// Checks the bot.md "Verify before hardcoding" list against live chains.
// Usage: npm run verify [-- --blocks 20000]
import { decodeEventLog, type Address, type Hex } from "viem";
import { airlockAbi, call, integratorOf, longFactoryAbi, multicurveState, poolIdOf, TOPIC, v3PriceUsd } from "./abis";
import { config } from "./config";
import { errMsg } from "./log";
import { WssRpc, type RpcLog } from "./rpc";

const argIdx = process.argv.indexOf("--blocks");
const BLOCKS = Number(argIdx >= 0 ? process.argv[argIdx + 1] : 20_000);
const KNOWN: Record<string, string> = Object.fromEntries(Object.entries(TOPIC).map(([k, v]) => [v, k]));
const BANKR_INIT_HINTS = ["0xd59ce43", "0xa36715d"]; // Decay / Scheduled multicurve initializers (bot.md)

function connect(chain: string, url: string): Promise<WssRpc> {
  return new Promise((resolve, reject) => {
    const rpc: WssRpc = new WssRpc(chain, url, async () => resolve(rpc), config.getLogsChunk);
    rpc.start();
    setTimeout(() => reject(new Error(`${chain}: could not connect + subscribe newHeads in 30s`)), 30_000);
  });
}

async function recentLogs(rpc: WssRpc, address: Address, topics?: Hex[]) {
  const head = await rpc.blockNumber();
  const from = Math.max(0, head - BLOCKS);
  return { logs: await rpc.getLogs({ address, topics }, from, head), from, head };
}

function printTopicCounts(label: string, logs: RpcLog[], expect: string[]) {
  const counts = new Map<string, number>();
  for (const l of logs) counts.set(l.topics[0], (counts.get(l.topics[0]) ?? 0) + 1);
  console.log(`  ${label}: ${logs.length} logs`);
  for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`    ${t}  ×${n}  ${KNOWN[t.toLowerCase()] ?? ""}`);
  for (const name of expect) {
    const seen = counts.has(TOPIC[name as keyof typeof TOPIC]);
    console.log(`    ${seen ? "✓" : "✗"} ${name} ${seen ? "seen" : "NOT seen in range (wrong signature, or just no activity?)"}`);
  }
}

console.log("== topic0 (computed from bot.md signatures) ==");
for (const [k, v] of Object.entries(TOPIC)) console.log(`  ${k.padEnd(8)} ${v}`);

// --- Robinhood / Long ---
if (config.longEnabled) {
  console.log("\n== Robinhood Chain / Long ==");
  try {
    const rpc = await connect("robinhood", config.rhWss);
    console.log(`  chainId: ${Number(await rpc.request<Hex>("eth_chainId"))}  (eth_subscribe newHeads ✓)`);
    const f = await recentLogs(rpc, config.long.factory);
    console.log(`  blocks ${f.from} → ${f.head}`);
    printTopicCounts("Factory", f.logs, ["Created"]);
    const a = await recentLogs(rpc, config.long.airlock);
    printTopicCounts("Airlock", a.logs, ["Migrate"]);

    const created = f.logs.filter((l) => l.topics[0] === TOPIC.Created).at(-1);
    if (created) {
      const { args } = decodeEventLog({ abi: longFactoryAbi, eventName: "Created", data: created.data, topics: created.topics as [Hex, ...Hex[]] });
      console.log(`  latest Created: ${args.asset} "${args.name}" epoch ${args.epochStart} → ${args.epochEnd}`);
      try {
        const d = await call(rpc, config.long.airlock, airlockAbi, "getAssetData", [args.asset]);
        console.log(`  getAssetData: numeraire=${d[0]} migrator=${d[3]} initializer=${d[4]} pool=${d[5]}`);
      } catch (e) {
        console.log(`  ✗ getAssetData failed: ${errMsg(e)}`);
      }
    }
    rpc.stop();
  } catch (e) {
    console.log(`  ✗ ${errMsg(e)}`);
  }
}

// --- Base / Bankr ---
if (config.bankrEnabled) {
  console.log("\n== Base / Bankr ==");
  try {
    const rpc = await connect("base", config.baseWss);
    console.log(`  chainId: ${Number(await rpc.request<Hex>("eth_chainId"))}`);
    const c = await recentLogs(rpc, config.bankr.airlock, [TOPIC.Create]);
    console.log(`  blocks ${c.from} → ${c.head}: ${c.logs.length} Airlock Create logs (all Doppler launches)`);

    const byInit = new Map<string, { n: number; sample: RpcLog }>();
    for (const l of c.logs) {
      const { args } = decodeEventLog({ abi: airlockAbi, eventName: "Create", data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      const init = args.initializer.toLowerCase();
      const e = byInit.get(init) ?? { n: 0, sample: l };
      e.n++;
      e.sample = l;
      byInit.set(init, e);
    }
    console.log("  initializers:");
    for (const [init, { n }] of [...byInit].sort((a, b) => b[1].n - a[1].n)) {
      const tags = [
        BANKR_INIT_HINTS.some((h) => init.startsWith(h)) ? "← matches bot.md Bankr hint" : "",
        config.bankr.initializers.includes(init as Address) ? "[configured]" : "",
      ].join(" ");
      console.log(`    ${init}  ×${n}  ${tags}`);
    }

    const target = [...byInit].find(([i]) => config.bankr.initializers.includes(i as Address) || BANKR_INIT_HINTS.some((h) => i.startsWith(h)));
    if (target) {
      const [init, { sample }] = target;
      const { args } = decodeEventLog({ abi: airlockAbi, eventName: "Create", data: sample.data, topics: sample.topics as [Hex, ...Hex[]] });
      console.log(`  sample launch ${args.asset} (tx ${sample.transactionHash})`);
      try {
        const s = await multicurveState(rpc, init as Address, args.asset);
        console.log(`  ✓ getState: numeraire=${s.numeraire} status=${s.status} farTick=${s.farTick}`);
        console.log(`    poolKey=${JSON.stringify(s.poolKey, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        console.log(`    poolId=${poolIdOf(s.poolKey)}  isToken0=${s.poolKey.currency0.toLowerCase() === args.asset.toLowerCase()}`);
      } catch (e) {
        console.log(`  ✗ getState failed (initializer ABI differs from upstream?): ${errMsg(e)}`);
      }
      const integ = await integratorOf(rpc, config.bankr.airlock, args.asset).catch(() => undefined);
      const ok = !config.bankr.integrator || integ === config.bankr.integrator;
      console.log(`  ${ok ? "✓" : "✗"} integrator (Airlock getAssetData): ${integ ?? "unreadable"}${config.bankr.integrator ? `, configured ${config.bankr.integrator}` : ""}`);
    } else {
      console.log("  ✗ no Create from a configured/hinted initializer in range; try a larger --blocks");
    }

    try {
      console.log(`  WETH price: $${(await v3PriceUsd(rpc, config.bankr.wethUsdcPool, config.bankr.weth, 18)).toFixed(2)}`);
    } catch (e) {
      console.log(`  ✗ WETH price read failed: ${errMsg(e)}`);
    }
    rpc.stop();
  } catch (e) {
    console.log(`  ✗ ${errMsg(e)}`);
  }
}

process.exit(0);
