# Exhibita: working notes for coding agents

Exhibita is a Forge app for Jira Service Management that builds card-chargeback defenses from evidence already in Jira, JSM and Confluence. Read `docs/SPEC.md`, `docs/ARCHITECTURE.md` and `docs/DECISIONS.md` before changing behaviour.

## Invariants (do not break these)
1. **Never show a win percentage.** Report evidence coverage and a Strong, Partial or Weak label only. (D-08)
2. **Decisions are deterministic.** Rubrics, triage, contradictions, classification and clustering live in `src/core`, are pure, and have tests. Rovo explains; it never decides. (D-01)
3. **Agent and MCP tools are GET-only.** Nothing reachable from Rovo or MCP changes state. State changes are UI buttons with confirmation. (D-06)
4. **The workflow validator fails closed.** If it cannot load or evaluate a dispute, it rejects the transition with a clear message. (D-07)
5. **Every evidence item has provenance:** a source (kind, key or id, URL), a timestamp and a state. Initiated and completed are different states.
6. **Inference is labelled.** Anything derived from text classification has `kind: "inference"` and shows an Inference label.
7. **No causal claim without a link.** Temporal overlap alone never makes an incident or deploy the cause of a dispute.
8. **The policy in force at purchase time is the one that counts.**
9. **Synthetic data only.** No real merchant, customer or company data, names or branding. No card-network or processor logos. Say "Stripe-compatible" in text only.
10. **No paid AI.** No external LLM APIs and no Forge `llm` module.
11. **`src/core` imports nothing from `@forge/*`**, so it runs in plain Node tests.
12. **Forge function keys are 23 characters or fewer.**

## Commands
```bash
npm test               # unit tests and validation suite
npm run typecheck      # tsc --noEmit
forge lint             # manifest and permission checks
forge deploy           # deploy to development
forge install --upgrade --site exhibita-demo.atlassian.net --product jira   # after scope changes
forge tunnel           # live reload
```

## Commits
- Subject: `type: plain-English summary`, lowercase type (feat, fix, docs, test, chore, refactor), no scope, ending with a decision ID when one applies, e.g. `(D-07)`.
- Body: why the change was needed, wrapped at about 72 characters. For fixes, say that the new test failed before the change.
- No co-author or tool trailers.
- Record notable progress and surprises in `docs/BUILD_LOG.md`, and new decisions in `docs/DECISIONS.md`.

## Style
- Plain punctuation in prose (no em dashes).
- Plain-English labels in the UI, with network codes in small secondary text.
