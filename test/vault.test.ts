process.env.HUSH_MOCK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { syncListings } from '../src/sync.ts';
import { buildServer } from '../src/server.ts';
import { newCode, normalizeCode, MICRO, rules, ledgerIsBalanced, createVault, quote, placeBet, cashOut, balanceOf, VaultError } from '../src/vault.ts';

async function setup() {
  const db = openDb(':memory:');
  await syncListings(db, Date.parse('2026-10-26T12:00:00Z'));
  return db;
}
const FED = 'pm-600011'; // yes = 0.64 in fixtures

test('secret codes are well formed and normalise from sloppy input', () => {
  const c = newCode();
  assert.match(c, /^hush-[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  assert.equal(normalizeCode(c.toLowerCase().replace(/-/g, ' ')), c);
  assert.equal(normalizeCode('hush-abc'), null);
  assert.equal(normalizeCode('hush-0000-0000-0000-0000-0000'), null, 'rejects ambiguous characters');
});

test('a new vault gets the practice grant and the ledger balances', async () => {
  const db = await setup();
  const { vaultId } = createVault(db);
  assert.equal(balanceOf(db, vaultId), rules.starterGrant);
  assert.ok(ledgerIsBalanced(db));
});

test('quote, bet and cash out move money correctly', async () => {
  const db = await setup();
  const { vaultId } = createVault(db);
  const q = quote(db, vaultId, FED, 'yes');
  assert.equal(q.price, 650_000, '64¢ plus 1¢ spread');
  const bet = placeBet(db, vaultId, q.id, 26 * MICRO);
  assert.equal(bet.shares, 40 * MICRO, '$26 at 65¢ buys 40 shares');
  assert.equal(bet.balance, 224 * MICRO);
  const sold = cashOut(db, vaultId, bet.positionId);
  assert.equal(sold.price, 630_000, 'sells at 64¢ minus 1¢');
  assert.equal(sold.payout, 25.2 * MICRO);
  assert.equal(balanceOf(db, vaultId), 249.2 * MICRO);
  assert.ok(ledgerIsBalanced(db));
  assert.throws(() => cashOut(db, vaultId, bet.positionId), (e: any) => e.code === 'position_closed');
});

test('quotes are single use, expire, and belong to one vault', async () => {
  const db = await setup();
  const a = createVault(db).vaultId, b = createVault(db).vaultId;
  const now = Date.now();
  const q = quote(db, a, FED, 'no', now);
  assert.throws(() => placeBet(db, b, q.id, MICRO, now), (e: any) => e.code === 'quote_not_found');
  assert.throws(() => placeBet(db, a, q.id, MICRO, now + rules.quoteTtlMs + 1), (e: any) => e.code === 'quote_expired');
  placeBet(db, a, q.id, MICRO, now);
  assert.throws(() => placeBet(db, a, q.id, MICRO, now), (e: any) => e.code === 'quote_used');
});

test('stake limits and balance are enforced', async () => {
  const db = await setup();
  const { vaultId } = createVault(db);
  const q = () => quote(db, vaultId, FED, 'yes').id;
  assert.throws(() => placeBet(db, vaultId, q(), MICRO / 2), (e: any) => e.code === 'stake_too_small');
  assert.throws(() => placeBet(db, vaultId, q(), 501 * MICRO), (e: any) => e.code === 'stake_too_large');
  placeBet(db, vaultId, q(), 200 * MICRO);
  assert.throws(() => placeBet(db, vaultId, q(), 60 * MICRO), (e: any) => e instanceof VaultError && e.code === 'insufficient_funds');
  assert.equal(balanceOf(db, vaultId), 50 * MICRO, 'a failed bet changes nothing');
  assert.ok(ledgerIsBalanced(db));
});

test('closed or unknown markets refuse quotes', async () => {
  const db = await setup();
  const { vaultId } = createVault(db);
  assert.throws(() => quote(db, vaultId, 'pm-nope', 'yes'), (e: any) => e.code === 'market_not_found');
  db.prepare("UPDATE markets SET accepting = 0 WHERE id = ?").run(FED);
  assert.throws(() => quote(db, vaultId, FED, 'yes'), (e: any) => e.code === 'market_closed');
});

test('HTTP flow: create, restore with code, bet, view, sell', async () => {
  const db = await setup();
  const app = buildServer(db);
  const made = await app.inject({ method: 'POST', url: '/api/vaults' });
  assert.equal(made.statusCode, 201);
  const { code, vault } = made.json();
  assert.equal(vault.balance, 250 * MICRO);
  const auth = { authorization: `Bearer ${code.toLowerCase()}` };

  assert.equal((await app.inject({ url: '/api/vault' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/vault', headers: { authorization: 'Bearer hush-AAAA-AAAA-AAAA-AAAA-AAAA' } })).statusCode, 401);

  const q = (await app.inject({ method: 'POST', url: '/api/quotes', headers: auth, payload: { marketId: FED, side: 'yes' } })).json();
  assert.equal(q.price, 650_000);
  const bad = await app.inject({ method: 'POST', url: '/api/bets', headers: auth, payload: { quoteId: q.id, stake: 'lots' } });
  assert.equal(bad.statusCode, 400);
  const bet = await app.inject({ method: 'POST', url: '/api/bets', headers: auth, payload: { quoteId: q.id, stake: 10 * MICRO } });
  assert.equal(bet.statusCode, 201);
  const view = (await app.inject({ url: '/api/vault', headers: auth })).json();
  assert.equal(view.positions.length, 1);
  assert.equal(view.positions[0].status, 'open');
  assert.equal(view.balance, 240 * MICRO);
  const sold = await app.inject({ method: 'POST', url: `/api/positions/${view.positions[0].id}/sell`, headers: auth });
  assert.equal(sold.statusCode, 200);
  const health = (await app.inject('/api/health')).json();
  assert.equal(health.ledgerBalanced, true);
  await app.close();
});

test('vault creation is rate limited per network', async () => {
  const db = await setup();
  const app = buildServer(db);
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await app.inject({ method: 'POST', url: '/api/vaults', remoteAddress: '203.0.113.9' })).statusCode;
  assert.equal(last, 429);
  assert.equal((await app.inject({ method: 'POST', url: '/api/vaults', remoteAddress: '203.0.113.10' })).statusCode, 201);
  await app.close();
});
