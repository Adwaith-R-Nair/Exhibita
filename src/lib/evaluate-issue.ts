// Load a work item's dispute record and evaluate it. Shared by the panel, validator and agent actions,
// so every surface reaches the same verdict from the same data (D-04, D-11).

import type { DisputeRecord, RecordTrust } from '../core/record';
export { COPY_CHANGED_MESSAGE, UNTRUSTED_RECORD_MESSAGE } from '../core/record';
import { evaluateDispute } from '../core/rubric/evaluate';
import { minor, type Evaluation } from '../core/types';
import { getConfig } from './config';
import { loadRecord } from './records';

export type IssueEvaluation =
  | { issueKey: string; trust: Extract<RecordTrust, 'verified' | 'copy-changed'>; record: DisputeRecord; evaluation: Evaluation }
  | { issueKey: string; trust: Extract<RecordTrust, 'unverified' | 'none'>; record: null; evaluation: null };

export async function evaluateIssue(issueKey: string, issueId?: string): Promise<IssueEvaluation> {
  const loaded = await loadRecord(issueKey, issueId);
  if (!loaded.record) return { issueKey, trust: loaded.trust, record: null, evaluation: null };
  const config = await getConfig();
  const evaluation = evaluateDispute(loaded.record.dispute, loaded.record.evidence, {
    signatureThreshold: minor(config.signatureThresholdMinor),
  });
  return { issueKey, trust: loaded.trust, record: loaded.record, evaluation };
}
