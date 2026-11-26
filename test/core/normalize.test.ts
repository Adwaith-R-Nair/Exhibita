import { describe, expect, it } from 'vitest';
import { normalizeDisputeEvent } from '../../src/core/intake/normalize';

const event = (overrides: Record<string, unknown> = {}, object: Record<string, unknown> = {}) => ({
  id: 'evt_1',
  type: 'charge.dispute.created',
  created: 1764000000,
  data: {
    object: {
      id: 'dp_test1',
      charge: 'ch_1',
      amount: 24900,
      currency: 'usd',
      reason: 'product_unacceptable',
      evidence_details: { due_by: 1766000000 },
      metadata: { order_id: 'ORD-77', customer: 'cus_9', purchased_at: '2026-10-02T09:30:00Z' },
      ...object,
    },
  },
  ...overrides,
});

describe('normalizeDisputeEvent', () => {
  it('maps a Stripe-compatible dispute event to a dispute record', () => {
    const r = normalizeDisputeEvent(event());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dispute).toEqual({
      externalId: 'dp_test1',
      chargeId: 'ch_1',
      orderId: 'ORD-77',
      customer: 'cus_9',
      amount: 24900,
      currency: 'USD',
      processorReason: 'product_unacceptable',
      reasonCode: 'visa-13.3',
      respondBy: new Date(1766000000 * 1000).toISOString(),
      receivedAt: new Date(1764000000 * 1000).toISOString(),
      purchasedAt: '2026-10-02T09:30:00.000Z',
    });
  });

  it.each([
    ['product_not_received', 'visa-13.1'],
    ['product_unacceptable', 'visa-13.3'],
    ['duplicate', 'visa-12.6.1'],
    ['fraudulent', 'visa-10.4'],
    ['subscription_canceled', 'visa-13.2'],
    ['general', 'unknown'],
    ['something_new', 'unknown'],
  ])('maps processor reason %s to %s', (reason, expected) => {
    const r = normalizeDisputeEvent(event({}, { reason }));
    expect(r.ok && r.dispute.reasonCode).toBe(expected);
  });

  it('ignores events that are not new disputes', () => {
    const r = normalizeDisputeEvent(event({ type: 'charge.dispute.closed' }));
    expect(r).toEqual({ ok: false, error: 'ignored-event-type' });
  });

  it.each([
    ['missing id', { id: undefined }],
    ['negative amount', { amount: -5 }],
    ['fractional amount', { amount: 12.5 }],
    ['bad currency', { currency: 'dollars' }],
  ])('rejects a malformed dispute: %s', (_label, object) => {
    const r = normalizeDisputeEvent(event({}, object));
    expect(r.ok).toBe(false);
  });

  it('rejects payloads that are not objects', () => {
    expect(normalizeDisputeEvent(null).ok).toBe(false);
    expect(normalizeDisputeEvent('{"type":"charge.dispute.created"}').ok).toBe(false);
    expect(normalizeDisputeEvent([]).ok).toBe(false);
  });

  it('tolerates missing optional fields', () => {
    const r = normalizeDisputeEvent(event({}, { charge: undefined, metadata: undefined, evidence_details: undefined }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dispute.orderId).toBeNull();
    expect(r.dispute.respondBy).toBeNull();
    expect(r.dispute.purchasedAt).toBeNull();
  });

  it('ignores an unparseable purchase date instead of storing garbage', () => {
    const r = normalizeDisputeEvent(event({}, { metadata: { purchased_at: 'yesterday' } }));
    expect(r.ok && r.dispute.purchasedAt).toBeNull();
  });
});
