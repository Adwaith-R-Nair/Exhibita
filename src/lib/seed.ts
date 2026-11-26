// "Set up demo data" (D-05). Builds the synthetic demo world on the site, one bounded step per call, so
// each call stays well inside the resolver time limit, runs as the admin who clicked, and shows
// progress. Every step is find-or-create and records what it made, so a failed run can be resumed
// and "Remove demo data" knows exactly what to remove.

import api, { route } from '@forge/api';
import { Queue } from '@forge/events';
import { kvs } from '@forge/kvs';
import { generateWorld } from '../core/demo';
import { chooseWorkType, type WorkTypeOption } from '../core/intake/issue-type';
import { normalizeDisputeEvent } from '../core/intake/normalize';
import { CHARGES, CUSTOMERS, ORDERS, OUTCOMES, PRODUCTS, REFUNDS, storedImpact, IMPACTS, type TableCodec } from '../core/sources/codec';
import type { DemoWorld } from '../core/sources/types';
import { validatorExtensionKey } from '../core/setup/workflow';
import { withMessageHeader } from '../core/sources/ticket-text';
import { INCIDENT_PROPERTY, saveSources, TICKET_PROPERTY, type IncidentProperty, type TicketProperty } from './collect-input';
import { getConfig } from './config';
import { createPage, ensureSpace, findPage, POLICY_PROPERTY, setPageProperty, updatePage, type PolicyPageProperty } from './confluence';
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
  mapWorkTypeToDisputeWorkflow,
  setIssueProperty,
} from './jira-setup';
import { runMigrations } from './sql';
import { insertRows, setRefundTicket } from './store';
import { INTAKE_QUEUE } from '../intake/webtrigger';

export { DEMO_LABEL } from './demo-label';
import { DEMO_LABEL } from './demo-label';
export const DEMO_PROJECTS = { tickets: 'SUP', incidents: 'INC', deploys: 'DEP' } as const;
export const DEMO_SPACE = { key: 'EXHPOL', name: 'Merchant policies (Exhibita demo)' } as const;
const STATE_KEY = 'demo:seed:v1';

export interface SeedState {
  seed: number;
  now: string;
  stepIndex: number;
  cursor: number;
  /** World refs and setup items → Jira keys, page ids and work type ids. */
  refs: Record<string, string>;
  createdProjects: string[];
  createdSpace: string | null;
  notes: string[];
  status: 'running' | 'done' | 'failed';
  error: string | null;
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

interface Step {
  label: string;
  run(world: DemoWorld, state: SeedState, ctx: SeedContext): Promise<StepResult>;
}

const asUser = () => api.asUser();

// --------------------------------------------------------------------------------------------------
// Steps
// --------------------------------------------------------------------------------------------------

/** Payment tables in insert order. Refunds start without a ticket; the ticket step fills it in. */
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
      await insertRows(codec, slice as never[]);
      state.cursor += slice.length;
      budget -= slice.length;
      skip = 0;
      if (budget <= 0) break;
    }
    return { done: state.cursor >= total, message: `${Math.min(state.cursor, total)} of ${total} rows written` };
  },
};

const PROJECTS = (disputesKey: string) =>
  [
    { key: disputesKey, kind: 'service', name: 'Disputes', description: 'Card disputes, one work item per chargeback. Set up by Exhibita.' },
    { key: DEMO_PROJECTS.tickets, kind: 'service', name: 'Customer support', description: 'Demo support tickets from customers. Set up by Exhibita.' },
    { key: DEMO_PROJECTS.incidents, kind: 'software', name: 'Incidents', description: 'Demo production incidents. Set up by Exhibita.' },
    { key: DEMO_PROJECTS.deploys, kind: 'software', name: 'Deploys', description: 'Demo deploys and changes. Set up by Exhibita.' },
  ] as const;

const projects: Step = {
  label: 'Creating projects',
  async run(_world, state, ctx) {
    const list = PROJECTS((await getConfig()).projectKey);
    const p = list[state.cursor];
    if (!p) return { done: true, message: 'All projects ready' };
    const ensure = p.kind === 'service' ? ensureServiceProject : ensureSoftwareProject;
    const { project, created } = await ensure(p.key, p.name, p.description, asUser());
    if (created) state.createdProjects.push(project.key);
    if (p.kind === 'service') await ensureProjectRoles(project.key, ctx.accountId);
    state.refs[`project:${p.key}`] = project.id;
    state.cursor += 1;
    return { done: state.cursor >= list.length, message: `${created ? 'Created' : 'Found'} ${project.name} (${project.key})` };
  },
};

