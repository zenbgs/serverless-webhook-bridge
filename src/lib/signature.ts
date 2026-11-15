import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a webhook signature header of the form `t=<unix seconds>,v1=<hex hmac>`.
 * The HMAC-SHA256 is computed over `${t}.${rawBody}` so the timestamp can't be swapped,
 * and old timestamps are rejected to block replayed requests.
 */
export function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  { toleranceSec = 300, nowMs = Date.now() }: { toleranceSec?: number; nowMs?: number } = {},
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const sig = parts.v1;
  if (!Number.isFinite(t) || !sig || !/^[0-9a-f]+$/i.test(sig)) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;

  const expected = sign(rawBody, secret, t);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sign(rawBody: string, secret: string, t: number): string {
  return createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
}
