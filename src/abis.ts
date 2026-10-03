import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
  zeroAddress,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import type { WssRpc } from "./rpc";

// Signatures checked against the verified sources on Sourcify (chain 4663):
// Airlock 0xeb7c…0862, DopplerHookInitializer 0x4e34…a544, LongLauncher 0x22e9…eeed.

export const airlockAbi = parseAbi([
  "event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)",
  "event Migrate(address indexed asset, address indexed pool)",
  "function getAssetData(address asset) view returns (address numeraire, address timelock, address governance, address liquidityMigrator, address poolInitializer, address pool, address migrationPool, uint256 numTokensToSell, uint256 totalSupply, address integrator)",
]);

export const initializerAbi = parseAbi([
  "event Graduate(address indexed asset)",
  "function getState(address asset) view returns (address numeraire, uint256 totalTokensOnBondingCurve, address dopplerHook, bytes graduationDopplerHookCalldata, uint8 status, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 farTick)",
]);

// Emitted by Long's launcher contracts in the same tx as the Airlock Create; `launcher` is the creator.
export const launcherAbi = parseAbi([
  "event LaunchCreated(address indexed poolOrHook, address indexed asset, address indexed numeraire, address poolInitializer, address launcher, bytes32 tickerKey, uint48 deployedAt, uint48 reservedUntil, string normalizedTicker)",
]);

export const poolManagerAbi = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "function extsload(bytes32 slot) view returns (bytes32)",
]);

const selector = (abi: Abi, name: string) =>
  toEventSelector(abi.find((x): x is AbiEvent => x.type === "event" && x.name === name)!).toLowerCase() as Hex;

export const TOPIC = {
  Create: selector(airlockAbi, "Create"),
  Migrate: selector(airlockAbi, "Migrate"),
  Graduate: selector(initializerAbi, "Graduate"),
  LaunchCreated: selector(launcherAbi, "LaunchCreated"),
  Initialize: selector(poolManagerAbi, "Initialize"),
  Swap: selector(poolManagerAbi, "Swap"),
};

export const PoolStatus = ["Uninitialized", "Initialized", "Locked", "Graduated", "Exited"] as const;

export async function call(rpc: WssRpc, to: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<any> {
  const data = encodeFunctionData({ abi, functionName, args } as any);
  const raw = await rpc.call(to, data);
  return decodeFunctionResult({ abi, functionName, data: raw } as any);
}

export async function tokenInfo(rpc: WssRpc, token: Address) {
  const [name, symbol] = await Promise.allSettled([call(rpc, token, erc20Abi, "name"), call(rpc, token, erc20Abi, "symbol")]);
  // Both failing usually means the socket dropped, not a weird token: let the caller retry.
  if (!rpc.isOpen) throw new Error(`${rpc.chain} wss dropped during tokenInfo`);
  return {
    name: name.status === "fulfilled" ? (name.value as string) : "",
    symbol: symbol.status === "fulfilled" ? (symbol.value as string) : "???",
  };
}

export async function symbolOf(rpc: WssRpc, token: Address): Promise<string> {
  if (token === zeroAddress) return "ETH";
  return call(rpc, token, erc20Abi, "symbol").catch(() => `${token.slice(0, 8)}…`);
}

export async function assetData(rpc: WssRpc, airlock: Address, asset: Address) {
  const r = await call(rpc, airlock, airlockAbi, "getAssetData", [asset]);
  return { numeraire: (r[0] as string).toLowerCase() as Address, integrator: (r[9] as string).toLowerCase() as Address };
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

export async function initializerState(rpc: WssRpc, initializer: Address, asset: Address) {
  const r = await call(rpc, initializer, initializerAbi, "getState", [asset]);
  return { numeraire: (r[0] as string).toLowerCase() as Address, status: Number(r[4]), poolKey: r[5] as PoolKey, farTick: Number(r[6]) };
}

/** Current pool tick via PoolManager.extsload (pools[id].slot0 lives at keccak(id, 6)). */
export async function currentTick(rpc: WssRpc, poolManager: Address, poolId: Hex): Promise<number> {
  const slot = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, uint256"), [poolId, 6n]));
  const v = BigInt(await call(rpc, poolManager, poolManagerAbi, "extsload", [slot]));
  const t = Number((v >> 160n) & 0xffffffn);
  return t >= 0x800000 ? t - 0x1000000 : t;
}
