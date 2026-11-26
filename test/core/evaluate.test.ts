import { describe, expect, it } from 'vitest';
import { evaluateDispute } from '../../src/core/rubric/evaluate';
import { findReason, REASONS } from '../../src/core/rubric/reasons';
import { minor, type Dispute, type EvidenceItem, type EvidenceType } from '../../src/core/types';

let seq = 0;
const ev = (type: EvidenceType, state: string, key: string, kind: 'fact' | 'inference' = 'fact'): EvidenceItem => ({
  id: `ev${++seq}`,
  type,
  state,
  kind,
  source: { kind: 'jira', key },
  at: '2026-11-01T10:00:00Z',
});

const dispute = (reasonCode: string, dollars: number, overrides: Partial<Dispute> = {}): Dispute => ({
  externalId: 'dp_test',
  chargeId: 'ch_test',
  orderId: 'ORD-1',
  customer: 'cus_1',
  amount: minor(Math.round(dollars * 100)),
  currency: 'USD',
  processorReason: 'test',
  reasonCode,
  respondBy: '2026-12-04T00:00:00Z',
  receivedAt: '2026-11-20T00:00:00Z',
  ...overrides,
});
const refundEv = (state: string, refundId: string, cents: number): EvidenceItem => ({
  ...ev('refund', state, `refunds/${refundId}`),
  meta: { refundId, amount: cents },
});
const processorEv = (state: string, refundId: string, cents: number): EvidenceItem => ({
  ...ev('processor-refund', state, 'charges/ch_test'),
  meta: { refundId, amount: cents, chargeId: 'ch_test' },
});

describe('reason catalogue', () => {
  it('maps network aliases and loose spellings to the same rubric', () => {
    expect(findReason('MC 4853')?.key).toBe('visa-13.3');
    expect(findReason('Visa 13.1')?.key).toBe('visa-13.1');
    expect(findReason('mc-4834')?.key).toBe('visa-12.6.1');
    expect(findReason('nonsense')).toBeNull();
  });

  it('gives every requirement a plain-English rule and at least one accepted state', () => {
    for (const reason of Object.values(REASONS)) {
      for (const req of reason.requirements) {
        expect(req.rule.length, `${reason.key}/${req.id}`).toBeGreaterThan(20);
        expect(req.accepts.length).toBeGreaterThan(0);
        for (const alt of req.accepts) expect(alt.states.length).toBeGreaterThan(0);
      }
    }
  });

  it('never lists a state as both accepted and conceding', () => {
    for (const reason of Object.values(REASONS)) {
      for (const req of reason.requirements) {
        const accepted = new Set(req.accepts.flatMap((a) => a.states.map((s) => `${a.type}:${s}`)));
        for (const c of req.concedes ?? []) {
          for (const s of c.states) expect(accepted.has(`${c.type}:${s}`), `${reason.key}/${req.id} ${s}`).toBe(false);
        }
      }
    }
  });
});

