// "Remove demo data" (D-05, D-13). Undoes only what the setup wizard recorded creating, one bounded step
// per call. It never selects by anything a user can edit, such as a label (review C):
// - demo disputes are found through the app's own dispute ledger, by the demo world's dispute ids;
// - SQL rows are deleted by the demo world's own ids, never by emptying tables;
// - projects and the Confluence space are removed only if setup created them.
// Demo projects setup created are deleted outright, so their keys are free for the next set-up.

import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { generateWorld } from '../core/demo';
import { normalizeDisputeEvent } from '../core/intake/normalize';
import type { DisputeRecord } from '../core/record';
import { clearSources } from './collect-input';
import { getConfig } from './config';
import { DEMO_LABEL } from './demo-label';
import { getIssueId } from './jira';
import { readStoredRecord } from './records';
import { trashSpace } from './confluence';
import { JiraError } from './jira';
import { deleteDemoProject } from './jira-setup';
import { clearSeedState, getSeedState, type SeedState } from './seed';
import { clearLegacyDemoTables, deleteDemoRows, forgetDisputes, ledgerIssues } from './store';

const DELETES_PER_CALL = 20;
const SWEEP_CURSOR_KEY = 'demo:remove-cursor';

export interface RemoveProgress {
  status: 'idle' | 'running' | 'done';
  message: string;
}

/** Run one bounded piece of the removal. Call until status is done. */
export async function removeDemoStep(): Promise<RemoveProgress> {
  const state = await getSeedState();
  if (!state) return { status: 'idle', message: 'No demo data was set up from this app.' };
  if (state.status === 'running' && state.lockedUntil && state.lockedUntil > Date.now()) {
    return { status: 'idle', message: 'Demo setup is still running. Wait for it to finish or fail, then remove.' };
  }
  // Runs from before the dispute ledger (review round 1) recorded no setup-time project key and their
  // world came from an older generator, so they are removed by the legacy path below.
  if (!state.disputesKey) return removeLegacyStep(state);
  const disputesKey = state.disputesKey;
  const world = generateWorld({ seed: state.seed, now: state.now });
  const demoIds = world.disputes.flatMap((d) => {
    const n = normalizeDisputeEvent(d.payload);
    return n.ok ? [n.dispute.externalId] : [];
  });
  const demoIdSet = new Set(demoIds);

  // 1. Demo disputes in a disputes project that existed before setup are deleted one by one, found
  //    through the ledger. If setup created the project, the whole project goes to the trash below.
  if (!state.createdProjects.includes(disputesKey)) {
    const batch = (await ledgerIssues(demoIds)).slice(0, DELETES_PER_CALL);
    for (const item of batch) {
      const res = await api.asUser().requestJira(route`/rest/api/3/issue/${item.issueKey}?deleteSubtasks=true`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new JiraError(`Deleting ${item.issueKey}`, res.status, await res.text());
    }
    if (batch.length > 0) {
      await forgetDisputes(batch.map((b) => b.externalId));
      return { status: 'running', message: `Deleted ${batch.length} demo disputes` };
    }
  }

  // 2. Stored records live in app storage, not in Jira, so sweep them page by page by dispute id.
  const cursor = await kvs.get<string>(SWEEP_CURSOR_KEY);
  let query = kvs.query().where('key', WhereConditions.beginsWith('record:')).limit(DELETES_PER_CALL);
  if (cursor) query = query.cursor(cursor);
  const page = await query.getMany<DisputeRecord>();
  for (const r of page.results) if (demoIdSet.has(r.value?.dispute?.externalId)) await kvs.delete(r.key);
  if (page.nextCursor) {
    await kvs.set(SWEEP_CURSOR_KEY, page.nextCursor);
    return { status: 'running', message: 'Removing stored demo records' };
  }
  await kvs.delete(SWEEP_CURSOR_KEY);

  // 3. Intake markers, so the same demo disputes can be taken in again later.
  for (const id of demoIds) await kvs.delete(`intake:${id}`);

  // 4. Projects and the space setup created. Demo content in projects setup did not create is limited
  //    to the disputes, handled in step 1.
  for (const key of state.createdProjects) await deleteDemoProject(key);
  if (state.createdSpace) await trashSpace(state.createdSpace);

  // 5. The demo's own SQL rows, by id, and the ledger entries for its disputes.
  await deleteDemoRows({
    customers: world.customers.map((c) => c.id),
    products: world.products.map((p) => p.sku),
    orders: world.orders.map((o) => o.id),
    charges: world.charges.map((c) => c.id),
    refunds: world.refunds.map((r) => r.id),
    outcomes: world.outcomes.map((o) => o.disputeId),
    disputes: demoIds,
  });
  await clearSources();
  await clearSeedState();
  const removed = [...state.createdProjects, ...(state.createdSpace ? [`space ${state.createdSpace}`] : [])];
  return { status: 'done', message: removed.length ? `Removed ${removed.join(', ')} and the demo records.` : 'Removed the demo records.' };
}

/**
 * Removal for a run made before the dispute ledger existed. A work item is deleted only if it carries the
 * demo label AND its record in app storage (which users cannot edit) names a demo dispute id, so neither a
 * stray label nor an edited issue property can get a real dispute deleted. That run's tables held only
 * demo rows, so they are cleared as that version of setup promised.
 */
async function removeLegacyStep(state: SeedState): Promise<RemoveProgress> {
  const disputesKey = (await getConfig()).projectKey;
  if (!state.createdProjects.includes(disputesKey)) {
    const res = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jql: `project = "${disputesKey}" AND labels = "${DEMO_LABEL}"`, fields: ['summary'], maxResults: DELETES_PER_CALL }),
    });
    if (!res.ok) throw new JiraError('Finding legacy demo disputes', res.status, await res.text());
    const issues = ((await res.json()) as { issues: { id: string; key: string }[] }).issues;
    let deleted = 0;
    for (const issue of issues) {
      const id = issue.id ?? (await getIssueId(issue.key));
      const record = id ? await readStoredRecord(id) : null;
      if (!record?.dispute.externalId.startsWith('dp_demo_')) continue;
      const del = await api.asUser().requestJira(route`/rest/api/3/issue/${issue.key}?deleteSubtasks=true`, { method: 'DELETE' });
      if (!del.ok && del.status !== 404) throw new JiraError(`Deleting ${issue.key}`, del.status, await del.text());
      if (id) await kvs.delete(`record:${id}`);
      await kvs.delete(`intake:${record.dispute.externalId}`);
      deleted += 1;
    }
    if (deleted > 0) return { status: 'running', message: `Deleted ${deleted} demo disputes from the earlier setup` };
  }
  for (const key of state.createdProjects) await deleteDemoProject(key);
  if (state.createdSpace) await trashSpace(state.createdSpace);
  await clearLegacyDemoTables();
  await clearSources();
  await clearSeedState();
  return { status: 'done', message: `Removed the earlier demo: ${[...state.createdProjects, state.createdSpace ? `space ${state.createdSpace}` : ''].filter(Boolean).join(', ')} and its records.` };
}
