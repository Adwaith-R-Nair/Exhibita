// Reads and writes the merchant's records in Forge SQL (D-03). Statement shapes and row conversion
// live in src/core/sources/codec.ts; this file only runs them.

import { sql } from '@forge/sql';
import {
  CHARGES,
  CUSTOMERS,
  fromSqlTime,
  toSqlTime,
  IMPACTS,
  insertStatement,
  ORDERS,
  OUTCOMES,
  PRODUCTS,
  REFUNDS,
  type StoredImpact,
  type TableCodec,
} from '../core/sources/codec';
import type { ChargeRow, OrderRow, OutcomeRow, PriorOrder, ProductRow, RefundRow } from '../core/sources/types';

type DbRow = Record<string, unknown>;

async function query(text: string, ...params: unknown[]): Promise<DbRow[]> {
  const { rows } = await sql.prepare<DbRow>(text).bindParams(...params).execute();
  return rows;
}

/** Rows per INSERT. Keeps each statement well under Forge SQL's request size limit. */
export const INSERT_BATCH = 100;

export async function insertRows<Row>(codec: TableCodec<Row>, rows: readonly Row[]): Promise<number> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { query: text, params } = insertStatement(codec, rows.slice(i, i + INSERT_BATCH));
    await sql.prepare(text).bindParams(...params).execute();
  }
  return rows.length;
}

/** Tables the demo data fills, in an order that is safe to empty. */
export const DEMO_TABLES = [IMPACTS, REFUNDS, CHARGES, ORDERS, PRODUCTS, CUSTOMERS, OUTCOMES].map((c) => c.table);

export async function clearDemoTables(): Promise<void> {
  for (const table of DEMO_TABLES) await sql.prepare(`DELETE FROM ${table}`).execute();
}

export async function setRefundTicket(refundId: string, ticketKey: string): Promise<void> {
  await sql.prepare('UPDATE refunds SET ticket_key = ? WHERE id = ?').bindParams(ticketKey, refundId).execute();
}

export async function getOrder(orderId: string): Promise<OrderRow | null> {
  const [row] = await query(`SELECT ${ORDERS.columns.join(', ')} FROM orders WHERE id = ?`, orderId);
  return row ? ORDERS.fromDb(row) : null;
}

export async function getProduct(sku: string): Promise<ProductRow | null> {
  const [row] = await query(`SELECT ${PRODUCTS.columns.join(', ')} FROM products WHERE sku = ?`, sku);
  return row ? PRODUCTS.fromDb(row) : null;
}

export async function getCharge(chargeId: string): Promise<ChargeRow | null> {
  const [row] = await query(`SELECT ${CHARGES.columns.join(', ')} FROM charges WHERE id = ?`, chargeId);
  return row ? CHARGES.fromDb(row) : null;
}

/**
 * Every charge on the order, plus the customer's other charges of the disputed amount within 7 days of
 * the disputed charge (falling back to the purchase time), so duplicates can be recognised.
 */
export async function getChargesFor(order: OrderRow, disputedAmount: number, anchorIso: string): Promise<ChargeRow[]> {
  const anchor = toSqlTime(anchorIso);
  const rows = await query(
    `SELECT ${CHARGES.columns.join(', ')} FROM charges
     WHERE order_id = ?
        OR (customer_id = ? AND amount = ? AND charged_at BETWEEN DATE_SUB(?, INTERVAL 7 DAY) AND DATE_ADD(?, INTERVAL 7 DAY))
     ORDER BY charged_at, id`,
    order.id, order.customerId, disputedAmount, anchor, anchor,
  );
  return rows.map((r) => CHARGES.fromDb(r));
}

export async function getRefundsFor(orderId: string): Promise<(RefundRow & { ticketKey: string | null })[]> {
  const rows = await query(`SELECT ${REFUNDS.columns.join(', ')} FROM refunds WHERE order_id = ? ORDER BY id`, orderId);
  return rows.map((r) => REFUNDS.fromDb(r));
}

/** Impact rows naming any of these refunds or charges. */
export async function getImpacts(refundIds: readonly string[], chargeIds: readonly string[]): Promise<StoredImpact[]> {
  if (refundIds.length === 0 && chargeIds.length === 0) return [];
  const inList = (n: number) => (n === 0 ? '(NULL)' : `(${Array.from({ length: n }, () => '?').join(', ')})`);
  const rows = await query(
    `SELECT incident_key, refund_id, charge_id FROM incident_impacts
     WHERE refund_id IN ${inList(refundIds.length)} OR charge_id IN ${inList(chargeIds.length)}`,
    ...refundIds, ...chargeIds,
  );
  return rows.map((r) => IMPACTS.fromDb(r));
}

/** The customer's orders before this one, flagged when they were disputed (for Compelling Evidence 3.0). */
export async function getPriorOrders(order: OrderRow, disputedOrderIds: ReadonlySet<string>): Promise<PriorOrder[]> {
  const rows = await query(
    'SELECT id, purchased_at, ip, device_id FROM orders WHERE customer_id = ? AND purchased_at < ? ORDER BY purchased_at, id',
    order.customerId, order.purchasedAt.slice(0, 23).replace('T', ' '),
  );
  return rows.map((r) => ({
    id: String(r.id),
    purchasedAt: fromSqlTime(r.purchased_at) ?? '',
    ip: String(r.ip),
    deviceId: String(r.device_id),
    disputed: disputedOrderIds.has(String(r.id)),
  }));
}

export async function getOutcomes(): Promise<OutcomeRow[]> {
  const rows = await query(`SELECT ${OUTCOMES.columns.join(', ')} FROM outcomes ORDER BY closed_at`);
  return rows.map((r) => OUTCOMES.fromDb(r));
}

export const TABLES = { CUSTOMERS, PRODUCTS, ORDERS, CHARGES, REFUNDS, IMPACTS, OUTCOMES };
