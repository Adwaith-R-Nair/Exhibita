# Exhibita product spec

**Exhibita: every claim, an exhibit.** A Forge app for Jira Service Management that builds a card-chargeback defense from evidence the team already has in Jira, JSM and Confluence. It cites every claim, blocks submission until the evidence is complete, and says when the evidence points to accepting a dispute instead of fighting it. It also traces many disputes back to one incident or deploy, and queues refunds for affected customers before they dispute.

Status: v2.1 of the spec, 26 Nov 2026. Decisions that shape it are logged in [DECISIONS.md](DECISIONS.md).

---

## 1. The problem

A customer tells their bank they never got what they paid for. The merchant now has a fixed window, often 7 to 20 days depending on the processor, to send evidence or lose the money plus a dispute fee. Every lost dispute also counts toward the card networks' dispute-ratio monitoring, and crossing those thresholds brings fines and higher processing costs.

The evidence that wins or loses a dispute is already inside the company, just scattered:

- the customer's own words in support tickets ("got it, thanks", "I want a refund")
- the refund and shipping policy pages, in the version that was live on the purchase date
- refund requests, and whether a refund was only approved or actually completed
- incidents and deploys that broke something for a batch of customers

Analysts copy this into a processor portal by hand, under deadline. They fight disputes they will lose because nobody noticed the refund never went out, and they fight the same root cause thirty times because nobody connected the disputes to the incident behind them.

## 2. Who it is for

- **Primary user:** the dispute analyst working a JSM "Disputes" queue. Every feature is designed from their seat.
- **Buyer:** any company on Atlassian that takes card payments. SaaS subscriptions are the lead example, then e-commerce and marketplaces.
- **Also:** payment aggregators and marketplaces with a dedicated chargeback team pulling disputes from several processors into one queue.

Value line: *Exhibita is for any team on Jira that takes card payments. It wins back the disputes you should win and stops you paying fees to fight the ones you'll lose.*

## 3. The core story

1. A $249 "not as described" dispute arrives. It looks defensible: the order was delivered and the customer received it.
2. Exhibita's evidence checks find that **a refund was approved but never completed**. A refund-service incident, INC-231, caused by deploy DEP-88, silently dropped it.
3. The recommendation flips from **Fight** to **Accept**, and the panel shows why, with a source for every line.
4. **37 more disputes** trace to the same incident, plus **212 affected customers who have not disputed yet**.
5. One confirmed action accepts the 37 and queues the 212 refunds. The dev team gets a linked bug: "DEP-88 has cost $9,140 in disputes so far."

## 4. Principles

1. **Deterministic core, AI on top.** Rubric evaluation, evidence matching, contradiction checks, clustering and triage are tested code. The Rovo agent explains, challenges and answers questions. It never decides.
2. **Never show a win percentage.** Exhibita reports evidence coverage ("4 of 5 required items met"), not a made-up probability.
3. **Every claim has a source.** Each evidence item carries where it came from, when, and its state. "Refund initiated" and "refund completed" are different facts.
4. **Facts and inferences look different.** Anything derived by classification (for example, "customer acknowledged receipt") is labelled *Inference*.
5. **Humans confirm anything that changes state.** Accepting disputes, bulk actions, creating the pack and queuing refunds are buttons with confirmation. Agent tools are read-only.
6. **Runs on Atlassian, no paid AI.** No external LLM API and no Forge LLM module. Customer-text classification uses a tested phrase lexicon with negation handling.
7. **Degrade gracefully.** If Teamwork Graph, Rovo or Assets is unavailable, the core flow still works and the UI says what is missing.

## 5. Features

### 5.1 Intake
- A Forge web trigger accepts a dispute webhook in a Stripe-compatible JSON shape, checks a shared secret, replies fast, and queues the work.
- A queue consumer creates a JSM **Dispute** work item with reason (plain English plus code), amount, respond-by date, order and customer. The raw payload is kept unchanged for audit.
- The respond-by deadline shows as a native JSM SLA in the queue.
- A replay script can fire a "dispute storm" of about 40 webhooks for demos and load testing.

### 5.2 Triage: Fight, Accept or Investigate
- On arrival, deterministic triage recommends **Fight**, **Accept** or **Investigate**, with a one-line reason.
  - A contradicting fact on a must-have item (refund owed, incident caused it) means **Accept**.
  - Every required item met means **Fight**.
  - Otherwise **Investigate**, listing what is missing.
- An importable Jira Automation rule runs the Exhibita Analyst agent when a dispute is created. The agent reads the case through the GET actions and posts a drafted, cited defense narrative as a comment.

### 5.3 Build defense: the evidence checklist
- A transparent rubric per reason, with the rule text visible ("why is this required?").
- Evidence items are lettered **Exhibit A, B, C** and show source, timestamp and state, with Fact or Inference labels.
- An evidence coverage score, for example "4 of 5 required items met (Strong)".
- **Submit is blocked** while required evidence is missing, and the panel says exactly what to add. This is enforced in the workflow itself: a `jira:workflowValidator` on the "Submit to network" transition rejects the move and names what is missing. It fails closed on errors.
- The checklist updates live as evidence is collected.

### 5.4 Challenge this: the evidence red team
A deterministic contradiction engine runs before submission and looks for:
- customer messages that contradict the merchant's claim
- a refund approved but not completed
- proof-of-delivery name or address mismatch
- evidence created after the dispute date
- the wrong policy version (the one in force at purchase time is what counts)
- an incident overlapping the transaction window

