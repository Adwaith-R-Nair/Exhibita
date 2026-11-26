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
// - An incident is a cause only through an explicit link (invariant 7), and only while the harm it
//   caused is still there: a dropped refund that was later paid and settled is no longer a cause (B5).
// - Customer messages count only from tickets about this order, or whose order is unknown (B4).
// - The processor's view of a refund (charges.amountRefunded) is read separately from the merchant's
//   refund service, so the two can be reconciled (D1).

import { classifyMessage, type MessageLabel } from '../classify/lexicon';
import { findReason } from '../rubric/reasons';
import type { ChargeRow, CollectInput, CollectSource, ObservedIncident, ObservedRefund, OrderRow } from '../sources/types';
import type { EvidenceCriterion, EvidenceItem, EvidenceType, ReasonKey } from '../types';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Two identical orders this close together may be one purchase submitted twice (review B7). */
const POSSIBLE_DUPLICATE_MS = 10 * MINUTE_MS;

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
  /** What the processor shows for each refund the refund service marked completed. Null: not read yet. */
  settlement: Map<string, Settlement> | null;
}

interface Settlement {
  settled: boolean;
  charge: ChargeRow;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Reconcile the refund service against the processor: allocate what the processor has refunded on each
 * charge to that charge's completed refunds, in the order they completed. A refund the allocation
 * cannot cover was marked sent but never reached the card.
 */
function reconcile(input: CollectInput): Map<string, Settlement> {
  const out = new Map<string, Settlement>();
  const completed = input.refunds
    .filter((r) => r.status === 'completed')
    .sort((a, b) => (ms(a.completedAt) ?? Infinity) - (ms(b.completedAt) ?? Infinity) || byId(a, b));
  const remaining = new Map<string, number>();
  for (const r of completed) {
    const charge = input.charges.find((c) => c.id === r.chargeId);
    if (!charge) continue;
    const left = remaining.get(charge.id) ?? charge.amountRefunded;
    const settled = left >= r.amount;
    if (settled) remaining.set(charge.id, left - r.amount);
    else remaining.set(charge.id, left);
    out.set(r.id, { settled, charge });
  }
  return out;
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

function refundState(r: ObservedRefund, receivedAt: number | null, disputed: number): { state: string; at: string } {
  switch (r.status) {
    case 'completed': {
      const done = ms(r.completedAt);
      // A completion with no date cannot be placed before or after the dispute.
      if (done === null || receivedAt === null) return { state: 'completed-date-unknown', at: r.requestedAt };
      return { state: done <= receivedAt ? 'completed-before-dispute' : 'completed-after-dispute', at: r.completedAt! };
    }
    case 'approved':
      // A person said yes but no money moved: the refund is owed. Owing less than the disputed amount is
      // not the same as the customer being right about all of it (review B6).
      return { state: r.amount < disputed ? 'partial-approved-not-completed' : 'approved-not-completed', at: r.approvedAt ?? r.requestedAt };
    case 'initiated':
      return { state: 'initiated', at: r.approvedAt ?? r.requestedAt };
    case 'declined':
      // The row keeps no decline time; the request is the latest recorded step.
      return { state: 'declined-per-policy', at: r.approvedAt ?? r.requestedAt };
    case 'requested':
      return { state: 'requested', at: r.requestedAt };
    case 'voided':
      // Cancelled because the chargeback was accepted and settles the amount: nothing is owed by refund.
      return { state: 'voided-settled-by-dispute', at: r.approvedAt ?? r.requestedAt };
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
    .sort(byId)
    .map((r) => {
      const { state, at } = refundState(r, received, input.dispute.amount);
      const meta: EvidenceItem['meta'] = { refundId: r.id, amount: r.amount };
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
        meta,
      };
    });
}

const dollars = (cents: number) => `${(cents / 100).toFixed(2)}`;

/**
 * The processor's view of each refund the refund service marked completed (review D1). Settled: the
 * processor refunded at least that amount on the charge. Not settled: the refund service says sent, but
 * the money never reached the card.
 */
function processorRefunds({ input, settlement }: Context): EvidenceItem[] {
  if (!settlement) return [];
  return [...input.refunds]
    .sort(byId)
    .flatMap((r) => {
      const s = settlement.get(r.id);
      if (!s) return [];
      const meta: EvidenceItem['meta'] = { refundId: r.id, amount: r.amount, chargeId: s.charge.id };
      if (r.linkedIncident) meta.linkedIncident = r.linkedIncident;
      if (r.linkedDeploy) meta.linkedDeploy = r.linkedDeploy;
      return [
        {
          id: `ev-processor-refund-${r.id}`,
          type: 'processor-refund' as const,
          state: s.settled ? 'settled' : 'not-settled',
          kind: 'fact' as const,
          source: { kind: 'sql' as const, key: `charges/${s.charge.id}`, title: `Charge ${s.charge.id} at the processor` },
          // A missing refund is an absence, dated like the others at the dispute's arrival.
          at: s.settled ? (s.charge.refundedAt ?? r.completedAt ?? r.requestedAt) : input.dispute.receivedAt,
          note: s.settled
            ? `The processor shows ${dollars(s.charge.amountRefunded)} refunded on ${s.charge.id}, covering ${r.id}.`
            : `The refund service marked ${r.id} (${dollars(r.amount)}) as sent${r.completedAt ? ` on ${r.completedAt.slice(0, 10)}` : ''}, but the processor shows ${dollars(s.charge.amountRefunded)} refunded on ${s.charge.id}.`,
          meta,
        },
      ];
    });
}

function orderPairs({ input }: Context): EvidenceItem[] {
  const disputed = input.charges.find((c) => c.id === input.dispute.chargeId);
  if (!disputed) return [];
  const others = input.charges
    .filter((c) => c.id !== disputed.id && c.amount === disputed.amount && c.currency === disputed.currency)
    .sort((a, b) => (a.chargedAt < b.chargedAt ? -1 : a.chargedAt > b.chargedAt ? 1 : a.id < b.id ? -1 : 1));
  if (others.length === 0) {
    // Recorded absence: the charges on this order, and the customer's same-amount charges within a week,
    // were read and there is no second one (review B7).
    return [
      {
        id: `ev-order-pair-only-${disputed.id}`,
        type: 'order-pair',
        state: 'only-charge',
        kind: 'fact',
        source: { kind: 'sql', key: `charges?order=${disputed.orderId}`, title: `Charges on ${disputed.orderId}` },
        at: input.dispute.receivedAt,
        note: `${disputed.id} is the only charge on ${disputed.orderId}, and the customer has no other charge of the same amount within 7 days.`,
      },
    ];
  }
  return others.map((other: ChargeRow) => {
    let state: string;
    let at = other.chargedAt;
    let note = `Disputed charge ${disputed.id} is on ${disputed.orderId}; this charge is on ${other.orderId}.`;
    const apart = Math.abs((ms(other.chargedAt) ?? 0) - (ms(disputed.chargedAt) ?? 0));
    if (other.orderId !== disputed.orderId) {
      // Two orders for the same amount minutes apart may be one purchase submitted twice (review B7).
      if (other.customerId === disputed.customerId && apart <= POSSIBLE_DUPLICATE_MS) {
        state = 'possible-duplicate';
        note = `${disputed.id} on ${disputed.orderId} and ${other.id} on ${other.orderId} are for the same amount, ${Math.round(apart / MINUTE_MS)} minutes apart. Check whether the customer meant to buy twice.`;
      } else {
        state = 'distinct';
      }
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
      note,
    };
  });
}

const CAUSED: Record<ObservedIncident['effect'], string> = {
  'duplicate-charges': 'caused-duplicate-charge',
  'dropped-refunds': 'caused-dropped-refund',
  other: 'caused-charge-problem',
};

/**
 * Whether every refund on this order linked to the incident has since been paid and settled (review B5).
 * Unknown settlement counts as still owed. No linked refund: the link came another way, so it stands.
 */
function repaired(incidentKey: string, { input, settlement }: Context): boolean {
  const linked = input.refunds.filter((r) => r.linkedIncident === incidentKey);
  if (linked.length === 0 || !settlement) return false;
  return linked.every((r) => r.status === 'completed' && settlement.get(r.id)?.settled === true);
}

function incidents(ctx: Context): EvidenceItem[] {
  const { input, reason, order } = ctx;
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
      const fixed = explicit && i.effect === 'dropped-refunds' && repaired(i.key, ctx);
      const causes = explicit && !fixed;
      const meta: EvidenceItem['meta'] = { windowStart: i.windowStart, windowEnd: i.windowEnd };
      // The incident-to-deploy link is explicit, but it only explains this dispute when the incident does.
      if (causes && i.linkedDeploy) meta.linkedDeploy = i.linkedDeploy;
      return {
        id: `ev-incident-${i.key}`,
        type: 'incident' as const,
        state: fixed ? 'dropped-refund-repaired' : causes ? CAUSED[i.effect] : 'unrelated',
        kind: 'fact' as const,
        source: { kind: 'jira' as const, key: i.key, title: i.title, ...(i.url ? { url: i.url } : {}) },
        at: i.windowStart,
        note: fixed
          ? 'Linked to this order, but the refund it dropped has since been paid and has reached the card. No longer a cause.'
          : causes
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

const present = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim().length > 0;
/** Two identifiers match only when both are present and equal: empty or missing never matches. */
const same = (a: string | null | undefined, b: string | null | undefined) => present(a) && present(b) && a === b;

/**
 * Visa Compelling Evidence 3.0 (review B8): two or more earlier transactions on the same card, each 120 to
 * 365 days before the dispute was received, never disputed or reported as fraud, and each sharing at least
 * two of IP address, device, account and shipping address with the disputed order, at least one of them
 * IP address or device. Each criterion is listed so the UI can tell a candidate from a qualified case.
 * Visa rules only: other networks get no item.
 */
function compellingEvidence({ input, order, customerId }: Context): EvidenceItem[] {
  if (!order) return [];
  const network = input.dispute.network ?? 'unknown';
  if (network !== 'visa' && network !== 'unknown') return [];
  const anchor = ms(input.dispute.receivedAt) ?? ms(order.purchasedAt)!;
  const tested = input.priorOrders.map((p) => {
    const t = ms(p.purchasedAt);
    const age = t === null ? null : (anchor - t) / DAY_MS;
    const ipOrDevice = same(p.ip, order.ip) || same(p.deviceId, order.deviceId);
    const shared = [same(p.ip, order.ip), same(p.deviceId, order.deviceId), same(p.accountId, order.accountId), same(p.shippingAddressHash, order.shippingAddressHash)].filter(Boolean).length;
    const checks = {
      'same-card': same(p.cardFingerprint, order.cardFingerprint),
      window: age !== null && age >= 120 && age <= 365,
      clean: !p.disputed && !p.fraudReported,
      identity: ipOrDevice && shared >= 2,
    };
    return { p, checks, all: Object.values(checks).every(Boolean) };
  });
  const count = (id: keyof (typeof tested)[number]['checks']) => tested.filter((x) => x.checks[id]).length;
  const LABELS: Record<keyof (typeof tested)[number]['checks'], string> = {
    'same-card': 'Earlier transactions on the same card',
    window: 'Made 120 to 365 days before the dispute',
    clean: 'Never disputed or reported as fraud',
    identity: 'Share two of IP address, device, account and shipping address, one of them IP address or device',
  };
  const criteria: EvidenceCriterion[] = (Object.keys(LABELS) as (keyof typeof LABELS)[]).map((id) => ({
    id,
    label: LABELS[id],
    passed: count(id) >= 2,
    detail: `${count(id)} of ${tested.length} earlier ${tested.length === 1 ? 'order' : 'orders'}`,
  }));
  const qualifying = tested.filter((x) => x.all).map((x) => x.p.id).sort();
  const state = qualifying.length >= 2 ? 'ce30-eligible' : count('identity') >= 2 ? 'ce30-candidate' : 'not-eligible';
  const failed = criteria.filter((c) => !c.passed).map((c) => c.label.toLowerCase());
  // Recorded absence when not eligible: the order history was read in full.
  return [
    {
      id: `ev-prior-orders-${order.id}`,
      type: 'prior-orders',
      state,
      kind: 'fact',
      source: { kind: 'sql', key: `orders?customer=${customerId ?? order.customerId}`, title: 'Earlier orders from this customer or card' },
      at: order.purchasedAt,
      note:
        state === 'ce30-eligible'
          ? `${qualifying.length} earlier transactions meet every Compelling Evidence 3.0 criterion: ${qualifying.join(', ')}.`
          : state === 'ce30-candidate'
            ? `Compelling Evidence 3.0 candidate: earlier orders look like the same person, but not every criterion is met (${failed.join('; ')}).`
            : 'Not enough earlier transactions meet the Compelling Evidence 3.0 criteria.',
      meta: { criteria },
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
      // The purchase date travels with the policy, so the in-force check runs without webhook metadata (B11).
      meta: { version: page.version, effectiveFrom: page.effectiveFrom, effectiveTo: page.effectiveTo, purchasedAt: order.purchasedAt },
    },
  ];
}

function customerMessages({ input, order }: Context): EvidenceItem[] {
  // Only tickets about this order count. A ticket whose order is unknown might be about it, so it is read;
  // one about another order is not this dispute's evidence (review B4).
  const orderId = order?.id ?? input.dispute.orderId;
  const about = input.tickets.filter((t) => t.orderId === null || orderId === null || t.orderId === orderId);
  const tickets = [...about].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.key < b.key ? -1 : 1));
  const items: EvidenceItem[] = [];
  for (const t of tickets) {
    t.messages.forEach((m, i) => {
      if (m.author !== 'customer') return;
      const seen = new Set<MessageLabel>();
      for (const match of classifyMessage(m.text)) {
        if (seen.has(match.label)) continue;
        seen.add(match.label);
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
  // Recorded absence: the customer has no ticket about this order at all, so they never raised a problem
  // with us (review B2). When tickets exist, nothing is inferred from what the lexicon did not find: a
  // person reads them. Still an inference, because it rests on tickets being filed against the right order.
  if (order && tickets.length === 0) {
    const elsewhere = input.tickets.length;
    items.push({
      id: `ev-no-complaint-${order.id}`,
      type: 'customer-message',
      state: 'no-complaint',
      kind: 'inference',
      source: { kind: 'jsm', key: `tickets?order=${order.id}`, title: 'Support tickets about this order' },
      at: input.dispute.receivedAt,
      note: `The customer has no support tickets about this order${elsewhere ? ` (${elsewhere} about other orders, not counted)` : ''}.`,
    });
  }
  return items;
}

const COLLECTORS: readonly ((ctx: Context) => EvidenceItem[])[] = [
  delivery,
  signature,
  description,
  refunds,
  processorRefunds,
  orderPairs,
  incidents,
  paymentChecks,
  compellingEvidence,
  cancellation,
  policy,
  customerMessages,
];

/** Which system each evidence type is read from, so unread sources contribute nothing. */
const SOURCE_OF: Record<EvidenceType, CollectSource> = {
  delivery: 'order',
  'delivery-signature': 'order',
  'product-description': 'order',
  'order-pair': 'order',
  '3ds': 'order',
  avs: 'order',
  cvv: 'order',
  'prior-orders': 'order',
  cancellation: 'order',
  'customer-message': 'tickets',
  refund: 'refunds',
  'processor-refund': 'settlements',
  incident: 'incidents',
  deploy: 'incidents',
  policy: 'policies',
};

export function collectEvidence(input: CollectInput): EvidenceItem[] {
  const reason = findReason(input.dispute.reasonCode)?.key ?? null;
  const pending = new Set(input.pending ?? []);
  const ctx: Context = {
    input,
    reason,
    order: input.order,
    customerId: input.dispute.customer ?? input.order?.customerId ?? null,
    settlement: pending.has('settlements') ? null : reconcile(input),
  };
  const relevant = (e: EvidenceItem) => reason === null || !ONLY_FOR[e.type] || ONLY_FOR[e.type]!.includes(reason);
  const read = (e: EvidenceItem) => !pending.has(SOURCE_OF[e.type]);
  // Collector order, then each collector's own sort, gives a stable exhibit order.
  return COLLECTORS.flatMap((collect) => collect(ctx)).filter(relevant).filter(read);
}
