// Load a work item's dispute record and evaluate it. Shared by the panel, validator and agent actions,
// so every surface reaches the same verdict from the same data (D-04, D-11).

import type { DisputeRecord, RecordTrust } from '../core/record';
export { COPY_CHANGED_MESSAGE, UNTRUSTED_RECORD_MESSAGE } from '../core/record';
import { challengeDispute, type ChallengeResult } from '../core/challenge/challenge';
import { evaluateDispute } from '../core/rubric/evaluate';
import { minor, type Evaluation } from '../core/types';
import { finalVerdict, type Verdict } from '../core/verdict';
import { getConfig } from './config';
import { loadRecord } from './records';

export type IssueEvaluation =
  | {
      issueKey: string;
      trust: Extract<RecordTrust, 'verified' | 'copy-changed'>;
      record: DisputeRecord;
      evaluation: Evaluation;
      challenge: ChallengeResult;
      verdict: Verdict;
    }
  | { issueKey: string; trust: Extract<RecordTrust, 'unverified' | 'none'>; record: null; evaluation: null; challenge: null; verdict: null };

export async function evaluateIssue(issueKey: string, issueId?: string): Promise<IssueEvaluation> {
  const loaded = await loadRecord(issueKey, issueId);
  if (!loaded.record) return { issueKey, trust: loaded.trust, record: null, evaluation: null, challenge: null, verdict: null };
  const config = await getConfig();
  const evaluation = evaluateDispute(loaded.record.dispute, loaded.record.evidence, {
    signatureThreshold: minor(config.signatureThresholdMinor),
  });
  const challenge = challengeDispute(loaded.record.dispute, loaded.record.evidence, evaluation);
  // A record saved part way through collection, or left that way by a failed source, has collectedAt null.
  const verdict = finalVerdict(evaluation, challenge, { collectionComplete: loaded.record.collectedAt !== null });
  return { issueKey, trust: loaded.trust, record: loaded.record, evaluation, challenge, verdict };
}
