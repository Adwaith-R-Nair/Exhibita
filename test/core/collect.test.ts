import { describe, expect, it } from 'vitest';
import { collectEvidence } from '../../src/core/collect';
import type {
  ChargeRow,
  CollectInput,
  ObservedIncident,
  ObservedPolicyVersion,
  ObservedRefund,
  ObservedTicket,
  OrderRow,
  PriorOrder,
  ProductRow,
} from '../../src/core/sources/types';
import { minor, type Dispute, type EvidenceItem } from '../../src/core/types';

const PURCHASED = '2026-10-01T12:00:00.000Z';
const RECEIVED = '2026-11-20T00:00:00.000Z';

const dispute = (reasonCode: string, overrides: Partial<Dispute> = {}): Dispute => ({
  externalId: 'dp_demo_0001',
  chargeId: 'ch_demo_0001',
  orderId: 'ORD-10001',
  customer: 'cus_demo_0001',
  amount: minor(8900),
  currency: 'USD',
  processorReason: 'test',
  reasonCode,
  respondBy: '2026-12-04T00:00:00.000Z',
  receivedAt: RECEIVED,
  purchasedAt: PURCHASED,
  ...overrides,
});

const order = (overrides: Partial<OrderRow> = {}): OrderRow => ({
  id: 'ORD-10001',
  customerId: 'cus_demo_0001',
  sku: 'SKU-LAMP',
  amount: minor(8900),
  currency: 'USD',
  purchasedAt: PURCHASED,
  ip: '203.0.113.10',
  deviceId: 'dev_a',
  termsAcceptedVersion: null,
  carrier: 'Demo Parcel Co.',
  tracking: 'DPC0000000001',
  shipStatus: 'delivered',
  deliveredAt: '2026-10-04T15:00:00.000Z',
  addressMatch: true,
  signedBy: null,
  signatureNameMatch: null,
  descriptionMatches: null,
  threeDS: 'not-attempted',
  avs: 'match',
  cvv: 'match',
  subscriptionCancelledAt: null,
  cardFingerprint: 'card_a',
  cardNetwork: 'visa',
  accountId: 'acct_a',
  shippingAddressHash: 'addr_a',
  fraudReported: false,
  ...overrides,
});

const product: ProductRow = { sku: 'SKU-LAMP', name: 'Cordless desk lamp', description: 'A lamp.', kind: 'physical' };

const charge = (overrides: Partial<ChargeRow> = {}): ChargeRow => ({
  id: 'ch_demo_0001',
  orderId: 'ORD-10001',
  customerId: 'cus_demo_0001',
  amount: minor(8900),
  currency: 'USD',
  chargedAt: PURCHASED,
  refundedAt: null,
  amountRefunded: minor(0),
  ...overrides,
});

const refund = (overrides: Partial<ObservedRefund> = {}): ObservedRefund => ({
  id: 'REF-1001',
  orderId: 'ORD-10001',
  chargeId: 'ch_demo_0001',
  amount: minor(8900),
  currency: 'USD',
  status: 'approved',
  requestedAt: '2026-10-10T00:00:00.000Z',
  approvedAt: '2026-10-11T00:00:00.000Z',
  completedAt: null,
  declineReason: null,
  linkedIncident: null,
  linkedDeploy: null,
  ticketKey: null,
  ...overrides,
});

const input = (reasonCode: string, overrides: Partial<CollectInput> = {}): CollectInput => ({
  dispute: dispute(reasonCode),
  order: order(),
  product,
  charges: [charge()],
  refunds: [],
  priorOrders: [],
  tickets: [],
  incidents: [],
  policies: [],
  ...overrides,
});

