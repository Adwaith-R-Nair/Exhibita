// Rovo agent and MCP tools. All GET: they read and explain, never change anything (D-06).

import { COPY_CHANGED_MESSAGE, evaluateIssue, UNTRUSTED_RECORD_MESSAGE, type IssueEvaluation } from '../lib/evaluate-issue';
import { userCanBrowse } from '../lib/permissions';

interface ActionPayload {
  issueKey?: string;
  context?: { jira?: { issueKey?: string } };
}

const issueKeyOf = (p: ActionPayload): string | null => p.issueKey?.trim().toUpperCase() || p.context?.jira?.issueKey || null;

/**
 * Evaluate only work items the asking user can see in Jira. The app itself can read every dispute, so
 * without this check an agent or MCP client could reveal disputes from projects the user cannot open
 * (review A3). A work item the user cannot see is reported exactly like one that does not exist.
 */
async function loadForUser(issueKey: string | null): Promise<IssueEvaluation | null> {
  if (!issueKey || !(await userCanBrowse(issueKey))) return null;
  return evaluateIssue(issueKey);
}

const notFound = (issueKey: string | null, loaded: IssueEvaluation | null) => ({
  error: !issueKey
    ? 'Tell me which dispute to look at, for example DSP-12.'
    : loaded
      ? `${loaded.issueKey}: ${UNTRUSTED_RECORD_MESSAGE[loaded.trust === 'unverified' ? 'unverified' : 'none']}`
      : `I can't find ${issueKey}, or you don't have access to it.`,
});

/** Exhibit letters as the panel shows them: A to Z, then AA, AB and so on. */
const letter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : letter(Math.floor(i / 26) - 1) + letter(i % 26));

/** Tell the agent when the work item's copy was edited, so it can say so instead of trusting that copy. */
const recordNote = (loaded: IssueEvaluation) => (loaded.trust === 'copy-changed' ? { recordWarning: COPY_CHANGED_MESSAGE } : {});

export async function getDisputeContext(payload: ActionPayload) {
  const issueKey = issueKeyOf(payload);
  const loaded = await loadForUser(issueKey);
  if (!loaded?.record) return notFound(issueKey, loaded);
  const { dispute, evidence } = loaded.record;
  return {
    issueKey,
    ...recordNote(loaded),
    dispute: { ...dispute, amount: `${(dispute.amount / 100).toFixed(2)} ${dispute.currency}` },
    reason: { label: loaded.evaluation.reasonLabel, code: loaded.evaluation.reasonCode },
    evidence: evidence.map((e, i) => ({
      exhibit: letter(i),
      type: e.type,
      state: e.state,
      kind: e.kind === 'inference' ? 'Inference' : 'Record',
      source: e.source,
      at: e.at,
      note: e.note,
    })),
    guidance: 'Cite each exhibit by letter and source key. Label inferences as Inference. Never give a win percentage.',
  };
}

export async function evaluateRubric(payload: ActionPayload) {
  const issueKey = issueKeyOf(payload);
  const loaded = await loadForUser(issueKey);
  if (!loaded?.record) return notFound(issueKey, loaded);
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
