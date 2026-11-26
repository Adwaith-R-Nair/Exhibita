// Evidence collectors: turn source records (CollectInput) into EvidenceItems the rubric and challenge
// engine understand. Pure and deterministic: stable ids, stable order, no clock.
//
// Rules this file keeps:
// - Every item has provenance: a source, the time of the underlying fact, a state and a kind (invariant 5).
// - Absent data produces no item. The exceptions are query results whose emptiness is itself a recorded
//   fact; each is marked "Recorded absence" below. Those queries all start from the order row, so with
//   no order there is no absence to record. Absence items are dated at the dispute's arrival: the
//   absence held then (records are not deleted), and dating them later would make the challenge engine
//   treat them as evidence created after the dispute.
// - Initiated, approved and completed are different states.
// - Text classification is always kind 'inference' and quotes the phrase it came from (invariant 6).
// - An incident is a cause only through an explicit link (invariant 7).

import { classifyMessage, type MessageLabel } from '../classify/lexicon';
import { findReason } from '../rubric/reasons';
import type { ChargeRow, CollectInput, ObservedIncident, ObservedRefund, OrderRow } from '../sources/types';
import type { EvidenceItem, EvidenceType, ReasonKey } from '../types';

const DAY_MS = 86_400_000;

/**
 * Evidence only one reason's rubric reads. Other reasons skip it so the exhibit list stays focused;
 * a dispute whose reason is unknown gets everything, because a person will review it.
 * Types read by the challenge engine for every reason (delivery, refund, messages, policy, incident)
 * are never skipped.
 */
const ONLY_FOR: Partial<Record<EvidenceType, readonly ReasonKey[]>> = {
  'product-description': ['visa-13.3'],
  'order-pair': ['visa-12.6.1'],
  '3ds': ['visa-10.4'],
  avs: ['visa-10.4'],
  cvv: ['visa-10.4'],
  'prior-orders': ['visa-10.4'],
  cancellation: ['visa-13.2'],
};

/** Customer-message labels that mean the customer raised a problem with us. */
const COMPLAINT_LABELS: readonly MessageLabel[] = ['complained', 'requested-refund', 'denied-receipt'];

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

interface Context {
  input: CollectInput;
  /** The reason key, or null when the reason is not one Exhibita covers. */
  reason: ReasonKey | null;
  order: OrderRow | null;
  customerId: string | null;
}

const orderSource = (order: OrderRow, title?: string): EvidenceItem['source'] => ({
  kind: 'sql',
  key: `orders/${order.id}`,
  ...(title ? { title } : {}),
});

function delivery({ order }: Context): EvidenceItem[] {
  if (!order?.shipStatus) return [];
  let state: string = order.shipStatus;
  if (order.shipStatus === 'delivered') {
    state = order.addressMatch === true ? 'delivered' : order.addressMatch === false ? 'delivered-address-mismatch' : 'delivered-address-unverified';
  }
  const tracking = [order.carrier, order.tracking].filter(Boolean).join(' ');
  return [
    {
      id: `ev-delivery-${order.id}`,
      type: 'delivery',
      state,
      kind: 'fact',
      source: orderSource(order, `Order ${order.id}`),
      // The order row keeps no status-change time, so a shipment not yet delivered is dated by the purchase.
      at: order.deliveredAt ?? order.purchasedAt,
      ...(tracking ? { note: `Carrier tracking ${tracking}` } : {}),
    },
  ];
}

function signature({ order }: Context): EvidenceItem[] {
  if (!order?.signedBy) return [];
  const state = order.signatureNameMatch === true ? 'signed' : order.signatureNameMatch === false ? 'signature-name-mismatch' : 'signed-name-unverified';
  return [
    {
      id: `ev-signature-${order.id}`,
      type: 'delivery-signature',
      state,
      kind: 'fact',
      source: orderSource(order, `Order ${order.id}`),
      at: order.deliveredAt ?? order.purchasedAt,
      note: `Signed for by ${order.signedBy}`,
    },
  ];
}