const ofType = (items: EvidenceItem[], type: EvidenceItem['type']) => items.filter((e) => e.type === type);
const one = (items: EvidenceItem[], type: EvidenceItem['type']) => {
  const found = ofType(items, type);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe('collectEvidence: provenance and determinism', () => {
  it('gives every item a source, a timestamp, a state and a kind', () => {
    const items = collectEvidence(input('visa-13.1', { refunds: [refund()] }));
    expect(items.length).toBeGreaterThan(0);
    for (const e of items) {
      expect(e.source.kind).toBeTruthy();
      expect(e.source.key).toBeTruthy();
      expect(Number.isNaN(Date.parse(e.at))).toBe(false);
      expect(e.state).toBeTruthy();
      expect(['fact', 'inference']).toContain(e.kind);
    }
  });

  it('is deterministic, with stable ids that do not repeat', () => {
    const a = collectEvidence(input('visa-13.1', { refunds: [refund()] }));
    const b = collectEvidence(input('visa-13.1', { refunds: [refund()] }));
    expect(a).toEqual(b);
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length);
    expect(one(a, 'delivery').id).toBe('ev-delivery-ORD-10001');
    expect(one(a, 'refund').id).toBe('ev-refund-REF-1001');
  });

  it('invents nothing, not even a recorded absence, when there is no order row to query from', () => {
    expect(collectEvidence(input('visa-13.1', { order: null, product: null, charges: [] }))).toEqual([]);
    expect(collectEvidence(input('visa-12.6.1', { order: null, product: null, charges: [] }))).toEqual([]);
  });
});

describe('delivery and signature', () => {
  it.each([
    [{ shipStatus: 'delivered', addressMatch: true }, 'delivered'],
    [{ shipStatus: 'delivered', addressMatch: false }, 'delivered-address-mismatch'],
    [{ shipStatus: 'delivered', addressMatch: null }, 'delivered-address-unverified'],
    [{ shipStatus: 'in-transit', deliveredAt: null }, 'in-transit'],
    [{ shipStatus: 'returned-to-sender', deliveredAt: null }, 'returned-to-sender'],
    [{ shipStatus: 'lost', deliveredAt: null }, 'lost'],
  ] as const)('%o becomes %s', (fields, state) => {
    const e = one(collectEvidence(input('visa-13.1', { order: order(fields) })), 'delivery');
    expect(e).toMatchObject({ state, kind: 'fact', source: { kind: 'sql', key: 'orders/ORD-10001' } });
  });

  it('dates a delivery by when it was delivered', () => {
    expect(one(collectEvidence(input('visa-13.1')), 'delivery').at).toBe('2026-10-04T15:00:00.000Z');
  });

  it('has no delivery evidence when nothing was shipped', () => {
    const items = collectEvidence(input('visa-13.1', { order: order({ shipStatus: null, carrier: null, tracking: null, deliveredAt: null }) }));
    expect(ofType(items, 'delivery')).toEqual([]);
  });

  it('maps a signature by whether the name matches', () => {
    const signed = collectEvidence(input('visa-13.1', { order: order({ signedBy: 'R. Okafor', signatureNameMatch: true }) }));
    const other = collectEvidence(input('visa-13.1', { order: order({ signedBy: 'J. Doe', signatureNameMatch: false }) }));
    const unknown = collectEvidence(input('visa-13.1', { order: order({ signedBy: 'J. Doe', signatureNameMatch: null }) }));
    expect(one(signed, 'delivery-signature').state).toBe('signed');
    expect(one(other, 'delivery-signature').state).toBe('signature-name-mismatch');
    expect(one(unknown, 'delivery-signature').state).toBe('signed-name-unverified');
    expect(ofType(collectEvidence(input('visa-13.1')), 'delivery-signature')).toEqual([]);
  });
});

describe('product description', () => {
  it('maps the fulfilment check, and says nothing when it is unknown', () => {
    const yes = collectEvidence(input('visa-13.3', { order: order({ descriptionMatches: true }) }));
    const no = collectEvidence(input('visa-13.3', { order: order({ descriptionMatches: false }) }));
    const unknown = collectEvidence(input('visa-13.3', { order: order({ descriptionMatches: null }) }));
    expect(one(yes, 'product-description').state).toBe('matches-delivered');
    expect(one(no, 'product-description').state).toBe('differs-from-delivered');
    expect(ofType(unknown, 'product-description')).toEqual([]);
  });
});

