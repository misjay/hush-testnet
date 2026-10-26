// Settlement. When a market resolves, every open position on it closes in one transaction:
// winning shares pay $1 each, losing shares pay nothing, a void refunds the stake.
import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { marketRow, setState } from './db.ts';
import { marketById } from './polymarket/client.ts';
import { toHushMarket, resolvedOutcome, parseList } from './polymarket/normalize.ts';
import { MICRO } from './vault.ts';

export type Outcome = 'yes' | 'no' | 'void';
export type SettleReport = { marketId: string; outcome: Outcome; won: number; lost: number; refunded: number; paid: number };

function postTxn(db: Db, kind: string, refId: string, entries: { account: string; amount: number }[], now: number) {
  const sum = entries.reduce((a, e) => a + e.amount, 0);
  if (sum !== 0) throw new Error(`Unbalanced settlement entry: ${sum}`);
  const txn = randomUUID();
  const ins = db.prepare('INSERT INTO ledger (txn_id, account, amount, kind, ref_id, created_at) VALUES (?,?,?,?,?,?)');
  for (const e of entries) ins.run(txn, e.account, e.amount, kind, refId, now);
}

// Idempotent: settling an already-settled market changes nothing.
export function settleMarket(db: Db, marketId: string, outcome: Outcome, now = Date.now()): SettleReport {
  if (!['yes', 'no', 'void'].includes(outcome)) throw new Error(`Unknown outcome: ${outcome}`);
  const report: SettleReport = { marketId, outcome, won: 0, lost: 0, refunded: 0, paid: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const m = marketRow(db, marketId);
    if (!m) throw new Error(`No market ${marketId}`);
    if (m.resolved && m.resolved !== outcome) throw new Error(`${marketId} already resolved as ${m.resolved}`);
    db.prepare('UPDATE markets SET resolved = ?, resolved_at = COALESCE(resolved_at, ?), closed = 1, accepting = 0, listed = 0 WHERE id = ?')
      .run(outcome, now, marketId);
    const open = db.prepare("SELECT * FROM positions WHERE market_id = ? AND status = 'open'").all(marketId) as any[];
    for (const p of open) {
      let status: string, payout: number;
      if (outcome === 'void') { status = 'void'; payout = p.cost; report.refunded++; }
      else if (p.side === outcome) { status = 'won'; payout = Math.floor((p.shares * MICRO) / MICRO); report.won++; } // 1 share pays $1
      else { status = 'lost'; payout = 0; report.lost++; }
      db.prepare('UPDATE positions SET status = ?, payout = ?, closed_at = ? WHERE id = ?').run(status, payout, now, p.id);
      if (payout > 0) {
        postTxn(db, status === 'void' ? 'refund' : 'payout', p.id, [{ account: 'house', amount: -payout }, { account: `vault:${p.vault_id}`, amount: payout }], now);
        report.paid += payout;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return report;
}

// Checks every Polymarket market that still has open positions, refreshes its price, and settles it once
// Polymarket reports a result. A market that has closed but not resolved is frozen until it does.
export async function syncResolutions(db: Db, now = Date.now()) {
  const pending = db.prepare(`
    SELECT DISTINCT m.id, m.external_id FROM markets m JOIN positions p ON p.market_id = m.id
    WHERE p.status = 'open' AND m.source = 'polymarket' AND m.resolved IS NULL`).all() as { id: string; external_id: string }[];
  const settled: SettleReport[] = [];
  const errors: string[] = [];
  for (const row of pending) {
    try {
      const raw = await marketById(row.external_id);
      if (!raw) continue;
      const outcomes = parseList(raw.outcomes).map((o) => o.toLowerCase());
      const yesIndex = outcomes.indexOf('yes');
      if (yesIndex === -1) continue;
      const outcome = resolvedOutcome(raw, yesIndex);
      if (outcome) { settled.push(settleMarket(db, row.id, outcome, now)); continue; }
      const live = toHushMarket(raw, 'X');
      if (raw.closed || raw.acceptingOrders === false) {
        db.prepare('UPDATE markets SET closed = ?, accepting = 0, updated_at = ? WHERE id = ?').run(raw.closed ? 1 : 0, now, row.id);
      } else if (live) {
        db.prepare('UPDATE markets SET yes = ?, updated_at = ? WHERE id = ?').run(live.yes, now, row.id);
      }
    } catch (e: any) {
      errors.push(`${row.id}: ${e?.message ?? e}`);
    }
  }
  setState(db, 'resolutions_at', String(now));
  return { checked: pending.length, settled, errors };
}
