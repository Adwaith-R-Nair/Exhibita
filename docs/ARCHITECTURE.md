# Architecture

Exhibita is a single Forge app. Its decisions come from deterministic, unit-tested code. Rovo sits on top to explain and challenge those decisions in chat, in Jira Automation, and through MCP.

This page describes what is built as of review round 1 (27 Nov 2026) and marks what is planned. See [SPEC.md](SPEC.md) for behaviour and [DECISIONS.md](DECISIONS.md) for why.

```
 Stripe-compatible signed webhook
          │
          ▼
 ┌──────────────────────┐  queue  ┌────────────────────────────┐
 │ web trigger           │───────▶│ intake consumer             │──▶ JSM Dispute work item (due date = respond-by)
 │ (HMAC-SHA256 check,   │        │ (atomic claim in SQL ledger,│    + record in app storage (authoritative)
 │  5-minute window,     │        │  create work item, keep raw │      mirrored to issue property `exhibita`
 │  fast 202 reply)      │        │  payload, collect evidence) │
 └──────────────────────┘        └────────────────────────────┘
                                         │ one source at a time, Realtime event after each
                                         ▼
 ┌────────────────────────────── deterministic core (src/core) ──────────────────────────────┐
 │ collectors (order, tickets, refunds, settlements, incidents, policies) → rubric evaluation   │
 │   → challenge (contradictions, refund reconciliation) → final verdict → clustering           │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
        │                    │                     │                       │
        ▼                    ▼                     ▼                       ▼
  issue panel         workflow validator     Rovo agent actions       rovo:mcp tools
  (exhibits,          (blocks "Submit to     (GET only, checks the    (same GET tools for
   verdict, flip,      network", fails        user can browse the      external MCP clients)
   collect again)      closed)                work item)
```

## 1. Principles

1. **Deterministic core, AI on top.** Forge backends cannot call a Rovo agent and read its answer. Rovo is involved in exactly three ways: Jira Automation's "Use Rovo agent" step, the user chatting with the agent, and `rovo.open()` from the UI, which opens chat with a prefilled prompt. So every decision lives in tested code.
2. **One source of truth per dispute.** The dispute record and its evidence live in Forge app storage under `record:{issueId}`, which only the app can write (D-11). A mirror in the issue property `exhibita` serves JQL and display, but is never trusted, because anyone who can edit the work item can rewrite it. The panel, the validator and the agent actions read the stored copy and flag a mirror that differs. The merchant's payment records, the dispute ledger and the audit log live in Forge SQL. Configuration and setup state live in Forge KVS.
3. **Agent tools are read-only.** Actions use `actionVerb: GET`, return well under 1 MB and finish in under 15 seconds. Jira Automation only runs GET actions. Anything that changes state is a button with human confirmation.
4. **Long work is split into bounded pieces.** Intake runs on a queue. Evidence is collected one source at a time, the record is saved after each, and a Realtime event tells the open panel to refresh. The setup wizard is driven from the admin's browser one bounded resolver call at a time, with state saved after every create, so a failure resumes where it stopped (D-13). Clustering at scale and pack building are planned as async events.
5. **An unread source is never an empty source.** A record that is still being collected, or where a source failed, is shown as incomplete and cannot be submitted.
6. **Graceful degradation.** No dependency on Teamwork Graph, Rovo or Assets is allowed to break the core flow.
7. **Free tier.** No paid AI. Forge SQL compute on the free tier is small, so inserts are batched `INSERT IGNORE`, queries are lean, and nothing polls in the background.

## 2. Security and trust boundaries

| Boundary | What is enforced |
|---|---|
| Webhook | Stripe-style signature: `t=<unix time>,v1=<HMAC-SHA256 of "t.body">` in `x-exhibita-signature` or `stripe-signature`, made with the webhook secret. Requests outside a five-minute window are refused. The secret never travels with a request (D-16) |
| Duplicate delivery | The consumer claims each dispute id with an atomic insert into the SQL `disputes` ledger before creating anything. A claim left pending by a crash is taken over after ten minutes (D-15) |
| The dispute record | Authoritative copy in app storage; the issue property is a mirror only (D-11) |
| Submit gate | `jira:workflowValidator` passes only when every source has been read and the final verdict, after the challenge, is Fight (D-12). It fails closed if it cannot load or evaluate the record (D-07) |
| Setup page | Every state-changing call requires the caller to hold Administer Jira |
| Agent and MCP actions | GET only; answer only about work items the asking user can open, checked as that user. Customer text is returned as quoted data, never as instructions |
| Demo removal | Deletes only what setup recorded: disputes in the ledger, the demo's rows by id, and the projects and space it created. Never selects by an editable label |

