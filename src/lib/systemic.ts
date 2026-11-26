// The systemic view (M3): disputes grouped under the incident behind them, the blast radius, and the
// three confirmed actions. Decisions come from src/core (clusterDisputes, blastRadius,
// planClusterActions); this file only reads the inputs and carries out a confirmed plan (D-06).

import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { blastRadius, clusterDisputes, type BlastRadius, type Cluster, type DisputeCase } from '../core/cluster/cluster';
import { formatMoney, planClusterActions, type ClusterPlan } from '../core/cluster/plan';
import { whyWeLose, type LossInsight } from '../core/insights';
import { chooseWorkType, type WorkTypeOption } from '../core/intake/issue-type';
import { minor } from '../core/types';
import { getSources } from './collect-input';
import { getConfig } from './config';
import { JiraError } from './jira';
import { addComment, adfParagraphs, createIssuesBulk } from './jira-setup';
import { readStoredRecord } from './records';
import { affectedOrdersFor, allLedgerIssues, getOutcomes, queueProactiveRefunds, queuedRefundCount, voidRefunds } from './store';

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
/** Per your processor agreement; shown as an assumption on the page. */
export const DISPUTE_FEE_MINOR = 1500;
export const ANALYST_MINUTES_PER_DISPUTE = 25;
const ACCEPT_BATCH = 6;

/** What has been done to a cluster, so each action runs once and the page can show it. */
interface ClusterActions {
  accepted?: { at: string; by: string; count: number };
  refundsQueued?: { at: string; by: string; count: number; trackingKey: string | null };
  costBug?: { at: string; by: string; key: string };
}
/**
 * Keyed by the incident's issue id, not its key: a rebuilt demo can reuse the key INC-1 for a new issue,
 * and its cluster must not inherit the old one's actions (found live, 27 Nov).
 */
const actionsKey = (incidentId: string) => `cluster:${incidentId}`;

interface IssueInfo {
  id: string;
  key: string;
  summary: string;
  done: boolean;
  status: string;
}

async function searchIssues(jql: string, max = 100): Promise<IssueInfo[]> {
  const out: IssueInfo[] = [];
  let nextPageToken: string | undefined;
  do {
    const res = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ jql, fields: ['summary', 'status'], maxResults: max, ...(nextPageToken ? { nextPageToken } : {}) }),
    });
    const text = await res.text();
    if (!res.ok) throw new JiraError('Searching work items', res.status, text);
    const body = JSON.parse(text) as { issues: { id: string; key: string; fields: { summary?: string; status?: { name: string; statusCategory?: { key: string } } } }[]; nextPageToken?: string };
    for (const i of body.issues) {
      out.push({ id: i.id, key: i.key, summary: i.fields.summary ?? i.key, done: i.fields.status?.statusCategory?.key === 'done', status: i.fields.status?.name ?? '' });
    }
    nextPageToken = body.nextPageToken;
  } while (nextPageToken);
  return out;
}

const quote = (v: string) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** Every dispute in the ledger with its stored (authoritative) evidence. Issue properties are never read. */
async function loadCases(): Promise<{ cases: DisputeCase[]; issues: Map<string, IssueInfo> }> {
  const ledger = await allLedgerIssues();
  const issues = new Map<string, IssueInfo>();
  for (let i = 0; i < ledger.length; i += 50) {
    const keys = ledger.slice(i, i + 50).map((l) => l.issueKey);
    for (const info of await searchIssues(`key in (${keys.map(quote).join(', ')})`)) issues.set(info.key, info);
  }
  const cases = (
    await Promise.all(
      ledger.map(async (l): Promise<DisputeCase | null> => {
        const info = issues.get(l.issueKey);
        if (!info) return null;
        const record = await readStoredRecord(info.id);
        if (!record) return null;
        return { issueKey: l.issueKey, orderId: record.dispute.orderId, customer: record.dispute.customer, amount: record.dispute.amount, currency: record.dispute.currency, evidence: record.evidence };
      }),
    )
  ).filter((c): c is DisputeCase => c !== null);
  return { cases, issues };
}

/**
 * Id and title of each issue, read directly rather than through search: the search index can lag behind
 * issues created moments ago, which left the page without titles right after a rebuild.
 */
async function issuesByKey(keys: readonly string[]): Promise<Map<string, { id: string; summary: string }>> {
  const found = await Promise.all(
    keys.map(async (key) => {
      const res = await api.asApp().requestJira(route`/rest/api/3/issue/${key}?fields=summary`, { headers: JSON_HEADERS });
      if (!res.ok) return null;
      const body = (await res.json()) as { id: string; fields: { summary?: string } };
      return [key, { id: body.id, summary: body.fields.summary ?? key }] as const;
    }),
  );
  return new Map(found.filter((f): f is NonNullable<typeof f> => f !== null));
}

export interface ClusterView {
  cluster: Cluster;
  incidentId: string;
  blast: BlastRadius;
  plan: ClusterPlan;
  incidentTitle: string | null;
  deployTitle: string | null;
  disputes: { issueKey: string; amount: number; currency: string; status: string; done: boolean }[];
  openToAccept: number;
  actions: ClusterActions;
  queuedRefunds: number;
  labels: { disputed: string; cost: string; owed: string };
}

