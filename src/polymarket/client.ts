// Read-only Polymarket client: Gamma (market metadata + prices) and CLOB (price history).
// In mock mode it reads recorded fixtures from test/fixtures instead of the network.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { getJSON } from './http.ts';

export type GammaMarket = Record<string, unknown> & {
  id: string;
  question?: string | null;
  slug?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[] | null;
  endDate?: string;
  volumeNum?: number;
  volume?: string;
  volume24hr?: number;
  liquidityNum?: number;
  liquidity?: string;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
};

export type PricePoint = { t: number; p: number };

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(FIXTURES + name, 'utf8')) as T;

const tagCache = new Map<string, string>();

export async function tagIdForSlug(slug: string): Promise<string> {
  const hit = tagCache.get(slug);
  if (hit) return hit;
  const tag = config.mock
    ? (await fixture<Record<string, { id: string }>>('tags.json'))[slug]
    : await getJSON<{ id: string | number }>(`${config.gammaBase}/tags/slug/${encodeURIComponent(slug)}`);
  if (!tag || tag.id === undefined) throw new Error(`Unknown Polymarket tag: ${slug}`);
  const id = String(tag.id);
  tagCache.set(slug, id);
  return id;
}

// Open markets for one tag. Gamma's keyset endpoint is cursor-paged; we read up to `pages` pages.
export async function openMarketsForTag(tagSlug: string, limit = 100, pages = 1): Promise<GammaMarket[]> {
  if (config.mock) return (await fixture<{ markets: GammaMarket[] }>(`gamma-${tagSlug}.json`)).markets;
  const tagId = await tagIdForSlug(tagSlug);
  const out: GammaMarket[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    // Highest 24h volume first, so one page holds the markets worth listing.
    const q = new URLSearchParams({ tag_id: tagId, closed: 'false', limit: String(limit), order: 'volume24hr', ascending: 'false' });
    if (cursor) q.set('after_cursor', cursor);
    const res = await getJSON<{ markets?: GammaMarket[]; next_cursor?: string | null }>(`${config.gammaBase}/markets/keyset?${q}`);
    out.push(...(res.markets ?? []));
    if (!res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

// One market by Gamma id, including closed ones. Used to detect resolution.
export async function marketById(id: string): Promise<GammaMarket | null> {
  if (config.mock) {
    const all = await fixture<Record<string, GammaMarket>>('gamma-by-id.json').catch(() => ({} as Record<string, GammaMarket>));
    return all[id] ?? null;
  }
  try {
    return await getJSON<GammaMarket>(`${config.gammaBase}/markets/${encodeURIComponent(id)}`);
  } catch (e: any) {
    if (e?.status === 404) return null;
    throw e;
  }
}

// YES-token price history from the CLOB. interval: 1h 6h 1d 1w 1m max; fidelity in minutes.
export async function priceHistory(tokenId: string, interval = '1w', fidelity = 120): Promise<PricePoint[]> {
  if (config.mock) {
    const all = await fixture<Record<string, PricePoint[]>>('history.json');
    return all[tokenId] ?? [];
  }
  const q = new URLSearchParams({ market: tokenId, interval, fidelity: String(fidelity) });
  const res = await getJSON<{ history?: PricePoint[] }>(`${config.clobBase}/prices-history?${q}`);
  return res.history ?? [];
}
