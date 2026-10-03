import { decodeEventLog, type Address, type Hex } from "viem";
import {
  assetData,
  currentTick,
  initializerState,
  launcherAbi,
  poolIdOf,
  poolManagerAbi,
  PoolStatus,
  symbolOf,
  tokenInfo,
  TOPIC,
  airlockAbi,
} from "./abis";
import { config } from "./config";
import { log, logEvent } from "./log";
import type { RpcLog } from "./rpc";
import type { Store, Tracked } from "./state";
import type { How, Pad } from "./types";
import { Watcher, type Emit } from "./watcher";

const PRUNE_EVERY_MS = 10 * 60_000;
const LN_TICK = Math.log(1.0001);

const topicAddr = (t: Hex | undefined) => (t ? (`0x${t.slice(26)}`.toLowerCase() as Address) : undefined);

/**
 * Long and Bankr both launch through the shared Airlock with the same
 * DopplerHookInitializer, so one handler serves both; the Airlock's stored
 * integrator decides the pad. Graduation, first signal wins:
 *   - price ≥ N× launch price, from PoolManager Swap ticks   (how: "multiple")
 *   - initializer Graduate(asset)                            (how: "graduate")
 *   - Airlock Migrate(asset)                                 (how: "migrate")
 *   - tick reached farTick (what graduate() itself checks)   (how: "tick")
 * As deployed, the hooks lack ON_GRADUATION_FLAG and pools are Locked, so in
 * practice only "multiple" fires; the others are watched in case that changes.
 *
 * Swaps: the provider rejects getLogs with more than ~5 topic values, so we take
 * every PoolManager Swap (~12/s) and match the PoolId locally.
 */
export class LaunchWatcher extends Watcher {
  private poolIndex = new Map<string, Tracked>(); // poolId → tracked
  private pruneTimer?: NodeJS.Timeout;
  private ticksNeeded: Record<Pad, number>;