## 3. Module map

| Module | Key | Status | Purpose |
|---|---|---|---|
| `jira:issuePanel` | `exhibita-evidence-panel` | Built | Verdict, one-line reason, coverage score, lettered exhibits with Record and Inference labels, rule text, "Changed from Fight to Accept" with the case against us, Submit-blocked and collection-incomplete banners, "Collect evidence again" |
| `jira:workflowValidator` | `exhibita-submit-validator` | Built | Blocks "Submit to network" until the final verdict allows it. Fails closed |
| `jira:adminPage` | `exhibita-admin` | Built | Disputes project setup, webhook secret, "Set up demo data" with progress, "Check the demo disputes", "Remove demo data", "Run validation suite", platform checks |
| `jira:entityProperty` | `exhibita-dispute-index`, `exhibita-ticket-index` | Built | Index the dispute id and customer, and the ticket customer, for JQL |
| `webtrigger` | `exhibita-dispute-intake` | Built | Receives `charge.dispute.created`, verifies the signature, replies 202 and queues |
| `consumer` | `exhibita-intake-consumer` | Built | Claims the dispute id, creates the work item, collects evidence |
| `trigger` | `exhibita-lifecycle` | Built | Runs the SQL migrations on install and upgrade |
| `rovo:agent` | `exhibita-analyst` | Built, live check pending (S6) | Exhibita Analyst: explains, challenges, argues the cardholder's side |
| `action` (GET) | `get-dispute-context`, `evaluate-rubric` | Built | Two of the six planned actions. Planned: `findRelatedDisputes`, `getContradictions`, `explainDecision`, `queueSummary` |
| `rovo:mcp` | `exhibita-mcp` | Built, live check pending (S9) | The same tools for external MCP clients |
| `sql` | `main` | Built | Payment records, dispute ledger, outcomes, audit log (see section 4) |
| `jira:globalPage` | command center | Planned (M3, M4) | Systemic page with safe bulk accept, refund queue, hypothesis board, evidence graph; queue by deadline, money at stake, ratio gauge, insight |

Forge function keys must be 23 characters or fewer, so handler keys are kept short.

## 4. Data model

**Dispute record** (stored in app storage as `record:{issueId}`, mirrored to the issue property `exhibita`). The hero, after collection, looks like this (abridged):

```json
{
  "schemaVersion": 1,
  "dispute": {
    "externalId": "dp_...", "chargeId": "ch_demo_0001", "orderId": "ORD-10001", "customer": "cus_...",
    "amount": 24900, "currency": "USD", "processorReason": "credit_not_processed",
    "reasonCode": "visa-13.6", "network": "visa", "networkReasonCode": "13.6",
    "respondBy": "...", "receivedAt": "...", "purchasedAt": "..."
  },
  "evidence": [
    {
      "id": "...", "type": "refund", "state": "completed-before-dispute", "kind": "fact",
      "source": { "kind": "sql", "key": "refunds/REF-1001", "title": "Refund REF-1001" }, "at": "...",
      "meta": { "refundId": "REF-1001", "amount": 24900, "linkedIncident": "INC-1", "linkedDeploy": "DEP-1" }
    },
    {
      "id": "...", "type": "processor-refund", "state": "not-settled", "kind": "fact",
      "source": { "kind": "sql", "key": "charges/ch_demo_0001", "title": "Charge ch_demo_0001 at the processor" }, "at": "...",
      "meta": { "refundId": "REF-1001", "amount": 24900, "chargeId": "ch_demo_0001" }
    },
    {
      "id": "...", "type": "incident", "state": "caused-dropped-refund", "kind": "fact",
      "source": { "kind": "jira", "key": "INC-1", "title": "Refund worker marked refunds as sent without sending them", "url": "..." },
      "at": "...", "meta": { "windowStart": "...", "windowEnd": "...", "linkedDeploy": "DEP-1" }
    }
  ],
  "raw": { "...original webhook payload, unchanged..." },
  "collectedAt": "..."
}
```

