// How source rows are stored in Forge SQL (D-03): column order, and conversion both ways.
// Pure so the round trip is unit-tested; src/lib/store.ts only runs the statements.

import { minor } from '../types';
import type { ChargeRow, CustomerRow, IncidentImpactRow, OrderRow, OutcomeRow, ProductRow, RefundRow } from './types';

type SqlValue = string | number | null;
type DbRow = Record<string, unknown>;

/** ISO 8601 → MySQL DATETIME(3) in UTC. */
export function toSqlTime(iso: string | null): string | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new RangeError(`Not a timestamp: ${iso}`);
  return new Date(t).toISOString().slice(0, 23).replace('T', ' ');
}

/** MySQL DATETIME (string or Date, always UTC) → ISO 8601. */
export function fromSqlTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new RangeError(`Not a SQL timestamp: ${s}`);
  return new Date(t).toISOString();
}

const bool = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);
const fromBool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) === 1);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const req = (v: unknown, column: string): string => {
  if (v === null || v === undefined) throw new TypeError(`Column ${column} is null`);
  return String(v);
};
const money = (v: unknown) => minor(Number(v));

export interface TableCodec<Row> {
  table: string;
  columns: readonly string[];
  /** Values in column order. */
  toParams(row: Row): SqlValue[];
  fromDb(row: DbRow): Row;
}

export const CUSTOMERS: TableCodec<CustomerRow> = {
  table: 'customers',
  columns: ['id', 'name', 'email', 'created_at'],
  toParams: (r) => [r.id, r.name, r.email, toSqlTime(r.createdAt)],
  fromDb: (d) => ({ id: req(d.id, 'id'), name: req(d.name, 'name'), email: req(d.email, 'email'), createdAt: req(fromSqlTime(d.created_at), 'created_at') }),
};

export const PRODUCTS: TableCodec<ProductRow> = {
  table: 'products',
  columns: ['sku', 'name', 'description', 'kind'],
  toParams: (r) => [r.sku, r.name, r.description, r.kind],
  fromDb: (d) => ({ sku: req(d.sku, 'sku'), name: req(d.name, 'name'), description: req(d.description, 'description'), kind: req(d.kind, 'kind') as ProductRow['kind'] }),
};

export const ORDERS: TableCodec<OrderRow> = {
  table: 'orders',
  columns: [
    'id', 'customer_id', 'sku', 'amount', 'currency', 'purchased_at', 'ip', 'device_id', 'terms_version',
    'carrier', 'tracking', 'ship_status', 'delivered_at', 'address_match', 'signed_by', 'signature_name_match',
    'description_matches', 'three_ds', 'avs', 'cvv', 'subscription_cancelled_at',
  ],
  toParams: (r) => [
    r.id, r.customerId, r.sku, r.amount, r.currency, toSqlTime(r.purchasedAt), r.ip, r.deviceId, r.termsAcceptedVersion,
    r.carrier, r.tracking, r.shipStatus, toSqlTime(r.deliveredAt), bool(r.addressMatch), r.signedBy, bool(r.signatureNameMatch),
    bool(r.descriptionMatches), r.threeDS, r.avs, r.cvv, toSqlTime(r.subscriptionCancelledAt),
  ],
  fromDb: (d) => ({
    id: req(d.id, 'id'),
    customerId: req(d.customer_id, 'customer_id'),
    sku: req(d.sku, 'sku'),
    amount: money(d.amount),
    currency: req(d.currency, 'currency'),
    purchasedAt: req(fromSqlTime(d.purchased_at), 'purchased_at'),
    ip: req(d.ip, 'ip'),
    deviceId: req(d.device_id, 'device_id'),
    termsAcceptedVersion: str(d.terms_version),
    carrier: str(d.carrier),
    tracking: str(d.tracking),
    shipStatus: str(d.ship_status) as OrderRow['shipStatus'],
    deliveredAt: fromSqlTime(d.delivered_at),
    addressMatch: fromBool(d.address_match),
    signedBy: str(d.signed_by),
    signatureNameMatch: fromBool(d.signature_name_match),
    descriptionMatches: fromBool(d.description_matches),
    threeDS: req(d.three_ds, 'three_ds') as OrderRow['threeDS'],
    avs: req(d.avs, 'avs') as OrderRow['avs'],
    cvv: req(d.cvv, 'cvv') as OrderRow['cvv'],
    subscriptionCancelledAt: fromSqlTime(d.subscription_cancelled_at),
  }),
};