describe('refunds', () => {
  const state = (r: Partial<ObservedRefund>) => one(collectEvidence(input('visa-13.3', { refunds: [refund(r)] })), 'refund');

  it('records "no refunds" as a fact, because the refunds table was queried', () => {
    const e = one(collectEvidence(input('visa-13.3')), 'refund');
    expect(e).toMatchObject({ state: 'none', kind: 'fact', source: { kind: 'sql', key: 'refunds?order=ORD-10001' }, at: RECEIVED });
  });

  it('treats approved-but-not-completed as owed, carrying only explicit incident links', () => {
    const plain = state({});
    expect(plain.state).toBe('approved-not-completed');
    expect(plain.meta?.linkedIncident).toBeUndefined();
    const linked = state({ linkedIncident: 'INC-231', linkedDeploy: 'DEP-88' });
    expect(linked.meta).toMatchObject({ linkedIncident: 'INC-231', linkedDeploy: 'DEP-88' });
    expect(linked.source.key).toBe('refunds/REF-1001');
  });

  it('keeps initiated and completed apart', () => {
    expect(state({ status: 'initiated' }).state).toBe('initiated');
    expect(state({ status: 'completed', completedAt: '2026-10-20T00:00:00.000Z' }).state).toBe('completed-before-dispute');
    expect(state({ status: 'completed', completedAt: '2026-11-21T00:00:00.000Z' }).state).toBe('completed-after-dispute');
  });

  it('maps declined and still-requested refunds', () => {
    expect(state({ status: 'declined', approvedAt: null, declineReason: 'Outside the 30-day window' }).state).toBe('declined-per-policy');
    expect(state({ status: 'requested', approvedAt: null }).state).toBe('requested');
  });

  it('dates a completed refund by when it completed', () => {
    expect(state({ status: 'completed', completedAt: '2026-10-20T00:00:00.000Z' }).at).toBe('2026-10-20T00:00:00.000Z');
  });

  it('never calls a completed refund with no completion date "after the dispute"', () => {
    expect(state({ status: 'completed', completedAt: null }).state).toBe('completed-date-unknown');
  });

  it('tells a partial amount owed apart from the full amount (review B6)', () => {
    expect(state({ amount: minor(2000) }).state).toBe('partial-approved-not-completed');
    expect(state({ amount: minor(8900) }).state).toBe('approved-not-completed');
    expect(state({ amount: minor(2000) }).meta).toMatchObject({ refundId: 'REF-1001', amount: 2000 });
  });
});

describe("the processor's view of refunds (reconciliation, review D1)", () => {
  const completed = (overrides: Partial<ObservedRefund> = {}) =>
    refund({ status: 'completed', completedAt: '2026-10-20T00:00:00.000Z', ...overrides });
  const settlement = (refunds: ObservedRefund[], charges: ChargeRow[], extra: Partial<CollectInput> = {}) =>
    ofType(collectEvidence(input('visa-13.6', { dispute: dispute('visa-13.6'), refunds, charges, ...extra })), 'processor-refund');

  it('is settled when the processor refunded at least the amount', () => {
    const [e] = settlement([completed()], [charge({ amountRefunded: minor(8900), refundedAt: '2026-10-21T00:00:00.000Z' })]);
    expect(e).toMatchObject({
      type: 'processor-refund',
      state: 'settled',
      kind: 'fact',
      source: { kind: 'sql', key: 'charges/ch_demo_0001' },
      at: '2026-10-21T00:00:00.000Z',
      meta: { refundId: 'REF-1001', amount: 8900, chargeId: 'ch_demo_0001' },
    });
  });

  it('is not settled when the refund service says sent but the processor shows no refund', () => {
    const [e] = settlement([completed({ linkedIncident: 'INC-1', linkedDeploy: 'DEP-2' })], [charge()]);
    expect(e).toMatchObject({ state: 'not-settled', at: RECEIVED, meta: { refundId: 'REF-1001', linkedIncident: 'INC-1', linkedDeploy: 'DEP-2' } });
    expect(e!.note).toMatch(/REF-1001/);
  });

  it('allocates what the processor refunded to refunds in the order they completed', () => {
    const items = settlement(
      [completed({ id: 'REF-1', amount: minor(3000) }), completed({ id: 'REF-2', amount: minor(3000), completedAt: '2026-10-25T00:00:00.000Z' })],
      [charge({ amountRefunded: minor(3000) })],
    );
    expect(items.map((e) => `${e.meta?.refundId}:${e.state}`)).toEqual(['REF-1:settled', 'REF-2:not-settled']);
  });

  it('only reconciles refunds the refund service marked completed', () => {
    expect(settlement([refund()], [charge()])).toEqual([]);
  });

  it('is read from the settlements source, after the refunds', () => {
    const refundsRead = collectEvidence(
      input('visa-13.6', { dispute: dispute('visa-13.6'), refunds: [completed()], pending: ['settlements', 'incidents', 'policies'] }),
    );
    expect(ofType(refundsRead, 'refund')).toHaveLength(1);
    expect(ofType(refundsRead, 'processor-refund')).toEqual([]);
  });
});

