// Storage. SQLite (built into Node) is plenty for testnet; the queries are plain SQL so a move to
// Postgres later is mechanical.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HushMarket } from './polymarket/normalize.ts';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS markets (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL CHECK (source IN ('polymarket','native')),
      external_id TEXT,
      slug        TEXT,
      question    TEXT NOT NULL,
      category    TEXT NOT NULL,
      yes_token   TEXT,
      no_token    TEXT,
      yes         REAL NOT NULL,
      volume      REAL NOT NULL DEFAULT 0,
      volume_24h  REAL NOT NULL DEFAULT 0,
      liquidity   REAL NOT NULL DEFAULT 0,
      end_date    TEXT,
      accepting   INTEGER NOT NULL DEFAULT 1,
      closed      INTEGER NOT NULL DEFAULT 0,
      resolved    TEXT CHECK (resolved IN ('yes','no','void')),
      resolved_at INTEGER,
      rule        TEXT,
      listed      INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS markets_listed ON markets(listed, category);

    CREATE TABLE IF NOT EXISTS price_history (
      market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      t         INTEGER NOT NULL,
      p         REAL NOT NULL,
      PRIMARY KEY (market_id, t)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- A vault is identified only by the hash of its secret code. No names, emails or addresses.
    CREATE TABLE IF NOT EXISTS vaults (
      id         TEXT PRIMARY KEY,
      code_hash  TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    -- Firm prices, valid for a few seconds, spendable once.
    CREATE TABLE IF NOT EXISTS quotes (
      id         TEXT PRIMARY KEY,
      vault_id   TEXT NOT NULL REFERENCES vaults(id),
      market_id  TEXT NOT NULL REFERENCES markets(id),
      side       TEXT NOT NULL CHECK (side IN ('yes','no')),
      price      INTEGER NOT NULL,          -- micro-dollars per share, 1..999999
      expires_at INTEGER NOT NULL,          -- ms
      used_at    INTEGER
    );

    -- Shares in micro-shares; money in micro-dollars. A winning share pays 1,000,000 micro-dollars.
    CREATE TABLE IF NOT EXISTS positions (
      id         TEXT PRIMARY KEY,
      vault_id   TEXT NOT NULL REFERENCES vaults(id),
      market_id  TEXT NOT NULL REFERENCES markets(id),
      side       TEXT NOT NULL CHECK (side IN ('yes','no')),
      shares     INTEGER NOT NULL CHECK (shares > 0),
      cost       INTEGER NOT NULL CHECK (cost > 0),
      status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','sold','won','lost','void')),
      payout     INTEGER,
      opened_at  INTEGER NOT NULL,
      closed_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS positions_vault ON positions(vault_id, status);
    CREATE INDEX IF NOT EXISTS positions_market ON positions(market_id, status);

    -- Double-entry ledger. Every txn_id's entries sum to zero.
    -- Accounts: 'vault:<id>' (user cash), 'house', 'faucet', later 'deposits' and 'withdrawals'.
    CREATE TABLE IF NOT EXISTS ledger (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      txn_id     TEXT NOT NULL,
      account    TEXT NOT NULL,
      amount     INTEGER NOT NULL,
      kind       TEXT NOT NULL,             -- grant, bet, sell, payout, deposit, withdrawal
      ref_id     TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account);
    CREATE INDEX IF NOT EXISTS ledger_txn ON ledger(txn_id);

    -- Passkeys hold no identity: a credential id and a public key, tied to a vault.
    CREATE TABLE IF NOT EXISTS passkeys (
      id          TEXT PRIMARY KEY,          -- credential id, base64url
      vault_id    TEXT NOT NULL REFERENCES vaults(id),
      public_key  BLOB NOT NULL,
      counter     INTEGER NOT NULL DEFAULT 0,
      transports  TEXT,
      created_at  INTEGER NOT NULL,
      last_used   INTEGER
    );
    CREATE INDEX IF NOT EXISTS passkeys_vault ON passkeys(vault_id);

    -- Sessions let a passkey sign-in act like the secret code. Only the token's hash is stored.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      vault_id    TEXT NOT NULL REFERENCES vaults(id),
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    -- Each vault gets its own shielded deposit address from the house wallet account.
    CREATE TABLE IF NOT EXISTS deposit_addresses (
      address     TEXT PRIMARY KEY,
      vault_id    TEXT NOT NULL UNIQUE REFERENCES vaults(id),
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id            TEXT PRIMARY KEY,         -- txid:pool:index
      vault_id      TEXT NOT NULL REFERENCES vaults(id),
      address       TEXT NOT NULL,
      txid          TEXT NOT NULL,
      value_zat     INTEGER NOT NULL,
      confirmations INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','credited')),
      price         REAL,
      credited      INTEGER,                  -- micro-dollars
      seen_at       INTEGER NOT NULL,
      credited_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS deposits_vault ON deposits(vault_id, seen_at);

    CREATE TABLE IF NOT EXISTS withdrawals (
      id          TEXT PRIMARY KEY,
      vault_id    TEXT NOT NULL REFERENCES vaults(id),
      address     TEXT NOT NULL,
      amount      INTEGER NOT NULL,           -- micro-dollars debited
      value_zat   INTEGER NOT NULL,
      price       REAL NOT NULL,
      status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
      opid        TEXT,
      txid        TEXT,
      error       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS withdrawals_status ON withdrawals(status);
    CREATE INDEX IF NOT EXISTS withdrawals_vault ON withdrawals(vault_id, created_at);

    CREATE TABLE IF NOT EXISTS challenges (
      id          TEXT PRIMARY KEY,
      challenge   TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('register','login')),
      vault_id    TEXT,
      expires_at  INTEGER NOT NULL
    );
  `);
  return db;
}

export function upsertMarket(db: Db, m: HushMarket & { rule?: string | null }, listed: boolean, now = Date.now()) {
  db.prepare(`
    INSERT INTO markets (id, source, external_id, slug, question, category, yes_token, no_token, yes, volume, volume_24h,
                         liquidity, end_date, accepting, closed, resolved, rule, listed, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      question=excluded.question, category=excluded.category, slug=excluded.slug,
      yes_token=excluded.yes_token, no_token=excluded.no_token, yes=excluded.yes,
      volume=excluded.volume, volume_24h=excluded.volume_24h, liquidity=excluded.liquidity,
      end_date=excluded.end_date, accepting=excluded.accepting, closed=excluded.closed,
      resolved=COALESCE(markets.resolved, excluded.resolved), rule=COALESCE(excluded.rule, markets.rule),
      listed=excluded.listed, updated_at=excluded.updated_at
  `).run(m.id, m.source, m.externalId, m.slug, m.question, m.category, m.yesToken, m.noToken, m.yes, m.volume, m.volume24h,
    m.liquidity, m.endDate, m.accepting ? 1 : 0, m.closed ? 1 : 0, m.resolved, m.rule ?? null, listed ? 1 : 0, now);
}

// Unlist markets in a category that weren't chosen this round. Their rows stay for settlement.
export function unlistOthers(db: Db, category: string, keepIds: string[]) {
  const marks = keepIds.map(() => '?').join(',') || "''";
  db.prepare(`UPDATE markets SET listed = 0 WHERE category = ? AND source = 'polymarket' AND id NOT IN (${marks})`).run(category, ...keepIds);
}

export function replaceHistory(db: Db, marketId: string, points: { t: number; p: number }[]) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM price_history WHERE market_id = ?').run(marketId);
    const ins = db.prepare('INSERT OR REPLACE INTO price_history (market_id, t, p) VALUES (?,?,?)');
    for (const pt of points) ins.run(marketId, Math.floor(pt.t), pt.p);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function appendPrice(db: Db, marketId: string, p: number, t = Math.floor(Date.now() / 1000)) {
  db.prepare('INSERT OR REPLACE INTO price_history (market_id, t, p) VALUES (?,?,?)').run(marketId, t, p);
  // keep about 10 days of points per market
  db.prepare('DELETE FROM price_history WHERE market_id = ? AND t < ?').run(marketId, t - 10 * 86400);
}

export function setState(db: Db, key: string, value: string) {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
export function getState(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export type MarketRow = {
  id: string; source: string; slug: string | null; question: string; category: string; yes: number; volume: number;
  volume_24h: number; liquidity: number; end_date: string | null; accepting: number; closed: number; resolved: string | null;
  rule: string | null; yes_token: string | null; external_id: string | null; listed: number; updated_at: number;
};

export function listedMarkets(db: Db): MarketRow[] {
  return db.prepare('SELECT * FROM markets WHERE listed = 1').all() as unknown as MarketRow[];
}
export function marketRow(db: Db, id: string): MarketRow | null {
  return (db.prepare('SELECT * FROM markets WHERE id = ?').get(id) as unknown as MarketRow) ?? null;
}

// Downsampled YES history for sparklines: at most `points` evenly spaced values over the last `days`.
export function sparkline(db: Db, marketId: string, points = 30, days = 7): number[] {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = db.prepare('SELECT p FROM price_history WHERE market_id = ? AND t >= ? ORDER BY t').all(marketId, since) as { p: number }[];
  if (rows.length <= points) return rows.map((r) => r.p);
  const out: number[] = [];
  for (let i = 0; i < points; i++) out.push(rows[Math.round((i * (rows.length - 1)) / (points - 1))].p);
  return out;
}
