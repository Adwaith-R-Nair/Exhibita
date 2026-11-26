// Backend for the Exhibita setup page: configuration, webhook secret, and platform checks.

import api, { webTrigger } from '@forge/api';
import { kvs } from '@forge/kvs';
import { publishGlobal } from '@forge/realtime';
import Resolver from '@forge/resolver';
import { getConfig, rotateWebhookSecret, saveConfig, type AppConfig } from '../lib/config';
import { findProject } from '../lib/jira';
import { audit, recentAudit, runMigrations } from '../lib/sql';

export const SPIKE_CHANNEL = 'exhibita-platform-check';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

const resolver = new Resolver();

resolver.define('getSetup', async () => ({
  config: await getConfig(),
  webhookUrl: await webTrigger.getUrl('exhibita-dispute-intake').catch(() => null),
}));

resolver.define('saveSetup', async ({ payload }: { payload: Partial<AppConfig> }) => ({ config: await saveConfig(payload) }));

resolver.define('rotateSecret', async ({ context }) => {
  const secret = await rotateWebhookSecret();
  await audit(context.accountId ?? 'unknown', 'rotate-webhook-secret', null).catch(() => undefined);
  return { secret };
});

resolver.define('runChecks', async ({ context }) => {
  const config = await getConfig();
  const results = await Promise.all([
    check('Key-value storage', async () => {
      const key = 'platform-check';
      const value = { at: Date.now() };
      await kvs.set(key, value);
      const back = await kvs.get<{ at: number }>(key);
      if (back?.at !== value.at) throw new Error('Read back a different value');
      return 'write and read back OK';
    }),
    check('Forge SQL', async () => {
      const applied = await runMigrations();
      await audit(context.accountId ?? 'unknown', 'platform-check', null);
      const rows = await recentAudit(1);
      return `migrations: ${applied.join(', ')}; audit rows readable: ${rows.length}`;
    }),
    check(`Jira project ${config.projectKey}`, async () => {
      const project = await findProject(config.projectKey);
      if (!project) throw new Error(`No project with key ${config.projectKey}`);
      return `${project.name} (${project.projectTypeKey})`;
    }),
    check('Web trigger', async () => webTrigger.getUrl('exhibita-dispute-intake')),
    check('Realtime', async () => {
      await publishGlobal(SPIKE_CHANNEL, JSON.stringify({ at: Date.now() }));
      return 'published; the page shows whether it arrived';
    }),
    check('Teamwork Graph', async () => {
      const res = await api.asUser().requestTeamworkGraph('query { __typename }');
      const body = (await res.json()) as { errors?: { message: string }[] };
      if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
      return `HTTP ${res.status}`;
    }),
  ]);
  return { results };
});

export const adminHandler = resolver.getDefinitions();