describe('item not received (Visa 13.1)', () => {
  it('recommends fight and allows submit when every required item is backed', () => {
    const r = evaluateDispute(dispute('visa-13.1', 120), [
      ev('delivery', 'delivered', 'ORD-1'),
      ev('refund', 'none', 'ORD-1'),
      ev('customer-message', 'acknowledged-receipt', 'SUP-12', 'inference'),
    ]);
    expect(r.recommendation).toBe('fight');
    expect(r.canSubmit).toBe(true);
    expect(r.coverage).toEqual({ met: 2, total: 2, label: 'Strong' });
  });

  it('requires a signed proof of delivery at or above the signature threshold', () => {
    const r = evaluateDispute(dispute('visa-13.1', 480), [
      ev('delivery', 'delivered', 'ORD-2'),
      ev('refund', 'none', 'ORD-2'),
    ]);
    expect(r.recommendation).toBe('investigate');
    expect(r.canSubmit).toBe(false);
    expect(r.blockers).toContain('Signed proof of delivery');
    expect(r.why).toMatch(/Signed proof of delivery/);
  });

  it('does not require a signature below the threshold', () => {
    const r = evaluateDispute(dispute('visa-13.1', 149.99), [
      ev('delivery', 'delivered', 'ORD-3'),
      ev('refund', 'none', 'ORD-3'),
    ]);
    expect(r.checks.find((c) => c.id === 'signed-pod')?.required).toBe(false);
    expect(r.canSubmit).toBe(true);
  });

  it('honours a custom signature threshold', () => {
    const r = evaluateDispute(
      dispute('visa-13.1', 100),
      [ev('delivery', 'delivered', 'ORD-4'), ev('refund', 'none', 'ORD-4')],
      { signatureThreshold: minor(5000) },
    );
    expect(r.checks.find((c) => c.id === 'signed-pod')?.required).toBe(true);
  });

  it('flags a missing proof of delivery and never invents one (validation case 2)', () => {
    const r = evaluateDispute(dispute('visa-13.1', 60), [ev('refund', 'none', 'ORD-5')]);
    const pod = r.checks.find((c) => c.id === 'delivery-proof');
    expect(pod?.status).toBe('missing');
    expect(pod?.evidence).toBeNull();
    expect(r.canSubmit).toBe(false);
  });

  it('treats delivery to the wrong address as failed, not met', () => {
    const r = evaluateDispute(dispute('visa-13.1', 60), [
      ev('delivery', 'delivered-address-mismatch', 'ORD-6'),
      ev('refund', 'none', 'ORD-6'),
    ]);
    expect(r.checks.find((c) => c.id === 'delivery-proof')?.status).toBe('failed');
    expect(r.recommendation).toBe('investigate');
    expect(r.why).toMatch(/against us/i);
  });
});

describe('not as described (Visa 13.3)', () => {
  it('flips to accept when a refund was approved but never completed: the core story', () => {
    const r = evaluateDispute(dispute('visa-13.3', 249), [
      ev('product-description', 'matches-delivered', 'CONF-7'),
      ev('customer-message', 'acknowledged-receipt', 'SUP-40', 'inference'),
      ev('refund', 'approved-not-completed', 'REF-231'),
    ]);
    expect(r.recommendation).toBe('accept');
    expect(r.why).toMatch(/REF-231/);
    expect(r.why).toMatch(/approved but never completed/);
    expect(r.canSubmit).toBe(false);
    expect(r.checks.find((c) => c.id === 'refund-status')?.status).toBe('conceded');
  });

  it('keeps refund initiated distinct from refund completed (validation case 3)', () => {
    const initiated = evaluateDispute(dispute('visa-13.3', 80), [
      ev('product-description', 'matches-delivered', 'CONF-7'),
      ev('customer-message', 'no-complaint', 'SUP-41', 'inference'),
      ev('refund', 'initiated', 'REF-9'),
    ]);
    expect(initiated.recommendation).toBe('investigate');
    expect(initiated.coverage.label).toBe('Partial');

    const completed = evaluateDispute(dispute('visa-13.3', 80), [
      ev('product-description', 'matches-delivered', 'CONF-7'),
      ev('customer-message', 'no-complaint', 'SUP-41', 'inference'),
      ev('refund', 'completed-before-dispute', 'REF-9'),
    ]);
    expect(completed.recommendation).toBe('fight');
  });

  it('marks a requirement contradicted when evidence points both ways (validation case 5)', () => {
    const r = evaluateDispute(dispute('visa-13.3', 80), [
      ev('product-description', 'matches-delivered', 'CONF-7'),
      ev('customer-message', 'no-complaint', 'SUP-42', 'inference'),
      ev('customer-message', 'complained', 'SUP-43', 'inference'),
      ev('refund', 'none', 'ORD-8'),
    ]);
    const check = r.checks.find((c) => c.id === 'no-prior-complaint');
    expect(check?.status).toBe('contradicted');
    expect(check?.contradictions.map((e) => e.source.key)).toEqual(['SUP-43']);
    expect(r.coverage.met).toBe(r.coverage.total - 1);
    expect(r.recommendation).toBe('investigate');
  });
});

