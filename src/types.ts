import type { Address, Hex } from "viem";

export type Pad = "long" | "bankr";
export type Chain = "robinhood" | "base";

export type Graduated = {
  pad: Pad;
  chain: Chain;
  token: Address;
  name: string;
  symbol: string;
  numeraire: Address; // Long: stock token (NVDA, AAPL…), Bankr: WETH/USDC
  pool: Address | Hex; // pool address or v4 PoolId
  creator?: Address;
  launchedAt: number;
  graduatedAt: number;
  txHash?: Hex; // absent when graduation was inferred from state, not a tx
  // post extras
  pairedSymbol?: string;
  rule?: "curve" | "mcap";
  mcapUsd?: number;
};
