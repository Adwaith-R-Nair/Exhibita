import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../../src/core/intake/signature';

const secret = 'whsec_test_only';
const body = '{"id":"evt_1","type":"charge.dispute.created"}';
const now = 1_795_700_000;

describe('webhook signatures (review A6)', () => {
  it('accepts a Stripe-style signature over "timestamp.body" made with the shared secret', () => {
    const v1 = createHmac('sha256', secret).update(`${now}.${body}`).digest('hex');
    expect(verifySignature(`t=${now},v1=${v1}`, body, secret, now)).toEqual({ ok: true });
    expect(verifySignature(signPayload(body, secret, now), body, secret, now + 299)).toEqual({ ok: true });
  });

  it('rejects a changed body, a wrong secret, a missing header and a malformed one', () => {
    const header = signPayload(body, secret, now);
    expect(verifySignature(header, body.replace('evt_1', 'evt_2'), secret, now)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifySignature(header, body, 'whsec_other', now)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifySignature(undefined, body, secret, now)).toEqual({ ok: false, reason: 'missing-signature' });
    expect(verifySignature('garbage', body, secret, now)).toEqual({ ok: false, reason: 'missing-signature' });
  });

  it('rejects a replay outside the five-minute window, in either direction', () => {
    const header = signPayload(body, secret, now);
    expect(verifySignature(header, body, secret, now + 301)).toEqual({ ok: false, reason: 'stale' });
    expect(verifySignature(header, body, secret, now - 301)).toEqual({ ok: false, reason: 'stale' });
  });

  it('accepts any one valid v1 among several, as when a secret is being rotated', () => {
    const good = signPayload(body, secret, now).split(',')[1];
    expect(verifySignature(`t=${now},v1=${'0'.repeat(64)},${good}`, body, secret, now)).toEqual({ ok: true });
  });
});
