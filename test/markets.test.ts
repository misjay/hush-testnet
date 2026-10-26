process.env.HUSH_MOCK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseList, toHushMarket, isListable, resolvedOutcome, yesPrice } from '../src/polymarket/normalize.ts';
import { openDb } from '../src/db.ts';
import { syncListings, syncHistory } from '../src/sync.ts';
import { buildServer } from '../src/server.ts';
import { config } from '../src/config.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const base = {
  id: '1', question: 'Will it happen?', outcomes: '["Yes", "No"]', outcomePrices: '["0.4", "0.6"]',
  clobTokenIds: '["111", "222"]', volumeNum: 1e6, liquidityNum: 5e4, volume24hr: 1000, endDate: '2026-12-31T00:00:00Z',
  active: true, closed: false, acceptingOrders: true,
};

test('parseList reads string-encoded and native arrays', () => {
  assert.deepEqual(parseList('["Yes", "No"]'), ['Yes', 'No']);
  assert.deepEqual(parseList(['a', 'b']), ['a', 'b']);
  assert.deepEqual(parseList('not json'), []);
  assert.deepEqual(parseList(null), []);
});

test('YES price uses the book midpoint when tight, else quoted price', () => {
  assert.equal(yesPrice({ ...base, bestBid: 0.41, bestAsk: 0.43 }, 0), 0.42);
  assert.equal(yesPrice({ ...base, bestBid: 0.1, bestAsk: 0.6 }, 0), 0.4); // wide book: fall back
  assert.equal(yesPrice({ ...base, outcomes: '["No","Yes"]', outcomePrices: '["0.7","0.3"]' }, 1), 0.3);
});

test('toHushMarket maps tokens by outcome order and rejects non-binary markets', () => {
  const m = toHushMarket({ ...base, outcomes: '["No","Yes"]', outcomePrices: '["0.7","0.3"]' }, 'Crypto')!;
  assert.equal(m.yesToken, '222');
  assert.equal(m.noToken, '111');
  assert.equal(m.yes, 0.3);
  assert.equal(toHushMarket({ ...base, outcomes: '["BTC","ETH"]' }, 'Crypto'), null);
  assert.equal(toHushMarket({ ...base, clobTokenIds: null }, 'Crypto'), null);
});

test('resolution is read from settled outcome prices', () => {
  assert.equal(resolvedOutcome({ ...base, closed: true, outcomePrices: '["1","0"]' }, 0), 'yes');
  assert.equal(resolvedOutcome({ ...base, closed: true, outcomePrices: '["0","1"]' }, 0), 'no');
  assert.equal(resolvedOutcome({ ...base, closed: true, outcomePrices: '["0.5","0.5"]' }, 0), null);
  assert.equal(resolvedOutcome({ ...base, closed: false, outcomePrices: '["1","0"]' }, 0), null);
});

test('isListable filters thin, pinned, closed and ending markets', () => {
  const opts = { ...config, now: NOW };
  const ok = toHushMarket(base, 'X')!;
  assert.equal(isListable(ok, opts), true);
  assert.equal(isListable({ ...ok, volume: 10 }, opts), false);
  assert.equal(isListable({ ...ok, yes: 0.995 }, opts), false);
  assert.equal(isListable({ ...ok, closed: true }, opts), false);
  assert.equal(isListable({ ...ok, endDate: '2026-10-26T12:30:00Z' }, opts), false);
});

test('sync curates each category and the API serves the board', async () => {
  const db = openDb(':memory:');
  const report = await syncListings(db, NOW);
  assert.deepEqual(report.errors, []);
  assert.equal(report.listed.Crypto, 4, 'drops non-binary, tiny and pinned markets');
  assert.equal(report.listed.Sports, 3, 'drops the closed market');
  await syncHistory(db, NOW);

  const app = buildServer(db);
  const res = await app.inject('/api/markets');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data, 'mock');
  const cats = new Set(body.markets.map((m: any) => m.category));
  for (const c of ['Crypto', 'Economy', 'Sports', 'Culture', 'Zcash-native']) assert.ok(cats.has(c), c);
  const fed = body.markets.find((m: any) => m.question.includes('Fed cut'));
  assert.equal(fed.yes, 0.64);
  assert.equal(fed.url, 'https://polymarket.com/event/fed-dec-2026');
  assert.ok(fed.history.length >= 10 && fed.history.length <= 30);
  assert.equal(body.markets[0].category, 'Crypto', 'sorted by category order');

  const filtered = (await app.inject('/api/markets?category=Sports')).json();
  assert.ok(filtered.markets.every((m: any) => m.category === 'Sports'));
  const search = (await app.inject('/api/markets?q=arsenal')).json();
  assert.equal(search.markets.length, 1);
  assert.equal((await app.inject('/api/markets/nope')).statusCode, 404);
  const native = (await app.inject('/api/markets/native-shielded-30')).json();
  assert.equal(native.source, 'native');
  assert.match(native.rule, /30%/);
  await app.close();
});

test('a failed category keeps its previous listings', async () => {
  const db = openDb(':memory:');
  await syncListings(db, NOW);
  const before = (db.prepare("SELECT COUNT(*) c FROM markets WHERE listed=1 AND category='Culture'").get() as any).c;
  const saved = config.categories;
  config.categories = [...saved, { name: 'Broken', tagSlug: 'does-not-exist' }];
  const r = await syncListings(db, NOW);
  config.categories = saved;
  assert.equal(r.errors.length, 1);
  const after = (db.prepare("SELECT COUNT(*) c FROM markets WHERE listed=1 AND category='Culture'").get() as any).c;
  assert.equal(after, before);
});

test('real Polymarket snapshot normalises cleanly', async () => {
  const { readFileSync } = await import('node:fs');
  const snap = JSON.parse(readFileSync(new URL('./fixtures/live-snapshot.json', import.meta.url), 'utf8'));
  let binary = 0;
  for (const list of Object.values(snap.markets) as any[]) {
    for (const raw of list) {
      const m = toHushMarket(raw, 'X'); // must never throw on real data
      if (!m) continue;
      binary++;
      assert.ok(m.yes >= 0 && m.yes <= 1, `price in range for ${raw.id}`);
      assert.ok(m.yesToken && m.noToken && m.yesToken !== m.noToken);
      assert.ok(m.slug, 'has an event slug for the Polymarket link');
    }
  }
  assert.ok(binary >= 50, `expected most real markets to be binary, got ${binary}`);
});

test('blocked topics are never listed', () => {
  const m = toHushMarket({ ...base, question: 'Will the defendant be convicted of murder by December?' }, 'Culture')!;
  assert.equal(isListable(m, { ...config, now: NOW }), false);
  const ok = toHushMarket({ ...base, question: 'Will GTA VI launch before June 2027?' }, 'Culture')!;
  assert.equal(isListable(ok, { ...config, now: NOW }), true);
});
