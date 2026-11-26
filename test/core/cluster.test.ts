import { describe, expect, it } from 'vitest';
import { blastRadius, clusterDisputes, type AffectedOrder, type DisputeCase } from '../../src/core/cluster/cluster';
import { minor, type EvidenceItem } from '../../src/core/types';

let seq = 0;
const refundDroppedBy = (incident: string, deploy?: string): EvidenceItem => ({
  id: `ev${++seq}`,
  type: 'refund',
  state: 'approved-not-completed',
  kind: 'fact',
  source: { kind: 'sql', key: `REF-${seq}` },
  at: '2026-11-02T00:00:00Z',
  meta: { linkedIncident: incident, ...(deploy ? { linkedDeploy: deploy } : {}) },
});
const incidentEvidence = (key: string, state: string): EvidenceItem => ({
  id: `ev${++seq}`,
  type: 'incident',
  state,
  kind: 'fact',
  source: { kind: 'jira', key },
  at: '2026-11-01T00:00:00Z',
});

const kase = (issueKey: string, customer: string, cents: number, evidence: EvidenceItem[], currency = 'USD', orderId = `O-${issueKey}`): DisputeCase => ({
  issueKey,
  orderId,
  customer,
  amount: minor(cents),
  currency,
  evidence,
});
const repairedRefund = (incident: string): EvidenceItem => ({ ...refundDroppedBy(incident), state: 'completed-before-dispute' });
const processor = (incident: string, state: string): EvidenceItem => ({
  ...refundDroppedBy(incident),
  type: 'processor-refund',
  state,
});

describe('clusterDisputes', () => {
  it('groups disputes that are explicitly linked to the same incident', () => {
    const clusters = clusterDisputes([
      kase('DSP-1', 'c1', 24900, [refundDroppedBy('INC-231', 'DEP-88')]),
      kase('DSP-2', 'c2', 4900, [refundDroppedBy('INC-231', 'DEP-88')]),
      kase('DSP-3', 'c3', 9900, [incidentEvidence('INC-231', 'caused-duplicate-charge')]),
      kase('DSP-4', 'c4', 1500, []),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ incidentKey: 'INC-231', deployKey: 'DEP-88', totals: [{ currency: 'USD', amount: 39700 }] });
    expect(clusters[0]!.disputes.map((d) => d.issueKey)).toEqual(['DSP-1', 'DSP-2', 'DSP-3']);
  });

  it('never clusters on an incident that is only unrelated or overlapping (validation case 8)', () => {
    const clusters = clusterDisputes([
      kase('DSP-1', 'c1', 1000, [incidentEvidence('INC-300', 'unrelated')]),
      kase('DSP-2', 'c2', 1000, [incidentEvidence('INC-300', 'unrelated')]),
    ]);
    expect(clusters).toEqual([]);
  });

  it('needs at least two disputes to call it a cluster by default', () => {
    expect(clusterDisputes([kase('DSP-1', 'c1', 1000, [refundDroppedBy('INC-5')])])).toEqual([]);
    expect(clusterDisputes([kase('DSP-1', 'c1', 1000, [refundDroppedBy('INC-5')])], { minSize: 1 })).toHaveLength(1);
  });

  it('counts a dispute once even if several of its exhibits point at the incident', () => {
    const [c] = clusterDisputes([
      kase('DSP-1', 'c1', 1000, [refundDroppedBy('INC-9'), incidentEvidence('INC-9', 'caused-duplicate-charge')]),
      kase('DSP-2', 'c2', 1000, [refundDroppedBy('INC-9')]),
    ]);
    expect(c!.disputes).toHaveLength(2);
    expect(c!.totals).toEqual([{ currency: 'USD', amount: 2000 }]);
  });

  it('leaves out a dispute whose dropped refund was later paid and settled (review B5)', () => {
    const clusters = clusterDisputes([
      kase('DSP-1', 'a', 1000, [refundDroppedBy('INC-7')]),
      kase('DSP-2', 'b', 1000, [refundDroppedBy('INC-7')]),
      kase('DSP-3', 'c', 1000, [repairedRefund('INC-7'), processor('INC-7', 'settled'), incidentEvidence('INC-7', 'dropped-refund-repaired')]),
    ]);
    expect(clusters[0]!.disputes.map((d) => d.issueKey)).toEqual(['DSP-1', 'DSP-2']);
  });

  it('keeps a dispute whose refund was marked sent but never settled', () => {
    const [c] = clusterDisputes([
      kase('DSP-1', 'a', 1000, [repairedRefund('INC-8'), processor('INC-8', 'not-settled')]),
      kase('DSP-2', 'b', 1000, [repairedRefund('INC-8'), processor('INC-8', 'not-settled')]),
    ]);
    expect(c!.disputes).toHaveLength(2);
  });

  it('never sums different currencies (review B12)', () => {
    const [c] = clusterDisputes([
      kase('DSP-1', 'a', 1000, [refundDroppedBy('INC-9')], 'USD'),
      kase('DSP-2', 'b', 2000, [refundDroppedBy('INC-9')], 'EUR'),
      kase('DSP-3', 'c', 500, [refundDroppedBy('INC-9')], 'USD'),
    ]);
    expect(c!.totals).toEqual([
      { currency: 'EUR', amount: 2000 },
      { currency: 'USD', amount: 1500 },
    ]);
  });

  it('sorts clusters by money at stake, largest first', () => {
    const clusters = clusterDisputes([
      kase('DSP-1', 'a', 100, [refundDroppedBy('INC-A')]),
      kase('DSP-2', 'b', 100, [refundDroppedBy('INC-A')]),
      kase('DSP-3', 'c', 9000, [refundDroppedBy('INC-B')]),
      kase('DSP-4', 'd', 9000, [refundDroppedBy('INC-B')]),
    ]);
    expect(clusters.map((c) => c.incidentKey)).toEqual(['INC-B', 'INC-A']);
  });
});

