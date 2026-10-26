// The Zcash wallet Hush talks to. Two implementations:
//   ZalletWallet: Zallet's JSON-RPC (Zcash's zcashd successor), running on testnet next to Zebra.
//   MockWallet:   in-memory, for tests and offline development.
// Hush keeps one "house" account in the wallet and hands each vault its own shielded address from it.
import { readFileSync } from 'node:fs';

export type IncomingNote = {
  key: string;            // stable id: txid:pool:index
  txid: string;
  address: string | null; // the receiving address, used to find the vault
  valueZat: number;
  confirmations: number;
};

export type SendResult = { status: 'pending' | 'success' | 'failed'; opid?: string; txid?: string; error?: string };

export interface ZcashWallet {
  kind: 'zallet' | 'mock';
  network: 'testnet';
  newAddress(): Promise<string>;
  listIncoming(): Promise<IncomingNote[]>;
  send(to: string, valueZat: number): Promise<SendResult>;
  checkSend(opid: string): Promise<SendResult>;
}

// Testnet shielded and unified addresses. Transparent (tm…) and mainnet addresses are refused.
export const isTestnetShielded = (a: string) => /^(utest1[0-9a-z]{40,}|ztestsapling1[0-9a-z]{60,})$/.test(a);

// ---------- Zallet JSON-RPC ----------
export type ZalletConfig = {
  url: string;               // e.g. http://127.0.0.1:28232
  user?: string; password?: string; cookieFile?: string;
  account?: string;          // house account UUID; created as "hush-house" if unset
  minconf?: number;          // confirmations before notes are spendable for withdrawals
  privacyPolicy?: string;    // z_sendmany privacy policy
};

export class ZalletWallet implements ZcashWallet {
  kind = 'zallet' as const;
  network = 'testnet' as const;
  private id = 0;
  private account: string | null;
  private cfg: ZalletConfig;
  private fetchImpl: typeof fetch;
  constructor(cfg: ZalletConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.account = cfg.account ?? null;
    this.fetchImpl = fetchImpl;
  }

  private auth(): string | null {
    if (this.cfg.user) return 'Basic ' + Buffer.from(`${this.cfg.user}:${this.cfg.password ?? ''}`).toString('base64');
    if (this.cfg.cookieFile) return 'Basic ' + Buffer.from(readFileSync(this.cfg.cookieFile, 'utf8').trim()).toString('base64');
    return null;
  }

