// Live ZEC/USD price for valuing testnet deposits and withdrawals. Tries several public sources;
// if none answers, callers wait rather than guess. HUSH_ZEC_PRICE pins a fixed price (tests, demos).
import { config } from './config.ts';
import { getJSON } from './polymarket/http.ts';

type Source = { name: string; url: string; read: (j: any) => number };
const SOURCES: Source[] = [
  { name: 'coinbase', url: 'https://api.coinbase.com/v2/prices/ZEC-USD/spot', read: (j) => Number(j?.data?.amount) },
  { name: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=ZECUSD', read: (j) => Number((Object.values(j?.result ?? {})[0] as any)?.c?.[0]) },
  { name: 'coingecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd', read: (j) => Number(j?.zcash?.usd) },
];

let cache: { price: number; source: string; at: number } | null = null;
const MAX_AGE_MS = 60_000;

export async function zecUsd(now = Date.now()): Promise<{ price: number; source: string } | null> {
  const pinned = Number(process.env.HUSH_ZEC_PRICE);
  if (pinned > 0) return { price: pinned, source: 'pinned' };
  if (config.mock) return { price: 386.4, source: 'mock' };
  if (cache && now - cache.at < MAX_AGE_MS) return cache;
  for (const s of SOURCES) {
    try {
      const p = s.read(await getJSON(s.url, {}, 1));
      if (Number.isFinite(p) && p > 0) { cache = { price: p, source: s.name, at: now }; return cache; }
    } catch {}
  }
  // A slightly stale price (under 15 minutes) is better than stopping everything.
  if (cache && now - cache.at < 15 * 60_000) return cache;
  return null;
}

export const ZAT = 100_000_000;
// zatoshis -> micro-dollars at `price` USD per ZEC
export const zatToMicroUsd = (zat: number, price: number) => Math.floor((zat * price) / 100);
// micro-dollars -> zatoshis at `price` USD per ZEC
export const microUsdToZat = (micro: number, price: number) => Math.floor((micro * 100) / price);