Results appear on a **hypothesis board** with "for" and "against" columns, every item cited, and can flip the recommendation. "Ask Rovo to argue the cardholder's side" opens the agent with a prefilled prompt so it argues the other side in chat, using the same read-only tools.

### 5.5 Systemic view: one incident, many disputes
- Disputes are clustered by shared incident, deploy, refund outage, product or merchant.
- **Blast radius:** affected customers who have not disputed yet go into a proactive refund queue, with "disputes prevented" shown.
- **Dev-side cost:** a linked Jira bug or a comment on the deploy ticket, "this change has cost $X in disputes".
- **Bulk accept** with confirmation, showing fees and analyst hours saved.
- A small evidence graph shows incident → deploy → disputes → customers, enriched from Teamwork Graph where available.
- **Causation needs a link.** A deploy that merely happened near the same time is never reported as a cause.

### 5.6 Defense pack
An exhibit-numbered Confluence page ("Exhibit 1: Proof of delivery…") with footnote citations and a SHA-256 hash of the evidence snapshot, so later edits are detectable.

### 5.7 Dispute watcher (prevention)
When a support ticket mentions "bank", "chargeback", "dispute" or "fraud", Exhibita flags it with the numbers: "Refund now: $49. Lose the dispute: $49 + $15 fee + ratio impact."

### 5.8 Command center
One deliberately small page:
- the queue sorted by deadline and amount
- money at stake
- the top systemic cluster
- a dispute-ratio gauge against network monitoring thresholds
- one "why are we losing?" insight from historical outcomes

### 5.9 Rovo agent and MCP
- One `rovo:agent`, **Exhibita Analyst**, with read-only actions: `getDisputeContext`, `evaluateRubric`, `findRelatedDisputes`, `getContradictions`, `explainDecision`, `queueSummary`.
- Example questions: "Which disputes are due this week and weak?", "Why did you recommend accepting DSP-41?"
- A `rovo:mcp` module exposes the same tools to Claude Code, Cursor and other MCP clients, with an open-source `skill.md`.

## 6. Reason coverage

| Reason (plain English and code) | Depth | Key evidence |
|---|---|---|
| Item not received (Visa 13.1, Mastercard 4853) | Deep | Proof of delivery with carrier and signature, delivery address match, customer acknowledgement |
| Not as described (Visa 13.3, Mastercard 4853) | Deep | Description at purchase, customer messages, return and refund policy version at purchase, refund status |
| Charged twice (Visa 12.6.1) | Deep | Distinct orders, or a refund already issued; otherwise Accept |
| Card-not-present fraud (Visa 10.4, Mastercard 4837) | Deep-lite | 3DS, AVS and CVV results, plus a Visa Compelling Evidence 3.0 eligibility check (2 or more prior undisputed orders 120 to 365 days old with matching IP or device) |
| Cancelled subscription (Visa 13.2) | Stub | Cancellation policy and cancellation records |

- Rubrics are data with unit tests. Adding a reason means adding a rubric, not changing the engine.
- Response windows are configurable per processor, with defaults. The UI says "per your processor agreement".
- Labels are plain English, with the network code in small grey text ("Item not received · Visa 13.1").

## 7. Validation suite

Exhibita ships with 10 validation disputes. The test suite asserts the expected behaviour for each, and an admin can run them in the app and watch them pass.

| # | Case | Expected behaviour |
|---|---|---|
| 1 | Strong case, all evidence present | Fight, Strong |
| 2 | Missing proof of delivery | Flagged, never invented, Submit blocked |
| 3 | Refund initiated but not completed | Partial, the two states distinguished |
| 4 | Approved refund never processed because of an incident | Accept |
| 5 | Customer message contradicts the merchant | Raised by Challenge, coverage drops |
| 6 | Duplicate charge | Detected, Accept |
| 7 | Many disputes from one incident | Clustered |
| 8 | Unrelated deploy around the same time | No causal claim |
| 9 | Policy changed after purchase | Uses the version in force at purchase |
| 10 | Sparse context | Says "insufficient evidence" |

## 8. Demo data

An admin wizard ("Set up demo data") builds a complete, synthetic demo world. It is idempotent, shows progress, and has a matching "Remove demo data" button. The data is generated from a seeded random generator, so the scenarios are not hand-placed.

- **JSM project "Disputes" (DSP):** about 60 disputes across the four deep reasons, about 30 support tickets with realistic and sometimes contradictory customer phrasing, and refund requests.
- **Jira:** incident INC-231 "Refund worker dropped approved refunds", linked to deploy DEP-88, plus an unrelated deploy.
- **Confluence:** "Refund & Returns Policy" with two versions, "Shipping Policy", and a "Dispute playbook".
- **Forge SQL:** orders (delivery, proof of delivery, 3DS, IP and device), customers, merchants, about 120 historical outcomes, and the audit log.
- **Currency:** USD by default.

All data is synthetic. No real merchant, customer or company data is used.

## 9. Design

- Plain-English labels everywhere.
- Atlassian Design System components, with real empty, loading and error states.
- A short first-run tour.
- The hypothesis board and evidence graph live on a full page, not crammed into the issue panel.
- Graceful degradation:
  - Teamwork Graph empty or forbidden: fall back to REST and show a subtle "graph enrichment unavailable" note.
  - Rovo off: hide the chat buttons; the deterministic flow still works.
  - Assets missing: nothing breaks, because the app does not depend on it.

## 10. Out of scope

- Real processor APIs. Intake uses a processor-style webhook with synthetic data.
- Submitting evidence to a processor. Exhibita prepares and gates the defense; sending it stays with the processor portal.
- Win-rate predictions.
- PDF export, CSV import, and large analytics dashboards.
