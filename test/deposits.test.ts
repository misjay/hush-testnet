process.env.HUSH_MOCK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { createVault, balanceOf, ledgerIsBalanced, MICRO } from '../src/vault.ts';
import { depositAddress, scanDeposits, requestWithdrawal, processWithdrawals, depositRules } from '../src/deposits.ts';
import { MockWallet, ZalletWallet, isTestnetShielded } from '../src/zcash/wallet.ts';
import { zatToMicroUsd, microUsdToZat } from '../src/price.ts';

const PRICE = 386.4; // mock ZEC price
const UTEST = 'utest1' + 'a'.repeat(120);

test('price conversions round down and invert', () => {
  assert.equal(zatToMicroUsd(10_000_000, PRICE), 38_640_000); // 0.1 ZEC = $38.64
  assert.equal(microUsdToZat(38_640_000, PRICE), 10_000_000);
});

test('testnet shielded addresses only', () => {
  assert.ok(isTestnetShielded(UTEST));
  assert.ok(isTestnetShielded('ztestsapling1' + 'q'.repeat(75)));
  assert.ok(!isTestnetShielded('tmXYZ' + 'a'.repeat(30)));
  assert.ok(!isTestnetShielded('u1' + 'a'.repeat(120)));
});

test('a deposit is credited once, after enough confirmations', async () => {
  const db = openDb(':memory:');
  const w = new MockWallet();
  const { vaultId } = createVault(db);
  const addr = await depositAddress(db, w, vaultId);
  assert.equal(await depositAddress(db, w, vaultId), addr, 'one address per vault');
  w.receive(addr, 10_000_000, 1);          // 0.1 TAZ, 1 confirmation
  w.receive('utest1someoneelse' + 'b'.repeat(80), 5_000_000, 9); // not a vault address
  let r = await scanDeposits(db, w);
  assert.deepEqual([r.seen, r.credited, r.unmatched], [1, 0, 1]);
  assert.equal(balanceOf(db, vaultId), 250 * MICRO);
  w.confirm(depositRules.confirmations);
  r = await scanDeposits(db, w);
  assert.equal(r.credited, 1);
  assert.equal(balanceOf(db, vaultId), 250 * MICRO + 38_640_000);
  r = await scanDeposits(db, w);
  assert.equal(r.credited, 0, 'never credited twice');
  assert.ok(ledgerIsBalanced(db));
});

test('withdrawals validate, send, and refund on failure', async () => {
  const db = openDb(':memory:');
  const w = new MockWallet();
  const { vaultId } = createVault(db);
  await assert.rejects(requestWithdrawal(db, vaultId, 'tmABC' + 'x'.repeat(30), MICRO), (e: any) => e.code === 'transparent_address');
  await assert.rejects(requestWithdrawal(db, vaultId, 'u1' + 'x'.repeat(100), MICRO), (e: any) => e.code === 'mainnet_address');
  await assert.rejects(requestWithdrawal(db, vaultId, UTEST, 300 * MICRO), (e: any) => e.code === 'insufficient_funds');
  await assert.rejects(requestWithdrawal(db, vaultId, UTEST, MICRO / 2), (e: any) => e.code === 'withdrawal_too_small');

  const ok = await requestWithdrawal(db, vaultId, UTEST, 38_640_000);
  assert.equal(ok.valueZat, 10_000_000);
  assert.equal(balanceOf(db, vaultId), 250 * MICRO - 38_640_000, 'debited straight away');
  const done = await processWithdrawals(db, w); // sends, then confirms in the same round
  assert.equal(done.sent, 1);
  assert.equal((await processWithdrawals(db, w)).sent, 0, 'nothing left to send');
  assert.equal(w.sent[0].to, UTEST);

  w.failNextSend = true;
  await requestWithdrawal(db, vaultId, UTEST, 10 * MICRO);
  const f = await processWithdrawals(db, w);
  assert.equal(f.failed, 1);
  assert.equal(balanceOf(db, vaultId), 250 * MICRO - 38_640_000, 'failed send was refunded');
  assert.ok(ledgerIsBalanced(db));
});

test('too many withdrawals in flight are refused', async () => {
  const db = openDb(':memory:');
  const { vaultId } = createVault(db);
  for (let i = 0; i < depositRules.maxPendingWithdrawals; i++) await requestWithdrawal(db, vaultId, UTEST, 5 * MICRO);
  await assert.rejects(requestWithdrawal(db, vaultId, UTEST, 5 * MICRO), (e: any) => e.code === 'too_many_withdrawals');
});