describe('charged twice (Visa 12.6.1)', () => {
  it('accepts a true duplicate (validation case 6)', () => {
    const r = evaluateDispute(dispute('visa-12.6.1', 60), [
      ev('order-pair', 'duplicate', 'ORD-9'),
      ev('incident', 'none', 'OPS'),
    ]);
    expect(r.recommendation).toBe('accept');
  });

  it('accepts when a linked incident caused the duplicate charge', () => {
    const r = evaluateDispute(dispute('visa-12.6.1', 60), [
      ev('order-pair', 'distinct', 'ORD-9'),
      ev('incident', 'caused-duplicate-charge', 'INC-231'),
    ]);
    expect(r.recommendation).toBe('accept');
    expect(r.why).toMatch(/INC-231/);
  });

  it('fights when the charges are for distinct orders and no incident is linked', () => {
    const r = evaluateDispute(dispute('visa-12.6.1', 60), [
      ev('order-pair', 'distinct', 'ORD-9'),
      ev('incident', 'none', 'OPS'),
    ]);
    expect(r.recommendation).toBe('fight');
  });

  it('fights when the duplicate was already refunded', () => {
    const r = evaluateDispute(dispute('visa-12.6.1', 60), [
      ev('order-pair', 'duplicate-refunded', 'ORD-9'),
      ev('incident', 'none', 'OPS'),
    ]);
    expect(r.recommendation).toBe('fight');
  });
});

describe('card-not-present fraud (Visa 10.4)', () => {
  it('is met by 3-D Secure authentication', () => {
    const r = evaluateDispute(dispute('visa-10.4', 300), [ev('3ds', 'authenticated', 'ORD-10')]);
    expect(r.checks.find((c) => c.id === 'cardholder-verified')?.status).toBe('met');
    expect(r.recommendation).toBe('fight');
  });

  it('is met by Compelling Evidence 3.0 history when 3-D Secure was not used', () => {
    const r = evaluateDispute(dispute('visa-10.4', 300), [
      ev('3ds', 'not-attempted', 'ORD-11'),
      ev('prior-orders', 'ce30-eligible', 'ORD-11'),
    ]);
    const check = r.checks.find((c) => c.id === 'cardholder-verified');
    expect(check?.status).toBe('met');
    expect(check?.contradictions).toEqual([]);
  });

  it('asks for more when neither is present', () => {
    const r = evaluateDispute(dispute('visa-10.4', 300), [ev('3ds', 'not-attempted', 'ORD-12')]);
    expect(r.recommendation).toBe('investigate');
    expect(r.canSubmit).toBe(false);
  });
});

describe('triage edges', () => {
  it('says insufficient evidence when nothing was found (validation case 10)', () => {
    const r = evaluateDispute(dispute('visa-13.3', 40), []);
    expect(r.coverage.label).toBe('Insufficient evidence');
    expect(r.recommendation).toBe('investigate');
    expect(r.why).toMatch(/insufficient evidence/i);
  });

  it('sends unknown reasons to a person', () => {
    const r = evaluateDispute(dispute('visa-99.9', 1), []);
    expect(r.supported).toBe(false);
    expect(r.recommendation).toBe('investigate');
    expect(r.canSubmit).toBe(false);
  });

  it('lets an accept beat any amount of supporting evidence', () => {
    const r = evaluateDispute(dispute('visa-13.1', 60), [
      ev('delivery', 'delivered', 'ORD-1'),
      ev('customer-message', 'acknowledged-receipt', 'SUP-1', 'inference'),
      ev('policy', 'accepted-at-checkout', 'CONF-1'),
      ev('refund', 'approved-not-completed', 'REF-1'),
    ]);
    expect(r.recommendation).toBe('accept');
  });

  it('is deterministic: the same input gives the same output', () => {
    const input = [ev('delivery', 'delivered', 'ORD-1'), ev('refund', 'none', 'ORD-1')];
    expect(evaluateDispute(dispute('visa-13.1', 60), input)).toEqual(evaluateDispute(dispute('visa-13.1', 60), input));
  });

  it('never reports a win percentage (D-08)', () => {
    const r = evaluateDispute(dispute('visa-13.1', 20), [ev('delivery', 'delivered', 'X')]);
    expect(JSON.stringify(r)).not.toMatch(/win|probab|percent|odds|%/i);
  });
});