export const CHARGES: TableCodec<ChargeRow> = {
  table: 'charges',
  columns: ['id', 'order_id', 'customer_id', 'amount', 'currency', 'charged_at', 'refunded_at'],
  toParams: (r) => [r.id, r.orderId, r.customerId, r.amount, r.currency, toSqlTime(r.chargedAt), toSqlTime(r.refundedAt)],
  fromDb: (d) => ({
    id: req(d.id, 'id'),
    orderId: req(d.order_id, 'order_id'),
    customerId: req(d.customer_id, 'customer_id'),
    amount: money(d.amount),
    currency: req(d.currency, 'currency'),
    chargedAt: req(fromSqlTime(d.charged_at), 'charged_at'),
    refundedAt: fromSqlTime(d.refunded_at),
  }),
};

/** Refunds, plus the support ticket that asked for one (filled in once the ticket exists in Jira). */
export const REFUNDS: TableCodec<RefundRow & { ticketKey: string | null }> = {
  table: 'refunds',
  columns: ['id', 'order_id', 'charge_id', 'amount', 'currency', 'status', 'requested_at', 'approved_at', 'completed_at', 'decline_reason', 'ticket_key'],
  toParams: (r) => [
    r.id, r.orderId, r.chargeId, r.amount, r.currency, r.status, toSqlTime(r.requestedAt), toSqlTime(r.approvedAt),
    toSqlTime(r.completedAt), r.declineReason, r.ticketKey,
  ],
  fromDb: (d) => ({
    id: req(d.id, 'id'),
    orderId: req(d.order_id, 'order_id'),
    chargeId: req(d.charge_id, 'charge_id'),
    amount: money(d.amount),
    currency: req(d.currency, 'currency'),
    status: req(d.status, 'status') as RefundRow['status'],
    requestedAt: req(fromSqlTime(d.requested_at), 'requested_at'),
    approvedAt: fromSqlTime(d.approved_at),
    completedAt: fromSqlTime(d.completed_at),
    declineReason: str(d.decline_reason),
    ticketKey: str(d.ticket_key),
  }),
};

/** Impact rows as stored: the incident's Jira key, known once the wizard has created it. */
export interface StoredImpact {
  incidentKey: string;
  refundId: string | null;
  chargeId: string | null;
}

export const IMPACTS: TableCodec<StoredImpact> = {
  table: 'incident_impacts',
  columns: ['incident_key', 'refund_id', 'charge_id'],
  toParams: (r) => [r.incidentKey, r.refundId, r.chargeId],
  fromDb: (d) => ({ incidentKey: req(d.incident_key, 'incident_key'), refundId: str(d.refund_id), chargeId: str(d.charge_id) }),
};

/** Resolve an impact row's incident ref to the Jira key the wizard created for it. */
export const storedImpact = (row: IncidentImpactRow, keyOf: (ref: string) => string): StoredImpact => ({
  incidentKey: keyOf(row.incidentRef),
  refundId: row.refundId,
  chargeId: row.chargeId,
});

export const OUTCOMES: TableCodec<OutcomeRow> = {
  table: 'outcomes',
  columns: ['dispute_id', 'reason_code', 'amount', 'currency', 'decision', 'result', 'closed_at', 'loss_reason'],
  toParams: (r) => [r.disputeId, r.reasonCode, r.amount, r.currency, r.decision, r.result, toSqlTime(r.closedAt), r.lossReason],
  fromDb: (d) => ({
    disputeId: req(d.dispute_id, 'dispute_id'),
    reasonCode: req(d.reason_code, 'reason_code') as OutcomeRow['reasonCode'],
    amount: money(d.amount),
    currency: req(d.currency, 'currency'),
    decision: req(d.decision, 'decision') as OutcomeRow['decision'],
    result: req(d.result, 'result') as OutcomeRow['result'],
    closedAt: req(fromSqlTime(d.closed_at), 'closed_at'),
    lossReason: str(d.loss_reason),
  }),
};

/**
 * One multi-row INSERT IGNORE for a batch, so re-running a seeding step after a partial failure
 * skips rows that already exist instead of failing.
 */
export function insertStatement<Row>(codec: TableCodec<Row>, rows: readonly Row[]): { query: string; params: SqlValue[] } {
  if (rows.length === 0) throw new RangeError('insertStatement needs at least one row');
  const placeholders = `(${codec.columns.map(() => '?').join(', ')})`;
  return {
    query: `INSERT IGNORE INTO ${codec.table} (${codec.columns.join(', ')}) VALUES ${rows.map(() => placeholders).join(', ')}`,
    params: rows.flatMap((r) => codec.toParams(r)),
  };
}
