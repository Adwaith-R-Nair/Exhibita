# Decision log

Each decision has an ID that commit subjects reference, for example `(D-04)`. A decision is never edited after the fact; a later one supersedes it.

---

## D-01: Decisions are deterministic code; Rovo explains them
**Date:** 26 Nov 2026
**Context:** A Forge backend cannot call a Rovo agent and read the result, and a dispute recommendation has to be repeatable and auditable.
**Decision:** Rubric evaluation, contradiction checks, clustering and triage are pure, unit-tested functions. The Rovo agent reads their output through GET actions and explains or challenges it.
**Consequence:** The same dispute always gets the same recommendation. The agent cannot invent a verdict.

## D-02: No paid AI; a phrase lexicon classifies customer text
**Date:** 26 Nov 2026
**Context:** The Forge LLM module has no free allowance, and an external LLM API would be a paid dependency and a data-sharing concern.
**Decision:** Customer messages are classified (acknowledged receipt, complained, asked for a refund, mentioned the bank) by a tested phrase lexicon with negation handling. Every result is labelled *Inference*.
**Consequence:** Classification is cheap, explainable and testable, at the cost of recall on unusual phrasing.

## D-03: Orders and customers live in Forge SQL, not Assets
**Date:** 26 Nov 2026
**Context:** Forge apps cannot create an Assets object schema.
**Decision:** Orders, customers, merchants, historical outcomes and the audit log are Forge SQL tables. Assets may be mirrored later behind a probe, but nothing depends on it.

## D-04: The dispute record lives in an issue property
**Date:** 26 Nov 2026
**Context:** The panel, the workflow validator, the agent actions and the MCP tools must all agree on the evidence.
**Decision:** Each dispute's record, evidence and raw webhook payload are stored in the issue property `exhibita`.
**Consequence:** One read gives every surface the same view, and the record moves with the issue.

## D-05: Demo data comes from an admin wizard, not install-time seeding
**Date:** 26 Nov 2026
**Context:** Install-time seeding is fragile, and some admin-only REST calls fail when made as the app.
**Decision:** An admin page offers "Set up demo data" and "Remove demo data". The wizard is idempotent, runs as the admin user, and shows progress.

## D-06: Agent tools are read-only; state changes need a human
**Date:** 26 Nov 2026
**Context:** Jira Automation only runs GET actions, and accepting a dispute moves money.
**Decision:** Every Rovo and MCP tool is `actionVerb: GET`. Accepting, bulk accepting, building the pack and queuing refunds are panel buttons with confirmation.

## D-07: The submit gate lives in the workflow and fails closed
**Date:** 26 Nov 2026
**Context:** A banner in a panel can be ignored. A workflow rule cannot.
**Decision:** A `jira:workflowValidator` on "Submit to network" rejects the transition until the rubric passes, and names what is missing. If it cannot load or evaluate the record, it rejects.

## D-08: Never show a win percentage
**Date:** 26 Nov 2026
**Context:** Seeded or small-sample outcome data cannot support a probability, and a false number would undermine trust in everything else.
**Decision:** Exhibita reports evidence coverage ("4 of 5 required items met") and a Strong, Partial or Weak label. No win percentage anywhere.

## D-09: TypeScript throughout
**Date:** 26 Nov 2026
**Context:** The evidence model has many states, and confusing "refund initiated" with "refund completed" is exactly the bug the product exists to catch.
**Decision:** The app is written in TypeScript with strict mode. The pure core compiles and tests without Forge.

## D-10: Build the core story end to end first
**Date:** 26 Nov 2026
**Context:** Building one layer at a time would leave the main story (webhook to verdict flip to cluster) unproven until late.
**Decision:** After the platform spikes, build a thin vertical slice of the full story first, then widen each part. Every milestone leaves a working demo.

## D-11: Exhibita's own storage holds the authoritative dispute record
**Date:** 26 Nov 2026
**Supersedes:** the storage part of D-04.
**Context:** Spike S8 showed that anyone who can edit a work item can rewrite its issue properties through the REST API. Evidence typed into the property by hand passed the submit gate.
**Decision:** The record is stored in Forge app storage under `record:{issueId}`, which only the app can write, and mirrored to the issue property `exhibita` for JQL and display. The panel, the validator and the agent actions read the stored copy only. If the mirror differs from it, the panel and agent say so. If only a mirror exists, nothing is evaluated and submission is blocked. A redelivered webhook restores a missing stored record from the authenticated payload, with evidence collected again.
**Consequence:** Evidence can only enter a record through Exhibita's own code paths. Each read costs one extra storage call, and records are keyed by issue id so they survive a project move.
