// Backend for the Exhibita page: the incidents behind disputes and the confirmed cluster actions.

import Resolver from '@forge/resolver';
import { getConfig } from '../lib/config';
import { requireProjectPermissions } from '../lib/permissions';
import { audit } from '../lib/sql';
import { acceptClusterStep, fileCostBug, queueClusterRefunds, systemicView } from '../lib/systemic';

const resolver = new Resolver();

const incidentOf = (payload: unknown): string => {
  const key = (payload as { incidentKey?: unknown } | undefined)?.incidentKey;
  if (typeof key !== 'string' || !/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new Error('Choose an incident cluster first.');
  return key;
};

/** Every action changes disputes in the disputes project, so the user must be able to work them there. */
async function requireDisputeWork(): Promise<string> {
  const { projectKey } = await getConfig();
  await requireProjectPermissions(projectKey, ['BROWSE_PROJECTS', 'TRANSITION_ISSUES', 'ADD_COMMENTS'], 'work disputes');
  return projectKey;
}

resolver.define('getView', async () => {
  const { projectKey } = await getConfig();
  await requireProjectPermissions(projectKey, ['BROWSE_PROJECTS'], 'see disputes');
  return systemicView();
});

resolver.define('acceptStep', async ({ payload, context }) => {
  await requireDisputeWork();
  const incidentKey = incidentOf(payload);
  const result = await acceptClusterStep(incidentKey, context.accountId ?? 'unknown');
  await audit(context.accountId ?? 'unknown', 'cluster-accept', null, { incidentKey, accepted: result.accepted }).catch(() => undefined);
  return result;
});

resolver.define('queueRefunds', async ({ payload, context }) => {
  await requireDisputeWork();
  const incidentKey = incidentOf(payload);
  const result = await queueClusterRefunds(incidentKey, context.accountId ?? 'unknown');
  await audit(context.accountId ?? 'unknown', 'cluster-queue-refunds', null, { incidentKey, ...result }).catch(() => undefined);
  return result;
});

resolver.define('fileCostBug', async ({ payload, context }) => {
  await requireDisputeWork();
  const incidentKey = incidentOf(payload);
  const result = await fileCostBug(incidentKey, context.accountId ?? 'unknown');
  await audit(context.accountId ?? 'unknown', 'cluster-cost-bug', null, { incidentKey, ...result }).catch(() => undefined);
  return result;
});

export const systemicHandler = resolver.getDefinitions();
