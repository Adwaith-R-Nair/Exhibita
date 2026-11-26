// Reads a dispute's evidence sources from Forge SQL, Jira and Confluence into a CollectInput, which the
// pure collectors (src/core/collect) turn into evidence. Must produce exactly what the reference
// observer (src/core/demo/observe.ts) produces from the generated world.
//
// Causes come only from explicit records: impact rows in SQL and "Causes" links in Jira (invariant 7).

import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { adfToText } from '../core/sources/adf';
import { stripMessageHeader } from '../core/sources/ticket-text';
import type { CollectInput, IncidentEffect, ObservedIncident, ObservedRefund, ObservedTicket, TicketMessage } from '../core/sources/types';
import type { Dispute } from '../core/types';
import { readPolicyVersions } from './confluence';
import { JiraError } from './jira';
import { getCharge, getChargesFor, getImpacts, getOrder, getPriorOrders, getProduct, getRefundsFor } from './store';

/** Where a site's evidence lives. Written by the setup wizard; an admin could point it elsewhere. */
export interface SourcesConfig {
  ticketProjectKey: string | null;
  incidentProjectKey: string | null;
  deployProjectKey: string | null;
  policyPageIds: string[];
}

const SOURCES_KEY = 'sources:v1';
export const TICKET_PROPERTY = 'exhibita-ticket';
export const INCIDENT_PROPERTY = 'exhibita-incident';

export async function getSources(): Promise<SourcesConfig> {
  return (await kvs.get<SourcesConfig>(SOURCES_KEY)) ?? { ticketProjectKey: null, incidentProjectKey: null, deployProjectKey: null, policyPageIds: [] };
}

export async function saveSources(sources: SourcesConfig): Promise<void> {
  await kvs.set(SOURCES_KEY, sources);
}

export async function clearSources(): Promise<void> {
  await kvs.delete(SOURCES_KEY);
}

/** Stored on each support ticket: who it is from, and the author and original time of each message. */
export interface TicketProperty {
  customerId: string;
  orderId: string | null;
  refundId: string | null;
  /** First entry is the description (commentId null); the rest are comments, in order. */
  messages: { commentId: string | null; author: TicketMessage['author']; at: string }[];
}

export interface IncidentProperty {
  effect: IncidentEffect;
  windowStart: string;
  windowEnd: string | null;
}

let siteUrlCache: string | null = null;
async function siteUrl(): Promise<string | null> {
  if (siteUrlCache) return siteUrlCache;
  const res = await api.asApp().requestJira(route`/rest/api/3/serverInfo`, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  siteUrlCache = ((await res.json()) as { baseUrl?: string }).baseUrl ?? null;
  return siteUrlCache;
}

const browse = (base: string | null, key: string) => (base ? `${base}/browse/${key}` : undefined);
const quote = (v: string) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

interface SearchIssue {
  key: string;
  fields: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

async function search(jql: string, fields: string[], properties: string[] = [], max = 100): Promise<SearchIssue[]> {
  const res = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jql, fields, properties, maxResults: max }),
  });
  const text = await res.text();
  if (!res.ok) throw new JiraError(`Searching: ${jql}`, res.status, text);
  return (JSON.parse(text) as { issues: SearchIssue[] }).issues;
}

interface LinkField {
  type: { name: string; inward: string; outward: string };
  inwardIssue?: { key: string };
  outwardIssue?: { key: string };
}

/** Keys of issues joined to this one by a "causes" link, in either direction, filtered by project. */
function causalLinks(issue: SearchIssue, projectKey: string | null): string[] {
  const links = (issue.fields.issuelinks as LinkField[] | undefined) ?? [];
  return links
    .filter((l) => l.type.outward.toLowerCase() === 'causes')
    .map((l) => l.inwardIssue?.key ?? l.outwardIssue?.key)
    .filter((k): k is string => !!k && (!projectKey || k.startsWith(`${projectKey}-`)));
}

const byTimeThenKey = <T>(at: (x: T) => string, key: (x: T) => string) => (a: T, b: T) =>
  Date.parse(at(a)) - Date.parse(at(b)) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** The customer's tickets, plus the incident each refund is linked to through a ticket about it. */
async function readTickets(sources: SourcesConfig, customerId: string, base: string | null): Promise<{ tickets: ObservedTicket[]; incidentByRefund: Map<string, string> }> {
  const incidentByRefund = new Map<string, string>();
  if (!sources.ticketProjectKey) return { tickets: [], incidentByRefund };
  const issues = await search(
    `project = ${quote(sources.ticketProjectKey)} AND issue.property[${TICKET_PROPERTY}].customerId = ${quote(customerId)} ORDER BY created ASC`,
    ['description', 'comment', 'created', 'issuelinks'],
    [TICKET_PROPERTY],
  );
  const tickets = issues.map((issue): ObservedTicket => {
    const prop = issue.properties?.[TICKET_PROPERTY] as TicketProperty | undefined;
    const comments = ((issue.fields.comment as { comments?: { id: string; body: unknown }[] } | undefined)?.comments ?? []);
    const textOf = (commentId: string | null) =>
      commentId === null ? adfToText(issue.fields.description) : stripMessageHeader(adfToText(comments.find((c) => c.id === commentId)?.body));
    const messages: TicketMessage[] = (prop?.messages ?? []).map((m) => ({ author: m.author, at: m.at, text: textOf(m.commentId) }));
    const linked = causalLinks(issue, sources.incidentProjectKey)[0];
    if (prop?.refundId && linked && !incidentByRefund.has(prop.refundId)) incidentByRefund.set(prop.refundId, linked);
    const url = browse(base, issue.key);
    return { key: issue.key, ...(url ? { url } : {}), createdAt: prop?.messages[0]?.at ?? String(issue.fields.created), messages };
  });
  return { tickets: tickets.sort(byTimeThenKey((t) => t.createdAt, (t) => t.key)), incidentByRefund };
}

