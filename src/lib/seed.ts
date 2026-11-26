// "Set up demo data" (D-05, D-13). Builds the synthetic demo world on the site, one bounded step per
// call, so each call stays well inside the resolver time limit, runs as the admin who clicked, and
// shows progress. Every step is find-or-create and records what it made as soon as it made it, so a
// failed or timed-out run resumes without duplicates and "Remove demo data" knows exactly what to remove.

import api, { route } from '@forge/api';
import { Queue } from '@forge/events';
import { kvs } from '@forge/kvs';
import { generateWorld } from '../core/demo';
import { chooseWorkType, type WorkTypeOption } from '../core/intake/issue-type';
import { normalizeDisputeEvent } from '../core/intake/normalize';
import { CHARGES, CUSTOMERS, ORDERS, OUTCOMES, PRODUCTS, REFUNDS, storedImpact, IMPACTS, type TableCodec } from '../core/sources/codec';
import { withMessageHeader } from '../core/sources/ticket-text';
import type { DemoWorld } from '../core/sources/types';
import { validatorExtensionKey } from '../core/setup/workflow';
import { INCIDENT_PROPERTY, saveSources, TICKET_PROPERTY, type IncidentProperty, type TicketProperty } from './collect-input';
import { getConfig } from './config';
import { createPage, ensureSpace, findPage, POLICY_PROPERTY, setPageProperty, updatePage, type PolicyPageProperty } from './confluence';
import { DEMO_LABEL } from './demo-label';
import { ensureProjectRoles, findProject, JiraError, type ProjectSummary } from './jira';
import {
  addComment,
  adfParagraphs,
  createIssuesBulk,
  ensureCausesLinkType,
  ensureDisputeWorkflow,
  ensureServiceProject,
  ensureSoftwareProject,
  ensureWorkType,
  ensureWorkTypesInProject,
  linkCauses,
  publishTaskStatus,
  setIssueProperty,
  startDisputeWorkflowMapping,
  type BulkResult,
} from './jira-setup';
import { runMigrations } from './sql';
import { deleteImpactsFor, insertRows, setRefundTicket } from './store';
import { INTAKE_QUEUE } from '../intake/webtrigger';

export { DEMO_LABEL } from './demo-label';
export const DEMO_PROJECTS = { tickets: 'SUP', incidents: 'INC', deploys: 'DEP' } as const;
export const DEMO_SPACE = { key: 'EXHPOL', name: 'Merchant policies (Exhibita demo)' } as const;
const STATE_KEY = 'demo:seed:v1';
/** A step that runs longer than this is assumed dead, so another call may take the lock. */
const LEASE_MS = 60_000;

