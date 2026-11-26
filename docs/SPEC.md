# Exhibita product spec

**Exhibita: every claim, an exhibit.** A Forge app for Jira Service Management that builds a card-chargeback defense from evidence the team already has in Jira, JSM and Confluence. It cites every claim, blocks submission until the evidence is complete, and says when the evidence points to accepting a dispute instead of fighting it. It also traces many disputes back to one incident or deploy, and queues refunds for affected customers before they dispute.

Status: v2.2 of the spec, 27 Nov 2026, after review round 1 ([reviews/round-1.md](reviews/round-1.md)). Decisions that shape it are logged in [DECISIONS.md](DECISIONS.md). Each feature below is marked **Built** (running on the development site) or **Planned** (with its milestone in [ROADMAP.md](ROADMAP.md)).

---

## 1. The problem

A customer tells their bank they never got what they paid for. The merchant now has a fixed window, often 7 to 20 days depending on the processor, to send evidence or lose the money plus a dispute fee. Every lost dispute also counts toward the card networks' dispute-ratio monitoring, and crossing those thresholds brings fines and higher processing costs.

The evidence that wins or loses a dispute is already inside the company, just scattered:

- the customer's own words in support tickets ("got it, thanks", "I want a refund")
- the refund and shipping policy pages, in the version that was live on the purchase date
- refund requests, and whether a refund was only approved, marked as sent, or actually reached the card
- incidents and deploys that broke something for a batch of customers

Analysts copy this into a processor portal by hand, under deadline. They fight disputes they will lose because nobody noticed the refund never went out, and they fight the same root cause thirty times because nobody connected the disputes to the incident behind them.

## 2. Who it is for

- **Primary user:** the dispute analyst working a JSM "Disputes" queue. Every feature is designed from their seat.
- **Buyer:** any company on Atlassian that takes card payments. SaaS subscriptions are the lead example, then e-commerce and marketplaces.
- **Also:** payment aggregators and marketplaces with a dedicated chargeback team pulling disputes from several processors into one queue.

Value line: *Exhibita is for any team on Jira that takes card payments. It wins back the disputes you should win and stops you paying fees to fight the ones you'll lose.*

## 3. The core story

1. A $249 **"Credit not processed"** dispute (Visa 13.6) arrives. The merchant's refund service marked refund REF-1001 as sent before the dispute, so the checklist alone says **Fight**: the credit was processed.
2. Evidence arrives source by source in the panel: order, support tickets, refunds, settlements, incidents, policies. When the settlements source is read, Exhibita reconciles the refund service against the processor's own view of the charge. The processor shows nothing refunded. The money never reached the card.
3. The recommendation changes from **Fight** to **Accept**, and the panel says "Changed from Fight to Accept". The reason names the refund, the charge, the incident "Refund worker marked refunds as sent without sending them" that is explicitly linked to the refund, and the deploy that caused it, with a source for every line. Jira assigns the keys, so on a fresh site they read like INC-1 and DEP-1.
4. **37 more disputes** trace to the same incident: a cluster of 38 disputes totalling **$5,492** ($6,062 once the $15 fee on each is counted). **212 customers who have not disputed yet** are owed **$30,859**.
5. One confirmed action accepts the cluster, **cancels the stuck refunds for those payments** so no customer is paid twice if the refund worker is later replayed, and queues proactive refunds for the 212. The dev team gets a linked bug on the deploy: "This deploy has cost $6,062 in disputes so far."

Steps 1 to 3 are built and verified live on the demo site. The cluster and blast-radius numbers in step 4 are computed by tested core code; the screens and the confirmed action in steps 4 and 5 come in M3.

## 4. Principles

