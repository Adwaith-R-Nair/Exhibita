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
import { collectAndSave } from '../lib/collect';
import { readStoredRecord, saveRecord } from '../lib/records';
import { claimDispute, getDisputeClaim, pendingAge, pendingMarker, releaseDisputeClaim, setDisputeIssue } from '../lib/store';
import { DEMO_LABEL } from '../lib/demo-label';

export const DISPUTE_CREATED_CHANNEL = 'exhibita-dispute-created';

interface IntakeMessage {
  dispute: Dispute;
  raw: unknown;
  /** Set by the demo setup wizard, so "Remove demo data" can find these work items. */
  demo?: boolean;
}

const money = (d: Dispute) => `${(d.amount / 100).toFixed(2)} ${d.currency}`;

/** A claim left pending this long belongs to a delivery that crashed; another delivery may take it over. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** The stored record for this work item is missing (deleted, or created before D-11): rebuild it from the
 * authenticated webhook and collect the evidence again. */
async function restore(issueKey: string, fresh: DisputeRecord, projectKey: string): Promise<void> {
  const id = await getIssueId(issueKey);
  if (!id || (await readStoredRecord(id))) {
    console.log(`Dispute ${fresh.dispute.externalId} already recorded on ${issueKey}; skipping`);
    return;
  }
  await saveRecord({ id, key: issueKey }, fresh);
  await collectAndSave({ id, key: issueKey }, fresh, projectKey).catch((e: unknown) => console.error(`Collection failed on restore of ${issueKey}`, e));
  console.log(`Restored the stored record for ${fresh.dispute.externalId} on ${issueKey}`);
}

export async function processIntake(event: AsyncEvent): Promise<void> {
  const { dispute, raw, demo } = event.body as unknown as IntakeMessage;
  const config = await getConfig();
  const fresh: DisputeRecord = { schemaVersion: RECORD_SCHEMA_VERSION, dispute, evidence: [], raw, collectedAt: null };

  const project = await findProject(config.projectKey);
  if (!project) throw new Error(`Project ${config.projectKey} not found. Set the project on the Exhibita setup page.`);

  // 1. Claim the dispute id atomically (review A4). Only one delivery can win the insert.
  const claimed = await claimDispute({ externalId: dispute.externalId, orderId: dispute.orderId, customerId: dispute.customer, receivedAt: dispute.receivedAt });
  if (!claimed) {
    const claim = await getDisputeClaim(dispute.externalId);
    const age = pendingAge(claim?.issueKey ?? null);
    if (claim?.issueKey && age === null) {
      if (await getIssueId(claim.issueKey)) return restore(claim.issueKey, fresh, config.projectKey);
      // The work item was deleted; fall through and create a new one.
    } else if (age !== null && age < STALE_CLAIM_MS) {
      console.log(`Dispute ${dispute.externalId} is being created by another delivery; skipping`);
      return;
    }
    await setDisputeIssue(dispute.externalId, pendingMarker());
  }

  try {
    // 2. Disputes taken in before the ledger existed are found by their KVS marker or by JQL.
    const seenKey = `intake:${dispute.externalId}`;
    const seen = await kvs.get<{ issueKey: string }>(seenKey);
    const legacy = (seen?.issueKey && (await getIssueId(seen.issueKey)) ? seen.issueKey : null) ?? (await findIssueByExternalId(config.projectKey, dispute.externalId));
    if (legacy) {
      await setDisputeIssue(dispute.externalId, legacy);
      return restore(legacy, fresh, config.projectKey);
    }

    // 3. Create the work item, and record its key at once so nothing can create a second one.
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
      labels: ['exhibita', 'dispute', ...(demo ? [DEMO_LABEL] : [])],
      // The processor's respond-by date drives the queue: Jira's due date sorts and filters on it.
      ...(dispute.respondBy ? { duedate: dispute.respondBy.slice(0, 10) } : {}),
    });
    await setDisputeIssue(dispute.externalId, issue.key);
    await kvs.set(seenKey, { issueKey: issue.key });
    await saveRecord(issue, fresh);

    // 4. Collect evidence straight away. If a source fails, the record stays incomplete, submission
    //    stays blocked (review A1), and the panel's "Collect evidence again" retries.
    let evidenceCount = 0;
    try {
      evidenceCount = (await collectAndSave(issue, fresh, config.projectKey)).evidence.length;
    } catch (error) {
      console.error(`Evidence collection failed for ${issue.key}`, error);
    }
    await publishGlobal(DISPUTE_CREATED_CHANNEL, JSON.stringify({ issueKey: issue.key, externalId: dispute.externalId }));
    console.log(`Created ${issue.key} for dispute ${dispute.externalId} with ${evidenceCount} evidence items`);
  } catch (error) {
    // Nothing was created under this claim: give it up so the queue's retry can take it.
    await releaseDisputeClaim(dispute.externalId).catch(() => undefined);
    throw error;
  }
}