async function projectOf(key: string): Promise<ProjectSummary> {
  const project = await findProject(key, asUser());
  if (!project) throw new Error(`Project ${key} is missing; run setup again`);
  return project;
}

const workTypes: Step = {
  label: 'Setting up work types',
  async run(_world, state) {
    const disputesKey = (await getConfig()).projectKey;
    const plan = [
      { name: 'Dispute', description: 'A card chargeback, one per processor dispute. Created by Exhibita.', project: disputesKey },
      { name: 'Incident', description: 'A production incident.', project: DEMO_PROJECTS.incidents },
      { name: 'Deploy', description: 'A deploy or production change.', project: DEMO_PROJECTS.deploys },
    ];
    for (const t of plan) {
      const id = await ensureWorkType(t.name, t.description, asUser());
      state.refs[`type:${t.name}`] = id;
      await ensureWorkTypesInProject(await projectOf(t.project), [id], asUser());
    }
    return { done: true, message: 'Dispute, Incident and Deploy work types ready' };
  },
};

const workflow: Step = {
  label: 'Setting up the dispute workflow and the submit check',
  async run(_world, state, ctx) {
    const validatorKey = validatorExtensionKey(ctx.localId, 'exhibita-submit-validator');
    const result = await ensureDisputeWorkflow(validatorKey, asUser());
    const disputes = await projectOf((await getConfig()).projectKey);
    const typeId = state.refs['type:Dispute'];
    if (!typeId) throw new Error('The Dispute work type is missing; run setup again');
    const mapped = await mapWorkTypeToDisputeWorkflow(disputes, typeId, asUser());
    if (result.validator === 'missing') {
      state.notes.push('The dispute workflow exists without the Exhibita submit check. Add "Exhibita evidence complete" to the Submit to network transition in the workflow editor.');
    }
    return { done: true, message: `Workflow ${result.created ? 'created' : 'found'}, ${mapped === 'mapped' ? 'now used' : 'already used'} by Dispute; submit check ${result.validator}` };
  },
};

const policies: Step = {
  label: 'Writing policies in Confluence',
  async run(world, state) {
    const { space, created } = await ensureSpace(DEMO_SPACE.key, DEMO_SPACE.name, 'Refund, shipping and cancellation policies for the Exhibita demo. Synthetic.', asUser());
    if (created) state.createdSpace = space.key;
    const policy = world.policies[state.cursor];
    if (!policy) return { done: true, message: 'Policies written' };
    const first = policy.versions[0];
    if (!first) throw new Error(`Policy ${policy.title} has no versions`);
    let page = (await findPage(space.id, policy.title, asUser())) ?? (await createPage(space.id, policy.title, first.body, asUser()));
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
    state.refs[policy.ref] = page.id;
    state.cursor += 1;
    return { done: state.cursor >= world.policies.length, message: `${policy.title}: ${policy.versions.length} version(s)` };
  },
};

const text = (s: string) => adfParagraphs(s);

const operations: Step = {
  label: 'Recording deploys and incidents',
  async run(world, state) {
    const linkType = await ensureCausesLinkType(asUser());
    const deployType = state.refs['type:Deploy'];
    const incidentType = state.refs['type:Incident'];
    if (!deployType || !incidentType) throw new Error('Work types are missing; run setup again');

    const newDeploys = world.deploys.filter((d) => !state.refs[d.ref]);
    if (newDeploys.length > 0) {
      const made = await createIssuesBulk(newDeploys.map((d) => ({
        fields: { project: { key: DEMO_PROJECTS.deploys }, issuetype: { id: deployType }, summary: d.title, description: text(`${d.description}\nDeployed at ${d.at}.`), labels: [DEMO_LABEL] },
      })));
      made.forEach((m, i) => (state.refs[newDeploys[i]!.ref] = m.key));
    }
    const newIncidents = world.incidents.filter((i) => !state.refs[i.ref]);
    if (newIncidents.length > 0) {
      const made = await createIssuesBulk(newIncidents.map((i) => ({
        fields: { project: { key: DEMO_PROJECTS.incidents }, issuetype: { id: incidentType }, summary: i.title, description: text(i.description), labels: [DEMO_LABEL] },
      })));
      made.forEach((m, i) => (state.refs[newIncidents[i]!.ref] = m.key));
    }
    for (const incident of world.incidents) {
      const key = state.refs[incident.ref]!;
      if (state.refs[`${incident.ref}:done`]) continue;
      const prop: IncidentProperty = { effect: incident.effect, windowStart: incident.windowStart, windowEnd: incident.windowEnd };
      await setIssueProperty(key, INCIDENT_PROPERTY, prop);
      const deployKey = incident.causedByDeployRef ? state.refs[incident.causedByDeployRef] : null;
      if (deployKey) await linkCauses(linkType, deployKey, key);
      state.refs[`${incident.ref}:done`] = '1';
    }
    return { done: true, message: `${world.deploys.length} deploys and ${world.incidents.length} incidents recorded` };
  },
};