1. **Deterministic core, AI on top.** Rubric evaluation, evidence matching, contradiction checks, clustering and triage are tested code. The Rovo agent explains, challenges and answers questions. It never decides.
2. **Never show a win percentage.** Exhibita reports evidence coverage ("4 of 5 required items met"), not a made-up probability.
3. **Every claim has a source.** Each evidence item carries where it came from, when, and its state. "Refund initiated" and "refund completed" are different states, and what the merchant's refund service says and what the processor shows are different sources.
4. **Records and inferences look different.** An item read from a system is labelled *Record*, because a record shows what a system says, not that it is true. Anything derived by classification (for example, "customer acknowledged receipt") is labelled *Inference* and quotes the phrase it came from.
5. **No causal claim without a link.** An incident or deploy is a cause only through an explicit Jira "Causes" link or a recorded impact row. Happening around the same time is never enough.
6. **Humans confirm anything that changes state.** Accepting disputes, bulk actions, creating the pack and queuing refunds are buttons with confirmation. Agent tools are read-only.
7. **Visa rules, and it says so.** The rubrics are Visa dispute rules. Disputes on other networks are shown as not supported yet rather than judged by the wrong rules (D-18).
8. **Runs on Atlassian, no paid AI.** No external LLM API and no Forge LLM module. Customer-text classification uses a tested phrase lexicon with negation handling.
9. **Degrade gracefully.** If Teamwork Graph, Rovo or Assets is unavailable, the core flow still works and the UI says what is missing.

## 5. Features

### 5.1 Intake (Built)
- A Forge web trigger accepts a dispute webhook in a Stripe-compatible JSON shape. Each request must be signed the way Stripe signs: a header `x-exhibita-signature` (or `stripe-signature`) of `t=<unix time>,v1=<HMAC-SHA256 of "t.body">`, made with the webhook secret from the setup page. Requests more than five minutes old are refused, so a captured request cannot be replayed (D-16). The trigger replies 202 and queues the work.
- The queue consumer first claims the processor's dispute id with an atomic insert into Exhibita's SQL dispute ledger, so a redelivered or concurrent webhook never creates a second work item (D-15). It then creates a JSM **Dispute** work item with the reason (plain English plus code), amount, respond-by date, order and customer. The raw payload is kept unchanged for audit.
- The processor's respond-by date sets the Jira **due date**, so the queue can sort and filter by deadline.
- Evidence is collected straight away, one source at a time, and the open panel updates after each source.
- Planned: a queue view sorted by deadline and amount, and a replay script that fires a "dispute storm" of webhooks for load testing. Until then, "Set up demo data" pushes the 63 demo disputes through the same queue the webhook uses.

### 5.2 Triage: Fight, Accept or Investigate (Built)
- Deterministic triage recommends **Fight**, **Accept** or **Investigate**, with a one-line reason.
  - Evidence that the customer is right on a must-have item (a refund still owed, a refund the processor never received, an incident linked to the problem) means **Accept**.
  - Every required item met, and nothing found against us by the challenge, means **Fight**.
  - Otherwise **Investigate**, listing what is missing. A partial refund still owed, a possible duplicate order and an unsupported card network all land here.
- Planned (M4): an importable Jira Automation rule runs the Exhibita Analyst agent when a dispute is created. The agent reads the case through the GET actions and posts a drafted, cited defense narrative as a comment.

### 5.3 Build defense: the evidence checklist (Built)
- A transparent rubric per reason, with the rule text visible ("why is this required?").
- Evidence items are lettered **Exhibit A, B, C** and show source, timestamp and state, with Record or Inference labels.
- An evidence coverage score, for example "4 of 5 required items met (Strong)".
- **Submit is blocked** until every source has been read and the final verdict, after the challenge, is Fight (D-12). The panel says exactly what is missing, or that collection is incomplete. This is enforced in the workflow itself: a `jira:workflowValidator` on the "Submit to network" transition rejects the move and names what is missing. It fails closed on errors.
- The checklist updates live as each source is read, and "Collect evidence again" re-reads every source.

### 5.4 Challenge this: the evidence red team
A deterministic contradiction engine runs on every evaluation (Built) and looks for:
- a refund the merchant's refund service marked as sent that the processor never received (reconciliation, D-17)
- a refund approved but still owed
- an incident explicitly linked to this dispute's refund or charge
- customer messages that contradict the merchant's claim
- proof-of-delivery name or address mismatch
- evidence created after the dispute date
- the wrong policy version (the one in force at purchase time is what counts)
- an incident that overlaps the purchase but is not linked to it, shown as a note only and never as a cause

Each finding is decisive (the customer is right on this point), weakens the case (a person should look before fighting), or is a note. The challenge can block a submission but never unblock one. When it changes the recommendation, the panel says "Changed from Fight to Accept" (or Investigate) and shows the case against us.

