import type { Address } from "viem";

const env = (name: string) => process.env[name]?.trim() || undefined;

function req(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

function num(name: string, def: number): number {
  const v = Number(env(name) ?? def);
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
}

const addr = (name: string, def: string) => (env(name) ?? def).toLowerCase() as Address;

const addrs = (name: string, def: string) =>
  (env(name) ?? def)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as Address[];

const gradMultiple = num("GRAD_MULTIPLE", 10);

// Required values are getters so `--test` only needs the Telegram vars.
export const config = {
  get telegramToken() { return req("TELEGRAM_BOT_TOKEN"); },
  get longChannel() { return req("LONG_CHANNEL_ID"); },
  get bankrChannel() { return req("BANKR_CHANNEL_ID"); },
  get rhWss() { return req("RH_WSS_URL"); },

  // Graduated = price reached N× its launch price (in the numeraire), per pad.
  gradMultiple: {
    long: num("LONG_GRAD_MULTIPLE", gradMultiple),
    bankr: num("BANKR_GRAD_MULTIPLE", gradMultiple),
  },
  trackTtlHours: num("TRACK_TTL_HOURS", num("BANKR_TRACK_TTL_HOURS", 48)),
  ignoreSwapsAfterLaunchS: num("IGNORE_SWAPS_AFTER_LAUNCH_S", 10), // anti-snipe fee makes early prints noisy

  stateFile: env("STATE_FILE") ?? "./state.json",
  getLogsChunk: num("RH_GETLOGS_CHUNK", 1000), // provider allows ~1001 blocks for older ranges
  maxBackfillBlocks: num("MAX_BACKFILL_BLOCKS", 100_000), // ~2.8h at ~0.1s blocks

  // Robinhood Chain (4663)
  airlock: addr("AIRLOCK", "0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862"),
  initializer: addr("INITIALIZER", "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544"), // DopplerHookInitializer
  poolManager: addr("POOL_MANAGER", "0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  // Airlock getAssetData().integrator is the only field that separates the pads (same initializer).
  // Comma-separated lists. Bankr's was confirmed against api.bankr.bot/token-launches/<token>.
  integrators: {
    long: addrs("LONG_INTEGRATOR", "0x92d435c96e63c43e12d6d0ab28f6b0b04072f765"),
    bankr: addrs("BANKR_INTEGRATOR", "0xf60633d02690e2a15a54ab919925f3d038df163e"),
  },

  links: {
    long: {
      chart: env("LONG_CHART_URL") ?? "https://dexscreener.com/robinhood/{token}",
      explorer: env("LONG_EXPLORER_URL") ?? "https://robinhoodchain.blockscout.com/token/{token}",
      site: env("LONG_SITE_URL") ?? "", // token page path unknown (/token/<addr> is a 404); set LONG_SITE_URL once known
    },
    bankr: {
      chart: env("BANKR_CHART_URL") ?? "https://dexscreener.com/robinhood/{token}",
      explorer: env("BANKR_EXPLORER_URL") ?? "https://robinhoodchain.blockscout.com/token/{token}",
      site: env("BANKR_SITE_URL") ?? "https://bankr.bot/launches/{token}",
    },
  },
};
