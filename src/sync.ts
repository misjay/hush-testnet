// Keeps the Hush board in step with Polymarket: curated listings + prices every minute,
// price history every 15 minutes. Native (Zcash) markets come from config.
import { config } from './config.ts';
import { type Db, upsertMarket, unlistOthers, replaceHistory, appendPrice, setState, listedMarkets } from './db.ts';
import { openMarketsForTag, priceHistory } from './polymarket/client.ts';
import { toHushMarket, isListable, type HushMarket } from './polymarket/normalize.ts';
import { syncResolutions } from './settle.ts';

// Keeps at most `max` markets from the same Polymarket event (they share a slug).
const perEventLimit = (max: number) => { const seen = new Map<string, number>();
  return (m: HushMarket) => { const k = m.slug ?? m.id; const n = seen.get(k) ?? 0; if (n >= max) return false; seen.set(k, n + 1); return true; }; };

export type SyncReport = { listed: Record<string, number>; errors: string[] };

const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[sync]', ...a);

// A market can carry several tags; the first category that claims it keeps it.
export async function syncListings(db: Db, now = Date.now()): Promise<SyncReport> {
  const report: SyncReport = { listed: {}, errors: [] };
  const taken = new Set<string>();
  for (const cat of config.categories) {
    try {
      const raw = await openMarketsForTag(cat.tagSlug);
      const picks: HushMarket[] = raw
        .map((r) => toHushMarket(r, cat.name))
        .filter((m): m is HushMarket => !!m && !taken.has(m.id))
        .filter((m) => isListable(m, { ...config, now }))
        .sort((a, b) => b.volume24h - a.volume24h || b.volume - a.volume)
        .filter(perEventLimit(config.maxPerEvent))
        .slice(0, config.perCategory);
      db.exec('BEGIN');
      try {
        for (const m of picks) {
          upsertMarket(db, m, true, now);
          appendPrice(db, m.id, m.yes, Math.floor(now / 1000));
          taken.add(m.id);
        }
        unlistOthers(db, cat.name, picks.map((m) => m.id));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      report.listed[cat.name] = picks.length;
    } catch (e: any) {
      // Keep the previous listings for this category if Polymarket is unreachable.
      report.errors.push(`${cat.name}: ${e?.message ?? e}`);
    }
  }
  for (const n of config.nativeMarkets) {
    upsertMarket(db, {
      id: n.id, source: 'native', externalId: null, slug: null, question: n.question, category: 'Zcash-native',
      yesToken: null, noToken: null, yes: n.yes, volume: 0, volume24h: 0, liquidity: 0, endDate: n.endDate,
      accepting: Date.parse(n.endDate) > now, closed: false, resolved: null, rule: n.rule,
    } as HushMarket & { rule: string }, true, now);
  }
  report.listed['Zcash-native'] = config.nativeMarkets.length;
  setState(db, 'listings_at', String(now));
  if (report.errors.length) setState(db, 'listings_error', report.errors.join(' | '));
  return report;
}

export async function syncHistory(db: Db, now = Date.now()) {
  const errors: string[] = [];
  for (const m of listedMarkets(db)) {
    if (m.source !== 'polymarket' || !m.yes_token) continue;
    try {
      const pts = await priceHistory(m.yes_token, '1w', 120);
      if (pts.length) replaceHistory(db, m.id, [...pts, { t: Math.floor(now / 1000), p: m.yes }]);
    } catch (e: any) {
      errors.push(`${m.id}: ${e?.message ?? e}`);
    }
  }
  setState(db, 'history_at', String(now));
  return errors;
}

// Runs both loops. Returns a stop function.
export function startSync(db: Db): () => void {
  let stopped = false;
  const runListings = async () => {
    const r = await syncListings(db).catch((e) => ({ listed: {}, errors: [String(e)] }));
    log('listings', JSON.stringify(r.listed), r.errors.length ? `errors: ${r.errors.join('; ')}` : '');
  };
  const runResolutions = async () => {
    const r = await syncResolutions(db).catch((e) => ({ checked: 0, settled: [], errors: [String(e)] }));
    if (r.settled.length || r.errors.length) log('resolutions', `settled ${r.settled.map((x) => `${x.marketId}=${x.outcome}`).join(', ') || 'none'}`, r.errors.length ? `errors: ${r.errors.join('; ')}` : '');
  };
  const runHistory = async () => {
    const errs = await syncHistory(db).catch((e) => [String(e)]);
    log('history', errs.length ? `errors: ${errs.length}` : 'ok');
  };
  (async () => {
    await runListings();
    await runHistory();
    await runResolutions();
  })();
  const a = setInterval(() => { if (!stopped) runListings(); }, config.listingsEveryMs);
  const b = setInterval(() => { if (!stopped) runHistory(); }, config.historyEveryMs);
  const c = setInterval(() => { if (!stopped) runResolutions(); }, config.resolutionsEveryMs);
  return () => { stopped = true; clearInterval(a); clearInterval(b); clearInterval(c); };
}