Planned (M3 and M4): a **hypothesis board** on a full page with "for" and "against" columns, every item cited, and "Ask Rovo to argue the cardholder's side", which opens the agent with a prefilled prompt so it argues the other side in chat using the same read-only tools.

### 5.5 Systemic view: one incident, many disputes
- Built in the core and tested: disputes are clustered by the incident explicitly linked to them and the deploy that caused it. A dispute whose refund was later repaired leaves the cluster.
- Built in the core and tested: **blast radius**, the customers affected by the same incident who have not disputed yet, counted by order and totalled per currency.
- Planned (M3), a systemic page with:
  - the cluster, its total and fees, and a small evidence graph (incident → deploy → disputes → customers), enriched from Teamwork Graph where available;
  - **safe bulk accept**: one confirmed action that accepts the cluster and cancels the stuck refunds for those payments, so no customer is paid twice, showing fees and analyst hours saved;
  - a **proactive refund queue** for the customers who have not disputed, with "disputes prevented";
  - **dev-side cost**: a linked Jira bug or a comment on the deploy, "this deploy has cost $X in disputes so far".
- **Causation needs a link.** A deploy that merely happened near the same time is never reported as a cause.

### 5.6 Defense pack (Planned, M4)
An exportable evidence package for the processor portal: an exhibit-numbered Confluence page ("Exhibit 1: Proof of delivery…") with footnote citations and a SHA-256 hash of the evidence snapshot, so later edits are detectable, which the analyst can export and upload.

### 5.7 Dispute watcher (Planned, M4)
When a support ticket mentions "bank", "chargeback", "dispute" or "fraud", Exhibita flags it with the numbers: "Refund now: $49. Lose the dispute: $49 + $15 fee + ratio impact." The demo world already includes such tickets.

### 5.8 Command center (Planned, M4)
One deliberately small page:
- the queue sorted by deadline and amount
- money at stake
- the top systemic cluster
- a dispute-ratio gauge against Visa's current monitoring program, checked before the gauge is built
- one "why are we losing?" insight from historical outcomes

### 5.9 Rovo agent and MCP
- Built: one `rovo:agent`, **Exhibita Analyst**, with two read-only actions, `getDisputeContext` and `evaluateRubric`, and a `rovo:mcp` module that exposes the same tools to external MCP clients. Each action first checks that the asking user can open the work item in Jira. Customer text is returned as quoted data, never as instructions. Live checks of the agent and MCP (spikes S6, S7, S9, S13) are still pending.
- Planned (M4): four more actions (`findRelatedDisputes`, `getContradictions`, `explainDecision`, `queueSummary`), the agent inside the workflow through Jira Automation, and an open-source `skill.md`.
- Example questions: "Which disputes are due this week and weak?", "Why did you recommend accepting this dispute?"

## 6. Reason coverage

| Reason (plain English and code) | Depth | Key evidence |
|---|---|---|
| Item not received (Visa 13.1) | Deep | Proof of delivery to the checkout address, signed proof of delivery above a value threshold, customer acknowledgement, no refund still owed |
| Not as described (Visa 13.3) | Deep | Description matched what was delivered, no complaint raised with the merchant first, no refund still owed, return policy at purchase. Receipt alone is not a 13.3 defense |
| Credit not processed (Visa 13.6) | Deep | The promised refund was paid before the dispute, or none was owed under the policy accepted at checkout. The refund service's record is checked against the processor's charge |
| Charged twice (Visa 12.6.1) | Deep | Distinct orders, or the duplicate already refunded; near-simultaneous identical orders go to a person; no linked incident that caused duplicate charges |
| Card-not-present fraud (Visa 10.4) | Deep-lite | 3-D Secure, or Visa Compelling Evidence 3.0; AVS and CVV results as support |
| Cancelled subscription (Visa 13.2) | Stub | Cancellation records and the cancellation terms accepted |

