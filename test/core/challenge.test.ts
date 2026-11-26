import { describe, expect, it } from 'vitest';
import { challengeDispute } from '../../src/core/challenge/challenge';
import { evaluateDispute } from '../../src/core/rubric/evaluate';
import { minor, type Dispute, type EvidenceItem, type EvidenceMeta, type EvidenceType } from '../../src/core/types';

let seq = 0;
const ev = (
  type: EvidenceType,
  state: string,
  key: string,
  opts: { at?: string; kind?: 'fact' | 'inference'; meta?: EvidenceMeta } = {},
): EvidenceItem => ({
  id: `ev${++seq}`,
  type,
  state,
  kind: opts.kind ?? 'fact',
  source: { kind: 'jira', key },
  at: opts.at ?? '2026-10-05T10:00:00Z',
  ...(opts.meta ? { meta: opts.meta } : {}),
});

const dispute = (reasonCode: string, overrides: Partial<Dispute> = {}): Dispute => ({
  externalId: 'dp_1',
  chargeId: 'ch_1',
  orderId: 'ORD-1',
  customer: 'cus_1',
  amount: minor(8000),
  currency: 'USD',
  processorReason: 'test',
  reasonCode,
  respondBy: '2026-12-04T00:00:00Z',
  receivedAt: '2026-11-20T00:00:00Z',
  purchasedAt: '2026-10-01T12:00:00Z',
  ...overrides,
});

const run = (d: Dispute, evidence: EvidenceItem[]) => challengeDispute(d, evidence, evaluateDispute(d, evidence));
const strong131 = () => [ev('delivery', 'delivered', 'ORD-1'), ev('refund', 'none', 'ORD-1')];

describe('challengeDispute', () => {
  it('finds nothing against a clean, strong case and keeps the fight', () => {
    const r = run(dispute('visa-13.1'), strong131());
    expect(r.findings).toEqual([]);
    expect(r.recommendation).toBe('fight');
    expect(r.changed).toBe(false);
    expect(r.support.map((s) => s.label)).toContain('Proof of delivery to the customer’s address');
  });

  it('raises a customer message that contradicts the merchant and downgrades fight (validation case 5)', () => {
    const r = run(dispute('visa-13.1'), [
      ...strong131(),
      ev('customer-message', 'denied-receipt', 'SUP-7', { kind: 'inference', meta: { quote: 'It never arrived' } }),
    ]);
    const f = r.findings.find((x) => x.rule === 'customer-contradicts');
    expect(f?.severity).toBe('weakens');
    expect(f?.detail).toMatch(/It never arrived/);
    expect(f?.evidence[0]?.source.key).toBe('SUP-7');
    expect(r.recommendation).toBe('investigate');
    expect(r.changed).toBe(true);
  });

  it('treats a refund approved but never completed as decisive', () => {
    const r = run(dispute('visa-13.3'), [ev('refund', 'approved-not-completed', 'REF-1')]);
    expect(r.findings.find((x) => x.rule === 'refund-outstanding')?.severity).toBe('decisive');
    expect(r.recommendation).toBe('accept');
  });

  it('treats a refund that is only initiated as weakening, not decisive', () => {
    const r = run(dispute('visa-13.3'), [ev('refund', 'initiated', 'REF-2')]);
    expect(r.findings.find((x) => x.rule === 'refund-outstanding')?.severity).toBe('weakens');
  });

  it('flags a proof-of-delivery name or address mismatch', () => {
    const r = run(dispute('visa-13.1'), [ev('delivery', 'delivered-address-mismatch', 'ORD-1'), ev('refund', 'none', 'ORD-1')]);
    expect(r.findings.map((x) => x.rule)).toContain('delivery-mismatch');
  });

  it('flags supporting evidence created after the dispute arrived', () => {
    const r = run(dispute('visa-13.1'), [ev('delivery', 'delivered', 'ORD-1', { at: '2026-11-21T09:00:00Z' }), ev('refund', 'none', 'ORD-1')]);
    const f = r.findings.find((x) => x.rule === 'evidence-after-dispute');
    expect(f?.severity).toBe('weakens');
    expect(r.recommendation).toBe('investigate');
  });

  it('flags a policy version that was not in force at purchase (validation case 9)', () => {
    const r = run(dispute('visa-13.1'), [
      ...strong131(),
      ev('policy', 'accepted-at-checkout', 'CONF-12', { meta: { version: 'v2', effectiveFrom: '2026-10-15T00:00:00Z', effectiveTo: null } }),
    ]);
    const f = r.findings.find((x) => x.rule === 'policy-not-in-force');
    expect(f?.severity).toBe('weakens');
    expect(f?.detail).toMatch(/v2/);
  });

  it('accepts a policy version that was in force at purchase', () => {
    const r = run(dispute('visa-13.1'), [
      ...strong131(),
      ev('policy', 'accepted-at-checkout', 'CONF-11', { meta: { version: 'v1', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-10-15T00:00:00Z' } }),
    ]);
    expect(r.findings.map((x) => x.rule)).not.toContain('policy-not-in-force');
  });

  it('makes no causal claim for an incident that only overlaps in time (validation case 8)', () => {
    const r = run(dispute('visa-12.6.1'), [
      ev('order-pair', 'distinct', 'ORD-1'),
      ev('incident', 'unrelated', 'INC-300', { meta: { windowStart: '2026-09-30T00:00:00Z', windowEnd: '2026-10-02T00:00:00Z' } }),
    ]);
    const f = r.findings.find((x) => x.rule === 'incident-overlap-unlinked');
    expect(f?.severity).toBe('note');
    expect(f?.detail).toMatch(/not linked/i);
    expect(r.recommendation).toBe('fight');
  });

  it('reports a linked incident as decisive', () => {
    const r = run(dispute('visa-12.6.1'), [ev('order-pair', 'distinct', 'ORD-1'), ev('incident', 'caused-duplicate-charge', 'INC-231')]);
    expect(r.findings.find((x) => x.rule === 'incident-linked')?.severity).toBe('decisive');
    expect(r.recommendation).toBe('accept');
  });

  it('notes a bank mention without counting it against the case', () => {
    const r = run(dispute('visa-13.1'), [...strong131(), ev('customer-message', 'mentioned-bank', 'SUP-9', { kind: 'inference' })]);
    expect(r.findings.find((x) => x.rule === 'customer-contradicts')).toBeUndefined();
    expect(r.recommendation).toBe('fight');
  });

  it('orders findings decisive first, then weakens, then notes', () => {
    const r = run(dispute('visa-13.3'), [
      ev('refund', 'approved-not-completed', 'REF-1'),
      ev('customer-message', 'complained', 'SUP-1', { kind: 'inference' }),
      ev('incident', 'unrelated', 'INC-9', { meta: { windowStart: '2026-09-01T00:00:00Z', windowEnd: null } }),
    ]);
    expect(r.findings.map((f) => f.severity)).toEqual(['decisive', 'weakens', 'note']);
  });
});
