// Thin, typed wrappers over the Jira REST API. Everything that talks to Jira goes through here.

import api, { route } from '@forge/api';
import { asDisputeRecord, RECORD_PROPERTY_KEY, type DisputeRecord } from '../core/record.js';

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${message} (HTTP ${status}): ${body.slice(0, 300)}`);
  }
}

type Requester = ReturnType<typeof api.asApp>;

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

interface IssueTypeSummary {
  id: string;
  name: string;
  subtask: boolean;
}

/** Prefer an issue type called "Dispute"; otherwise the first standard type in the project. */
export async function pickIssueType(projectId: string, as: Requester = api.asApp()): Promise<IssueTypeSummary> {
  const res = await as.requestJira(route`/rest/api/3/issuetype/project?projectId=${projectId}`);
  const types = await json<IssueTypeSummary[]>(res, 'Reading issue types');
  const standard = types.filter((t) => !t.subtask);
  const chosen = standard.find((t) => t.name.toLowerCase() === 'dispute') ?? standard[0];
  if (!chosen) throw new Error(`Project ${projectId} has no standard issue types`);
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

/** Find the work item already created for a processor dispute id, so redelivered webhooks don't duplicate it. */
export async function findIssueByExternalId(projectKey: string, externalId: string, as: Requester = api.asApp()): Promise<string | null> {
  const jql = `project = "${projectKey}" AND issue.property[${RECORD_PROPERTY_KEY}].dispute.externalId = "${externalId}"`;
  const res = await as.requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jql, maxResults: 1, fields: ['key'] }),
  });
  const body = await json<{ issues: { key: string }[] }>(res, 'Searching for an existing dispute');
  return body.issues[0]?.key ?? null;
}
