// Collect a dispute's evidence and save it to the record. Used on intake and by "Collect evidence again".

import { collectEvidence } from '../core/collect';
import type { DisputeRecord } from '../core/record';
import { buildCollectInput } from './collect-input';
import { saveRecord } from './records';

export async function collectAndSave(issue: { id: string; key: string }, record: DisputeRecord, disputesProjectKey: string): Promise<DisputeRecord> {
  const input = await buildCollectInput(record.dispute, disputesProjectKey);
  const next: DisputeRecord = { ...record, evidence: collectEvidence(input), collectedAt: new Date().toISOString() };
  await saveRecord(issue, next);
  return next;
}
