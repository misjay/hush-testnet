import { config } from '../config.ts';

export class HttpError extends Error {
  status: number;
  url: string;
  constructor(status: number, url: string, message: string) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GET a JSON document with a timeout and polite retries on 429 / 5xx.
export async function getJSON<T>(url: string, init: RequestInit = {}, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.requestTimeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
      if (res.ok) return (await res.json()) as T;
      const body = await res.text().catch(() => '');
      if (res.status === 429 || res.status >= 500) {
        let wait = 1000 * 2 ** i;
        try { const j = JSON.parse(body); if (j.retry_after_seconds) wait = j.retry_after_seconds * 1000; } catch {}
        lastErr = new HttpError(res.status, url, body.slice(0, 200));
        await sleep(Math.min(wait, 15_000));
        continue;
      }
      throw new HttpError(res.status, url, body.slice(0, 200));
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
      if (i < attempts - 1) await sleep(500 * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
