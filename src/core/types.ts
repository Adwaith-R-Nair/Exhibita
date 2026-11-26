// Domain types for Exhibita's deterministic core.
// Nothing in src/core may import from @forge/*: it runs in plain Node tests.

/** Money is always an integer count of minor units (cents), never a float. */
export type MinorUnits = number & { readonly __brand: 'MinorUnits' };

export const minor = (n: number): MinorUnits => {
  if (!Number.isInteger(n)) throw new RangeError(`Money must be whole minor units, got ${n}`);
  return n as MinorUnits;
};

export type Currency = 'USD' | 'EUR' | 'GBP' | 'INR' | (string & {});

/** Where an exhibit came from. Every evidence item must have one. */
export interface Source {
  kind: 'jira' | 'jsm' | 'confluence' | 'sql' | 'webhook' | 'teamwork-graph';
  /** Issue key, page id, table row id, etc. */
  key: string;
  title?: string;
  url?: string;
}

export type EvidenceType =
  | 'delivery'
  | 'delivery-signature'
  | 'customer-message'
  | 'refund'
  | 'policy'
  | 'product-description'
  | 'order-pair'
  | 'incident'
  | 'deploy'
  | '3ds'
  | 'avs'
  | 'cvv'
  | 'prior-orders'
  | 'cancellation'
  /** The processor's view of a refund: did the money actually reach the card? (reconciliation, review D1) */
  | 'processor-refund';

/**
 * fact: read directly from a system of record. Shown as "Record" (KIND_LABEL in rubric/states.ts), because
 * a record shows what a system says, not that it is true (review B13).
 * inference: derived by classification (for example, the customer-text lexicon). Shown with an Inference label.
 */
export type EvidenceKind = 'fact' | 'inference';

export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  /** The state this evidence is in. "initiated" and "completed" are different facts. */
  state: string;
  kind: EvidenceKind;
  source: Source;
  /** When the underlying fact was recorded (ISO 8601). */
  at: string;
  note?: string;
  /** Type-specific details the challenge rules read, for example a policy's effective dates. */
  meta?: EvidenceMeta;
}

export interface EvidenceMeta {
  /** Policy versions: when this version took effect and stopped applying (ISO 8601, null = still in force). */
  effectiveFrom?: string;
  effectiveTo?: string | null;
  version?: string;
  /** Incidents: the window during which the incident affected customers. */
  windowStart?: string;
  windowEnd?: string | null;
  /** Customer messages: the exact phrase a classifier label came from. */
  quote?: string;
  /** An explicit link (not a timing guess) to the incident or deploy behind this fact. */
  linkedIncident?: string;
  linkedDeploy?: string;
  /** Refunds and processor refunds: the refund this item is about, and its amount in minor units (review B6, D1). */
  refundId?: string;
  amount?: number;
  /** Processor refunds: the charge the processor's view was read from. */
  chargeId?: string;
  /** Policies: when the customer paid, so the policy-in-force check runs without webhook metadata (review B11). */
  purchasedAt?: string;
  /** Compelling Evidence 3.0: each criterion and whether it passed, so the UI can show a candidate versus a qualified case (review B8). */
  criteria?: EvidenceCriterion[];
}

export interface EvidenceCriterion {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export type ReasonKey = 'visa-13.1' | 'visa-13.3' | 'visa-12.6.1' | 'visa-10.4' | 'visa-13.2' | 'visa-13.6';

/** Card network. The rubrics are Visa rules; other networks are shown as not supported yet (review B9). */
export type CardNetwork = 'visa' | 'mastercard' | 'amex' | 'discover' | 'unknown';

export interface Dispute {
  externalId: string;
  chargeId: string | null;
  orderId: string | null;
  customer: string | null;
  amount: MinorUnits;
  currency: Currency;
  processorReason: string;
  /** Our reason key, or 'unknown' when the processor reason doesn't map to one. */
  reasonCode: ReasonKey | 'unknown' | (string & {});
  respondBy: string | null;
  receivedAt: string;
  /** When the customer paid. Decides which policy version applies. */
  purchasedAt?: string | null;
  /** Network of the disputed card, from the processor event. Missing means unknown. */
  network?: CardNetwork;
  /** The network's own reason code as the processor reports it (for example "13.6"), kept raw. */
  networkReasonCode?: string | null;
}

/** Context a requirement can use to decide whether it applies. */
export interface RubricContext {
  amount: MinorUnits;
  /** Orders at or above this need a signed proof of delivery. */
  signatureThreshold: MinorUnits;
}

/** A set of evidence states of one type. */
export interface StateMatch {
  type: EvidenceType;
  states: readonly string[];
}

export interface Requirement {
  id: string;
  label: string;
  /**
   * Evidence that satisfies the requirement. More than one entry means alternatives:
   * any one of them is enough (for example, 3-D Secure or Compelling Evidence 3.0 history).
   */
  accepts: readonly StateMatch[];
  /**
   * Evidence that means the customer is right and the dispute should be accepted,
   * for example a refund approved but never completed, or an incident that caused the charge.
   */
  concedes?: readonly StateMatch[];
  /**
   * Evidence that argues against the requirement (review B3). For customer messages, whose labels are
   * independent facets rather than exclusive states, only the states listed here count against it.
   * For other types, any state that neither satisfies nor concedes still counts against it.
   */
  opposes?: readonly StateMatch[];
  required: boolean | ((ctx: RubricContext) => boolean);
  /** Shown verbatim in the UI as "why is this required?". */
  rule: string;
}

export interface Reason {
  key: ReasonKey;
  /** Plain-English label, shown first. */
  label: string;
  /** Network code, shown small and grey. */
  code: string;
  aliases: readonly string[];
  /** Depth of coverage. Stubs are evaluated but flagged as limited in the UI. */
  depth: 'deep' | 'deep-lite' | 'stub';
  requirements: readonly Requirement[];
  /**
   * A full credit, issued and settled at the processor before the dispute arrived, answers the dispute on
   * its own: "Credit issued before the dispute" (review B6).
   */
  creditDefense?: boolean;
}

/**
 * met: satisfying evidence and nothing against it.
 * conceded: evidence says the customer is right.
 * contradicted: satisfying evidence, but other evidence of the same type disagrees.
 * failed: only non-satisfying evidence.
 * missing: no evidence of a relevant type.
 */
export type CheckStatus = 'met' | 'conceded' | 'contradicted' | 'failed' | 'missing';

export interface CheckResult {
  id: string;
  label: string;
  rule: string;
  required: boolean;
  status: CheckStatus;
  /** The evidence that satisfies it, if any. */
  evidence: EvidenceItem | null;
  /** Evidence that disagrees with the requirement, including any that concedes it. */
  contradictions: EvidenceItem[];
}

export type Recommendation = 'fight' | 'accept' | 'investigate';

export type StrengthLabel = 'Strong' | 'Partial' | 'Weak' | 'Insufficient evidence' | 'Not assessed';

export interface Coverage {
  met: number;
  total: number;
  label: StrengthLabel;
}

export interface Evaluation {
  supported: boolean;
  reasonKey: ReasonKey | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  checks: CheckResult[];
  coverage: Coverage;
  recommendation: Recommendation;
  /** One plain-English line explaining the recommendation, naming sources where it can. */
  why: string;
  /** True only when the recommendation is fight and every required item is met. */
  canSubmit: boolean;
  /** Labels of required items that are not met. */
  blockers: string[];
  /** Plain-English caveats, for example that the card network is unknown and Visa rules were applied (review B9). */
  notes?: string[];
}
