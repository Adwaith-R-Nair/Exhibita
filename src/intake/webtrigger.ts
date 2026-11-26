// Web trigger: receives processor dispute webhooks, verifies their signature, replies fast, and queues
// the real work. The raw body is passed through unchanged so it can be kept for audit.

import type { WebTriggerRequest, WebTriggerResponse } from '@forge/api';
import { Queue } from '@forge/events';
import { normalizeDisputeEvent } from '../core/intake/normalize';
import { verifySignature } from '../core/intake/signature';
import { getWebhookSecret } from '../lib/config';

export const INTAKE_QUEUE = 'exhibita-intake';

const reply = (statusCode: number, body: Record<string, unknown>): WebTriggerResponse => ({
  statusCode,
  headers: { 'Content-Type': ['application/json'] },
  body: JSON.stringify(body),
});

/** Header names are case-insensitive; Forge passes them lower-cased. Stripe's own name is accepted too. */
const signatureHeader = (headers: Record<string, string[] | undefined>) =>
  headers['x-exhibita-signature']?.[0] ?? headers['stripe-signature']?.[0];

export async function handleIntake(request: WebTriggerRequest): Promise<WebTriggerResponse> {
  if (request.method !== 'POST') return reply(405, { error: 'method-not-allowed' });

  const expected = await getWebhookSecret();
  if (!expected) return reply(503, { error: 'not-configured', detail: 'Create a webhook secret on the Exhibita setup page first.' });
  const check = verifySignature(signatureHeader(request.headers), request.body, expected, Math.floor(Date.now() / 1000));
  if (!check.ok) return reply(401, { error: check.reason });

  let payload: unknown;
  try {
    payload = JSON.parse(request.body);
  } catch {
    return reply(400, { error: 'invalid-json' });
  }

  const normalized = normalizeDisputeEvent(payload);
  if (!normalized.ok) {
    // Other event types are acknowledged so the processor doesn't keep retrying them.
    if (normalized.error === 'ignored-event-type') return reply(200, { ignored: true });
    return reply(422, { error: normalized.error, detail: normalized.detail });
  }

  await new Queue({ key: INTAKE_QUEUE }).push({ body: { dispute: normalized.dispute, raw: payload } });
  return reply(202, { queued: true, externalId: normalized.dispute.externalId });
}
