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

const kase = (issueKey: string, customer: string, cents: number, evidence: EvidenceItem[]): DisputeCase => ({
  issueKey,
  customer,
  amount: minor(cents),
  currency: 'USD',
  evidence,
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
    expect(clusters[0]).toMatchObject({ incidentKey: 'INC-231', deployKey: 'DEP-88', totalAmount: 39700 });
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
    expect(c!.totalAmount).toBe(2000);
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
    kase('DSP-1', 'c1', 24900, [refundDroppedBy('INC-231', 'DEP-88')]),
    kase('DSP-2', 'c2', 4900, [refundDroppedBy('INC-231', 'DEP-88')]),
  ])[0]!;
  const affected: AffectedOrder[] = [
    { orderId: 'O1', customer: 'c1', amount: minor(24900) },
    { orderId: 'O2', customer: 'c2', amount: minor(4900) },
    { orderId: 'O3', customer: 'c3', amount: minor(1900) },
    { orderId: 'O4', customer: 'c4', amount: minor(2900) },
    { orderId: 'O5', customer: 'c4', amount: minor(1000) },
  ];

  it('separates customers who already disputed from those who have not', () => {
    const r = blastRadius(cluster, affected, { disputeFee: minor(1500), analystMinutesPerDispute: 45 });
    expect(r.notYetDisputed.map((o) => o.orderId)).toEqual(['O3', 'O4', 'O5']);
    expect(r.customersNotYetDisputed).toBe(2);
    expect(r.proactiveRefundTotal).toBe(5800);
  });

  it('prices what the incident has cost in disputes so far', () => {
    const r = blastRadius(cluster, affected, { disputeFee: minor(1500), analystMinutesPerDispute: 45 });
    // 249 + 49 disputed, plus two 15-dollar fees
    expect(r.disputeCostSoFar).toBe(24900 + 4900 + 2 * 1500);
    expect(r.analystHoursSavedByBulkAccept).toBe(1.5);
  });

  it('never reports a prediction of future disputes', () => {
    const r = blastRadius(cluster, affected, { disputeFee: minor(1500), analystMinutesPerDispute: 45 });
    expect(JSON.stringify(r)).not.toMatch(/predict|likely|probab|percent/i);
  });
});
