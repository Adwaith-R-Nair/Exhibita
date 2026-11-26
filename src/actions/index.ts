// Rovo agent and MCP tools. All GET: they read and explain, never change anything (D-06).

import { evaluateIssue } from '../lib/evaluate-issue.js';

interface ActionPayload {
  issueKey?: string;
  context?: { jira?: { issueKey?: string } };
}

const issueKeyOf = (p: ActionPayload): string | null => p.issueKey?.trim().toUpperCase() || p.context?.jira?.issueKey || null;

const notFound = (issueKey: string | null) => ({
  error: issueKey ? `${issueKey} has no Exhibita dispute record.` : 'Tell me which dispute to look at, for example DSP-12.',
});

export async function getDisputeContext(payload: ActionPayload) {
  const issueKey = issueKeyOf(payload);
  const loaded = issueKey ? await evaluateIssue(issueKey) : null;
  if (!loaded) return notFound(issueKey);
  const { dispute, evidence } = loaded.record;
  return {
    issueKey,
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
  if (!loaded) return notFound(issueKey);
  const e = loaded.evaluation;
  return {
    issueKey,
    recommendation: e.recommendation,
    why: e.why,
    coverage: `${e.coverage.met} of ${e.coverage.total} required items met (${e.coverage.label})`,
    canSubmit: e.canSubmit,
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
