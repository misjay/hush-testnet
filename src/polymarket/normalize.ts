// Turns a raw Gamma market into the shape Hush stores. Pure functions, unit tested.
import type { GammaMarket } from './client.ts';

export type HushMarket = {
  id: string; // 'pm-<gamma id>' or a native id
  source: 'polymarket' | 'native';
  externalId: string | null;
  slug: string | null;
  question: string;
  category: string;
  yesToken: string | null;
  noToken: string | null;
  yes: number; // YES price 0..1
  volume: number;
  volume24h: number;
  liquidity: number;
  endDate: string | null;
  accepting: boolean;
  closed: boolean;
  resolved: 'yes' | 'no' | null;
};

// Gamma encodes several arrays as strings that contain JSON ("[\"Yes\", \"No\"]").
export function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const n = (v: unknown): number | null => {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};

// YES price: the order-book midpoint when the book is tight, else the quoted outcome price, else last trade.
export function yesPrice(raw: GammaMarket, yesIndex: number): number | null {
  const bid = n(raw.bestBid), ask = n(raw.bestAsk);
  if (bid !== null && ask !== null && ask >= bid && ask - bid <= 0.1 && ask > 0) return round4((bid + ask) / 2);
  const quoted = n(parseList(raw.outcomePrices)[yesIndex]);
  if (quoted !== null) return round4(quoted);
  const last = n(raw.lastTradePrice);
  return last === null ? null : round4(last);
}

// A closed market is resolved when one outcome's price has settled at 1.
export function resolvedOutcome(raw: GammaMarket, yesIndex: number): 'yes' | 'no' | null {
  if (!raw.closed) return null;
  const prices = parseList(raw.outcomePrices).map((p) => n(p));
  if (prices.length !== 2) return null;
  const y = prices[yesIndex], no = prices[1 - yesIndex];
  if (y !== null && y >= 0.999) return 'yes';
  if (no !== null && no >= 0.999) return 'no';
  return null;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

// Returns null for anything Hush can't list: non-binary, missing tokens or prices.
export function toHushMarket(raw: GammaMarket, category: string): HushMarket | null {
  const outcomes = parseList(raw.outcomes).map((o) => o.toLowerCase());
  if (outcomes.length !== 2) return null;
  const yesIndex = outcomes.indexOf('yes');
  if (yesIndex === -1 || outcomes.indexOf('no') === -1) return null;
  const tokens = parseList(raw.clobTokenIds);
  if (tokens.length !== 2) return null;
  const question = (raw.question ?? '').trim();
  if (!question) return null;
  const yes = yesPrice(raw, yesIndex);
  if (yes === null) return null;
  return {
    id: `pm-${raw.id}`,
    source: 'polymarket',
    externalId: String(raw.id),
    // Polymarket's public pages live under the parent event's slug.
    slug: (Array.isArray(raw.events) && (raw.events[0] as any)?.slug) || raw.slug || null,
    question,
    category,
    yesToken: tokens[yesIndex],
    noToken: tokens[1 - yesIndex],
    yes,
    volume: n(raw.volumeNum) ?? n(raw.volume) ?? 0,
    volume24h: n(raw.volume24hr) ?? 0,
    liquidity: n(raw.liquidityNum) ?? n(raw.liquidity) ?? 0,
    endDate: raw.endDate ?? null,
    accepting: raw.acceptingOrders !== false && raw.active !== false,
    closed: raw.closed === true,
    resolved: resolvedOutcome(raw, yesIndex),
  };
}

// Is this market worth listing on Hush right now?
export function isListable(m: HushMarket, opts: { minVolume: number; minLiquidity: number; minPrice: number; maxPrice: number; minHoursLeft?: number; blockedTopics?: RegExp; now?: number }): boolean {
  const now = opts.now ?? Date.now();
  if (m.closed || !m.accepting) return false;
  if (opts.blockedTopics && opts.blockedTopics.test(m.question)) return false;
  if (m.volume < opts.minVolume || m.liquidity < opts.minLiquidity) return false;
  if (m.yes < opts.minPrice || m.yes > opts.maxPrice) return false;
  if (m.endDate && Date.parse(m.endDate) < now + (opts.minHoursLeft ?? 6) * 3600_000) return false; // closes too soon to be useful
  return true;
}