function description({ order, input }: Context): EvidenceItem[] {
  if (!order || order.descriptionMatches === null) return [];
  return [
    {
      id: `ev-description-${order.id}`,
      type: 'product-description',
      state: order.descriptionMatches ? 'matches-delivered' : 'differs-from-delivered',
      kind: 'fact',
      source: orderSource(order, input.product?.name),
      // Checked at fulfilment, which is recorded no later than delivery.
      at: order.deliveredAt ?? order.purchasedAt,
      ...(input.product ? { note: `Description at purchase: ${input.product.description}` } : {}),
    },
  ];
}

function refundState(r: ObservedRefund, receivedAt: number | null): { state: string; at: string } {
  switch (r.status) {
    case 'completed': {
      const done = ms(r.completedAt);
      const before = done !== null && receivedAt !== null && done <= receivedAt;
      return { state: before ? 'completed-before-dispute' : 'completed-after-dispute', at: r.completedAt ?? r.requestedAt };
    }
    case 'approved':
      // A person said yes but no money moved: the refund is owed.
      return { state: 'approved-not-completed', at: r.approvedAt ?? r.requestedAt };
    case 'initiated':
      return { state: 'initiated', at: r.approvedAt ?? r.requestedAt };
    case 'declined':
      // The row keeps no decline time; the request is the latest recorded step.
      return { state: 'declined-per-policy', at: r.approvedAt ?? r.requestedAt };
    case 'requested':
      return { state: 'requested', at: r.requestedAt };
  }
}

function refunds({ input, order }: Context): EvidenceItem[] {
  const received = ms(input.dispute.receivedAt);
  if (input.refunds.length === 0) {
    if (!order) return [];
    const orderId = order.id;
    // Recorded absence: the refunds table was queried for this order and returned nothing.
    return [
      {
        id: `ev-refund-none-${orderId}`,
        type: 'refund',
        state: 'none',
        kind: 'fact',
        source: { kind: 'sql', key: `refunds?order=${orderId}`, title: `Refunds on ${orderId}` },
        at: input.dispute.receivedAt,
        note: 'No refund has been requested or issued on this order.',
      },
    ];
  }
  return [...input.refunds]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => {
      const { state, at } = refundState(r, received);
      const meta: EvidenceItem['meta'] = {};
      if (r.linkedIncident) meta.linkedIncident = r.linkedIncident;
      if (r.linkedDeploy) meta.linkedDeploy = r.linkedDeploy;
      const notes = [r.ticketKey ? `Support ticket ${r.ticketKey}` : null, r.declineReason ? `Declined: ${r.declineReason}` : null].filter(Boolean);
      return {
        id: `ev-refund-${r.id}`,
        type: 'refund' as const,
        state,
        kind: 'fact' as const,
        source: { kind: 'sql' as const, key: `refunds/${r.id}`, title: `Refund ${r.id}` },
        at,
        ...(notes.length ? { note: notes.join('. ') } : {}),
        ...(Object.keys(meta).length ? { meta } : {}),
      };
    });
}

function orderPairs({ input }: Context): EvidenceItem[] {
  const disputed = input.charges.find((c) => c.id === input.dispute.chargeId);
  if (!disputed) return [];
  const others = input.charges
    .filter((c) => c.id !== disputed.id && c.amount === disputed.amount && c.currency === disputed.currency)
    .sort((a, b) => (a.chargedAt < b.chargedAt ? -1 : a.chargedAt > b.chargedAt ? 1 : a.id < b.id ? -1 : 1));
  return others.map((other: ChargeRow) => {
    let state: string;
    let at = other.chargedAt;
    if (other.orderId !== disputed.orderId) {
      state = 'distinct';
    } else if (other.refundedAt || disputed.refundedAt) {
      state = 'duplicate-refunded';
      at = (other.refundedAt ?? disputed.refundedAt)!;
    } else {
      state = 'duplicate';
    }
    return {
      id: `ev-order-pair-${other.id}`,
      type: 'order-pair' as const,
      state,
      kind: 'fact' as const,
      source: { kind: 'sql' as const, key: `charges/${other.id}`, title: `Charge ${other.id} on ${other.orderId}` },
      at,
      note: `Disputed charge ${disputed.id} is on ${disputed.orderId}; this charge is on ${other.orderId}.`,
    };
  });
}

const CAUSED: Record<ObservedIncident['effect'], string> = {
  'duplicate-charges': 'caused-duplicate-charge',
  'dropped-refunds': 'caused-dropped-refund',
  other: 'caused-charge-problem',
};

