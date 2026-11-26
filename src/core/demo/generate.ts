// The demo world (docs/SPEC.md §3 and §8). Deterministic from (seed, now): a seeded PRNG picks names,
// products, amounts and times; every date is an offset from `now`, so deadlines stay in the future
// whenever the wizard runs. The story's shape (one hero, a cluster of 38, 212 customers not yet
// disputing, an unrelated incident, the other scenarios) holds for every seed.
//
// All data is synthetic (invariant 9). Money is integer cents in USD.

import type { ReasonKey, Recommendation } from '../types';
import { minor } from '../types';
import type {
  ChargeRow,
  CustomerRow,
  DemoDeploy,
  DemoDispute,
  DemoIncident,
  DemoPolicy,
  DemoTicket,
  DemoWorld,
  IncidentImpactRow,
  OrderRow,
  OutcomeRow,
  RefundRow,
  TicketMessage,
} from '../sources/types';
import {
  CARRIER,
  FIRST_NAMES,
  HERO_PRODUCT,
  HIGH_VALUE,
  LAST_NAMES,
  LOW_VALUE,
  MESSAGES,
  PHYSICAL,
  POLICY_BODIES,
  PRODUCTS,
  SUBSCRIPTIONS,
  type CatalogProduct,
  type MessageKey,
} from './catalog';
import { Rng } from './random';

export interface GenerateOptions {
  seed: number;
  /** Anchor time (ISO 8601). Every other date is relative to it. */
  now: string;
}

/** Stable refs for Jira and Confluence records. Their real keys are assigned when the wizard creates them. */
export const DEMO_REFS = {
  refundDeploy: 'deploy-refund-worker',
  refundIncident: 'incident-refund-worker',
  storefrontDeploy: 'deploy-storefront',
  storefrontIncident: 'incident-storefront',
  gatewayDeploy: 'deploy-payment-gateway',
  gatewayIncident: 'incident-payment-gateway',
  refundPolicy: 'policy-refund-returns',
  shippingPolicy: 'policy-shipping',
  cancellationPolicy: 'policy-cancellation',
} as const;

/** The numbers the story promises, for every seed. */
export const STORY = {
  /** The hero plus 37 more disputes whose refunds the refund-worker incident dropped. */
  clusterSize: 38,
  /** Customers whose refunds were dropped and who have not disputed. */
  notYetDisputed: 212,
  heroAmount: 24_900,
} as const;

/** The timeline, in days relative to now. */
const T = {
  policyStart: -400,
  policyV2: -40,
  refundDeploy: -34,
  refundWindow: [-34 + 1 / 48, -27] as const,
  storefrontDeploy: -24,
  storefrontWindow: [-24 + 1 / 96, -23] as const,
  gatewayDeploy: -20,
  gatewayWindow: [-20 + 1 / 144, -19 + 1 / 12] as const,
};

const INCIDENT_WINDOWS = [T.refundWindow, T.storefrontWindow, T.gatewayWindow];

const PROCESSOR_REASON: Record<ReasonKey, string> = {
  'visa-13.1': 'product_not_received',
  'visa-13.3': 'product_unacceptable',
  'visa-12.6.1': 'duplicate',
  'visa-10.4': 'fraudulent',
  'visa-13.2': 'subscription_canceled',
};

const DAY = 86_400_000;
const MINUTE = 60_000;
const pad = (n: number, width = 4) => String(n).padStart(width, '0');
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

interface PendingDispute {
  order: OrderRow;
  charge: ChargeRow;
  reason: ReasonKey;
  expected: Recommendation;
  scenario: string;
  receivedAt: string;
  hero?: boolean;
}

interface PendingTicket {
  customer: CustomerRow;
  orderId: string | null;
  summary: string;
  messages: TicketMessage[];
  refundId: string | null;
  linkedIncidentRef: string | null;
}

