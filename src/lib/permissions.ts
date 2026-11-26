// Authorisation checks made as the calling user. Module visibility is not authorisation, so anything
// that changes state or reveals a dispute checks the user's own Jira permissions first (review A2, A3).

import api, { route } from '@forge/api';

export class NotAllowedError extends Error {}

/** The caller must hold Administer Jira. Used by every state-changing setup-page call. */
export async function requireSiteAdmin(): Promise<void> {
  const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new NotAllowedError(`Could not check your permissions (HTTP ${res.status}).`);
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
  const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=${permissions.join(',')}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new NotAllowedError(`Could not check your permissions on ${projectKey} (HTTP ${res.status}).`);
  const body = (await res.json()) as { permissions?: Record<string, { havePermission?: boolean }> };
  const missing = permissions.filter((p) => !body.permissions?.[p]?.havePermission);
  if (missing.length > 0) throw new NotAllowedError(`You need permission to ${what} in ${projectKey}.`);
}
