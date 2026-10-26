// Testnet deposits and withdrawals.
// Deposits: notes arriving at a vault's address are recorded as pending, then credited in test dollars
// at the live ZEC price once they reach HUSH_DEPOSIT_CONFS confirmations.
// Withdrawals: debited from the vault immediately and queued; the worker sends shielded TAZ and refunds
// the vault if the send fails.
import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { setState } from './db.ts';
import { balanceOf, VaultError, MICRO } from './vault.ts';
import { zecUsd, zatToMicroUsd, microUsdToZat } from './price.ts';
import { type ZcashWallet, isTestnetShielded } from './zcash/wallet.ts';

export const depositRules = {
  confirmations: Number(process.env.HUSH_DEPOSIT_CONFS ?? 3),
  minWithdrawal: 1 * MICRO,
  maxWithdrawal: 1000 * MICRO,
  maxPendingWithdrawals: 3,
};

function post(db: Db, kind: string, refId: string, entries: { account: string; amount: number }[], now: number) {
  if (entries.reduce((a, e) => a + e.amount, 0) !== 0) throw new Error(`Unbalanced ${kind}`);
  const txn = randomUUID();
  const ins = db.prepare('INSERT INTO ledger (txn_id, account, amount, kind, ref_id, created_at) VALUES (?,?,?,?,?,?)');
  for (const e of entries) ins.run(txn, e.account, e.amount, kind, refId, now);
}
function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export async function depositAddress(db: Db, wallet: ZcashWallet | null, vaultId: string, now = Date.now()): Promise<string> {
  const row = db.prepare('SELECT address FROM deposit_addresses WHERE vault_id = ?').get(vaultId) as { address: string } | undefined;
  if (row) return row.address;
  if (!wallet) throw new VaultError('deposits_off', 'Deposits aren’t switched on for this server yet.', 503);
  const address = await wallet.newAddress();
  db.prepare('INSERT INTO deposit_addresses (address, vault_id, created_at) VALUES (?,?,?)').run(address, vaultId, now);
  return address;
}

// Reads incoming notes from the wallet and credits the ones that are deep enough.
export async function scanDeposits(db: Db, wallet: ZcashWallet, now = Date.now()) {
  const notes = await wallet.listIncoming();
  const vaultFor = db.prepare('SELECT vault_id FROM deposit_addresses WHERE address = ?');
  let seen = 0, credited = 0, unmatched = 0;
  for (const n of notes) {
    if (!n.address) { unmatched++; continue; }
    const v = vaultFor.get(n.address) as { vault_id: string } | undefined;
    if (!v) { unmatched++; continue; } // e.g. the house wallet's own change, or a top-up of the house
    db.prepare(`INSERT INTO deposits (id, vault_id, address, txid, value_zat, confirmations, seen_at) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET confirmations = MAX(deposits.confirmations, excluded.confirmations)`)
      .run(n.key, v.vault_id, n.address, n.txid, n.valueZat, n.confirmations, now);
    seen++;
  }
  const due = db.prepare("SELECT * FROM deposits WHERE status = 'pending' AND confirmations >= ?").all(depositRules.confirmations) as any[];
  if (due.length) {
    const quote = await zecUsd(now);
    if (quote) {
      for (const d of due) {
        const usd = zatToMicroUsd(d.value_zat, quote.price);
        tx(db, () => {
          const still = db.prepare("SELECT status FROM deposits WHERE id = ?").get(d.id) as { status: string };
          if (still.status !== 'pending') return;
          db.prepare("UPDATE deposits SET status = 'credited', price = ?, credited = ?, credited_at = ? WHERE id = ?").run(quote.price, usd, now, d.id);
          if (usd > 0) post(db, 'deposit', d.id, [{ account: 'deposits', amount: -usd }, { account: `vault:${d.vault_id}`, amount: usd }], now);
        });
        credited++;
      }
    }
  }
  setState(db, 'deposits_at', String(now));
  return { seen, credited, unmatched, waitingForPrice: due.length > 0 && credited === 0 };
}