export interface SeedState {
  seed: number;
  now: string;
  /** The disputes project, fixed when setup starts so later config changes cannot split the demo. */
  disputesKey: string;
  stepIndex: number;
  cursor: number;
  /** World refs and setup items → Jira keys, page ids, work type ids and progress markers. */
  refs: Record<string, string>;
  createdProjects: string[];
  /**
   * The keys setup chose for the demo projects. A removed demo's projects sit in the Jira trash and keep
   * their keys and names, so setting up again picks the next free ones (SUP2 and so on).
   */
  projectKeys: { tickets: string; incidents: string; deploys: string };
  /** A project being created right now; if the call dies, resume treats it as created by setup. */
  pendingCreate: string | null;
  createdSpace: string | null;
  notes: string[];
  status: 'running' | 'done' | 'failed';
  error: string | null;
  /** Lease against two tabs running steps at once. */
  lockedUntil: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SeedContext {
  accountId: string;
  /** The calling module's extension ARI; the validator's is derived from it. */
  localId: string;
}

interface StepResult {
  /** True when the step has finished; false to run it again with the updated cursor. */
  done: boolean;
  message: string;
}

/** Saves the state now, so whatever was just created survives a timeout later in the same call. */
type Checkpoint = () => Promise<void>;

interface Step {
  label: string;
  run(world: DemoWorld, state: SeedState, ctx: SeedContext, checkpoint: Checkpoint): Promise<StepResult>;
}

const asUser = () => api.asUser();

/** Record every created work item from a bulk result, then report any that Jira refused. */
async function recordBulk(result: BulkResult, refs: readonly string[], state: SeedState, checkpoint: Checkpoint): Promise<void> {
  result.created.forEach((made, i) => {
    if (made) state.refs[refs[i]!] = made.key;
  });
  await checkpoint();
  if (result.errors.length > 0) throw new Error(`Jira refused ${result.errors.length} work items: ${result.errors[0]}`);
}

// --------------------------------------------------------------------------------------------------
// Steps
// --------------------------------------------------------------------------------------------------

/** Payment tables in insert order. Refunds start without a ticket; a later step fills it in. */
function paymentBatches(world: DemoWorld): { codec: TableCodec<never>; rows: unknown[] }[] {
  const list: [TableCodec<never>, unknown[]][] = [
    [CUSTOMERS as TableCodec<never>, world.customers],
    [PRODUCTS as TableCodec<never>, world.products],
    [ORDERS as TableCodec<never>, world.orders],
    [CHARGES as TableCodec<never>, world.charges],
    [REFUNDS as TableCodec<never>, world.refunds.map((r) => ({ ...r, ticketKey: null }))],
    [OUTCOMES as TableCodec<never>, world.outcomes],
  ];
  return list.map(([codec, rows]) => ({ codec, rows }));
}

const ROWS_PER_CALL = 800;

const storage: Step = {
  label: 'Preparing storage',
  async run() {
    const applied = await runMigrations();
    return { done: true, message: `${applied.length} migrations in place` };
  },
};

const payments: Step = {
  label: 'Writing customers, orders and payments',
  async run(world, state) {
    const batches = paymentBatches(world);
    const total = batches.reduce((n, b) => n + b.rows.length, 0);
    let skip = state.cursor;
    let budget = ROWS_PER_CALL;
    for (const { codec, rows } of batches) {
      if (skip >= rows.length) {
        skip -= rows.length;
        continue;
      }
      const slice = rows.slice(skip, skip + budget);
      // INSERT IGNORE: rows written by a call that died before saving its cursor are skipped, not doubled.
      await insertRows(codec, slice as never[]);
      state.cursor += slice.length;
      budget -= slice.length;
      skip = 0;
      if (budget <= 0) break;
    }
    return { done: state.cursor >= total, message: `${Math.min(state.cursor, total)} of ${total} rows written` };
  },
};

type ProjectRole = 'disputes' | keyof SeedState['projectKeys'];

const PROJECTS: readonly { role: ProjectRole; kind: 'service' | 'software'; name: string; description: string }[] = [
  { role: 'disputes', kind: 'service', name: 'Disputes', description: 'Card disputes, one work item per chargeback. Set up by Exhibita.' },
  { role: 'tickets', kind: 'service', name: 'Customer support', description: 'Demo support tickets from customers. Set up by Exhibita.' },
  { role: 'incidents', kind: 'software', name: 'Incidents', description: 'Demo production incidents. Set up by Exhibita.' },
  { role: 'deploys', kind: 'software', name: 'Deploys', description: 'Demo deploys and changes. Set up by Exhibita.' },
];

const keyOfRole = (state: SeedState, role: ProjectRole) => (role === 'disputes' ? state.disputesKey : state.projectKeys[role]);

/** Jira refuses a key or name that any project holds, including one in the trash. */
const keyOrNameTaken = (e: unknown) => e instanceof JiraError && e.status === 400 && /projectKey|projectName/.test(e.body);

const projects: Step = {
  label: 'Creating projects',
  async run(_world, state, ctx, checkpoint) {
    const p = PROJECTS[state.cursor];
    if (!p) return { done: true, message: 'All projects ready' };
    const key = keyOfRole(state, p.role);
    const existing = await findProject(key, asUser());
    const ours = state.createdProjects.includes(key) || state.pendingCreate === key;
    let project = existing;
    if (existing && !ours && p.role !== 'disputes') {
      // Someone's real project, or one we cannot see: never write demo data into it (review C). Try the
      // next key instead.
      if (!bumpKey(state, p.role)) throw new Error(`Keys ${key} and its alternatives are taken by projects Exhibita did not make.`);
      await checkpoint();
      return { done: false, message: `${key} is taken; trying ${keyOfRole(state, p.role)}` };
    }
    if (!project) {
      state.pendingCreate = key;
      await checkpoint();
      const ensure = p.kind === 'service' ? ensureServiceProject : ensureSoftwareProject;
      const attempt = keyOfRole(state, p.role) === PROJECT_BASE[p.role as keyof typeof PROJECT_BASE] || p.role === 'disputes' ? '' : ` ${keyOfRole(state, p.role).slice(-1)}`;
      try {
        project = (await ensure(key, `${p.name}${attempt}`, p.description, asUser())).project;
      } catch (e) {
        // A trashed project still holds its key and name; move on to the next free key.
        if (p.role === 'disputes' || !keyOrNameTaken(e)) throw e;
        state.pendingCreate = null;
        if (!bumpKey(state, p.role)) throw e;
        await checkpoint();
        return { done: false, message: `${key} is still held by a project in the trash; trying ${keyOfRole(state, p.role)}` };
      }
    }
    if (state.pendingCreate === key) {
      if (!state.createdProjects.includes(key)) state.createdProjects.push(key);
      state.pendingCreate = null;
      await checkpoint();
    }
    if (p.kind === 'service') await ensureProjectRoles(project.key, ctx.accountId);
    state.refs[`project:${project.key}`] = project.id;
    state.cursor += 1;
    const made = state.createdProjects.includes(project.key);
    return { done: state.cursor >= PROJECTS.length, message: `${made ? 'Created' : 'Using existing'} ${project.name} (${project.key})` };
  },
};

const PROJECT_BASE = { tickets: DEMO_PROJECTS.tickets, incidents: DEMO_PROJECTS.incidents, deploys: DEMO_PROJECTS.deploys } as const;

/** Move a demo project to its next candidate key (SUP, SUP2 ... SUP9). False when none are left. */
function bumpKey(state: SeedState, role: ProjectRole): boolean {
  if (role === 'disputes') return false;
  const base = PROJECT_BASE[role];
  const current = state.projectKeys[role];
  const n = current === base ? 1 : Number(current.slice(base.length));
  if (n >= 9) return false;
  state.projectKeys[role] = `${base}${n + 1}`;
  return true;
}

async function projectOf(key: string): Promise<ProjectSummary> {
  const project = await findProject(key, asUser());
  if (!project) throw new Error(`Project ${key} is missing; resume setup`);
  return project;
}

const workTypes: Step = {
  label: 'Setting up work types',
  async run(_world, state, _ctx, checkpoint) {
    const plan = [
      { name: 'Dispute', description: 'A card chargeback, one per processor dispute. Created by Exhibita.', project: state.disputesKey },
      { name: 'Incident', description: 'A production incident.', project: state.projectKeys.incidents },
      { name: 'Deploy', description: 'A deploy or production change.', project: state.projectKeys.deploys },
    ];
    for (const t of plan) {
      const id = await ensureWorkType(t.name, t.description, asUser());
      state.refs[`type:${t.name}`] = id;
      await checkpoint();
      await ensureWorkTypesInProject(await projectOf(t.project), [id], asUser());
    }
    return { done: true, message: 'Dispute, Incident and Deploy work types ready' };
  },
};

const workflow: Step = {
  label: 'Setting up the dispute workflow and the submit check',
  async run(_world, state, ctx, checkpoint) {
    // A publish started by an earlier call: poll it instead of starting another (review C).
    const task = state.refs['task:publish'];
    if (task) {
      const status = await publishTaskStatus(task, asUser());
      if (status === 'running') return { done: false, message: 'Jira is still publishing the workflow scheme' };
      delete state.refs['task:publish'];
      return { done: true, message: 'Dispute work items now use the dispute workflow' };
    }
    const validatorKey = validatorExtensionKey(ctx.localId, 'exhibita-submit-validator');
    const result = await ensureDisputeWorkflow(validatorKey, asUser());
    if (result.validator === 'missing') {
      state.notes.push('The dispute workflow exists without the Exhibita submit check. Add "Exhibita evidence complete" to the Submit to network transition in the workflow editor.');
    }
    const typeId = state.refs['type:Dispute'];
    if (!typeId) throw new Error('The Dispute work type is missing; resume setup');
    const mapping = await startDisputeWorkflowMapping(await projectOf(state.disputesKey), typeId, asUser());
    if (mapping === 'already') return { done: true, message: `Workflow ${result.created ? 'created' : 'found'} and already used by Dispute; submit check ${result.validator}` };
    state.refs['task:publish'] = mapping.taskId;
    await checkpoint();
    return { done: false, message: `Workflow ${result.created ? 'created' : 'found'}; publishing it for the Dispute work type` };
  },
};

const policies: Step = {
  label: 'Writing policies in Confluence',
  async run(world, state, _ctx, checkpoint) {
    const { space, created } = await ensureSpace(DEMO_SPACE.key, DEMO_SPACE.name, 'Refund, shipping and cancellation policies for the Exhibita demo. Synthetic.', asUser());
    if (created) {
      state.createdSpace = space.key;
      await checkpoint();
    }
    const policy = world.policies[state.cursor];
    if (!policy) return { done: true, message: 'Policies written' };
    const first = policy.versions[0];
    if (!first) throw new Error(`Policy ${policy.title} has no versions`);
    let page = (await findPage(space.id, policy.title, asUser())) ?? (await createPage(space.id, policy.title, first.body, asUser()));
    state.refs[policy.ref] = page.id;
    await checkpoint();
    // Page version n holds policy version n. Pages can't be backdated, so dates live in the property.
    for (let i = page.version.number; i < policy.versions.length; i++) {
      const v = policy.versions[i]!;
      page = await updatePage(page, v.body, `Policy ${v.version}, in force from ${v.effectiveFrom.slice(0, 10)}`, asUser());
    }
    const prop: PolicyPageProperty = {
      kind: policy.kind,
      versions: policy.versions.map((v, i) => ({ version: v.version, pageVersion: i + 1, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo })),
    };
    await setPageProperty(page.id, POLICY_PROPERTY, prop, asUser());
    state.cursor += 1;
    return { done: state.cursor >= world.policies.length, message: `${policy.title}: ${policy.versions.length} version(s)` };
  },
};

const text = (s: string) => adfParagraphs(s);

const operations: Step = {
  label: 'Recording deploys and incidents',
  async run(world, state, _ctx, checkpoint) {
    const linkType = await ensureCausesLinkType(asUser());
    const deployType = state.refs['type:Deploy'];
    const incidentType = state.refs['type:Incident'];
    if (!deployType || !incidentType) throw new Error('Work types are missing; resume setup');

    const newDeploys = world.deploys.filter((d) => !state.refs[d.ref]);
    if (newDeploys.length > 0) {
      const result = await createIssuesBulk(newDeploys.map((d) => ({
        fields: { project: { key: state.projectKeys.deploys }, issuetype: { id: deployType }, summary: d.title, description: text(`${d.description}\nDeployed at ${d.at}.`), labels: [DEMO_LABEL] },
      })));
      await recordBulk(result, newDeploys.map((d) => d.ref), state, checkpoint);
    }
    const newIncidents = world.incidents.filter((i) => !state.refs[i.ref]);
    if (newIncidents.length > 0) {
      const result = await createIssuesBulk(newIncidents.map((i) => ({
        fields: { project: { key: state.projectKeys.incidents }, issuetype: { id: incidentType }, summary: i.title, description: text(i.description), labels: [DEMO_LABEL] },
      })));
      await recordBulk(result, newIncidents.map((i) => i.ref), state, checkpoint);
    }
    for (const incident of world.incidents) {
      if (state.refs[`${incident.ref}:done`]) continue;
      const key = state.refs[incident.ref]!;
      const prop: IncidentProperty = { effect: incident.effect, windowStart: incident.windowStart, windowEnd: incident.windowEnd };
      await setIssueProperty(key, INCIDENT_PROPERTY, prop);
      const deployKey = incident.causedByDeployRef ? state.refs[incident.causedByDeployRef] : null;
      if (deployKey) await linkCauses(linkType, deployKey, key);
      state.refs[`${incident.ref}:done`] = '1';
      await checkpoint();
    }
    return { done: true, message: `${world.deploys.length} deploys and ${world.incidents.length} incidents recorded` };
  },
};

const TICKETS_PER_CALL = 6;

async function ticketWorkType(projectKey: string): Promise<WorkTypeOption> {
  const project = await projectOf(projectKey);
  const res = await api.asApp().requestJira(route`/rest/api/3/issuetype/project?projectId=${project.id}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new JiraError(`Reading work types of ${projectKey}`, res.status, await res.text());
  const types = (await res.json()) as WorkTypeOption[];
  const chosen = types.find((t) => t.name === 'Emailed request') ?? chooseWorkType(types);
  if (!chosen) throw new Error(`Project ${projectKey} has no usable work type for tickets`);
  return chosen;
}

const tickets: Step = {
  label: 'Writing support tickets',
  async run(world, state, _ctx, checkpoint) {
    const linkType = await ensureCausesLinkType(asUser());
    const chunk = world.tickets.slice(state.cursor, state.cursor + TICKETS_PER_CALL);
    if (chunk.length === 0) return { done: true, message: 'Tickets written' };
    const type = await ticketWorkType(state.projectKeys.tickets);
    const missing = chunk.filter((t) => !state.refs[t.ref]);
    if (missing.length > 0) {
      const result = await createIssuesBulk(missing.map((t) => ({
        fields: {
          project: { key: state.projectKeys.tickets },
          issuetype: { id: type.id },
          summary: t.summary,
          description: text(t.messages[0]?.text ?? ''),
          labels: [DEMO_LABEL],
        },
      })));
      await recordBulk(result, missing.map((t) => t.ref), state, checkpoint);
    }
    for (const t of chunk) {
      if (state.refs[`${t.ref}:done`]) continue;
      const key = state.refs[t.ref]!;
      const meta: TicketProperty['messages'] = [];
      for (const [i, m] of t.messages.entries()) {
        // Each comment is recorded the moment it exists, so a resumed run never posts it twice.
        const marker = `${t.ref}:m${i}`;
        let commentId: string | null = null;
        if (i > 0) {
          commentId = state.refs[marker] ?? (await addComment(key, withMessageHeader(m)));
          state.refs[marker] = commentId;
          await checkpoint();
        }
        meta.push({ commentId, author: m.author, at: m.at });
      }
      const prop: TicketProperty = { customerId: t.customerId, orderId: t.orderId, refundId: t.refundId, messages: meta };
      await setIssueProperty(key, TICKET_PROPERTY, prop);
      const incidentKey = t.linkedIncidentRef ? state.refs[t.linkedIncidentRef] : null;
      if (incidentKey) await linkCauses(linkType, incidentKey, key);
      state.refs[`${t.ref}:done`] = '1';
      await checkpoint();
    }
    state.cursor += chunk.length;
    return { done: state.cursor >= world.tickets.length, message: `${Math.min(state.cursor, world.tickets.length)} of ${world.tickets.length} tickets` };
  },
};

const impacts: Step = {
  label: 'Linking incidents to the refunds and charges they affected',
  async run(world, state) {
    const keyOf = (ref: string) => {
      const key = state.refs[ref];
      if (!key) throw new Error(`No Jira key for ${ref}`);
      return key;
    };
    // Rows with a NULL column slip past the unique key, so clear this world's rows before writing them.
    await deleteImpactsFor(
      world.impacts.flatMap((i) => (i.refundId ? [i.refundId] : [])),
      world.impacts.flatMap((i) => (i.chargeId ? [i.chargeId] : [])),
    );
    await insertRows(IMPACTS, world.impacts.map((i) => storedImpact(i, keyOf)));
    // A refund's ticket is the first ticket about it, as the reference observer reads it.
    const firstTicket = new Map<string, string>();
    for (const t of world.tickets) if (t.refundId && !firstTicket.has(t.refundId)) firstTicket.set(t.refundId, t.ref);
    for (const [refundId, ref] of firstTicket) await setRefundTicket(refundId, keyOf(ref));
    return { done: true, message: `${world.impacts.length} impact records` };
  },
};

const sources: Step = {
  label: 'Recording where evidence lives',
  async run(world, state) {
    await saveSources({
      ticketProjectKey: state.projectKeys.tickets,
      incidentProjectKey: state.projectKeys.incidents,
      deployProjectKey: state.projectKeys.deploys,
      policyPageIds: world.policies.map((p) => state.refs[p.ref]).filter((id): id is string => !!id),
    });
    return { done: true, message: 'Evidence sources saved' };
  },
};

const DISPUTES_PER_CALL = 50;

const disputes: Step = {
  label: 'Sending disputes through the webhook queue',
  async run(world, state) {
    const chunk = world.disputes.slice(state.cursor, state.cursor + DISPUTES_PER_CALL);
    const events = chunk.flatMap((d) => {
      const n = normalizeDisputeEvent(d.payload);
      return n.ok ? [{ body: { dispute: n.dispute, raw: d.payload, demo: true } }] : [];
    });
    // If this call dies after pushing, the resumed push repeats these events; intake's atomic claim
    // (review A4) makes the repeats harmless.
    if (events.length > 0) await new Queue({ key: INTAKE_QUEUE }).push(events);
    state.cursor += chunk.length;
    return { done: state.cursor >= world.disputes.length, message: `${Math.min(state.cursor, world.disputes.length)} of ${world.disputes.length} disputes queued` };
  },
};

export const STEPS: readonly Step[] = [storage, payments, projects, workTypes, workflow, policies, operations, tickets, impacts, sources, disputes];

// --------------------------------------------------------------------------------------------------
// Running
// --------------------------------------------------------------------------------------------------

export interface SeedProgress {
  status: SeedState['status'] | 'idle';
  step: number;
  steps: string[];
  label: string;
  message: string;
  notes: string[];
  error: string | null;
}

const progress = (state: SeedState | null, message = ''): SeedProgress => ({
  status: state?.status ?? 'idle',
  step: state?.stepIndex ?? 0,
  steps: STEPS.map((s) => s.label),
  label: state ? (STEPS[state.stepIndex]?.label ?? 'Done') : '',
  message,
  notes: state?.notes ?? [],
  error: state?.error ?? null,
});

export async function getSeedState(): Promise<SeedState | null> {
  return (await kvs.get<SeedState>(STATE_KEY)) ?? null;
}

export async function seedProgress(): Promise<SeedProgress> {
  return progress(await getSeedState());
}

/** Start a run, or resume one that failed part way. A finished run is left alone. */
export async function startSeed(seed = 20261126): Promise<SeedProgress> {
  const existing = await getSeedState();
  if (existing?.status === 'running' || existing?.status === 'done') return progress(existing, 'Already set up or in progress');
  const disputesKey = (await getConfig()).projectKey;
  if ((Object.values(DEMO_PROJECTS) as string[]).includes(disputesKey)) {
    throw new Error(`The disputes project key ${disputesKey} is also used for demo tickets, incidents or deploys. Choose another key first.`);
  }
  const state: SeedState = existing
    ? { ...existing, projectKeys: existing.projectKeys ?? { ...DEMO_PROJECTS }, status: 'running', error: null, lockedUntil: null }
    : {
        seed,
        now: new Date().toISOString(),
        disputesKey,
        stepIndex: 0,
        cursor: 0,
        refs: {},
        createdProjects: [],
        projectKeys: { ...DEMO_PROJECTS },
        pendingCreate: null,
        createdSpace: null,
        notes: [],
        status: 'running',
        error: null,
        lockedUntil: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
  await kvs.set(STATE_KEY, state);
  return progress(state, 'Starting');
}

/** Run one bounded piece of the current step and save where it got to. */
export async function runSeedStep(ctx: SeedContext): Promise<SeedProgress> {
  const state = await getSeedState();
  if (!state || state.status !== 'running') return progress(state, state?.status === 'done' ? 'Done' : 'Not running');
  if (state.lockedUntil && state.lockedUntil > Date.now()) return progress(state, 'Setup is already running in another tab');
  state.lockedUntil = Date.now() + LEASE_MS;
  await kvs.set(STATE_KEY, state);
  const checkpoint: Checkpoint = () => kvs.set(STATE_KEY, state);

  const step = STEPS[state.stepIndex];
  if (!step) {
    state.status = 'done';
    state.finishedAt = new Date().toISOString();
    state.lockedUntil = null;
    await kvs.set(STATE_KEY, state);
    return progress(state, 'Done');
  }
  const world = generateWorld({ seed: state.seed, now: state.now });
  try {
    const result = await step.run(world, state, ctx, checkpoint);
    if (result.done) {
      state.stepIndex += 1;
      state.cursor = 0;
      if (state.stepIndex >= STEPS.length) {
        state.status = 'done';
        state.finishedAt = new Date().toISOString();
      }
    }
    state.lockedUntil = null;
    await kvs.set(STATE_KEY, state);
    return progress(state, result.message);
  } catch (error) {
    // Keep everything recorded so far; starting again resumes this step.
    state.status = 'failed';
    const message = error instanceof Error ? error.message : String(error);
    state.error = /tenant is restricted/i.test(message)
      ? `${step.label}: Atlassian is doing maintenance on this site and refused a change for now. Everything so far is kept; resume in a few minutes.`
      : `${step.label}: ${message}`;
    state.lockedUntil = null;
    await kvs.set(STATE_KEY, state);
    console.error('Demo setup step failed', error instanceof JiraError ? error.message : error);
    return progress(state, 'Failed');
  }
}

/** Forget the run record (after removal). */
export async function clearSeedState(): Promise<void> {
  await kvs.delete(STATE_KEY);
}
