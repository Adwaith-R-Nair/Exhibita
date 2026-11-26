// Backend for the issue panel: evaluates the dispute on the current work item, and re-collects evidence.

import Resolver from '@forge/resolver';
import { collectAndSave } from '../lib/collect';
import { getConfig } from '../lib/config';
import { evaluateIssue } from '../lib/evaluate-issue';
import { getIssueId } from '../lib/jira';
import { loadRecord } from '../lib/records';

type Ctx = { extension?: { issue?: { key?: string; id?: string | number } }; localId?: string };

/** The Exhibita page's address, from this module's extension id: .../extension/{app}/{env}/static/{module}. */
const pageUrlOf = (context: unknown): string | null => {
  const m = /extension\/([^/]+)\/([^/]+)\/static\//.exec((context as Ctx).localId ?? '');
  return m ? `/jira/apps/${m[1]}/${m[2]}` : null;
};

const issueOf = (context: unknown) => {
  const issue = (context as Ctx).extension?.issue;
  return { key: issue?.key, id: issue?.id !== undefined ? String(issue.id) : undefined };
};

async function view(issueKey: string, givenId?: string, pageUrl: string | null = null) {
  const issueId = givenId ?? (await getIssueId(issueKey)) ?? undefined;
  const loaded = await evaluateIssue(issueKey, issueId);
  if (loaded.trust === 'unverified') return { state: 'unverified' as const, issueKey };
  if (!loaded.record) return { state: 'not-a-dispute' as const, issueKey };
  return {
    state: 'ready' as const,
    issueKey,
    issueId: issueId ?? null,
    copyChanged: loaded.trust === 'copy-changed',
    dispute: loaded.record.dispute,
    evidence: loaded.record.evidence,
    collectedAt: loaded.record.collectedAt,
    evaluation: loaded.evaluation,
    findings: loaded.challenge.findings,
    verdict: loaded.verdict,
    // An incident explicitly linked as the cause: the panel points to the cluster it belongs to.
    linkedIncident:
      loaded.record.evidence.find((e) => e.type === 'incident' && e.state.startsWith('caused-'))?.source.key ??
      loaded.record.evidence.find((e) => e.meta?.linkedIncident)?.meta?.linkedIncident ??
      null,
    pageUrl,
  };
}

const resolver = new Resolver();

resolver.define('getEvaluation', async ({ context }) => {
  const { key, id } = issueOf(context);
  if (!key) return { state: 'no-issue' as const };
  return view(key, id, pageUrlOf(context));
});

/** Collect the evidence again from the sources. Only works on a record Exhibita itself stored. */
resolver.define('collectAgain', async ({ context }) => {
  const { key, id: givenId } = issueOf(context);
  if (!key) return { state: 'no-issue' as const };
  const id = givenId ?? (await getIssueId(key));
  if (!id) return { state: 'not-a-dispute' as const, issueKey: key };
  const loaded = await loadRecord(key, id);
  if (!loaded.record) return view(key, id, pageUrlOf(context));
  await collectAndSave({ id, key }, loaded.record, (await getConfig()).projectKey);
  return view(key, id, pageUrlOf(context));
});

export const panelHandler = resolver.getDefinitions();
