import { describe, expect, it } from 'vitest';
import { blastRadius, clusterDisputes, type AffectedOrder, type DisputeCase } from '../../src/core/cluster/cluster';
import { formatMoney, planClusterActions } from '../../src/core/cluster/plan';
import { minor, type EvidenceItem } from '../../src/core/types';

let n = 0;
const ev = (type: EvidenceItem['type'], state: string, refundId: string, incident = 'INC-1', deploy = 'DEP-1'): EvidenceItem => ({
  id: `e${++n}`, type, state, kind: 'fact', source: { kind: 'sql', key: `refunds/${refundId}` }, at: '2026-11-01T00:00:00Z',
  meta: { refundId, linkedIncident: incident, linkedDeploy: deploy },
});
const kase = (key: string, cents: number, evidence: EvidenceItem[]): DisputeCase => ({ issueKey: key, orderId: `O-${key}`, customer: `c-${key}`, amount: minor(cents), currency: 'USD', evidence });

const cases = [
  kase('DSP-1', 24900, [ev('refund', 'completed-before-dispute', 'REF-1'), ev('processor-refund', 'not-settled', 'REF-1')]),
  kase('DSP-2', 4900, [ev('refund', 'approved-not-completed', 'REF-2')]),
];
const affected: AffectedOrder[] = [
  { orderId: 'O-DSP-1', customer: 'c-DSP-1', amount: minor(24900), currency: 'USD' },
  { orderId: 'O-9', customer: 'c-9', amount: minor(10000), currency: 'USD' },
];
const [cluster] = clusterDisputes(cases);
const blast = blastRadius(cluster!, affected, { disputeFee: minor(1500), analystMinutesPerDispute: 25 });
const plan = planClusterActions(cluster!, cases, blast, { incidentTitle: 'Refund worker marked refunds as sent', deployTitle: 'Deploy refund-worker 3.2' });

describe('planClusterActions', () => {
  it('accepts every dispute in the cluster', () => {
    expect(plan.accept.map((a) => a.issueKey)).toEqual(['DSP-1', 'DSP-2']);
  });

  it('cancels each stuck refund once, so accepting never pays a customer twice', () => {
    expect(plan.voidRefunds).toEqual([
      { refundId: 'REF-1', issueKey: 'DSP-1' },
      { refundId: 'REF-2', issueKey: 'DSP-2' },
    ]);
    expect(plan.accept[0]!.comment).toMatch(/REF-1/);
    expect(plan.accept[0]!.comment).toMatch(/not paid twice/);
  });

  it('queues proactive refunds only for orders nobody has disputed', () => {
    expect(plan.proactive.map((o) => o.orderId)).toEqual(['O-9']);
  });

  it('writes a cost bug that names the deploy and adds disputes and fees', () => {
    expect(plan.costBug.summary).toBe('DEP-1 has cost $328.00 in disputes so far');
    expect(plan.costBug.description).toMatch(/2 disputes/);
    expect(plan.costBug.description).toMatch(/1 customer has not disputed yet/);
    expect(plan.costBug.description).toMatch(/\$100\.00/);
  });

  it('never claims anything about refunds that are not linked to this incident', () => {
    const other = [kase('DSP-3', 1000, [ev('refund', 'approved-not-completed', 'REF-3', 'INC-9')])];
    const mixed = [...cases, ...other];
    const [c] = clusterDisputes(mixed).filter((x) => x.incidentKey === 'INC-1');
    const p = planClusterActions(c!, mixed, blastRadius(c!, affected, { disputeFee: minor(1500), analystMinutesPerDispute: 25 }), {});
    expect(p.voidRefunds.map((v) => v.refundId)).not.toContain('REF-3');
  });
});

describe('formatMoney', () => {
  it('formats minor units as currency', () => {
    expect(formatMoney({ amount: minor(3085900), currency: 'USD' })).toBe('$30,859.00');
    expect(formatMoney([{ amount: minor(100), currency: 'EUR' }, { amount: minor(250), currency: 'USD' }])).toBe('€1.00 + $2.50');
  });
});
