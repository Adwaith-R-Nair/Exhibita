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

## D-12: Submission follows the final verdict, after the challenge
**Date:** 26 Nov 2026
**Context:** The rubric can say Fight with every required item met while the challenge finds something that makes fighting unsafe, such as the customer saying the parcel never arrived. Gating on the rubric alone would let that case through.
**Decision:** The panel, the validator and the agent actions share one verdict: the rubric's result, then the challenge. "Submit to network" needs every required item met and a final recommendation of Fight. When the challenge changes the recommendation, the panel says so and shows the case against.
**Consequence:** The challenge can block a submission, never unblock one. The checklist still explains what is missing.

## D-13: The setup wizard is driven step by step from the admin's browser
**Date:** 26 Nov 2026
**Context:** Creating projects, workflows and Confluence spaces must run as the admin, takes minutes in total, and each resolver call has a short time limit. Queue consumers do not run as the user.
**Decision:** "Set up demo data" runs as a list of find-or-create steps. The page calls one bounded step at a time and shows progress. State, including everything created, is saved in app storage after every step, so a failed run resumes where it stopped and "Remove demo data" removes exactly what was made. Disputes are pushed through the same queue the webhook uses, so the demo exercises the real intake path.
**Consequence:** The admin keeps the page open for a few minutes. Nothing half-made is left untracked.

## D-14: Demo world layout
**Date:** 26 Nov 2026
**Context:** Jira assigns issue keys, so the story cannot rely on keys such as INC-231. Service projects made through the REST API need the right template (spike S3, revisited).
**Decision:** Disputes in a service project (default DSP), support tickets in a second service project (SUP), incidents and deploys in two company-managed software projects (INC, DEP), policies in a Confluence space (EXHPOL), and payment records in Forge SQL. Ticket and incident details that Jira cannot hold natively (original message times, incident windows) are stored as issue properties, and policy effective dates as a page property, because Jira and Confluence timestamps cannot be backdated.
**Consequence:** The story's keys depend on the site, for example "INC-1 caused by DEP-2". Causes are recorded only as Jira "Causes" links and SQL impact rows.

## D-15: Exhibita keeps its own ledger of the disputes it takes in
**Date:** 27 Nov 2026
**Context:** Two deliveries of one dispute could both create a work item, and the list of disputed orders used by Compelling Evidence 3.0 came from issue properties anyone can edit (review round 1).
**Decision:** Intake claims each processor dispute id with an atomic insert into a SQL `disputes` table before creating anything, then records the work item key. A claim left pending by a crash is taken over after ten minutes. The ledger is the trusted answer to "which orders were disputed" and to "which work items did the demo create".
**Consequence:** Redeliveries and concurrent deliveries are harmless, removal never needs to select by an editable label, and legacy disputes are still found through the older marker and JQL.

## D-16: Dispute webhooks are signed, not shared-secret
**Date:** 27 Nov 2026
**Context:** A static secret in a header can leak into logs and be replayed indefinitely.
**Decision:** Requests carry a Stripe-style signature: `t=<unix time>,v1=<HMAC-SHA256 of "t.body">` in `x-exhibita-signature` or `stripe-signature`, made with the webhook secret. Requests more than five minutes from the current time are refused.
**Consequence:** The secret never travels with a request, a captured request cannot be replayed later, and processors that already sign this way work unchanged.

## D-17: Reconcile the merchant's refund records against the processor
**Date:** 27 Nov 2026
**Context:** Review round 1 showed the original hero was modelled on the wrong reason (a refund that was promised and never paid is Visa 13.6) and that the Fight-to-Accept flip never appeared. A real and common failure is a refund system that records a refund as sent when the processor never received it.
**Decision:** Collect the processor's view of refunds (the charge's amount refunded) as its own source, read after the merchant's refund records. When the refund service says completed but the processor shows no refund, the challenge raises a decisive finding that names any explicitly linked incident and deploy. The hero is a $249 Visa 13.6 dispute whose checklist says Fight until that reconciliation flips it to Accept.
**Consequence:** The flip is genuine and visible live as the settlements source is read. Accepting a cluster must also cancel the stuck refunds for those payments, so no customer is paid twice (planned for the bulk accept in M3).

## D-18: The rubrics are Visa rules, and say so
**Date:** 27 Nov 2026
**Context:** Mastercard and other networks have different reason codes, stages and evidence rules. Applying Visa rules to them would give confident wrong answers.
**Decision:** Every dispute carries its card network from the processor event. Visa disputes are judged and labelled "Judged against Visa dispute rules"; Mastercard, Amex and Discover disputes are marked not supported yet and recommended for review by hand; an unknown network gets Visa rules with a note.
**Consequence:** Coverage is narrower but every answer the app gives is one it can stand behind. Dispute stages (pre-arbitration, arbitration fees) are recorded as deferred.
