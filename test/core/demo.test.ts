import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyMessage } from '../../src/core/classify/lexicon';
import { DEMO_REFS, STORY, generateWorld } from '../../src/core/demo';
import { MESSAGES } from '../../src/core/demo/catalog';
import { normalizeDisputeEvent } from '../../src/core/intake/normalize';
import type { DemoWorld } from '../../src/core/sources/types';

const NOW = '2026-11-26T09:00:00.000Z';
const DAY = 86_400_000;
const world = generateWorld({ seed: 7, now: NOW });

const disputed = (w: DemoWorld) =>
  w.disputes.map((d) => {
    const r = normalizeDisputeEvent(d.payload);
    if (!r.ok) throw new Error(r.error);
    return r.dispute;
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('generateWorld: determinism', () => {
  it('gives the same world for the same seed and now', () => {
    expect(generateWorld({ seed: 7, now: NOW })).toEqual(world);
  });

  it('gives a different world for a different seed', () => {
    expect(generateWorld({ seed: 8, now: NOW })).not.toEqual(world);
  });

  it('never reads Math.random or the clock', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random was called');
    });
    vi.useFakeTimers({ now: new Date('2020-01-01T00:00:00Z') });
    const early = generateWorld({ seed: 7, now: NOW });
    vi.setSystemTime(new Date('2031-06-01T00:00:00Z'));
    expect(generateWorld({ seed: 7, now: NOW })).toEqual(early);
  });

  it('places every date relative to now', () => {
    const later = generateWorld({ seed: 7, now: new Date(Date.parse(NOW) + 10 * DAY).toISOString() });
    world.orders.forEach((o, i) => {
      expect(Date.parse(later.orders[i]!.purchasedAt) - Date.parse(o.purchasedAt)).toBe(10 * DAY);
    });
  });

  it('rejects an invalid now', () => {
    expect(() => generateWorld({ seed: 1, now: 'not a date' })).toThrow(RangeError);
  });
});

describe('generateWorld: volumes', () => {
  it('keeps Jira and Confluence volume modest', () => {
    expect(world.disputes).toHaveLength(STORY.disputes);
    expect(world.tickets.length).toBeGreaterThanOrEqual(25);
    expect(world.tickets.length).toBeLessThanOrEqual(35);
    expect(world.incidents).toHaveLength(3);
    expect(world.deploys).toHaveLength(3);
    expect(world.policies).toHaveLength(3);
    expect(world.outcomes).toHaveLength(120);
  });
});

describe('generateWorld: disputes', () => {
  const disputes = disputed(world);

  it('has exactly one hero: $249.00 on a Visa card, credit not processed, expected accept', () => {
    const heroes = world.disputes.filter((d) => d.hero);
    expect(heroes).toHaveLength(1);
    const hero = disputes[world.disputes.indexOf(heroes[0]!)]!;
    expect(hero).toMatchObject({
      amount: 24_900,
      currency: 'USD',
      reasonCode: 'visa-13.6',
      processorReason: 'credit_not_processed',
      network: 'visa',
      networkReasonCode: '13.6',
    });
    expect(heroes[0]!.expected).toBe('accept');
  });

  it('puts the card brand and network reason code on every payload, with one Mastercard dispute', () => {
    for (const d of disputes) {
      const order = world.orders.find((o) => o.id === d.orderId)!;
      expect(d.network).toBe(order.cardNetwork);
      expect(d.networkReasonCode).toBeTruthy();
    }
    expect(disputes.filter((d) => d.network === 'mastercard')).toHaveLength(1);
  });

  it('keeps the queue mixed: the cluster accepts, and the other scenarios mostly fight or investigate', () => {
    const count = (r: string) => world.disputes.filter((d) => d.expected === r).length;
    expect(count('accept')).toBe(STORY.clusterSize + 2);
    expect(count('fight')).toBeGreaterThanOrEqual(12);
    expect(count('investigate')).toBeGreaterThanOrEqual(11);
  });

  it('sends Stripe-compatible payloads that normalise cleanly', () => {
    world.disputes.forEach((d, i) => {
      const n = disputes[i]!;
      expect(n.reasonCode).toBe(d.reasonCode);
      expect(n.externalId).toMatch(/^dp_demo_\d{4}$/);
      expect(n.chargeId).toMatch(/^ch_demo_\d{4}$/);
      expect(n.orderId).toMatch(/^ORD-\d+$/);
      expect(n.customer).toMatch(/^cus_demo_\d{4}$/);
      expect(n.purchasedAt).toBeTruthy();
    });
    expect(new Set(disputes.map((d) => d.externalId)).size).toBe(disputes.length);
  });

  it('puts every respond-by deadline 5 to 18 days in the future, and every arrival in the past', () => {
    const now = Date.parse(NOW);
    for (const d of disputes) {
      const due = Date.parse(d.respondBy!);
      expect(due - now).toBeGreaterThanOrEqual(5 * DAY);
      expect(due - now).toBeLessThanOrEqual(18 * DAY);
      expect(Date.parse(d.receivedAt)).toBeLessThan(now);
      expect(Date.parse(d.purchasedAt!)).toBeLessThan(Date.parse(d.receivedAt));
    }
  });

  it('matches each dispute to its order, charge and customer', () => {
    for (const d of disputes) {
      const order = world.orders.find((o) => o.id === d.orderId)!;
      const charge = world.charges.find((c) => c.id === d.chargeId)!;
      expect(order.customerId).toBe(d.customer);
      expect(charge.orderId).toBe(order.id);
      expect(charge.amount).toBe(d.amount);
      expect(order.purchasedAt).toBe(d.purchasedAt);
    }
  });

  it('covers every reason and every recommendation', () => {
    expect(new Set(world.disputes.map((d) => d.reasonCode))).toEqual(
      new Set(['visa-13.1', 'visa-13.3', 'visa-12.6.1', 'visa-10.4', 'visa-13.2', 'visa-13.6']),
    );
    expect(new Set(world.disputes.map((d) => d.expected))).toEqual(new Set(['fight', 'accept', 'investigate']));
  });
});

