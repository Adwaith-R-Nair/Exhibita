// Rovo agent and MCP tools. All GET: they read and explain, never change anything (D-06).

import { COPY_CHANGED_MESSAGE, evaluateIssue, UNTRUSTED_RECORD_MESSAGE, type IssueEvaluation } from '../lib/evaluate-issue';

interface ActionPayload {
  issueKey?: string;
  context?: { jira?: { issueKey?: string } };
}

const issueKeyOf = (p: ActionPayload): string | null => p.issueKey?.trim().toUpperCase() || p.context?.jira?.issueKey || null;

const notFound = (loaded: IssueEvaluation | null) => ({
  error: loaded
    ? `${loaded.issueKey}: ${UNTRUSTED_RECORD_MESSAGE[loaded.trust === 'unverified' ? 'unverified' : 'none']}`
    : 'Tell me which dispute to look at, for example DSP-12.',
});

/** Tell the agent when the work item's copy was edited, so it can say so instead of trusting that copy. */
const recordNote = (loaded: IssueEvaluation) => (loaded.trust === 'copy-changed' ? { recordWarning: COPY_CHANGED_MESSAGE } : {});

export async function getDisputeContext(payload: ActionPayload) {
  const issueKey = issueKeyOf(payload);
  const loaded = issueKey ? await evaluateIssue(issueKey) : null;
  if (!loaded?.record) return notFound(loaded);
  const { dispute, evidence } = loaded.record;
  return {
    issueKey,
    ...recordNote(loaded),
    dispute: { ...dispute, amount: `${(dispute.amount / 100).toFixed(2)} ${dispute.currency}` },
    reason: { label: loaded.evaluation.reasonLabel, code: loaded.evaluation.reasonCode },
    evidence: evidence.map((e, i) => ({
      exhibit: String.fromCharCode(65 + i),
      type: e.type,
      state: e.state,
      kind: e.kind === 'inference' ? 'Inference' : 'Fact',
      source: e.source,
      at: e.at,
      note: e.note,
    })),
    guidance: 'Cite each exhibit by letter and source key. Label inferences as Inference. Never give a win percentage.',
  };
}

export async function evaluateRubric(payload: ActionPayload) {
  const issueKey = issueKeyOf(payload);
  const loaded = issueKey ? await evaluateIssue(issueKey) : null;
  if (!loaded?.record) return notFound(loaded);
  const e = loaded.evaluation;
  const v = loaded.verdict;
  return {
    issueKey,
    ...recordNote(loaded),
    recommendation: v.recommendation,
    why: v.why,
    checklistRecommendation: e.recommendation,
    changedByChallenge: v.changed,
    caseAgainst: loaded.challenge.findings.map((f) => ({ severity: f.severity, title: f.title, detail: f.detail, sources: f.evidence.map((x) => x.source.key) })),
    coverage: `${e.coverage.met} of ${e.coverage.total} required items met (${e.coverage.label})`,
    canSubmit: v.canSubmit,
    blockers: e.blockers,
    requirements: e.checks.map((c) => ({
      label: c.label,
      required: c.required,
      status: c.status,
      rule: c.rule,
      evidence: c.evidence?.source.key ?? null,
      against: c.contradictions.map((x) => `${x.type} ${x.state} (${x.source.key})`),
    })),
  };
}
