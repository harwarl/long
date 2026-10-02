import { decodeEventLog, type Address, type Hex } from "viem";
import { airlockAbi, integratorOf, multicurveState, poolIdOf, poolManagerAbi, tokenInfo, TOPIC, v3PriceUsd } from "./abis";
import { config } from "./config";
import { errMsg, log, logEvent } from "./log";
import type { RpcLog } from "./rpc";
import type { BankrTracked, Store } from "./state";
import { Watcher, type Emit } from "./watcher";

const RESUB_DEBOUNCE_MS = 1_000;
const PRICE_REFRESH_MS = 60_000;
const PRUNE_EVERY_MS = 10 * 60_000;

/**
 * Bankr never migrates, so graduation is inferred from Swap logs on the v4
 * PoolManager: the tick crossing the last curve's end (curve) or mcap ≥ threshold (mcap).
 */
export class BankrWatcher extends Watcher {
  private c = config.bankr;
  private poolIndex = new Map<string, string>(); // poolId → asset
  private swapSubs: string[] = [];
  private resubTimer?: NodeJS.Timeout;
  private intervals: NodeJS.Timeout[] = [];
  private wethUsd?: number;

  constructor(store: Store, emit: Emit) {
    super("base", config.baseWss, store, emit);
    if (!this.c.initializers.length && !this.c.integrator) {
      throw new Error("Bankr filter not configured: set BANKR_INITIALIZERS and/or BANKR_INTEGRATOR (run `npm run verify`)");
    }
    for (const [asset, t] of Object.entries(this.tracked)) this.poolIndex.set(t.poolId, asset);
    this.intervals.push(
      setInterval(() => void this.refreshWethPrice(), PRICE_REFRESH_MS),
      setInterval(() => this.prune(), PRUNE_EVERY_MS),
    );
  }

  private get tracked() {
    return this.store.data.tracked.bankr;
  }

  trackedCount() {
    return this.poolIndex.size;
  }

  override stop() {
    this.intervals.forEach(clearInterval);
    clearTimeout(this.resubTimer);
    super.stop();
  }

  protected async subscribeLive() {
    this.swapSubs = []; // old ids died with the socket
    await this.refreshWethPrice(); // backfilled swaps need it for mcap
    await this.rpc.subscribe(["logs", { address: this.c.airlock, topics: [TOPIC.Create] }], this.ingest);
    await this.resubscribeSwaps();
  }

  protected async afterLive() {
    await this.resubscribeSwaps(); // picks up pools added during backfill
    await this.refreshWethPrice();
  }

  protected async backfill(from: number, to: number) {
    // Creates first: they add the pools whose swaps we then fetch.
    await this.processNow(await this.rpc.getLogs({ address: this.c.airlock, topics: [TOPIC.Create] }, from, to));
    const swaps: RpcLog[] = [];
    for (const ids of this.poolIdChunks()) {
      swaps.push(...(await this.rpc.getLogs({ address: this.c.poolManager, topics: [TOPIC.Swap, ids] }, from, to)));
    }
    await this.processNow(swaps);
  }

  protected async onLog(l: RpcLog) {
    const address = l.address.toLowerCase();
    const topic0 = l.topics[0]?.toLowerCase();
    if (address === this.c.airlock && topic0 === TOPIC.Create) return this.onCreate(l);
    if (address === this.c.poolManager && topic0 === TOPIC.Swap) return this.onSwap(l);
  }

  // --- launches ---

  private async isBankr(initializer: string, asset: Address): Promise<boolean> {
    if (this.c.initializers.length && !this.c.initializers.includes(initializer as Address)) return false;
    if (this.c.integrator && (await integratorOf(this.rpc, this.c.airlock, asset)) !== this.c.integrator) return false;
    return true;
  }

