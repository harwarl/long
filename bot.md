# Grad Bot: Long + Bankr

Telegram bot that watches two launchpads over WSS RPC and posts graduated tokens. Long and Bankr each post to their own channel.

| Launchpad       | Chain           | Stack                                                     | "Graduated" means                       |
| --------------- | --------------- | --------------------------------------------------------- | --------------------------------------- |
| Long (long.xyz) | Robinhood Chain | Doppler Airlock + Uniswap v4, paired against stock tokens | Epoch ended and liquidity migrated      |
| Bankr           | Base            | Doppler Airlock + v4 multicurve, NoOpMigrator             | No on-chain event. Inferred (see below) |

Runs for a short period only. Keep it small: one process, two chain watchers, one poster, local state file.

---

## Config

```env
TELEGRAM_BOT_TOKEN=
LONG_CHANNEL_ID=                # bot must be admin in both channels
BANKR_CHANNEL_ID=

RH_WSS_URL=                     # Robinhood Chain WSS RPC
BASE_WSS_URL=                   # Base WSS RPC

BANKR_GRAD_MODE=curve           # curve | mcap
BANKR_MCAP_USD=100000           # only used when mode=mcap
BANKR_TRACK_TTL_HOURS=48        # stop tracking a pool after this with no graduation

STATE_FILE=./state.json
```

---

## Contracts

### Long (Robinhood Chain)

| Contract | Address                                      |
| -------- | -------------------------------------------- |
| Factory  | `0x22e99278308b393ea1260859b181ad7e78f5eeed` |
| Airlock  | `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862` |

Factory event:

```solidity
event Created(
  address indexed asset,
  address hook,
  address creator,
  bytes32 poolId,
  uint256 epochStart,
  uint256 epochEnd,
  string name
);
```

Airlock view:

```solidity
function getAssetData(address asset) view returns (
  address numeraire, address timelock, address governance,
  address liquidityMigrator, address poolInitializer, address pool
);
```

### Bankr (Base)

| Contract                       | Address                                       |
| ------------------------------ | --------------------------------------------- |
| Doppler Airlock                | `0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12`  |
| Uniswap v4 PoolManager         | `0x498581fF718922c3f8e6A244956aF099B2652b2b`  |
| DecayMulticurveInitializer     | `0xd59ce43…` (get full address from Basescan) |
| ScheduledMulticurveInitializer | `0xA36715d…` (get full address from Basescan) |

Airlock event (positional: asset, numeraire, initializer, 4th = migrator/poolOrHook):

```solidity
event Create(address asset, address indexed numeraire, address initializer, address poolOrHook);
```

### Verify before hardcoding

- [ ] Pull the ABIs from the explorers and compute topic0 hashes yourself. Don't trust the signatures above blindly.
- [ ] Long: check whether its Airlock emits `Migrate(address indexed asset, address indexed pool)` like upstream Doppler.
- [ ] Bankr: the Base Airlock is shared by **all** Doppler launches, not just Bankr. Find the field that marks a launch as Bankr's (the initializer address, the integrator in the `create()` calldata, or the token factory) and filter on it.
- [ ] Bankr: confirm how to read a pool's final curve segment (`tickUpper` of the last curve) from the initializer's state.
- [ ] Confirm Robinhood Chain's chain ID and that your provider supports `eth_subscribe` there.

---

## Architecture

```
 RH WSS ──► LongWatcher ──┐                                  ┌──► LONG_CHANNEL_ID
                          ├──► Graduated{…} ──► Dedup ──► Poster ─┤
 Base WSS ─► BankrWatcher ┘                                  └──► BANKR_CHANNEL_ID
                   ▲
              state.json (lastBlock per chain, tracked tokens, posted set)
```

Both watchers emit the same event:

```ts
type Graduated = {
  pad: "long" | "bankr";
  chain: "robinhood" | "base";
  token: Address;
  name: string;
  symbol: string;
  numeraire: Address; // Long: stock token (NVDA, AAPL…), Bankr: WETH/USDC
  pool: Address | Hex; // pool address or v4 PoolId
  creator?: Address;
  launchedAt: number;
  graduatedAt: number;
  txHash: Hex;
};
```

---

## LongWatcher

