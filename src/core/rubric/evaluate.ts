// Deterministic rubric evaluation and triage (D-01).
// Given a dispute and its evidence, decide for each requirement whether it is met, and
// recommend fight, accept or investigate. Reports coverage, never a win percentage (D-08).

import {
  minor,
  type CheckResult,
  type Coverage,
  type Dispute,
  type Evaluation,
  type EvidenceItem,
  type MinorUnits,
  type Reason,
  type Recommendation,
  type Requirement,
  type RubricContext,
  type StateMatch,
} from '../types';
import { findReason } from './reasons';
import { describeState } from './states';

export interface EvaluateOptions {
  /** Orders at or above this amount need a signed proof of delivery. Default $150. */
  signatureThreshold?: MinorUnits;
}

const DEFAULT_SIGNATURE_THRESHOLD = minor(15_000);

const matches = (e: EvidenceItem, sets: readonly StateMatch[] | undefined): boolean =>
  (sets ?? []).some((m) => m.type === e.type && m.states.includes(e.state));

/**
 * Types whose states are independent facets rather than mutually exclusive (review B3). A customer can
 * say "got it" and mention their bank in the same breath; only states a requirement lists in `opposes`
 * count against it.
 */
const FACET_TYPES: ReadonlySet<string> = new Set(['customer-message']);

const relevantTypes = (req: Requirement): Set<string> =>
  new Set([...req.accepts, ...(req.concedes ?? []), ...(req.opposes ?? [])].map((m) => m.type));

export function checkRequirement(req: Requirement, evidence: readonly EvidenceItem[], ctx: RubricContext): CheckResult {
  const required = typeof req.required === 'function' ? req.required(ctx) : req.required;
  const types = relevantTypes(req);
  const candidates = evidence.filter((e) => types.has(e.type));

  const conceding = candidates.filter((e) => matches(e, req.concedes));
  const satisfying = candidates.filter((e) => matches(e, req.accepts));
  const satisfiedTypes = new Set(satisfying.map((e) => e.type));
  // Listed opposition always counts. For exclusive types, any other state of the type counts too, but it
  // only contradicts within a type that also has satisfying evidence: for alternatives, "3-D Secure not
  // attempted" does not contradict a requirement met by CE3.0 history.
  const listed = candidates.filter((e) => matches(e, req.opposes));
  const implicit = candidates.filter(
    (e) => !FACET_TYPES.has(e.type) && !matches(e, req.accepts) && !matches(e, req.concedes) && !matches(e, req.opposes),
  );
  const opposing = [...listed, ...implicit];
  const contradicting = [...listed, ...implicit.filter((e) => satisfiedTypes.has(e.type))];

  let status: CheckResult['status'];
  let contradictions: EvidenceItem[];
  if (conceding.length > 0) {
    status = 'conceded';
    contradictions = [...conceding, ...opposing];
  } else if (satisfying.length > 0) {
    status = contradicting.length > 0 ? 'contradicted' : 'met';
    contradictions = contradicting;
  } else if (opposing.length > 0) {
    status = 'failed';
    contradictions = opposing;
  } else {
    status = 'missing';
    contradictions = [];
  }

  return {
    id: req.id,
    label: req.label,
    rule: req.rule,
    required,
    status,
    evidence: satisfying[0] ?? null,
    contradictions,
  };
}

function coverageOf(checks: readonly CheckResult[]): Coverage {
  const required = checks.filter((c) => c.required);
  const met = required.filter((c) => c.status === 'met').length;
  const total = required.length;
  let label: Coverage['label'];
  if (total === 0) label = 'Not assessed';
  else if (required.every((c) => c.status === 'missing')) label = 'Insufficient evidence';
  else if (met === total) label = 'Strong';
  else if (met / total >= 0.5) label = 'Partial';
  else label = 'Weak';
  return { met, total, label };
}

const cite = (e: EvidenceItem | undefined): string => (e ? ` (${e.source.key})` : '');

/** The fact that concedes a dispute, as the start of a sentence. */
function concession(e: EvidenceItem): string {
  switch (e.type) {
    case 'refund':
      return `Refund ${describeState(e.state)}`;
    case 'cancellation':
      return e.state === 'cancelled-before-charge' ? 'The customer cancelled before the charge' : `Cancellation: ${describeState(e.state)}`;
    case 'order-pair':
      return `This charge is ${describeState(e.state)}`;
    case 'incident':
      return `An incident is ${describeState(e.state)}`;
    default:
      return `${e.type.replaceAll('-', ' ').replace(/^./, (c) => c.toUpperCase())}: ${describeState(e.state)}`;
  }
}
const list = (checks: readonly CheckResult[]): string => checks.map((c) => c.label).join('; ');

