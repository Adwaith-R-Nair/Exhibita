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
