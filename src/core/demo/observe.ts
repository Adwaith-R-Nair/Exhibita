// The reference observer: builds the CollectInput for each demo dispute straight from the DemoWorld.
// The platform fetchers read the same facts back from Forge SQL, Jira and Confluence after the wizard
// has written them, and must produce exactly this. Each field below says where its facts come from.

import { normalizeDisputeEvent } from '../intake/normalize';
import type {
  ChargeRow,
  CollectInput,
  DemoDispute,
  DemoIncident,
  DemoWorld,
  ObservedIncident,
  ObservedPolicyVersion,
  ObservedRefund,
  ObservedTicket,
  OrderRow,
  PriorOrder,
} from '../sources/types';
import type { Dispute } from '../types';

export type KeyKind = 'jira' | 'jsm' | 'confluence';

export interface WorldKeys {
  /** Jira key for each deploy and incident ref, JSM key for each ticket ref, Confluence page id for each policy ref. */
  keyOf: Readonly<Record<string, string>>;
  /** Browser URL for a key. Omit and observed records carry no URLs. */
  url?: (kind: KeyKind, key: string) => string;
}

export interface ObservedDispute {
  demo: DemoDispute;
  dispute: Dispute;
  input: CollectInput;
}

const DAY = 86_400_000;
const time = (iso: string) => Date.parse(iso);
const byTimeThenId = <T>(at: (x: T) => string, id: (x: T) => string) => (a: T, b: T) =>
  time(at(a)) - time(at(b)) || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);

/** Placeholder keys for tests and previews: DEP-1, INC-1, SUP-1 and page ids from 100001, in world order. */
export function demoKeys(world: DemoWorld, baseUrl = 'https://example.atlassian.net'): WorldKeys {
  const keyOf: Record<string, string> = {};
  world.deploys.forEach((d, i) => (keyOf[d.ref] = `DEP-${i + 1}`));
  world.incidents.forEach((d, i) => (keyOf[d.ref] = `INC-${i + 1}`));
  world.tickets.forEach((t, i) => (keyOf[t.ref] = `SUP-${i + 1}`));
  world.policies.forEach((p, i) => (keyOf[p.ref] = String(100001 + i)));
  return {
    keyOf,
    url: (kind, key) => (kind === 'confluence' ? `${baseUrl}/wiki/pages/viewpage.action?pageId=${key}` : `${baseUrl}/browse/${key}`),
  };
}

