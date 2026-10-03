import type { Address, Hex } from "viem";

export type Pad = "long" | "bankr";

export type How = "multiple" | "graduate" | "migrate" | "tick";

export type Graduated = {
  pad: Pad;
  token: Address;
  name: string;
  symbol: string;
  numeraire: Address; // WETH, native ETH (0x0) or a stock token (NVDA…)
  pairedSymbol?: string;
  pool: Hex; // v4 PoolId
  creator?: Address;
  how: How;
  multiple?: number; // price / launch price at graduation
  launchedAt: number;
  graduatedAt: number;
  txHash?: Hex;
};
