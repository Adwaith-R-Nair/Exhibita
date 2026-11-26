# Exhibita

**Every claim, an exhibit.**

Exhibita is a Forge app for Jira Service Management that builds card-chargeback defenses from evidence your team already has in Jira, JSM and Confluence. It cites every claim, blocks submission until the evidence is complete, and tells you when the evidence says to accept a dispute instead of fighting it. When many disputes share one root cause, it traces them to the incident or deploy behind them so the customers who haven't disputed yet can be refunded first.

> Status: in active development for Codegeist 2026 (Apps for Specialized Industries). All data is synthetic.

## Why
A lost dispute costs the sale, a fee, and a mark against your dispute ratio. The evidence that decides it is already in your support tickets, policy pages, refund records and incident reports, but nobody has time to assemble it under deadline, and nobody notices when the evidence says the customer is right.

## The story it tells
A $249 "Credit not processed" dispute arrives. The refund service says refund REF-1001 was sent, so the checklist alone says Fight. As each source is read, Exhibita reconciles the refund service against the processor's charge, finds the money never reached the card, and the verdict changes from Fight to Accept, naming the incident ("Refund worker marked refunds as sent without sending them") and the deploy that caused it. 37 more disputes and 212 customers who have not disputed yet trace to the same incident.

## How it works
- **Deterministic core, AI on top.** Reason-code rubrics, contradiction checks, refund reconciliation, clustering and triage are tested code. The Rovo agent *Exhibita Analyst* explains and challenges those decisions; it never makes them.
- **Every claim has a source.** Evidence is lettered Exhibit A, B, C, with source, timestamp and state, and labelled Record or Inference.
- **The gate is in the workflow.** A workflow validator blocks "Submit to network" until every source has been read and the final verdict is Fight. It fails closed.
- **Visa rules, and it says so.** Disputes on other card networks are shown as not supported yet rather than judged by the wrong rules.
- **Signed intake.** Disputes arrive by a Stripe-compatible webhook signed with HMAC-SHA256, and each dispute id is claimed once.
- **Runs on Atlassian, no paid AI.**

## What exists today
- Webhook intake, the evidence panel with live collection, the Fight, Accept or Investigate verdict, the challenge, and the submit gate.
- Six Visa reasons: 13.1, 13.3, 13.6, 12.6.1, 10.4 (with Compelling Evidence 3.0) and 13.2 (basic).
- A setup page that builds and removes a synthetic demo world, and runs the validation suite.
- The Rovo agent and MCP tools with two read-only actions.

Coming next: the systemic page (cluster, safe bulk accept, proactive refund queue, cost bug on the deploy), the defense pack, Rovo inside the workflow, and the command center. See the [roadmap](docs/ROADMAP.md).

## Judge quick start
The installable release and its install link come later. On a site with Exhibita installed:

1. Go to Jira settings → Apps → **Exhibita setup**.
2. Click **Set up demo data** and keep the page open. It runs 11 steps (projects, the dispute workflow, Confluence policies, incidents and deploys, support tickets, payment records, and 63 disputes sent through the real webhook queue) and can be resumed if it stops.
3. Click **Check the demo disputes** to see every demo dispute reach the recommendation its scenario intends.
4. Click **Run validation suite** to see 10 of 10 pass, and **Run checks** under Platform checks to confirm the site is set up correctly.
5. In the Disputes project, open the $249.00 "Credit not processed" dispute on order ORD-10001 and open the Exhibita evidence panel. Click **Collect evidence again** to watch the verdict change from Fight to Accept as the sources are read.

**Remove demo data** on the same page deletes only what setup created.

## Docs
- [Product spec](docs/SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Decision log](docs/DECISIONS.md)
- [Roadmap](docs/ROADMAP.md)
- [Build log](docs/BUILD_LOG.md)

## License
[MIT](LICENSE)
