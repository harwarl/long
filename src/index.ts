import { config } from "./config";
import { formatGraduated } from "./format";
import { LaunchWatcher } from "./launches";
import { errMsg, log } from "./log";
import { Store } from "./state";
import { Poster } from "./telegram";
import type { Graduated } from "./types";

process.on("unhandledRejection", (e) => log("unhandledRejection:", errMsg(e)));

const poster = new Poster(config.telegramToken, { long: config.longChannel, bankr: config.bankrChannel });

// Build-order step 1: `pnpm run test:telegram` sends a sample post to each channel and exits.
if (process.argv.includes("--test")) {
  const now = Math.floor(Date.now() / 1000);
  const sample = (g: Graduated) => {
    const m = formatGraduated(g);
    return { ...m, text: `🧪 <i>TEST POST — not a real graduation</i>\n\n${m.text}` };
  };
  const base = { token: "0x0000000000000000000000000000000000000001", name: "Test Token", symbol: "TEST", pool: "0x00", how: "multiple", graduatedAt: now } as const;
  poster.post("long", sample({
    ...base, pad: "long", numeraire: "0x0000000000000000000000000000000000000002", pairedSymbol: "NVDA",
    creator: "0x0000000000000000000000000000000000000003", multiple: config.gradMultiple.long, launchedAt: now - 8040,
  }));
  poster.post("bankr", sample({
    ...base, pad: "bankr", numeraire: "0x0000000000000000000000000000000000000002", pairedSymbol: "WETH",
    multiple: config.gradMultiple.bankr, launchedAt: now - 2820,
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
    log(g.pad, "duplicate", g.token);
    return;
  }
  store.markPosted(key);
  poster.post(g.pad, formatGraduated(g));
};

const watcher = new LaunchWatcher(store, emit);
watcher.start();
log("grad-bot started: robinhood", `multiple long=${config.gradMultiple.long}x bankr=${config.gradMultiple.bankr}x`);

const uptime = (since: number) => {
  if (!since) return "down";
  const m = Math.floor((Date.now() - since) / 60_000);
  return `${Math.floor(m / 60)}h${m % 60}m`;
};

setInterval(() => {
  log("status", watcher.trackedCount(), `lastBlock=${store.lastBlock}`, `head=${watcher.rpc.headBlock}`, `wss=${uptime(watcher.rpc.connectedAt)}`);
  log("status", "posted", store.data.posted.length, "queued", poster.pendingCount());
}, 5 * 60_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("shutdown:", signal);
  watcher.stop();
  await poster.drain(5_000);
  store.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
