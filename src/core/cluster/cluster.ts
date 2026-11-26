// One incident, many disputes. Groups disputes by an explicit link to the incident behind them and
// measures the blast radius: who else was affected but hasn't disputed yet, and what it has cost.
// Clustering uses links only, never timing (AGENTS.md invariant 7).

import type { Currency, EvidenceItem, MinorUnits } from '../types';

export interface DisputeCase {
  issueKey: string;
  customer: string | null;
  amount: MinorUnits;
  currency: Currency;
  evidence: readonly EvidenceItem[];
}

export interface Cluster {
  incidentKey: string;
  deployKey: string | null;
  disputes: { issueKey: string; customer: string | null; amount: MinorUnits }[];
  totalAmount: MinorUnits;
  currency: Currency;
}

/** The incidents a dispute is explicitly linked to, with any deploy named on the same link. */
function linksOf(c: DisputeCase): Map<string, string | null> {
  const links = new Map<string, string | null>();
  for (const e of c.evidence) {
    if (e.type === 'incident' && e.state.startsWith('caused-')) {
      links.set(e.source.key, links.get(e.source.key) ?? e.meta?.linkedDeploy ?? null);
    }
    if (e.meta?.linkedIncident) {
      links.set(e.meta.linkedIncident, links.get(e.meta.linkedIncident) ?? e.meta.linkedDeploy ?? null);
    }
  }
  return links;
}

export function clusterDisputes(cases: readonly DisputeCase[], options: { minSize?: number } = {}): Cluster[] {
  const minSize = options.minSize ?? 2;
  const byIncident = new Map<string, { deployKey: string | null; cases: DisputeCase[] }>();
  for (const c of cases) {
    for (const [incidentKey, deployKey] of linksOf(c)) {
      const entry = byIncident.get(incidentKey) ?? { deployKey: null, cases: [] };
      entry.deployKey ??= deployKey;
      entry.cases.push(c);
      byIncident.set(incidentKey, entry);
    }
  }

  const clusters: Cluster[] = [];
  for (const [incidentKey, { deployKey, cases: members }] of byIncident) {
    if (members.length < minSize) continue;
    const sorted = [...members].sort((a, b) => a.issueKey.localeCompare(b.issueKey, 'en', { numeric: true }));
    clusters.push({
      incidentKey,
      deployKey,
      disputes: sorted.map((c) => ({ issueKey: c.issueKey, customer: c.customer, amount: c.amount })),
      totalAmount: sorted.reduce((sum, c) => sum + c.amount, 0) as MinorUnits,
      currency: sorted[0]!.currency,
    });
  }
  return clusters.sort((a, b) => b.totalAmount - a.totalAmount || a.incidentKey.localeCompare(b.incidentKey));
}

export interface AffectedOrder {
  orderId: string;
  customer: string;
  amount: MinorUnits;
}

export interface BlastRadiusOptions {
  /** What the processor charges per dispute, per your agreement. */
  disputeFee: MinorUnits;
  /** Analyst time to work one dispute by hand; an assumption the admin can change. */
  analystMinutesPerDispute: number;
}

export interface BlastRadius {
  incidentKey: string;
  deployKey: string | null;
  disputesSoFar: number;
  /** Disputed amounts plus a fee per dispute. */
  disputeCostSoFar: MinorUnits;
  /** Affected orders whose customer has not disputed. */
  notYetDisputed: AffectedOrder[];
  customersNotYetDisputed: number;
  /** What refunding every not-yet-disputed order now would cost. */
  proactiveRefundTotal: MinorUnits;
  analystHoursSavedByBulkAccept: number;
}

export function blastRadius(cluster: Cluster, affected: readonly AffectedOrder[], options: BlastRadiusOptions): BlastRadius {
  const disputing = new Set(cluster.disputes.map((d) => d.customer).filter((c): c is string => c !== null));
  const notYetDisputed = affected.filter((o) => !disputing.has(o.customer));
  const sum = (xs: readonly { amount: MinorUnits }[]) => xs.reduce((s, x) => s + x.amount, 0) as MinorUnits;
  return {
    incidentKey: cluster.incidentKey,
    deployKey: cluster.deployKey,
    disputesSoFar: cluster.disputes.length,
    disputeCostSoFar: (cluster.totalAmount + cluster.disputes.length * options.disputeFee) as MinorUnits,
    notYetDisputed,
    customersNotYetDisputed: new Set(notYetDisputed.map((o) => o.customer)).size,
    proactiveRefundTotal: sum(notYetDisputed),
    analystHoursSavedByBulkAccept: Math.round(((cluster.disputes.length * options.analystMinutesPerDispute) / 60) * 10) / 10,
  };
}
