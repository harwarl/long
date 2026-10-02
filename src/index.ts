import { BankrWatcher } from "./bankr";
import { config } from "./config";
import { formatGraduated } from "./format";
import { errMsg, log } from "./log";
import { LongWatcher } from "./long";
import { Store } from "./state";
import { Poster } from "./telegram";
import type { Graduated } from "./types";
import type { Watcher } from "./watcher";

process.on("unhandledRejection", (e) => log("unhandledRejection:", errMsg(e)));

const poster = new Poster(config.telegramToken, { long: config.longChannel, bankr: config.bankrChannel });

// Build-order step 1: `npm run test:telegram` sends one message to each channel and exits.
if (process.argv.includes("--test")) {
  // Sample posts in the real format (with buttons), clearly marked as tests.
  const now = Math.floor(Date.now() / 1000);
  const sample = (g: Graduated) => {
    const m = formatGraduated(g);
    return { ...m, text: `🧪 <i>TEST POST — not a real graduation</i>\n\n${m.text}` };
  };
  poster.post("long", sample({
    pad: "long", chain: "robinhood", token: "0x0000000000000000000000000000000000000001", name: "Test Token", symbol: "TEST",
    numeraire: "0x0000000000000000000000000000000000000002", pairedSymbol: "NVDA", pool: "0x00",
    creator: "0x0000000000000000000000000000000000000003", launchedAt: now - 8040, graduatedAt: now,
  }));
  poster.post("bankr", sample({
    pad: "bankr", chain: "base", token: "0x0000000000000000000000000000000000000001", name: "Test Token", symbol: "TEST",
    numeraire: config.bankr.weth, pool: "0x00", launchedAt: now - 3600, graduatedAt: now, rule: config.bankrGradMode, mcapUsd: 123_000,
  }));
  await poster.drain(60_000);
  const long = poster.stats("long");
  const bankr = poster.stats("bankr");
  log("test", "long", long, "bankr", bankr);
  process.exit(long.delivered && bankr.delivered ? 0 : 1);
}

const store = new Store(config.stateFile);
store.start();

const emit = (g: Graduated) => {
  const key = `${g.pad}:${g.token.toLowerCase()}`;
  if (store.hasPosted(key)) {
    log(g.pad, g.chain, "duplicate", g.token);
    return;
  }
  store.markPosted(key);
  poster.post(g.pad, formatGraduated(g));
};

const watchers: Watcher[] = [];
if (config.longEnabled) watchers.push(new LongWatcher(store, emit));
if (config.bankrEnabled) watchers.push(new BankrWatcher(store, emit));
if (!watchers.length) throw new Error("Both LONG_ENABLED and BANKR_ENABLED are off");
watchers.forEach((w) => w.start());
log("grad-bot started:", watchers.map((w) => w.chain).join(", "), `bankr mode=${config.bankrGradMode}`);

const uptime = (since: number) => {
  if (!since) return "down";
  const m = Math.floor((Date.now() - since) / 60_000);
  return `${Math.floor(m / 60)}h${m % 60}m`;
};

setInterval(() => {
  for (const w of watchers) {
    log("status", w.chain, `tracked=${w.trackedCount()}`, `lastBlock=${store.lastBlock(w.chain)}`, `head=${w.rpc.headBlock}`, `wss=${uptime(w.rpc.connectedAt)}`);
  }
  log("status", "posted", store.data.posted.length, "queued", poster.pendingCount());
}, 5 * 60_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("shutdown:", signal);
  watchers.forEach((w) => w.stop());
  await poster.drain(5_000);
  store.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
