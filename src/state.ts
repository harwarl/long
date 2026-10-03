import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { errMsg, log } from "./log";
import type { Pad } from "./types";

export type Tracked = {
  pad: Pad;
  asset: Address;
  name: string;
  symbol: string;
  numeraire: Address;
  pairedSymbol: string;
  creator?: Address;
  poolId: Hex;
  isToken0: boolean; // asset is currency0 → gets more expensive as tick rises
  startTick: number;
  farTick: number;
  createdAt: number;
  block: number;
  txHash: Hex;
};

type StateData = {
  lastBlock: number;
  tracked: Record<Pad, Record<string, Tracked>>;
  posted: string[];
};

export class Store {
  data: StateData = { lastBlock: 0, tracked: { long: {}, bankr: {} }, posted: [] };
  private posted: Set<string>;
  private dirty = false;
  private timer?: NodeJS.Timeout;

  constructor(private file: string) {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      // Old two-chain state: lastBlock was { robinhood, base }; tracked entries had another shape.
      const lastBlock = typeof raw.lastBlock === "number" ? raw.lastBlock : Number(raw.lastBlock?.robinhood ?? 0);
      const keep = (m: Record<string, any> = {}) =>
        Object.fromEntries(Object.entries(m).filter(([, t]) => typeof t?.startTick === "number")) as Record<string, Tracked>;
      this.data = {
        lastBlock,
        tracked: { long: keep(raw.tracked?.long), bankr: keep(raw.tracked?.bankr) },
        posted: raw.posted ?? [],
      };
    }
    this.posted = new Set(this.data.posted);
  }

  get lastBlock() {
    return this.data.lastBlock;
  }

  setLastBlock(block: number) {
    if (block > this.data.lastBlock) {
      this.data.lastBlock = block;
      this.dirty = true;
    }
  }

  hasPosted(key: string) {
    return this.posted.has(key);
  }

  markPosted(key: string) {
    this.posted.add(key);
    this.data.posted.push(key);
    this.dirty = true;
  }

  touch() {
    this.dirty = true;
  }

  start() {
    this.timer = setInterval(() => this.flush(), 5_000);
  }

  stop() {
    clearInterval(this.timer);
    this.flush();
  }

  flush() {
    if (!this.dirty) return;
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      log("state", "flush failed:", errMsg(e));
    }
  }
}