describe('order pairs (charged twice)', () => {
  const pairs = (charges: ChargeRow[], overrides: Partial<Dispute> = {}) =>
    ofType(collectEvidence(input('visa-12.6.1', { dispute: dispute('visa-12.6.1', overrides), charges })), 'order-pair');

  it('finds a true duplicate on the same order', () => {
    const [e] = pairs([charge(), charge({ id: 'ch_demo_0002', chargedAt: '2026-10-01T12:01:00.000Z' })]);
    expect(e).toMatchObject({ state: 'duplicate', source: { kind: 'sql', key: 'charges/ch_demo_0002' } });
  });

  it('knows a refunded duplicate', () => {
    const [e] = pairs([charge(), charge({ id: 'ch_demo_0002', refundedAt: '2026-10-03T00:00:00.000Z' })]);
    expect(e).toMatchObject({ state: 'duplicate-refunded', at: '2026-10-03T00:00:00.000Z' });
  });

  it('calls a look-alike charge on another order distinct', () => {
    const [e] = pairs([charge(), charge({ id: 'ch_demo_0002', orderId: 'ORD-10002', chargedAt: '2026-09-30T08:00:00.000Z' })]);
    expect(e).toMatchObject({ state: 'distinct', at: '2026-09-30T08:00:00.000Z' });
  });

  it('records the only charge as a defense when there is no second charge (review B7)', () => {
    const [e] = pairs([charge()]);
    expect(e).toMatchObject({ state: 'only-charge', kind: 'fact', source: { kind: 'sql', key: 'charges?order=ORD-10001' }, at: RECEIVED });
  });

  it('says nothing when the disputed charge cannot be found', () => {
    expect(pairs([charge(), charge({ id: 'ch_demo_0002' })], { chargeId: null })).toEqual([]);
  });

  it('flags two identical orders minutes apart as a possible duplicate, not distinct (review B7)', () => {
    const [e] = pairs([charge(), charge({ id: 'ch_demo_0002', orderId: 'ORD-10002', chargedAt: '2026-10-01T12:04:00.000Z' })]);
    expect(e).toMatchObject({ state: 'possible-duplicate' });
    const [later] = pairs([charge(), charge({ id: 'ch_demo_0002', orderId: 'ORD-10002', chargedAt: '2026-10-01T12:30:00.000Z' })]);
    expect(later).toMatchObject({ state: 'distinct' });
  });
});

describe('incidents', () => {
  const incident = (overrides: Partial<ObservedIncident> = {}): ObservedIncident => ({
    key: 'INC-1',
    url: 'https://example.atlassian.net/browse/INC-1',
    title: 'Payment retries charged twice',
    effect: 'duplicate-charges',
    windowStart: '2026-09-30T00:00:00.000Z',
    windowEnd: '2026-10-02T00:00:00.000Z',
    linkedDeploy: 'DEP-2',
    link: 'explicit',
    ...overrides,
  });
  const incidents = (reason: string, list: ObservedIncident[]) => ofType(collectEvidence(input(reason, { incidents: list })), 'incident');

  it('names an explicitly linked incident as the cause, with its deploy', () => {
    const [e] = incidents('visa-12.6.1', [incident()]);
    expect(e).toMatchObject({ state: 'caused-duplicate-charge', source: { kind: 'jira', key: 'INC-1' }, meta: { linkedDeploy: 'DEP-2' } });
    const [dropped] = incidents('visa-13.3', [incident({ effect: 'dropped-refunds' })]);
    expect(dropped!.state).toBe('caused-dropped-refund');
  });

  it('concedes a dropped refund only while the refund is still owed (review B5)', () => {
    const linked = { linkedIncident: 'INC-1', linkedDeploy: 'DEP-2' };
    const dropped = incident({ effect: 'dropped-refunds' });
    const run = (refunds: ObservedRefund[], charges: ChargeRow[]) =>
      ofType(collectEvidence(input('visa-13.3', { incidents: [dropped], refunds, charges })), 'incident')[0]!;
    expect(run([refund(linked)], [charge()]).state).toBe('caused-dropped-refund');
    const paid = refund({ ...linked, status: 'completed', completedAt: '2026-10-20T00:00:00.000Z' });
    expect(run([paid], [charge()]).state).toBe('caused-dropped-refund');
    const repaired = run([paid], [charge({ amountRefunded: minor(8900) })]);
    expect(repaired.state).toBe('dropped-refund-repaired');
    expect(repaired.meta?.linkedDeploy).toBeUndefined();
  });

  it('never makes an overlapping incident a cause (invariant 7)', () => {
    const [e] = incidents('visa-12.6.1', [incident({ link: 'none' })]);
    expect(e!.state).toBe('unrelated');
    expect(e!.meta).toMatchObject({ windowStart: '2026-09-30T00:00:00.000Z', windowEnd: '2026-10-02T00:00:00.000Z' });
    expect(e!.meta?.linkedDeploy).toBeUndefined();
    expect(e!.meta?.linkedIncident).toBeUndefined();
  });

  it('records "no incident" for a charged-twice dispute, since the incident list was queried', () => {
    const [e] = incidents('visa-12.6.1', []);
    expect(e).toMatchObject({ state: 'none', at: RECEIVED });
    expect(incidents('visa-13.1', [])).toEqual([]);
  });
});