export interface SystemicView {
  clusters: ClusterView[];
  insights: LossInsight[];
  assumptions: { disputeFee: string; analystMinutesPerDispute: number };
}

async function buildClusters(): Promise<{ views: ClusterView[]; cases: DisputeCase[] }> {
  const { cases, issues } = await loadCases();
  const clusters = clusterDisputes(cases);
  const linked = await issuesByKey([...new Set(clusters.flatMap((c) => [c.incidentKey, ...(c.deployKey ? [c.deployKey] : [])]))]);
  const views = await Promise.all(
    clusters.map(async (cluster): Promise<ClusterView> => {
      const affected = (await affectedOrdersFor(cluster.incidentKey)).map((o) => ({ ...o, amount: minor(o.amount) }));
      const blast = blastRadius(cluster, affected, { disputeFee: minor(DISPUTE_FEE_MINOR), analystMinutesPerDispute: ANALYST_MINUTES_PER_DISPUTE });
      const incident = linked.get(cluster.incidentKey);
      const incidentId = incident?.id ?? cluster.incidentKey;
      const incidentTitle = incident?.summary ?? null;
      const deployTitle = cluster.deployKey ? (linked.get(cluster.deployKey)?.summary ?? null) : null;
      const plan = planClusterActions(cluster, cases, blast, { ...(incidentTitle ? { incidentTitle } : {}), ...(deployTitle ? { deployTitle } : {}) });
      const disputes = cluster.disputes.map((d) => {
        const info = issues.get(d.issueKey);
        return { issueKey: d.issueKey, amount: d.amount, currency: d.currency, status: info?.status ?? '', done: info?.done ?? false };
      });
      return {
        cluster,
        incidentId,
        blast,
        plan,
        incidentTitle,
        deployTitle,
        disputes,
        openToAccept: disputes.filter((d) => !d.done).length,
        actions: (await kvs.get<ClusterActions>(actionsKey(incidentId))) ?? {},
        queuedRefunds: await queuedRefundCount(cluster.incidentKey),
        labels: { disputed: formatMoney(cluster.totals), cost: formatMoney(blast.disputeCostSoFar), owed: formatMoney(blast.proactiveRefundTotals) },
      };
    }),
  );
  return { views, cases };
}

export async function systemicView(): Promise<SystemicView> {
  const [{ views }, outcomes] = await Promise.all([buildClusters(), getOutcomes()]);
  return {
    clusters: views,
    insights: whyWeLose(outcomes),
    assumptions: { disputeFee: formatMoney({ amount: minor(DISPUTE_FEE_MINOR), currency: 'USD' }), analystMinutesPerDispute: ANALYST_MINUTES_PER_DISPUTE },
  };
}

async function clusterView(incidentKey: string): Promise<ClusterView> {
  const { views } = await buildClusters();
  const view = views.find((v) => v.cluster.incidentKey === incidentKey);
  if (!view) throw new Error(`No cluster of disputes is linked to ${incidentKey} any more.`);
  return view;
}

/**
 * Accept the next few open disputes in the cluster as the user, comment on each, and cancel their stuck
 * refunds. Called repeatedly until nothing is left, so each call stays inside the time limit.
 */
export async function acceptClusterStep(incidentKey: string, accountId: string): Promise<{ accepted: string[]; remaining: number }> {
  const view = await clusterView(incidentKey);
  // Settle first what an earlier call accepted but may not have finished cancelling: cancelling is
  // idempotent, so repeating it is harmless, and skipping it could pay a customer twice.
  const statusOf = (key: string) => view.disputes.find((d) => d.issueKey === key);
  await voidRefunds(
    view.plan.accept.filter((a) => statusOf(a.issueKey)?.status === 'Accepted').flatMap((a) => a.refundIds),
    `Settled by accepting the chargeback (${incidentKey} cluster)`,
  );
  const open = view.plan.accept.filter((a) => !statusOf(a.issueKey)?.done);
  const batch = open.slice(0, ACCEPT_BATCH);
  const accepted: string[] = [];
  for (const item of batch) {
    const tr = await api.asUser().requestJira(route`/rest/api/3/issue/${item.issueKey}/transitions`, { headers: JSON_HEADERS });
    if (!tr.ok) throw new JiraError(`Reading transitions of ${item.issueKey}`, tr.status, await tr.text());
    const transition = ((await tr.json()) as { transitions: { id: string; name: string }[] }).transitions.find((t) => t.name === 'Accept dispute');
    if (!transition) throw new Error(`${item.issueKey} cannot be accepted from its current status.`);
    const res = await api.asUser().requestJira(route`/rest/api/3/issue/${item.issueKey}/transitions`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
    if (!res.ok) throw new JiraError(`Accepting ${item.issueKey}`, res.status, await res.text());
    // Only once the chargeback is accepted does it settle the amount, so only then is the stuck refund
    // cancelled. A failure here is repaired by the next call (above).
    await voidRefunds(item.refundIds, `Settled by accepting the chargeback on ${item.issueKey}`);
    await addComment(item.issueKey, item.comment, api.asUser());
    accepted.push(item.issueKey);
  }
  const remaining = open.length - batch.length;
  if (remaining === 0) {
    const actions = (await kvs.get<ClusterActions>(actionsKey(view.incidentId))) ?? {};
    actions.accepted = { at: new Date().toISOString(), by: accountId, count: view.plan.accept.length };
    await kvs.set(actionsKey(view.incidentId), actions);
  }
  return { accepted, remaining };
}

async function workTypeFor(projectKey: string, preferred: string): Promise<WorkTypeOption> {
  const p = await api.asApp().requestJira(route`/rest/api/3/project/${projectKey}`, { headers: JSON_HEADERS });
  if (!p.ok) throw new JiraError(`Reading project ${projectKey}`, p.status, await p.text());
  const project = (await p.json()) as { id: string };
  const res = await api.asApp().requestJira(route`/rest/api/3/issuetype/project?projectId=${project.id}`, { headers: JSON_HEADERS });
  const types = (await res.json()) as WorkTypeOption[];
  const chosen = types.find((t) => t.name === preferred) ?? chooseWorkType(types);
  if (!chosen) throw new Error(`Project ${projectKey} has no usable work type`);
  return chosen;
}

async function relate(fromKey: string, toKey: string): Promise<void> {
  const res = await api.asUser().requestJira(route`/rest/api/3/issueLink`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ type: { name: 'Relates' }, inwardIssue: { key: fromKey }, outwardIssue: { key: toKey } }),
  });
  if (!res.ok) console.warn(`Could not link ${fromKey} to ${toKey}`, res.status);
}