export function triage(checks: readonly CheckResult[], reason: Reason): { recommendation: Recommendation; why: string } {
  // Accept beats fight: if the evidence says the customer is right, no amount of other evidence matters.
  const conceded = checks.find((c) => c.status === 'conceded');
  if (conceded) {
    const e = conceded.contradictions[0];
    const what = e ? `${concession(e)}${cite(e)}` : conceded.label;
    return {
      recommendation: 'accept',
      why: `${what}. The customer is right on this point, so fighting would only add the dispute fee.`,
    };
  }

  const required = checks.filter((c) => c.required);
  const unmet = required.filter((c) => c.status !== 'met');
  if (unmet.length === 0) {
    return { recommendation: 'fight', why: `All ${required.length} required items for ${reason.code} are backed by evidence.` };
  }
  if (unmet.length === required.length && unmet.every((c) => c.status === 'missing')) {
    return { recommendation: 'investigate', why: `Insufficient evidence: nothing found yet for ${list(unmet)}.` };
  }
  const conflicting = unmet.filter((c) => c.status === 'contradicted');
  if (conflicting.length > 0) {
    return { recommendation: 'investigate', why: `Evidence conflicts on: ${list(conflicting)}.` };
  }
  const against = unmet.filter((c) => c.status === 'failed');
  if (against.length > 0) {
    return { recommendation: 'investigate', why: `Evidence is against us on: ${list(against)}.` };
  }
  return { recommendation: 'investigate', why: `Still missing: ${list(unmet)}.` };
}

const NETWORK_NAMES: Record<'mastercard' | 'amex' | 'discover', string> = {
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
};

const day = (iso: string) => iso.slice(0, 10);

export const CREDIT_DEFENSE_LABEL = 'Credit issued before the dispute';

/**
 * A full credit, paid by the refund service before the dispute arrived and confirmed by the processor
 * (review B6). Returns the refund evidence and the processor's confirmation, or null.
 */
function creditBeforeDispute(dispute: Dispute, evidence: readonly EvidenceItem[]): { refund: EvidenceItem; settled: EvidenceItem } | null {
  for (const refund of evidence) {
    if (refund.type !== 'refund' || refund.state !== 'completed-before-dispute') continue;
    const refundId = refund.meta?.refundId;
    const amount = refund.meta?.amount;
    if (!refundId || amount === undefined || amount < dispute.amount) continue;
    const settled = evidence.find((e) => e.type === 'processor-refund' && e.state === 'settled' && e.meta?.refundId === refundId);
    if (settled) return { refund, settled };
  }
  return null;
}

function notSupported(why: string, reasonCode: string | null = null): Evaluation {
  return {
    supported: false,
    reasonKey: null,
    reasonCode,
    reasonLabel: null,
    checks: [],
    coverage: { met: 0, total: 0, label: 'Not assessed' },
    recommendation: 'investigate',
    why,
    canSubmit: false,
    blockers: [],
  };
}

export function evaluateDispute(
  dispute: Dispute,
  evidence: readonly EvidenceItem[],
  options: EvaluateOptions = {},
): Evaluation {
  // The rubrics are Visa rules. Other networks are not judged by them (review B9).
  const network = dispute.network ?? 'unknown';
  if (network === 'mastercard' || network === 'amex' || network === 'discover') {
    return notSupported(`${NETWORK_NAMES[network]} disputes are not supported yet; review by hand.`, dispute.networkReasonCode ?? null);
  }

  const reason = findReason(dispute.reasonCode);
  if (!reason) return notSupported('This reason is not covered yet, so a person should review it.');

  const ctx: RubricContext = {
    amount: dispute.amount,
    signatureThreshold: options.signatureThreshold ?? DEFAULT_SIGNATURE_THRESHOLD,
  };
  let checks = reason.requirements.map((req) => checkRequirement(req, evidence, ctx));
  let { recommendation, why } = triage(checks, reason);

  // A full credit settled before the dispute answers it on its own: the other items are no longer needed.
  // A concession still wins.
  const credit = reason.creditDefense && recommendation !== 'accept' ? creditBeforeDispute(dispute, evidence) : null;
  if (credit) {
    const defense: CheckResult = {
      id: 'credit-issued',
      label: CREDIT_DEFENSE_LABEL,
      rule: 'A full refund paid before the dispute, and confirmed by the processor, means the customer already has their money back. That answers the dispute on its own.',
      required: true,
      status: 'met',
      evidence: credit.refund,
      contradictions: [],
    };
    checks = [defense, ...checks.map((c) => (c.required && c.status !== 'met' ? { ...c, required: false } : c))];
    recommendation = 'fight';
    const chargeId = credit.settled.meta?.chargeId;
    why = `${CREDIT_DEFENSE_LABEL}: refund ${credit.refund.meta!.refundId} paid the full amount on ${day(credit.refund.at)}, and the processor confirms it${chargeId ? ` on charge ${chargeId}` : ''}.`;
  }

  const coverage = coverageOf(checks);
  const blockers = checks.filter((c) => c.required && c.status !== 'met').map((c) => c.label);
  const notes =
    network === 'visa'
      ? ['Judged against Visa dispute rules.']
      : ['The card network is unknown, so Visa dispute rules were applied. Check the network before submitting.'];

  return {
    supported: true,
    reasonKey: reason.key,
    reasonCode: reason.code,
    reasonLabel: reason.label,
    checks,
    coverage,
    recommendation,
    why,
    canSubmit: recommendation === 'fight' && blockers.length === 0,
    blockers,
    notes,
  };
}
