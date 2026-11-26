// Webhook signatures in the Stripe-compatible scheme (review A6). The sender puts
// "t=<unix seconds>,v1=<hex HMAC-SHA256 of 't.body'>" in a signature header. Verifying it proves the
// body came from someone holding the secret and was not changed, and the timestamp window stops an
// old, captured request from being replayed. The secret itself never travels with the request.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing-signature' | 'bad-signature' | 'stale' };

const hmac = (secret: string, t: number, body: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

/** Make a signature header, as a sender would. Used by the tests. */
export function signPayload(body: string, secret: string, nowSeconds: number): string {
  return `t=${nowSeconds},v1=${hmac(secret, nowSeconds, body)}`;
}

export function verifySignature(header: string | undefined, body: string, secret: string, nowSeconds: number): SignatureCheck {
  if (!header) return { ok: false, reason: 'missing-signature' };
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string | undefined]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k, v]) => k === 'v1' && v && /^[0-9a-f]{64}$/i.test(v)).map(([, v]) => v!.toLowerCase());
  if (!Number.isInteger(t) || signatures.length === 0) return { ok: false, reason: 'missing-signature' };
  const expected = Buffer.from(hmac(secret, t, body), 'hex');
  const match = signatures.some((s) => timingSafeEqual(Buffer.from(s, 'hex'), expected));
  if (!match) return { ok: false, reason: 'bad-signature' };
  if (Math.abs(nowSeconds - t) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };
  return { ok: true };
}
