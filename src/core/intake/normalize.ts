// Maps a processor dispute event in a Stripe-compatible JSON shape to Exhibita's dispute record.
// Pure and defensive: the payload comes from outside, so every field is checked, never trusted.

import { minor, type CardNetwork, type Dispute } from '../types';

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
  credit_not_processed: 'visa-13.6',
};

/** Card brand as the processor spells it → our network. Anything else is unknown, never guessed. */
const NETWORK_MAP: Record<string, CardNetwork> = {
  visa: 'visa',
  mastercard: 'mastercard',
  amex: 'amex',
  american_express: 'amex',
  discover: 'discover',
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
/** Latest instant a JavaScript Date can hold, in seconds. Larger timestamps would throw in toISOString. */
const MAX_UNIX_SECONDS = 8.64e12;

/**
 * Unix seconds → ISO 8601. Absent (undefined or null) is null; present but not a usable time is an error,
 * so a garbled timestamp is rejected as malformed instead of throwing or being silently replaced.
 */
function unixField(v: unknown): { ok: true; iso: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, iso: null };
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_UNIX_SECONDS) return { ok: false };
  return { ok: true, iso: new Date(v * 1000).toISOString() };
}
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

  const created = unixField(payload.created);
  if (!created.ok) return { ok: false, error: 'malformed-dispute', detail: 'created must be a unix time in seconds' };
  const dueBy = unixField(evidenceDetails.due_by);
  if (!dueBy.ok) return { ok: false, error: 'malformed-dispute', detail: 'evidence_details.due_by must be a unix time in seconds' };

  // Stripe disputes carry the card brand and the network's own reason code on payment_method_details.card.
  const pmd = isObj(d.payment_method_details) ? d.payment_method_details : {};
  const card = isObj(pmd.card) ? pmd.card : {};
  const brand = (str(card.brand) ?? str(d.network) ?? str(metadata.network))?.toLowerCase().replace(/[\s-]+/g, '_') ?? null;
  const network: CardNetwork = (brand && NETWORK_MAP[brand]) || 'unknown';
  const networkReasonCode = str(card.network_reason_code) ?? str(d.network_reason_code);

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
      respondBy: dueBy.iso,
      receivedAt: created.iso ?? now().toISOString(),
      purchasedAt: isoOrNull(metadata.purchased_at),
      network,
      networkReasonCode,
    },
  };
}
