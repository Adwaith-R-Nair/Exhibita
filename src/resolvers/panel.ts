// Backend for the issue panel: evaluates the dispute on the current work item.

import Resolver from '@forge/resolver';
import { evaluateIssue } from '../lib/evaluate-issue.js';

const resolver = new Resolver();

resolver.define('getEvaluation', async ({ context }) => {
  const issueKey = (context.extension as { issue?: { key?: string } } | undefined)?.issue?.key;
  if (!issueKey) return { state: 'no-issue' as const };
  const loaded = await evaluateIssue(issueKey);
  if (!loaded) return { state: 'not-a-dispute' as const, issueKey };
  return {
    state: 'ready' as const,
    issueKey,
    dispute: loaded.record.dispute,
    evidence: loaded.record.evidence,
    evaluation: loaded.evaluation,
  };
});

export const panelHandler = resolver.getDefinitions();
