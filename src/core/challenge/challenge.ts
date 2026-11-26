// "Challenge this": a deterministic red team that looks for reasons our own case is weaker than the
// rubric alone suggests. It never invents evidence and never claims causation without a link.

import { describeState } from '../rubric/states';
import type { Dispute, Evaluation, EvidenceItem, Recommendation } from '../types';

export type ChallengeRule =
  | 'refund-not-settled'
  | 'refund-outstanding'
  | 'incident-linked'
  | 'customer-contradicts'
  | 'delivery-mismatch'
  | 'evidence-after-dispute'
  | 'policy-not-in-force'
  | 'incident-overlap-unlinked';

/**
 * decisive: the customer is right on this point (the rubric concedes it too).
 * weakens: a fight is no longer safe without a person looking.
 * note: worth knowing, changes nothing.
 */
export type Severity = 'decisive' | 'weakens' | 'note';

export interface Finding {
  rule: ChallengeRule;
  severity: Severity;
  title: string;
  detail: string;
  evidence: EvidenceItem[];
}

export interface SupportItem {
  label: string;
  evidence: EvidenceItem;
}

export interface ChallengeResult {
  /** The case against us, most serious first. */
  findings: Finding[];
  /** The case for us: requirements met, each with the evidence that meets it. */
  support: SupportItem[];
  recommendation: Recommendation;
  why: string;
  /** True when the challenge changed the rubric's recommendation. */
  changed: boolean;
}

const SEVERITY_ORDER: Record<Severity, number> = { decisive: 0, weakens: 1, note: 2 };

/** Customer-message states that contradict the merchant, by reason. Default covers unknown reasons. */
const CONTRADICTING_MESSAGES: Record<string, readonly string[]> = {
  'visa-13.1': ['denied-receipt'],
  'visa-13.3': ['complained', 'requested-refund'],
  'visa-12.6.1': [],
  'visa-10.4': [],
  'visa-13.2': ['requested-refund', 'cancelled'],
  'visa-13.6': ['refund-not-received'],
  default: ['denied-receipt', 'complained', 'requested-refund'],
};

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
const day = (iso: string) => iso.slice(0, 10);
const keys = (items: readonly EvidenceItem[]) => items.map((e) => e.source.key).join(', ');

type Rule = (d: Dispute, evidence: readonly EvidenceItem[], evaluation: Evaluation) => Finding[];

const OUTSTANDING: Record<string, { severity: Severity; title: string; detail: string }> = {
  'approved-not-completed': {
    severity: 'decisive',
    title: 'A refund was approved but never paid',
    detail: 'The customer was promised their money and never got it, so they are right to dispute.',
  },
  'partial-approved-not-completed': {
    severity: 'weakens',
    title: 'Part of the amount is still owed as a refund',
    detail: 'The customer is owed part of what they disputed. A person should decide whether to refund that part and fight the rest.',
  },
  initiated: {
    severity: 'weakens',
    title: 'A refund is in progress',
    detail: 'If it completes, fighting would risk refunding twice.',
  },
};

const refundOutstanding: Rule = (_d, evidence) =>
  evidence
    .filter((e) => e.type === 'refund' && OUTSTANDING[e.state])
    .map((e) => {
      const o = OUTSTANDING[e.state]!;
      return {
        rule: 'refund-outstanding',
        severity: o.severity,
        title: o.title,
        detail: `Refund ${describeState(e.state)} (${e.source.key}). ${o.detail}`,
        evidence: [e],
      };
    });

/**
 * Reconciliation (review D1): the refund service says a refund was sent, but the processor shows no such
 * refund on the charge. Decisive when the missing money covers the disputed amount; otherwise it only
 * weakens the case. Names the incident and deploy only when they are explicitly linked to the refund.
 */
