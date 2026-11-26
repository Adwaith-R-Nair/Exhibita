// Confluence wrappers: the policy space, policy pages and their versions, and page properties.
// Page versions cannot be backdated (spike S12), so each policy page carries a page property that
// records which policy version took effect when. The policy in force at purchase is read from it.

import api, { route } from '@forge/api';
import type { ObservedPolicyVersion, PolicyKind } from '../core/sources/types';

type Requester = Pick<ReturnType<typeof api.asApp>, 'requestConfluence'>;

export class ConfluenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${message} (HTTP ${status}): ${body.slice(0, 300)}`);
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

async function call<T>(as: Requester, path: ReturnType<typeof route>, what: string, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await as.requestConfluence(path, init ? { method: init.method, headers: JSON_HEADERS, body: init.body === undefined ? undefined : JSON.stringify(init.body) } : { headers: JSON_HEADERS });
  const text = await res.text();
  if (!res.ok) throw new ConfluenceError(what, res.status, text);
  return (text ? JSON.parse(text) : null) as T;
}

export const POLICY_PROPERTY = 'exhibita-policy';

/** Stored on each policy page: which policy version is which page version, and when each applied. */
export interface PolicyPageProperty {
  kind: PolicyKind;
  versions: { version: string; pageVersion: number; effectiveFrom: string; effectiveTo: string | null }[];
}

export interface SpaceInfo {
  id: string;
  key: string;
  homepageId?: string;
}

export async function findSpace(key: string, as: Requester = api.asUser()): Promise<SpaceInfo | null> {
  const res = await call<{ results: SpaceInfo[] }>(as, route`/wiki/api/v2/spaces?keys=${key}`, `Looking up space ${key}`);
  return res.results[0] ?? null;
}

export async function ensureSpace(key: string, name: string, description: string, as: Requester = api.asUser()): Promise<{ space: SpaceInfo; created: boolean }> {
  const existing = await findSpace(key, as);
  if (existing) return { space: existing, created: false };
  const space = await call<SpaceInfo>(as, route`/wiki/api/v2/spaces`, `Creating space ${key}`, {
    method: 'POST',
    body: { key, name, description: { value: description, representation: 'plain' } },
  });
  return { space, created: true };
}

/** Move a space to the Confluence trash (an admin can restore it). */
export async function trashSpace(key: string, as: Requester = api.asUser()): Promise<boolean> {
  const res = await as.requestConfluence(route`/wiki/rest/api/space/${key}`, { method: 'DELETE' });
  if (res.status === 404) return false;
  if (!res.ok) throw new ConfluenceError(`Removing space ${key}`, res.status, await res.text());
  return true;
}

export interface PageInfo {
  id: string;
  title: string;
  version: { number: number };
  _links?: { webui?: string; base?: string };
}

export async function findPage(spaceId: string, title: string, as: Requester = api.asUser()): Promise<PageInfo | null> {
  const res = await call<{ results: PageInfo[] }>(as, route`/wiki/api/v2/spaces/${spaceId}/pages?title=${title}&limit=5`, `Looking up page ${title}`);
  return res.results.find((p) => p.title === title) ?? null;
}

export async function createPage(spaceId: string, title: string, storageBody: string, as: Requester = api.asUser()): Promise<PageInfo> {
  return call<PageInfo>(as, route`/wiki/api/v2/pages`, `Creating page ${title}`, {
    method: 'POST',
    body: { spaceId, status: 'current', title, body: { representation: 'storage', value: storageBody } },
  });
}

export async function updatePage(page: PageInfo, storageBody: string, message: string, as: Requester = api.asUser()): Promise<PageInfo> {
  return call<PageInfo>(as, route`/wiki/api/v2/pages/${page.id}`, `Updating page ${page.title}`, {
    method: 'PUT',
    body: { id: page.id, status: 'current', title: page.title, body: { representation: 'storage', value: storageBody }, version: { number: page.version.number + 1, message } },
  });
}

interface PropertyRead {
  id: string;
  key: string;
  value: unknown;
  version: { number: number };
}

export async function getPageProperty<T>(pageId: string, key: string, as: Requester = api.asApp()): Promise<T | null> {
  const res = await call<{ results: PropertyRead[] }>(as, route`/wiki/api/v2/pages/${pageId}/properties?key=${key}`, `Reading ${key} on page ${pageId}`);
  return (res.results[0]?.value as T | undefined) ?? null;
}

export async function setPageProperty(pageId: string, key: string, value: unknown, as: Requester = api.asUser()): Promise<void> {
  const res = await call<{ results: PropertyRead[] }>(as, route`/wiki/api/v2/pages/${pageId}/properties?key=${key}`, `Reading ${key} on page ${pageId}`);
  const existing = res.results[0];
  if (existing) {
    await call(as, route`/wiki/api/v2/pages/${pageId}/properties/${existing.id}`, `Updating ${key} on page ${pageId}`, {
      method: 'PUT',
      body: { key, value, version: { number: existing.version.number + 1 } },
    });
  } else {
    await call(as, route`/wiki/api/v2/pages/${pageId}/properties`, `Setting ${key} on page ${pageId}`, { method: 'POST', body: { key, value } });
  }
}

export async function getPage(pageId: string, as: Requester = api.asApp()): Promise<PageInfo | null> {
  const res = await as.requestConfluence(route`/wiki/api/v2/pages/${pageId}`, { headers: JSON_HEADERS });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new ConfluenceError(`Reading page ${pageId}`, res.status, text);
  return JSON.parse(text) as PageInfo;
}

/** Every version of a policy page, as the collectors see it. Empty if the page has no policy property. */
export async function readPolicyVersions(pageId: string, siteUrl: string | null, as: Requester = api.asApp()): Promise<ObservedPolicyVersion[]> {
  const [page, prop] = await Promise.all([getPage(pageId, as), getPageProperty<PolicyPageProperty>(pageId, POLICY_PROPERTY, as)]);
  if (!page || !prop) return [];
  const webui = page._links?.webui;
  const url = siteUrl && webui ? `${siteUrl}/wiki${webui}` : undefined;
  return prop.versions.map((v) => ({
    pageId,
    title: page.title,
    ...(url ? { url: `${url}?pageVersion=${v.pageVersion}` } : {}),
    kind: prop.kind,
    version: v.version,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: v.effectiveTo,
  }));
}