describe('blastRadius', () => {
  const cluster = clusterDisputes([
    kase('DSP-1', 'c1', 24900, [refundDroppedBy('INC-231', 'DEP-88')], 'USD', 'O1'),
    kase('DSP-2', 'c2', 4900, [refundDroppedBy('INC-231', 'DEP-88')], 'USD', 'O2'),
  ])[0]!;
  const affected: AffectedOrder[] = [
    { orderId: 'O1', customer: 'c1', amount: minor(24900), currency: 'USD' },
    { orderId: 'O2', customer: 'c2', amount: minor(4900), currency: 'USD' },
    { orderId: 'O3', customer: 'c3', amount: minor(1900), currency: 'USD' },
    { orderId: 'O4', customer: 'c4', amount: minor(2900), currency: 'USD' },
    { orderId: 'O5', customer: 'c4', amount: minor(1000), currency: 'USD' },
  ];

  it('separates orders already disputed from those not yet disputed', () => {
    const r = blastRadius(cluster, affected, { disputeFee: minor(1500), analystMinutesPerDispute: 45 });
    expect(r.notYetDisputed.map((o) => o.orderId)).toEqual(['O3', 'O4', 'O5']);
    expect(r.customersNotYetDisputed).toBe(2);
    expect(r.proactiveRefundTotals).toEqual([{ currency: 'USD', amount: 5800 }]);
  });

  it('de-duplicates by order, not customer: a disputing customer can have another affected order (review B12)', () => {
    const more = [...affected, { orderId: 'O6', customer: 'c1', amount: minor(3000), currency: 'USD' }];
    const r = blastRadius(cluster, more, { disputeFee: minor(1500), analystMinutesPerDispute: 45 });
    expect(r.notYetDisputed.map((o) => o.orderId)).toEqual(['O3', 'O4', 'O5', 'O6']);
  });

  it('prices what the incident has cost in disputes so far', () => {
    const r = blastRadius(cluster, affected, { disputeFee: minor(1500), analystMinutesPerDispute: 45 });
    // 249 + 49 disputed, plus two 15-dollar fees
    expect(r.disputeCostSoFar).toEqual([{ currency: 'USD', amount: 24900 + 4900 + 2 * 1500 }]);
    expect(r.analystHoursSavedByBulkAccept).toBe(1.5);
  });

  it('keeps each currency separate, with fees in the fee currency', () => {
    const r = blastRadius(cluster, [...affected, { orderId: 'O7', customer: 'c7', amount: minor(5000), currency: 'EUR' }], {
      disputeFee: minor(1500),
      feeCurrency: 'USD',
      analystMinutesPerDispute: 45,
    });
    expect(r.proactiveRefundTotals).toEqual([
      { currency: 'EUR', amount: 5000 },
      { currency: 'USD', amount: 5800 },
    ]);
  });

  it('never reports a prediction of future disputes', () => {
    const r = blastRadius(cluster, affected, { disputeFee: minor(1500), analystMinutesPerDispute: 45 });
    expect(JSON.stringify(r)).not.toMatch(/predict|likely|probab|percent/i);
  });
});
