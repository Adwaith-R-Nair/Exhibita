// Backend for the Exhibita setup page: configuration, webhook secret, and platform checks.

import api, { route, webTrigger } from '@forge/api';
import { kvs } from '@forge/kvs';
import { publishGlobal } from '@forge/realtime';
import Resolver from '@forge/resolver';
import { getConfig, rotateWebhookSecret, saveConfig, type AppConfig } from '../lib/config';
import { createServiceProject, ensureProjectRoles, findProject } from '../lib/jira';
import { runValidationSuite } from '../core/validation/suite';
import { removeDemoStep } from '../lib/remove-demo';
import { runSeedStep, seedProgress, startSeed } from '../lib/seed';
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

resolver.define('createProject', async ({ context }) => {
  const config = await getConfig();
  const existing = await findProject(config.projectKey);
  const project = existing ?? (await createServiceProject(config.projectKey, 'Disputes'));
  const rolesAdded = context.accountId ? await ensureProjectRoles(project.key, context.accountId) : [];
  await audit(context.accountId ?? 'unknown', existing ? 'set-up-project' : 'create-project', null).catch(() => undefined);
  return { project, created: !existing, rolesAdded };
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
    check('Confluence', async () => {
      // Read as the app and as the admin: policy pages are written as the admin, read back as the app.
      const asApp = await api.asApp().requestConfluence(route`/wiki/api/v2/spaces?limit=1`);
      const asUser = await api.asUser().requestConfluence(route`/wiki/api/v2/spaces?limit=1`);
      if (!asApp.ok || !asUser.ok) throw new Error(`as app HTTP ${asApp.status}, as you HTTP ${asUser.status}: ${(await (asApp.ok ? asUser : asApp).text()).slice(0, 200)}`);
      return 'spaces readable as the app and as you';
    }),
    check('Teamwork Graph', async () => {
      const res = await api.asUser().requestTeamworkGraph('query exhibita_platformCheck { __typename }');
      const body = (await res.json()) as { errors?: { message: string }[] };
      if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
      return `HTTP ${res.status}`;
    }),
  ]);
  return { results };
});

resolver.define('runValidation', async () => runValidationSuite());

resolver.define('seedStatus', async () => seedProgress());

resolver.define('seedStart', async ({ context }) => {
  await audit(context.accountId ?? 'unknown', 'demo-setup-start', null).catch(() => undefined);
  return startSeed();
});

resolver.define('seedStep', async ({ context }) => {
  const localId = (context as { localId?: string }).localId;
  if (!context.accountId || !localId) throw new Error('Run demo setup from the Exhibita setup page as a site admin.');
  return runSeedStep({ accountId: context.accountId, localId });
});

resolver.define('removeStep', async ({ context }) => {
  const result = await removeDemoStep();
  if (result.status === 'done') await audit(context.accountId ?? 'unknown', 'demo-remove', null).catch(() => undefined);
  return result;
});

export const adminHandler = resolver.getDefinitions();
