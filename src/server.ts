// Hush testnet server: serves the web app and the markets API, and runs the Polymarket sync.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config, CATEGORY_ORDER } from './config.ts';
import { openDb, listedMarkets, marketRow, sparkline, getState, type Db, type MarketRow } from './db.ts';
import { startSync } from './sync.ts';
import { relyingParty, vaultIdForSession, endSession, registrationOptions, verifyRegistration, loginOptions, verifyLogin, passkeyCount } from './passkeys.ts';
import { readFileSync } from 'node:fs';
import { type ZcashWallet, MockWallet, walletFromEnv } from './zcash/wallet.ts';
import { depositAddress, requestWithdrawal, walletActivity, scanDeposits, startWalletLoop, depositRules } from './deposits.ts';
import { VaultError, createVault, vaultIdForCode, vaultView, quote, placeBet, cashOut, ledgerIsBalanced } from './vault.ts';

const vaultLimitPerHour = Number(process.env.HUSH_VAULTS_PER_HOUR ?? 10);

export type ApiMarket = {
  id: string;
  question: string;
  category: string;
  yes: number;
  no: number;
  volume: number;
  volume24h: number;
  endDate: string | null;
  source: 'polymarket' | 'native';
  url: string | null;
  rule: string | null;
  accepting: boolean;
  resolved: 'yes' | 'no' | null;
  history: number[];
};

export function toApi(db: Db, r: MarketRow): ApiMarket {
  const hist = sparkline(db, r.id);
  return {
    id: r.id,
    question: r.question,
    category: r.category,
    yes: r.yes,
    no: Math.round((1 - r.yes) * 10_000) / 10_000,
    volume: r.volume,
    volume24h: r.volume_24h,
    endDate: r.end_date,
    source: r.source as ApiMarket['source'],
    url: r.source === 'polymarket' && r.slug ? `https://polymarket.com/event/${r.slug}` : null,
    rule: r.rule,
    accepting: !!r.accepting && !r.closed,
    resolved: (r.resolved as ApiMarket['resolved']) ?? null,
    history: hist.length >= 2 ? hist : [r.yes, r.yes],
  };
}