  constructor(store: Store, emit: Emit) {
    super("robinhood", config.rhWss, store, emit);
    this.ticksNeeded = {
      long: Math.ceil(Math.log(config.gradMultiple.long) / LN_TICK),
      bankr: Math.ceil(Math.log(config.gradMultiple.bankr) / LN_TICK),
    };
    for (const pad of ["long", "bankr"] as const) {
      for (const t of Object.values(this.store.data.tracked[pad])) this.poolIndex.set(t.poolId, t);
    }
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_EVERY_MS);
  }

  trackedCount() {
    const t = this.store.data.tracked;
    return `long=${Object.keys(t.long).length} bankr=${Object.keys(t.bankr).length}`;
  }

  override stop() {
    clearInterval(this.pruneTimer);
    super.stop();
  }

  private get filters() {
    return {
      airlock: { address: config.airlock, topics: [[TOPIC.Create, TOPIC.Migrate]] },
      graduate: { address: config.initializer, topics: [TOPIC.Graduate] },
      swap: { address: config.poolManager, topics: [TOPIC.Swap] },
    };
  }

  protected async subscribeLive() {
    for (const f of Object.values(this.filters)) await this.rpc.subscribe(["logs", f], this.ingest);
  }

  /**
   * One combined query per chunk, processed in chain order (a Create always precedes its
   * pool's swaps). Chunk by chunk because swaps are dense (~1k per 1k blocks).
   */
  protected async backfill(from: number, to: number) {
    const all = {
      address: [config.airlock, config.initializer, config.poolManager],
      topics: [[TOPIC.Create, TOPIC.Migrate, TOPIC.Graduate, TOPIC.Swap]],
    };
    for (let start = from; start <= to; start += config.getLogsChunk) {
      const end = Math.min(start + config.getLogsChunk - 1, to);
      await this.processNow(await this.rpc.getLogs(all, start, end));
    }
  }

  protected async onLog(l: RpcLog) {
    const address = l.address.toLowerCase();
    const topic0 = l.topics[0]?.toLowerCase();
    if (address === config.airlock && topic0 === TOPIC.Create) return this.onCreate(l);
    if (address === config.airlock && topic0 === TOPIC.Migrate) return this.onSignal(topicAddr(l.topics[1]), "migrate", l);
    if (address === config.initializer && topic0 === TOPIC.Graduate) return this.onSignal(topicAddr(l.topics[1]), "graduate", l);
    if (address === config.poolManager && topic0 === TOPIC.Swap) return this.onSwap(l);
  }

  // --- launches ---

  private padOf(integrator: Address): Pad | undefined {
    if (integrator === config.integrators.long) return "long";
    if (integrator === config.integrators.bankr) return "bankr";
  }

  private async onCreate(l: RpcLog) {
    const { args } = decodeEventLog({ abi: airlockAbi, eventName: "Create", data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    const asset = args.asset.toLowerCase() as Address;
    if (args.initializer.toLowerCase() !== config.initializer) return;
    if (this.store.data.tracked.long[asset] || this.store.data.tracked.bankr[asset]) return;
    const pad = this.padOf((await assetData(this.rpc, config.airlock, asset)).integrator);
    if (!pad) return;
    const block = Number(l.blockNumber);

    const [state, info, createdAt, receipt] = await Promise.all([
      initializerState(this.rpc, config.initializer, asset),
      tokenInfo(this.rpc, asset),
      this.rpc.blockTimestamp(block),
      this.rpc.request<{ logs: RpcLog[] }>("eth_getTransactionReceipt", [l.transactionHash]),
    ]);
    const poolId = poolIdOf(state.poolKey);
    const isToken0 = state.poolKey.currency0.toLowerCase() === asset;

    // Launch price = the pool's initial tick (from Initialize in the same tx), so backfill stays correct.
    let startTick: number | undefined;
    let creator: Address | undefined;
    for (const r of receipt?.logs ?? []) {
      const t0 = r.topics[0]?.toLowerCase();
      if (r.address.toLowerCase() === config.poolManager && t0 === TOPIC.Initialize && r.topics[1]?.toLowerCase() === poolId) {
        startTick = decodeEventLog({ abi: poolManagerAbi, eventName: "Initialize", data: r.data, topics: r.topics as [Hex, ...Hex[]] }).args.tick;
      } else if (t0 === TOPIC.LaunchCreated && topicAddr(r.topics[2]) === asset) {
        creator = decodeEventLog({ abi: launcherAbi, data: r.data, topics: r.topics as [Hex, ...Hex[]] }).args.launcher.toLowerCase() as Address;
      }
    }
    if (startTick === undefined) {
      startTick = await currentTick(this.rpc, config.poolManager, poolId);
      log(pad, "no Initialize log in launch tx; using current tick as launch price", asset, startTick);
    }

    const t: Tracked = {
      pad,
      asset,
      name: info.name,
      symbol: info.symbol,
      numeraire: state.numeraire,
      pairedSymbol: await symbolOf(this.rpc, state.numeraire),
      creator,
      poolId,
      isToken0,
      startTick,
      farTick: state.farTick,
      createdAt,
      block,
      txHash: l.transactionHash,
    };
    this.store.data.tracked[pad][asset] = t;
    this.poolIndex.set(poolId, t);
    this.store.touch();
    logEvent(pad, `created(${t.pairedSymbol},${PoolStatus[state.status] ?? state.status})`, asset, block, l.transactionHash);

    if (state.status === 3 || state.status === 4) await this.graduate(t, state.status === 3 ? "graduate" : "migrate", block, l.transactionHash);
  }

  // --- graduation ---

  private trackedFor(asset: Address | undefined): Tracked | undefined {
    if (!asset) return undefined;
    return this.store.data.tracked.long[asset] ?? this.store.data.tracked.bankr[asset];
  }

  private async onSignal(asset: Address | undefined, how: How, l: RpcLog) {
    const t = this.trackedFor(asset);
    if (t) await this.graduate(t, how, Number(l.blockNumber), l.transactionHash);
  }

  private async onSwap(l: RpcLog) {
    const t = this.poolIndex.get(l.topics[1]?.toLowerCase() ?? "");
    if (!t) return;
    const { args } = decodeEventLog({ abi: poolManagerAbi, eventName: "Swap", data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    const tick = Number(args.tick);
    const up = t.isToken0 ? tick - t.startTick : t.startTick - tick; // ticks moved in the asset-more-expensive direction
    const atFar = t.isToken0 ? tick >= t.farTick : tick <= t.farTick;
    const how: How | undefined = atFar ? "tick" : up >= this.ticksNeeded[t.pad] ? "multiple" : undefined;
    if (!how) return;

    const block = Number(l.blockNumber);
    const ts = await this.rpc.blockTimestamp(block);
    if (ts < t.createdAt + config.ignoreSwapsAfterLaunchS) return;
    await this.graduate(t, how, block, l.transactionHash, Math.exp(up * LN_TICK));
  }

  private async graduate(t: Tracked, how: How, block: number, txHash: Hex, multiple?: number) {
    if (!this.store.data.tracked[t.pad][t.asset]) return;
    const graduatedAt = await this.rpc.blockTimestamp(block);
    if (!this.store.data.tracked[t.pad][t.asset]) return; // raced with another signal
    this.untrack(t);
    logEvent(t.pad, `graduated(${how}${multiple ? ` ${multiple.toFixed(1)}x` : ""})`, t.asset, block, txHash);
    this.emit({
      pad: t.pad,
      token: t.asset,
      name: t.name,
      symbol: t.symbol,
      numeraire: t.numeraire,
      pairedSymbol: t.pairedSymbol,
      pool: t.poolId,
      creator: t.creator,
      how,
      multiple,
      launchedAt: t.createdAt,
      graduatedAt,
      txHash,
    });
  }

  // --- tracked set ---

  private untrack(t: Tracked) {
    this.poolIndex.delete(t.poolId);
    delete this.store.data.tracked[t.pad][t.asset];
    this.store.touch();
  }

  private prune() {
    const cutoff = Date.now() / 1000 - config.trackTtlHours * 3600;
    for (const t of [...this.poolIndex.values()]) {
      if (t.createdAt < cutoff) {
        this.untrack(t);
        logEvent(t.pad, "pruned(ttl)", t.asset, t.block);
      }
    }
  }
}
