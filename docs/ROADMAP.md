# Roadmap

Target: feature freeze **15 Dec 2026**, submission **21 Dec 2026**. Each milestone ends with a working demo and a review pass (D-10). Progress, breakages and fixes are recorded in [BUILD_LOG.md](BUILD_LOG.md).

| # | Planned dates | Milestone | Done when | Status |
|---|---|---|---|---|
| M0 | 26–28 Nov | **Foundations and platform spikes.** TypeScript skeleton, first deploy and install, the 13 spikes in [SPIKES.md](SPIKES.md) | Every spike has a recorded result and the plan is adjusted | **Done** (26 Nov). 9 of 13 spikes pass. The four Rovo and MCP spikes (S6, S7, S9, S13) are pending and move to M4 |
| M1 | 29 Nov – 2 Dec | **Thin end-to-end slice.** Webhook → queue → DSP work item → rubric for one reason → verdict in the issue panel → validator blocks Submit | A signed test webhook produces a dispute with a verdict, and Submit is blocked | **Done** (26 Nov) |
| M2 | 3–7 Dec | **The plot twist, end to end.** Setup wizard (resumable, progress, safe removal), SQL schema, evidence collectors with provenance, deep rubrics, lexicon classifier, challenge and refund reconciliation, Fight to Accept flip, validation suite 10/10 | The $249 Visa 13.6 hero flips from Fight to Accept, live, with cited sources, on a freshly seeded site | **Done** (27 Nov), including review round 1: all A to C findings fixed and verified live (63 of 63 demo disputes as intended, validation 10/10, all platform checks pass) |
| M3 | 8–11 Dec | **Systemic view.** A systemic page with the cluster and its cost, blast radius, **safe bulk accept** (one confirmed action that accepts the cluster and cancels the stuck refunds for those payments, so no customer is paid twice), a proactive refund queue for the 212, the dev-side cost bug on the deploy, the hypothesis board and the evidence graph. A queue view by deadline | 38 disputes ($5,492, or $6,062 with fees) and 212 customers owed $30,859 trace to the refund incident and its deploy; bulk accept cancels the stuck refunds; the cost bug is filed | **Done** (27 Nov), verified live. Cut on review advice: the separate hypothesis board and evidence graph (the panel's case against us and the cluster page cover them). The deadline queue moves to M5; due dates are already set on every dispute |
| M4 | 12–14 Dec | **Rovo in the workflow, and outputs.** Agent with six GET actions (two built), the Automation rule that runs the agent on every new dispute, `rovo:mcp` and `skill.md`, the defense pack as an exportable evidence package with a hash, the dispute watcher, the command center with a ratio gauge checked against Visa's current monitoring program. Spikes S6, S7, S9, S13 | The agent drafts a cited narrative on a new dispute, answers with citations in chat, and an MCP client calls a tool | Planned |
|  | **15 Dec** | **Feature freeze** | | |
| M5 | 16–18 Dec | **Hardening.** Fresh-site install via the install link, onboarding, empty and error states, README, judge quick start, architecture diagram, privacy and terms | Someone new can install it and see the demo with only the quick start | Planned |
| M6 | 19–21 Dec | **Video and submission** | Submitted | Planned |

## Deferred beyond this release

These were raised in review round 1 and deliberately left out (see [reviews/round-1.md](reviews/round-1.md)):

- **Dispute stages and arbitration fees.** Response, pre-arbitration and arbitration each have their own rules and fees. The stage may be recorded with a warning about arbitration costs, but stage-aware rubrics are out of scope.
- **Mastercard and other networks.** Shown as not supported yet rather than judged by Visa rules (D-18).
- **Proving upstream records were not edited.** Exhibita flags inconsistencies and keeps an audit trail and an evidence hash, but trusts the merchant's own systems.
