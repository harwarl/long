import { config } from "./config";
import { errMsg, log, sleep } from "./log";
import { WssRpc, type RpcLog } from "./rpc";
import type { Store } from "./state";
import type { Graduated } from "./types";

export type Emit = (g: Graduated) => void;

const HEAD_LAG = 3; // only advance lastBlock from newHeads this far behind the tip
const SEEN_CAP = 20_000;

/**
 * Per (re)connect: subscribe live (buffering), backfill lastBlock+1 → head, then
 * drain the buffer and go live. Every log goes through one serial queue and a
 * seen-set, so overlap between backfill and the live subscription is harmless.
 */
export abstract class Watcher {
  readonly rpc: WssRpc;
  private live = false;
  private buffer: RpcLog[] = [];
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private seen = new Set<string>();

  constructor(
    readonly chain: string,
    url: string,
    protected store: Store,
    protected emit: Emit,
  ) {
    this.rpc = new WssRpc(chain, url, () => this.setup(), config.getLogsChunk);
    this.rpc.onHead = (n) => {
      if (this.live && this.queued === 0) this.store.setLastBlock(n - HEAD_LAG);
    };
  }

  start() {
    this.rpc.start();
  }

  stop() {
    this.rpc.stop();
  }

  abstract trackedCount(): string;
  protected abstract subscribeLive(): Promise<void>;
  /** Fetch and process (via processNow) everything in [from, to]. */
  protected abstract backfill(from: number, to: number): Promise<void>;
  protected abstract onLog(l: RpcLog): Promise<void>;
  protected async afterLive(): Promise<void> {}

  /** Subscription handler. */
  protected ingest = (l: RpcLog) => {
    if (!this.live) this.buffer.push(l);
    else void this.enqueue(l, true);
  };

  protected async processNow(logs: RpcLog[]) {
    logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
    for (const l of logs) await this.enqueue(l, false);
  }

  private enqueue(l: RpcLog, live: boolean): Promise<void> {
    if (l.removed) return Promise.resolve(); // reorged out
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (this.seen.has(key)) return Promise.resolve();
    this.seen.add(key);
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.values().next().value!);

    this.queued++;
    this.queue = this.queue
      .then(() => this.run(l))
      .finally(() => {
        this.queued--;
        // -1: another log in the same block may still be unprocessed
        if (live) this.store.setLastBlock(Number(l.blockNumber) - 1);
      });
    return this.queue;
  }

  private async run(l: RpcLog) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.onLog(l);
      } catch (e) {
        if (attempt >= 3) {
          log(this.chain, "log failed", Number(l.blockNumber), l.transactionHash, errMsg(e));
          return;
        }
        await sleep(5_000);
      }
    }
  }

  private async setup() {
    this.live = false;
    this.buffer = [];
    await this.subscribeLive();
    const head = await this.rpc.blockNumber();
    const last = this.store.lastBlock;
    if (last > 0 && last < head) {
      const from = Math.max(last + 1, head - config.maxBackfillBlocks);
      if (from > last + 1) log(this.chain, "backfill", `capped: skipping ${last + 1} → ${from - 1}`);
      log(this.chain, "backfill", `${from} → ${head}`);
      await this.backfill(from, head);
    }
    await this.queue;
    this.store.setLastBlock(head);
    this.live = true;
    const buffered = this.buffer;
    this.buffer = [];
    for (const l of buffered) this.ingest(l);
    await this.afterLive();
  }
}
