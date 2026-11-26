# Exhibita

**Every claim, an exhibit.**

Exhibita is a Forge app for Jira Service Management that builds card-chargeback defenses from evidence your team already has in Jira, JSM and Confluence. It cites every claim, blocks submission until the evidence is complete, and tells you when the evidence says to accept a dispute instead of fighting it. When many disputes share one root cause, it traces them to the incident or deploy behind them and queues refunds for the customers who haven't disputed yet.

> Status: in active development for Codegeist 2026 (Apps for Specialized Industries). All data is synthetic.

## Why
A lost dispute costs the sale, a fee, and a mark against your dispute ratio. The evidence that decides it is already in your support tickets, policy pages, refund requests and incident reports, but nobody has time to assemble it under deadline, and nobody notices when the evidence says the customer is right.

## How it works
- **Deterministic core, AI on top.** Reason-code rubrics, contradiction checks, clustering and triage are tested code. The Rovo agent *Exhibita Analyst* explains and challenges those decisions; it never makes them.
- **Every claim has a source.** Evidence is lettered Exhibit A, B, C, with source, timestamp and state, and labelled Fact or Inference.
- **The gate is in the workflow.** A workflow validator blocks "Submit to network" until the required evidence is there.
- **Runs on Atlassian, no paid AI.**

## Docs
- [Product spec](docs/SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Decision log](docs/DECISIONS.md)
- [Roadmap](docs/ROADMAP.md)
- [Build log](docs/BUILD_LOG.md)

## Judge quick start
Coming with the first installable release.

## License
[MIT](LICENSE)