function incidents({ input, reason, order }: Context): EvidenceItem[] {
  if (input.incidents.length === 0) {
    // Recorded absence: the incident search ran and found nothing linked or overlapping. Only the
    // charged-twice rubric reads it, so other reasons skip it.
    if (!order || (reason !== null && reason !== 'visa-12.6.1')) return [];
    const ref = order.id;
    return [
      {
        id: `ev-incident-none-${ref}`,
        type: 'incident',
        state: 'none',
        kind: 'fact',
        source: { kind: 'jira', key: `incidents?order=${ref}`, title: 'Incident search' },
        at: input.dispute.receivedAt,
        note: 'No incident is linked to this order or charge, and none overlapped the purchase.',
      },
    ];
  }
  return [...input.incidents]
    .sort((a, b) => (a.windowStart < b.windowStart ? -1 : a.windowStart > b.windowStart ? 1 : a.key < b.key ? -1 : 1))
    .map((i) => {
      const explicit = i.link === 'explicit';
      const meta: EvidenceItem['meta'] = { windowStart: i.windowStart, windowEnd: i.windowEnd };
      // The incident-to-deploy link is explicit, but it only explains this dispute when the incident does.
      if (explicit && i.linkedDeploy) meta.linkedDeploy = i.linkedDeploy;
      return {
        id: `ev-incident-${i.key}`,
        type: 'incident' as const,
        state: explicit ? CAUSED[i.effect] : 'unrelated',
        kind: 'fact' as const,
        source: { kind: 'jira' as const, key: i.key, title: i.title, ...(i.url ? { url: i.url } : {}) },
        at: i.windowStart,
        note: explicit
          ? `Explicitly linked to this order or charge${i.linkedDeploy ? `; caused by ${i.linkedDeploy}` : ''}.`
          : 'Open around the time of purchase but not linked to this order or charge. Not a cause.',
        meta,
      };
    });
}

function paymentChecks({ order }: Context): EvidenceItem[] {
  if (!order) return [];
  const check = (type: '3ds' | 'avs' | 'cvv', state: string, title: string): EvidenceItem => ({
    id: `ev-${type}-${order.id}`,
    type,
    state,
    kind: 'fact',
    source: orderSource(order, title),
    at: order.purchasedAt,
  });
  return [
    check('3ds', order.threeDS, '3-D Secure result'),
    check('avs', order.avs, 'Address verification result'),
    check('cvv', order.cvv, 'Security code check result'),
  ];
}

/** Visa Compelling Evidence 3.0: two or more undisputed orders 120 to 365 days earlier sharing IP or device. */
function compellingEvidence({ input, order, customerId }: Context): EvidenceItem[] {
  if (!order) return [];
  const purchased = ms(order.purchasedAt)!;
  const qualifying = input.priorOrders.filter((p) => {
    const t = ms(p.purchasedAt);
    if (t === null || p.disputed) return false;
    const age = (purchased - t) / DAY_MS;
    return age >= 120 && age <= 365 && (p.ip === order.ip || p.deviceId === order.deviceId);
  });
  const ids = qualifying.map((p) => p.id).sort();
  // Recorded absence when not eligible: the customer's order history was read in full.
  return [
    {
      id: `ev-prior-orders-${order.id}`,
      type: 'prior-orders',
      state: qualifying.length >= 2 ? 'ce30-eligible' : 'not-eligible',
      kind: 'fact',
      source: { kind: 'sql', key: `orders?customer=${customerId ?? order.customerId}`, title: 'Earlier orders from this customer' },
      at: order.purchasedAt,
      note: ids.length
        ? `${ids.length} earlier undisputed ${ids.length === 1 ? 'order' : 'orders'} 120 to 365 days old with the same IP or device: ${ids.join(', ')}.`
        : 'No earlier undisputed orders 120 to 365 days old with the same IP or device.',
    },
  ];
}

