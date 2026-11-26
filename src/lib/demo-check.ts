// Checks the live demo against the generated world: every demo dispute on the site should reach the
// recommendation the generator intended. Catches drift between the collectors' reference observer and
// what the site actually returns.

import { generateWorld } from '../core/demo';
import { normalizeDisputeEvent } from '../core/intake/normalize';
import { evaluateIssue } from './evaluate-issue';
import { getSeedState } from './seed';
import { ledgerIssues } from './store';

export interface DemoCheck {
  total: number;
  found: number;
  matching: number;
  mismatches: { issueKey: string | null; externalId: string; scenario: string; expected: string; actual: string }[];
}

export async function checkDemo(): Promise<DemoCheck | null> {
  const state = await getSeedState();
  if (!state) return null;
  const world = generateWorld({ seed: state.seed, now: state.now });
  const ids = world.disputes.flatMap((d) => {
    const n = normalizeDisputeEvent(d.payload);
    return n.ok ? [n.dispute.externalId] : [];
  });
  // The ledger, not issue properties, says which work item holds which dispute.
  const issues = new Map((await ledgerIssues(ids)).map((l) => [l.externalId, l.issueKey]));
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
        const loaded = await evaluateIssue(issue);
        const actual = loaded.verdict?.recommendation ?? `no trusted record (${loaded.trust})`;
        if (actual === d.expected) result.matching += 1;
        else result.mismatches.push({ issueKey: issue, externalId: n.dispute.externalId, scenario: d.scenario, expected: d.expected, actual });
      }),
    );
  }
  return result;
}
