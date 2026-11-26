// Jira configuration the setup wizard needs: work types, schemes, the dispute workflow, projects and
// link types. Every function is find-or-create, so a wizard step can be re-run safely (D-05).
// Runs as the admin who clicked the button: some of these calls are admin-only.

import api, { route } from '@forge/api';
import {
  DISPUTE_STATUSES,
  DISPUTE_WORKFLOW_NAME,
  disputeWorkflowCreateBody,
  hasSubmitValidator,
} from '../core/setup/workflow';
import { findProject, JiraError, SERVICE_PROJECT_TEMPLATES, type ProjectSummary } from './jira';

// Both requesters share requestJira; asApp lacks only the external-auth helpers we never use.
type Requester = Pick<ReturnType<typeof api.asApp>, 'requestJira'>;

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

async function call<T>(as: Requester, path: ReturnType<typeof route>, what: string, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await as.requestJira(path, init ? { method: init.method, headers: JSON_HEADERS, body: init.body === undefined ? undefined : JSON.stringify(init.body) } : { headers: JSON_HEADERS });
  const text = await res.text();
  if (!res.ok) throw new JiraError(what, res.status, text);
  return (text ? JSON.parse(text) : null) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------
// Work types and work type schemes
// ------------------------------------------------------------------------------------------------

interface IssueTypeInfo {
  id: string;
  name: string;
  subtask: boolean;
  scope?: unknown;
}

/** A global, standard work type with this name, created if missing. */
export async function ensureWorkType(name: string, description: string, as: Requester = api.asUser()): Promise<string> {
  const all = await call<IssueTypeInfo[]>(as, route`/rest/api/3/issuetype`, 'Listing work types');
  const hit = all.find((t) => !t.scope && !t.subtask && t.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  const created = await call<{ id: string }>(as, route`/rest/api/3/issuetype`, `Creating work type ${name}`, {
    method: 'POST',
    body: { name, description, hierarchyLevel: 0 },
  });
  return created.id;
}

/**
 * Make these work types available in the project. A scheme shared with other projects is never edited:
 * the project gets its own copy, so other projects are untouched.
 */
export async function ensureWorkTypesInProject(project: ProjectSummary, typeIds: readonly string[], as: Requester = api.asUser()): Promise<void> {
  const mapping = await call<{ values: { issueTypeScheme: { id: string; name: string; isDefault?: boolean }; projectIds: string[] }[] }>(
    as, route`/rest/api/3/issuetypescheme/project?projectId=${project.id}`, `Reading the work type scheme of ${project.key}`,
  );
  const entry = mapping.values[0];
  if (!entry) throw new Error(`Project ${project.key} has no work type scheme`);
  const schemeId = entry.issueTypeScheme.id;
  const items = await call<{ values: { issueTypeId: string }[] }>(
    as, route`/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId=${schemeId}&maxResults=100`, 'Reading the scheme work types',
  );
  const current = items.values.map((v) => v.issueTypeId);
  const missing = typeIds.filter((id) => !current.includes(id));
  if (missing.length === 0) return;

  const shared = entry.issueTypeScheme.isDefault || schemeId === '10000' || entry.projectIds.length > 1;
  if (!shared) {
    await call(as, route`/rest/api/3/issuetypescheme/${schemeId}/issuetype`, 'Adding work types to the scheme', {
      method: 'PUT',
      body: { issueTypeIds: missing },
    });
    return;
  }
  const created = await call<{ issueTypeSchemeId: string }>(as, route`/rest/api/3/issuetypescheme`, 'Creating a work type scheme', {
    method: 'POST',
    body: { name: `${project.key}: Exhibita work types`, description: `Work types for ${project.name}, set up by Exhibita.`, issueTypeIds: [...current, ...missing] },
  });
  await call(as, route`/rest/api/3/issuetypescheme/project`, 'Assigning the work type scheme', {
    method: 'PUT',
    body: { issueTypeSchemeId: created.issueTypeSchemeId, projectId: project.id },
  });
}

// ------------------------------------------------------------------------------------------------
// Projects
// ------------------------------------------------------------------------------------------------

async function myAccountId(as: Requester): Promise<string> {
  return (await call<{ accountId: string }>(as, route`/rest/api/3/myself`, 'Reading the current user')).accountId;
}

async function createProject(key: string, name: string, description: string, typeKey: string, templates: readonly string[], as: Requester): Promise<ProjectSummary> {
  const lead = await myAccountId(as);
  let last: unknown = null;
  for (const template of templates) {
    try {
      await call(as, route`/rest/api/3/project`, `Creating project ${key}`, {
        method: 'POST',
        body: { key, name, description, projectTypeKey: typeKey, projectTemplateKey: template, leadAccountId: lead, assigneeType: 'UNASSIGNED' },
      });
      const project = await findProject(key, as);
      if (!project) throw new Error(`Project ${key} was created but cannot be read back`);
      return project;
    } catch (error) {
      last = error;
      if (!(error instanceof JiraError) || error.status !== 400 || !/template/i.test(error.body)) throw error;
    }
  }
  throw last;
}

/** A company-managed service project (verified: the finance template gives a real service desk). */
export async function ensureServiceProject(key: string, name: string, description: string, as: Requester = api.asUser()) {
  const existing = await findProject(key, as);
  if (existing) return { project: existing, created: false };
  return { project: await createProject(key, name, description, 'service_desk', SERVICE_PROJECT_TEMPLATES, as), created: true };
}

export const SOFTWARE_PROJECT_TEMPLATES = ['com.pyxis.greenhopper.jira:gh-simplified-kanban-classic'] as const;

/** A company-managed software project, for incidents and deploys. */
export async function ensureSoftwareProject(key: string, name: string, description: string, as: Requester = api.asUser()) {
  const existing = await findProject(key, as);
  if (existing) return { project: existing, created: false };
  return { project: await createProject(key, name, description, 'software', SOFTWARE_PROJECT_TEMPLATES, as), created: true };
}

/**
 * Permanently delete a project setup created. Only ever called for demo projects that hold synthetic data
 * the wizard generated. Not the trash: a trashed project keeps its key and name for 60 days, so every
 * remove and set-up cycle would drift to SUP2, SUP3 and so on (found live, 27 Nov).
 */
export async function deleteDemoProject(key: string, as: Requester = api.asUser()): Promise<boolean> {
  const res = await as.requestJira(route`/rest/api/3/project/${key}?enableUndo=false`, { method: 'DELETE' });
  if (res.status === 404) return false;
  if (!res.ok) throw new JiraError(`Deleting demo project ${key}`, res.status, await res.text());
  return true;
}

// ------------------------------------------------------------------------------------------------
// The dispute workflow
// ------------------------------------------------------------------------------------------------

interface WorkflowRead {
  id: string;
  name: string;
  transitions: { name: string; validators?: { ruleKey: string; parameters?: Record<string, unknown> }[] }[];
}

async function findWorkflow(name: string, as: Requester): Promise<WorkflowRead | null> {
  const res = await call<{ workflows: WorkflowRead[] }>(as, route`/rest/api/3/workflows`, `Reading workflow ${name}`, {
    method: 'POST',
    body: { workflowNames: [name] },
  }).catch((e: unknown) => {
    if (e instanceof JiraError && (e.status === 404 || e.status === 400)) return { workflows: [] };
    throw e;
  });
  return res.workflows.find((w) => w.name === name) ?? null;
}

async function existingStatusIds(as: Requester): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // One lookup per status, in parallel: seven sequential calls were a large part of the step's time.
  await Promise.all(DISPUTE_STATUSES.map(async (s) => {
    const res = await call<{ values: { id: string; name: string; statusCategory: string; scope?: { type: string } }[] }>(
      as, route`/rest/api/3/statuses/search?searchString=${s.name}&maxResults=50`, `Looking up status ${s.name}`,
    );
    const hit = res.values.find((v) => v.name.toLowerCase() === s.name.toLowerCase() && (!v.scope || v.scope.type === 'GLOBAL') && v.statusCategory === s.category);
    if (hit) out[s.name] = hit.id;
  }));
  return out;
}

export type WorkflowSetup = { workflowId: string; created: boolean; validator: 'present' | 'missing' };

/** Create the dispute workflow with the submit validator, or report on the one that exists. */
export async function ensureDisputeWorkflow(validatorKey: string, as: Requester = api.asUser()): Promise<WorkflowSetup> {
  const existing = await findWorkflow(DISPUTE_WORKFLOW_NAME, as);
  if (existing) {
    return { workflowId: existing.id, created: false, validator: hasSubmitValidator(existing.transitions, validatorKey) ? 'present' : 'missing' };
  }
  const body = disputeWorkflowCreateBody({ existingStatusIds: await existingStatusIds(as), validatorKey, uuid: () => crypto.randomUUID() });
  const created = await call<{ workflows: { id: string }[] }>(as, route`/rest/api/3/workflows/create`, 'Creating the dispute workflow', {
    method: 'POST',
    body,
  });
  const id = created.workflows[0]?.id;
  if (!id) throw new Error('Jira did not return the new workflow');
  const check = await findWorkflow(DISPUTE_WORKFLOW_NAME, as);
  return { workflowId: id, created: true, validator: check && hasSubmitValidator(check.transitions, validatorKey) ? 'present' : 'missing' };
}

interface WorkflowScheme {
  id: number;
  name: string;
  defaultWorkflow: string;
  issueTypeMappings: Record<string, string>;
  projectIds?: string[];
}

async function statusIdsOfWorkflow(name: string, as: Requester): Promise<string[]> {
  const res = await call<{ values: { statuses?: { id: string }[] }[] }>(
    as, route`/rest/api/3/workflow/search?workflowName=${name}&expand=statuses`, `Reading statuses of ${name}`,
  );
  return (res.values[0]?.statuses ?? []).map((s) => s.id);
}

/** Work items of this type already in the project. Remapping their workflow would move them all to New. */
async function countItemsOfType(project: ProjectSummary, typeId: string, as: Requester): Promise<number> {
  const res = await call<{ count: number }>(as, route`/rest/api/3/search/approximate-count`, 'Counting work items', {
    method: 'POST',
    body: { jql: `project = "${project.key}" AND issuetype = ${typeId}` },
  });
  return res.count;
}

/**
 * Start mapping the work type to the dispute workflow in the project's workflow scheme. Active schemes
 * change through a draft that Jira publishes asynchronously, so this returns the publish task, polled
 * with publishTaskStatus on later calls; each resolver call stays well inside its time limit.
 */
export async function startDisputeWorkflowMapping(project: ProjectSummary, typeId: string, as: Requester = api.asUser()): Promise<'already' | { taskId: string }> {
  const res = await call<{ values: { workflowScheme: WorkflowScheme; projectIds: string[] }[] }>(
    as, route`/rest/api/3/workflowscheme/project?projectId=${project.id}`, `Reading the workflow scheme of ${project.key}`,
  );
  const entry = res.values[0];
  if (!entry) throw new Error(`Project ${project.key} has no workflow scheme`);
  const scheme = entry.workflowScheme;
  if (scheme.issueTypeMappings[typeId] === DISPUTE_WORKFLOW_NAME) return 'already';
  if (entry.projectIds.length > 1) {
    throw new Error(`The workflow scheme "${scheme.name}" is shared with other projects. Give ${project.key} its own scheme, then resume setup.`);
  }
  const existingItems = await countItemsOfType(project, typeId, as);
  if (existingItems > 0) {
    throw new Error(`${project.key} already has ${existingItems} work items of type Dispute on another workflow. Switching would move them all to New, so setup stopped. Choose an empty disputes project, or map the workflow by hand.`);
  }

  const oldWorkflow = scheme.issueTypeMappings[typeId] ?? scheme.defaultWorkflow;
  const newStatusId = (await existingStatusIds(as))['New'];
  if (!newStatusId) throw new Error('The New status is missing; create the dispute workflow first');
  const oldStatuses = await statusIdsOfWorkflow(oldWorkflow, as).catch(() => [] as string[]);

  await call(as, route`/rest/api/3/workflowscheme/${scheme.id}/createdraft`, 'Drafting the workflow scheme', { method: 'POST' }).catch((e: unknown) => {
    // A draft may already exist from an earlier, interrupted run.
    if (!(e instanceof JiraError && e.status === 400)) throw e;
  });
  await call(as, route`/rest/api/3/workflowscheme/${scheme.id}/draft/issuetype/${typeId}`, 'Mapping the work type in the draft', {
    method: 'PUT',
    body: { issueType: typeId, workflow: DISPUTE_WORKFLOW_NAME },
  });
  const statusMappings = oldStatuses.filter((id) => id !== newStatusId).map((statusId) => ({ issueTypeId: typeId, statusId, newStatusId }));
  const task = await call<{ self: string }>(as, route`/rest/api/3/workflowscheme/${scheme.id}/draft/publish`, 'Publishing the workflow scheme', {
    method: 'POST',
    body: { statusMappings },
  });
  return { taskId: task.self.split('/').pop() ?? '' };
}

/** Poll a publish task briefly. 'running' means call again later. */
export async function publishTaskStatus(taskId: string, as: Requester = api.asUser()): Promise<'complete' | 'running'> {
  for (let i = 0; i < 5; i++) {
    const t = await call<{ status: string; message?: string }>(as, route`/rest/api/3/task/${taskId}`, 'Checking the publish task');
    if (t.status === 'COMPLETE') return 'complete';
    if (['FAILED', 'CANCELLED', 'DEAD'].includes(t.status)) throw new Error(`Publishing the workflow scheme failed: ${t.message ?? t.status}`);
    await sleep(1000);
  }
  return 'running';
}

// ------------------------------------------------------------------------------------------------
// Links and issues
// ------------------------------------------------------------------------------------------------

export const CAUSES_LINK = { name: 'Causes', outward: 'causes', inward: 'is caused by' } as const;

/** The "Causes" link type that records an explicit cause (invariant 7). JSM sites usually have it. */
export async function ensureCausesLinkType(as: Requester = api.asUser()): Promise<string> {
  const res = await call<{ issueLinkTypes: { name: string; inward: string; outward: string }[] }>(as, route`/rest/api/3/issueLinkType`, 'Listing link types');
  const hit = res.issueLinkTypes.find((t) => t.outward.toLowerCase() === CAUSES_LINK.outward && t.inward.toLowerCase() === CAUSES_LINK.inward);
  if (hit) return hit.name;
  await call(as, route`/rest/api/3/issueLinkType`, 'Creating the Causes link type', { method: 'POST', body: CAUSES_LINK });
  return CAUSES_LINK.name;
}

export interface BulkResult {
  /** One entry per input, in input order: the created work item, or null where Jira refused it. */
  created: ({ id: string; key: string } | null)[];
  /** Why the refused ones failed, for the error message. */
  errors: string[];
}

/**
 * Create up to 50 work items in one call. Jira creates the good ones even when some fail, so the result
 * keeps every success by position; callers record those before reporting the failures, or a resumed run
 * would create them twice (review C).
 */
export async function createIssuesBulk(issueUpdates: readonly { fields: Record<string, unknown> }[], as: Requester = api.asApp()): Promise<BulkResult> {
  if (issueUpdates.length > 50) throw new RangeError('Jira creates at most 50 work items per call');
  const res = await as.requestJira(route`/rest/api/3/issue/bulk`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ issueUpdates }) });
  const text = await res.text();
  if (!res.ok && res.status !== 400) throw new JiraError('Creating work items', res.status, text);
  const body = (text ? JSON.parse(text) : {}) as { issues?: { id: string; key: string }[]; errors?: { failedElementNumber: number; elementErrors: unknown }[] };
  const failed = new Set((body.errors ?? []).map((e) => e.failedElementNumber));
  const ok = [...(body.issues ?? [])];
  const created = issueUpdates.map((_, i) => (failed.has(i) ? null : (ok.shift() ?? null)));
  return { created, errors: (body.errors ?? []).map((e) => JSON.stringify(e.elementErrors).slice(0, 200)) };
}