function cancellation({ input, order }: Context): EvidenceItem[] {
  if (!order) return [];
  const disputed = input.charges.find((c) => c.id === input.dispute.chargeId);
  const chargedAt = disputed?.chargedAt ?? order.purchasedAt;
  const cancelled = ms(order.subscriptionCancelledAt);
  const before = cancelled !== null && cancelled < ms(chargedAt)!;
  return [
    {
      id: `ev-cancellation-${order.id}`,
      type: 'cancellation',
      state: before ? 'cancelled-before-charge' : 'none-before-charge',
      kind: 'fact',
      source: orderSource(order, 'Subscription status'),
      // The cancellation field is a recorded fact either way: when it is empty, nothing was cancelled by the charge.
      at: before ? order.subscriptionCancelledAt! : chargedAt,
      ...(order.subscriptionCancelledAt && !before ? { note: `Cancelled on ${order.subscriptionCancelledAt.slice(0, 10)}, after this charge.` } : {}),
    },
  ];
}

function policy({ input, order }: Context): EvidenceItem[] {
  const version = order?.termsAcceptedVersion;
  if (!order || !version) return [];
  const page = input.policies.find((p) => p.kind === 'refund-returns' && p.version === version);
  // A version the customer accepted but that is not on record cannot be cited.
  if (!page) return [];
  return [
    {
      id: `ev-policy-${page.pageId}-${page.version}`,
      type: 'policy',
      state: 'accepted-at-checkout',
      kind: 'fact',
      source: { kind: 'confluence', key: page.pageId, title: page.title, ...(page.url ? { url: page.url } : {}) },
      at: order.purchasedAt,
      note: `Accepted ${page.version} at checkout.`,
      meta: { version: page.version, effectiveFrom: page.effectiveFrom, effectiveTo: page.effectiveTo },
    },
  ];
}

function customerMessages({ input, order, customerId }: Context): EvidenceItem[] {
  const tickets = [...input.tickets].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.key < b.key ? -1 : 1));
  const items: EvidenceItem[] = [];
  let complained = false;
  for (const t of tickets) {
    t.messages.forEach((m, i) => {
      if (m.author !== 'customer') return;
      const seen = new Set<MessageLabel>();
      for (const match of classifyMessage(m.text)) {
        if (seen.has(match.label)) continue;
        seen.add(match.label);
        if (COMPLAINT_LABELS.includes(match.label)) complained = true;
        items.push({
          id: `ev-message-${t.key}-${i}-${match.label}`,
          type: 'customer-message',
          state: match.label,
          kind: 'inference',
          source: { kind: 'jsm', key: t.key, ...(t.url ? { url: t.url } : {}) },
          at: m.at,
          meta: { quote: match.phrase },
        });
      }
    });
  }
  // Recorded absence: every ticket from this customer was read and none raised a problem. With no
  // tickets at all the customer never contacted us, which is the plainest case of no complaint.
  // Still an inference: it rests on the lexicon not finding a complaint.
  if (!complained && order && customerId) {
    items.push({
      id: `ev-no-complaint-${customerId}`,
      type: 'customer-message',
      state: 'no-complaint',
      kind: 'inference',
      source: { kind: 'jsm', key: `tickets?customer=${customerId}`, title: 'Support tickets from this customer' },
      at: input.dispute.receivedAt,
      note:
        tickets.length === 0
          ? 'This customer has no support tickets.'
          : `${tickets.length} support ${tickets.length === 1 ? 'ticket' : 'tickets'} (${tickets.map((t) => t.key).join(', ')}), none raising a problem.`,
    });
  }
  return items;
}

const COLLECTORS: readonly ((ctx: Context) => EvidenceItem[])[] = [
  delivery,
  signature,
  description,
  refunds,
  orderPairs,
  incidents,
  paymentChecks,
  compellingEvidence,
  cancellation,
  policy,
  customerMessages,
];

export function collectEvidence(input: CollectInput): EvidenceItem[] {
  const reason = findReason(input.dispute.reasonCode)?.key ?? null;
  const ctx: Context = {
    input,
    reason,
    order: input.order,
    customerId: input.dispute.customer ?? input.order?.customerId ?? null,
  };
  const relevant = (e: EvidenceItem) => reason === null || !ONLY_FOR[e.type] || ONLY_FOR[e.type]!.includes(reason);
  // Collector order, then each collector's own sort, gives a stable exhibit order.
  return COLLECTORS.flatMap((collect) => collect(ctx)).filter(relevant);
}
