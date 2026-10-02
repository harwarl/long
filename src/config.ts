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

function bool(name: string, def: boolean): boolean {
  const v = env(name);
  return v === undefined ? def : /^(1|true|yes|on)$/i.test(v);
}

const addr = (name: string, def: string) => (env(name) ?? def).toLowerCase() as Address;

const list = (name: string) =>
  (env(name) ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as Address[];

function gradMode(): "curve" | "mcap" {
  const v = env("BANKR_GRAD_MODE") ?? "curve";
  if (v !== "curve" && v !== "mcap") throw new Error("BANKR_GRAD_MODE must be curve or mcap");
  return v;
}

// Required values are getters so `--test` only needs the Telegram vars.
export const config = {
  get telegramToken() { return req("TELEGRAM_BOT_TOKEN"); },
  get longChannel() { return req("LONG_CHANNEL_ID"); },
  get bankrChannel() { return req("BANKR_CHANNEL_ID"); },
  get rhWss() { return req("RH_WSS_URL"); },
  get baseWss() { return req("BASE_WSS_URL"); },

  longEnabled: bool("LONG_ENABLED", true),
  bankrEnabled: bool("BANKR_ENABLED", true),

  bankrGradMode: gradMode(),
  bankrMcapUsd: num("BANKR_MCAP_USD", 100_000),
  bankrTtlHours: num("BANKR_TRACK_TTL_HOURS", 48),

  stateFile: env("STATE_FILE") ?? "./state.json",
  getLogsChunk: num("GETLOGS_CHUNK", 2000),
  maxBackfillBlocks: num("MAX_BACKFILL_BLOCKS", 50_000),

  long: {
    factory: addr("LONG_FACTORY", "0x22e99278308b393ea1260859b181ad7e78f5eeed"),
    airlock: addr("LONG_AIRLOCK", "0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862"),
    fallbackLookback: num("LONG_FALLBACK_LOOKBACK_BLOCKS", 20_000),
    postOnEpochEnd: bool("LONG_POST_ON_EPOCH_END", false),
  },

  bankr: {
    airlock: addr("BANKR_AIRLOCK", "0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12"),
    poolManager: addr("BASE_POOL_MANAGER", "0x498581fF718922c3f8e6A244956aF099B2652b2b"),
    initializers: list("BANKR_INITIALIZERS"),
    integrator: env("BANKR_INTEGRATOR")?.toLowerCase() as Address | undefined,
    swapTopicChunk: num("BANKR_SWAP_TOPIC_CHUNK", 200),
    weth: addr("BASE_WETH", "0x4200000000000000000000000000000000000006"),
    usdc: addr("BASE_USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    wethUsdcPool: addr("BASE_WETH_USDC_POOL", "0xd0b53D9277642d899DF5C87A3966A349A798F224"),
  },

  links: {
    long: {
      chart: env("LONG_CHART_URL") ?? "https://dexscreener.com/robinhood/{token}",
      explorer: env("LONG_EXPLORER_URL") ?? "https://explorer.chain.robinhood.com/token/{token}",
      site: env("LONG_SITE_URL") ?? "https://long.xyz/token/{token}",
    },
    bankr: {
      chart: env("BANKR_CHART_URL") ?? "https://dexscreener.com/base/{token}",
      explorer: env("BANKR_EXPLORER_URL") ?? "https://basescan.org/token/{token}",
      site: env("BANKR_SITE_URL") ?? "https://bankr.bot/launches/{token}",
    },
  },
};
