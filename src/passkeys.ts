// Passkeys: sign in with Face ID, a fingerprint or a device PIN. No names or emails are involved;
// Hush stores a credential id and a public key per vault. A passkey sign-in issues a session token
// that works like the secret code for 30 days.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { Db } from './db.ts';
import { VaultError } from './vault.ts';

export const SESSION_DAYS = 30;
const CHALLENGE_TTL_MS = 5 * 60_000;

export type RelyingParty = { rpID: string; origins: string[]; rpName: string };

// HUSH_ORIGIN is the public site address, e.g. https://hush.example. Several may be comma separated.
export function relyingParty(port: number): RelyingParty {
  const origins = (process.env.HUSH_ORIGIN ?? `http://localhost:${port}`).split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return { rpID: new URL(origins[0]).hostname, origins, rpName: 'Hush' };
}

const sha = (s: string) => createHash('sha256').update('hush-session-v1:' + s).digest('hex');

export function newSession(db: Db, vaultId: string, now = Date.now()) {
  const token = 'sess_' + randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, vault_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha(token), vaultId, now, now + SESSION_DAYS * 86400_000);
  return token;
}

export function vaultIdForSession(db: Db, token: string, now = Date.now()): string | null {
  if (!token.startsWith('sess_')) return null;
  const r = db.prepare('SELECT vault_id, expires_at FROM sessions WHERE token_hash = ?').get(sha(token)) as { vault_id: string; expires_at: number } | undefined;
  if (!r || r.expires_at < now) return null;
  return r.vault_id;
}

export function endSession(db: Db, token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

function saveChallenge(db: Db, challenge: string, kind: 'register' | 'login', vaultId: string | null, now: number) {
  db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(now);
  const id = randomUUID();
  db.prepare('INSERT INTO challenges (id, challenge, kind, vault_id, expires_at) VALUES (?,?,?,?,?)').run(id, challenge, kind, vaultId, now + CHALLENGE_TTL_MS);
  return id;
}

// Each challenge can be used once.
function takeChallenge(db: Db, id: string, kind: 'register' | 'login', now: number) {
  const c = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id) as any;
  db.prepare('DELETE FROM challenges WHERE id = ?').run(id);
  if (!c || c.kind !== kind || c.expires_at < now) throw new VaultError('challenge_expired', 'That sign-in attempt expired. Try again.', 400);
  return c as { challenge: string; vault_id: string | null };
}

export function passkeyCount(db: Db, vaultId: string): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE vault_id = ?').get(vaultId) as { n: number }).n);
}

export async function registrationOptions(db: Db, rp: RelyingParty, vaultId: string, now = Date.now()) {
  if (passkeyCount(db, vaultId) >= 10) throw new VaultError('too_many_passkeys', 'This vault already has 10 passkeys.', 409);
  const existing = db.prepare('SELECT id, transports FROM passkeys WHERE vault_id = ?').all(vaultId) as { id: string; transports: string | null }[];
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: 'Hush vault',               // shown by the device; deliberately carries no identity
    userDisplayName: 'Hush vault',
    userID: new TextEncoder().encode(vaultId),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  return { challengeId: saveChallenge(db, options.challenge, 'register', vaultId, now), options };
}

export async function verifyRegistration(db: Db, rp: RelyingParty, vaultId: string, challengeId: string, response: any, now = Date.now()) {
  const c = takeChallenge(db, challengeId, 'register', now);
  if (c.vault_id !== vaultId) throw new VaultError('challenge_expired', 'That sign-in attempt expired. Try again.', 400);
  let v;
  try {
    v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: false });
  } catch (e: any) {
    throw new VaultError('passkey_failed', 'Your device couldn’t create the passkey. Try again.', 400);
  }
  if (!v.verified || !v.registrationInfo) throw new VaultError('passkey_failed', 'Your device couldn’t create the passkey. Try again.', 400);
  const cred = v.registrationInfo.credential;
  db.prepare('INSERT OR IGNORE INTO passkeys (id, vault_id, public_key, counter, transports, created_at) VALUES (?,?,?,?,?,?)')
    .run(cred.id, vaultId, Buffer.from(cred.publicKey), cred.counter, JSON.stringify(cred.transports ?? response?.response?.transports ?? []), now);
  return { passkeys: passkeyCount(db, vaultId) };
}

export async function loginOptions(db: Db, rp: RelyingParty, now = Date.now()) {
  // No allowCredentials: the device offers whichever Hush passkey it holds.
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred' });
  return { challengeId: saveChallenge(db, options.challenge, 'login', null, now), options };
}

export async function verifyLogin(db: Db, rp: RelyingParty, challengeId: string, response: any, now = Date.now()) {
  const c = takeChallenge(db, challengeId, 'login', now);
  const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(String(response?.id ?? '')) as any;
  if (!row) throw new VaultError('unknown_passkey', 'That passkey isn’t linked to a Hush vault. Use your secret code instead.', 401);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge: c.challenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: false,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: row.transports ? JSON.parse(row.transports) : undefined },
    });
  } catch (e: any) {
    throw new VaultError('passkey_failed', 'Your passkey couldn’t be checked. Try again or use your secret code.', 401);
  }
  if (!v.verified) throw new VaultError('passkey_failed', 'Your passkey couldn’t be checked. Try again or use your secret code.', 401);
  db.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?').run(v.authenticationInfo.newCounter, now, row.id);
  return { vaultId: row.vault_id as string, session: newSession(db, row.vault_id, now) };
}
