# Build log

Notable progress, surprises and lessons, newest first.

## 26 Nov 2026 (night): the submit gate works
- DSP has a Dispute work type and an "Exhibita dispute workflow" (New, Collecting evidence, Ready to submit, Submitted, Won, Lost, Accepted). The statuses, workflow, work type and scheme mapping were made through the REST API; publishing the workflow scheme needs status mappings even when no work items of the type exist yet.
- The validator is attached to "Submit to network". It blocks DSP-3 with the missing exhibits named, in the UI and over REST, and lets it through once proof of delivery and a no-refund record are present (spike S8).
- Jira stores a Forge validator as `forge:expression-validator` keyed by the extension ARI, which includes the environment id. The seed wizard can therefore build the whole workflow, validator included, with one API call.
- Surprise worth acting on: issue properties are writable by anyone who can edit the work item. A user could add evidence to the record by hand and pass the gate, which is how the pass case was tested.
- Fixed the same night (D-11). The authoritative record now lives in Forge app storage and the issue property is a mirror. Checked live: evidence typed into DSP-4's property by hand no longer passes "Submit to network", and the panel says the record was edited outside Exhibita. DSP-1, created before the change, showed as untrusted until its webhook was resent, which restored the stored record.

## 26 Nov 2026 (evening): first live run
- Registered the app in the Exhibita Developer Space, deployed to development and installed on the demo site. Live checks S1, S2, S4, S10 (from a resolver) and S11 pass; details in [SPIKES.md](SPIKES.md).
- Two build fixes before the first deploy: Forge's ts-loader emits nothing under `noEmit`, and its webpack config does not resolve `.js` import paths to `.ts`, so imports are now extensionless.
- The setup page was stuck loading because the ISP's DNS refused Forge's CDN hosts. Public DNS fixed it. Worth knowing for the demo recording.
- The live run caught two intake bugs the unit tests could not: disputes became Epics, and a redelivered webhook made a duplicate (JQL cannot search an issue property until `jira:entityProperty` indexes it). Both fixed, with a KVS marker for read-your-writes deduplication.
- Surprise: a service project created through the REST API is a shell (Epic and Story only, no service desk behind it), and the caller is not an agent. The issue panel does not show there. Replaced it with a project created from Jira's UI (Finance service management, company-managed so Forge validators apply); the panel then appeared and rendered the live rubric. M1 slice now runs webhook to work item to panel; the workflow validator is next.

## 26 Nov 2026
- Checked fifteen platform facts against the Forge docs before writing Forge code ([SPIKES.md](SPIKES.md)). All three load-bearing assumptions held: function keys max 23 characters, Automation runs only GET actions, and a backend cannot read a Rovo reply. New find: Jira's experimental agents API can *start* an agent on issues, now spike S13.
- Package majors had moved well past the early scaffold (`@forge/api` 8, `@forge/bridge` 7, `@forge/react` 12), so every API call was checked against the installed type definitions.
- **Open risk:** the docs require `app.rovo` metadata for `rovo:mcp` apps from 5 Jan 2027, but `@forge/manifest` 13.9.1 (the newest) rejects it. Left out of the manifest with a comment; re-check the schema before submission.
- Every new Forge app now needs a Developer Space, which the CLI cannot create. That is a one-time console step before the first deploy.
- Core so far: rubrics and triage for five reasons, a webhook normaliser, and a negation-aware customer-text classifier. 66 tests.
- Started the repo docs-first: spec, architecture, ten decision records, invariants for coding agents, roadmap.
- Chose TypeScript over plain JavaScript (D-09) and an end-to-end slice before widening each layer (D-10).