describe('plain-English explanations', () => {
  it('names a conceded fact as a sentence, not "Evidence <state>"', () => {
    const dup = evaluateDispute(dispute('visa-12.6.1', 60), [ev('order-pair', 'duplicate', 'ORD-9'), ev('incident', 'none', 'OPS')]);
    expect(dup.why).toMatch(/^This charge is a true duplicate of another charge \(ORD-9\)\./);
    const cancelled = evaluateDispute(dispute('visa-13.2', 30), [ev('cancellation', 'cancelled-before-charge', 'SUB-1')]);
    expect(cancelled.why).toMatch(/^The customer cancelled before the charge \(SUB-1\)\./);
    expect(cancelled.why).not.toMatch(/^Evidence/);
  });

  it('says evidence is against us when nothing conflicts, and conflicting only when it does', () => {
    const against = evaluateDispute(dispute('visa-10.4', 80), [ev('3ds', 'not-attempted', 'ORD-1'), ev('prior-orders', 'not-eligible', 'ORD-1')]);
    expect(against.recommendation).toBe('investigate');
    expect(against.why).toMatch(/^Evidence is against us on:/);
  });
});

describe('customer-message labels are facets, not exclusive states (review B3)', () => {
  it('does not treat "Got it" plus "no complaint" as a conflict', () => {
    const r = evaluateDispute(dispute('visa-13.1', 60), [
      ev('delivery', 'delivered', 'ORD-1'),
      ev('refund', 'none', 'ORD-1'),
      ev('customer-message', 'acknowledged-receipt', 'SUP-1', 'inference'),
      ev('customer-message', 'no-complaint', 'SUP-2', 'inference'),
      ev('customer-message', 'mentioned-bank', 'SUP-3', 'inference'),
    ]);
    const ack = r.checks.find((c) => c.id === 'customer-ack')!;
    expect(ack.status).toBe('met');
    expect(ack.contradictions).toEqual([]);
  });

  it('leaves the acknowledgement missing, not failed, when the customer never wrote to us', () => {
    const r = evaluateDispute(dispute('visa-13.1', 60), [
      ev('delivery', 'delivered', 'ORD-1'),
      ev('refund', 'none', 'ORD-1'),
      ev('customer-message', 'no-complaint', 'tickets?order=ORD-1', 'inference'),
    ]);
    expect(r.checks.find((c) => c.id === 'customer-ack')?.status).toBe('missing');
    expect(r.recommendation).toBe('fight');
  });

  it('still counts a listed opposing label against the requirement', () => {
    const r = evaluateDispute(dispute('visa-13.1', 60), [
      ev('delivery', 'delivered', 'ORD-1'),
      ev('refund', 'none', 'ORD-1'),
      ev('customer-message', 'acknowledged-receipt', 'SUP-1', 'inference'),
      ev('customer-message', 'denied-receipt', 'SUP-2', 'inference'),
    ]);
    const ack = r.checks.find((c) => c.id === 'customer-ack')!;
    expect(ack.status).toBe('contradicted');
    expect(ack.contradictions.map((e) => e.source.key)).toEqual(['SUP-2']);
  });

  it('does not let "Got it" stand in for "no complaint" on a not-as-described dispute', () => {
    const r = evaluateDispute(dispute('visa-13.3', 80), [
      ev('product-description', 'matches-delivered', 'CONF-7'),
      ev('customer-message', 'acknowledged-receipt', 'SUP-40', 'inference'),
      ev('refund', 'none', 'ORD-8'),
    ]);
    expect(r.checks.find((c) => c.id === 'no-prior-complaint')?.status).toBe('missing');
    expect(r.recommendation).toBe('investigate');
  });

  it('flags a customer who says they cancelled when the record says they did not', () => {
    const r = evaluateDispute(dispute('visa-13.2', 30), [
      ev('cancellation', 'none-before-charge', 'SUB-1'),
      ev('customer-message', 'cancelled', 'SUP-5', 'inference'),
    ]);
    expect(r.checks.find((c) => c.id === 'not-cancelled')?.status).toBe('contradicted');
    expect(r.recommendation).toBe('investigate');
  });

  it('keeps exclusive behaviour for other types (a declined and an owed refund still conflict)', () => {
    const r = evaluateDispute(dispute('visa-13.1', 60), [
      ev('delivery', 'delivered', 'ORD-1'),
      ev('delivery', 'delivered-address-mismatch', 'ORD-1b'),
      ev('refund', 'none', 'ORD-1'),
    ]);
    expect(r.checks.find((c) => c.id === 'delivery-proof')?.status).toBe('contradicted');
  });
});

