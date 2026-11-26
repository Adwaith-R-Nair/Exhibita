import { describe, expect, it } from 'vitest';
import { CHARGES, fromSqlTime, insertStatement, ORDERS, REFUNDS, toSqlTime } from '../../src/core/sources/codec';
import type { OrderRow } from '../../src/core/sources/types';
import { minor } from '../../src/core/types';

const order: OrderRow = {
  id: 'ORD-10001', customerId: 'cus_demo_0001', sku: 'PRO-HEADSET', amount: minor(24900), currency: 'USD',
  purchasedAt: '2026-10-01T12:00:00.000Z', ip: '203.0.113.7', deviceId: 'dev-1', termsAcceptedVersion: 'v1',
  carrier: 'Ground courier', tracking: 'GC123', shipStatus: 'delivered', deliveredAt: '2026-10-04T09:30:00.000Z',
  addressMatch: true, signedBy: null, signatureNameMatch: null, descriptionMatches: false,
  threeDS: 'not-attempted', avs: 'match', cvv: 'unavailable', subscriptionCancelledAt: null,
};

/** What the database hands back: column names, booleans as 0/1, DATETIME as text. */
const asDb = <R>(codec: { columns: readonly string[]; toParams(r: R): unknown[] }, row: R) =>
  Object.fromEntries(codec.columns.map((c, i) => [c, codec.toParams(row)[i]]));

describe('SQL time conversion', () => {
  it('stores UTC with milliseconds and reads it back as ISO', () => {
    expect(toSqlTime('2026-10-01T12:00:00.123+05:30')).toBe('2026-10-01 06:30:00.123');
    expect(fromSqlTime('2026-10-01 06:30:00.123')).toBe('2026-10-01T06:30:00.123Z');
    expect(fromSqlTime(new Date('2026-10-01T06:30:00Z'))).toBe('2026-10-01T06:30:00.000Z');
    expect(toSqlTime(null)).toBeNull();
    expect(fromSqlTime(null)).toBeNull();
  });

  it('rejects text that is not a time instead of storing garbage', () => {
    expect(() => toSqlTime('soon')).toThrow(RangeError);
    expect(() => fromSqlTime('later')).toThrow(RangeError);
  });
});

describe('row codecs', () => {
  it('round-trips an order, keeping false distinct from unknown', () => {
    const back = ORDERS.fromDb(asDb(ORDERS, order));
    expect(back).toEqual(order);
    expect(back.descriptionMatches).toBe(false);
    expect(back.signatureNameMatch).toBeNull();
  });

  it('round-trips charges and refunds', () => {
    const charge = { id: 'ch_1', orderId: 'ORD-1', customerId: 'cus_1', amount: minor(4900), currency: 'USD', chargedAt: '2026-10-01T00:00:00.000Z', refundedAt: null };
    expect(CHARGES.fromDb(asDb(CHARGES, charge))).toEqual(charge);
    const refund = {
      id: 'REF-1', orderId: 'ORD-1', chargeId: 'ch_1', amount: minor(4900), currency: 'USD', status: 'approved' as const,
      requestedAt: '2026-10-02T00:00:00.000Z', approvedAt: '2026-10-03T00:00:00.000Z', completedAt: null, declineReason: null, ticketKey: 'SUP-4',
    };
    expect(REFUNDS.fromDb(asDb(REFUNDS, refund))).toEqual(refund);
  });

  it('builds one INSERT IGNORE with a placeholder per value', () => {
    const { query, params } = insertStatement(ORDERS, [order, { ...order, id: 'ORD-10002' }]);
    expect(query.startsWith('INSERT IGNORE INTO orders (id, customer_id,')).toBe(true);
    expect(query.match(/\?/g)).toHaveLength(ORDERS.columns.length * 2);
    expect(params).toHaveLength(ORDERS.columns.length * 2);
    expect(() => insertStatement(ORDERS, [])).toThrow(RangeError);
  });
});
