# Grad Bot: Long + Bankr (Robinhood Chain)

Implements [bot.md](bot.md), adjusted to what the contracts on Robinhood Chain actually do. Node ≥ 22 (built-in WebSocket), one process, one WSS connection.

```sh
pnpm install
cp .env.example .env        # fill it in
pnpm run test:telegram      # sample post (with buttons) to each channel
pnpm run verify             # live check: topics, pad attribution, pool status, hook flags
pnpm start
```

| File | Role |
| --- | --- |
| `src/rpc.ts` | WSS JSON-RPC: backoff reconnect, newHeads heartbeat (30s), chunked `getLogs` that halves on errors |
| `src/watcher.ts` | Per-connection loop: subscribe (buffered), backfill `lastBlock+1 → head`, drain, go live; dedup and serial processing |
| `src/launches.ts` | Airlock `Create` → attribute to Long/Bankr → track pool; PoolManager `Swap` → graduation rule; `Graduate`/`Migrate` as extra signals |
| `src/telegram.ts` | One queue per channel, 1/s and 20/min each, ~30/s global, per-channel 429 handling |
| `src/state.ts` | `state.json`: atomic write, flushed every 5s and on SIGINT/SIGTERM; migrates the old two-chain state |
| `src/verify.ts` | The bot.md verify checklist against the live chain |

## How it decides

**Attribution.** Long and Bankr both launch through the shared Airlock using the same `DopplerHookInitializer` (`0x4e34…a544`). The initializer can't tell them apart. The Airlock's stored `integrator` can:

| Integrator | Pad | Notes |
| --- | --- | --- |
| `0x92d435c9…f765` | Long | Stock-token numeraires (NVDA, SPY, TSLA…). Addresses end in `1e18`. Sent through launcher `0x1eef…2104`, which emits the same `LaunchCreated` event as the verified `LongLauncher`. Not confirmed against long.xyz itself (its API is behind Cloudflare) |
| `0xf60633d0…163e` | Bankr | Confirmed: every sampled token appears in `api.bankr.bot/token-launches/<token>` with `"chain":"robinhood"`. WETH, BNKR or stock numeraires. Addresses end in `ba3`. Sent straight to the Airlock from creator wallets |

`0xae478d76…0db5`, which an earlier version of this bot wrongly treated as Bankr, is not Bankr: none of its tokens appear in Bankr's API on either chain.

Everything else on the Airlock (about a fifth of launches) is ignored.

**Graduation.** Graduation fires when the token's price, in its numeraire, reaches `GRAD_MULTIPLE`× its launch price:
- The launch price is the pool's initial tick, read from the `Initialize` log in the launch tx, so catch-up runs stay correct.
- The rule is checked on every PoolManager `Swap` for a tracked pool.
- Swaps in the first 10s after launch are ignored.

These on-chain signals are also watched. The first signal wins, and dedup collapses the rest:
- `Graduate(asset)` from the initializer
- `Migrate(asset)` from the Airlock
- tick reaching `farTick`

## Verified on live Robinhood Chain (2026-10-03)

- Chain ID is 4663, and `eth_subscribe` works on the pocket.network endpoint.
- **bot.md doesn't match the verified contracts (Sourcify):**
  - `0x22e9…eeed` is `LongLauncher`. It emits `LaunchCreated`, not `Created`, and has no epochs. It has had no launches in the last 22h+.
  - The epoch model came from a third-party doc (Mobula).
- **No on-chain graduation is possible right now:**
  - Every Long and Bankr pool sampled is `Locked`.
  - Both pads' doppler hooks have flags `3`, which lacks `ON_GRADUATION_FLAG` (4), so `graduate()` always reverts.
  - `Airlock.migrate()` needs `Initialized`, so `Migrate` can't fire either.
  - Long's `farTick` is −887256 (minimum tick), and Bankr's is about 547k ticks away.
  - In 22h there were 0 `Graduate` and 0 `Migrate` events.
- **Provider limits (pocket.network):**
  - Ranges older than roughly the last 50–100k blocks are capped at 1001 blocks per query.
  - Filters with more than about 5 topic values are rejected. So the bot takes every PoolManager `Swap` (about 12/s) and matches PoolIds locally.
- **End to end with Telegram stubbed:**
  - Backfill → attribution → tracking → swap → post works, including creator and paired symbol. Tested at 1.01×.
  - Old state migrated cleanly.
  - Subscribe timeouts recovered on their own.
- **Trading activity is thin:**
  - Across ~150 Long/Bankr launches over 2.8h, the best had reached 1.06×, and most had never traded.
  - At the default 10×, expect posts to be rare.

## Notes

- The Robinhood block time is about 0.1s. A full `MAX_BACKFILL_BLOCKS` catch-up (100k blocks, about 2.8h) takes about 5 minutes.
- Old `.env` keys (`BASE_WSS_URL`, `BANKR_GRAD_MODE`, `BANKR_MCAP_USD`, `BANKR_INITIALIZERS`) are ignored. `BANKR_TRACK_TTL_HOURS` still works as a fallback for `TRACK_TTL_HOURS`.
- There's no MC line: the multiple rule needs no USD prices.
