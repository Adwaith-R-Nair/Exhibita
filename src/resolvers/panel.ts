// Backend for the issue panel: evaluates the dispute on the current work item.

import Resolver from '@forge/resolver';
import { evaluateIssue } from '../lib/evaluate-issue';

const resolver = new Resolver();

resolver.define('getEvaluation', async ({ context }) => {
  const issue = (context.extension as { issue?: { key?: string; id?: string | number } } | undefined)?.issue;
  const issueKey = issue?.key;
  if (!issueKey) return { state: 'no-issue' as const };
  const loaded = await evaluateIssue(issueKey, issue?.id !== undefined ? String(issue.id) : undefined);
  if (loaded.trust === 'unverified') return { state: 'unverified' as const, issueKey };
  if (!loaded.record) return { state: 'not-a-dispute' as const, issueKey };
  return {
    state: 'ready' as const,
    issueKey,
    copyChanged: loaded.trust === 'copy-changed',
    dispute: loaded.record.dispute,
    evidence: loaded.record.evidence,
    evaluation: loaded.evaluation,
  };
});

export const panelHandler = resolver.getDefinitions();
