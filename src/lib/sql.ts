// Forge SQL schema and migrations (D-03). Migrations are append-only: never edit one that has shipped.

import { migrationRunner, sql } from '@forge/sql';

const MIGRATIONS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  [
    'v001_create_audit_log',
    `CREATE TABLE IF NOT EXISTS audit_log (
       id BIGINT AUTO_INCREMENT PRIMARY KEY,
       at DATETIME(3) NOT NULL,
       actor VARCHAR(128) NOT NULL,
       action VARCHAR(64) NOT NULL,
       issue_key VARCHAR(32) NULL,
       detail JSON NULL,
       INDEX idx_audit_issue (issue_key)
     )`,
  ],
  // The merchant's payment and fulfilment records (D-03). Columns match src/core/sources/codec.ts.
  [
    'v002_create_customers',
    `CREATE TABLE IF NOT EXISTS customers (
       id VARCHAR(32) PRIMARY KEY,
       name VARCHAR(128) NOT NULL,
       email VARCHAR(160) NOT NULL,
       created_at DATETIME(3) NOT NULL
     )`,
  ],
  [
    'v003_create_products',
    `CREATE TABLE IF NOT EXISTS products (
       sku VARCHAR(32) PRIMARY KEY,
       name VARCHAR(128) NOT NULL,
       description TEXT NOT NULL,
       kind VARCHAR(16) NOT NULL
     )`,
  ],
  [
    'v004_create_orders',
    `CREATE TABLE IF NOT EXISTS orders (
       id VARCHAR(32) PRIMARY KEY,
       customer_id VARCHAR(32) NOT NULL,
       sku VARCHAR(32) NOT NULL,
       amount BIGINT NOT NULL,
       currency CHAR(3) NOT NULL,
       purchased_at DATETIME(3) NOT NULL,
       ip VARCHAR(45) NOT NULL,
       device_id VARCHAR(64) NOT NULL,
       terms_version VARCHAR(16) NULL,
       carrier VARCHAR(64) NULL,
       tracking VARCHAR(64) NULL,
       ship_status VARCHAR(24) NULL,
       delivered_at DATETIME(3) NULL,
       address_match TINYINT NULL,
       signed_by VARCHAR(128) NULL,
       signature_name_match TINYINT NULL,
       description_matches TINYINT NULL,
       three_ds VARCHAR(16) NOT NULL,
       avs VARCHAR(16) NOT NULL,
       cvv VARCHAR(16) NOT NULL,
       subscription_cancelled_at DATETIME(3) NULL,
       INDEX idx_orders_customer (customer_id)
     )`,
  ],
  [
    'v005_create_charges',
    `CREATE TABLE IF NOT EXISTS charges (
       id VARCHAR(40) PRIMARY KEY,
       order_id VARCHAR(32) NOT NULL,
       customer_id VARCHAR(32) NOT NULL,
       amount BIGINT NOT NULL,
       currency CHAR(3) NOT NULL,
       charged_at DATETIME(3) NOT NULL,
       refunded_at DATETIME(3) NULL,
       INDEX idx_charges_order (order_id),
       INDEX idx_charges_customer (customer_id)
     )`,
  ],
  [
    'v006_create_refunds',
    `CREATE TABLE IF NOT EXISTS refunds (
       id VARCHAR(32) PRIMARY KEY,
       order_id VARCHAR(32) NOT NULL,
       charge_id VARCHAR(40) NOT NULL,
       amount BIGINT NOT NULL,
       currency CHAR(3) NOT NULL,
       status VARCHAR(16) NOT NULL,
       requested_at DATETIME(3) NOT NULL,
       approved_at DATETIME(3) NULL,
       completed_at DATETIME(3) NULL,
       decline_reason VARCHAR(255) NULL,
       ticket_key VARCHAR(32) NULL,
       INDEX idx_refunds_order (order_id)
     )`,
  ],
  [
    'v007_create_incident_impacts',
    `CREATE TABLE IF NOT EXISTS incident_impacts (
       id BIGINT AUTO_INCREMENT PRIMARY KEY,
       incident_key VARCHAR(32) NOT NULL,
       refund_id VARCHAR(32) NULL,
       charge_id VARCHAR(40) NULL,
       UNIQUE KEY uq_impact (incident_key, refund_id, charge_id),
       INDEX idx_impacts_refund (refund_id),
       INDEX idx_impacts_charge (charge_id)
     )`,
  ],
  [
    'v008_create_outcomes',
    `CREATE TABLE IF NOT EXISTS outcomes (
       dispute_id VARCHAR(40) PRIMARY KEY,
       reason_code VARCHAR(24) NOT NULL,
       amount BIGINT NOT NULL,
       currency CHAR(3) NOT NULL,
       decision VARCHAR(16) NOT NULL,
       result VARCHAR(16) NOT NULL,
       closed_at DATETIME(3) NOT NULL,
       loss_reason VARCHAR(255) NULL
     )`,
  ],
  // Review round 1: payer identity for Compelling Evidence 3.0, the processor's refunded amount for
  // reconciliation, and the app's own dispute ledger (atomic intake claim, trusted disputed orders).
  [
    'v009_orders_payer_identity',
    `ALTER TABLE orders
       ADD COLUMN card_fingerprint VARCHAR(64) NULL,
       ADD COLUMN card_network VARCHAR(16) NOT NULL DEFAULT 'unknown',
       ADD COLUMN account_id VARCHAR(64) NULL,
       ADD COLUMN ship_address_hash VARCHAR(64) NULL,
       ADD COLUMN fraud_reported TINYINT NOT NULL DEFAULT 0`,
  ],
  ['v010_charges_amount_refunded', 'ALTER TABLE charges ADD COLUMN amount_refunded BIGINT NOT NULL DEFAULT 0'],
  [
    'v011_create_disputes',
    `CREATE TABLE IF NOT EXISTS disputes (
       external_id VARCHAR(64) PRIMARY KEY,
       order_id VARCHAR(32) NULL,
       customer_id VARCHAR(32) NULL,
       issue_key VARCHAR(32) NULL,
       received_at DATETIME(3) NOT NULL,
       INDEX idx_disputes_customer (customer_id)
     )`,
  ],
];

export async function runMigrations(): Promise<string[]> {
  let runner = migrationRunner;
  for (const [name, ddl] of MIGRATIONS) runner = runner.enqueue(name, ddl);
  await runner.run();
  const applied = await migrationRunner.list();
  return applied.map((m) => m.name);
}

export async function audit(actor: string, action: string, issueKey: string | null, detail: unknown = null): Promise<void> {
  await sql
    .prepare('INSERT INTO audit_log (at, actor, action, issue_key, detail) VALUES (?, ?, ?, ?, ?)')
    .bindParams(new Date().toISOString().slice(0, 23).replace('T', ' '), actor, action, issueKey, JSON.stringify(detail))
    .execute();
}

export async function recentAudit(limit = 5): Promise<unknown[]> {
  const { rows } = await sql.prepare(`SELECT id, at, actor, action, issue_key FROM audit_log ORDER BY id DESC LIMIT ${Math.max(1, Math.min(limit, 50))}`).execute();
  return rows as unknown[];
}
