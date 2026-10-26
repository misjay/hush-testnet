process.env.HUSH_MOCK = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { buildServer } from '../src/server.ts';
import { createVault } from '../src/vault.ts';
import { newSession } from '../src/passkeys.ts';

test('a session token works like the secret code and can be ended', async () => {
  const db = openDb(':memory:');
  const app = buildServer(db);
  const { vaultId } = createVault(db);
  const token = newSession(db, vaultId);
  const auth = { authorization: `Bearer ${token}` };
  const v = await app.inject({ url: '/api/vault', headers: auth });
  assert.equal(v.statusCode, 200);
  assert.equal(v.json().passkeys, 0);
  await app.inject({ method: 'POST', url: '/api/sessions/end', headers: auth });
  assert.equal((await app.inject({ url: '/api/vault', headers: auth })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/vault', headers: { authorization: 'Bearer sess_forged' } })).statusCode, 401);
  await app.close();
});

test('passkey registration needs a vault, and each challenge works once', async () => {
  const db = openDb(':memory:');
  const app = buildServer(db);
  assert.equal((await app.inject({ method: 'POST', url: '/api/passkeys/register/options' })).statusCode, 401);
  const { code } = createVault(db);
  const auth = { authorization: `Bearer ${code}` };
  const o = await app.inject({ method: 'POST', url: '/api/passkeys/register/options', headers: auth });
  assert.equal(o.statusCode, 200);
  const { challengeId, options } = o.json();
  assert.equal(options.rp.id, 'localhost');
  assert.equal(options.user.name, 'Hush vault', 'no identity in the passkey');
  const bogus = { id: 'x', rawId: 'x', type: 'public-key', response: { clientDataJSON: 'e30', attestationObject: 'e30' }, clientExtensionResults: {} };
  const first = await app.inject({ method: 'POST', url: '/api/passkeys/register/verify', headers: auth, payload: { challengeId, response: bogus } });
  assert.equal(first.json().code, 'passkey_failed');
  const again = await app.inject({ method: 'POST', url: '/api/passkeys/register/verify', headers: auth, payload: { challengeId, response: bogus } });
  assert.equal(again.json().code, 'challenge_expired', 'challenge was consumed');
  await app.close();
});

test('signing in with an unknown passkey is refused', async () => {
  const db = openDb(':memory:');
  const app = buildServer(db);
  const o = (await app.inject({ method: 'POST', url: '/api/passkeys/login/options' })).json();
  const r = await app.inject({ method: 'POST', url: '/api/passkeys/login/verify', payload: { challengeId: o.challengeId, response: { id: 'nope', rawId: 'nope', type: 'public-key', response: {}, clientExtensionResults: {} } } });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().code, 'unknown_passkey');
  await app.close();
});
