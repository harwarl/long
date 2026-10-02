# Grad Bot: Long + Bankr

Implements [bot.md](bot.md). Node ≥ 22 (uses the built-in WebSocket), one process.

```sh
npm install
cp .env.example .env        # fill it in
npm run test:telegram       # build step 1: one test post to each channel
npm run verify              # check signatures / addresses against live chains
npm start
```

| File | Role |
| --- | --- |
| `src/rpc.ts` | WSS JSON-RPC: backoff reconnect, newHeads heartbeat (30s), chunked `getLogs` |
| `src/watcher.ts` | Shared per-chain loop: subscribe (buffered), backfill `lastBlock+1 → head`, drain, go live; dedup + serial processing |
| `src/long.ts` | Factory `Created` → track; Airlock `Migrate` → graduated; epochEnd+30s fallback |
| `src/bankr.ts` | Airlock `Create` (Bankr-filtered) → track pool; PoolManager `Swap` → curve / mcap rule |
| `src/telegram.ts` | One queue per channel, 1/s and 20/min each, ~30/s global, per-channel 429 handling |
| `src/state.ts` | `state.json`: atomic write, flushed every 5s and on SIGINT/SIGTERM |
| `src/verify.ts` | Prints topic0s, live topic counts, Bankr initializer census, sample `getState` |

## Before going live

`npm run verify` covers the checklist in bot.md:

- **Topics**: shows whether `Created`, `Migrate` (Long) and `Create` (Base) were actually seen in the last N blocks (`-- --blocks 100000` for more).
- **Bankr filter**: lists every initializer on the shared Base Airlock and flags the ones matching `0xd59ce43…` / `0xA36715d…`. Put the full addresses in `BANKR_INITIALIZERS`. Optionally set `BANKR_INTEGRATOR`, which is matched against launch tx calldata.
- **Final curve tick**: assumes the upstream Doppler `getState(asset)` getter on the multicurve initializer, returning `farTick`. Verify confirms it decodes. If it doesn't, Bankr launches get logged as "getState failed" and are not tracked.
- **Robinhood Chain**: prints the chain ID and confirms `eth_subscribe` works.
- **Button URLs**: the Robinhood explorer, Long, Dexscreener-Robinhood and Bankr URL templates are guesses. Override them in `.env`.

## Notes / deviations

- The live subscription is opened *before* backfill and buffered, instead of after it. This closes the gap between the two; the overlap is deduped.
- Long fallback: at epochEnd+30s, look for a missed `Migrate` for the token, then compare `getAssetData` with its value at creation. Retry every 60s for 10 min, then drop. `LONG_POST_ON_EPOCH_END=true` posts on time alone.
- `txHash` is omitted when a Long graduation was inferred from state rather than a log.
- MC is shown only when the Bankr numeraire is WETH or USDC. About a third of Bankr launches pair with ZORA (`0x1111…afc69`). Those get no MC line, and in `mcap` mode they never graduate. `curve` mode is unaffected.

## Verified on live Base (2026-10-02)

- Initializer `0xd59ce43e…` is used only by integrator `0xae478d76…`. Every launch went through ERC-4337 smart wallets. The other active initializer (`0xbdf93814…`) serves six other integrators, so the filter is clean.
- `getState` decodes. The computed poolIds resolve to live pools in StateView. The tick direction toward `farTick` matches `isToken0` on all 40 pools sampled.
- End to end with Telegram stubbed: backfill, then track, then a Swap triggers graduation and a formatted post. MC matched Dexscreener. Restarting resumed from `lastBlock` with no repost. Reconnects after a heartbeat timeout and a subscribe timeout recovered on their own.
- Not yet tested: Long / Robinhood Chain (needs an RPC) and real Telegram delivery (needs a token).
