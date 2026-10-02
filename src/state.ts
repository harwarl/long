import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { errMsg, log } from "./log";
import type { Chain } from "./types";

export type LongTracked = {
  asset: Address;
  name: string;
  symbol: string;
  creator: Address;
  hook: Address;
  poolId: Hex;
  numeraire?: Address;
  pairedSymbol?: string;
  assetData?: Hex; // raw getAssetData() at creation, compared later to detect completion
  epochStart: number;
  epochEnd: number;
  launchedAt: number;
  block: number;
  txHash: Hex;
};

export type BankrTracked = {
  asset: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  numeraire: Address;
  numeraireDecimals: number;
  initializer: Address;
  poolId: Hex;
  isToken0: boolean;
  farTick: number;
  createdAt: number;
  block: number;
  txHash: Hex;
};

type StateData = {
  lastBlock: Record<Chain, number>;
  tracked: { long: Record<string, LongTracked>; bankr: Record<string, BankrTracked> };
  posted: string[];
};

export class Store {
  data: StateData = { lastBlock: { robinhood: 0, base: 0 }, tracked: { long: {}, bankr: {} }, posted: [] };
  private posted: Set<string>;
  private dirty = false;
  private timer?: NodeJS.Timeout;

  constructor(private file: string) {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      this.data = {
        lastBlock: { ...this.data.lastBlock, ...raw.lastBlock },
        tracked: { long: raw.tracked?.long ?? {}, bankr: raw.tracked?.bankr ?? {} },
        posted: raw.posted ?? [],
      };
    }
    this.posted = new Set(this.data.posted);
  }

  lastBlock(chain: Chain) {
    return this.data.lastBlock[chain];
  }

  setLastBlock(chain: Chain, block: number) {
    if (block > this.data.lastBlock[chain]) {
      this.data.lastBlock[chain] = block;
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
