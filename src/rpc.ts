import { toHex, type Address, type Hex } from "viem";
import { errMsg, log } from "./log";

export type RpcLog = {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed?: boolean;
};

export type LogFilter = { address: Address | Address[]; topics?: (Hex | Hex[] | null)[] };

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const HEARTBEAT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Minimal JSON-RPC over WebSocket. Every (re)connect subscribes newHeads for the
 * heartbeat, then runs `setup` (backfill + subscriptions). Subscriptions die with
 * the socket, so `setup` must recreate them.
 */
export class WssRpc {
  connectedAt = 0; // 0 while down or still in setup
  headBlock = 0;
  onHead?: (block: number) => void;

  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subs = new Map<string, (result: any) => void>();
  private backoff = 1000;
  private lastHeadAt = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private blockTimes = new Map<number, number>();

  constructor(
    readonly chain: string,
    private url: string,
    private setup: () => Promise<void>,
    private logChunk = 2000,
  ) {}

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.ws) this.drop(this.ws, "stopped");
  }

  private connect() {
    if (this.stopped) return;
    log(this.chain, "wss", "connecting");
    const ws = new WebSocket(this.url);
    const openedAt = Date.now();
    this.ws = ws;
    ws.onopen = () => void this.onOpen(ws);
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = (ev) => this.drop(ws, `closed (${ev.code})`);
    ws.onerror = () => this.drop(ws, "socket error");

    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (ws !== this.ws) return;
      if (ws.readyState === WebSocket.CONNECTING && Date.now() - openedAt > CONNECT_TIMEOUT_MS) {
        this.drop(ws, "connect timeout");
      } else if (ws.readyState === WebSocket.OPEN && Date.now() - this.lastHeadAt > HEARTBEAT_MS) {
        this.drop(ws, "no newHeads for 30s");
      }
    }, 5_000);
  }

  private async onOpen(ws: WebSocket) {
    this.lastHeadAt = Date.now();
    try {
      await this.subscribe(["newHeads"], (head) => {
        this.lastHeadAt = Date.now();
        this.headBlock = Number(head.number);
        this.onHead?.(this.headBlock);
      });
      await this.setup();
      if (ws !== this.ws) return;
      this.connectedAt = Date.now();
      this.backoff = 1000;
      log(this.chain, "wss", "live", `head=${this.headBlock}`);
    } catch (e) {
      log(this.chain, "wss", "setup failed:", errMsg(e));
      this.drop(ws, "setup failed");
    }
  }

  /** Tear down without waiting for a close handshake (a dead peer may never answer). */
  private drop(ws: WebSocket, reason: string) {
    if (ws !== this.ws) return;
    this.ws = undefined;
    this.connectedAt = 0;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {}
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`${this.chain} wss dropped`));
    }
    this.pending.clear();
    this.subs.clear();
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    log(this.chain, "wss", `down: ${reason}; reconnecting in ${delay / 1000}s`);
    setTimeout(() => this.connect(), delay);
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.method === "eth_subscription") {
      try {
        this.subs.get(msg.params?.subscription)?.(msg.params.result);
      } catch (e) {
        log(this.chain, "subscription handler error:", errMsg(e));
      }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }

  request<T = any>(method: string, params: unknown[] = [], timeoutMs = 30_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`${this.chain} wss not connected`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.chain} ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async subscribe(params: unknown[], handler: (result: any) => void): Promise<string> {
    const id = await this.request<string>("eth_subscribe", params, 10_000); // a stuck subscribe means a bad connection: fail fast
    this.subs.set(id, handler);
    return id;
  }

  unsubscribe(id: string) {
    this.subs.delete(id);
    this.request("eth_unsubscribe", [id]).catch(() => {});
  }

  async blockNumber(): Promise<number> {
    return Number(await this.request<Hex>("eth_blockNumber"));
  }

  call(to: Address, data: Hex): Promise<Hex> {
    return this.request<Hex>("eth_call", [{ to, data }, "latest"]);
  }

  async blockTimestamp(block: number): Promise<number> {
    const cached = this.blockTimes.get(block);
    if (cached) return cached;
    const b = await this.request<{ timestamp: Hex }>("eth_getBlockByNumber", [toHex(block), false]);
    const ts = Number(b.timestamp);
    if (this.blockTimes.size > 1000) this.blockTimes.clear();
    this.blockTimes.set(block, ts);
    return ts;
  }

  /** Chunked eth_getLogs; halves the chunk size when the provider rejects a range. */
  async getLogs(filter: LogFilter, from: number, to: number): Promise<RpcLog[]> {
    const out: RpcLog[] = [];
    let size = this.logChunk;
    let start = from;
    while (start <= to) {
      const end = Math.min(start + size - 1, to);
      try {
        const logs = await this.request<RpcLog[]>(
          "eth_getLogs",
          [{ ...filter, fromBlock: toHex(start), toBlock: toHex(end) }],
          60_000,
        );
        out.push(...logs);
        start = end + 1;
      } catch (e) {
        if (size <= 1 || !this.isOpen) throw e;
        size = Math.max(1, Math.floor(size / 2));
        log(this.chain, "getLogs", `${errMsg(e)}; retrying with ${size}-block chunks`);
      }
    }
    return out;
  }
}