export function buildServer(db: Db, opts: { wallet?: ZcashWallet | null } = {}) {
  const wallet = opts.wallet ?? null;
  // Set HUSH_TRUST_PROXY=1 when running behind a reverse proxy so per-IP limits see the real client.
  const app = Fastify({ logger: false, trustProxy: process.env.HUSH_TRUST_PROXY === '1', bodyLimit: 16 * 1024 });

  // Security headers for browser defense
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (process.env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  app.register(fastifyStatic, { root: fileURLToPath(new URL('../web/', import.meta.url)), index: ['index.html'] });

  app.get('/api/health', async () => ({
    ok: true,
    network: 'zcash-testnet',
    data: config.mock ? 'mock' : 'polymarket',
    listingsAt: Number(getState(db, 'listings_at')) || null,
    historyAt: Number(getState(db, 'history_at')) || null,
    lastError: getState(db, 'listings_error'),
    ledgerBalanced: ledgerIsBalanced(db),
    wallet: wallet ? wallet.kind : 'off',
    depositsAt: Number(getState(db, 'deposits_at')) || null,
  }));

  app.get<{ Querystring: { category?: string; q?: string } }>('/api/markets', async (req, reply) => {
    const { category, q } = req.query;
    const needle = (q ?? '').trim().toLowerCase().slice(0, 100);
    const rows = listedMarkets(db)
      .filter((r) => !category || category === 'All' || r.category === category)
      .filter((r) => !needle || r.question.toLowerCase().includes(needle))
      .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || b.volume_24h - a.volume_24h);
    reply.header('cache-control', 'public, max-age=10');
    return {
      updatedAt: Number(getState(db, 'listings_at')) || null,
      data: config.mock ? 'mock' : 'polymarket',
      categories: CATEGORY_ORDER,
      markets: rows.map((r) => toApi(db, r)),
    };
  });

  app.get<{ Params: { id: string } }>('/api/markets/:id', async (req, reply) => {
    const r = marketRow(db, req.params.id);
    if (!r) return reply.code(404).send({ error: 'No market with that id.' });
    return toApi(db, r);
  });

  // ---------- vaults ----------
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof VaultError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err.validation) return reply.code(400).send({ error: 'Check the request and try again.', code: 'bad_request' });
    console.error(err);
    return reply.code(500).send({ error: 'Something went wrong on our side. Try again in a moment.', code: 'server_error' });
  });

  const bearer = (req: { headers: Record<string, unknown> }) => { const h = String(req.headers['authorization'] ?? ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };
  // A request is signed by either the vault's secret code or a passkey session token.
  const vaultFrom = (req: { headers: Record<string, unknown> }) => {
    const t = bearer(req);
    const id = t.startsWith('sess_') ? vaultIdForSession(db, t) : vaultIdForCode(db, t);
    if (!id) throw new VaultError('unknown_code', 'That secret code doesn’t match a vault. Check it and try again.', 401);
    return id;
  };

  // Memory-safe sliding window rate limiter with periodic cleanup
  class SlidingRateLimiter {
    private hits = new Map<string, number[]>();
    private limit: number;
    private windowMs: number;
    constructor(limit: number, windowMs: number) {
      this.limit = limit;
      this.windowMs = windowMs;
    }
    allow(key: string, now = Date.now()): boolean {
      if (this.hits.size > 1000) {
        for (const [k, timestamps] of this.hits.entries()) {
          const fresh = timestamps.filter((t) => now - t < this.windowMs);
          if (fresh.length === 0) this.hits.delete(k);
          else this.hits.set(k, fresh);
        }
      }
      const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
      if (recent.length >= this.limit) return false;
      recent.push(now);
      this.hits.set(key, recent);
      return true;
    }
  }

  const vaultLimiter = new SlidingRateLimiter(vaultLimitPerHour, 3600_000);
  const loginLimiter = new SlidingRateLimiter(30, 60_000);
  const quoteLimiter = new SlidingRateLimiter(60, 60_000);
  const betLimiter = new SlidingRateLimiter(30, 60_000);

  app.post('/api/vaults', async (req, reply) => {
    if (!vaultLimiter.allow(req.ip)) throw new VaultError('rate_limited', 'Too many new vaults from this network. Try again in an hour, or restore one with its code.', 429);
    const { code, vaultId } = createVault(db);
    reply.code(201).header('cache-control', 'no-store');
    return { code, vault: { ...vaultView(db, vaultId), passkeys: 0 } };
  });

  app.get('/api/vault', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const id = vaultFrom(req);
    return { ...vaultView(db, id), passkeys: passkeyCount(db, id), wallet: walletActivity(db, id) };
  });

  // ---------- testnet deposits and withdrawals ----------
  const qrJs = readFileSync(fileURLToPath(new URL('../node_modules/qrcode-generator/qrcode.js', import.meta.url)), 'utf8');
  app.get('/vendor/qrcode.js', async (_req, reply) => reply.type('application/javascript').header('cache-control', 'public, max-age=86400').send(qrJs));

  app.get('/api/deposit-address', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { address: await depositAddress(db, wallet, vaultFrom(req)), confirmations: depositRules.confirmations, network: 'testnet' };
  });
  app.post<{ Body: { address: string; amount: number } }>('/api/withdrawals', {
    schema: { body: { type: 'object', required: ['address', 'amount'], properties: { address: { type: 'string', maxLength: 600 }, amount: { type: 'integer', minimum: 1 } } } },
  }, async (req, reply) => {
    if (!wallet) throw new VaultError('withdrawals_off', 'Withdrawals aren\u2019t switched on for this server yet.', 503);
    const r = await requestWithdrawal(db, vaultFrom(req), req.body.address, req.body.amount);
    reply.code(201);
    return r;
  });
  // Mock wallet only: pretend TAZ arrived at this vault's address, already confirmed.
  app.post<{ Body: { zec?: number } }>('/api/dev/mock-deposit', async (req) => {
    if (!(wallet instanceof MockWallet)) throw new VaultError('not_found', 'Not available.', 404);
    const id = vaultFrom(req);
    const address = await depositAddress(db, wallet, id);
    const zec = Math.min(Math.max(Number(req.body?.zec ?? 0.1), 0.001), 10);
    wallet.receive(address, Math.round(zec * 1e8), depositRules.confirmations);
    await scanDeposits(db, wallet);
    return { ok: true };
  });

  // ---------- passkeys ----------
  const rp = relyingParty(config.port);
  const webauthnJs = readFileSync(fileURLToPath(new URL('../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', import.meta.url)), 'utf8');
  app.get('/vendor/webauthn.js', async (_req, reply) => reply.type('application/javascript').header('cache-control', 'public, max-age=86400').send(webauthnJs));

  app.post('/api/passkeys/register/options', async (req) => registrationOptions(db, rp, vaultFrom(req)));
  app.post<{ Body: { challengeId: string; response: unknown } }>('/api/passkeys/register/verify', {
    schema: { body: { type: 'object', required: ['challengeId', 'response'], properties: { challengeId: { type: 'string', maxLength: 64 }, response: { type: 'object' } } } },
  }, async (req) => verifyRegistration(db, rp, vaultFrom(req), req.body.challengeId, req.body.response));
  app.post('/api/passkeys/login/options', async (req) => {
    if (!loginLimiter.allow(req.ip)) throw new VaultError('rate_limited', 'Too many login attempts. Please wait a minute and try again.', 429);
    return loginOptions(db, rp);
  });
  app.post<{ Body: { challengeId: string; response: unknown } }>('/api/passkeys/login/verify', {
    schema: { body: { type: 'object', required: ['challengeId', 'response'], properties: { challengeId: { type: 'string', maxLength: 64 }, response: { type: 'object' } } } },
  }, async (req, reply) => {
    const { vaultId, session } = await verifyLogin(db, rp, req.body.challengeId, req.body.response);
    reply.header('cache-control', 'no-store');
    return { session, vault: { ...vaultView(db, vaultId), passkeys: passkeyCount(db, vaultId) } };
  });
  app.post('/api/sessions/end', async (req) => { const t = bearer(req); if (t.startsWith('sess_')) endSession(db, t); return { ok: true }; });

  app.post<{ Body: { marketId: string; side: 'yes' | 'no' } }>('/api/quotes', {
    schema: { body: { type: 'object', required: ['marketId', 'side'], properties: { marketId: { type: 'string', maxLength: 100 }, side: { enum: ['yes', 'no'] } } } },
  }, async (req) => {
    if (!quoteLimiter.allow(req.ip)) throw new VaultError('rate_limited', 'Too many quote requests. Please wait a moment.', 429);
    return quote(db, vaultFrom(req), req.body.marketId, req.body.side);
  });

  app.post<{ Body: { quoteId: string; stake: number } }>('/api/bets', {
    schema: { body: { type: 'object', required: ['quoteId', 'stake'], properties: { quoteId: { type: 'string', maxLength: 64 }, stake: { type: 'integer', minimum: 1 } } } },
  }, async (req, reply) => {
    if (!betLimiter.allow(req.ip)) throw new VaultError('rate_limited', 'Too many bets placed in a short window. Please wait a moment.', 429);
    const r = placeBet(db, vaultFrom(req), req.body.quoteId, req.body.stake);
    reply.code(201);
    return r;
  });

  app.post<{ Params: { id: string } }>('/api/positions/:id/sell', async (req) => cashOut(db, vaultFrom(req), req.params.id));

  return app;
}

// Start when run directly: `node src/server.ts`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb(config.dbPath);
  const wallet = walletFromEnv() ?? (config.mock ? new MockWallet() : null);
  const app = buildServer(db, { wallet });
  startSync(db);
  if (wallet) startWalletLoop(db, wallet);
  else console.log('Deposits and withdrawals are off: set HUSH_ZALLET_URL to connect a Zallet testnet wallet.');
  app.listen({ port: config.port, host: config.host }).then(() => {
    console.log(`Hush testnet on http://localhost:${config.port} (data: ${config.mock ? 'mock fixtures' : 'Polymarket'})`);
  });
}
