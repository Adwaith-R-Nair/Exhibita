// Authorisation checks made as the calling user. Module visibility is not authorisation, so anything
// that changes state or reveals a dispute checks the user's own Jira permissions first (review A2, A3).

import api, { route } from '@forge/api';

export class NotAllowedError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Atlassian sometimes answers 403 "Tenant is restricted" while it maintains or migrates a site, and 429 or
 * 5xx under load. Those are temporary; a permission check must not turn them into "you are not allowed".
 */
export const isTemporary = (status: number, body: string) => status === 429 || status >= 500 || (status === 403 && /tenant is restricted/i.test(body));

async function checkWithRetry(path: ReturnType<typeof route>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await api.asUser().requestJira(path, { headers: { Accept: 'application/json' } });
    if (res.ok) return res as unknown as Response;
    const body = await res.text();
    if (!isTemporary(res.status, body) || attempt >= 2) {
      if (isTemporary(res.status, body)) throw new NotAllowedError('Atlassian is doing maintenance on this site right now. Wait a minute, then try again.');
      throw new NotAllowedError(`Could not check your permissions (HTTP ${res.status}).`);
    }
    await sleep(1500 * (attempt + 1));
  }
}

/** The caller must hold Administer Jira. Used by every state-changing setup-page call. */
export async function requireSiteAdmin(): Promise<void> {
  const res = await checkWithRetry(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
  const body = (await res.json()) as { permissions?: { ADMINISTER?: { havePermission?: boolean } } };
  if (!body.permissions?.ADMINISTER?.havePermission) throw new NotAllowedError('Only Jira administrators can change Exhibita setup.');
}

/** True when the calling user can see this work item, as Jira itself decides. */
export async function userCanBrowse(issueKey: string): Promise<boolean> {
  const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary`, { headers: { Accept: 'application/json' } });
  return res.ok;
}

/** The caller must hold these project permissions (for example BROWSE_PROJECTS, TRANSITION_ISSUES). */
export async function requireProjectPermissions(projectKey: string, permissions: readonly string[], what: string): Promise<void> {
  const res = await checkWithRetry(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=${permissions.join(',')}`);
  const body = (await res.json()) as { permissions?: Record<string, { havePermission?: boolean }> };
  const missing = permissions.filter((p) => !body.permissions?.[p]?.havePermission);
  if (missing.length > 0) throw new NotAllowedError(`You need permission to ${what} in ${projectKey}.`);
}