const refundNotSettled: Rule = (d, evidence) =>
  evidence
    .filter((e) => e.type === 'processor-refund' && e.state === 'not-settled')
    .map((e) => {
      const refundId = e.meta?.refundId ?? 'the refund';
      const chargeId = e.meta?.chargeId ?? e.source.key;
      const full = (e.meta?.amount ?? 0) >= d.amount;
      const incidentKey = e.meta?.linkedIncident;
      const incident = incidentKey ? evidence.find((x) => x.type === 'incident' && x.source.key === incidentKey) : undefined;
      const cause = incidentKey
        ? ` ${incidentKey}${incident?.source.title ? ` (${incident.source.title})` : ''} is explicitly linked to this refund${
            e.meta?.linkedDeploy ? `, and was caused by ${e.meta.linkedDeploy}` : ''
          }.`
        : '';
      return {
        rule: 'refund-not-settled' as const,
        severity: full ? ('decisive' as const) : ('weakens' as const),
        title: 'The refund never reached the card',
        detail: `The refund service marked ${refundId} as sent, but the processor shows no refund on the charge ${chargeId}.${cause}${
          full ? ' The customer never got their money back.' : ' The missing refund is less than the disputed amount, so a person should decide.'
        }`,
        evidence: [e, ...(incident ? [incident] : [])],
      };
    });

const incidentLinked: Rule = (_d, evidence) =>
  evidence
    .filter((e) => e.type === 'incident' && e.state.startsWith('caused-'))
    .map((e) => ({
      rule: 'incident-linked',
      severity: 'decisive',
      title:
        e.state === 'caused-dropped-refund'
          ? "A linked incident dropped this customer's refund"
          : e.state === 'caused-duplicate-charge'
            ? 'A linked incident caused duplicate charges'
            : 'A linked incident caused this problem',
      detail: `${e.source.key}${e.source.title ? ` (${e.source.title})` : ''} is ${describeState(e.state)}, recorded by an explicit link to this order.`,
      evidence: [e],
    }));

const customerContradicts: Rule = (d, evidence) => {
  const states = CONTRADICTING_MESSAGES[d.reasonCode] ?? CONTRADICTING_MESSAGES.default!;
  const against = evidence.filter((e) => e.type === 'customer-message' && states.includes(e.state));
  if (against.length === 0) return [];
  const quotes = against.map((e) => (e.meta?.quote ? `"${e.meta.quote}" (${e.source.key})` : `${describeState(e.state)} (${e.source.key})`));
  return [
    {
      rule: 'customer-contradicts',
      severity: 'weakens',
      title: 'The customer said otherwise',
      detail: `Customer messages point the other way: ${quotes.join('; ')}. These are inferences from the customer's own words.`,
      evidence: against,
    },
  ];
};

const deliveryMismatch: Rule = (_d, evidence) => {
  const bad = evidence.filter(
    (e) =>
      (e.type === 'delivery' && e.state === 'delivered-address-mismatch') ||
      (e.type === 'delivery-signature' && e.state === 'signature-name-mismatch'),
  );
  if (bad.length === 0) return [];
  return [
    {
      rule: 'delivery-mismatch',
      severity: 'weakens',
      title: 'Proof of delivery does not match the customer',
      detail: bad.map((e) => `${describeState(e.state)} (${e.source.key})`).join('; ') + '.',
      evidence: bad,
    },
  ];
};

const evidenceAfterDispute: Rule = (d, _evidence, evaluation) => {
  const received = ms(d.receivedAt);
  if (received === null) return [];
  const late = evaluation.checks
    .map((c) => c.evidence)
    .filter((e): e is EvidenceItem => e !== null && (ms(e.at) ?? 0) > received);
  if (late.length === 0) return [];
  return [
    {
      rule: 'evidence-after-dispute',
      severity: 'weakens',
      title: 'Some supporting evidence is dated after the dispute',
      detail: `${keys(late)} ${late.length === 1 ? 'was' : 'were'} recorded after the dispute arrived on ${day(d.receivedAt)}. Issuers often discount evidence created after the fact.`,
      evidence: late,
    },
  ];
};