async function readIncidents(sources: SourcesConfig, base: string | null): Promise<(Omit<ObservedIncident, 'link'>)[]> {
  if (!sources.incidentProjectKey) return [];
  const issues = await search(`project = ${quote(sources.incidentProjectKey)} ORDER BY created ASC`, ['summary', 'issuelinks'], [INCIDENT_PROPERTY]);
  return issues.flatMap((issue) => {
    const prop = issue.properties?.[INCIDENT_PROPERTY] as IncidentProperty | undefined;
    if (!prop) return [];
    const url = browse(base, issue.key);
    return [{
      key: issue.key,
      ...(url ? { url } : {}),
      title: String(issue.fields.summary ?? issue.key),
      effect: prop.effect,
      windowStart: prop.windowStart,
      windowEnd: prop.windowEnd,
      linkedDeploy: causalLinks(issue, sources.deployProjectKey)[0] ?? null,
    }];
  });
}

/** Orders this customer has disputed, from the dispute records in the disputes project. */
async function disputedOrders(projectKey: string, customerId: string): Promise<Set<string>> {
  const issues = await search(`project = ${quote(projectKey)} AND issue.property[exhibita].dispute.customer = ${quote(customerId)}`, ['summary'], ['exhibita'], 100);
  return new Set(
    issues
      .map((i) => (i.properties?.exhibita as { dispute?: { orderId?: string | null } } | undefined)?.dispute?.orderId)
      .filter((o): o is string => !!o),
  );
}

const overlaps = (purchasedAt: string, start: string, end: string | null) => {
  const t = Date.parse(purchasedAt);
  return t >= Date.parse(start) && (end === null || t <= Date.parse(end));
};

export async function buildCollectInput(dispute: Dispute, disputesProjectKey: string): Promise<CollectInput> {
  const sources = await getSources();
  const base = await siteUrl();
  const order = dispute.orderId ? await getOrder(dispute.orderId) : null;
  const empty: CollectInput = { dispute, order: null, product: null, charges: [], refunds: [], priorOrders: [], tickets: [], incidents: [], policies: [] };
  const policies = (await Promise.all(sources.policyPageIds.map((id) => readPolicyVersions(id, base).catch(() => [])))).flat();
  if (!order) return { ...empty, policies };

  const customerId = order.customerId;
  const disputedCharge = dispute.chargeId ? await getCharge(dispute.chargeId) : null;
  const [product, charges, refundRows, ticketData, allIncidents, disputed] = await Promise.all([
    getProduct(order.sku),
    getChargesFor(order, dispute.amount, disputedCharge?.chargedAt ?? order.purchasedAt),
    getRefundsFor(order.id),
    readTickets(sources, customerId, base),
    readIncidents(sources, base),
    disputedOrders(disputesProjectKey, customerId),
  ]);
  // Only this order's refunds and charges count; a look-alike charge on another order is not this dispute.
  const orderCharges = charges.filter((c) => c.orderId === order.id).map((c) => c.id);
  const impacts = await getImpacts(refundRows.map((r) => r.id), orderCharges);
  const priorOrders = await getPriorOrders(order, disputed);
  const incidentByKey = new Map(allIncidents.map((i) => [i.key, i]));

  const refunds: ObservedRefund[] = refundRows.map((r) => {
    const fromImpact = impacts.find((i) => i.refundId === r.id)?.incidentKey ?? null;
    const fromTicket = ticketData.incidentByRefund.get(r.id) ?? null;
    const linkedIncident = fromImpact ?? fromTicket;
    const ticketUrl = r.ticketKey ? browse(base, r.ticketKey) : undefined;
    return {
      ...r,
      linkedIncident,
      linkedDeploy: linkedIncident ? (incidentByKey.get(linkedIncident)?.linkedDeploy ?? null) : null,
      ticketKey: r.ticketKey,
      ...(ticketUrl ? { ticketUrl } : {}),
    };
  });

  const explicit = new Set<string>([
    ...impacts.map((i) => i.incidentKey),
    ...refunds.map((r) => r.linkedIncident).filter((k): k is string => !!k),
  ]);
  const incidents: ObservedIncident[] = allIncidents
    .flatMap((i): ObservedIncident[] => {
      if (explicit.has(i.key)) return [{ ...i, link: 'explicit' as const }];
      if (overlaps(order.purchasedAt, i.windowStart, i.windowEnd)) return [{ ...i, link: 'none' as const }];
      return [];
    })
    .sort(byTimeThenKey((i) => i.windowStart, (i) => i.key));

  return { dispute, order, product, charges, refunds, priorOrders, tickets: ticketData.tickets, incidents, policies };
}
