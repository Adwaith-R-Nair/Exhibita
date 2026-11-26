// Maps a processor dispute event in a Stripe-compatible JSON shape to Exhibita's dispute record.
// Pure and defensive: the payload comes from outside, so every field is checked, never trusted.

import { minor, type Dispute } from '../types';

export type NormalizeResult =
  | { ok: true; dispute: Dispute }
  | { ok: false; error: 'not-an-object' | 'ignored-event-type' | 'malformed-dispute'; detail?: string };

/** Processor reason → our reason key. Anything unmapped goes to a person as 'unknown'. */
const REASON_MAP: Record<string, Dispute['reasonCode']> = {
  product_not_received: 'visa-13.1',
  product_unacceptable: 'visa-13.3',
  duplicate: 'visa-12.6.1',
  fraudulent: 'visa-10.4',
  subscription_canceled: 'visa-13.2',
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const unixToIso = (v: unknown): string | null =>
  typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;
const isoOrNull = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

export function normalizeDisputeEvent(payload: unknown, now: () => Date = () => new Date()): NormalizeResult {
  if (!isObj(payload)) return { ok: false, error: 'not-an-object' };
  if (payload.type !== 'charge.dispute.created') return { ok: false, error: 'ignored-event-type' };

  const data = isObj(payload.data) ? payload.data : null;
  const d = data && isObj(data.object) ? data.object : null;
  if (!d) return { ok: false, error: 'malformed-dispute', detail: 'data.object is missing' };

  const id = str(d.id);
  if (!id) return { ok: false, error: 'malformed-dispute', detail: 'id is missing' };

  const amount = d.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
    return { ok: false, error: 'malformed-dispute', detail: 'amount must be a non-negative integer in minor units' };
  }

  const currency = str(d.currency)?.toUpperCase() ?? 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'malformed-dispute', detail: 'currency must be a 3-letter code' };

  const metadata = isObj(d.metadata) ? d.metadata : {};
  const evidenceDetails = isObj(d.evidence_details) ? d.evidence_details : {};
  const processorReason = str(d.reason) ?? 'general';

  return {
    ok: true,
    dispute: {
      externalId: id,
      chargeId: str(d.charge),
      orderId: str(metadata.order_id),
      customer: str(metadata.customer),
      amount: minor(amount),
      currency,
      processorReason,
      reasonCode: REASON_MAP[processorReason] ?? 'unknown',
      respondBy: unixToIso(evidenceDetails.due_by),
      receivedAt: unixToIso(payload.created) ?? now().toISOString(),
      purchasedAt: isoOrNull(metadata.purchased_at),
    },
  };
}
