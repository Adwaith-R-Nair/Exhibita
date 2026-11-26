// Where dispute records are kept (D-11). The authoritative copy lives in Forge app storage, which only
// this app can write. The work item property is a mirror for JQL and display, and is never trusted on
// its own: anyone who can edit the work item can rewrite it.

import { kvs } from '@forge/kvs';
import { reconcileRecord, type DisputeRecord, type ReconciledRecord } from '../core/record';
import { getIssueId, readDisputeRecord, writeDisputeRecord } from './jira';

/** Keyed by issue id, which survives the work item being moved to another project. */
export const storedRecordKey = (issueId: string) => `record:${issueId}`;

export async function readStoredRecord(issueId: string): Promise<DisputeRecord | null> {
  return (await kvs.get<DisputeRecord>(storedRecordKey(issueId))) ?? null;
}

/** Save the record: app storage first, so a failed mirror write never leaves an untrusted copy alone. */
export async function saveRecord(issue: { id: string; key: string }, record: DisputeRecord): Promise<void> {
  await kvs.set(storedRecordKey(issue.id), record);
  await writeDisputeRecord(issue.key, record);
}

/** Load a work item's record and say how far it can be trusted. Only the stored copy is ever returned. */
export async function loadRecord(issueKey: string, issueId?: string): Promise<ReconciledRecord> {
  const id = issueId ?? (await getIssueId(issueKey));
  if (!id) return { trust: 'none', record: null };
  const [stored, copy] = await Promise.all([readStoredRecord(id), readDisputeRecord(issueKey)]);
  return reconcileRecord(stored, copy);
}
