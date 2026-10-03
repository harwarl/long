// Checks the bot.md "Verify before hardcoding" list against live Robinhood Chain.
// Usage: pnpm run verify [-- --blocks 50000]
import { decodeEventLog, type Address, type Hex } from "viem";
import { airlockAbi, assetData, call, currentTick, initializerAbi, initializerState, poolIdOf, PoolStatus, symbolOf, TOPIC } from "./abis";
import { config } from "./config";
import { errMsg } from "./log";
import { WssRpc } from "./rpc";

const argIdx = process.argv.indexOf("--blocks");
const BLOCKS = Number(argIdx >= 0 ? process.argv[argIdx + 1] : 50_000);
const ON_GRADUATION_FLAG = 4n;
const hookFlagsAbi = [{ type: "function", name: "isDopplerHookEnabled", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;

function connect(url: string): Promise<WssRpc> {
  return new Promise((resolve, reject) => {
    const rpc: WssRpc = new WssRpc("robinhood", url, async () => resolve(rpc), config.getLogsChunk);
    rpc.start();
    setTimeout(() => reject(new Error("could not connect + subscribe newHeads in 30s")), 30_000);
  });
}

console.log("== topic0 (from verified ABIs) ==");
for (const [k, v] of Object.entries(TOPIC)) console.log(`  ${k.padEnd(14)} ${v}`);

try {
  const rpc = await connect(config.rhWss);
  console.log(`\nchainId ${Number(await rpc.request<Hex>("eth_chainId"))} (expect 4663), eth_subscribe newHeads ✓`);
  const head = await rpc.blockNumber();
  const from = head - BLOCKS;
  const logs = await rpc.getLogs({ address: config.airlock, topics: [[TOPIC.Create, TOPIC.Migrate]] }, from, head);
  const grads = await rpc.getLogs({ address: config.initializer, topics: [TOPIC.Graduate] }, from, head);
  const creates = logs.filter((l) => l.topics[0] === TOPIC.Create);
  console.log(`blocks ${from} → ${head}: Create ×${creates.length}, Migrate ×${logs.length - creates.length}, Graduate ×${grads.length}`);

  const byIntegrator = new Map<string, { n: number; init: Set<string>; sample?: Address }>();
  for (const l of creates) {
    const a = decodeEventLog({ abi: airlockAbi, eventName: "Create", data: l.data, topics: l.topics as [Hex, ...Hex[]] }).args;
    const { integrator } = await assetData(rpc, config.airlock, a.asset);
    const e = byIntegrator.get(integrator) ?? { n: 0, init: new Set() };
    e.n++;
    e.init.add(a.initializer.toLowerCase());
    e.sample = a.asset;
    byIntegrator.set(integrator, e);
  }
  console.log("\nlaunches by integrator:");
  for (const [i, e] of [...byIntegrator].sort((a, b) => b[1].n - a[1].n)) {
    const pad = i === config.integrators.long ? "← LONG" : i === config.integrators.bankr ? "← BANKR" : "";
    console.log(`  ${i} ×${e.n} initializers=${[...e.init].join(",")} ${pad}`);
  }

  for (const pad of ["long", "bankr"] as const) {
    const e = byIntegrator.get(config.integrators[pad]);
    if (!e?.sample) {
      console.log(`\n✗ ${pad}: no launches from integrator ${config.integrators[pad]} in range; try --blocks`);
      continue;
    }
    const s = await initializerState(rpc, config.initializer, e.sample);
    const id = poolIdOf(s.poolKey);
    const raw = await call(rpc, config.initializer, initializerAbi, "getState", [e.sample]);
    const hook = raw[2] as Address;
    const flags = BigInt(await call(rpc, config.initializer, hookFlagsAbi as any, "isDopplerHookEnabled", [hook]));
    console.log(`\n${pad} sample ${e.sample} paired ${await symbolOf(rpc, s.numeraire)}`);
    console.log(`  status=${PoolStatus[s.status]} farTick=${s.farTick} tick=${await currentTick(rpc, config.poolManager, id)} poolId=${id}`);
    console.log(`  dopplerHook=${hook} flags=${flags} → graduate() ${flags & ON_GRADUATION_FLAG ? "possible" : "always reverts (no ON_GRADUATION_FLAG)"}`);
  }
  rpc.stop();
} catch (e) {
  console.log(`✗ ${errMsg(e)}`);
}
process.exit(0);
