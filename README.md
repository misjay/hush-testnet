# Hush Testnet

Private prediction markets on Zcash testnet. Hush mirrors live Polymarket markets, prices and results; users bet with testnet ZEC (TAZ), which has no value.

Built so far:

- **Step 1, live market board:** Polymarket data flows into Hush's own database and API, and the web app reads from it.
- **Step 2, vaults and betting:** secret-code vaults, a double-entry ledger, firm quotes, bets and cash-outs, all on the server.
- **Step 3, settlement:** positions settle automatically when Polymarket resolves a market; voids refund; an admin command settles Zcash-native markets.
- **Step 4, passkeys:** sign in with Face ID, a fingerprint or a device PIN; the secret code stays as a backup.
- **Step 5, testnet deposits and withdrawals:** each vault gets its own shielded address from a Zallet testnet wallet; deposits are credited at the live ZEC price; withdrawals send shielded TAZ and refund on failure.
- **Faucet page:** `#faucet` explains how to get testnet ZEC and links to community faucets.

To put it online, follow **DEPLOY.md**.

## Run it

Requires Node 22.18 or newer (runs TypeScript directly, uses Node's built-in SQLite).

```bash
npm install
npm start          # live Polymarket data on http://localhost:8787
npm run mock       # offline: sample markets + a mock wallet (simulated deposits)
npm run settle -- list   # markets with open positions; see DEPLOY.md
npm test           # unit + API tests (uses sample data)
```

## How it works

| Piece | File | Job |
|---|---|---|
| Polymarket client | `src/polymarket/client.ts` | Reads markets from Gamma (`/markets/keyset`, `/tags/slug`) and YES price history from the CLOB (`/prices-history`). Read-only, no account or key. |
| Normaliser | `src/polymarket/normalize.ts` | Parses Gamma's text-encoded lists (`outcomes`, `outcomePrices`, `clobTokenIds`), maps Yes/No tokens, picks a price, detects resolution. |
| Sync | `src/sync.ts` | Every minute: picks the top markets per category by 24h volume and stores prices. Every 15 minutes: refreshes price history. If Polymarket is unreachable, the last good board stays up. |
| Storage | `src/db.ts` | SQLite tables `markets`, `price_history`, `sync_state`. Plain SQL, easy to move to Postgres. |
| Vaults + ledger | `src/vault.ts` | Secret codes, practice grant, quotes, bets, cash-outs, vault view. Integer micro-dollars throughout. |
| Settlement | `src/settle.ts`, `src/admin.ts` | Resolver (every 5 min) and manual settle/void. |
| Passkeys | `src/passkeys.ts` | WebAuthn registration and sign-in, 30-day sessions. |
| Wallet | `src/zcash/wallet.ts`, `src/deposits.ts`, `src/price.ts` | Zallet JSON-RPC connector, mock wallet, deposit watcher, withdrawal queue, ZEC price. |
| API + web | `src/server.ts`, `web/index.html` | The endpoints below, and the Hush web app. |

### Curation rules

A Polymarket market is listed when it is a Yes/No market, open and accepting orders, has at least $250K volume and $10K liquidity, its YES price is between 3% and 97%, and it doesn't close within 6 hours. Markets about deaths, violence or criminal trials are never listed. The top 6 per category by 24h volume are shown, with at most 2 from any one event. Categories map to Polymarket tags: `crypto`, `economy`, `sports`, `pop-culture`. Zcash-native markets are defined in `src/config.ts` with their settlement rule.

### Prices

YES price is the order-book midpoint when the spread is 10¢ or less; otherwise the quoted outcome price; otherwise the last trade. A closed market is treated as resolved when one outcome's price settles at 1.


## API

| Method | Path | Auth | Does |
|---|---|---|---|
| GET | `/api/health` | none | Sync status and whether the ledger balances |
| GET | `/api/markets?category=&q=` | none | The board |
| GET | `/api/markets/:id` | none | One market |
| POST | `/api/vaults` | none | Opens a vault. Returns the secret code once, plus the vault |
| GET | `/api/vault` | code | Balance, open value, positions, recent activity |
| POST | `/api/quotes` | code | `{marketId, side}` → a firm price for 10 seconds |
| POST | `/api/bets` | code | `{quoteId, stake}` (stake in micro-dollars) → opens a position |
| POST | `/api/positions/:id/sell` | code | Cashes out an open position at the current price minus the spread |
| GET | `/api/deposit-address` | code | The vault's shielded testnet deposit address |
| POST | `/api/withdrawals` | code | `{address, amount}` (micro-dollars) → queues a shielded TAZ withdrawal |
| POST | `/api/passkeys/register/options`, `/verify` | code | Adds a passkey to the vault |
| POST | `/api/passkeys/login/options`, `/verify` | none | Signs in with a passkey; returns a session token |
| POST | `/api/sessions/end` | session | Signs a passkey session out |

Auth is `Authorization: Bearer <secret code>` or `Bearer <session token>` from a passkey sign-in. Errors return `{error, code}` with a plain-English `error`.

### Vault and money rules

- **Secret code:** `hush-XXXX-XXXX-XXXX-XXXX-XXXX`, about 99 bits of randomness. The server stores only its SHA-256 fingerprint, so a database leak reveals no codes. Lost codes can't be recovered.
- **Practice grant:** $250 in test dollars per new vault. New vaults are limited to 10 per IP per hour (in memory, not logged). Set `HUSH_TRUST_PROXY=1` behind a reverse proxy.
- **Pricing:** buy at the market price plus 1¢, sell at the market price minus 1¢, clamped to 1¢–99¢. A quote lasts 10 seconds and can be used once, by the vault that asked for it.
- **Stakes:** $1 minimum, $500 maximum per bet on testnet. The balance check happens inside the same transaction as the bet.
- **Ledger:** every money movement is a set of entries that sums to zero across accounts (`vault:<id>`, `house`, `faucet`). `/api/health` reports `ledgerBalanced`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HUSH_DB` | `data/hush.db` | SQLite file |
| `HUSH_MOCK` | unset | `1` serves sample fixtures, no network |
| `HUSH_PER_CATEGORY` | `6` | Markets shown per category |
| `HUSH_MIN_VOLUME` | `250000` | Minimum lifetime volume (USD) |
| `HUSH_MIN_LIQUIDITY` | `10000` | Minimum liquidity (USD) |
| `HUSH_LISTINGS_MS` / `HUSH_HISTORY_MS` | `60000` / `900000` | Sync intervals |
| `HUSH_VAULTS_PER_HOUR` | `10` | New vaults per IP per hour |
| `HUSH_TRUST_PROXY` | unset | `1` behind a reverse proxy |

## Before going public

See the checklist at the end of **DEPLOY.md**. Polymarket's developer docs describe the market and price APIs as public reads with no key; their main Terms of Use on polymarket.com should be read before launch. The site states that Hush isn't affiliated with Polymarket.