const policyNotInForce: Rule = (d, evidence) => {
  const policies = evidence.filter((e) => e.type === 'policy');
  if (policies.length === 0) return [];
  // The webhook's purchase date, or the order's, carried on the policy evidence (review B11).
  const purchasedIso = d.purchasedAt ?? policies.find((e) => e.meta?.purchasedAt)?.meta?.purchasedAt ?? null;
  const purchased = ms(purchasedIso);
  if (purchased === null) {
    return [
      {
        rule: 'policy-not-in-force',
        severity: 'note',
        title: 'Purchase date unknown',
        detail: `Without a purchase date we can't confirm ${keys(policies)} was the version in force when the customer paid.`,
        evidence: policies,
      },
    ];
  }
  return policies
    .filter((e) => {
      const from = ms(e.meta?.effectiveFrom);
      const to = ms(e.meta?.effectiveTo ?? null);
      return (from !== null && from > purchased) || (to !== null && to <= purchased);
    })
    .map((e) => ({
      rule: 'policy-not-in-force' as const,
      severity: 'weakens' as const,
      title: 'The cited policy was not in force at purchase',
      detail: `${e.source.key}${e.meta?.version ? ` (${e.meta.version})` : ''} applied from ${day(e.meta?.effectiveFrom ?? '')}${
        e.meta?.effectiveTo ? ` to ${day(e.meta.effectiveTo)}` : ''
      }, but the customer paid on ${day(purchasedIso!)}. Only the version in force on the purchase date counts.`,
      evidence: [e],
    }));
};

const incidentOverlapUnlinked: Rule = (d, evidence) => {
  const from = ms(d.purchasedAt) ?? ms(d.receivedAt);
  const to = ms(d.receivedAt);
  if (from === null || to === null) return [];
  return evidence
    .filter((e) => e.type === 'incident' && e.state === 'unrelated' && e.meta?.windowStart)
    .filter((e) => {
      const start = ms(e.meta!.windowStart)!;
      const end = ms(e.meta!.windowEnd ?? null) ?? Number.POSITIVE_INFINITY;
      return start <= to && end >= from;
    })
    .map((e) => ({
      rule: 'incident-overlap-unlinked' as const,
      severity: 'note' as const,
      title: 'An incident overlapped, but is not linked',
      detail: `${e.source.key} was open around the same time, but it is not linked to this order or charge, so Exhibita makes no causal claim.`,
      evidence: [e],
    }));
};

const RULES: readonly Rule[] = [
  refundNotSettled,
  refundOutstanding,
  incidentLinked,
  customerContradicts,
  deliveryMismatch,
  evidenceAfterDispute,
  policyNotInForce,
  incidentOverlapUnlinked,
];

export function challengeDispute(dispute: Dispute, evidence: readonly EvidenceItem[], evaluation: Evaluation): ChallengeResult {
  const findings = RULES.flatMap((rule) => rule(dispute, evidence, evaluation)).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const support = evaluation.checks
    .filter((c) => c.status === 'met' && c.evidence)
    .map((c) => ({ label: c.label, evidence: c.evidence! }));

  let recommendation = evaluation.recommendation;
  let why = evaluation.why;
  const decisive = findings.find((f) => f.severity === 'decisive');
  const weakening = findings.filter((f) => f.severity === 'weakens');
  if (decisive && recommendation !== 'accept') {
    recommendation = 'accept';
    why = `${decisive.detail} The customer is right on this point.`;
  } else if (recommendation === 'fight' && weakening.length > 0) {
    recommendation = 'investigate';
    why = `Challenge found ${weakening.length === 1 ? 'a problem' : `${weakening.length} problems`}: ${weakening.map((f) => f.title.toLowerCase()).join('; ')}.`;
  }

  return { findings, support, recommendation, why, changed: recommendation !== evaluation.recommendation };
}
