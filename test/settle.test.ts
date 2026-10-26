process.env.HUSH_MOCK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, marketRow } from '../src/db.ts';
import { syncListings } from '../src/sync.ts';
import { createVault, quote, placeBet, balanceOf, ledgerIsBalanced, cashOut, MICRO } from '../src/vault.ts';
import { settleMarket, syncResolutions } from '../src/settle.ts';

const FED = 'pm-600011', CPI = 'pm-600012', RECESSION = 'pm-600013';
async function setup() {
  const db = openDb(':memory:');
  await syncListings(db, Date.parse('2026-10-26T12:00:00Z'));
  return db;
}
const bet = (db: any, v: string, market: string, side: 'yes' | 'no', usd: number) => placeBet(db, v, quote(db, v, market, side).id, usd * MICRO);

test('winners are paid $1 a share, losers get nothing', async () => {
  const db = await setup();
  const a = createVault(db).vaultId, b = createVault(db).vaultId;
  const ya = bet(db, a, FED, 'yes', 65); // 100 shares at 65¢
  bet(db, b, FED, 'no', 37);              // 100 shares at 37¢
  const r = settleMarket(db, FED, 'yes');
  assert.deepEqual([r.won, r.lost, r.refunded], [1, 1, 0]);
  assert.equal(ya.shares, 100 * MICRO);
  assert.equal(balanceOf(db, a), (250 - 65 + 100) * MICRO);
  assert.equal(balanceOf(db, b), (250 - 37) * MICRO);
  assert.ok(ledgerIsBalanced(db));
  const again = settleMarket(db, FED, 'yes');
  assert.equal(again.won + again.lost, 0, 'settling twice pays nothing more');
  assert.throws(() => settleMarket(db, FED, 'no'), /already resolved/);
  assert.throws(() => quote(db, a, FED, 'yes'), (e: any) => e.code === 'market_closed');
});

test('a void refunds every stake', async () => {
  const db = await setup();
  const a = createVault(db).vaultId;
  bet(db, a, CPI, 'yes', 40);
  bet(db, a, CPI, 'no', 20);
  const r = settleMarket(db, CPI, 'void');
  assert.equal(r.refunded, 2);
  assert.equal(balanceOf(db, a), 250 * MICRO);
  assert.ok(ledgerIsBalanced(db));
});

test('sold positions are not settled again', async () => {
  const db = await setup();
  const a = createVault(db).vaultId;
  const p = bet(db, a, FED, 'yes', 13);
  cashOut(db, a, p.positionId);
  const before = balanceOf(db, a);
  const r = settleMarket(db, FED, 'yes');
  assert.equal(r.won, 0);
  assert.equal(balanceOf(db, a), before);
});

test('resolver settles resolved markets, freezes closed ones, refreshes prices', async () => {
  const db = await setup();
  const a = createVault(db).vaultId;
  bet(db, a, FED, 'yes', 65);
  bet(db, a, CPI, 'no', 10);
  bet(db, a, RECESSION, 'yes', 10);
  const r = await syncResolutions(db);
  assert.equal(r.checked, 3);
  assert.deepEqual(r.settled.map((s) => [s.marketId, s.outcome]), [[FED, 'yes']]);
  assert.equal(marketRow(db, FED)!.resolved, 'yes');
  const cpi = marketRow(db, CPI)!;
  assert.equal(cpi.resolved, null);
  assert.equal(cpi.accepting, 0, 'closed but unresolved market is frozen');
  assert.equal(marketRow(db, RECESSION)!.yes, 0.3, 'open market price refreshed from Polymarket');
  assert.ok(ledgerIsBalanced(db));
});