export function observeWorld(world: DemoWorld, keys: WorldKeys): ObservedDispute[] {
  const keyOf = (ref: string): string => {
    const key = keys.keyOf[ref];
    if (!key) throw new Error(`No key for demo record "${ref}". Create it before observing the world.`);
    return key;
  };
  const urlOf = (kind: KeyKind, key: string) => (keys.url ? { url: keys.url(kind, key) } : {});
  const incidentByRef = new Map(world.incidents.map((i) => [i.ref, i]));
  const disputedOrders = new Set(
    world.disputes.map((d) => normalizeDisputeEvent(d.payload, () => new Date(world.now))).flatMap((r) => (r.ok && r.dispute.orderId ? [r.dispute.orderId] : [])),
  );

  // Policies: every version of every Confluence policy page. One page per policy; its versions share the page id.
  const policies: ObservedPolicyVersion[] = world.policies.flatMap((p) =>
    p.versions.map((v) => ({
      pageId: keyOf(p.ref),
      title: p.title,
      ...urlOf('confluence', keyOf(p.ref)),
      kind: p.kind,
      version: v.version,
      effectiveFrom: v.effectiveFrom,
      effectiveTo: v.effectiveTo,
    })),
  );

  return world.disputes.map((demo) => {
    const normalised = normalizeDisputeEvent(demo.payload, () => new Date(world.now));
    if (!normalised.ok) throw new Error(`Demo dispute payload does not normalise: ${normalised.error}`);
    const dispute = normalised.dispute;

    // order: the orders row named by the webhook's metadata.order_id. Every other query starts from it,
    // so without one only the policies are read.
    const order = world.orders.find((o) => o.id === dispute.orderId) ?? null;
    if (!order) {
      const empty: CollectInput = { dispute, order: null, product: null, charges: [], refunds: [], priorOrders: [], tickets: [], incidents: [], policies };
      return { demo, dispute, input: empty };
    }
    // product: the products row for the order's sku.
    const product = world.products.find((p) => p.sku === order.sku) ?? null;
    const customerId = order.customerId;

    // charges: every charges row on the order, plus the customer's other charges of the same amount
    // within 7 days of the disputed charge.
    const disputedCharge = world.charges.find((c) => c.id === dispute.chargeId);
    const anchor = time(disputedCharge?.chargedAt ?? order.purchasedAt);
    const charges: ChargeRow[] = world.charges
      .filter(
        (c) =>
          c.orderId === order.id ||
          (c.customerId === customerId && c.amount === dispute.amount && Math.abs(time(c.chargedAt) - anchor) <= 7 * DAY),
      )
      .sort(byTimeThenId((c) => c.chargedAt, (c) => c.id));
    const orderChargeIds = new Set(charges.filter((c) => c.orderId === order.id).map((c) => c.id));

    // charges also carry the processor's view of refunds (amountRefunded), which the settlements stage
    // reconciles against the refunds rows below. Nothing else is read for it.
    //
    // refunds: refunds rows on the order. An incident is linked to a refund by an impact row naming it,
    // or by a Jira link from the incident to a ticket about that refund. Its deploy comes from the
    // incident's "caused by" link. ticketKey: the first ticket about the refund.
    const incidentForRefund = (refundId: string): DemoIncident | null => {
      const ref =
        world.impacts.find((i) => i.refundId === refundId)?.incidentRef ??
        world.tickets.find((t) => t.refundId === refundId && t.linkedIncidentRef)?.linkedIncidentRef ??
        null;
      return ref ? (incidentByRef.get(ref) ?? null) : null;
    };
    const refunds: ObservedRefund[] = world.refunds
      .filter((r) => r.orderId === order.id)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((r) => {
        const incident = incidentForRefund(r.id);
        const ticket = world.tickets.find((t) => t.refundId === r.id);
        const ticketKey = ticket ? keyOf(ticket.ref) : null;
        return {
          ...r,
          linkedIncident: incident ? keyOf(incident.ref) : null,
          linkedDeploy: incident?.causedByDeployRef ? keyOf(incident.causedByDeployRef) : null,
          ticketKey,
          ...(ticketKey && keys.url ? { ticketUrl: keys.url('jsm', ticketKey) } : {}),
        };
      });

    // priorOrders: orders bought before this one by the same customer or on the same card (Visa CE 3.0
    // is about the card, not the account); disputed when a dispute names that order.
    const sameCard = (o: OrderRow) => order.cardFingerprint !== null && o.cardFingerprint === order.cardFingerprint;
    const priorOrders: PriorOrder[] = world.orders
      .filter((o) => o.id !== order.id && (o.customerId === order.customerId || sameCard(o)) && time(o.purchasedAt) < time(order.purchasedAt))
      .sort(byTimeThenId((o) => o.purchasedAt, (o) => o.id))
      .map((o) => ({
        id: o.id,
        purchasedAt: o.purchasedAt,
        ip: o.ip,
        deviceId: o.deviceId,
        disputed: disputedOrders.has(o.id),
        cardFingerprint: o.cardFingerprint,
        accountId: o.accountId,
        shippingAddressHash: o.shippingAddressHash,
        fraudReported: o.fraudReported,
      }));

    // tickets: JSM tickets from the order's customer, with the description and comments as messages, and
    // the order each one is about (its "Order" field), so the collector can drop tickets about other orders.
    const tickets: ObservedTicket[] = world.tickets
      .filter((t) => t.customerId === customerId)
      .map((t) => ({ key: keyOf(t.ref), ...urlOf('jsm', keyOf(t.ref)), orderId: t.orderId, createdAt: t.createdAt, messages: t.messages }))
      .sort(byTimeThenId((t) => t.createdAt, (t) => t.key));

    // incidents: explicit when an impact row names a refund or charge on this order, or a linked ticket
    // is about this order's refund. Otherwise listed with link 'none' only if its window contains the purchase.
    const refundIds = new Set(refunds.map((r) => r.id));
    const explicit = new Set<string>([
      ...world.impacts.filter((i) => (i.refundId && refundIds.has(i.refundId)) || (i.chargeId && orderChargeIds.has(i.chargeId))).map((i) => i.incidentRef),
      ...world.tickets.filter((t) => t.linkedIncidentRef && t.refundId && refundIds.has(t.refundId)).map((t) => t.linkedIncidentRef!),
    ]);
    const purchased = time(order.purchasedAt);
    const overlaps = (i: DemoIncident) => time(i.windowStart) <= purchased && (i.windowEnd === null || purchased <= time(i.windowEnd));
    const incidents: ObservedIncident[] = world.incidents
      .filter((i) => explicit.has(i.ref) || overlaps(i))
      .map((i) => ({
        key: keyOf(i.ref),
        ...urlOf('jira', keyOf(i.ref)),
        title: i.title,
        effect: i.effect,
        windowStart: i.windowStart,
        windowEnd: i.windowEnd,
        linkedDeploy: i.causedByDeployRef ? keyOf(i.causedByDeployRef) : null,
        link: explicit.has(i.ref) ? ('explicit' as const) : ('none' as const),
      }))
      .sort(byTimeThenId((i) => i.windowStart, (i) => i.key));

    return { demo, dispute, input: { dispute, order, product, charges, refunds, priorOrders, tickets, incidents, policies } };
  });
}
