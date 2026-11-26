# Roadmap

Target: feature freeze **15 Dec 2026**, submission **21 Dec 2026**. Each milestone ends with a working demo and a review pass (D-10).

| # | Dates | Milestone | Done when |
|---|---|---|---|
| M0 | 26–28 Nov | **Foundations and platform spikes.** TypeScript skeleton, first deploy and install, the twelve spikes in [SPIKES.md](SPIKES.md) | Every spike has a recorded result and the plan is adjusted |
| M1 | 29 Nov – 2 Dec | **Thin end-to-end slice.** Webhook → queue → DSP work item → rubric for one reason → verdict in the issue panel → validator blocks Submit | A curl'd webhook produces a dispute with a verdict, and Submit is blocked |
| M2 | 3–7 Dec | **The plot twist, end to end.** Seed wizard (idempotent, progress, remove), SQL schema, evidence collectors with provenance, four deep rubrics, lexicon classifier, contradiction engine, Fight to Accept flip, validation suite 10/10 | The $249 case flips to Accept with cited sources on a freshly seeded site |
| M3 | 8–11 Dec | **Systemic view.** Clustering, blast radius, bulk accept with confirmation, refund queue, dev-side cost bug, hypothesis board, evidence graph | 37 disputes and 212 customers trace to INC-231, and the cost bug is filed |
| M4 | 12–14 Dec | **Rovo and outputs.** Agent with six GET actions, Automation rule, `rovo:mcp` and `skill.md`, defense pack page with hash, dispute watcher, command center | The agent answers with citations, and Claude Code calls an MCP tool |
| — | **15 Dec** | **Feature freeze** | |
| M5 | 16–18 Dec | **Hardening.** Fresh-site install via the install link, onboarding, empty and error states, README, judge quick start, architecture diagram, privacy and terms | Someone new can install it and see the demo with only the quick start |
| M6 | 19–21 Dec | **Video and submission** | Submitted |
