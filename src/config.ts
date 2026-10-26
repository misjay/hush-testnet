// Hush testnet configuration. Every value can be overridden with an environment variable.

export type CategoryConfig = { name: string; tagSlug: string };

export type NativeMarketConfig = {
  id: string;
  question: string;
  endDate: string;
  yes: number; // starting price for YES, 0..1
  rule: string; // how Hush settles it, shown to users
};

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.HUSH_DB ?? 'data/hush.db',

  // Read-only Polymarket endpoints. No account or key is needed to read.
  gammaBase: process.env.POLYMARKET_GAMMA ?? 'https://gamma-api.polymarket.com',
  clobBase: process.env.POLYMARKET_CLOB ?? 'https://clob.polymarket.com',

  // HUSH_MOCK=1 serves recorded fixtures instead of calling Polymarket (offline dev, tests).
  get mock() { return process.env.HUSH_MOCK === '1'; },

  listingsEveryMs: num(process.env.HUSH_LISTINGS_MS, 60_000),
  historyEveryMs: num(process.env.HUSH_HISTORY_MS, 15 * 60_000),
  resolutionsEveryMs: num(process.env.HUSH_RESOLUTIONS_MS, 5 * 60_000),
  requestTimeoutMs: 10_000,

  // Curation: how many markets per category, and the minimum depth to list one.
  perCategory: num(process.env.HUSH_PER_CATEGORY, 6),
  minVolume: num(process.env.HUSH_MIN_VOLUME, 250_000),
  minLiquidity: num(process.env.HUSH_MIN_LIQUIDITY, 10_000),
  // Ignore markets whose YES price is pinned near 0 or 1; they make dull bets.
  minHoursLeft: num(process.env.HUSH_MIN_HOURS_LEFT, 6),
  maxPerEvent: 2, // avoid a board full of one event's price ladder
  minPrice: 0.03,
  maxPrice: 0.97,
  // Topics Hush won't list even if Polymarket does: deaths, violence and criminal trials of real people.
  blockedTopics: /\b(murder\w*|kill(s|ed|ing)?|dies|die|died|death\w*|dead|assassinat\w*|shooting|terror\w*|rape\w*|suicide|convicted|sentenced|execut(ed|ion)|casualt\w*|hostage\w*)\b/i,

  categories: [
    { name: 'Crypto', tagSlug: 'crypto' },
    { name: 'Economy', tagSlug: 'economy' },
    { name: 'Sports', tagSlug: 'sports' },
    { name: 'Culture', tagSlug: 'pop-culture' },
  ] as CategoryConfig[],

  // Markets Hush runs and settles itself from public Zcash data.
  nativeMarkets: [
    {
      id: 'native-shielded-30',
      question: 'Will shielded ZEC pass 30% of supply by Dec 31, 2026?',
      endDate: '2026-12-31T23:59:00Z',
      yes: 0.52,
      rule: 'Settles YES if the shielded pools hold at least 30% of ZEC supply at the first block after the end date.',
    },
    {
      id: 'native-shielded-tx-nov',
      question: 'Will Zcash process 1M shielded transactions in November 2026?',
      endDate: '2026-11-30T23:59:00Z',
      yes: 0.37,
      rule: 'Settles YES if the count of transactions with shielded inputs or outputs in November 2026 reaches 1,000,000.',
    },
  ] as NativeMarketConfig[],
};

export const CATEGORY_ORDER = [...config.categories.map((c) => c.name), 'Zcash-native'];