const TICKETS_PER_CALL = 6;

async function ticketWorkType(projectKey: string): Promise<WorkTypeOption> {
  const project = await projectOf(projectKey);
  const res = await api.asApp().requestJira(route`/rest/api/3/issuetype/project?projectId=${project.id}`, { headers: { Accept: 'application/json' } });
  const types = (await res.json()) as WorkTypeOption[];
  const chosen = types.find((t) => t.name === 'Emailed request') ?? chooseWorkType(types);
  if (!chosen) throw new Error(`Project ${projectKey} has no usable work type for tickets`);
  return chosen;
}

const tickets: Step = {
  label: 'Writing support tickets',
  async run(world, state) {
    const linkType = await ensureCausesLinkType(asUser());
    const chunk = world.tickets.slice(state.cursor, state.cursor + TICKETS_PER_CALL);
    if (chunk.length === 0) return { done: true, message: 'Tickets written' };
    const type = await ticketWorkType(DEMO_PROJECTS.tickets);
    const missing = chunk.filter((t) => !state.refs[t.ref]);
    if (missing.length > 0) {
      const made = await createIssuesBulk(missing.map((t) => ({
        fields: {
          project: { key: DEMO_PROJECTS.tickets },
          issuetype: { id: type.id },
          summary: t.summary,
          description: text(t.messages[0]?.text ?? ''),
          labels: [DEMO_LABEL],
        },
      })));
      made.forEach((m, i) => (state.refs[missing[i]!.ref] = m.key));
    }
    for (const t of chunk) {
      if (state.refs[`${t.ref}:done`]) continue;
      const key = state.refs[t.ref]!;
      const meta: TicketProperty['messages'] = [];
      for (const [i, m] of t.messages.entries()) {
        const commentId = i === 0 ? null : await addComment(key, withMessageHeader(m));
        meta.push({ commentId, author: m.author, at: m.at });
      }
      const prop: TicketProperty = { customerId: t.customerId, orderId: t.orderId, refundId: t.refundId, messages: meta };
      await setIssueProperty(key, TICKET_PROPERTY, prop);
      const incidentKey = t.linkedIncidentRef ? state.refs[t.linkedIncidentRef] : null;
      if (incidentKey) await linkCauses(linkType, incidentKey, key);
      state.refs[`${t.ref}:done`] = '1';
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
      ticketProjectKey: DEMO_PROJECTS.tickets,
      incidentProjectKey: DEMO_PROJECTS.incidents,
      deployProjectKey: DEMO_PROJECTS.deploys,
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
  const state: SeedState = existing
    ? { ...existing, status: 'running', error: null }
    : { seed, now: new Date().toISOString(), stepIndex: 0, cursor: 0, refs: {}, createdProjects: [], createdSpace: null, notes: [], status: 'running', error: null, startedAt: new Date().toISOString(), finishedAt: null };
  await kvs.set(STATE_KEY, state);
  return progress(state, 'Starting');
}

/** Run one bounded piece of the current step and save where it got to. */
export async function runSeedStep(ctx: SeedContext): Promise<SeedProgress> {
  const state = await getSeedState();
  if (!state || state.status !== 'running') return progress(state, state?.status === 'done' ? 'Done' : 'Not running');
  const step = STEPS[state.stepIndex];
  if (!step) {
    state.status = 'done';
    state.finishedAt = new Date().toISOString();
    await kvs.set(STATE_KEY, state);
    return progress(state, 'Done');
  }
  const world = generateWorld({ seed: state.seed, now: state.now });
  try {
    const result = await step.run(world, state, ctx);
    if (result.done) {
      state.stepIndex += 1;
      state.cursor = 0;
      if (state.stepIndex >= STEPS.length) {
        state.status = 'done';
        state.finishedAt = new Date().toISOString();
      }
    }
    await kvs.set(STATE_KEY, state);
    return progress(state, result.message);
  } catch (error) {
    // Keep everything recorded so far; starting again resumes this step.
    state.status = 'failed';
    state.error = `${step.label}: ${error instanceof Error ? error.message : String(error)}`;
    await kvs.set(STATE_KEY, state);
    console.error('Demo setup step failed', error instanceof JiraError ? error.message : error);
    return progress(state, 'Failed');
  }
}

/** Forget the run record (after removal). */
export async function clearSeedState(): Promise<void> {
  await kvs.delete(STATE_KEY);
}
