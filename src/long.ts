import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  pad,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { airlockAbi, call, longFactoryAbi, tokenInfo, TOPIC } from "./abis";
import { config } from "./config";
import { errMsg, log, logEvent } from "./log";
import type { RpcLog } from "./rpc";
import type { LongTracked, Store } from "./state";
import { Watcher, type Emit } from "./watcher";

const FIRST_CHECK_DELAY_S = 30;
const RETRY_MS = 60_000;
const GIVE_UP_AFTER_S = 600;
const MAX_TIMER_MS = 6 * 3600_000;

/**
 * Long graduates on time: epoch ends, liquidity migrates. Primary signal is the
 * Airlock `Migrate` log; a per-token timer at epochEnd+30s is the fallback.
 */
export class LongWatcher extends Watcher {
  private timers = new Map<string, NodeJS.Timeout>();
  private factory = config.long.factory;
  private airlock = config.long.airlock;

  constructor(store: Store, emit: Emit) {
    super("robinhood", config.rhWss, store, emit);
    for (const key of Object.keys(this.tracked)) this.armFallback(key);
  }

  private get tracked() {
    return this.store.data.tracked.long;
  }

  trackedCount() {
    return Object.keys(this.tracked).length;
  }

  override stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    super.stop();
  }

  protected async subscribeLive() {
    await this.rpc.subscribe(["logs", { address: this.factory, topics: [TOPIC.Created] }], this.ingest);
    await this.rpc.subscribe(["logs", { address: this.airlock, topics: [TOPIC.Migrate] }], this.ingest);
  }

  protected async backfill(from: number, to: number) {
    await this.processNow(await this.rpc.getLogs({ address: this.factory, topics: [TOPIC.Created] }, from, to));
    await this.processNow(await this.rpc.getLogs({ address: this.airlock, topics: [TOPIC.Migrate] }, from, to));
  }

  protected async onLog(l: RpcLog) {
    const address = l.address.toLowerCase();
    const topic0 = l.topics[0]?.toLowerCase();
    if (address === this.factory && topic0 === TOPIC.Created) return this.onCreated(l);
    if (address === this.airlock && topic0 === TOPIC.Migrate) return this.onMigrate(l);
  }

  private async onCreated(l: RpcLog) {
    const { args } = decodeEventLog({ abi: longFactoryAbi, eventName: "Created", data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    const asset = args.asset.toLowerCase() as Address;
    if (this.tracked[asset]) return;
    const block = Number(l.blockNumber);

    const [launchedAt, info, assetData] = await Promise.all([
      this.rpc.blockTimestamp(block),
      tokenInfo(this.rpc, asset),
      this.readAssetData(asset),
    ]);
    const numeraire = assetData?.numeraire;
    const pairedSymbol =
      numeraire && numeraire !== zeroAddress
        ? await call(this.rpc, numeraire, erc20Abi, "symbol").catch(() => undefined)
        : undefined;

    this.tracked[asset] = {
      asset,
      name: args.name || info.name,
      symbol: info.symbol,
      creator: args.creator,
      hook: args.hook,
      poolId: args.poolId,
      numeraire,
      pairedSymbol,
      assetData: assetData?.raw,
      epochStart: Number(args.epochStart),
      epochEnd: Number(args.epochEnd),
      launchedAt,
      block,
      txHash: l.transactionHash,
    };
    this.store.touch();
    logEvent("long", "robinhood", "created", asset, block, l.transactionHash);
    this.armFallback(asset);
  }

  private async onMigrate(l: RpcLog) {
    const { args } = decodeEventLog({ abi: airlockAbi, eventName: "Migrate", data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    const asset = args.asset.toLowerCase();
    const block = Number(l.blockNumber);
    if (!this.tracked[asset]) {
      logEvent("long", "robinhood", "migrate-untracked", asset, block, l.transactionHash);
      return;
    }
    await this.graduate(asset, block, l.transactionHash);
  }

  private async graduate(asset: string, block: number, txHash: Hex | undefined, via = "migrate") {
    const t = this.tracked[asset];
    if (!t) return;
    const graduatedAt = await this.rpc.blockTimestamp(block);
    if (!this.tracked[asset]) return; // raced with the other path
    delete this.tracked[asset];
    clearTimeout(this.timers.get(asset));
    this.timers.delete(asset);
    this.store.touch();
    logEvent("long", "robinhood", `graduated(${via})`, asset, block, txHash);
    this.emit({
      pad: "long",
      chain: "robinhood",
      token: t.asset,
      name: t.name,
      symbol: t.symbol,
      numeraire: t.numeraire ?? zeroAddress,
      pairedSymbol: t.pairedSymbol,
      pool: t.poolId,
      creator: t.creator,
      launchedAt: t.launchedAt,
      graduatedAt,
      txHash,
    });
  }

  // --- epochEnd fallback ---

  private armFallback(asset: string) {
    const t = this.tracked[asset];
    if (!t) return;
    const due = (t.epochEnd + FIRST_CHECK_DELAY_S) * 1000;
    this.schedule(asset, due - Date.now());
  }

  private schedule(asset: string, delayMs: number) {
    clearTimeout(this.timers.get(asset));
    const delay = Math.min(Math.max(0, delayMs), MAX_TIMER_MS);
    this.timers.set(asset, setTimeout(() => void this.checkFallback(asset), delay));
  }

  private async checkFallback(asset: string) {
    const t = this.tracked[asset];
    if (!t) return;
    if (Date.now() < (t.epochEnd + FIRST_CHECK_DELAY_S) * 1000) return this.armFallback(asset); // long timer was clamped

    try {
      const done = await this.completedOnChain(t);
      if (done) return await this.graduate(asset, done.block, done.txHash, done.via);
    } catch (e) {
      log("long", "robinhood", "fallback check failed", asset, errMsg(e));
    }

    if (Date.now() >= (t.epochEnd + FIRST_CHECK_DELAY_S + GIVE_UP_AFTER_S) * 1000) {
      delete this.tracked[asset];
      this.timers.delete(asset);
      this.store.touch();
      logEvent("long", "robinhood", "dropped(no-graduation)", asset, t.block);
      return;
    }
    this.schedule(asset, RETRY_MS);
  }

  private async completedOnChain(t: LongTracked): Promise<{ block: number; txHash?: Hex; via: string } | undefined> {
    const latest = await this.rpc.blockNumber();

    // A Migrate log we missed (e.g. dropped subscription)?
    const from = Math.max(t.block, latest - config.long.fallbackLookback);
    const logs = await this.rpc.getLogs(
      { address: this.airlock, topics: [TOPIC.Migrate, pad(t.asset, { size: 32 }).toLowerCase() as Hex] },
      from,
      latest,
    );
    if (logs.length) return { block: Number(logs[0].blockNumber), txHash: logs[0].transactionHash, via: "fallback-migrate" };

    // Airlock state for this asset changed since creation (migrator/pool fields updated or cleared)?
    if (t.assetData) {
      const now = await this.readAssetData(t.asset);
      if (now && now.raw !== t.assetData) return { block: latest, via: "fallback-state" };
    }

    if (config.long.postOnEpochEnd) return { block: latest, via: "epoch-end" };
  }

  private async readAssetData(asset: Address): Promise<{ raw: Hex; numeraire: Address } | undefined> {
    try {
      const raw = await this.rpc.call(this.airlock, encodeFunctionData({ abi: airlockAbi, functionName: "getAssetData", args: [asset] }));
      const [numeraire] = decodeFunctionResult({ abi: airlockAbi, functionName: "getAssetData", data: raw });
      return { raw, numeraire: numeraire.toLowerCase() as Address };
    } catch (e) {
      if (!this.rpc.isOpen) throw e;
      log("long", "robinhood", "getAssetData failed", asset, errMsg(e));
      return undefined;
    }
  }
}
