// One incident, many disputes. Groups disputes by an explicit link to the incident behind them and
// measures the blast radius: who else was affected but hasn't disputed yet, and what it has cost.
// Clustering uses links only, never timing (AGENTS.md invariant 7), and only while the harm is still
// there: a dropped refund that was later paid and settled leaves the cluster (review B5).
// Money in different currencies is never added together (review B12).

import type { Currency, EvidenceItem, MinorUnits } from '../types';

export interface DisputeCase {
  issueKey: string;
  /** The disputed order. The blast radius de-duplicates by order, not by customer (review B12). */
  orderId: string | null;
  customer: string | null;
  amount: MinorUnits;
  currency: Currency;
  evidence: readonly EvidenceItem[];
}

export interface Money {
  currency: Currency;
  amount: MinorUnits;
}

export interface Cluster {
  incidentKey: string;
  deployKey: string | null;
  disputes: { issueKey: string; orderId: string | null; customer: string | null; amount: MinorUnits; currency: Currency }[];
  /** Disputed amounts, one total per currency, sorted by currency code. */
  totals: Money[];
}

/** Refund states that mean money is still owed because of the incident. */
const STILL_OWED = new Set(['approved-not-completed', 'partial-approved-not-completed', 'initiated', 'requested']);

/** Whether an exhibit carrying an incident link still shows harm from it. */
function stillHarmed(e: EvidenceItem): boolean {
  if (e.type === 'refund') return STILL_OWED.has(e.state);
  if (e.type === 'processor-refund') return e.state === 'not-settled';
  return true;
}

/** The incidents a dispute is explicitly linked to, with any deploy named on the same link. */
function linksOf(c: DisputeCase): Map<string, string | null> {
  const links = new Map<string, string | null>();
  for (const e of c.evidence) {
    if (e.type === 'incident' && e.state.startsWith('caused-')) {
      links.set(e.source.key, links.get(e.source.key) ?? e.meta?.linkedDeploy ?? null);
    }
    if (e.meta?.linkedIncident && stillHarmed(e)) {
      links.set(e.meta.linkedIncident, links.get(e.meta.linkedIncident) ?? e.meta.linkedDeploy ?? null);
    }
  }
  return links;
}

/** One total per currency, sorted by currency code. */
export function totalsByCurrency(items: readonly { amount: MinorUnits; currency: Currency }[]): Money[] {
  const sums = new Map<string, number>();
  for (const x of items) sums.set(x.currency, (sums.get(x.currency) ?? 0) + x.amount);
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, amount]) => ({ currency, amount: amount as MinorUnits }));
}

/** A single total when the cluster is in one currency, for sorting; null when currencies are mixed. */
const singleTotal = (c: Cluster): Money | null => (c.totals.length === 1 ? c.totals[0]! : null);

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
      disputes: sorted.map((c) => ({ issueKey: c.issueKey, orderId: c.orderId, customer: c.customer, amount: c.amount, currency: c.currency })),
      totals: totalsByCurrency(sorted),
    });
  }
  // Largest first: by money when both clusters are in the same single currency, otherwise by count.
  return clusters.sort((a, b) => {
    const ta = singleTotal(a);
    const tb = singleTotal(b);
    if (ta && tb && ta.currency === tb.currency && ta.amount !== tb.amount) return tb.amount - ta.amount;
    return b.disputes.length - a.disputes.length || a.incidentKey.localeCompare(b.incidentKey);
  });
}

export interface AffectedOrder {
  orderId: string;
  customer: string;
  amount: MinorUnits;
  currency: Currency;
}

export interface BlastRadiusOptions {
  /** What the processor charges per dispute, per your agreement. */
  disputeFee: MinorUnits;
  /** Currency of the dispute fee. Default: USD. */
  feeCurrency?: Currency;
  /** Analyst time to work one dispute by hand; an assumption the admin can change. */
  analystMinutesPerDispute: number;
}

export interface BlastRadius {
  incidentKey: string;
  deployKey: string | null;
  disputesSoFar: number;
  /** Disputed amounts plus a fee per dispute, one total per currency. */
  disputeCostSoFar: Money[];
  /** Affected orders that have not been disputed. */
  notYetDisputed: AffectedOrder[];
  customersNotYetDisputed: number;
  /** What refunding every not-yet-disputed order now would cost, one total per currency. */
  proactiveRefundTotals: Money[];
  analystHoursSavedByBulkAccept: number;
}

export function blastRadius(cluster: Cluster, affected: readonly AffectedOrder[], options: BlastRadiusOptions): BlastRadius {
  const disputedOrders = new Set(cluster.disputes.map((d) => d.orderId).filter((o): o is string => o !== null));
  const notYetDisputed = affected.filter((o) => !disputedOrders.has(o.orderId));
  const fees = { currency: options.feeCurrency ?? 'USD', amount: (cluster.disputes.length * options.disputeFee) as MinorUnits };
  return {
    incidentKey: cluster.incidentKey,
    deployKey: cluster.deployKey,
    disputesSoFar: cluster.disputes.length,
    disputeCostSoFar: totalsByCurrency([...cluster.disputes, fees]),
    notYetDisputed,
    customersNotYetDisputed: new Set(notYetDisputed.map((o) => o.customer)).size,
    proactiveRefundTotals: totalsByCurrency(notYetDisputed),
    analystHoursSavedByBulkAccept: Math.round(((cluster.disputes.length * options.analystMinutesPerDispute) / 60) * 10) / 10,
  };
}
