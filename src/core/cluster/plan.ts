// What a confirmed "accept this cluster" does, decided in tested code before anything changes (D-06,
// D-17). Accepting the chargebacks settles each disputed amount, so every stuck refund for those payments
// must be cancelled at the same time: otherwise fixing and replaying the refund worker pays the customer
// a second time. Customers who have not disputed are refunded proactively instead.

import type { EvidenceItem } from '../types';
import type { AffectedOrder, BlastRadius, Cluster, DisputeCase, Money } from './cluster';

/** Refund evidence that means money is still owed to the customer because of the incident. */
const OWED_REFUND = new Set(['approved-not-completed', 'partial-approved-not-completed', 'initiated', 'requested']);

export interface PlannedAccept {
  issueKey: string;
  orderId: string | null;
  amount: Money['amount'];
  currency: Money['currency'];
  /** Stuck refunds on this payment that accepting must cancel. */
  refundIds: string[];
  /** Posted on the work item when it is accepted. */
  comment: string;
}

export interface ClusterPlan {
  incidentKey: string;
  deployKey: string | null;
  accept: PlannedAccept[];
  voidRefunds: { refundId: string; issueKey: string }[];
  proactive: AffectedOrder[];
  costBug: { summary: string; description: string };
}

export function formatMoney(money: Money | readonly Money[]): string {
  const list = Array.isArray(money) ? money : [money as Money];
  if (list.length === 0) return '$0.00';
  return list.map((m) => (m.amount / 100).toLocaleString('en-US', { style: 'currency', currency: m.currency })).join(' + ');
}

/** Refunds this dispute's evidence shows as stuck because of this incident. */
function stuckRefunds(evidence: readonly EvidenceItem[], incidentKey: string): string[] {
  const ids = evidence
    .filter((e) => e.meta?.refundId && e.meta.linkedIncident === incidentKey)
    .filter((e) => (e.type === 'refund' && OWED_REFUND.has(e.state)) || (e.type === 'processor-refund' && e.state === 'not-settled'))
    .map((e) => e.meta!.refundId!);
  return [...new Set(ids)];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function planClusterActions(
  cluster: Cluster,
  cases: readonly DisputeCase[],
  blast: BlastRadius,
  labels: { incidentTitle?: string; deployTitle?: string },
): ClusterPlan {
  const byKey = new Map(cases.map((c) => [c.issueKey, c]));
  const accept: PlannedAccept[] = cluster.disputes.map((d) => {
    const refundIds = stuckRefunds(byKey.get(d.issueKey)?.evidence ?? [], cluster.incidentKey);
    const refunds = refundIds.length > 0 ? refundIds.join(', ') : null;
    return {
      issueKey: d.issueKey,
      orderId: d.orderId,
      amount: d.amount,
      currency: d.currency,
      refundIds,
      comment: [
        `Accepted with the ${cluster.incidentKey} cluster${labels.incidentTitle ? ` (${labels.incidentTitle})` : ''}.`,
        refunds
          ? `Refund ${refunds} was recorded but the money never reached the card. It has been cancelled, so the customer is not paid twice when stuck refunds are replayed.`
          : 'No stuck refund was found for this payment.',
      ].join(' '),
    };
  });
  const voidRefunds = accept.flatMap((a) => a.refundIds.map((refundId) => ({ refundId, issueKey: a.issueKey })));

  const culprit = cluster.deployKey ?? cluster.incidentKey;
  const description = [
    `${culprit}${labels.deployTitle && cluster.deployKey ? ` (${labels.deployTitle})` : ''} is linked as the cause of ${cluster.incidentKey}${labels.incidentTitle ? ` (${labels.incidentTitle})` : ''}.`,
    '',
    `Cost so far: ${plural(blast.disputesSoFar, 'dispute', 'disputes')}, ${formatMoney(cluster.totals)} disputed, ${formatMoney(blast.disputeCostSoFar)} including dispute fees.`,
    `Still exposed: ${plural(blast.customersNotYetDisputed, 'customer has', 'customers have')} not disputed yet, owed ${formatMoney(blast.proactiveRefundTotals)} in refunds.`,
    `Analyst time: about ${blast.analystHoursSavedByBulkAccept} hours of manual dispute work.`,
    '',
    'Causation comes from explicit links (incident impact records and Jira links), not from timing.',
  ].join('\n');

  return {
    incidentKey: cluster.incidentKey,
    deployKey: cluster.deployKey,
    accept,
    voidRefunds,
    proactive: blast.notYetDisputed,
    costBug: { summary: `${culprit} has cost ${formatMoney(blast.disputeCostSoFar)} in disputes so far`, description },
  };
}