export async function addComment(issueKey: string, text: string, as: Requester = api.asApp()): Promise<string> {
  const res = await call<{ id: string }>(as, route`/rest/api/3/issue/${issueKey}/comment`, `Commenting on ${issueKey}`, {
    method: 'POST',
    body: { body: adfParagraphs(text) },
  });
  return res.id;
}

/**
 * Record "cause causes effect", e.g. a deploy causes an incident. Jira's create call reads the other way
 * round from its field names: the inwardIssue is the one doing the outward verb ("causes"). Verified
 * live: the reverse shape made INC-1 read "causes DEP-1".
 */
export async function linkCauses(linkType: string, causeKey: string, effectKey: string, as: Requester = api.asApp()): Promise<void> {
  await call(as, route`/rest/api/3/issueLink`, `Linking ${causeKey} to ${effectKey}`, {
    method: 'POST',
    body: { type: { name: linkType }, inwardIssue: { key: causeKey }, outwardIssue: { key: effectKey } },
  });
}

export async function setIssueProperty(issueKey: string, propertyKey: string, value: unknown, as: Requester = api.asApp()): Promise<void> {
  const res = await as.requestJira(route`/rest/api/3/issue/${issueKey}/properties/${propertyKey}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new JiraError(`Setting ${propertyKey} on ${issueKey}`, res.status, await res.text());
}

/** Plain text to an Atlassian Document Format document, one paragraph per line. */
export function adfParagraphs(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph', content: [] })),
  };
}