describe('payment checks and Compelling Evidence 3.0', () => {
  // Ages are measured from when the dispute was received (Visa CE 3.0).
  const prior = (daysBefore: number, overrides: Partial<PriorOrder> = {}): PriorOrder => ({
    id: `ORD-P${daysBefore}`,
    purchasedAt: new Date(Date.parse(RECEIVED) - daysBefore * 86_400_000).toISOString(),
    ip: '203.0.113.10',
    deviceId: 'dev_other',
    disputed: false,
    cardFingerprint: 'card_a',
    accountId: 'acct_a',
    shippingAddressHash: 'addr_other',
    fraudReported: false,
    ...overrides,
  });
  const ce = (priorOrders: PriorOrder[], extra: Partial<CollectInput> = {}) =>
    one(collectEvidence(input('visa-10.4', { priorOrders, ...extra })), 'prior-orders');
  const passed = (e: EvidenceItem) => Object.fromEntries((e.meta?.criteria ?? []).map((c) => [c.id, c.passed]));

  it('reads 3-D Secure, AVS and CVV from the order', () => {
    const items = collectEvidence(input('visa-10.4', { order: order({ threeDS: 'authenticated', avs: 'mismatch', cvv: 'unavailable' }) }));
    expect(one(items, '3ds').state).toBe('authenticated');
    expect(one(items, 'avs').state).toBe('mismatch');
    expect(one(items, 'cvv').state).toBe('unavailable');
  });

  it('qualifies with two clean transactions on the same card, 120 to 365 days old, sharing two identifiers incl. IP or device (review B8)', () => {
    // IP and account; device and account.
    const e = ce([prior(150), prior(300, { ip: '198.51.100.1', deviceId: 'dev_a' })]);
    expect(e.state).toBe('ce30-eligible');
    expect(passed(e)).toEqual({ 'same-card': true, window: true, clean: true, identity: true });
    expect(e.note).toMatch(/ORD-P150, ORD-P300/);
  });

  it.each([
    ['no history', [], 'not-eligible'],
    ['one transaction too recent', [prior(150), prior(60)], 'ce30-candidate'],
    ['one transaction too old', [prior(150), prior(400)], 'ce30-candidate'],
    ['one disputed', [prior(150), prior(200, { disputed: true })], 'ce30-candidate'],
    ['one reported as fraud', [prior(150), prior(200, { fraudReported: true })], 'ce30-candidate'],
    ['one sharing only account and address, not IP or device', [prior(150), prior(200, { ip: '198.51.100.9', shippingAddressHash: 'addr_a' })], 'not-eligible'],
    ['one sharing only the IP address', [prior(150), prior(200, { accountId: 'acct_z' })], 'not-eligible'],
  ] as const)('does not qualify with %s (%s)', (_label, priors, state) => {
    expect(ce([...priors]).state).toBe(state);
  });

  it('is a candidate, not qualified, when only the card differs, and says which criterion failed', () => {
    const e = ce([prior(150, { cardFingerprint: 'card_b' }), prior(300, { cardFingerprint: 'card_b' })]);
    expect(e.state).toBe('ce30-candidate');
    expect(passed(e)).toEqual({ 'same-card': false, window: true, clean: true, identity: true });
  });

  it('never matches on empty or missing identifiers', () => {
    const blank = { ip: '', deviceId: '', accountId: null, shippingAddressHash: null };
    const e = ce([prior(150, blank), prior(300, blank)], { order: order(blank) });
    expect(e.state).toBe('not-eligible');
    const noCard = ce([prior(150, { cardFingerprint: null }), prior(300, { cardFingerprint: null })], { order: order({ cardFingerprint: null }) });
    expect(passed(noCard)['same-card']).toBe(false);
  });

  it('measures age from when the dispute was received, not the purchase', () => {
    // 125 days before the dispute is 75 days before this purchase.
    expect(ce([prior(125), prior(130)]).state).toBe('ce30-eligible');
  });

  it('only applies to Visa or unknown networks', () => {
    const mc = collectEvidence(input('visa-10.4', { dispute: dispute('visa-10.4', { network: 'mastercard' }), priorOrders: [prior(150), prior(300)] }));
    expect(ofType(mc, 'prior-orders')).toEqual([]);
  });

  it('only collects fraud checks for fraud disputes, and everything for unknown reasons', () => {
    expect(ofType(collectEvidence(input('visa-13.1')), '3ds')).toEqual([]);
    expect(ofType(collectEvidence(input('general')), '3ds')).toHaveLength(1);
  });
});