  private async onCreate(l: RpcLog) {
    const { args } = decodeEventLog({ abi: airlockAbi, eventName: "Create", data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    const asset = args.asset.toLowerCase() as Address;
    const initializer = args.initializer.toLowerCase() as Address;
    if (this.tracked[asset]) return;
    if (!(await this.isBankr(initializer, asset))) return;
    const block = Number(l.blockNumber);

    let state;
    try {
      state = await multicurveState(this.rpc, initializer, asset);
    } catch (e) {
      if (!this.rpc.isOpen) throw e;
      log("bankr", "base", "getState failed, not tracking", asset, initializer, errMsg(e));
      return;
    }
    const numeraire = args.numeraire.toLowerCase() as Address;
    const [info, num, createdAt] = await Promise.all([
      tokenInfo(this.rpc, asset),
      tokenInfo(this.rpc, numeraire),
      this.rpc.blockTimestamp(block),
    ]);
    const poolId = poolIdOf(state.poolKey);

    this.tracked[asset] = {
      asset,
      name: info.name,
      symbol: info.symbol,
      decimals: info.decimals,
      totalSupply: info.totalSupply,
      numeraire,
      numeraireDecimals: num.decimals,
      initializer,
      poolId,
      isToken0: state.poolKey.currency0.toLowerCase() === asset,
      farTick: state.farTick,
      createdAt,
      block,
      txHash: l.transactionHash,
    };
    this.poolIndex.set(poolId, asset);
    this.store.touch();
    logEvent("bankr", "base", "created", asset, block, l.transactionHash);
    this.scheduleResub();
  }

  // --- graduation ---

  private async onSwap(l: RpcLog) {
    const asset = this.poolIndex.get(l.topics[1]?.toLowerCase() ?? "");
    const t = asset ? this.tracked[asset] : undefined;
    if (!asset || !t) return;
    const { args } = decodeEventLog({ abi: poolManagerAbi, eventName: "Swap", data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    const tick = Number(args.tick);
    const mcapUsd = this.mcapUsd(t, args.sqrtPriceX96);

    const mode = config.bankrGradMode;
    const graduated =
      mode === "curve"
        ? t.isToken0 ? tick >= t.farTick : tick <= t.farTick // asset gets more expensive in this direction
        : mcapUsd !== undefined && mcapUsd >= config.bankrMcapUsd;
    if (!graduated) return;

    const block = Number(l.blockNumber);
    const graduatedAt = await this.rpc.blockTimestamp(block);
    if (!this.tracked[asset]) return;
    this.untrack(asset);
    logEvent("bankr", "base", `graduated(${mode})`, asset, block, l.transactionHash);
    this.emit({
      pad: "bankr",
      chain: "base",
      token: t.asset,
      name: t.name,
      symbol: t.symbol,
      numeraire: t.numeraire,
      pool: t.poolId,
      launchedAt: t.createdAt,
      graduatedAt,
      txHash: l.transactionHash,
      rule: mode,
      mcapUsd,
    });
  }

  private mcapUsd(t: BankrTracked, sqrtPriceX96: bigint): number | undefined {
    const numUsd = t.numeraire === this.c.weth ? this.wethUsd : t.numeraire === this.c.usdc ? 1 : undefined;
    if (numUsd === undefined) return undefined;
    const p = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // raw token1 per raw token0
    if (!(p > 0) || !Number.isFinite(p)) return undefined;
    const rawNumPerAsset = t.isToken0 ? p : 1 / p;
    const price = rawNumPerAsset * 10 ** (t.decimals - t.numeraireDecimals);
    const supply = Number(BigInt(t.totalSupply)) / 10 ** t.decimals;
    return price * numUsd * supply;
  }

  private async refreshWethPrice() {
    if (!this.rpc.isOpen) return;
    try {
      this.wethUsd = await v3PriceUsd(this.rpc, this.c.wethUsdcPool, this.c.weth, 18);
    } catch (e) {
      log("bankr", "base", "WETH price refresh failed:", errMsg(e));
    }
  }

  // --- tracked set / Swap subscriptions ---

  private untrack(asset: string) {
    const t = this.tracked[asset];
    if (t) this.poolIndex.delete(t.poolId);
    delete this.tracked[asset];
    this.store.touch();
    this.scheduleResub();
  }

  private prune() {
    const cutoff = Date.now() / 1000 - config.bankrTtlHours * 3600;
    for (const [asset, t] of Object.entries(this.tracked)) {
      if (t.createdAt < cutoff) {
        this.untrack(asset);
        logEvent("bankr", "base", "pruned(ttl)", asset, t.block);
      }
    }
  }

  private poolIdChunks(): Hex[][] {
    const ids = [...this.poolIndex.keys()] as Hex[];
    const out: Hex[][] = [];
    for (let i = 0; i < ids.length; i += this.c.swapTopicChunk) out.push(ids.slice(i, i + this.c.swapTopicChunk));
    return out;
  }

  private scheduleResub() {
    clearTimeout(this.resubTimer);
    this.resubTimer = setTimeout(() => {
      this.resubscribeSwaps().catch((e) => log("bankr", "base", "swap resubscribe failed:", errMsg(e)));
    }, RESUB_DEBOUNCE_MS);
  }

  /** Subscribe the new set before dropping the old one so there's no gap; dupes are deduped. */
  private async resubscribeSwaps() {
    if (!this.rpc.isOpen) return; // setup() will subscribe on reconnect
    const next: string[] = [];
    for (const ids of this.poolIdChunks()) {
      next.push(await this.rpc.subscribe(["logs", { address: this.c.poolManager, topics: [TOPIC.Swap, ids] }], this.ingest));
    }
    const old = this.swapSubs;
    this.swapSubs = next;
    old.forEach((id) => this.rpc.unsubscribe(id));
  }
}
