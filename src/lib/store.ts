// Reads and writes the merchant's records in Forge SQL (D-03). Statement shapes and row conversion
// live in src/core/sources/codec.ts; this file only runs them.

import { sql } from '@forge/sql';
import {
  CHARGES,
  CUSTOMERS,
  DISPUTES,
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

/**
 * Orders bought before this one by the same customer or on the same card, flagged when disputed. Visa
 * Compelling Evidence 3.0 is about the card, not the account, so same-card orders count too.
 */
export async function getPriorOrders(order: OrderRow): Promise<PriorOrder[]> {
  const rows = await query(
    `SELECT id, purchased_at, ip, device_id, card_fingerprint, account_id, ship_address_hash, fraud_reported FROM orders
     WHERE id <> ? AND purchased_at < ? AND (customer_id = ? OR (? IS NOT NULL AND card_fingerprint = ?))
     ORDER BY purchased_at, id`,
    order.id, toSqlTime(order.purchasedAt), order.customerId, order.cardFingerprint, order.cardFingerprint,
  );
  // Disputed means any dispute in the app's own ledger names that order, whoever the customer was.
  const ids = rows.map((r) => String(r.id));
  const disputedOrderIds = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    if (batch.length === 0) continue;
    const hits = await query(`SELECT order_id FROM disputes WHERE order_id IN (${batch.map(() => '?').join(', ')})`, ...batch);
    for (const h of hits) disputedOrderIds.add(String(h.order_id));
  }
  return rows.map((r) => ({
    id: String(r.id),
    purchasedAt: fromSqlTime(r.purchased_at) ?? '',
    ip: String(r.ip),
    deviceId: String(r.device_id),
    disputed: disputedOrderIds.has(String(r.id)),
    cardFingerprint: r.card_fingerprint == null ? null : String(r.card_fingerprint),
    accountId: r.account_id == null ? null : String(r.account_id),
    shippingAddressHash: r.ship_address_hash == null ? null : String(r.ship_address_hash),
    fraudReported: Number(r.fraud_reported) === 1,
  }));
}

export async function getOutcomes(): Promise<OutcomeRow[]> {
  const rows = await query(`SELECT ${OUTCOMES.columns.join(', ')} FROM outcomes ORDER BY closed_at`);
  return rows.map((r) => OUTCOMES.fromDb(r));
}

export const TABLES = { CUSTOMERS, PRODUCTS, ORDERS, CHARGES, REFUNDS, IMPACTS, OUTCOMES };

/**
 * Claim a dispute id for intake. Returns true only for the first caller: INSERT IGNORE on the primary
 * key is atomic, so two simultaneous deliveries cannot both create a work item (review A4).
 */
export async function claimDispute(row: { externalId: string; orderId: string | null; customerId: string | null; receivedAt: string }): Promise<boolean> {
  // The issue key starts as a dated "pending" marker, so a claim abandoned by a crash can be taken over.
  const { query: text, params } = insertStatement(DISPUTES, [{ ...row, issueKey: pendingMarker() }]);
  const res = (await sql.prepare(text).bindParams(...params).execute()) as unknown as { rows?: { affectedRows?: number } };
  return (res.rows?.affectedRows ?? 0) > 0;
}

export async function getDisputeClaim(externalId: string): Promise<{ issueKey: string | null } | null> {
  const [row] = await query('SELECT issue_key FROM disputes WHERE external_id = ?', externalId);
  return row ? { issueKey: row.issue_key == null ? null : String(row.issue_key) } : null;
}

export async function setDisputeIssue(externalId: string, issueKey: string | null): Promise<void> {
  await sql.prepare('UPDATE disputes SET issue_key = ? WHERE external_id = ?').bindParams(issueKey, externalId).execute();
}

export const pendingMarker = (at = Date.now()) => `pending:${at}`;

/** Age in milliseconds of a pending claim, or null if the claim names a real work item. */
export function pendingAge(issueKey: string | null, now = Date.now()): number | null {
  const m = /^pending:(\d+)$/.exec(issueKey ?? '');
  return m ? now - Number(m[1]) : null;
}

/** Give up a claim that never got a work item, so a retry can take it. */
export async function releaseDisputeClaim(externalId: string): Promise<void> {
  await sql.prepare("DELETE FROM disputes WHERE external_id = ? AND issue_key LIKE 'pending:%'").bindParams(externalId).execute();
}

/** Orders this customer has disputed, from the app's own ledger (never from editable issue properties). */
export async function getDisputedOrders(customerId: string): Promise<Set<string>> {
  const rows = await query("SELECT order_id FROM disputes WHERE customer_id = ? AND order_id IS NOT NULL", customerId);
  return new Set(rows.map((r) => String(r.order_id)));
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');
const ID_BATCH = 200;

/** Delete rows whose key column is one of these ids, in batches. */
async function deleteWhereIn(table: string, column: string, ids: readonly string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    if (batch.length > 0) await sql.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders(batch.length)})`).bindParams(...batch).execute();
  }
}

/** Impact rows naming these refunds or charges (so a re-run step can rewrite them without duplicates). */
export async function deleteImpactsFor(refundIds: readonly string[], chargeIds: readonly string[]): Promise<void> {
  await deleteWhereIn('incident_impacts', 'refund_id', refundIds);
  await deleteWhereIn('incident_impacts', 'charge_id', chargeIds);
}

/** The demo world's rows, by id. Removal deletes exactly these, never whole tables (review C). */
export interface DemoRowIds {
  customers: string[];
  products: string[];
  orders: string[];
  charges: string[];
  refunds: string[];
  outcomes: string[];
  disputes: string[];
}

export async function deleteDemoRows(ids: DemoRowIds): Promise<void> {
  await deleteImpactsFor(ids.refunds, ids.charges);
  await deleteWhereIn('refunds', 'id', ids.refunds);
  await deleteWhereIn('charges', 'id', ids.charges);
  await deleteWhereIn('orders', 'id', ids.orders);
  await deleteWhereIn('products', 'sku', ids.products);
  await deleteWhereIn('customers', 'id', ids.customers);
  await deleteWhereIn('outcomes', 'dispute_id', ids.outcomes);
  await deleteWhereIn('disputes', 'external_id', ids.disputes);
}

/** Work items intake created for these dispute ids, from the app's own ledger. */
export async function ledgerIssues(externalIds: readonly string[]): Promise<{ externalId: string; issueKey: string }[]> {
  const out: { externalId: string; issueKey: string }[] = [];
  for (let i = 0; i < externalIds.length; i += ID_BATCH) {
    const batch = externalIds.slice(i, i + ID_BATCH);
    if (batch.length === 0) continue;
    const rows = await query(`SELECT external_id, issue_key FROM disputes WHERE external_id IN (${placeholders(batch.length)}) AND issue_key IS NOT NULL AND issue_key NOT LIKE 'pending:%'`, ...batch);
    for (const r of rows) out.push({ externalId: String(r.external_id), issueKey: String(r.issue_key) });
  }
  return out;
}

/** Drop ledger entries for disputes whose work items were deleted. */
export async function forgetDisputes(externalIds: readonly string[]): Promise<void> {
  await deleteWhereIn('disputes', 'external_id', externalIds);
}

/**
 * Only for removing a demo set up before review round 1, whose tables held nothing but demo rows. New
 * removals delete by id (deleteDemoRows) and never empty a table.
 */
export async function clearLegacyDemoTables(): Promise<void> {
  for (const table of ['incident_impacts', 'refunds', 'charges', 'orders', 'products', 'customers', 'outcomes']) {
    await sql.prepare(`DELETE FROM ${table}`).execute();
  }
}