describe('cancellation', () => {
  const cancel = (subscriptionCancelledAt: string | null) =>
    one(collectEvidence(input('visa-13.2', { order: order({ subscriptionCancelledAt, shipStatus: null }) })), 'cancellation');

  it('maps a cancellation before the disputed charge', () => {
    expect(cancel('2026-09-20T00:00:00.000Z')).toMatchObject({ state: 'cancelled-before-charge', at: '2026-09-20T00:00:00.000Z' });
  });

  it('maps no cancellation, or one after the charge, to none-before-charge', () => {
    expect(cancel(null)).toMatchObject({ state: 'none-before-charge', at: PURCHASED });
    expect(cancel('2026-10-05T00:00:00.000Z').state).toBe('none-before-charge');
  });
});

describe('policy', () => {
  const versions: ObservedPolicyVersion[] = [
    { pageId: '100001', title: 'Refund & Returns Policy', kind: 'refund-returns', version: 'v1', effectiveFrom: '2025-11-01T00:00:00.000Z', effectiveTo: '2026-10-15T00:00:00.000Z' },
    { pageId: '100001', title: 'Refund & Returns Policy', kind: 'refund-returns', version: 'v2', effectiveFrom: '2026-10-15T00:00:00.000Z', effectiveTo: null },
    { pageId: '100002', title: 'Shipping Policy', kind: 'shipping', version: 'v1', effectiveFrom: '2025-11-01T00:00:00.000Z', effectiveTo: null },
  ];

  it('cites the refund policy version the customer accepted, with its dates', () => {
    const e = one(collectEvidence(input('visa-13.1', { order: order({ termsAcceptedVersion: 'v1' }), policies: versions })), 'policy');
    expect(e).toMatchObject({
      state: 'accepted-at-checkout',
      source: { kind: 'confluence', key: '100001' },
      at: PURCHASED,
      meta: { version: 'v1', effectiveFrom: '2025-11-01T00:00:00.000Z', effectiveTo: '2026-10-15T00:00:00.000Z' },
    });
  });

  it("carries the order's purchase date, so the in-force check runs without webhook metadata (review B11)", () => {
    const e = one(
      collectEvidence(input('visa-13.1', { dispute: dispute('visa-13.1', { purchasedAt: null }), order: order({ termsAcceptedVersion: 'v1' }), policies: versions })),
      'policy',
    );
    expect(e.meta?.purchasedAt).toBe(PURCHASED);
  });

  it('cites nothing when no version was accepted or the version is not on record', () => {
    expect(ofType(collectEvidence(input('visa-13.1', { policies: versions })), 'policy')).toEqual([]);
    expect(ofType(collectEvidence(input('visa-13.1', { order: order({ termsAcceptedVersion: 'v9' }), policies: versions })), 'policy')).toEqual([]);
  });
});