/** Queue refunds for the affected customers who have not disputed, with one tracking work item. */
export async function queueClusterRefunds(incidentKey: string, accountId: string): Promise<{ count: number; trackingKey: string | null }> {
  const view = await clusterView(incidentKey);
  const actions = view.actions;
  if (actions.refundsQueued) return { count: actions.refundsQueued.count, trackingKey: actions.refundsQueued.trackingKey };
  const orders = view.plan.proactive;
  const sources = await getSources();
  const projectKey = sources.ticketProjectKey ?? (await getConfig()).projectKey;
  const type = await workTypeFor(projectKey, 'Task');
  const lines = orders.slice(0, 25).map((o) => `${o.orderId} · ${o.customer} · ${formatMoney({ amount: o.amount, currency: o.currency })}`);
  const result = await createIssuesBulk(
    [
      {
        fields: {
          project: { key: projectKey },
          issuetype: { id: type.id },
          summary: `Proactive refunds for ${incidentKey}: ${orders.length} customers, ${view.labels.owed}`,
          description: adfParagraphs(
            [
              `${orders.length} customers were affected by ${incidentKey}${view.incidentTitle ? ` (${view.incidentTitle})` : ''} and have not disputed. Refunding them now avoids ${orders.length} possible disputes and their fees.`,
              'The full list is in the Exhibita refund queue. First orders:',
              ...lines,
              orders.length > lines.length ? `and ${orders.length - lines.length} more.` : '',
            ].join('\n'),
          ),
          labels: ['exhibita', 'proactive-refund'],
        },
      },
    ],
    api.asUser(),
  );
  const trackingKey = result.created[0]?.key ?? null;
  if (!trackingKey) throw new Error(`Jira refused the tracking work item: ${result.errors[0] ?? 'unknown error'}`);
  await queueProactiveRefunds(incidentKey, orders, accountId, trackingKey);
  await relate(incidentKey, trackingKey);
  actions.refundsQueued = { at: new Date().toISOString(), by: accountId, count: orders.length, trackingKey };
  await kvs.set(actionsKey(view.incidentId), actions);
  return { count: orders.length, trackingKey };
}

/** File the cost bug on the deploy (or the incident when no deploy is linked). */
export async function fileCostBug(incidentKey: string, accountId: string): Promise<{ key: string }> {
  const view = await clusterView(incidentKey);
  const actions = view.actions;
  if (actions.costBug) return { key: actions.costBug.key };
  const sources = await getSources();
  const culprit = view.cluster.deployKey ?? incidentKey;
  const projectKey = (view.cluster.deployKey ? sources.deployProjectKey : sources.incidentProjectKey) ?? culprit.split('-')[0]!;
  const type = await workTypeFor(projectKey, 'Bug');
  const result = await createIssuesBulk(
    [{ fields: { project: { key: projectKey }, issuetype: { id: type.id }, summary: view.plan.costBug.summary, description: adfParagraphs(view.plan.costBug.description), labels: ['exhibita', 'dispute-cost'] } }],
    api.asUser(),
  );
  const key = result.created[0]?.key;
  if (!key) throw new Error(`Jira refused the cost bug: ${result.errors[0] ?? 'unknown error'}`);
  await relate(culprit, key);
  if (culprit !== incidentKey) await relate(incidentKey, key);
  actions.costBug = { at: new Date().toISOString(), by: accountId, key };
  await kvs.set(actionsKey(view.incidentId), actions);
  return { key };
}
