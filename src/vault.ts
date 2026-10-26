// Vaults, the ledger, quotes, bets and cash-outs. All money is integer micro-dollars (1 USD = 1_000_000).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { marketRow } from './db.ts';

export const MICRO = 1_000_000;
export const rules = {
  starterGrant: 250 * MICRO,      // practice balance for new testnet vaults
  spread: 10_000,                 // 1¢ per share, added to buys, taken from sells
  quoteTtlMs: 10_000,
  minStake: 1 * MICRO,
  maxStakePerBet: 500 * MICRO,    // testnet cap
  minPrice: 10_000,               // 1¢
  maxPrice: 990_000,              // 99¢
};

export class VaultError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------- secret codes ----------
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export function newCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 5; g++) {
    let s = '';
    while (s.length < 4) {
      const b = randomBytes(1)[0];
      if (b < 248) s += ALPHABET[b % 31]; // rejection sampling: 248 = 8 * 31, no modulo bias
    }
    groups.push(s);
  }
  return 'hush-' + groups.join('-'); // 20 symbols from 31 ≈ 99 bits
}

// Accepts lowercase, spaces or missing dashes when a user types the code back in.
export function normalizeCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^HUSH/, '');
  if (raw.length !== 20 || [...raw].some((c) => !ALPHABET.includes(c))) return null;
  return 'hush-' + raw.match(/.{4}/g)!.join('-');
}

// The code is ~99 bits of randomness, so a fast hash is enough: guessing is infeasible either way.
export const hashCode = (code: string) => createHash('sha256').update('hush-vault-v1:' + code).digest('hex');

// ---------- ledger ----------
type Entry = { account: string; amount: number };
function post(db: Db, kind: string, refId: string | null, entries: Entry[], now: number) {
  const sum = entries.reduce((a, e) => a + e.amount, 0);
  if (sum !== 0 || entries.some((e) => !Number.isSafeInteger(e.amount))) throw new Error(`Unbalanced ledger txn (${kind}): ${sum}`);
  const txn = randomUUID();
  const ins = db.prepare('INSERT INTO ledger (txn_id, account, amount, kind, ref_id, created_at) VALUES (?,?,?,?,?,?)');
  for (const e of entries) ins.run(txn, e.account, e.amount, kind, refId, now);
  return txn;
}
const acct = (vaultId: string) => `vault:${vaultId}`;

export function balanceOf(db: Db, vaultId: string): number {
  const r = db.prepare('SELECT COALESCE(SUM(amount),0) AS b FROM ledger WHERE account = ?').get(acct(vaultId)) as { b: number };
  return Number(r.b);
}

function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- vaults ----------
export function createVault(db: Db, now = Date.now()): { code: string; vaultId: string } {
  const code = newCode();
  const vaultId = randomUUID();
  tx(db, () => {
    db.prepare('INSERT INTO vaults (id, code_hash, created_at) VALUES (?,?,?)').run(vaultId, hashCode(code), now);
    post(db, 'grant', vaultId, [{ account: 'faucet', amount: -rules.starterGrant }, { account: acct(vaultId), amount: rules.starterGrant }], now);
  });
  return { code, vaultId };
}

export function vaultIdForCode(db: Db, code: string | null | undefined): string | null {
  const norm = code ? normalizeCode(code) : null;
  if (!norm) return null;
  const r = db.prepare('SELECT id FROM vaults WHERE code_hash = ?').get(hashCode(norm)) as { id: string } | undefined;
  return r?.id ?? null;
}

// ---------- pricing ----------
const toMicro = (p: number) => Math.round(p * MICRO);
const clampPrice = (p: number) => Math.min(rules.maxPrice, Math.max(rules.minPrice, p));

function liveMarket(db: Db, marketId: string) {
  const m = marketRow(db, marketId);
  if (!m) throw new VaultError('market_not_found', 'That market no longer exists.', 404);
  if (m.closed || !m.accepting || m.resolved) throw new VaultError('market_closed', 'This market is closed to new bets.', 409);
  if (m.end_date && Date.parse(m.end_date) <= Date.now()) throw new VaultError('market_closed', 'This market has ended.', 409);
  return m;
}
const sidePrice = (yes: number, side: 'yes' | 'no') => toMicro(side === 'yes' ? yes : 1 - yes);

export function quote(db: Db, vaultId: string, marketId: string, side: 'yes' | 'no', now = Date.now()) {
  if (side !== 'yes' && side !== 'no') throw new VaultError('bad_side', 'Choose Yes or No.');
  const m = liveMarket(db, marketId);
  const price = clampPrice(sidePrice(m.yes, side) + rules.spread);
  const id = randomUUID();
  db.prepare('INSERT INTO quotes (id, vault_id, market_id, side, price, expires_at) VALUES (?,?,?,?,?,?)')
    .run(id, vaultId, marketId, side, price, now + rules.quoteTtlMs);
  return { id, marketId, side, price, expiresAt: now + rules.quoteTtlMs, ttlMs: rules.quoteTtlMs };
}

