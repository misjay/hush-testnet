# Deploying Hush testnet

Hush has two parts:

1. **The Hush server** (this repo): web app, API, Polymarket sync, ledger. Small; any host that runs Docker or Node 22.18+.
2. **A Zcash testnet wallet**: Zebra (node) + Zallet (wallet) for real deposits and withdrawals. Heavier; needs a VPS with disk for the testnet chain.

You can launch part 1 first. Without a wallet, the site runs with the $250 practice balance and shows "Deposits aren't switched on yet" on the deposit screen.

---

## Part 1: the Hush server on Fly.io

1. Install the Fly CLI and sign in: `fly auth login`.
2. In this folder, edit `fly.toml`: set `app` to your app name and `HUSH_ORIGIN` to `https://<your-app>.fly.dev` (or your own domain).
3. Create the app and a 1 GB volume for the database:
   ```bash
   fly launch --copy-config --no-deploy
   fly volumes create hush_data --size 1 --region lhr
   fly deploy
   ```
4. Open `https://<your-app>.fly.dev/api/health`. You should see `"data":"polymarket"` and, after a minute, a `listingsAt` time.

Keep it to **one machine**: the database is SQLite on a single volume. (`fly scale count 1`.)

### Custom domain
`fly certs add hush.yourdomain.com`, point the DNS record Fly shows you, then set `HUSH_ORIGIN=https://hush.yourdomain.com` in `fly.toml` and redeploy. Passkeys are tied to this exact address, so set it before people create passkeys.

### Other hosts
Any Docker host works: `docker build -t hush . && docker run -d -p 8787:8787 -v hush_data:/data -e HUSH_ORIGIN=https://your.site -e HUSH_TRUST_PROXY=1 hush`. Put it behind HTTPS (Caddy or Nginx). Passkeys require HTTPS except on `localhost`.

---

## Part 2: the Zcash testnet wallet (Zebra + Zallet)

The Zcash Foundation's **Z3** project runs Zebra and Zallet together with Docker Compose on testnet.

1. Get a VPS (Ubuntu, Docker installed). Check Z3's README for current disk and memory needs; Zebra must sync the testnet chain before Zallet can use it.
2. Start the testnet stack:
   ```bash
   git clone https://github.com/ZcashFoundation/z3 && cd z3
   ./scripts/setup-network.sh testnet
   docker compose --env-file .env.testnet up -d zebra
   ./scripts/check-zebra-readiness.sh 18080     # wait until Zebra is synced
   docker compose --env-file .env.testnet up -d
   ```
3. Note Zallet's RPC address and credentials from Z3's config (`Z3_ZALLET_HOST_RPC_PORT` and the Zallet RPC auth settings). Keep the RPC port private: firewall it so only the Hush server can reach it, or run Hush on the same VPS.
4. Point Hush at it:
   ```bash
   fly secrets set HUSH_ZALLET_URL=http://<vps-private-ip>:<port> HUSH_ZALLET_USER=<user> HUSH_ZALLET_PASSWORD=<password>
   ```
   (Or `HUSH_ZALLET_COOKIE=/path/to/cookie` if Hush runs on the same machine.)
5. On first start Hush creates a wallet account named `hush-house` and gives each vault its own shielded address from it. To reuse an account, set `HUSH_ZALLET_ACCOUNT=<account uuid>`.
6. **Fund the house wallet** with testnet TAZ from a faucet so withdrawals can be paid. Get an address for it with Zallet's `z_getaddressforaccount` on the `hush-house` account.
7. Check `/api/health` shows `"wallet":"zallet"`. Make a small test deposit from a testnet wallet and watch it go from "Confirming 0/3" to "Credited" in the vault.

### Wallet settings

| Variable | Default | Meaning |
|---|---|---|
| `HUSH_ZALLET_URL` | unset | Zallet JSON-RPC URL. Unset means deposits and withdrawals are off |
| `HUSH_ZALLET_USER` / `HUSH_ZALLET_PASSWORD` | unset | RPC basic auth |
| `HUSH_ZALLET_COOKIE` | unset | Path to an RPC cookie file instead of user/password |
| `HUSH_ZALLET_ACCOUNT` | auto | House account UUID |
| `HUSH_ZALLET_MINCONF` | Zallet default | Confirmations before notes can be spent for withdrawals |
| `HUSH_ZALLET_PRIVACY` | `AllowRevealedAmounts` | `z_sendmany` privacy policy |
| `HUSH_DEPOSIT_CONFS` | `3` | Confirmations before a deposit is credited |
| `HUSH_WALLET_MS` | `30000` | How often deposits and withdrawals are processed |
| `HUSH_ZEC_PRICE` | live | Pin the ZEC price instead of fetching it (demos) |

### What to expect from Zallet
Zallet is in beta and its RPC still differs from zcashd in places. Hush uses `z_listaccounts`, `z_getnewaccount`, `z_getaddressforaccount`, `z_listunspent`, `z_viewtransaction`, `z_sendmany` and `z_getoperationstatus`. If a Zallet update changes one of these, the wallet loop logs the error (`[wallet] error ...`) and `/api/health` keeps working; adjust `src/zcash/wallet.ts`.

---

## Before you share the link

- [ ] `/api/health` shows `data: polymarket`, `ledgerBalanced: true`, and the wallet you expect.
- [ ] `HUSH_ORIGIN` matches the address people will use (passkeys depend on it).
- [ ] House wallet is funded with TAZ and one real deposit and withdrawal have worked end to end.
- [ ] The faucet links on the "Get testnet ZEC" page still work (edit the `FAUCETS` list in `web/index.html` if not).
- [ ] Read Polymarket's Terms of Use (polymarket.com) for using their public data in another product.
- [ ] Back up `/data/hush.db` (Fly: `fly volumes snapshots create`).

## Operating

- Settle a Zcash-native market or void a market: `fly ssh console -C "node --disable-warning=ExperimentalWarning src/admin.ts list"` then `... src/admin.ts <marketId> yes|no|void`.
- Polymarket markets settle automatically within five minutes of resolving.
