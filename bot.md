<!-- # Grad Bot: Long + Bankr

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
7. Run against live chains with both pads posting to private test channels, then switch the two IDs to the real channels. -->

# Grad Bot: Long + Bankr (Robinhood Chain)

Telegram bot that watches two launchpads on Robinhood Chain over one WSS RPC and posts graduated tokens. Long and Bankr each post to their own channel.

| Launchpad       | Chain           | Stack                                                      | "Graduated" means                                       |
| --------------- | --------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Long (long.xyz) | Robinhood Chain | Doppler Airlock + Uniswap v4, paired against stock tokens  | Epoch ended and liquidity migrated                      |
| Bankr           | Robinhood Chain | Doppler Airlock + `DopplerHookInitializer` (v4 multicurve) | Pool reached its target tick (`graduate()` or inferred) |

Base is out of scope. Bankr Base launches use `NoOpMigrator` and never graduate.

Runs for a short period only. Keep it small: one process, one chain watcher with two handlers, one poster, local state file.

---

## Config

```env
TELEGRAM_BOT_TOKEN=
LONG_CHANNEL_ID=                # bot must be admin in both channels
BANKR_CHANNEL_ID=

RH_WSS_URL=                     # Robinhood Chain WSS RPC

BANKR_GRAD_MODE=curve           # curve | mcap
BANKR_MCAP_USD=100000           # only used when mode=mcap
BANKR_TRACK_TTL_HOURS=48        # stop tracking a pool after this with no graduation

RH_GETLOGS_CHUNK=1000           # RH provider times out on larger ranges
STATE_FILE=./state.json
```

---

## Contracts (all Robinhood Chain)

| Contract               | Address                                      | Used by          |
| ---------------------- | -------------------------------------------- | ---------------- |
| Doppler Airlock        | `0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862` | Long + Bankr     |
| Launcher / factory     | `0x22e99278308b393ea1260859b181ad7e78f5eeed` | Long (+ others?) |
| DopplerHookInitializer | `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544` | Bankr            |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | Bankr            |

The Airlock is shared. Every `Create` and `Migrate` on it must be attributed to Long, Bankr, or neither before anything else happens.

Airlock:

```solidity
event Create(address asset, address indexed numeraire, address initializer, address poolOrHook);
event Migrate(address indexed asset, address indexed pool);

function getAssetData(address asset) view returns (
  address numeraire, address timelock, address governance,
  address liquidityMigrator, address poolInitializer, address pool,
  address migrationPool, uint256 numTokensToSell, uint256 totalSupply,
  address integrator
);
```

Long factory:

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

DopplerHookInitializer: `getState(asset)` (returns pool status, PoolKey, `farTick`), `graduate(asset)`, and a graduation event. Exact names and layout come from the verified source.

v4 PoolManager:

```solidity
event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1,
           uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee);
```

### Verify before hardcoding

- [ ] Pull ABIs from the Robinhood explorer and compute topic0 hashes yourself. Don't trust the signatures above blindly.
- [ ] `getAssetData` layout on this Airlock deployment (field count and order).
- [ ] DopplerHookInitializer: exact graduation event name/args, `getState` return layout, and the status enum value that means graduated.
- [ ] Bankr filter: which field marks a launch as Bankr's. Candidates: `integrator` from `getAssetData`, `initializer == 0x4e34…a544` in `Create`, or the `create()` calldata/tx `to`. Check that Long does **not** also use `0x4e34…a544`, or the initializer alone won't separate them.
- [ ] Does `0x22e9…eeed` emit `Created` for Bankr launches too? If yes, filter Long by the same field as above.
- [ ] Bankr migrator: read `liquidityMigrator` for a few Bankr assets. NoOp means `Migrate` never fires for Bankr and the initializer event / tick rule carry graduation.
- [ ] Sanity check: take one Bankr token that pumped hard and call `getState`. Graduated status means someone calls `graduate()`; tick past `farTick` with status unchanged means nobody does and the tick rule does all the work.
- [ ] Confirm chain ID and that the provider supports `eth_subscribe`.

---

## Architecture

```
                 ┌─► LongHandler ──┐                                 ┌──► LONG_CHANNEL_ID
 RH WSS ──► Watcher                ├─► Graduated{…} ─► Dedup ─► Poster ─┤
                 └─► BankrHandler ─┘                                 └──► BANKR_CHANNEL_ID
                          ▲
            state.json (lastBlock, tracked tokens, posted set)
```

One connection, one `lastBlock`, one backfill path. The watcher fans logs out by address/topic0; shared Airlock logs go to whichever handler owns the asset.

```ts
type Graduated = {
  pad: "long" | "bankr";
  token: Address;
  name: string;
  symbol: string;
  numeraire: Address; // Long: stock token (NVDA…). Bankr: WETH or a stock token
  pool: Address | Hex; // pool address or v4 PoolId
  creator?: Address;
  how: "migrate" | "graduate" | "tick" | "mcap" | "epoch";
  launchedAt: number;
  graduatedAt: number;
  txHash?: Hex; // omitted when inferred from state
};
```

---

## Subscriptions

