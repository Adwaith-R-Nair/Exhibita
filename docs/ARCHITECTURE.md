# Architecture

Exhibita is a single Forge app. Its decisions come from deterministic, unit-tested code. Rovo sits on top to explain and challenge those decisions in chat, in Jira Automation, and through MCP.

```
 processor-style webhook
          │
          ▼
 ┌─────────────────┐   queue    ┌──────────────────┐
 │ webtrigger       │──────────▶│ intake consumer   │──▶ JSM Dispute work item
 │ (secret check,   │           │ (create issue,    │    + stored record (app storage)
 │                  │           │                   │      mirrored to issue property
 │  fast 202 reply) │           │  keep raw payload)│
 └─────────────────┘           └──────────────────┘
                                         │
                                         ▼
 ┌────────────────────────────── deterministic core (src/core) ─────────────────────────────┐
 │ evidence collectors → rubric evaluation → contradiction engine → triage → clustering      │
 │   (Jira, JSM, Confluence, Forge SQL, Teamwork Graph where available)                       │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
        │                    │                     │                       │
        ▼                    ▼                     ▼                       ▼
  issue panel         workflow validator     Rovo agent actions       rovo:mcp tools
  (exhibits,          (blocks "Submit to     (GET only: explain,      (same GET tools for
   verdict, buttons)   network", fails        challenge, summarise)    Claude Code, Cursor)
                       closed)
```

## 1. Principles

1. **Deterministic core, AI on top.** Forge backends cannot call a Rovo agent and read its answer. Rovo is involved in exactly three ways: Jira Automation's "Use Rovo agent" step, the user chatting with the agent, and `rovo.open()` from the UI, which opens chat with a prefilled prompt. So every decision lives in tested code.
2. **One source of truth per dispute.** The dispute record and its evidence live in Forge app storage under `record:{issueId}`, which only the app can write (D-11). A mirror in the issue property `exhibita` serves JQL and display, but is never trusted alone, because anyone who can edit the work item can rewrite it. The panel, the validator, the agent actions and the MCP tools all read the stored copy and flag a mirror that differs. Orders, customers, outcomes and the audit log live in Forge SQL. Configuration lives in Forge KVS.
3. **Agent tools are read-only.** Actions use `actionVerb: GET`, return well under 1 MB and finish in under 15 seconds. Jira Automation only runs GET actions. Anything that changes state is a panel button with human confirmation.
4. **Long work runs on queues.** Seeding, clustering and pack building run as async events (up to 900 s). Progress streams to the UI over Forge Realtime, and checkpoints are saved so a page reload recovers.
5. **Graceful degradation.** No dependency on Teamwork Graph, Rovo or Assets is allowed to break the core flow.
6. **Free tier.** No paid AI. Forge SQL compute on the free tier is small, so inserts are batched, queries are lean, and nothing polls.

## 2. Module map

| Module | Key | Purpose |
|---|---|---|
| `jira:issuePanel` | `exhibita-evidence-panel` | Verdict, one-line reason, coverage score, lettered exhibits with Fact and Inference labels, rule tooltips, Submit-blocked banner, Challenge, Ask Rovo |
| `jira:workflowValidator` | `exhibita-submit-validator` | Blocks "Submit to network" until the rubric passes. Fails closed |
| `jira:adminPage` | `exhibita-admin` | Setup, demo-data wizard with progress, remove demo data, run validation suite, platform checks |
| `jira:globalPage` | `exhibita-command-center` | Queue by deadline and amount, money at stake, top cluster, ratio gauge, insight, hypothesis board, evidence graph |
| `webtrigger` | `exhibita-dispute-intake` | Receives `charge.dispute.created`, checks `x-exhibita-secret`, replies 202 and queues |
| `consumer` | `exhibita-intake` and others | Creates the dispute work item; also runs seeding and clustering jobs |
| `rovo:agent` | `exhibita-analyst` | Exhibita Analyst: explains, challenges, argues the cardholder's side |
| `action` (GET) | six actions | `getDisputeContext`, `evaluateRubric`, `findRelatedDisputes`, `getContradictions`, `explainDecision`, `queueSummary` |
| `rovo:mcp` | `exhibita-mcp` | The same tools for external MCP clients |
| `sql` | `main` | Orders, customers, merchants, outcomes, audit log, jobs |

Forge function keys must be 23 characters or fewer, so handler keys are kept short.

## 3. Data model

**Dispute record** (stored in app storage as `record:{issueId}`, mirrored to the issue property `exhibita`):

```json
{
  "dispute": {
    "externalId": "dp_123", "chargeId": "ch_1", "orderId": "ORD-77", "customer": "cus_9",
    "amount": 249, "currency": "USD", "processorReason": "product_unacceptable",
    "reasonCode": "visa-13.3", "respondBy": "2026-12-04T00:00:00Z", "receivedAt": "..."
  },
  "evidence": [
    {
      "id": "ev1", "type": "refund", "state": "approved-not-completed", "kind": "fact",
      "source": { "kind": "jira", "key": "INC-231", "url": "..." }, "at": "...", "note": "..."
    }
  ],
  "raw": { "...original webhook payload, unchanged..." }
}
```

**Evidence types:** `delivery`, `delivery-signature`, `customer-message`, `refund`, `policy`, `product-description`, `order-pair`, `incident`, `3ds`, `avs`, `prior-orders`. Each type has its own set of states.

**Rubrics are data.** Each requirement is `{ id, label, evidenceType, acceptedStates, required, ruleText }`, where `required` can depend on the dispute's context.

**SQL tables:** `orders`, `customers`, `merchants`, `outcomes`, `audit_log`, `jobs`.

## 4. Repository layout

```
manifest.yml
src/
  index.ts          every Forge handler, re-exported
  core/             pure, unit-tested logic: rubrics, triage, contradictions, classifier, clustering
  lib/              thin wrappers over Jira, Confluence, SQL, KVS and Realtime
  intake/           web trigger and queue consumer
  validator/        jira:workflowValidator
  actions/          Rovo and MCP GET actions
  resolvers/        backends for the panel, admin page and command center
  seed/             seeded demo-data generator and wizard jobs
  frontend/         UI
static/prompts/     agent prompt
test/               unit tests and the validation suite
docs/               spec, architecture, decisions, build log, judge quick start
```

`src/core` imports nothing from Forge, so it runs and tests in plain Node.

## 5. Platform constraints we design around

| Constraint | What we do |
|---|---|
| A backend cannot call a Rovo agent and get the answer back | Decisions are deterministic; Rovo explains them |
| Jira Automation only runs GET actions | State changes are confirmed buttons |
| No free Forge LLM allowance | Phrase lexicon classifier, labelled Inference |
| Creating an Assets schema is not available to Forge apps | Orders and customers live in Forge SQL |
| Teamwork Graph curated queries are thin on seeded data, and HTTP 200 can still carry `errors` | REST and JQL are the main path; Teamwork Graph enriches; `errors` is always checked |
| Seeding at install time is fragile, and admin-only REST calls fail when made as the app | An admin-page wizard runs as the admin user, idempotently |
| Timeouts: resolvers 25 s, actions 55 s, async events 900 s | Long work goes on queues with Realtime progress |
| `rovo:mcp` needs an org admin to turn it on | Covered in the judge quick start |
