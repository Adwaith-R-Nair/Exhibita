// Load a work item's dispute record and evaluate it. Shared by the panel, validator and agent actions,
// so every surface reaches the same verdict from the same data (D-04).

import type { DisputeRecord } from '../core/record.js';
import { evaluateDispute } from '../core/rubric/evaluate.js';
import { minor, type Evaluation } from '../core/types.js';
import { getConfig } from './config.js';
import { readDisputeRecord } from './jira.js';

export interface IssueEvaluation {
  issueKey: string;
  record: DisputeRecord;
  evaluation: Evaluation;
}

export async function evaluateIssue(issueKey: string): Promise<IssueEvaluation | null> {
  const record = await readDisputeRecord(issueKey);
  if (!record) return null;
  const config = await getConfig();
  const evaluation = evaluateDispute(record.dispute, record.evidence, {
    signatureThreshold: minor(config.signatureThresholdMinor),
  });
  return { issueKey, record, evaluation };
}