describe('refund amounts and credits (review B6)', () => {
  it('investigates, rather than conceding, when only part of the amount is owed', () => {
    const r = evaluateDispute(dispute('visa-13.3', 249), [
      ev('product-description', 'matches-delivered', 'CONF-7'),
      ev('customer-message', 'no-complaint', 'SUP-1', 'inference'),
      refundEv('partial-approved-not-completed', 'REF-7', 5000),
    ]);
    expect(r.recommendation).toBe('investigate');
    expect(r.checks.find((c) => c.id === 'refund-status')?.status).toBe('failed');
  });

  it.each(['visa-13.1', 'visa-13.3', 'visa-13.6'])('%s: a full credit issued and settled before the dispute is a defense', (reason) => {
    const r = evaluateDispute(dispute(reason, 89), [
      ev('delivery', 'lost', 'ORD-1'),
      refundEv('completed-before-dispute', 'REF-8', 8900),
      processorEv('settled', 'REF-8', 8900),
    ]);
    expect(r.recommendation).toBe('fight');
    expect(r.canSubmit).toBe(true);
    expect(r.checks[0]).toMatchObject({ id: 'credit-issued', label: 'Credit issued before the dispute', status: 'met', required: true });
    expect(r.why).toMatch(/^Credit issued before the dispute/);
    expect(r.why).toMatch(/REF-8/);
    expect(r.coverage.label).toBe('Strong');
  });

  it('is no defense when the processor never settled it, or it covered only part of the amount', () => {
    const unsettled = evaluateDispute(dispute('visa-13.1', 89), [
      ev('delivery', 'lost', 'ORD-1'),
      refundEv('completed-before-dispute', 'REF-8', 8900),
      processorEv('not-settled', 'REF-8', 8900),
    ]);
    expect(unsettled.checks.map((c) => c.id)).not.toContain('credit-issued');
    expect(unsettled.recommendation).toBe('investigate');
    const partial = evaluateDispute(dispute('visa-13.1', 89), [
      ev('delivery', 'lost', 'ORD-1'),
      refundEv('completed-before-dispute', 'REF-8', 2000),
      processorEv('settled', 'REF-8', 2000),
    ]);
    expect(partial.checks.map((c) => c.id)).not.toContain('credit-issued');
  });

  it('does not offer the credit defense where the rubric does not allow it', () => {
    const r = evaluateDispute(dispute('visa-10.4', 89), [
      refundEv('completed-before-dispute', 'REF-8', 8900),
      processorEv('settled', 'REF-8', 8900),
    ]);
    expect(r.checks.map((c) => c.id)).not.toContain('credit-issued');
  });

  it('lets a concession beat the credit defense', () => {
    const r = evaluateDispute(dispute('visa-13.1', 89), [
      refundEv('completed-before-dispute', 'REF-8', 8900),
      processorEv('settled', 'REF-8', 8900),
      refundEv('approved-not-completed', 'REF-9', 8900),
    ]);
    expect(r.recommendation).toBe('accept');
  });
});

