import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import type { WssRpc } from "./rpc";

// Signatures come from bot.md. topic0 is computed from them here; `npm run verify`
// checks that the live contracts actually emit these topics.

export const longFactoryAbi = parseAbi([
  "event Created(address indexed asset, address hook, address creator, bytes32 poolId, uint256 epochStart, uint256 epochEnd, string name)",
]);

export const airlockAbi = parseAbi([
  "event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)",
  "event Migrate(address indexed asset, address indexed pool)",
  "function getAssetData(address asset) view returns (address numeraire, address timelock, address governance, address liquidityMigrator, address poolInitializer, address pool)",
]);

export const poolManagerAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

// Upstream Doppler UniswapV4MulticurveInitializer: public `getState(asset)` getter
// (array members are dropped by the auto-getter). farTick is the end of the last curve.
export const multicurveInitializerAbi = parseAbi([
  "function getState(address asset) view returns (address numeraire, uint8 status, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 farTick)",
]);

export const v3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
]);

const selector = (abi: Abi, name: string) =>
  toEventSelector(abi.find((x): x is AbiEvent => x.type === "event" && x.name === name)!).toLowerCase() as Hex;

export const TOPIC = {
  Created: selector(longFactoryAbi, "Created"),
  Create: selector(airlockAbi, "Create"),
  Migrate: selector(airlockAbi, "Migrate"),
  Swap: selector(poolManagerAbi, "Swap"),
};

export async function call(rpc: WssRpc, to: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<any> {
  const data = encodeFunctionData({ abi, functionName, args } as any);
  const raw = await rpc.call(to, data);
  return decodeFunctionResult({ abi, functionName, data: raw } as any);
}

const settled = <T>(r: PromiseSettledResult<unknown>, def: T): T => (r.status === "fulfilled" ? (r.value as T) : def);

export async function tokenInfo(rpc: WssRpc, token: Address) {
  const [name, symbol, decimals, totalSupply] = await Promise.allSettled([
    call(rpc, token, erc20Abi, "name"),
    call(rpc, token, erc20Abi, "symbol"),
    call(rpc, token, erc20Abi, "decimals"),
    call(rpc, token, erc20Abi, "totalSupply"),
  ]);
  // All four failing usually means the socket dropped, not a weird token: let the caller retry.
  if (!rpc.isOpen) throw new Error(`${rpc.chain} wss dropped during tokenInfo`);
  return {
    name: settled(name, ""),
    symbol: settled(symbol, "???"),
    decimals: Number(settled(decimals, 18)),
    totalSupply: String(settled(totalSupply, 0n)),
  };
}

/**
 * Integrator stored by the (upstream) Doppler Airlock: word 9 of getAssetData's return
 * (…, pool, migrationPool, numTokensToSell, totalSupply, integrator). Not in the 6-field
 * ABI above, so it's read raw. Verified on the Base Airlock.
 */
export async function integratorOf(rpc: WssRpc, airlock: Address, asset: Address): Promise<Address | undefined> {
  const raw = await rpc.call(airlock, encodeFunctionData({ abi: airlockAbi, functionName: "getAssetData", args: [asset] }));
  const word = raw.slice(2 + 64 * 9, 2 + 64 * 10);
  return word.length === 64 ? (`0x${word.slice(24)}`.toLowerCase() as Address) : undefined;
}

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

export function poolIdOf(k: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [
      k.currency0,
      k.currency1,
      k.fee,
      k.tickSpacing,
      k.hooks,
    ]),
  ).toLowerCase() as Hex;
}

export async function multicurveState(rpc: WssRpc, initializer: Address, asset: Address) {
  const [numeraire, status, poolKey, farTick] = await call(rpc, initializer, multicurveInitializerAbi, "getState", [asset]);
  return { numeraire: numeraire as Address, status: Number(status), poolKey: poolKey as PoolKey, farTick: Number(farTick) };
}

/** USD price of `token` from a token/USDC v3 pool (decimals given). */
export async function v3PriceUsd(rpc: WssRpc, pool: Address, token: Address, tokenDecimals: number, usdcDecimals = 6) {
  const [token0, slot0] = await Promise.all([call(rpc, pool, v3PoolAbi, "token0"), call(rpc, pool, v3PoolAbi, "slot0")]);
  const p = (Number(slot0[0]) / 2 ** 96) ** 2; // raw token1 per raw token0
  const rawUsdcPerToken = (token0 as string).toLowerCase() === token.toLowerCase() ? p : 1 / p;
  return rawUsdcPerToken * 10 ** (tokenDecimals - usdcDecimals);
}
