import { describe, expect, it } from 'vitest';
import { evaluateDispute } from '../../src/core/rubric/evaluate.js';
import { findReason, REASONS } from '../../src/core/rubric/reasons.js';
import { minor, type Dispute, type EvidenceItem, type EvidenceType } from '../../src/core/types.js';

let seq = 0;
const ev = (type: EvidenceType, state: string, key: string, kind: 'fact' | 'inference' = 'fact'): EvidenceItem => ({
  id: `ev${++seq}`,
  type,
  state,
  kind,
  source: { kind: 'jira', key },
  at: '2026-11-01T10:00:00Z',
});

const dispute = (reasonCode: string, dollars: number): Dispute => ({
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
    expect(r.why).toMatch(/conflict/i);
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
      ev('customer-message', 'acknowledged-receipt', 'SUP-42', 'inference'),
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