describe('credit not processed (Visa 13.6, review B10)', () => {
  it('is in the catalogue', () => {
    expect(findReason('Visa 13.6')?.label).toBe('Credit not processed');
  });

  it('fights when the refund service completed the credit before the dispute', () => {
    const r = evaluateDispute(dispute('visa-13.6', 249), [refundEv('completed-before-dispute', 'REF-1', 24900)]);
    expect(r.recommendation).toBe('fight');
    expect(r.coverage.label).toBe('Strong');
    expect(r.checks.find((c) => c.id === 'credit-processed')?.label).toBe('The promised credit was processed, or none was due');
  });

  it.each(['none', 'declined-per-policy'])('fights when no credit was owed (%s)', (state) => {
    expect(evaluateDispute(dispute('visa-13.6', 60), [ev('refund', state, 'ORD-1')]).recommendation).toBe('fight');
  });

  it('accepts when the credit was approved and never processed', () => {
    const r = evaluateDispute(dispute('visa-13.6', 60), [refundEv('approved-not-completed', 'REF-2', 6000)]);
    expect(r.recommendation).toBe('accept');
    expect(r.why).toMatch(/REF-2|refunds\/REF-2/);
  });

  it('investigates a refund that is only in progress, or completed with no date', () => {
    expect(evaluateDispute(dispute('visa-13.6', 60), [ev('refund', 'initiated', 'REF-3')]).recommendation).toBe('investigate');
    expect(evaluateDispute(dispute('visa-13.6', 60), [ev('refund', 'completed-date-unknown', 'REF-3')]).recommendation).toBe('investigate');
  });
});

describe('card network (review B9)', () => {
  const strong = [ev('delivery', 'delivered', 'ORD-1'), ev('refund', 'none', 'ORD-1')];

  it.each([
    ['mastercard', 'Mastercard'],
    ['amex', 'American Express'],
    ['discover', 'Discover'],
  ] as const)('does not judge a %s dispute by Visa rules', (network, name) => {
    const r = evaluateDispute(dispute('visa-13.1', 60, { network }), strong);
    expect(r.supported).toBe(false);
    expect(r.checks).toEqual([]);
    expect(r.recommendation).toBe('investigate');
    expect(r.canSubmit).toBe(false);
    expect(r.why).toBe(`${name} disputes are not supported yet; review by hand.`);
  });

  it('applies Visa rules to a Visa dispute and says so', () => {
    const r = evaluateDispute(dispute('visa-13.1', 60, { network: 'visa' }), strong);
    expect(r.recommendation).toBe('fight');
    expect(r.notes).toEqual(['Judged against Visa dispute rules.']);
  });

  it('applies Visa rules when the network is unknown, and notes it', () => {
    for (const d of [dispute('visa-13.1', 60, { network: 'unknown' }), dispute('visa-13.1', 60)]) {
      const r = evaluateDispute(d, strong);
      expect(r.recommendation).toBe('fight');
      expect(r.notes?.[0]).toMatch(/network is unknown/i);
    }
  });
});

describe('wording (review B13, D-08)', () => {
  it('never predicts the outcome of a fight', () => {
    const r = evaluateDispute(dispute('visa-13.3', 249), [ev('refund', 'approved-not-completed', 'REF-231')]);
    expect(r.why).not.toMatch(/likely|lose|lost/i);
    for (const reason of Object.values(REASONS)) for (const req of reason.requirements) expect(req.rule).not.toMatch(/likely/i);
  });
});
