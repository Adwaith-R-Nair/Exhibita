// "Remove demo data" (D-05). Undoes only what the setup wizard recorded creating, one bounded step per
// call. Projects and the Confluence space go to their trash, where an admin can restore them. Demo
// disputes in a disputes project that existed before setup are deleted one by one, because the
// project itself must stay.

import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { generateWorld } from '../core/demo';
import { normalizeDisputeEvent } from '../core/intake/normalize';
import { clearSources } from './collect-input';
import { getConfig } from './config';
import { trashSpace } from './confluence';
import { JiraError } from './jira';
import { trashProject } from './jira-setup';
import type { DisputeRecord } from '../core/record';
import { clearSeedState, DEMO_LABEL, getSeedState } from './seed';
import { clearDemoTables } from './store';

const DELETES_PER_CALL = 20;
const SWEEP_CURSOR_KEY = 'demo:remove-cursor';

export interface RemoveProgress {
  status: 'idle' | 'running' | 'done';
  message: string;
}

async function demoDisputesIn(projectKey: string): Promise<{ id: string; key: string }[]> {
  const res = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jql: `project = "${projectKey}" AND labels = "${DEMO_LABEL}"`, fields: ['summary'], maxResults: DELETES_PER_CALL }),
  });
  const text = await res.text();
  if (res.status === 400 || res.status === 404) return [];
  if (!res.ok) throw new JiraError('Finding demo disputes', res.status, text);
  return (JSON.parse(text) as { issues: { id: string; key: string }[] }).issues;
}

/** Run one bounded piece of the removal. Call until status is done. */
export async function removeDemoStep(): Promise<RemoveProgress> {
  const state = await getSeedState();
  if (!state) return { status: 'idle', message: 'No demo data was set up from this app.' };
  const disputesKey = (await getConfig()).projectKey;

  const world = generateWorld({ seed: state.seed, now: state.now });
  const demoIds = new Set(world.disputes.flatMap((d) => {
    const n = normalizeDisputeEvent(d.payload);
    return n.ok ? [n.dispute.externalId] : [];
  }));

  // 1. In a disputes project that existed before setup, delete the demo disputes themselves.
  if (!state.createdProjects.includes(disputesKey)) {
    const batch = await demoDisputesIn(disputesKey);
    for (const issue of batch) {
      const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issue.key}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new JiraError(`Deleting ${issue.key}`, res.status, await res.text());
    }
    if (batch.length > 0) return { status: 'running', message: `Deleted ${batch.length} demo disputes` };
  }

  // 2. Stored records live in app storage, not in Jira, so sweep them page by page.
  const cursor = await kvs.get<string>(SWEEP_CURSOR_KEY);
  let query = kvs.query().where('key', WhereConditions.beginsWith('record:')).limit(DELETES_PER_CALL);
  if (cursor) query = query.cursor(cursor);
  const page = await query.getMany<DisputeRecord>();
  for (const r of page.results) if (demoIds.has(r.value?.dispute?.externalId)) await kvs.delete(r.key);
  if (page.nextCursor) {
    await kvs.set(SWEEP_CURSOR_KEY, page.nextCursor);
    return { status: 'running', message: 'Removing stored demo records' };
  }
  await kvs.delete(SWEEP_CURSOR_KEY);

  // 3. Intake markers, so the same demo disputes can be created again later.
  for (const id of demoIds) await kvs.delete(`intake:${id}`);

  // 4. Projects and the space the wizard created, to the trash.
  for (const key of state.createdProjects) await trashProject(key);
  if (state.createdSpace) await trashSpace(state.createdSpace);

  // 5. The merchant tables and the record of where evidence lives.
  await clearDemoTables();
  await clearSources();
  await clearSeedState();
  const trashed = [...state.createdProjects, ...(state.createdSpace ? [`space ${state.createdSpace}`] : [])];
  return { status: 'done', message: trashed.length ? `Moved ${trashed.join(', ')} to the trash and cleared the demo tables.` : 'Cleared the demo data.' };
}
