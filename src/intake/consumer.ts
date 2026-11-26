// Queue consumer: turns a normalised dispute into a JSM work item with the dispute record attached.
// Idempotent on the processor's dispute id, because queues retry and processors redeliver.

import type { AsyncEvent } from '@forge/events';
import { kvs } from '@forge/kvs';
import { publishGlobal } from '@forge/realtime';
import { RECORD_SCHEMA_VERSION, type DisputeRecord } from '../core/record';
import { findReason } from '../core/rubric/reasons';
import type { Dispute } from '../core/types';
import { getConfig } from '../lib/config';
import { createIssue, findIssueByExternalId, findProject, getIssueId, pickIssueType } from '../lib/jira';
import { readStoredRecord, saveRecord } from '../lib/records';

export const DISPUTE_CREATED_CHANNEL = 'exhibita-dispute-created';

interface IntakeMessage {
  dispute: Dispute;
  raw: unknown;
}

const money = (d: Dispute) => `${(d.amount / 100).toFixed(2)} ${d.currency}`;

export async function processIntake(event: AsyncEvent): Promise<void> {
  const { dispute, raw } = event.body as unknown as IntakeMessage;
  const config = await getConfig();

  const project = await findProject(config.projectKey);
  if (!project) throw new Error(`Project ${config.projectKey} not found. Set the project on the Exhibita setup page.`);

  // KVS is read-your-writes, so a redelivery minutes later is caught here; JQL is the fallback for
  // records written before this key existed (the search index can lag by a few seconds).
  const seenKey = `intake:${dispute.externalId}`;
  const seen = await kvs.get<{ issueKey: string }>(seenKey);
  const seenLive = seen?.issueKey && (await getIssueId(seen.issueKey)) ? seen.issueKey : null;
  const existing = seenLive ?? (await findIssueByExternalId(config.projectKey, dispute.externalId));
  const fresh: DisputeRecord = { schemaVersion: RECORD_SCHEMA_VERSION, dispute, evidence: [], raw, collectedAt: null };
  if (existing) {
    // A redelivery restores the stored record if it is missing (D-11). The webhook is authenticated,
    // so its dispute details can be trusted; evidence starts empty and is collected again.
    const id = await getIssueId(existing);
    if (id && !(await readStoredRecord(id))) {
      await saveRecord({ id, key: existing }, fresh);
      console.log(`Restored the stored record for ${dispute.externalId} on ${existing}`);
    } else {
      console.log(`Dispute ${dispute.externalId} already recorded on ${existing}; skipping`);
    }
    return;
  }

  const reason = findReason(dispute.reasonCode);
  const reasonText = reason ? `${reason.label} (${reason.code})` : `Unmapped reason: ${dispute.processorReason}`;
  const issueType = await pickIssueType(project.id);
  const issue = await createIssue({
    projectId: project.id,
    issueTypeId: issueType.id,
    summary: `${money(dispute)} dispute: ${reason?.label ?? dispute.processorReason}${dispute.orderId ? ` on ${dispute.orderId}` : ''}`,
    description: [
      `Reason: ${reasonText}`,
      `Amount: ${money(dispute)}`,
      `Respond by: ${dispute.respondBy ?? 'not given'}`,
      `Order: ${dispute.orderId ?? 'unknown'} · Customer: ${dispute.customer ?? 'unknown'}`,
      `Processor dispute: ${dispute.externalId}`,
    ].join('\n'),
    labels: ['exhibita', 'dispute'],
  });

  await saveRecord(issue, fresh);
  await kvs.set(seenKey, { issueKey: issue.key });

  await publishGlobal(DISPUTE_CREATED_CHANNEL, JSON.stringify({ issueKey: issue.key, externalId: dispute.externalId }));
  console.log(`Created ${issue.key} for dispute ${dispute.externalId}`);
}