describe('generateWorld: the incident story', () => {
  const impacts = world.impacts.filter((i) => i.incidentRef === DEMO_REFS.refundIncident);
  const refunds = impacts.map((i) => world.refunds.find((r) => r.id === i.refundId)!);
  const incident = world.incidents.find((i) => i.ref === DEMO_REFS.refundIncident)!;
  const disputedOrders = new Set(disputed(world).map((d) => d.orderId));

  it('marks refunds as sent during the incident window without sending them, caused by the refund-worker deploy', () => {
    expect(incident.effect).toBe('dropped-refunds');
    expect(incident.title).toBe('Refund worker marked refunds as sent without sending them');
    expect(incident.causedByDeployRef).toBe(DEMO_REFS.refundDeploy);
    expect(refunds).toHaveLength(STORY.clusterSize + STORY.notYetDisputed);
    for (const r of refunds) {
      // The refund service says completed...
      expect(r.status).toBe('completed');
      expect(Date.parse(r.completedAt!)).toBeGreaterThanOrEqual(Date.parse(incident.windowStart));
      expect(Date.parse(r.completedAt!)).toBeLessThanOrEqual(Date.parse(incident.windowEnd!));
      // ...but the processor never refunded the charge.
      const charge = world.charges.find((c) => c.id === r.chargeId)!;
      expect(charge).toMatchObject({ amountRefunded: 0, refundedAt: null });
    }
  });

  it('gives every completed refund outside the incident a matching processor refund', () => {
    const incidentRefunds = new Set(refunds.map((r) => r.id));
    for (const r of world.refunds.filter((x) => x.status === 'completed' && !incidentRefunds.has(x.id))) {
      expect(world.charges.find((c) => c.id === r.chargeId)!.amountRefunded).toBeGreaterThanOrEqual(r.amount);
    }
  });

  it('has 38 affected disputes and 212 affected customers who have not disputed', () => {
    const orders = refunds.map((r) => world.orders.find((o) => o.id === r.orderId)!);
    expect(orders.filter((o) => disputedOrders.has(o.id))).toHaveLength(STORY.clusterSize);
    const quiet = orders.filter((o) => !disputedOrders.has(o.id));
    expect(new Set(quiet.map((o) => o.customerId)).size).toBe(STORY.notYetDisputed);
  });

  it('records the hero refund on a ticket linked to the incident', () => {
    const linked = world.tickets.filter((t) => t.linkedIncidentRef === DEMO_REFS.refundIncident && t.refundId);
    expect(linked.length).toBeGreaterThan(0);
    for (const t of linked) expect(refunds.map((r) => r.id)).toContain(t.refundId);
  });

  it('has an unrelated incident with no impact rows that overlaps a disputed purchase', () => {
    const unrelated = world.incidents.find((i) => i.ref === DEMO_REFS.storefrontIncident)!;
    expect(world.impacts.filter((i) => i.incidentRef === unrelated.ref)).toEqual([]);
    const overlapping = disputed(world).filter(
      (d) => Date.parse(d.purchasedAt!) >= Date.parse(unrelated.windowStart) && Date.parse(d.purchasedAt!) <= Date.parse(unrelated.windowEnd!),
    );
    expect(overlapping.length).toBeGreaterThan(0);
  });
});