export function generateWorld({ seed, now }: GenerateOptions): DemoWorld {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw new RangeError(`now must be an ISO 8601 date, got ${now}`);
  const rng = new Rng(seed);

  // Whole minutes keep webhook timestamps (unix seconds) exact.
  const iso = (t: number) => new Date(Math.round(t / MINUTE) * MINUTE).toISOString();
  const day = (offset: number) => iso(nowMs + offset * DAY);
  const plus = (at: string, days: number) => iso(Date.parse(at) + days * DAY);
  const v2From = day(T.policyV2);
  const termsAt = (purchasedAt: string) => (Date.parse(purchasedAt) >= Date.parse(v2From) ? 'v2' : 'v1');

  const customers: CustomerRow[] = [];
  const orders: OrderRow[] = [];
  const charges: ChargeRow[] = [];
  const refunds: RefundRow[] = [];
  const impacts: IncidentImpactRow[] = [];
  const pendingTickets: PendingTicket[] = [];
  const pendingDisputes: PendingDispute[] = [];
  const devices = new Map<string, { ip: string; deviceId: string }>();

  const newCustomer = (): CustomerRow => {
    const n = customers.length + 1;
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const customer: CustomerRow = {
      id: `cus_demo_${pad(n)}`,
      name: `${first} ${last}`,
      email: `${first}.${last}.${n}@example.com`.toLowerCase(),
      createdAt: day(-rng.between(420, 900)),
    };
    customers.push(customer);
    // Documentation-only address ranges (RFC 5737), so no real network is named.
    devices.set(customer.id, { ip: `${rng.pick(['203.0.113', '198.51.100'])}.${rng.int(1, 254)}`, deviceId: `dev_${rng.hex(10)}` });
    return customer;
  };

  const newOrder = (customer: CustomerRow, product: CatalogProduct, purchasedAt: string, overrides: Partial<OrderRow> = {}): OrderRow => {
    const physical = product.row.kind === 'physical';
    const signed = physical && product.price >= 15_000;
    const device = devices.get(customer.id)!;
    const order: OrderRow = {
      id: `ORD-${10001 + orders.length}`,
      customerId: customer.id,
      sku: product.row.sku,
      amount: minor(product.price),
      currency: 'USD',
      purchasedAt,
      ip: device.ip,
      deviceId: device.deviceId,
      termsAcceptedVersion: termsAt(purchasedAt),
      carrier: physical ? CARRIER : null,
      tracking: physical ? `DPC${rng.digits(10)}` : null,
      shipStatus: physical ? 'delivered' : null,
      deliveredAt: physical ? plus(purchasedAt, rng.between(2, 5)) : null,
      addressMatch: physical ? true : null,
      // The shipping policy asks for a signature at $150 and over.
      signedBy: signed ? customer.name : null,
      signatureNameMatch: signed ? true : null,
      descriptionMatches: physical ? true : null,
      threeDS: rng.pick(['authenticated', 'attempted', 'not-attempted'] as const),
      avs: 'match',
      cvv: 'match',
      subscriptionCancelledAt: null,
      ...overrides,
    };
    orders.push(order);
    return order;
  };

  const newCharge = (order: OrderRow, chargedAt = order.purchasedAt, refundedAt: string | null = null): ChargeRow => {
    const charge: ChargeRow = {
      id: `ch_demo_${pad(charges.length + 1)}`,
      orderId: order.id,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
      chargedAt,
      refundedAt,
    };
    charges.push(charge);
    return charge;
  };

  const newRefund = (charge: ChargeRow, fields: Pick<RefundRow, 'status' | 'requestedAt'> & Partial<RefundRow>): RefundRow => {
    const refund: RefundRow = {
      id: `REF-${1001 + refunds.length}`,
      orderId: charge.orderId,
      chargeId: charge.id,
      amount: charge.amount,
      currency: charge.currency,
      approvedAt: null,
      completedAt: null,
      declineReason: null,
      ...fields,
    };
    refunds.push(refund);
    return refund;
  };

  const say = (key: MessageKey, at: string): TicketMessage => ({ author: 'customer', at, text: MESSAGES[key].text });
  const reply = (text: string, at: string): TicketMessage => ({ author: 'agent', at, text });
  const ticket = (t: Omit<PendingTicket, 'refundId' | 'linkedIncidentRef'> & Partial<PendingTicket>) =>
    pendingTickets.push({ refundId: null, linkedIncidentRef: null, ...t });

  const dispute = (d: Omit<PendingDispute, 'charge'> & { charge?: ChargeRow }) =>
    pendingDisputes.push({ ...d, charge: d.charge ?? charges.find((c) => c.orderId === d.order.id)! });

  /** Disputes arrive within the last two weeks. */
  const recently = (min = 0.5, max = 12) => day(-rng.between(min, max));

  /**
   * A time in [min, max) days from now that falls outside every incident window (with a margin), so
   * only the scenarios meant to overlap an incident pick up an "overlapped, not linked" note.
   */
  const quietDay = (min: number, max: number): string => {
    for (let tries = 0; tries < 1000; tries++) {
      const d = rng.between(min, max);
      if (!INCIDENT_WINDOWS.some(([start, end]) => d >= start - 0.25 && d <= end + 0.25)) return day(d);
    }
    throw new RangeError(`No quiet time between ${min} and ${max} days`);
  };

  /**
   * A fixed product mix in a seeded order. Which customer bought what changes with the seed; the totals
   * the story quotes (cluster amount, refunds owed) do not.
   */
  const productMix = (count: number) => rng.shuffle(Array.from({ length: count }, (_, i) => PHYSICAL[i % PHYSICAL.length]!));

  // -------------------------------------------------------------------------------------------------
  // The refund-worker incident: approved refunds marked approved but never sent to the processor.
  // -------------------------------------------------------------------------------------------------

  const refundOwed = (customer: CustomerRow, product: CatalogProduct) => {
    const approvedAt = day(T.refundWindow[0] + rng.between(0.1, 6.5));
    const requestedAt = plus(approvedAt, -rng.between(0.2, 1.5));
    const purchasedAt = plus(requestedAt, -rng.between(10, 18));
    const order = newOrder(customer, product, purchasedAt);
    const charge = newCharge(order);
    const refund = newRefund(charge, { status: 'approved', requestedAt, approvedAt });
    impacts.push({ incidentRef: DEMO_REFS.refundIncident, refundId: refund.id, chargeId: null });
    return { order, charge, refund };
  };

  const chase = (customer: CustomerRow, owed: ReturnType<typeof refundOwed>, key: MessageKey, after: [number, number]) =>
    ticket({
      customer,
      orderId: owed.order.id,
      summary: 'Approved refund has not arrived',
      messages: [say(key, plus(owed.refund.approvedAt!, rng.between(...after)))],
      refundId: owed.refund.id,
      linkedIncidentRef: DEMO_REFS.refundIncident,
    });

  // The hero. It looks defensible: delivered, as described, and the customer said they got it.
  {
    const customer = newCustomer();
    const owed = refundOwed(customer, HERO_PRODUCT);
    const { order, refund } = owed;
    const ack = plus(order.deliveredAt!, rng.between(0.1, 0.3));
    ticket({ customer, orderId: order.id, summary: 'Delivery confirmation', messages: [say('heroAck', ack)] });
    ticket({
      customer,
      orderId: order.id,
      summary: 'Return and refund for trail jacket',
      messages: [
        say('heroRefund', refund.requestedAt),
        reply(`Thanks for letting us know. Your refund of ${dollars(refund.amount)} has been approved and will reach your card within 5 business days.`, refund.approvedAt!),
        say('heroChase', plus(refund.approvedAt!, rng.between(12, 14))),
      ],
      refundId: refund.id,
      linkedIncidentRef: DEMO_REFS.refundIncident,
    });
    dispute({
      order,
      reason: 'visa-13.3',
      expected: 'accept',
      scenario: 'Hero: delivered and acknowledged, but an approved refund was dropped by the refund-worker incident',
      receivedAt: recently(1.5, 5),
      hero: true,
    });
  }

  // 37 more disputes from the same incident.
  const chaseKeys: MessageKey[] = ['chaseApproved', 'chaseWhere', 'chasePlease', 'chaseAccount'];
  const clusterProducts = productMix(STORY.clusterSize - 1);
  for (let i = 0; i < STORY.clusterSize - 1; i++) {
    const customer = newCustomer();
    const owed = refundOwed(customer, clusterProducts[i]!);
    if (i < 8) chase(customer, owed, chaseKeys[i % chaseKeys.length]!, [5, 12]);
    const reason = rng.pick(['visa-13.1', 'visa-13.3'] as const);
    dispute({
      order: owed.order,
      reason,
      expected: 'accept',
      scenario: `Cluster: ${reason === 'visa-13.1' ? 'item not received' : 'not as described'} after an approved refund was dropped`,
      receivedAt: recently(),
    });
  }

  // 212 affected customers who have not disputed (yet).
  const quietProducts = productMix(STORY.notYetDisputed);
  for (let i = 0; i < STORY.notYetDisputed; i++) {
    const customer = newCustomer();
    const owed = refundOwed(customer, quietProducts[i]!);
    if (i < 6) chase(customer, owed, chaseKeys[i % chaseKeys.length]!, [3, 20]);
    else if (i < 9) chase(customer, owed, i % 2 === 0 ? 'watcherBank' : 'watcherChargeback', [14, 24]);
  }

  // -------------------------------------------------------------------------------------------------
  // Other disputes, one scenario each.
  // -------------------------------------------------------------------------------------------------

  /** A new customer's delivered order, bought 16 to 26 days ago unless a purchase time is given; disputed in the last 6 days. */
  const placed = (product: CatalogProduct, overrides: Partial<OrderRow> = {}, purchasedAt?: string) => {
    const customer = newCustomer();
    const receivedAt = recently(0.5, 6);
    const order = newOrder(customer, product, purchasedAt ?? quietDay(-26.5, -16), overrides);
    newCharge(order);
    return { customer, order, receivedAt };
  };
  const ackAfterDelivery = (order: OrderRow) => plus(order.deliveredAt!, rng.between(0.1, 1));

  // Item not received (13.1).
  {
    // Bought under v1 of the refund policy and cites v1: the policy check passes.
    const v1Purchase = day(T.policyV2 - rng.between(4, 12));
    const { customer, order, receivedAt } = placed(rng.pick(LOW_VALUE), {}, v1Purchase);
    ticket({ customer, orderId: order.id, summary: 'Delivery confirmation', messages: [say('arrivedThanks', ackAfterDelivery(order))] });
    dispute({ order, reason: 'visa-13.1', expected: 'fight', scenario: 'Item not received: delivered, acknowledged, bought under policy v1', receivedAt });
  }
  {
    const { order, receivedAt } = placed(rng.pick(HIGH_VALUE));
    dispute({ order, reason: 'visa-13.1', expected: 'fight', scenario: 'Item not received: high value with signed proof of delivery', receivedAt });
  }
  {
    // Bought while the storefront incident was open, but nothing links them: no causal claim.
    const during = day(T.storefrontWindow[0] + rng.between(0.05, 0.9));
    const { customer, order, receivedAt } = placed(rng.pick(LOW_VALUE), {}, during);
    ticket({ customer, orderId: order.id, summary: 'Billing address', messages: [say('billingAddress', plus(order.deliveredAt!, 2))] });
    dispute({ order, reason: 'visa-13.1', expected: 'fight', scenario: 'Item not received: bought during an unrelated incident, no causal claim', receivedAt });
  }
  {
    const { order, receivedAt } = placed(rng.pick(LOW_VALUE), { carrier: null, tracking: null, shipStatus: null, deliveredAt: null, addressMatch: null });
    dispute({ order, reason: 'visa-13.1', expected: 'investigate', scenario: 'Item not received: missing proof of delivery, submit blocked', receivedAt });
  }
  {
    const { order, receivedAt } = placed(rng.pick(HIGH_VALUE), { signedBy: null, signatureNameMatch: null });
    dispute({ order, reason: 'visa-13.1', expected: 'investigate', scenario: 'Item not received: high value delivered without a signature', receivedAt });
  }
  {
    const { customer, order, receivedAt } = placed(rng.pick(LOW_VALUE));
    ticket({ customer, orderId: order.id, summary: 'Order not received', messages: [say('neverArrived', plus(order.deliveredAt!, rng.between(1, 3)))] });
    dispute({ order, reason: 'visa-13.1', expected: 'investigate', scenario: 'Item not received: tracking says delivered, customer says it never arrived', receivedAt });
  }
  {
    const { customer, order, receivedAt } = placed(rng.pick(LOW_VALUE), { addressMatch: false });
    ticket({ customer, orderId: order.id, summary: 'Delivered to the wrong address', messages: [say('wrongAddress', plus(order.deliveredAt!, rng.between(1, 3)))] });
    dispute({ order, reason: 'visa-13.1', expected: 'investigate', scenario: 'Item not received: delivered to a different address', receivedAt });
  }
  {
    const { order, receivedAt } = placed(rng.pick(HIGH_VALUE), { signedBy: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`, signatureNameMatch: false });
    dispute({ order, reason: 'visa-13.1', expected: 'investigate', scenario: 'Item not received: signed for by someone else', receivedAt });
  }
  {
    // The order records v2, which was not yet in force when the customer paid.
    const v1Purchase = day(T.policyV2 - rng.between(4, 10));
    const { order, receivedAt } = placed(rng.pick(LOW_VALUE), { termsAcceptedVersion: 'v2' }, v1Purchase);
    dispute({ order, reason: 'visa-13.1', expected: 'investigate', scenario: 'Item not received: cites policy v2, which was not in force at purchase', receivedAt });
  }

  // Not as described (13.3).
  {
    const { customer, order, receivedAt } = placed(rng.pick(PHYSICAL));
    ticket({ customer, orderId: order.id, summary: 'Delivery feedback', messages: [say('arrivedFine', ackAfterDelivery(order))] });
    dispute({ order, reason: 'visa-13.3', expected: 'fight', scenario: 'Not as described: matches the listing, customer acknowledged it, no complaint', receivedAt });
  }
  {
    const { customer, order, receivedAt } = placed(rng.pick(PHYSICAL));
    ticket({ customer, orderId: order.id, summary: 'Order received', messages: [say('receivedOrder', ackAfterDelivery(order))] });
    dispute({ order, reason: 'visa-13.3', expected: 'fight', scenario: 'Not as described: matches the listing, no complaint on record', receivedAt });
  }
  {
    const { order, receivedAt } = placed(rng.pick(PHYSICAL));
    const requestedAt = plus(order.deliveredAt!, rng.between(2, 4));
    const charge = charges.find((c) => c.orderId === order.id)!;
    // Requested through the returns portal, so there is no ticket; the payout started but has not landed.
    newRefund(charge, { status: 'initiated', requestedAt, approvedAt: plus(requestedAt, 1) });
    dispute({ order, reason: 'visa-13.3', expected: 'investigate', scenario: 'Not as described: refund initiated but not completed', receivedAt });
  }
  {
    const blender = PRODUCTS.find((p) => p.row.sku === 'SKU-BLENDER')!;
    const { customer, order, receivedAt } = placed(blender);
    ticket({ customer, orderId: order.id, summary: 'Blender stopped working', messages: [say('stoppedWorking', plus(order.deliveredAt!, rng.between(2, 4)))] });
    dispute({ order, reason: 'visa-13.3', expected: 'investigate', scenario: 'Not as described: the customer complained first', receivedAt });
  }
  {
    const { order, receivedAt } = placed(rng.pick(PHYSICAL), { descriptionMatches: false });
    dispute({ order, reason: 'visa-13.3', expected: 'investigate', scenario: 'Not as described: fulfilment shows it did not match the listing', receivedAt });
  }

  // Charged twice (12.6.1).
  {
    // A gateway retry charged the same order twice; the incident names the extra charge.
    const customer = newCustomer();
    const product = rng.pick(LOW_VALUE);
    const order = newOrder(customer, product, day(T.gatewayWindow[0] + rng.between(0.05, 0.9)));
    newCharge(order);
    const extra = newCharge(order, plus(order.purchasedAt, rng.int(2, 6) / 1440));
    impacts.push({ incidentRef: DEMO_REFS.gatewayIncident, refundId: null, chargeId: extra.id });
    ticket({ customer, orderId: order.id, summary: 'Charged twice', messages: [say('twoCharges', plus(order.purchasedAt, rng.between(1, 2)))] });
    dispute({ order, charge: extra, reason: 'visa-12.6.1', expected: 'accept', scenario: 'Charged twice: a true duplicate caused by the payment gateway incident', receivedAt: recently() });
  }
  {
    // Two orders for the same item two days apart: both are real.
    const customer = newCustomer();
    const product = rng.pick(LOW_VALUE);
    const during = day(T.storefrontWindow[0] + rng.between(0.05, 0.9));
    newCharge(newOrder(customer, product, plus(during, -rng.between(1, 3))));
    const order = newOrder(customer, product, during);
    newCharge(order);
    dispute({ order, reason: 'visa-12.6.1', expected: 'fight', scenario: 'Charged twice: two separate orders, bought during an unrelated incident', receivedAt: recently() });
  }
  {
    // A duplicate that was refunded before the customer disputed.
    const customer = newCustomer();
    const order = newOrder(customer, rng.pick(LOW_VALUE), quietDay(-26.5, -16));
    const first = newCharge(order);
    const refundedAt = plus(order.purchasedAt, rng.between(1, 2));
    const extra = newCharge(order, plus(order.purchasedAt, rng.int(2, 6) / 1440), refundedAt);
    newRefund(extra, { status: 'completed', requestedAt: plus(order.purchasedAt, 0.5), approvedAt: plus(order.purchasedAt, 0.6), completedAt: refundedAt });
    dispute({ order, charge: first, reason: 'visa-12.6.1', expected: 'fight', scenario: 'Charged twice: the duplicate was already refunded', receivedAt: recently() });
  }

  // Card-not-present fraud (10.4).
  {
    const { customer, order, receivedAt } = placed(rng.pick(PHYSICAL), { threeDS: 'authenticated' });
    ticket({ customer, orderId: null, summary: 'Gift wrapping', messages: [say('giftWrap', plus(order.purchasedAt, -rng.between(20, 60)))] });
    dispute({ order, reason: 'visa-10.4', expected: 'fight', scenario: 'Fraud: payment authenticated with 3-D Secure', receivedAt });
  }
  {
    const { customer, order, receivedAt } = placed(rng.pick(PHYSICAL), { threeDS: 'not-attempted' });
    // Earlier undisputed orders from the same device, 120 to 365 days before: Compelling Evidence 3.0.
    for (const age of [rng.between(130, 170), rng.between(200, 260), rng.between(290, 350)]) {
      newCharge(newOrder(customer, rng.pick(PHYSICAL), plus(order.purchasedAt, -age), { ip: `198.51.100.${rng.int(1, 254)}` }));
    }
    dispute({ order, reason: 'visa-10.4', expected: 'fight', scenario: 'Fraud: no 3-D Secure, but Compelling Evidence 3.0 history', receivedAt });
  }
  {
    const { customer, order, receivedAt } = placed(rng.pick(PHYSICAL), { threeDS: 'not-attempted', avs: 'mismatch' });
    // One old order is not enough, and a recent one is too new to count.
    newCharge(newOrder(customer, rng.pick(PHYSICAL), plus(order.purchasedAt, -rng.between(180, 250))));
    newCharge(newOrder(customer, rng.pick(PHYSICAL), plus(order.purchasedAt, -rng.between(30, 60))));
    dispute({ order, reason: 'visa-10.4', expected: 'investigate', scenario: 'Fraud: no 3-D Secure and not enough history', receivedAt });
  }

  // Cancelled subscription (13.2).
  {
    const customer = newCustomer();
    const renewal = quietDay(-25, -15);
    const order = newOrder(customer, rng.pick(SUBSCRIPTIONS), renewal, { subscriptionCancelledAt: plus(renewal, -rng.between(3, 10)) });
    newCharge(order);
    ticket({ customer, orderId: order.id, summary: 'Charged after cancelling', messages: [say('cancelledCharged', plus(renewal, rng.between(1, 3)))] });
    dispute({ order, reason: 'visa-13.2', expected: 'accept', scenario: 'Cancelled subscription: cancelled before the renewal charge', receivedAt: recently() });
  }
  {
    const customer = newCustomer();
    const renewal = quietDay(-25, -15);
    // Cancelled after this renewal, so the charge itself was valid.
    const order = newOrder(customer, rng.pick(SUBSCRIPTIONS), renewal, { subscriptionCancelledAt: plus(renewal, rng.between(2, 5)) });
    newCharge(order);
    dispute({ order, reason: 'visa-13.2', expected: 'fight', scenario: 'Cancelled subscription: cancelled only after the renewal charge', receivedAt: recently() });
  }

  // -------------------------------------------------------------------------------------------------
  // Jira, Confluence and history.
  // -------------------------------------------------------------------------------------------------

  const deploys: DemoDeploy[] = [
    {
      ref: DEMO_REFS.refundDeploy,
      title: 'Deploy refund-worker 3.2',
      description: 'Moves refund payouts from the inline worker to a batched payout queue.',
      at: day(T.refundDeploy),
    },
    {
      ref: DEMO_REFS.storefrontDeploy,
      title: 'Deploy storefront 5.1',
      description: 'New product image carousel on the checkout and product pages.',
      at: day(T.storefrontDeploy),
    },
    {
      ref: DEMO_REFS.gatewayDeploy,
      title: 'Deploy payment-gateway 2.8',
      description: 'Adds automatic retries for payment requests that time out.',
      at: day(T.gatewayDeploy),
    },
  ];

  const incidents: DemoIncident[] = [
    {
      ref: DEMO_REFS.refundIncident,
      title: 'Refund worker dropped approved refunds',
      description:
        'After refund-worker 3.2, refunds approved by support were marked approved but never sent to the processor. The affected refunds are listed in the incident impact table.',
      effect: 'dropped-refunds',
      windowStart: day(T.refundWindow[0]),
      windowEnd: day(T.refundWindow[1]),
      causedByDeployRef: DEMO_REFS.refundDeploy,
    },
    {
      ref: DEMO_REFS.storefrontIncident,
      title: 'Checkout pages slow to load',
      description: 'Product images on checkout loaded slowly for about a day. No payments, orders or refunds were affected.',
      effect: 'other',
      windowStart: day(T.storefrontWindow[0]),
      windowEnd: day(T.storefrontWindow[1]),
      causedByDeployRef: DEMO_REFS.storefrontDeploy,
    },
    {
      ref: DEMO_REFS.gatewayIncident,
      title: 'Payment retries charged some customers twice',
      description: 'Timed-out payment requests were retried even when the first attempt had succeeded. Affected charges are listed in the impact table.',
      effect: 'duplicate-charges',
      windowStart: day(T.gatewayWindow[0]),
      windowEnd: day(T.gatewayWindow[1]),
      causedByDeployRef: DEMO_REFS.gatewayDeploy,
    },
  ];

  const policies: DemoPolicy[] = [
    {
      ref: DEMO_REFS.refundPolicy,
      kind: 'refund-returns',
      title: 'Refund & Returns Policy',
      versions: [
        { version: 'v1', effectiveFrom: day(T.policyStart), effectiveTo: v2From, body: POLICY_BODIES.refundV1 },
        { version: 'v2', effectiveFrom: v2From, effectiveTo: null, body: POLICY_BODIES.refundV2 },
      ],
    },
    {
      ref: DEMO_REFS.shippingPolicy,
      kind: 'shipping',
      title: 'Shipping Policy',
      versions: [{ version: 'v1', effectiveFrom: day(T.policyStart), effectiveTo: null, body: POLICY_BODIES.shipping }],
    },
    {
      ref: DEMO_REFS.cancellationPolicy,
      kind: 'cancellation',
      title: 'Cancellation Policy',
      versions: [{ version: 'v1', effectiveFrom: day(T.policyStart), effectiveTo: null, body: POLICY_BODIES.cancellation }],
    },
  ];

  // Tickets get refs in time order, so their keys read chronologically once created.
  const tickets: DemoTicket[] = pendingTickets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.messages[0]!.at < b.t.messages[0]!.at ? -1 : a.t.messages[0]!.at > b.t.messages[0]!.at ? 1 : a.i - b.i))
    .map(({ t }, n) => ({
      ref: `ticket-${pad(n + 1, 2)}`,
      customerId: t.customer.id,
      orderId: t.orderId,
      summary: t.summary,
      createdAt: t.messages[0]!.at,
      messages: t.messages,
      refundId: t.refundId,
      linkedIncidentRef: t.linkedIncidentRef,
    }));

  // The queue arrives in a seeded order, not in the order scenarios were written.
  const disputes: DemoDispute[] = rng.shuffle(pendingDisputes).map((d, i) => {
    const received = Math.floor(Date.parse(d.receivedAt) / 1000);
    const dueBy = Math.floor((nowMs + rng.between(5, 18) * DAY) / 1000);
    return {
      payload: {
        id: `evt_demo_${pad(i + 1)}`,
        object: 'event',
        type: 'charge.dispute.created',
        created: received,
        data: {
          object: {
            id: `dp_demo_${pad(i + 1)}`,
            object: 'dispute',
            amount: d.charge.amount,
            currency: 'usd',
            reason: PROCESSOR_REASON[d.reason],
            status: 'needs_response',
            charge: d.charge.id,
            created: received,
            evidence_details: { due_by: dueBy },
            metadata: { order_id: d.order.id, customer: d.order.customerId, purchased_at: d.order.purchasedAt },
          },
        },
      },
      reasonCode: d.reason,
      expected: d.expected,
      scenario: d.scenario,
      ...(d.hero ? { hero: true } : {}),
    };
  });

  return {
    seed,
    now: new Date(nowMs).toISOString(),
    customers,
    products: PRODUCTS.map((p) => p.row),
    orders,
    charges,
    refunds,
    deploys,
    incidents,
    impacts,
    tickets,
    policies,
    disputes,
    outcomes: generateOutcomes(rng, day),
  };
}

// -------------------------------------------------------------------------------------------------
// Historical outcomes, for "why are we losing?". The counts are fixed so the pattern holds for every
// seed: most lost item-not-received disputes were orders over $150 with no signed proof of delivery.
// -------------------------------------------------------------------------------------------------

type Value = 'high' | 'low' | 'subscription' | 'any';

const OUTCOME_PLAN: readonly {
  reason: ReasonKey;
  count: number;
  result: OutcomeRow['result'];
  value: Value;
  lossReason?: string;
}[] = [
  { reason: 'visa-13.1', count: 18, result: 'lost', value: 'high', lossReason: 'No signed proof of delivery on an order over $150' },
  { reason: 'visa-13.1', count: 4, result: 'won', value: 'high' },
  { reason: 'visa-13.1', count: 14, result: 'won', value: 'low' },
  { reason: 'visa-13.1', count: 4, result: 'lost', value: 'low', lossReason: "Tracking did not show delivery to the cardholder's address" },
  { reason: 'visa-13.1', count: 8, result: 'accepted', value: 'any' },
  { reason: 'visa-13.3', count: 12, result: 'won', value: 'any' },
  { reason: 'visa-13.3', count: 6, result: 'lost', value: 'any', lossReason: 'The customer complained before disputing and the complaint was not answered' },
  { reason: 'visa-13.3', count: 6, result: 'accepted', value: 'any' },
  { reason: 'visa-10.4', count: 12, result: 'won', value: 'any' },
  { reason: 'visa-10.4', count: 7, result: 'lost', value: 'any', lossReason: 'No 3-D Secure and no Compelling Evidence 3.0 history' },
  { reason: 'visa-10.4', count: 5, result: 'accepted', value: 'any' },
  { reason: 'visa-12.6.1', count: 6, result: 'won', value: 'low' },
  { reason: 'visa-12.6.1', count: 3, result: 'lost', value: 'low', lossReason: 'The second charge had not been refunded' },
  { reason: 'visa-12.6.1', count: 7, result: 'accepted', value: 'low' },
  { reason: 'visa-13.2', count: 3, result: 'won', value: 'subscription' },
  { reason: 'visa-13.2', count: 2, result: 'lost', value: 'subscription', lossReason: 'The cancellation request was on file before the charge' },
  { reason: 'visa-13.2', count: 3, result: 'accepted', value: 'subscription' },
];

const VALUE_POOL: Record<Value, readonly CatalogProduct[]> = {
  high: HIGH_VALUE,
  low: LOW_VALUE,
  subscription: SUBSCRIPTIONS,
  any: PHYSICAL,
};

function generateOutcomes(rng: Rng, day: (offset: number) => string): OutcomeRow[] {
  const rows = OUTCOME_PLAN.flatMap((p) =>
    Array.from({ length: p.count }, () => ({
      reasonCode: p.reason,
      amount: minor(rng.pick(VALUE_POOL[p.value]).price),
      currency: 'USD',
      decision: p.result === 'accepted' ? ('accepted' as const) : ('fought' as const),
      result: p.result,
      closedAt: day(-rng.between(45, 400)),
      lossReason: p.lossReason ?? null,
    })),
  );
  return rows
    .sort((a, b) => (a.closedAt < b.closedAt ? -1 : a.closedAt > b.closedAt ? 1 : 0))
    .map((r, i) => ({ disputeId: `dp_hist_${pad(i + 1)}`, ...r }));
}
