# Build log

Notable progress, surprises and lessons, newest first.

## 26 Nov 2026 (evening): first live run
- Registered the app in the Exhibita Developer Space, deployed to development and installed on the demo site. Live checks S1, S2, S4, S10 (from a resolver) and S11 pass; details in [SPIKES.md](SPIKES.md).
- Two build fixes before the first deploy: Forge's ts-loader emits nothing under `noEmit`, and its webpack config does not resolve `.js` import paths to `.ts`, so imports are now extensionless.
- The setup page was stuck loading because the ISP's DNS refused Forge's CDN hosts. Public DNS fixed it. Worth knowing for the demo recording.
- The live run caught two intake bugs the unit tests could not: disputes became Epics, and a redelivered webhook made a duplicate (JQL cannot search an issue property until `jira:entityProperty` indexes it). Both fixed, with a KVS marker for read-your-writes deduplication.
- Surprise: a service project created through the REST API is a shell (Epic and Story only, no service desk behind it), and the caller is not an agent. The issue panel does not show there. Next: decide how the disputes project gets created.

## 26 Nov 2026
- Checked fifteen platform facts against the Forge docs before writing Forge code ([SPIKES.md](SPIKES.md)). All three load-bearing assumptions held: function keys max 23 characters, Automation runs only GET actions, and a backend cannot read a Rovo reply. New find: Jira's experimental agents API can *start* an agent on issues, now spike S13.
- Package majors had moved well past the early scaffold (`@forge/api` 8, `@forge/bridge` 7, `@forge/react` 12), so every API call was checked against the installed type definitions.
- **Open risk:** the docs require `app.rovo` metadata for `rovo:mcp` apps from 5 Jan 2027, but `@forge/manifest` 13.9.1 (the newest) rejects it. Left out of the manifest with a comment; re-check the schema before submission.
- Every new Forge app now needs a Developer Space, which the CLI cannot create. That is a one-time console step before the first deploy.
- Core so far: rubrics and triage for five reasons, a webhook normaliser, and a negation-aware customer-text classifier. 66 tests.
- Started the repo docs-first: spec, architecture, ten decision records, invariants for coding agents, roadmap.
- Chose TypeScript over plain JavaScript (D-09) and an end-to-end slice before widening each layer (D-10).
