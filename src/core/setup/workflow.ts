// The Exhibita dispute workflow, as data for Jira's bulk workflow API (POST /rest/api/3/workflows/create).
// Verified by hand on the demo site (spike S8); the setup wizard builds the same thing through this.

export const DISPUTE_WORKFLOW_NAME = 'Exhibita dispute workflow';
export const SUBMIT_TRANSITION = 'Submit to network';

type Category = 'TODO' | 'IN_PROGRESS' | 'DONE';

export const DISPUTE_STATUSES: ReadonlyArray<{ ref: string; name: string; category: Category; description: string; x: number; y: number }> = [
  { ref: 'new', name: 'New', category: 'TODO', description: 'A dispute arrived from the processor and has not been worked yet.', x: 0, y: 0 },
  { ref: 'collect', name: 'Collecting evidence', category: 'IN_PROGRESS', description: 'Evidence is being gathered for the dispute.', x: 260, y: 0 },
  { ref: 'ready', name: 'Ready to submit', category: 'IN_PROGRESS', description: 'The defense is assembled and waiting to be sent to the card network.', x: 520, y: 0 },
  { ref: 'submitted', name: 'Submitted', category: 'IN_PROGRESS', description: 'The defense was sent; waiting for the network decision.', x: 780, y: 0 },
  { ref: 'won', name: 'Won', category: 'DONE', description: "The network decided in the merchant's favour.", x: 1040, y: -120 },
  { ref: 'lost', name: 'Lost', category: 'DONE', description: "The network decided in the cardholder's favour.", x: 1040, y: 120 },
  { ref: 'accepted', name: 'Accepted', category: 'DONE', description: 'The merchant accepted the dispute instead of fighting it.', x: 520, y: 240 },
];

type StatusRef = (typeof DISPUTE_STATUSES)[number]['ref'];

const TRANSITIONS: ReadonlyArray<{ name: string; from: StatusRef[]; to: StatusRef; description: string }> = [
  { name: 'Start collecting evidence', from: ['new'], to: 'collect', description: 'Begin gathering evidence.' },
  { name: 'Mark ready to submit', from: ['collect'], to: 'ready', description: 'The defense is assembled.' },
  { name: 'Back to collecting evidence', from: ['ready'], to: 'collect', description: 'More evidence is needed.' },
  { name: SUBMIT_TRANSITION, from: ['collect', 'ready'], to: 'submitted', description: 'Send the defense to the card network.' },
  { name: 'Accept dispute', from: ['new', 'collect', 'ready'], to: 'accepted', description: 'Accept the dispute instead of fighting it.' },
  { name: 'Record win', from: ['submitted'], to: 'won', description: 'The network decided for the merchant.' },
  { name: 'Record loss', from: ['submitted'], to: 'lost', description: 'The network decided for the cardholder.' },
];

/**
 * Jira stores a Forge validator as rule `forge:expression-validator` keyed by the module's extension ARI,
 * which includes the environment. Derived from the calling module's localId, which has the same shape
 * with a different module key at the end.
 */
export function validatorExtensionKey(localId: string, validatorModuleKey: string): string {
  const m = /^(ari:cloud:ecosystem::extension\/[^/]+\/[^/]+\/static\/)[^/]+$/.exec(localId);
  if (!m) throw new Error(`Cannot derive the validator key from ${localId}`);
  return `${m[1]}${validatorModuleKey}`;
}

export interface WorkflowCreateInput {
  /** Existing status ids by name; statuses not listed here are created. */
  existingStatusIds: Readonly<Record<string, string>>;
  validatorKey: string;
  /** Source of status reference UUIDs (crypto.randomUUID in production, a counter in tests). */
  uuid: () => string;
}

export function disputeWorkflowCreateBody({ existingStatusIds, validatorKey, uuid }: WorkflowCreateInput) {
  const refs = Object.fromEntries(DISPUTE_STATUSES.map((s) => [s.ref, uuid()])) as Record<StatusRef, string>;
  let nextId = 1;
  const transition = (t: (typeof TRANSITIONS)[number]) => ({
    id: String((nextId += 10)),
    name: t.name,
    description: t.description,
    type: 'DIRECTED' as const,
    toStatusReference: refs[t.to],
    links: t.from.map((f) => ({ fromStatusReference: refs[f], fromPort: 1, toPort: 3 })),
    actions: [],
    validators: t.name === SUBMIT_TRANSITION ? [{ ruleKey: 'forge:expression-validator', parameters: { key: validatorKey, config: '' } }] : [],
    triggers: [],
    properties: {},
  });
  return {
    scope: { type: 'GLOBAL' as const },
    statuses: DISPUTE_STATUSES.map((s) => ({
      statusReference: refs[s.ref],
      name: s.name,
      statusCategory: s.category,
      description: s.description,
      ...(existingStatusIds[s.name] ? { id: existingStatusIds[s.name] } : {}),
    })),
    workflows: [
      {
        name: DISPUTE_WORKFLOW_NAME,
        description: 'One card dispute from arrival to the network decision. Submit to network is gated by the Exhibita evidence check.',
        statuses: DISPUTE_STATUSES.map((s) => ({ statusReference: refs[s.ref], layout: { x: s.x, y: s.y }, properties: {} })),
        transitions: [
          { id: '1', name: 'Create', type: 'INITIAL' as const, toStatusReference: refs.new, links: [], actions: [], validators: [], triggers: [], properties: {} },
          ...TRANSITIONS.map(transition),
        ],
      },
    ],
  };
}

/** True when a workflow's transition already carries our validator (so setup doesn't add it twice). */
export function hasSubmitValidator(
  transitions: ReadonlyArray<{ name: string; validators?: ReadonlyArray<{ ruleKey: string; parameters?: Record<string, unknown> }> }>,
  validatorKey: string,
): boolean {
  const submit = transitions.find((t) => t.name === SUBMIT_TRANSITION);
  return !!submit?.validators?.some((v) => v.ruleKey === 'forge:expression-validator' && v.parameters?.key === validatorKey);
}