1. Subscribe `logs` on Factory, topic0 = `Created`.
2. On `Created`: store `{asset, poolId, epochEnd, creator, name}` in `tracked.long`.
3. Graduation, primary path: subscribe `logs` on Airlock, topic0 = `Migrate`. If `asset` is in `tracked.long`, emit `Graduated`.
4. Fallback: a timer fires at `epochEnd + 30s`. Call `getAssetData(asset)`. If the pool or migrator state shows the launch completed, emit `Graduated`. If not, retry every 60s for 10 min, then drop.
5. Enrich: `symbol()`, `decimals()`, and `symbol()` on the numeraire, so the post says "paired with NVDA".

Long completes on **time**, not reserves. Progress = `(now - epochStart) / (epochEnd - epochStart)`. No need to watch swaps.

---

## BankrWatcher

1. Subscribe `logs` on Airlock, topic0 = `Create`. Drop anything that isn't Bankr (see the checklist).
2. On a Bankr `Create`: store `{asset, numeraire, initializer, poolId, finalTick, createdAt}` in `tracked.bankr`.
3. Subscribe `logs` on PoolManager, topic0 = `Swap`, topic1 = each tracked PoolId. Keep one subscription with a topic1 array and rebuild it when the tracked set changes, or use one subscription per pool if the provider limits array size.
4. On each `Swap`, read `tick` and `sqrtPriceX96` from the log data, then check the rule:

   **`BANKR_GRAD_MODE=curve`** (default): graduated when the pool tick crosses `finalTick`, the end of the last curve segment, in the direction the asset gets more expensive. Closest thing to a real graduation.

   **`BANKR_GRAD_MODE=mcap`**: price = sqrtPriceX96 → asset/numeraire price × numeraire USD price. mcap = price × totalSupply. Graduated when mcap ≥ `BANKR_MCAP_USD`. Cache the numeraire USD price (WETH) and refresh it every 60s from a v4/v3 WETH/USDC pool on Base.

5. On graduation: emit `Graduated` and remove the pool from `tracked.bankr`.
6. Prune pools with no graduation after `BANKR_TRACK_TTL_HOURS`.

Liquidity never migrates on Bankr, so the pool address stays the same after graduation.

---

## WSS reliability

- Store `lastBlock` per chain in `state.json` and update it after each processed log.
- On disconnect: back off (1s, 2s, 4s, capped at 30s) and reconnect. Then `eth_getLogs(lastBlock+1 → latest)` with the same filters **before** subscribing again. Process the backfill, then go live.
- Heartbeat: if no `newHeads` arrive for 30s, treat the connection as dead and force a reconnect.
- Ignore `removed: true` logs (reorgs). Base and RH are L2s with rare reorgs, but handle it anyway.
- Chunk backfill `getLogs` into ranges your provider accepts (often 2k–10k blocks).

---

## Dedup & state

```json
{
  "lastBlock": { "robinhood": 0, "base": 0 },
  "tracked": { "long": {}, "bankr": {} },
  "posted": ["long:0x…", "bankr:0x…"]
}
```

- Key = `${pad}:${token}`. Skip if it's already in `posted`.
- Write the state file atomically (write tmp, then rename). Flush every 5s and on SIGINT/SIGTERM.

---

## Telegram post

Route by `pad`: `long` goes to `LONG_CHANNEL_ID` and `bankr` goes to `BANKR_CHANNEL_ID`. One bot token serves both channels.

```
🎓 GRADUATED · LONG
$SYMBOL — Name
Paired: NVDA
CA: 0x…
Creator: 0x…
Launched → graduated: 2h 14m

[Chart] [Explorer] [Long]
```

```
🎓 GRADUATED · BANKR
$SYMBOL — Name
Rule: curve exhausted   (or: mcap ≥ $100k)
CA: 0x…
MC: $123k

[Chart] [Basescan] [Bankr]
```

- Use `parse_mode=HTML`, escape names (they're user input), and disable link previews.
- Put the links in inline keyboard buttons, not the body.
- Rate limit: one queue per channel, so a Bankr burst never delays Long posts. Send at most 1 msg/s and ~20/min per channel, and stay under ~30 msg/s across the whole bot. On 429, honor `retry_after` for that channel only.

---

## Logging

- One line per event: `pad chain kind token block tx`.
- Every 5 min, log the tracked counts, last block per chain, and WSS uptime.

---

## Build order

1. Config + state file + Telegram poster (send a test message to each channel).
2. Long `Created` subscription, logging only.
3. Long graduation: `Migrate` sub, then the epochEnd fallback.
4. Bankr `Create` sub + Bankr-only filter.
5. Bankr `Swap` tracking + the graduation rule.
6. Reconnect/backfill and dedup hardening.
7. Run against live chains with both pads posting to private test channels, then switch the two IDs to the real channels.