Money is always an integer count of minor units. `kind: "fact"` is shown as **Record**; `kind: "inference"` is shown as **Inference** and carries the quoted phrase. `collectedAt` stays null until every source has been read. Keys such as INC-1 and DEP-1 are whatever the site assigned.

**Evidence types:** `delivery`, `delivery-signature`, `customer-message`, `refund`, `processor-refund`, `policy`, `product-description`, `order-pair`, `incident`, `deploy`, `3ds`, `avs`, `cvv`, `prior-orders`, `cancellation`. Each type has its own set of states.

**Rubrics are data.** Each requirement is `{ id, label, accepts, concedes?, opposes?, required, rule }`. `accepts` lists the evidence states that satisfy it, `concedes` the states that mean the customer is right, and `opposes` the states that count against it. `required` can depend on the dispute's context, for example the order value.

**SQL tables** (migrations in `src/lib/sql.ts`):

| Table | Holds |
|---|---|
| `audit_log` | Who did what, and when |
| `customers`, `products` | The merchant's customers and catalogue |
| `orders` | Purchase, delivery, 3-D Secure, AVS and CVV results, and payer identity (card fingerprint, network, IP, device, account, shipping address hash, fraud reported) for Compelling Evidence 3.0 |
| `charges` | The processor's view of each charge, including the amount refunded |
| `refunds` | The merchant's refund service: requested, approved, completed, declined |
| `incident_impacts` | Explicit rows tying an incident to the refunds or charges it affected |
| `outcomes` | Historical dispute results, for "why are we losing?" |
| `disputes` | Exhibita's own dispute ledger: one row per processor dispute id, its order, customer and work item key |

## 5. Repository layout

```
manifest.yml
src/
  index.ts          every Forge handler, re-exported
  core/             pure, unit-tested logic: rubrics, collectors, lexicon, challenge, verdict,
                    clustering, intake normalising and signatures, the demo-world generator,
                    the validation suite
  lib/              thin wrappers over Jira, Confluence, SQL, KVS and Realtime, the setup wizard,
                    demo check and removal, permission checks
  intake/           web trigger and queue consumer
  validator/        jira:workflowValidator
  actions/          Rovo and MCP GET actions
  resolvers/        backends for the panel and the setup page
  frontend/         UI Kit panel and setup page
static/prompts/     agent prompt
test/               unit tests and the validation suite
docs/               spec, architecture, decisions, build log, spikes, reviews
```

`src/core` imports nothing from Forge, so it runs and tests in plain Node.

## 6. Platform constraints we design around

| Constraint | What we do |
|---|---|
| A backend cannot call a Rovo agent and get the answer back | Decisions are deterministic; Rovo explains them |
| Jira Automation only runs GET actions | State changes are confirmed buttons |
| No free Forge LLM allowance | Phrase lexicon classifier, labelled Inference |
| Creating an Assets schema is not available to Forge apps | Orders and customers live in Forge SQL |
| Anyone who can edit a work item can rewrite its issue properties | The authoritative record is in app storage (D-11) |
| JQL cannot see an issue property until an entity property module indexes it | `jira:entityProperty` indexes the dispute id; the SQL ledger is the real guard against duplicates |
| Jira assigns issue keys, and a trashed project keeps its key | The story never relies on fixed keys; setup picks the next free project key |
| Jira and Confluence timestamps cannot be backdated | Original message times and incident windows are issue properties; policy effective dates are a page property (D-14) |
| Teamwork Graph curated queries are thin on seeded data, and HTTP 200 can still carry `errors` | REST and JQL are the main path; Teamwork Graph enriches; `errors` is always checked |
| Seeding at install time is fragile, and admin-only REST calls fail when made as the app | A setup-page wizard runs as the admin, step by step and resumable (D-13) |
| Timeouts: resolvers 25 s, actions 55 s, queue consumers up to 900 s | Bounded steps, one source at a time, Realtime progress |
| `rovo:mcp` needs an org admin to turn it on | Covered in the judge quick start |
