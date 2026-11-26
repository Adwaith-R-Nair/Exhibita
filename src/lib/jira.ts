// Thin, typed wrappers over the Jira REST API. Everything that talks to Jira goes through here.

import api, { route } from '@forge/api';
import { chooseWorkType, type WorkTypeOption } from '../core/intake/issue-type';
import { asDisputeRecord, RECORD_PROPERTY_KEY, type DisputeRecord } from '../core/record';

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${message} (HTTP ${status}): ${body.slice(0, 300)}`);
  }
}

// asApp and asUser both provide requestJira, which is all these wrappers use.
type Requester = Pick<ReturnType<typeof api.asApp>, 'requestJira'>;

async function json<T>(res: Awaited<ReturnType<Requester['requestJira']>>, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new JiraError(what, res.status, text);
  return (text ? JSON.parse(text) : null) as T;
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
}

export async function findProject(key: string, as: Requester = api.asApp()): Promise<ProjectSummary | null> {
  const res = await as.requestJira(route`/rest/api/3/project/${key}`);
  if (res.status === 404) return null;
  return json<ProjectSummary>(res, `Reading project ${key}`);
}

export async function listProjects(as: Requester = api.asApp()): Promise<ProjectSummary[]> {
  const res = await as.requestJira(route`/rest/api/3/project/search?maxResults=50`);
  const body = await json<{ values: ProjectSummary[] }>(res, 'Listing projects');
  return body.values;
}

/** Service project templates to try, most fitting first. Sites differ in which ones they offer. */
export const SERVICE_PROJECT_TEMPLATES = [
  // Verified live (26 Nov): creates a company-managed service project with a real service desk.
  // 'simplified-general-service-desk' looked accepted but built a shell project with no service desk.
  'com.atlassian.servicedesk:simplified-finance-service-desk',
  'com.atlassian.servicedesk:simplified-it-service-management',
] as const;

/**
 * Create the Jira Service Management project disputes land in. Runs as the admin who clicked the
 * button, who becomes the project lead. Tries each template until the site accepts one.
 */
export async function createServiceProject(
  key: string,
  name: string,
  as: Requester = api.asUser(),
): Promise<ProjectSummary & { template: string }> {
  const me = await json<{ accountId: string }>(await as.requestJira(route`/rest/api/3/myself`), 'Reading the current user');
  let lastError: unknown = null;
  for (const template of SERVICE_PROJECT_TEMPLATES) {
    const res = await as.requestJira(route`/rest/api/3/project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        key,
        name,
        projectTypeKey: 'service_desk',
        projectTemplateKey: template,
        leadAccountId: me.accountId,
        assigneeType: 'UNASSIGNED',
        description: 'Card disputes, one work item per chargeback. Created by Exhibita.',
      }),
    });
    try {
      await json<{ id: number; key: string }>(res, `Creating project ${key} from ${template}`);
      const project = await findProject(key, as);
      if (!project) throw new Error(`Project ${key} was created but cannot be read back`);
      return { ...project, template };
    } catch (error) {
      lastError = error;
      // A 400 that names the template means the site doesn't offer it; try the next one.
      if (!(error instanceof JiraError) || error.status !== 400 || !/template/i.test(error.body)) throw error;
    }
  }
  throw lastError;
}

/**
 * Put a user in the project's admin and agent roles. Creating a service project through the REST
 * API makes the caller the lead but not an agent, and JSM hides app panels from non-agents.
 */
export async function ensureProjectRoles(
  key: string,
  accountId: string,
  roleNames: readonly string[] = ['Administrators', 'Service Desk Team'],
  as: Requester = api.asUser(),
): Promise<string[]> {
  const roles = await json<Record<string, string>>(await as.requestJira(route`/rest/api/3/project/${key}/role`), `Reading roles of ${key}`);
  const added: string[] = [];
  for (const name of roleNames) {
    const url = roles[name];
    const id = url?.split('/').pop();
    if (!id) continue;
    const role = await json<{ actors?: { actorUser?: { accountId: string } }[] }>(
      await as.requestJira(route`/rest/api/3/project/${key}/role/${id}`),
      `Reading role ${name}`,
    );
    if (role.actors?.some((a) => a.actorUser?.accountId === accountId)) continue;
    await json(
      await as.requestJira(route`/rest/api/3/project/${key}/role/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ user: [accountId] }),
      }),
      `Adding the user to ${name}`,
    );
    added.push(name);
  }
  return added;
}

/** The standard work type disputes are created as (see chooseWorkType). */
export async function pickIssueType(projectId: string, as: Requester = api.asApp()): Promise<WorkTypeOption> {
  const res = await as.requestJira(route`/rest/api/3/issuetype/project?projectId=${projectId}`);
  const chosen = chooseWorkType(await json<WorkTypeOption[]>(res, 'Reading issue types'));
  if (!chosen) throw new Error(`Project ${projectId} has no standard work types`);
  return chosen;
}

export async function createIssue(
  fields: { projectId: string; issueTypeId: string; summary: string; description: string; labels?: string[] },
  as: Requester = api.asApp(),
): Promise<{ id: string; key: string }> {
  const res = await as.requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      fields: {
        project: { id: fields.projectId },
        issuetype: { id: fields.issueTypeId },
        summary: fields.summary,
        labels: fields.labels ?? [],
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: fields.description }] }],
        },
      },
    }),
  });
  return json<{ id: string; key: string }>(res, 'Creating issue');
}

export async function readDisputeRecord(issueKey: string, as: Requester = api.asApp()): Promise<DisputeRecord | null> {
  const res = await as.requestJira(route`/rest/api/3/issue/${issueKey}/properties/${RECORD_PROPERTY_KEY}`);
  if (res.status === 404) return null;
  const body = await json<{ value: unknown }>(res, `Reading dispute record on ${issueKey}`);
  return asDisputeRecord(body.value);
}

export async function writeDisputeRecord(issueKey: string, record: DisputeRecord, as: Requester = api.asApp()): Promise<void> {
  const res = await as.requestJira(route`/rest/api/3/issue/${issueKey}/properties/${RECORD_PROPERTY_KEY}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
  if (!res.ok) throw new JiraError(`Writing dispute record on ${issueKey}`, res.status, await res.text());
}

/** The work item's numeric id, or null if it doesn't exist (it may have been deleted since we recorded it). */
export async function getIssueId(issueKey: string, as: Requester = api.asApp()): Promise<string | null> {
  const res = await as.requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary`);
  if (res.status === 404) return null;
  return (await json<{ id: string }>(res, `Reading ${issueKey}`)).id;
}

/** Find the work item already created for a processor dispute id, so redelivered webhooks don't duplicate it. */

export async function findIssueByExternalId(projectKey: string, externalId: string, as: Requester = api.asApp()): Promise<string | null> {
  const quoted = (v: string) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  const jql = `project = ${quoted(projectKey)} AND issue.property[${RECORD_PROPERTY_KEY}].dispute.externalId = ${quoted(externalId)}`;
  const res = await as.requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jql, maxResults: 1, fields: ['key'] }),
  });
  const body = await json<{ issues: { key: string }[] }>(res, 'Searching for an existing dispute');
  return body.issues[0]?.key ?? null;
}