| Filter                                         | Purpose                          |
| ---------------------------------------------- | -------------------------------- |
| Long factory, topic0 = `Created`               | Long launches                    |
| Airlock, topic0 ∈ {`Create`, `Migrate`}        | Bankr launches, both graduations |
| Initializer `0x4e34…`, topic0 = graduation evt | Bankr graduation (primary)       |
| PoolManager, topic0 = `Swap`, topic1 ∈ PoolIds | Bankr tick/mcap rule (fallback)  |
| `newHeads`                                     | Heartbeat                        |

---

## LongHandler

1. On `Created`: store `{asset, poolId, epochStart, epochEnd, creator, name}` in `tracked.long`.
2. Primary graduation: Airlock `Migrate` where `asset ∈ tracked.long`. Emit `Graduated` (`how: "migrate"`).
3. Fallback: timer at `epochEnd + 30s`. Call `getAssetData(asset)`. If pool/migrator state shows completion, emit (`how: "epoch"`). Otherwise retry every 60s for 10 min, then drop.
4. Enrich: `symbol()`, `decimals()`, and `symbol()` on the numeraire ("paired with NVDA").

Long completes on time, not reserves. No swap watching.

---

## BankrHandler

1. On Airlock `Create`: drop it unless the Bankr filter matches and the asset isn't Long's.
2. Read `getState(asset)` once: PoolKey → PoolId, `farTick`, current status. If already graduated, emit immediately (backfill case). Store `{asset, numeraire, poolId, farTick, assetIsCurrency0, totalSupply, createdAt}` in `tracked.bankr`. Rebuild the `Swap` topic1 filter.
3. Graduation, first signal wins:
   - **Initializer graduation event** for a tracked asset → `how: "graduate"`.
   - **Airlock `Migrate`** for a tracked asset (only if Bankr uses a real migrator) → `how: "migrate"`.
   - **Swap rule** on each `Swap` for a tracked PoolId:
     - `BANKR_GRAD_MODE=curve` (default): graduated when `tick` reaches `farTick` in the direction the asset gets more expensive (`assetIsCurrency0` → tick rising, else falling) → `how: "tick"`. This is the condition `graduate()` itself checks, so it catches tokens nobody calls `graduate()` on.
     - `BANKR_GRAD_MODE=mcap`: price from `sqrtPriceX96` (invert if asset is currency1) × numeraire USD × `totalSupply` ≥ `BANKR_MCAP_USD` → `how: "mcap"`. Needs a USD price for the numeraire: WETH from a WETH/USDC v4 pool on RH, refreshed every 60s. Stock-paired launches need a stock-token price source; skip them in mcap mode until there is one.
   - Ignore swaps in the first 10s after launch (decaying anti-snipe fee makes early prints noisy).
4. On graduation: emit `Graduated`, remove from `tracked.bankr`, rebuild the `Swap` filter.
5. Prune pools with no graduation after `BANKR_TRACK_TTL_HOURS`.

---

## WSS reliability

- Store `lastBlock` in `state.json`; update after each processed log.
- On disconnect: back off (1s, 2s, 4s, capped at 30s), reconnect, then `eth_getLogs(lastBlock+1 → latest)` with every filter above **before** resubscribing. Process backfill, then go live.
- Backfill in `RH_GETLOGS_CHUNK` ranges. On timeout, halve the chunk and retry.
- Heartbeat: no `newHeads` for 30s → dead, force reconnect.
- Ignore `removed: true` logs.

---

## Dedup & state

```json
{
  "lastBlock": 0,
  "tracked": { "long": {}, "bankr": {} },
  "posted": ["long:0x…", "bankr:0x…"]
}
```

- Key = `${pad}:${token}`. Skip if already in `posted`. Multiple graduation signals for one token collapse here.
- Atomic writes (tmp + rename). Flush every 5s and on SIGINT/SIGTERM.
- Migrating from the old two-chain state: drop `lastBlock.base` and any Base entries in `tracked.bankr`; start `lastBlock` from the old `lastBlock.robinhood`.

---

## Telegram post

Route by `pad`. One bot token serves both channels.

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
Paired: WETH            (or the stock token)
Signal: graduate()      (or: curve end reached / mcap ≥ $100k / migrated)
CA: 0x…
MC: $123k               (only when numeraire has a USD price)
Launched → graduated: 47m

[Chart] [Explorer] [Bankr]
```

- `parse_mode=HTML`, escape names (user input), disable link previews.
- Links go in inline keyboard buttons, not the body.
- One queue per channel. ≤1 msg/s and ~20/min per channel, under ~30 msg/s overall. On 429, honor `retry_after` for that channel only.

---

## Logging

- One line per event: `pad kind token block tx`.
- Every 5 min: tracked counts per pad, `lastBlock`/head, WSS uptime.

---

## Build order

1. Config + state + poster (test message to each channel).
2. Single RH watcher: subscribe, heartbeat, backfill. Log every filter, no handlers.
3. Run the verify checklist against live logs: topic0s, Bankr filter, `getState` layout, migrator, sanity-check token.
4. Long: `Created` → `Migrate` → epochEnd fallback.
5. Bankr: `Create` + filter → `getState` tracking → initializer event → `Swap` tick rule.
6. Dedup and reconnect hardening.
7. Live run into private test channels, then switch both IDs to the real channels.