// ---------- bets ----------
export function placeBet(db: Db, vaultId: string, quoteId: string, stake: number, now = Date.now()) {
  if (!Number.isSafeInteger(stake) || stake < rules.minStake) throw new VaultError('stake_too_small', 'Enter a stake of at least $1.');
  if (stake > rules.maxStakePerBet) throw new VaultError('stake_too_large', 'Testnet bets are capped at $500 each.');
  return tx(db, () => {
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId) as any;
    if (!q || q.vault_id !== vaultId) throw new VaultError('quote_not_found', 'That price is no longer available. Get a new price and try again.', 404);
    if (q.used_at) throw new VaultError('quote_used', 'That price was already used. Get a new price to bet again.', 409);
    if (now > q.expires_at) throw new VaultError('quote_expired', 'That price expired. Refresh to get a new one.', 409);
    liveMarket(db, q.market_id);
    const bal = balanceOf(db, vaultId);
    if (stake > bal) throw new VaultError('insufficient_funds', 'Your vault doesn’t cover this stake. Deposit testnet ZEC or lower the amount.', 402);
    const shares = Math.floor((stake * MICRO) / q.price); // micro-shares
    if (shares <= 0) throw new VaultError('stake_too_small', 'Enter a larger stake.');
    db.prepare('UPDATE quotes SET used_at = ? WHERE id = ?').run(now, quoteId);
    const id = randomUUID();
    db.prepare('INSERT INTO positions (id, vault_id, market_id, side, shares, cost, opened_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, vaultId, q.market_id, q.side, shares, stake, now);
    post(db, 'bet', id, [{ account: acct(vaultId), amount: -stake }, { account: 'house', amount: stake }], now);
    return { positionId: id, marketId: q.market_id, side: q.side as 'yes' | 'no', shares, cost: stake, price: q.price, balance: balanceOf(db, vaultId) };
  });
}

// Sell an open position back at the current price minus the spread.
export function cashOut(db: Db, vaultId: string, positionId: string, now = Date.now()) {
  return tx(db, () => {
    const p = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
    if (!p || p.vault_id !== vaultId) throw new VaultError('position_not_found', 'That position isn’t in this vault.', 404);
    if (p.status !== 'open') throw new VaultError('position_closed', 'That position is already closed.', 409);
    const m = liveMarket(db, p.market_id);
    const price = clampPrice(sidePrice(m.yes, p.side) - rules.spread);
    const payout = Math.floor((p.shares * price) / MICRO);
    db.prepare("UPDATE positions SET status = 'sold', payout = ?, closed_at = ? WHERE id = ?").run(payout, now, positionId);
    post(db, 'sell', positionId, [{ account: 'house', amount: -payout }, { account: acct(vaultId), amount: payout }], now);
    return { positionId, payout, price, balance: balanceOf(db, vaultId) };
  });
}

// ---------- read model ----------
export function vaultView(db: Db, vaultId: string) {
  const rows = db.prepare(`
    SELECT p.*, m.question, m.category, m.yes AS market_yes, m.resolved, m.closed
    FROM positions p JOIN markets m ON m.id = p.market_id
    WHERE p.vault_id = ? ORDER BY p.opened_at DESC LIMIT 200`).all(vaultId) as any[];
  const positions = rows.map((r) => {
    const mark = r.status === 'open' ? clampPrice(sidePrice(r.market_yes, r.side) - rules.spread) : null;
    const value = r.status === 'open' ? Math.floor((r.shares * mark!) / MICRO) : r.payout ?? 0;
    return {
      id: r.id, marketId: r.market_id, question: r.question, category: r.category, side: r.side, status: r.status,
      shares: r.shares, cost: r.cost, value, payout: r.payout, openedAt: r.opened_at, closedAt: r.closed_at,
    };
  });
  const open = positions.filter((p) => p.status === 'open');
  const activity = (db.prepare(`SELECT kind, amount, ref_id, created_at FROM ledger WHERE account = ? ORDER BY seq DESC LIMIT 50`)
    .all(acct(vaultId)) as any[]).map((a) => ({ kind: a.kind, amount: a.amount, refId: a.ref_id, at: a.created_at }));
  return {
    balance: balanceOf(db, vaultId),
    openValue: open.reduce((a, p) => a + p.value, 0),
    positions,
    activity,
    rules: { spread: rules.spread, quoteTtlMs: rules.quoteTtlMs, minStake: rules.minStake, maxStakePerBet: rules.maxStakePerBet },
  };
}

// Sum of every ledger entry must be zero. Used by tests and the health check.
export function ledgerIsBalanced(db: Db): boolean {
  const r = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM ledger').get() as { s: number };
  return Number(r.s) === 0;
}