  async rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const a = this.auth();
    if (a) headers.authorization = a;
    const res = await this.fetchImpl(this.cfg.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }) });
    const j: any = await res.json().catch(() => ({}));
    if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    return j.result as T;
  }

  // The house account: configured UUID, else an account named hush-house, else a new one.
  async houseAccount(): Promise<string> {
    if (this.account) return this.account;
    const accounts: any[] = await this.rpc('z_listaccounts');
    const found = accounts.find((a) => a.name === 'hush-house');
    if (found?.account_uuid) return (this.account = found.account_uuid);
    const made: any = await this.rpc('z_getnewaccount', ['hush-house']);
    this.account = made.account_uuid ?? made.account;
    if (!this.account) throw new Error('z_getnewaccount returned no account id');
    return this.account;
  }

  // A fresh diversified unified address with Orchard and Sapling receivers (no transparent receiver).
  async newAddress(): Promise<string> {
    const acct = await this.houseAccount();
    const r: any = await this.rpc('z_getaddressforaccount', [acct, ['orchard', 'sapling']]);
    if (!r?.address) throw new Error('z_getaddressforaccount returned no address');
    return r.address;
  }

  async listIncoming(): Promise<IncomingNote[]> {
    const acct = await this.houseAccount();
    const notes: any[] = await this.rpc('z_listunspent', [0, 9_999_999, false]);
    const mine = notes.filter((n) => !n.walletInternal && (!n.account_uuid || n.account_uuid === acct) && n.pool !== 'transparent');
    const out: IncomingNote[] = [];
    for (const n of mine) {
      const index = n.outindex ?? n.actionindex ?? n.jsoutindex ?? 0;
      let address: string | null = n.address ?? null;
      if (!address) address = await this.addressFromTx(n.txid, n.pool, index).catch(() => null);
      out.push({
        key: `${n.txid}:${n.pool ?? 'shielded'}:${index}`,
        txid: n.txid,
        address,
        valueZat: Number(n.valueZat ?? Math.round(Number(n.value ?? n.amount) * 1e8)),
        confirmations: Number(n.confirmations ?? 0),
      });
    }
    return out;
  }

  // Fallback when z_listunspent omits the receiving address.
  private async addressFromTx(txid: string, pool: string, index: number): Promise<string | null> {
    const tx: any = await this.rpc('z_viewtransaction', [txid]);
    const o = (tx?.outputs ?? []).find((x: any) => (x.pool === pool || !pool) && (x.output ?? x.action ?? x.outindex) === index && !x.walletInternal);
    return o?.address ?? null;
  }

  async send(to: string, valueZat: number): Promise<SendResult> {
    const acct = await this.houseAccount();
    const from: any = await this.rpc('z_getaddressforaccount', [acct, ['orchard', 'sapling']]);
    const amount = Number((valueZat / 1e8).toFixed(8));
    const opid: string = await this.rpc('z_sendmany', [from.address, [{ address: to, amount }], this.cfg.minconf ?? null, null, this.cfg.privacyPolicy ?? 'AllowRevealedAmounts']);
    return { status: 'pending', opid };
  }

  async checkSend(opid: string): Promise<SendResult> {
    const ops: any[] = await this.rpc('z_getoperationstatus', [[opid]]);
    const op = ops?.[0];
    if (!op) return { status: 'pending', opid };
    if (op.status === 'success') return { status: 'success', opid, txid: op.result?.txid ?? op.result?.txids?.[0] };
    if (op.status === 'failed' || op.status === 'cancelled') return { status: 'failed', opid, error: op.error?.message ?? op.status };
    return { status: 'pending', opid };
  }
}

// ---------- in-memory wallet for tests and offline dev ----------
export class MockWallet implements ZcashWallet {
  kind = 'mock' as const;
  network = 'testnet' as const;
  notes: IncomingNote[] = [];
  sent: { opid: string; to: string; valueZat: number; status: SendResult['status'] }[] = [];
  failNextSend = false;
  private n = 0;
  async newAddress() { this.n++; return 'utest1' + 'mock' + String(this.n).padStart(6, '0') + 'q'.repeat(60); }
  async listIncoming() { return this.notes.map((x) => ({ ...x })); }
  receive(address: string, valueZat: number, confirmations = 0) {
    const txid = 'mocktx' + String(this.notes.length + 1).padStart(58, '0');
    this.notes.push({ key: `${txid}:orchard:0`, txid, address, valueZat, confirmations });
    return txid;
  }
  confirm(blocks = 1) { this.notes.forEach((x) => (x.confirmations += blocks)); }
  async send(to: string, valueZat: number): Promise<SendResult> {
    const opid = 'opid-mock-' + (this.sent.length + 1);
    this.sent.push({ opid, to, valueZat, status: this.failNextSend ? 'failed' : 'success' });
    this.failNextSend = false;
    return { status: 'pending', opid };
  }
  async checkSend(opid: string): Promise<SendResult> {
    const s = this.sent.find((x) => x.opid === opid);
    if (!s) return { status: 'pending', opid };
    return s.status === 'failed' ? { status: 'failed', opid, error: 'Insufficient funds in house wallet' } : { status: 'success', opid, txid: 'sendtx-' + opid };
  }
}

export function walletFromEnv(): ZcashWallet | null {
  if (process.env.HUSH_WALLET === 'mock') return new MockWallet();
  const url = process.env.HUSH_ZALLET_URL;
  if (!url) return null;
  return new ZalletWallet({
    url,
    user: process.env.HUSH_ZALLET_USER,
    password: process.env.HUSH_ZALLET_PASSWORD,
    cookieFile: process.env.HUSH_ZALLET_COOKIE,
    account: process.env.HUSH_ZALLET_ACCOUNT,
    minconf: process.env.HUSH_ZALLET_MINCONF ? Number(process.env.HUSH_ZALLET_MINCONF) : undefined,
    privacyPolicy: process.env.HUSH_ZALLET_PRIVACY,
  });
}