export async function requestWithdrawal(db: Db, vaultId: string, address: string, amount: number, now = Date.now()) {
  const to = String(address ?? '').trim();
  if (!isTestnetShielded(to)) {
    if (/^tm/.test(to)) throw new VaultError('transparent_address', 'That’s a transparent testnet address. Hush only pays to shielded addresses starting with utest1 or ztestsapling1.');
    if (/^(u1|zs1|t1|t3)/.test(to)) throw new VaultError('mainnet_address', 'That looks like a mainnet address. Hush testnet only pays to testnet addresses starting with utest1 or ztestsapling1.');
    throw new VaultError('bad_address', 'Enter a testnet shielded address starting with utest1 or ztestsapling1.');
  }
  if (!Number.isSafeInteger(amount) || amount < depositRules.minWithdrawal) throw new VaultError('withdrawal_too_small', 'Withdraw at least $1.');
  if (amount > depositRules.maxWithdrawal) throw new VaultError('withdrawal_too_large', 'Testnet withdrawals are capped at $1,000 each.');
  const quote = await zecUsd(now);
  if (!quote) throw new VaultError('price_unavailable', 'We can’t get a ZEC price right now. Try again in a minute.', 503);
  const valueZat = microUsdToZat(amount, quote.price);
  if (valueZat < 10_000) throw new VaultError('withdrawal_too_small', 'That amount is too small to send on Zcash.');
  return tx(db, () => {
    const pending = (db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE vault_id = ? AND status IN ('queued','sending')").get(vaultId) as { n: number }).n;
    if (pending >= depositRules.maxPendingWithdrawals) throw new VaultError('too_many_withdrawals', 'You already have withdrawals on the way. Wait for them to arrive.', 429);
    if (amount > balanceOf(db, vaultId)) throw new VaultError('insufficient_funds', 'You don’t have that much in your vault.', 402);
    const id = randomUUID();
    db.prepare('INSERT INTO withdrawals (id, vault_id, address, amount, value_zat, price, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, vaultId, to, amount, valueZat, quote.price, now, now);
    post(db, 'withdrawal', id, [{ account: `vault:${vaultId}`, amount: -amount }, { account: 'withdrawals', amount }], now);
    return { id, amount, valueZat, price: quote.price, status: 'queued' as const, balance: balanceOf(db, vaultId) };
  });
}

function refund(db: Db, w: any, error: string, now: number) {
  tx(db, () => {
    const cur = db.prepare('SELECT status FROM withdrawals WHERE id = ?').get(w.id) as { status: string };
    if (cur.status === 'failed' || cur.status === 'sent') return;
    db.prepare("UPDATE withdrawals SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 300), now, w.id);
    post(db, 'refund', w.id, [{ account: 'withdrawals', amount: -w.amount }, { account: `vault:${w.vault_id}`, amount: w.amount }], now);
  });
}

// Sends queued withdrawals and follows the ones in flight.
export async function processWithdrawals(db: Db, wallet: ZcashWallet, now = Date.now()) {
  let sent = 0, failed = 0;
  for (const w of db.prepare("SELECT * FROM withdrawals WHERE status = 'queued' ORDER BY created_at LIMIT 10").all() as any[]) {
    db.prepare("UPDATE withdrawals SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'queued'").run(now, w.id);
    try {
      const r = await wallet.send(w.address, w.value_zat);
      db.prepare('UPDATE withdrawals SET opid = ?, updated_at = ? WHERE id = ?').run(r.opid ?? null, now, w.id);
    } catch (e: any) {
      refund(db, w, String(e?.message ?? e), now); failed++;
    }
  }
  for (const w of db.prepare("SELECT * FROM withdrawals WHERE status = 'sending' AND opid IS NOT NULL").all() as any[]) {
    try {
      const r = await wallet.checkSend(w.opid);
      if (r.status === 'success') { db.prepare("UPDATE withdrawals SET status = 'sent', txid = ?, updated_at = ? WHERE id = ?").run(r.txid ?? null, now, w.id); sent++; }
      else if (r.status === 'failed') { refund(db, w, r.error ?? 'Send failed', now); failed++; }
    } catch { /* try again next round */ }
  }
  return { sent, failed };
}

export function walletActivity(db: Db, vaultId: string) {
  const deposits = (db.prepare('SELECT * FROM deposits WHERE vault_id = ? ORDER BY seen_at DESC LIMIT 20').all(vaultId) as any[]).map((d) => ({
    id: d.id, txid: d.txid, valueZat: d.value_zat, confirmations: d.confirmations, status: d.status, credited: d.credited, at: d.seen_at,
  }));
  const withdrawals = (db.prepare('SELECT * FROM withdrawals WHERE vault_id = ? ORDER BY created_at DESC LIMIT 20').all(vaultId) as any[]).map((w) => ({
    id: w.id, address: w.address, amount: w.amount, valueZat: w.value_zat, status: w.status, txid: w.txid, error: w.status === 'failed' ? 'The send didn’t go through, so your balance was refunded.' : null, at: w.created_at,
  }));
  return { deposits, withdrawals, confirmationsNeeded: depositRules.confirmations };
}

export function startWalletLoop(db: Db, wallet: ZcashWallet, everyMs = Number(process.env.HUSH_WALLET_MS ?? 30_000)) {
  let busy = false;
  const run = async () => {
    if (busy) return; busy = true;
    try {
      const d = await scanDeposits(db, wallet);
      const w = await processWithdrawals(db, wallet);
      if (d.credited || w.sent || w.failed || d.waitingForPrice) console.log(new Date().toISOString(), '[wallet]', JSON.stringify({ ...d, ...w }));
    } catch (e: any) {
      console.error(new Date().toISOString(), '[wallet] error', e?.message ?? e);
      setState(db, 'wallet_error', String(e?.message ?? e));
    } finally { busy = false; }
  };
  run();
  const t = setInterval(run, everyMs);
  return () => clearInterval(t);
}
