// Runs on install and upgrade: bring the SQL schema up to date.

import { runMigrations } from './lib/sql.js';

export async function onLifecycle(event: { eventType?: string }): Promise<void> {
  const applied = await runMigrations();
  console.log(`Lifecycle ${event.eventType ?? 'event'}: migrations applied: ${applied.join(', ')}`);
}
