// Web trigger: receives processor dispute webhooks, checks the shared secret, replies fast, and queues
// the real work. The raw body is passed through unchanged so it can be kept for audit.

import type { WebTriggerRequest, WebTriggerResponse } from '@forge/api';
import { Queue } from '@forge/events';
import { timingSafeEqual } from 'node:crypto';
import { normalizeDisputeEvent } from '../core/intake/normalize';
import { getWebhookSecret } from '../lib/config';

export const INTAKE_QUEUE = 'exhibita-intake';

const reply = (statusCode: number, body: Record<string, unknown>): WebTriggerResponse => ({
  statusCode,
  headers: { 'Content-Type': ['application/json'] },
  body: JSON.stringify(body),
});

function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleIntake(request: WebTriggerRequest): Promise<WebTriggerResponse> {
  if (request.method !== 'POST') return reply(405, { error: 'method-not-allowed' });

  const expected = await getWebhookSecret();
  if (!expected) return reply(503, { error: 'not-configured', detail: 'Create a webhook secret on the Exhibita setup page first.' });
  if (!sameSecret(request.headers['x-exhibita-secret']?.[0], expected)) return reply(401, { error: 'bad-secret' });

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