test('HTTP: deposit address, mock deposit, withdrawal, vault activity', async () => {
  const db = openDb(':memory:');
  const wallet = new MockWallet();
  const app = buildServer(db, { wallet });
  const { code } = (await app.inject({ method: 'POST', url: '/api/vaults' })).json();
  const auth = { authorization: `Bearer ${code}` };
  const a = (await app.inject({ url: '/api/deposit-address', headers: auth })).json();
  assert.ok(isTestnetShielded(a.address));
  await app.inject({ method: 'POST', url: '/api/dev/mock-deposit', headers: auth, payload: { zec: 0.1 } });
  let v = (await app.inject({ url: '/api/vault', headers: auth })).json();
  assert.equal(v.balance, 250 * MICRO + 38_640_000);
  assert.equal(v.wallet.deposits[0].status, 'credited');
  const wd = await app.inject({ method: 'POST', url: '/api/withdrawals', headers: auth, payload: { address: UTEST, amount: 20 * MICRO } });
  assert.equal(wd.statusCode, 201);
  v = (await app.inject({ url: '/api/vault', headers: auth })).json();
  assert.equal(v.wallet.withdrawals[0].status, 'queued');
  assert.equal((await app.inject('/api/health')).json().wallet, 'mock');
  await app.close();
});

test('servers without a wallet say deposits are off', async () => {
  const db = openDb(':memory:');
  const app = buildServer(db);
  const { code } = (await app.inject({ method: 'POST', url: '/api/vaults' })).json();
  const r = await app.inject({ url: '/api/deposit-address', headers: { authorization: `Bearer ${code}` } });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, 'deposits_off');
  assert.equal((await app.inject({ method: 'POST', url: '/api/dev/mock-deposit', headers: { authorization: `Bearer ${code}` } })).statusCode, 404);
  await app.close();
});

test('Zallet connector speaks the documented RPC', async () => {
  const calls: { method: string; params: any[]; auth: string | null }[] = [];
  const results: Record<string, any> = {
    z_listaccounts: [{ account_uuid: 'acct-1', name: 'something-else' }],
    z_getnewaccount: { account_uuid: 'house-uuid' },
    z_getaddressforaccount: { account_uuid: 'house-uuid', address: UTEST },
    z_listunspent: [
      { txid: 'aa', pool: 'orchard', actionindex: 1, address: UTEST, valueZat: 12_345_678, confirmations: 4, account_uuid: 'house-uuid', walletInternal: false },
      { txid: 'bb', pool: 'sapling', outindex: 0, valueZat: 5_000, confirmations: 1, account_uuid: 'house-uuid', walletInternal: false },
      { txid: 'cc', pool: 'orchard', actionindex: 0, valueZat: 99, confirmations: 9, account_uuid: 'house-uuid', walletInternal: true },
      { txid: 'dd', pool: 'transparent', valueZat: 1, confirmations: 9, account_uuid: 'house-uuid' },
    ],
    z_viewtransaction: { outputs: [{ pool: 'sapling', output: 0, address: 'ztestsapling1' + 'z'.repeat(75), walletInternal: false }] },
    z_sendmany: 'opid-123',
    z_getoperationstatus: [{ id: 'opid-123', status: 'success', result: { txid: 'tx-999' } }],
  };
  const fake: typeof fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, params: body.params, auth: init.headers.authorization ?? null });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: results[body.method] ?? null }), { status: 200 });
  }) as any;
  const w = new ZalletWallet({ url: 'http://zallet:28232', user: 'hush', password: 'pw' }, fake);
  assert.equal(await w.newAddress(), UTEST);
  assert.deepEqual(calls.map((c) => c.method).slice(0, 3), ['z_listaccounts', 'z_getnewaccount', 'z_getaddressforaccount']);
  assert.deepEqual(calls[1].params, ['hush-house']);
  assert.deepEqual(calls[2].params, ['house-uuid', ['orchard', 'sapling']]);
  assert.match(calls[0].auth!, /^Basic /);

  const notes = await w.listIncoming();
  assert.equal(notes.length, 2, 'skips change and transparent outputs');
  assert.deepEqual(notes[0], { key: 'aa:orchard:1', txid: 'aa', address: UTEST, valueZat: 12_345_678, confirmations: 4 });
  assert.match(notes[1].address!, /^ztestsapling1/, 'address recovered from z_viewtransaction');

  const s = await w.send(UTEST, 150_000_000);
  assert.equal(s.opid, 'opid-123');
  const send = calls.find((c) => c.method === 'z_sendmany')!;
  assert.deepEqual(send.params[1], [{ address: UTEST, amount: 1.5 }]);
  assert.equal(send.params[3], null, 'fee must be null (ZIP 317)');
  assert.deepEqual(await w.checkSend('opid-123'), { status: 'success', opid: 'opid-123', txid: 'tx-999' });
});