describe('customer messages', () => {
  const ticket = (key: string, messages: ObservedTicket['messages'], orderId: string | null = 'ORD-10001'): ObservedTicket => ({
    key,
    url: `https://example.atlassian.net/browse/${key}`,
    orderId,
    createdAt: messages[0]!.at,
    messages,
  });
  const say = (text: string) => [{ author: 'customer' as const, at: '2026-10-05T09:00:00.000Z', text }];

  it('labels customer words as inferences, quoting the phrase (invariant 6)', () => {
    const items = collectEvidence(
      input('visa-13.1', {
        tickets: [ticket('SUP-1', [{ author: 'customer', at: '2026-10-05T09:00:00.000Z', text: 'Got it, thanks!' }])],
      }),
    );
    const [e] = ofType(items, 'customer-message').filter((m) => m.state === 'acknowledged-receipt');
    expect(e).toMatchObject({ kind: 'inference', source: { kind: 'jsm', key: 'SUP-1' }, at: '2026-10-05T09:00:00.000Z', meta: { quote: 'Got it' } });
  });

  it('ignores what agents wrote', () => {
    const items = collectEvidence(
      input('visa-13.3', {
        tickets: [ticket('SUP-2', [
          { author: 'customer', at: '2026-10-05T09:00:00.000Z', text: 'Hello, quick question about my invoice.' },
          { author: 'agent', at: '2026-10-05T10:00:00.000Z', text: 'Sorry it arrived broken, we will issue a refund.' },
        ])],
      }),
    );
    expect(ofType(items, 'customer-message')).toEqual([]);
  });

  it('records no-complaint only when the customer has no tickets about this order at all (review B2)', () => {
    const none = one(collectEvidence(input('visa-13.3')), 'customer-message');
    expect(none).toMatchObject({ state: 'no-complaint', kind: 'inference', source: { kind: 'jsm', key: 'tickets?order=ORD-10001' }, at: RECEIVED });
    expect(none.note).toMatch(/no support tickets about this order/i);
  });

  it('records nothing, leaving it for a person, when tickets exist but nothing was classified (review B2)', () => {
    for (const text of ['Hello, quick question about my invoice.', 'It arrived broken.', 'Can I get my money back?', 'It never arrived.']) {
      const items = collectEvidence(input('visa-13.3', { tickets: [ticket('SUP-3', say(text))] }));
      expect(ofType(items, 'customer-message').map((e) => e.state)).not.toContain('no-complaint');
    }
  });

  it('treats a ticket whose order is unknown as possibly about this order', () => {
    const items = collectEvidence(input('visa-13.3', { tickets: [ticket('SUP-5', say('It arrived broken.'), null)] }));
    expect(ofType(items, 'customer-message').map((e) => e.state)).toEqual(['acknowledged-receipt', 'complained']);
  });

  it('never counts messages from a ticket about another order (review B4)', () => {
    const items = collectEvidence(input('visa-13.1', { tickets: [ticket('SUP-6', say('It never arrived.'), 'ORD-99999')] }));
    expect(ofType(items, 'customer-message').map((e) => e.state)).toEqual(['no-complaint']);
  });

  it('emits one item per label per message, in a stable order', () => {
    const items = collectEvidence(
      input('visa-13.3', {
        tickets: [ticket('SUP-4', [{ author: 'customer', at: '2026-10-05T09:00:00.000Z', text: 'Got it, it arrived broken and I want a refund' }])],
      }),
    );
    expect(ofType(items, 'customer-message').map((e) => e.id)).toEqual([
      'ev-message-SUP-4-0-acknowledged-receipt',
      'ev-message-SUP-4-0-complained',
      'ev-message-SUP-4-0-requested-refund',
    ]);
  });
});

describe('collecting source by source', () => {
  it('never records an absence for a source that has not been read yet', () => {
    const unread = collectEvidence(input('visa-13.1', { refunds: [], tickets: [], pending: ['refunds', 'tickets'] }));
    expect(unread.some((e) => e.type === 'refund')).toBe(false);
    expect(unread.some((e) => e.type === 'customer-message')).toBe(false);
    const read = collectEvidence(input('visa-13.1', { refunds: [], tickets: [] }));
    expect(read.find((e) => e.type === 'refund')?.state).toBe('none');
  });

  it('keeps evidence from the sources already read', () => {
    const partial = collectEvidence(input('visa-13.1', { pending: ['refunds', 'tickets', 'incidents', 'policies'] }));
    expect(partial.some((e) => e.type === 'delivery')).toBe(true);
  });
});
