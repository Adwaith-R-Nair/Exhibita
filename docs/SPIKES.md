# Platform spikes

Facts that decide design choices, each with its evidence. Part 1 was checked against the Forge documentation. Part 2 is checked on the live development site, and nothing there counts as true until it has run.

## Part 1: documentation check (26 Nov 2026)

| # | Question | Finding | Source |
|---|---|---|---|
| D1 | Can a backend call a Rovo agent and read the reply? | No. `rovo.open` from the UI opens chat only. Jira REST v3 has **experimental** endpoints that *start* agents on 1 to 50 issues asynchronously (`POST /rest/api/3/agents/bulk/invoke/uniform`), with no reply returned. | [Rovo bridge](https://developer.atlassian.com/platform/forge/apis-reference/ui-api-bridge/rovo/), [Jira agents API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-agents/) |
| D2 | Which actions can Automation run? | GET only. "Agents triggered by automation rules will not invoke actions with actionVerb CREATE, UPDATE, DELETE, and TRIGGER." | [action module](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/) |
| D3 | Function key length | 23 characters at most, `^[a-zA-Z0-9_-]+$` | [function module](https://developer.atlassian.com/platform/forge/manifest-reference/modules/function/) |
| D4 | Workflow validator shape | Function receives `{ issue: { key }, configuration, transition: { from, to, modifiedFields } }`, rejects with `{ result: false, errorMessage }`. Company-managed by default; team-managed needs `projectTypes`. JSM transitions are supported. Function validators are created in the new workflow editor. | [workflowValidator](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-workflow-validator/) |
| D5 | Action payload | Inputs at the top level next to `context.jira` (`issueKey`, `projectKey`, ...). Returns any string or JSON. | [action module](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/) |
| D6 | `rovo:mcp` | One module per app, up to 50 `action` keys as tools. Endpoint `https://mcp.atlassian.com/forge/<appId>`. Off by default; an admin turns tools on per installation under admin.atlassian.com > Apps > Sites > Connected apps. | [rovo:mcp](https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-mcp/) |
| D7 | `app.rovo` metadata | Required from 5 Jan 2027 for apps with `rovo:mcp`: `tag` (8 chars max), `description` (100 max), `keywords` (50 chars combined). | [manifest reference](https://developer.atlassian.com/platform/forge/manifest-reference/) |
| D8 | Runtime | `nodejs24.x` recommended; `nodejs22.x` and `nodejs20.x` allowed. | [manifest reference](https://developer.atlassian.com/platform/forge/manifest-reference/) |
| D9 | Queues | `new Queue({ key }).push({ body })`; the consumer reads `event.body`. 200 KB per push, 50 events per push, timeout up to 900 s, automatic retries with backoff. | [async events](https://developer.atlassian.com/platform/forge/runtime-reference/async-events-api/) |
| D10 | Forge SQL | `migrationRunner.enqueue(name, ddl).run()`, run from a consumer triggered on install and upgrade. Per install: 200 tables, SELECT 5 s, writes 10 s. Free monthly allowance: 1 hour compute, 100k requests. Adding `sql` to an existing app forces a major version. | [SQL API](https://developer.atlassian.com/platform/forge/storage-reference/sql-api/), [pricing](https://developer.atlassian.com/platform/forge/forge-platform-pricing/) |
| D11 | Realtime | Backend `publish(channel, payload)`, UI `realtime.subscribe` from `@forge/bridge`. 50 requests per second per install, 1 MB per payload. | [Realtime](https://developer.atlassian.com/platform/forge/runtime-reference/realtime-events-api/) |
| D12 | Sharing by install link | Requires a production deploy, then Distribution > Sharing in the developer console. Apps with `licensing` in the manifest cannot be shared by link. | [distribute your apps](https://developer.atlassian.com/platform/forge/distribute-your-apps/) |
| D13 | Teamwork Graph | `api.asUser().requestTeamworkGraph(...)`, one scope per object type; missing scopes fail silently; raw Cypher is not available to new apps. | [call the Teamwork Graph API](https://developer.atlassian.com/platform/forge/call-the-teamwork-graph-api/) |
| D14 | UI Kit | Lozenge, Tooltip, DynamicTable, ProgressBar, Modal, Box/Inline/Stack with XCSS, and Bar, Donut, Line and Pie charts are available. No Spotlight component, so onboarding is built from existing components. | [UI Kit components](https://developer.atlassian.com/platform/forge/ui-kit/components/) |
| D15 | Every new app needs a Developer Space | Created in the developer console; the CLI cannot create one. | [Developer Spaces](https://developer.atlassian.com/platform/forge/developer-space/create-developer-space/) |

## Part 2: live checks on the development site

| # | Spike | Result |
|---|---|---|
| S1 | Deploy and install the skeleton; admin page loads | pending |
| S2 | KVS and SQL: run a migration, insert, select | pending |
| S3 | Find or create the JSM service project `DSP` from code | pending |
| S4 | Web trigger: post a dispute, see it queued, consumer creates a DSP work item | pending |
| S5 | Issue panel renders on a DSP work item | pending |
| S6 | Rovo agent appears in chat, calls a GET action, sees seeded issues | pending |
| S7 | Automation rule: work item created → Use Rovo agent → comment | pending |
| S8 | Workflow validator blocks a DSP transition with our message | pending |
| S9 | `rovo:mcp`: enable in admin, connect Claude Code, list and call a tool | pending |
| S10 | Realtime: publish from a consumer, panel receives it | pending |
| S11 | Teamwork Graph: one curated query on the site | pending |
| S12 | Confluence: create a page, read back a page's versions | pending |
| S13 | Experimental Jira agents API: can the app start Exhibita Analyst on an issue? | pending |