- **Compelling Evidence 3.0** is checked to Visa's full rule: at least two earlier transactions on the same card, each 120 to 365 days before the dispute, never disputed or reported as fraud, and each sharing at least two of IP address, device, account and shipping address with the disputed order, at least one of them IP address or device. The panel shows each criterion, so a near miss reads as a candidate rather than a qualified case.
- **Refunds:** a full refund issued before the dispute is a defense for 13.1, 13.3 and 13.6. A partial amount still owed means Investigate.
- **Card networks:** these are Visa rules. A dispute on a Mastercard, American Express or Discover card is shown as not supported yet and left for review by hand. Mastercard reason codes are recognised so the dispute is identified, not judged. A dispute whose network is unknown is judged by Visa rules with a note to check the network.
- Rubrics are data with unit tests. Adding a reason means adding a rubric, not changing the engine.
- Deadlines come from the processor's respond-by date, which sets the Jira due date.
- Labels are plain English, with the network code in small grey text ("Item not received · Visa 13.1").

## 7. Validation suite (Built)

Exhibita ships with 10 validation disputes. The test suite asserts the expected behaviour for each, and an admin can run them from the setup page and watch them pass (10 of 10 live).

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

## 8. Demo data (Built)

An admin wizard ("Set up demo data") builds a complete, synthetic demo world from a seeded random generator (seed 20261126), so the scenarios are not hand-placed. The story numbers and dollar totals come out the same for every seed tested.

- **Disputes service project (default key DSP):** 63 disputes. 40 should be accepted, 12 fought and 11 investigated, across the six Visa reasons, plus one Mastercard dispute that is shown as not supported. 38 of them form the refund-incident cluster, and 36 of those show the Fight to Accept flip.
- **Customer support service project (SUP):** 27 support tickets with realistic and sometimes contradictory customer phrasing, including customers chasing refunds that never arrived and customers mentioning their bank.
- **Incidents and Deploys software projects (INC, DEP):** three incidents, each linked to the deploy that caused it by a Jira "Causes" link. The refund-worker incident and the duplicate-charge incident are tied to the refunds and charges they affected by SQL impact rows. The third, slow checkout pages, overlaps some purchases in time but affected no payments, so it is deliberately never reported as a cause.
- **Confluence space (EXHPOL):** "Refund & Returns Policy" in two versions, "Shipping Policy" and "Cancellation Policy". Effective dates are stored in a page property, because Confluence version times cannot be backdated (D-14).
- **Forge SQL:** customers, products, orders with payer identity (card fingerprint, network, IP, device, account, shipping address), charges with the processor's amount refunded, the merchant's refund records, incident impacts, 120 historical outcomes, the audit log, and the dispute ledger.
- **Currency:** USD.

How setup and removal behave:
- The wizard runs 11 resumable find-or-create steps from the admin's browser, one bounded call at a time, with progress shown and state saved after every create (D-13). A lease stops two tabs running it at once.
- Jira assigns every key. If projects from an earlier demo are still in the Jira trash, they keep their keys, so setup picks the next free key (for example SUP2). Setup never writes into an existing project it did not create.
- The 63 disputes go through the real webhook queue, so the demo exercises the intake path.
- **"Check the demo disputes"** evaluates every demo dispute from live sources and compares each verdict with what the scenario intends.
- **"Remove demo data"** deletes only what setup recorded: the disputes in the ledger, the demo's own rows by id, and the projects and space it created, which go to the trash.

All data is synthetic. No real merchant, customer or company data is used.

## 9. Design

- Plain-English labels everywhere.
- Atlassian Design System components, with real empty, loading and error states.
- A short first-run tour (planned).
- The hypothesis board and evidence graph live on a full page, not crammed into the issue panel.
- Graceful degradation:
  - Teamwork Graph empty or forbidden: fall back to REST and show a subtle "graph enrichment unavailable" note.
  - Rovo off: hide the chat buttons; the deterministic flow still works.
  - Assets missing: nothing breaks, because the app does not depend on it.

## 10. Out of scope for this release

- Real processor APIs. Intake uses a processor-style signed webhook with synthetic data.
- Submitting evidence to a processor. Exhibita prepares and gates the defense; sending it stays with the processor portal.
- Win-rate predictions.
- **Dispute stages.** Real disputes move through response, pre-arbitration and arbitration, each with its own rules and fees. The stage may be recorded with a warning about arbitration costs, but stage-aware rubrics are deferred.
- **Mastercard and other networks.** Shown as not supported rather than approximated with Visa rules.
- Proving that an upstream record (a ticket, incident or policy) was never edited. Exhibita flags inconsistencies and keeps an audit trail and an evidence hash.
- CSV import and large analytics dashboards.
