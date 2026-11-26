# Review round 1 (26 to 27 Nov 2026)

At the end of M2 the app was reviewed five ways, each without seeing the others' conclusions:

- three independent internal reviews: platform correctness and security, the deterministic core (run against adversarial inputs), and product against the spec and judging criteria;
- two external adversarial reviewers, briefed as a disputes-operations expert, a security reviewer and a hackathon judge.

Findings were checked against the code before being accepted. This page records what was found and what we decided. Progress is tracked in [BUILD_LOG.md](../BUILD_LOG.md).

**Status (27 Nov 2026):** sections A, B and C and the core of D are fixed and verified live (commits `881b67d`, `6b3fb72`, `bd4a0bc`, `c2310b6`; decisions D-15 to D-18). The rest of D (safe bulk accept, proactive refunds, cost bug) is M3 work. The deferred items below remain deferred.

## What everyone agreed on

1. **The hero case was modelled on the wrong reason.** A refund that was promised and never processed is Visa 13.6, "Credit not processed". Delivery and "got it" prove receipt, which defends 13.1, not conformity for 13.3.
2. **Compelling Evidence 3.0 was too loose.** Visa needs two earlier transactions on the same card, 120 to 365 days before the dispute, not reported as fraud, sharing at least two identifying elements, at least one of them IP address or device.
3. **Accepting a dispute can pay the customer twice.** If the stuck "approved" refund is later replayed after the dispute is accepted, the customer gets the money twice. Accepting must cancel the pending refund for that payment.
4. **There was no visible Fight-to-Accept flip.** The hero was conceded by the checklist itself, so the "changed" banner never appeared.
5. **The systemic view, the defense pack and Rovo inside the workflow are the biggest gaps for winning.**

## Fixes, by priority

### A. Safety of the submit gate and the data (do first)
| # | Finding | Decision |
|---|---|---|
| A1 | A partly collected record was judged as complete, so Submit could pass while refunds or incidents were unread or failed. | Block submission and say "collection incomplete" until every source has been read. |
| A2 | Admin resolvers did not check the caller is a site admin. | Require the Administer Jira permission for every state-changing admin call. |
| A3 | Rovo and MCP actions read any work item as the app. | Check the user can browse the work item before answering. |
| A4 | Two simultaneous deliveries of one dispute could create two work items. | Claim each dispute id atomically in a SQL `disputes` table before creating anything. |
| A5 | CE 3.0 read other disputes from untrusted issue-property copies. | Read disputed orders from the app's own `disputes` table. |
| A6 | Static shared-secret webhook. | Verify a Stripe-style HMAC-SHA256 signature over the timestamp and raw body, with a five-minute replay window. |

### B. Decision correctness
| # | Finding | Decision |
|---|---|---|
| B1 | Lexicon read "It has not yet arrived" as receipt and missed common denials. | Fix the clause rule, add denial verbs, treat questions as non-assertive, separate "my refund hasn't arrived" from the goods, add complaint and cancellation phrases. Tests use the reviewers' phrasings. |
| B2 | A "no complaint" inference satisfied a required 13.3 item. | Only a customer with no tickets at all counts as "no complaint on record"; unclassified tickets need review. |
| B3 | Customer-message labels were treated as mutually exclusive. | Each requirement lists what opposes it explicitly. |
| B4 | Tickets were matched per customer, not per order. | Use the ticket's order when known. |
| B5 | A linked incident conceded even after the refund was completed. | Concede only while the refund is still owed; leave repaired cases out of clusters. |
| B6 | Refund amounts were ignored. | A partial amount owed means Investigate; a full credit issued before the dispute is a defense. |
| B7 | Near-simultaneous identical orders read as distinct. | Flag them as a possible duplicate. |
| B8 | CE 3.0 rule (see above). | Implement the full rule and show each criterion. |
| B9 | Card network ignored. | Carry the network; the rubrics are Visa rules and say so; other networks are shown as not supported yet rather than judged by Visa rules. |
| B10 | Missing reason: 13.6 credit not processed. | Add it. |
| B11 | Policy-in-force check depended on optional webhook metadata. | Fall back to the order's purchase date. |
| B12 | Blast radius de-duplicated by customer and summed mixed currencies. | De-duplicate by order; group by currency. |
| B13 | "Fact" overstated what a system record proves. | Label source records as "Record"; inferences stay "Inference". |

### C. Setup and removal robustness
Save wizard state immediately after every create; a lease lock against two tabs; record partial bulk results; poll the workflow-scheme publish across calls; fix the disputes project key at setup time; refuse to write into existing support, incident or deploy projects the wizard did not create. Removal deletes only work items and rows the wizard recorded (by dispute id and demo row ids), never by an editable label, and checks how the Confluence space is removed.

### D. The story (built in M3)
- **Hero becomes a 13.6 case with a real flip.** The refund system says the refund was sent, so the checklist says Fight. Exhibita reconciles the refund ledger against the processor's charge, finds the money never reached the card, traces it to the incident and deploy, and flips to Accept, live, as the refunds source is read.
- **Accepting is safe.** One confirmed action accepts the cluster, cancels the stuck refunds for those payments (no double payment), queues proactive refunds for the customers who have not disputed, and files the cost bug on the deploy.
- **Deadlines** come from the processor's due date and set the Jira due date.

## Considered and deferred
- **Dispute stages and arbitration fees.** Real disputes move through response, pre-arbitration and arbitration, each with its own rules and fees. We will record the stage and warn about arbitration costs, but full stage-aware rubrics are beyond this release.
- **Mastercard and other networks.** Shown as not supported rather than approximated with Visa rules.
- **Upstream data poisoning.** The app trusts the merchant's own systems (tickets, incidents, policies). It flags inconsistencies and keeps an audit trail and an evidence hash, but cannot prove an upstream record was not edited.
- **Prompt injection through customer text.** Agent tools return customer text as quoted data, never as instructions, and the agent decides nothing.
- **Monitoring thresholds** for the command center will be checked against Visa's current program before any gauge is built.