describe('generateWorld: records', () => {
  it('is synthetic: example.com emails, whole cents, USD', () => {
    for (const c of world.customers) expect(c.email).toMatch(/@example\.com$/);
    for (const row of [...world.orders, ...world.charges, ...world.refunds, ...world.outcomes]) {
      expect(Number.isInteger(row.amount)).toBe(true);
      expect(row.currency).toBe('USD');
    }
  });

  it('records who paid: card, network, account and shipping address on every order', () => {
    for (const o of world.orders) {
      expect(o.cardFingerprint).toMatch(/^card_/);
      expect(['visa', 'mastercard']).toContain(o.cardNetwork);
      expect(o.accountId).toMatch(/^acct_/);
      expect(o.fraudReported).toBe(false);
    }
  });

  it('only references records that exist', () => {
    const ids = (xs: { id: string }[]) => new Set(xs.map((x) => x.id));
    const refs = (xs: { ref: string }[]) => new Set(xs.map((x) => x.ref));
    const customers = ids(world.customers);
    const orders = ids(world.orders);
    const charges = ids(world.charges);
    const refunds = ids(world.refunds);
    const skus = new Set(world.products.map((p) => p.sku));
    for (const o of world.orders) {
      expect(customers.has(o.customerId)).toBe(true);
      expect(skus.has(o.sku)).toBe(true);
    }
    for (const c of world.charges) expect(orders.has(c.orderId)).toBe(true);
    for (const r of world.refunds) expect(charges.has(r.chargeId)).toBe(true);
    for (const i of world.impacts) {
      expect(refs(world.incidents).has(i.incidentRef)).toBe(true);
      if (i.refundId) expect(refunds.has(i.refundId)).toBe(true);
      if (i.chargeId) expect(charges.has(i.chargeId)).toBe(true);
    }
    for (const i of world.incidents) if (i.causedByDeployRef) expect(refs(world.deploys).has(i.causedByDeployRef)).toBe(true);
    for (const t of world.tickets) {
      expect(customers.has(t.customerId)).toBe(true);
      if (t.orderId) expect(orders.has(t.orderId)).toBe(true);
      if (t.refundId) expect(refunds.has(t.refundId)).toBe(true);
      if (t.linkedIncidentRef) expect(refs(world.incidents).has(t.linkedIncidentRef)).toBe(true);
    }
  });

  it('gives each customer message the label the lexicon really finds', () => {
    const templates = Object.values(MESSAGES);
    for (const t of world.tickets) {
      for (const m of t.messages.filter((x) => x.author === 'customer')) {
        const template = templates.find((x) => x.text === m.text);
        expect(template, m.text).toBeDefined();
        const got = [...new Set(classifyMessage(m.text).map((x) => x.label))].sort();
        expect(got, m.text).toEqual([...template!.labels].sort());
      }
    }
  });

  it('keeps ticket messages in time order and starts each ticket with a customer message', () => {
    for (const t of world.tickets) {
      expect(t.messages[0]!.author).toBe('customer');
      expect(t.createdAt).toBe(t.messages[0]!.at);
      const times = t.messages.map((m) => m.at);
      expect([...times].sort()).toEqual(times);
    }
  });

  it('changes the refund policy from v1 to v2 about 40 days before now', () => {
    const policy = world.policies.find((p) => p.kind === 'refund-returns')!;
    expect(policy.title).toBe('Refund & Returns Policy');
    expect(policy.versions.map((v) => v.version)).toEqual(['v1', 'v2']);
    expect(policy.versions[0]!.effectiveTo).toBe(policy.versions[1]!.effectiveFrom);
    expect(Date.parse(NOW) - Date.parse(policy.versions[1]!.effectiveFrom)).toBe(40 * DAY);
    expect(policy.versions[1]!.effectiveTo).toBeNull();
    expect(world.policies.map((p) => p.title).sort()).toEqual(['Cancellation Policy', 'Refund & Returns Policy', 'Shipping Policy']);
  });

  it('records the policy version in force at purchase on most orders', () => {
    const [v1, v2] = world.policies.find((p) => p.kind === 'refund-returns')!.versions;
    const inForce = (iso: string) => (Date.parse(iso) >= Date.parse(v2!.effectiveFrom) ? 'v2' : 'v1');
    const wrong = world.orders.filter((o) => o.termsAcceptedVersion !== inForce(o.purchasedAt));
    expect(wrong).toHaveLength(1);
    expect(v1!.version).toBe('v1');
  });

  it('shows a pattern in past outcomes: most lost item-not-received disputes lacked a signed POD over $150', () => {
    const lost131 = world.outcomes.filter((o) => o.reasonCode === 'visa-13.1' && o.result === 'lost');
    const noPod = lost131.filter((o) => o.amount >= 15_000 && /signed proof of delivery/i.test(o.lossReason ?? ''));
    expect(noPod.length / lost131.length).toBeGreaterThan(0.7);
    for (const o of world.outcomes) {
      expect(o.result === 'accepted').toBe(o.decision === 'accepted');
      expect(o.lossReason === null).toBe(o.result !== 'lost');
      expect(Date.parse(o.closedAt)).toBeLessThan(Date.parse(NOW));
    }
  });
});
