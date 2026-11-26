// Collect a dispute's evidence and save it to the record, one source at a time. After each source the
// record is saved and an event is published, so an open panel shows the evidence arriving (spec 5.3).
// Used on intake and by "Collect evidence again".

import { publishGlobal } from '@forge/realtime';
import { collectEvidence } from '../core/collect';
import type { DisputeRecord } from '../core/record';
import type { CollectSource } from '../core/sources/types';
import { buildCollectInput } from './collect-input';
import { saveRecord } from './records';

export const EVIDENCE_CHANNEL = 'exhibita-evidence';

/** What the panel hears: which work item changed, the source just read, and whether collection is done. */
export interface EvidenceEvent {
  issueId: string;
  stage: CollectSource | 'done';
}

async function announce(event: EvidenceEvent): Promise<void> {
  // A missed message only means the panel refreshes on its next load, so never fail collection over it.
  await publishGlobal(EVIDENCE_CHANNEL, JSON.stringify(event)).catch((e: unknown) => console.warn('Realtime publish failed', e));
}

export async function collectAndSave(issue: { id: string; key: string }, record: DisputeRecord, disputesProjectKey: string): Promise<DisputeRecord> {
  const input = await buildCollectInput(record.dispute, disputesProjectKey, async (partial, stage) => {
    await saveRecord(issue, { ...record, evidence: collectEvidence(partial), collectedAt: null });
    await announce({ issueId: issue.id, stage });
  });
  const next: DisputeRecord = { ...record, evidence: collectEvidence(input), collectedAt: new Date().toISOString() };
  await saveRecord(issue, next);
  await announce({ issueId: issue.id, stage: 'done' });
  return next;
}
