// Checks the live demo against the generated world: every demo dispute on the site should reach the
// recommendation the generator intended. Catches drift between the collectors' reference observer and
// what the site actually returns.

import api, { route } from '@forge/api';
import { generateWorld } from '../core/demo';
import { normalizeDisputeEvent } from '../core/intake/normalize';
import { getConfig } from './config';
import { DEMO_LABEL } from './demo-label';
import { evaluateIssue } from './evaluate-issue';
import { getSeedState } from './seed';

export interface DemoCheck {
  total: number;
  found: number;
  matching: number;
  mismatches: { issueKey: string | null; externalId: string; scenario: string; expected: string; actual: string }[];
}

async function demoIssues(projectKey: string): Promise<Map<string, { id: string; key: string }>> {
  const out = new Map<string, { id: string; key: string }>();
  let nextPageToken: string | undefined;
  do {
    const res = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jql: `project = "${projectKey}" AND labels = "${DEMO_LABEL}"`, fields: ['summary'], properties: ['exhibita'], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }),
    });
    const body = (await res.json()) as { issues: { id: string; key: string; properties?: { exhibita?: { dispute?: { externalId?: string } } } }[]; nextPageToken?: string };
    for (const i of body.issues) {
      const ext = i.properties?.exhibita?.dispute?.externalId;
      if (ext) out.set(ext, { id: i.id, key: i.key });
    }
    nextPageToken = body.nextPageToken;
  } while (nextPageToken);
  return out;
}

export async function checkDemo(): Promise<DemoCheck | null> {
  const state = await getSeedState();
  if (!state) return null;
  const world = generateWorld({ seed: state.seed, now: state.now });
  const issues = await demoIssues((await getConfig()).projectKey);
  const result: DemoCheck = { total: world.disputes.length, found: 0, matching: 0, mismatches: [] };
  const BATCH = 10;
  for (let i = 0; i < world.disputes.length; i += BATCH) {
    await Promise.all(
      world.disputes.slice(i, i + BATCH).map(async (d) => {
        const n = normalizeDisputeEvent(d.payload);
        if (!n.ok) return;
        const issue = issues.get(n.dispute.externalId);
        if (!issue) {
          result.mismatches.push({ issueKey: null, externalId: n.dispute.externalId, scenario: d.scenario, expected: d.expected, actual: 'not created' });
          return;
        }
        result.found += 1;
        const loaded = await evaluateIssue(issue.key, issue.id);
        const actual = loaded.verdict?.recommendation ?? `no trusted record (${loaded.trust})`;
        if (actual === d.expected) result.matching += 1;
        else result.mismatches.push({ issueKey: issue.key, externalId: n.dispute.externalId, scenario: d.scenario, expected: d.expected, actual });
      }),
    );
  }
  return result;
}
