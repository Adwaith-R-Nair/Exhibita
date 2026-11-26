# Build log

This is the engineering log for Exhibita, a Forge app for Jira Service Management that builds card-chargeback defenses from evidence already in Jira, JSM and Confluence. It records what was built, what broke, how it was found and how it was fixed, in enough detail that the whole workflow can be followed later.

**How to read it.**
- "At a glance" lists every bug, breakage and blocker so far in one table, then the milestones reached.
- The chronology that follows is newest first. Each entry is split into Built, Broke, Fixed, Blocked and Learned where those apply.
- Short hashes such as `efbf8a7` are commits in this repository. Decision IDs such as D-11 point to [DECISIONS.md](DECISIONS.md); spike IDs such as S8 point to [SPIKES.md](SPIKES.md); milestones such as M2 point to [ROADMAP.md](ROADMAP.md).
- All data is synthetic. Work item keys (DSP-47, INC-1, REF-1001) are the ones the development site assigned.
- Git records every commit so far with the date 26 Nov 2026. Entries marked "overnight" ran past midnight into 27 Nov.

---

## At a glance

### Bugs, breakages and blockers

| # | What broke | Root cause | Fix | Commit(s) | How it was found |
|---|---|---|---|---|---|
| 1 | First `forge deploy` failed: "TypeScript emitted no output" | ts-loader emits nothing when `tsconfig.json` sets `noEmit` | Removed `noEmit` from tsconfig; the `typecheck` script still passes `--noEmit` | `887731d` | Live deploy |
| 2 | Second deploy failed: "Can't resolve './intake/consumer.js'" | Forge's webpack config does not map `.js` import paths to `.ts` files | Relative imports made extensionless | `887731d` | Live deploy |
| 3 | Setup page stuck on a loading skeleton; "Failed to open iframe bridge: Handshake timeout" | The local DNS resolver answered `REFUSED` for Forge's CDN hosts (`*.cdn.prod.atlassian-dev.net`) | Machine and browser switched to public DNS (environment fix, no code change) | recorded in `db6cd7c` | Live run |
| 4 | Platform check failed: disputes project DSP missing | No project had been created yet | Setup page can create the disputes project | `99a49de` | Live platform check |
| 5 | Teamwork Graph rejected the check query: "You must set an operation name of the shape [company]_[operation]" | The API requires named operations | Query named `exhibita_platformCheck` | `99a49de` | Live platform check |
| 6 | Disputes were created as Epics | Intake took the first work type the project listed | `chooseWorkType` skips epics and subtasks and prefers Dispute, Service request or Task (5 tests) | `54cbca9` | Live run |
| 7 | A redelivered webhook created a duplicate work item | JQL cannot search an issue property until a `jira:entityProperty` module indexes it | Indexed the dispute id, plus a KVS read-your-writes marker checked before JQL | `54cbca9` | Live run |
| 8 | Issue panel missing on work items (first cause) | The admin was not in the project's agent role; JSM hides app panels from non-agents | Setup adds the admin to Administrators and Service Desk Team | `99a49de` | Live run |
| 9 | Issue panel still missing (second cause) | The REST-created service project was a shell (Epic and Story only, no service desk), from template `simplified-general-service-desk` | Deleted with the site owner's approval and recreated from Jira's UI; later, the correct REST template key was found | `49cc631`, `1e1a595`, `d2f9d29` | Live run |
| 10 | A resent dispute was skipped and never came back | A stale KVS intake marker pointed at a work item that had been deleted | Consumer checks that the recorded work item still exists before trusting the marker | `8cf4549` | Live run |
| 11 | `workflows/create` rejected the payload: "The reference new is not a UUID" | Status references in the request must be UUIDs | Status references sent as UUIDs | recorded in `5d75d7e` | Live REST call |
| 12 | Publishing the workflow scheme draft failed: "missing the mappings required for statuses with IDs 1,3,4,5,6" | Jira demands status mappings even when no work items of the type exist | Status mappings supplied on publish | recorded in `5d75d7e` | Live REST call |
| 13 | The submit gate could be passed with hand-typed evidence | Issue properties are writable by anyone who can edit the work item | Authoritative record moved to Forge app storage; issue property is only a mirror (D-11) | `efbf8a7`, `caaf650` | Live test of the gate (S8) |
| 14 | Confluence calls failed for the app | The app had no Confluence scopes and was not installed in Confluence | Added scopes (major version 3.0.0), approved the major version rule, upgraded installs | `1e1a595` | Live spike (S12) |
| 15 | Policy effective dates could not come from Confluence versions | Confluence version timestamps are always the time of writing | Effective dates stored in a page property (D-14) | `d2f9d29` | Live spike (S12) |
| 16 | The story's planned keys (INC-231, DEP-88) could not be created | Jira assigns issue keys; they cannot be chosen | Story uses site-assigned keys such as INC-1 and DEP-n (D-14) | `d2f9d29` | Live spike |
| 17 | TypeScript compile error in the setup library | `asApp()` and `asUser()` requester types differ | Wrappers narrowed to a `requestJira`-only type | `40753a9` | Typecheck |
| 18 | Five mismatches between the live evidence fetcher and the reference observer (see M2 entry) | Window anchored on the wrong charge, unsorted lists, a comment header leaking into classified text, links via the first ticket only, wrong ticket key on refunds | Each fixed before going live; ticket header stripping is round-trip tested | `5592f92` | Comparing fetcher with reference observer |
| 19 | "Remove demo data" would have cleaned only the first 20 stored records before trashing the project | A single page of app storage was read | Paged sweep of app storage | `40753a9` | Reading the code before running it |
| 20 | `forge logs` showed too little to count results | It prints 20 lines by default | Counts checked with JQL, later with `--limit` | none | Live run |
| 21 | Explanations read wrongly: a conceded non-refund item said "Evidence cancelled before the charge"; a check with only evidence against us was called a conflict; a dropped-refund incident was titled "charge problem"; policy exhibits showed a page id | Explanation text did not distinguish these cases | Tests written first, then the wording fixed | `c5bb4ec` | Reading the panel's explanations |
| 22 | An unread source would have looked empty (an unread refunds table becomes "no refund owed") | Collectors could not tell "not read yet" from "read and empty" | Collectors take a list of pending sources and emit nothing from them | `a6727b9` | Design review before shipping |
| 23 | `app.rovo` metadata required for `rovo:mcp` from 5 Jan 2027 is rejected by `@forge/manifest` 13.9.1 | Schema lags the documentation | **Open.** Left out with a comment; re-check before submission | `b52e221`, `a698c2d` | Documentation check |
| 24 | New apps need a Developer Space, which the CLI cannot create | Platform limitation | Created once in the developer console | `1fb3d02` | Documentation check |
| 25 | Review round 1 findings (see that entry) | Various | Fixed, except items deliberately deferred (dispute stages, other networks) | `5a97064`, `5783af0`, `8d7605d`, `1e9f426` | Internal and external review |
| 26 | `Causes` links were stored backwards: INC-1 read "causes DEP-1", and support tickets appeared to cause the incident | Jira's issue-link create call reads opposite to its field names (the `inwardIssue` performs the outward verb) | Links written with the cause as `inwardIssue`; readers follow only "is caused by" | `5783af0` | Reading a live incident's links while fixing review items |
| 27 | Setting up demo data again after removing it failed: "Project 'Customer support' uses this project key" | Projects in the Jira trash keep their keys and names | Setup picks the next free key (SUP2, INC2, DEP2) and records its choice | `1e9f426` | Live run (remove, then set up again) |
| 28 | The demo made before the review could not be removed by the new removal code | It predated the dispute ledger and was generated by an older generator | A narrow legacy path: deletes only work items that carry the demo label and whose app-stored record names a demo dispute id | `1e9f426` | Live run |

### Milestones reached

| Milestone | Reached | Evidence |
|---|---|---|
| Docs-first repo: spec, architecture, D-01 to D-10, invariants, roadmap | 26 Nov | `0ebcdce`, `bf9861c`, `8901e92` |
| 15 platform facts checked against the Forge docs | 26 Nov | `0ed1847`, SPIKES part 1 |
| Deterministic core: rubrics for five reasons, normaliser, lexicon, 66 tests | 26 Nov | `7022e40` to `7a506ff` |
| First deploy and install on the development site | 26 Nov (evening) | `1fb3d02`, `887731d` |
| M1 slice live: webhook to work item to panel | 26 Nov (evening) | S4, S5 |
| Submit gate live on the dispute workflow, then hardened (D-11) | 26 Nov (night) | S8, `efbf8a7` |
| Demo world built on the site by the 11-step wizard: 60 disputes, 29 tickets, 3 incidents, 3 deploys | overnight | `40753a9` |
| Hero dispute (DSP-47) shows Accept with cited sources | overnight | `5592f92` |
| 60 of 60 demo disputes reach their intended recommendation live; validation suite 10/10 live | overnight | `fee1af5` |
| Live evidence arrival in the panel (S10) | overnight | `a6727b9` |
| Live spikes: 9 of 13 pass (S1 to S5, S8, S10 to S12); S6, S7, S9, S13 pending | overnight | SPIKES part 2 |
| 224 unit and validation tests passing | overnight (`a6727b9`) | `npm test` |
| Review round 1 fixed and verified live: 63 of 63 demo disputes as intended, validation 10/10, all 8 platform checks, the hero flips Fight to Accept, signed webhooks enforced | 27 Nov | `5a97064` to `1e9f426` |
| 364 unit and validation tests passing | 27 Nov | `npm test` |

---

## M3: the systemic view (27 Nov 2026)

### Built
- **The Exhibita page** (`jira:globalPage`): disputes grouped under the incident an explicit link names as the cause, with the blast radius (disputes and their cost with fees, customers affected who have not disputed and what they are owed, analyst time) and a "why we lose disputes" card from closed outcomes (counts only, never a prediction). `b06a960`, `94961b6`
- **Three confirmed actions, planned in tested core code first** (`217a71d`):
  - Accept the cluster: each dispute is accepted as the user with a comment, and its stuck refund is cancelled only after the chargeback is accepted, so no customer can be paid twice when the refund worker is replayed. A half-finished step is repaired on the next call.
  - Queue proactive refunds for the customers who have not disputed, in a new `refund_queue` table with one tracking work item. Exhibita never moves money.
  - File the cost bug on the deploy, linked to it and to the incident.
- The dispute panel links to the page when an incident is linked as the cause.
- Removal now deletes demo projects outright instead of trashing them, so their keys stay free for the next set-up (`74b6659`).

### Broke, and how it was found
- **My own ordering mistake, caught before running:** the first draft cancelled the stuck refund before accepting the dispute. If the transition then failed, the customer would be owed nothing while the dispute stayed open. Reversed: accept first, then cancel, with a repair pass on each call.
- **Atlassian site maintenance** (found live): mid-removal and mid-setup, Jira answered 403 "Tenant is restricted: migration". A permission check reported this as a refusal and stopped the removal; setup showed the raw error. Checks now retry temporary answers and setup explains the maintenance (`3b36141`). Both runs resumed without losing work, which is what the resumable design was for.
- Opening the panel once failed with Jira's generic "We couldn't perform the action"; a retry opened it. Platform-side, not reproduced.
- **Stale cluster state after a rebuild** (found live): the page showed the previous demo's refunds as queued and its cost bug as filed, because actions were stored under the incident key and the rebuilt INC-1 reused it; titles were also missing because the search index had not caught up with the new issues. Actions are now stored under the incident's issue id, which is never reused, and titles are read directly (`6f86c7b`).

### Verified live
- The demo was rebuilt through intermittent "Tenant is restricted" refusals by resuming several times: exactly 27 tickets, no duplicate comments, 63 disputes, clean keys, and 63 of 63 as intended. The hero's panel links to the page.
- The page traced INC-1 ("Refund worker marked refunds as sent without sending them") to DEP-1: 38 disputes, $5,492.00 disputed, $6,062.00 with fees, 212 customers not yet disputed owed $30,859.00, about 15.8 analyst hours.
- Accept: all 38 disputes moved to Accepted with the explanation comment; collecting the hero's evidence again showed REF-1001 as "cancelled because the accepted chargeback settles it".
- Queue: 212 refunds queued with tracking item SUP-28 linked to INC-1.
- Cost bug: DEP-4 "DEP-1 has cost $6,062.00 in disputes so far", linked to DEP-1 and INC-1.

---

## Housekeeping and a clean rebuild (27 Nov 2026)

### Done
- **Repository history tidied.** With the owner's approval, two commit messages were reworded and the working-notes file was renamed to `AGENTS.md` in every commit, then the history was force-pushed. Code, authors and dates are unchanged; every commit hash after the second commit changed, and the hashes cited in this log were remapped to match.
- **Clean project keys again.** Projects in the Jira trash keep their keys, so the demo had been running on SUP2, INC2 and DEP2. The three old demo projects (synthetic data only) were permanently deleted from the trash with the owner's approval; the demo was then removed and set up again.

### Verified live
- The new ledger-based removal ran for the first time on a ledger-era demo: "Removed SUP2, INC2, DEP2, space EXHPOL and the demo records".
- A fresh setup created SUP, INC and DEP again. INC-1 now reads "is caused by DEP-1" and "causes SUP-5", confirming the link-direction fix (row 26).
- 63 of 63 demo disputes reach their intended recommendation. The hero is DSP-155.

---

## Review round 1 fixes (27 Nov 2026)

### Built
- **A real flip for the hero (D-17).** The hero is now a $249 Visa 13.6 "credit not processed" dispute. The merchant's refund service marked REF-1001 as sent, so the checklist alone says Fight. A new source, the processor's view of refunds (the charge's amount refunded), is read after the refund records; when the two disagree the challenge raises a decisive finding naming the incident and the deploy, and the panel shows "Changed from Fight to Accept". 36 demo disputes show this flip.
- **A dispute ledger (D-15).** Intake claims each dispute id with an atomic SQL insert before creating anything; the ledger also answers which orders were disputed and which work items the demo created.
- **Signed webhooks (D-16).** Stripe-style HMAC-SHA256 signatures with a five-minute window replace the shared-secret header.
- **Visa rules, labelled (D-18).** Card network is read from the processor event; non-Visa disputes are marked not supported instead of judged by Visa rules. Visa 13.6 added; Compelling Evidence 3.0 implemented to Visa's full rule with each criterion shown.
- Due dates from the processor's respond-by date; "Record" instead of "Fact" for system records.

### Broke, and how it was found
- Reading INC-1's links live while fixing the review items showed every `Causes` link stored backwards (at-a-glance row 26).
- Removing the demo and setting it up again failed because trashed projects keep their keys (row 27).
- The old demo could not be removed by the new removal code (row 28).

### Fixed
Every review item below except the two deliberately deferred. Core decision fixes in `5a97064` (each with a failing test first), the gate, permission and intake fixes in `5783af0`, signed webhooks in `8d7605d`, setup and removal in `1e9f426`.

### Verified live
- Remove demo data (legacy path) cleared the earlier demo; a fresh setup ran all 11 steps, choosing SUP2, INC2 and DEP2 because the earlier projects are in the trash.
- "Check the demo disputes": 63 of 63 reach their intended recommendation. Validation suite 10 of 10. All 8 platform checks pass, including the three new migrations.
- DSP-90 (the hero) shows Accept with "Changed from Fight to Accept", citing REF-1001, the charge, INC2-1 and DEP2-1; due date set.
- Webhook: unsigned requests, the old secret header, and a mismatched signature are refused; a signed request is queued.

---

## Review round 1 (26 Nov 2026): findings

### What happened
With M2 working live, the build paused for review before widening further. Five reviews ran:
- Three independent internal reviews, each with a narrow brief: platform correctness and security, core logic, and product against the spec.
- Adversarial reviews by two external reviewers, asked to attack the product's claims and the dispute logic.

Each finding was verified by reading or running the code before being listed. The triage and decisions are in [reviews/round-1.md](reviews/round-1.md). **All are fixed** (see "Review round 1 fixes" above) **except** dispute stages and arbitration fees, and networks other than Visa, which are deliberately deferred (D-18).

### Critical
1. **A partly collected record is evaluated as complete.** Collection saves the record after each source with `collectedAt` still null, but evaluation does not check for that. The submit check could pass while later sources (refunds, incidents) are unread or have failed. This is the same class of risk that `a6727b9` closed for collectors, one layer up.
2. **The lexicon misreads denials of receipt.** "It has not yet arrived" was read as acknowledged receipt, and common denials ("never delivered", "did not arrive", "still haven't gotten it") were missed.
3. **A "no complaint" inference could satisfy a required item for 13.3 (not as described).** A complaint the lexicon missed therefore became a Fight.

### Important: platform and security
- Admin resolvers do not check that the caller is a site admin.
- Agent and MCP actions read any work item as the app without checking the user's browse permission. They also need a prompt-injection boundary around customer text.
- Compelling Evidence 3.0 prior orders were read from the issue-property copies of other disputes, which are untrusted (the same hole D-11 closed for the dispute's own record).
- Two simultaneous deliveries of one dispute could create two work items: there is no atomic claim on the dispute id.
- The webhook uses a static shared secret. It should move to HMAC signature verification with a replay window.

### Important: setup and removal
- Wizard resume after a timeout or a partial bulk create can duplicate tickets and comments and lose track of created projects. There is no lock.
- "Remove demo data" could permanently delete any work item carrying the demo label, and empties whole SQL tables instead of only demo rows.
- Removal reads the disputes project key from current config rather than the key recorded at setup time.
- The workflow step could exceed the resolver time limit while polling the scheme publish.

### Important: dispute logic
- **The hero has no visible Fight to Accept flip.** The checklist itself already concedes the refund, so the "the challenge changed the recommendation" banner never shows. M2's done-when ("the $249 case flips to Accept") is met in outcome but not in what the analyst sees.
- **The hero is properly a "credit not processed" case.** A refund promised but never processed fits Visa 13.6, not 13.3. Delivery and "got it" prove receipt, not that the goods conformed to the description, so they should not carry a 13.3 defense.
- **The Compelling Evidence 3.0 rule is too loose.** It needs at least two matching data elements, at least one of them IP address or device, the same card, and prior transactions not reported as fraud. Card brand is also ignored, though CE 3.0 is Visa only.
- Accepting a dispute whose approved refund is still pending could pay the customer twice when the refund worker is replayed. Stuck refunds must be voided when a dispute is accepted.
- An explicit incident link conceded the case even after the refund was later completed.
- Refund amounts were ignored, so partial refunds were not handled.
- A full refund before the dispute was not treated as a defense.
- Customer-message labels were treated as mutually exclusive states, though one message can carry several.
- Support tickets were matched per customer, not per order.
- Near-simultaneous identical orders read as distinct orders rather than possible duplicates.
- The policy-in-force check depended on optional webhook metadata.
- Blast radius de-duplicated by customer instead of order, and summed amounts in mixed currencies.
- Dispute stages (representment, pre-arbitration, arbitration fees) are not modelled.
- Monitoring thresholds must use Visa's current program, not retired ones.

### Product gaps
- Spec story numbers and several docs are out of date (for example the roadmap still names INC-231 and twelve spikes).
- Due dates and queue views are missing.
- The biggest gaps for the submission are the systemic view (M3), the defense pack, and Rovo inside the workflow (M4).

---

## Polish (overnight)

### Built
- **Live evidence arrival** (`a6727b9`, spike S10). Collection now reads one source at a time (order, support tickets, refunds, incidents, policies), saves the record and publishes a Realtime event on `exhibita-evidence` after each. The open panel shows "Collecting evidence" with the source just read, then refreshes. Seen live on DSP-47 from "Collect evidence again"; the intake consumer runs the same code and logged no publish failures across the 60-dispute demo run.

### Broke
- Explanation wording, found by reading the panel's explanations:
  - A conceded item that was not a refund read "Evidence cancelled before the charge".
  - A check with only evidence against us was reported as a conflict, though nothing conflicted.
  - An incident that dropped a refund was titled as a "charge problem".
  - Policy exhibits were named by Confluence page id.

### Fixed
- `c5bb4ec`: concessions now read as sentences ("The customer cancelled before the charge"), failed checks say the evidence is against us, the dropped-refund incident is titled that way, and policy exhibits use the page title. The new explanation tests failed before the change.
- `a6727b9`: a design risk caught before shipping. Reading sources one at a time means a record exists while some sources are unread, and an unread refunds table would look like "no refund owed", which could wrongly support a Fight. Collectors now take a list of pending sources and emit nothing from them. The new collector tests failed before the change.

### Learned
- Any staged or partial read needs an explicit "not read yet" state, separate from "read and empty". (Review round 1 found the same gap one layer up, in evaluation.)

---

## M2 build: evidence, demo world and setup wizard (overnight)

Commits `e1222be` to `fee1af5`.

### Built
- **Source-record contract** (`e1222be`). One definition shared by the demo generator, the setup wizard and the collectors: the SQL rows, the Jira and Confluence records the wizard creates, and the observed records the collectors read back with real keys. An incident is a cause only through an explicit impact row or link, never through timing.
- **Evidence collectors with provenance** (`4a130d8`). Orders, charges, refunds, tickets, incidents and policy versions become lettered evidence. Every item names its source and the time of the underlying fact; inferences from customer text carry the quoted phrase; an absence is evidence only when it is a recorded query result.
- **Seeded demo-world generator** (`3798652`) with a reference observer and a story test. The world has 60 disputes, including the $249 hero whose approved refund was dropped by an incident, a cluster of 38 disputes (the hero plus 37) totalling $5,492, and 212 customers not yet disputed who are owed $30,859. The story test checks every dispute's recommendation, the cluster and the blast radius on six seeds and asserts the dollar totals are identical across them; a one-off 300-seed sweep also held.
- **Verdict after challenge gates submission** (`3ca49b6`, D-12). The panel, validator and agent actions share one verdict: every required item met and a final recommendation of Fight. The new test covers a complete case where the customer says the parcel never arrived, which the checklist alone would have let through.
- **SQL schema** (`50b698c`, D-03): customers, products, orders, charges, refunds, incident_impacts and outcomes. Row codecs live in the pure core with round-trip tests, so false and unknown stay distinct and times stay UTC. Inserts are batched `INSERT IGNORE`, so a seeding step can be re-run after a partial failure.
- **Evidence gathering on intake** (`5592f92`). Orders and refunds from Forge SQL, tickets and linked incidents from Jira, the policy version in force from Confluence. The panel shows lettered exhibits with sources, Fact and Inference labels, the case against us, whether the challenge changed the recommendation, and "Collect evidence again".
- **Jira and Confluence setup library and the setup wizard** (`40753a9`, D-13). "Set up demo data" runs 11 resumable find-or-create steps from the admin's browser, one bounded resolver call at a time, with progress saved after each: projects, the Dispute work type, the dispute workflow with the submit check, policy pages, deploys and incidents with their causal links, support tickets, payment records, and 60 disputes pushed through the real webhook queue. "Remove demo data" removes only what setup recorded creating and moves projects and the space to the trash. The page also runs the ten-case validation suite.
- **"Check the demo disputes"** (`fee1af5`). Evaluates every demo dispute on the site from its stored record and live sources, and compares each verdict with what the generator intended. It catches drift between the reference observer and what the site returns.
- **Decision records** (`d2f9d29`): D-12, D-13 and D-14.

### Broke
- **Typecheck.** `asApp()` and `asUser()` return requester types that differ, so a wrapper accepting either did not compile. Wrappers were narrowed to a type with only `requestJira` (`40753a9`).
- **Fetcher versus reference observer.** Before going live, the live fetcher's output was compared with what the reference observer says the collectors should see. Five mismatches, all fixed in `5592f92`:
  1. The duplicate-charge window was anchored on the purchase instead of the disputed charge.
  2. Refunds, tickets and incidents were not sorted.
  3. A "Customer (time):" header on ticket comments leaked into the text being classified. It is now stripped, with a round-trip test.
  4. Refund to incident links were followed only through the first ticket.
  5. A refund's ticket key was set by the last ticket instead of the first.
- **Removal bug, caught by reading the code before running it.** When setup had created the disputes project, only the first 20 stored records would have been cleaned before the project was trashed, leaving orphaned records in app storage. Replaced with a paged sweep (`40753a9`).

### Verified live
- The wizard completed all 11 steps with no errors: 60 disputes, 29 tickets, 3 incidents, 3 deploys.
- The hero, DSP-47, shows Accept, citing refund REF-1001 (approved but never completed) and INC-1.
- "Check the demo disputes": 60 of 60 reach their intended recommendation.
- Validation suite: 10 of 10 on the site.

### Learned
- `forge logs` prints only 20 lines by default, which is not enough to count a 60-dispute run. Counts were checked with JQL instead, and later with `--limit`.
- A reference observer that is independent of the fetchers is worth its cost: it found five bugs that no unit test targeted.

---

## M2 platform spikes (overnight)

### Built
- Confluence scopes and a Confluence install (`1e1a595`). A new platform check reads Confluence both as the app and as the admin; both pass.

### Fixed
- **S3 revisited.** REST project creation was tested again. Template `com.atlassian.servicedesk:simplified-finance-service-desk` creates a real, company-managed service desk that the service desk API lists. The earlier shell project came from the wrong template key, not from a platform limit. Company-managed software projects come from `gh-simplified-kanban-classic`. Throwaway test projects were moved to the trash.

### Blocked, then unblocked
- The app could not call Confluence until it had Confluence scopes and was installed in Confluence as well as Jira. The scope change made a major version (3.0.0). The deploy required approving the `MAJOR_VERSION_RULE`, and the installs had to be upgraded with the new scopes confirmed. After that, platform checks read Confluence as the app and as the admin.

### Learned
- **S12.** As the admin, created a space and a page, updated it, and read back both versions with their messages. Version timestamps are always the time of writing and cannot be backdated, so policy effective dates live in a page property.
- Jira issue keys cannot be chosen, so the story uses site-assigned keys (INC-1, DEP-n) instead of the planned INC-231 and DEP-88 (D-14).

---

## 26 Nov 2026 (night): the submit gate

### Built
- A Dispute work type and an "Exhibita dispute workflow" (New, Collecting evidence, Ready to submit, Submitted, Won, Lost, Accepted) on DSP. The statuses, workflow, work type and scheme mapping were made through the REST API. Intake now picks Dispute automatically.
- The validator was attached to "Submit to network" in the workflow editor, then read back through the API (spike S8, `5d75d7e`).

### Broke
- `POST /rest/api/3/workflows/create` rejected the request: "The reference new is not a UUID". Status references must be UUIDs.
- Publishing the workflow scheme draft failed: "missing the mappings required for statuses with IDs 1,3,4,5,6". Jira requires status mappings even when no work items of the type exist yet. Supplying them fixed it.
- **Integrity hole.** The pass case was tested by adding evidence to DSP-3's record, and that is exactly the problem: issue properties are writable by anyone who can edit the work item, so evidence could be typed in by hand to pass the gate.

### Fixed
- D-11 (`efbf8a7`, `caaf650`). The authoritative record lives in Forge app storage under `record:{issueId}`, which only the app can write. The issue property `exhibita` is a mirror for JQL and display. The panel, validator and agent actions read only the stored copy. A mirror that differs is flagged "Record edited outside Exhibita"; a mirror with no stored record is "unverified" and never evaluated, so submission stays blocked. A resent webhook restores the stored record from the authenticated payload. The new `reconcileRecord` tests failed before the change.

### Verified live
- DSP-3 with no evidence: "Submit to network" fails in the UI and over REST with "Evidence incomplete (0 of 2 required). Add: Proof of delivery to the customer's address; No refund is still owed to the customer". With both exhibits on the record, it passes and moves to Submitted.
- After D-11: evidence typed into DSP-4's property by hand is rejected, and the panel says the record was edited outside Exhibita. DSP-1, created before the change, showed as untrusted until its webhook was resent, which restored the stored record.

### Learned
- Jira stores a Forge validator as rule `forge:expression-validator`, with parameter `key` set to the extension ARI, which includes the environment id. The seed wizard can therefore create the whole workflow, validator included, through `workflows/create`, taking the environment id from the request context.
- A gate is only as strong as the data it reads. Anything a user can edit is input, not a record.

---

## 26 Nov 2026 (evening): first deploy and live run

### Built
- Registered the app in the Developer Space (`1fb3d02`), deployed to development, and installed on the demo site.
- Setup page actions to create the disputes project and put the admin in its Administrators and Service Desk Team roles (`99a49de`).
- Live spikes S1, S2, S4, S5, S10 (published from a resolver) and S11 pass ([SPIKES.md](SPIKES.md)). For S4: GET returns 405, no secret 503, a wrong secret 401, a good post 202, and the consumer creates the work item with the record attached.

### Broke
- **Deploy, twice** (`887731d`):
  1. "TypeScript emitted no output". ts-loader emits nothing when tsconfig sets `noEmit`. Removed it; the `typecheck` script still passes `--noEmit`.
  2. "Can't resolve './intake/consumer.js'". Forge's webpack config does not map `.js` import paths to `.ts` files. Relative imports are now extensionless, which both Bundler resolution and Vitest accept.
- **Setup page stuck on a loading skeleton**, with "Failed to open iframe bridge: Handshake timeout" in the console. Forge serves app UIs from per-app hosts under `*.cdn.prod.atlassian-dev.net`, and the local DNS resolver answered `REFUSED` for them, so the UI frame never loaded. Public resolvers answered normally.
- **Platform checks:** the Jira project DSP did not exist yet, and Teamwork Graph rejected the query with "You must set an operation name of the shape [company]_[operation]".
- **Intake bugs that unit tests could not catch:**
  - Disputes were created as Epics, because intake took the first work type the project listed.
  - A redelivered webhook created a duplicate, because JQL cannot search an issue property until a `jira:entityProperty` module indexes it.
- **Panel missing on work items**, for two separate reasons found one after the other:
  1. The admin was not in the project's agent role. A project created through the REST API makes the caller its lead but not an agent, and JSM hides app panels from non-agents.
  2. Even with the role, the REST-created service project was a shell: Epic and Story only, no service desk behind it (template `simplified-general-service-desk`).
- **A resent dispute was skipped.** After DSP was replaced, the KVS intake marker still pointed at a deleted work item, so the consumer believed the dispute already existed.

### Fixed
- Pointed the machine and browser at public DNS. Ordinary networks are not affected, but the demo machine must use public DNS.
- Added project setup (`99a49de`), and named the Teamwork Graph query `exhibita_platformCheck` (`99a49de`).
- `chooseWorkType` never picks epics or subtasks and prefers Dispute, Service request or Task; its 5 new tests fail against the old pick (`54cbca9`).
- The manifest indexes `dispute.externalId` (alias `exhibitaDisputeId`), and the consumer records each dispute id in KVS, which is read-your-writes, before falling back to JQL. Values in JQL are now quoted safely (`54cbca9`).
- Role setup for the admin (`99a49de`).
- Deleted the shell project with the site owner's approval and recreated DSP from Jira's UI using the Finance service management template, company-managed so that Forge workflow validators apply. The "Exhibita evidence" panel then appeared and rendered the live rubric: Investigate, 0 of 2 required (Insufficient evidence), submit blocked with both missing items named (S5, `49cc631`).
- The consumer checks that the recorded work item still exists before trusting the marker (`8cf4549`).

### Result
- The M1 slice runs live: webhook, queue, work item, panel. The workflow validator was next.

### Learned
- Live runs find a different class of bug from unit tests: platform defaults (work type order, search indexing, roles, templates) that no test of our own code can see.
- Read-your-writes markers need to be checked against reality when the thing they point to can be deleted.

---

## 26 Nov 2026 (day): foundations

### Built
- **Docs first.** Product spec, architecture, ten decision records (D-01 to D-10), a short list of invariants every change must keep, and a six-milestone roadmap with feature freeze on 15 Dec (`0ebcdce`, `bf9861c`, `8901e92`).
- **TypeScript in strict mode with Vitest** (`0c2f567`, D-09), with unchecked index access, because the evidence model is full of string states where a typo is a silent wrong verdict.
- **Deterministic core** (D-01), all pure and tested without Forge:
  - Reason-code rubrics and Fight, Accept or Investigate triage for five reasons: item not received, not as described, charged twice, card-not-present fraud, and a cancelled-subscription stub (`7022e40`). A refund approved but never completed concedes the case; one only initiated leads to Investigate. A test fails if anything resembling a win percentage appears (D-08).
  - A webhook normaliser for Stripe-compatible dispute payloads that checks every field (`e2317d5`).
  - A negation-aware phrase lexicon for customer text, with no model and no network call (`7a506ff`, D-02).
  - 66 tests at this point.
- Later the same day: the evidence red team (`52efe19`), clustering and blast radius (`278765d`), the ten-case validation suite that runs both in tests and in the app (`f428aec`), the webhook intake through a queue (`179f394`), the workflow validator (`f3a3813`), the issue panel (`a9c1c3b`), the setup page with platform checks (`812fee7`), and the Exhibita Analyst agent with two read-only GET actions for Rovo and MCP (`b52e221`, D-06).

### Learned
- **Fifteen platform facts checked against the Forge docs** before writing Forge code (SPIKES part 1, `0ed1847`). All three load-bearing assumptions held: function keys are 23 characters at most, Automation runs only GET actions, and a backend cannot read a Rovo reply. New find: Jira's experimental agents API can *start* an agent on issues, now spike S13.
- **Package majors had moved** well past the early scaffold (`@forge/api` 8, `@forge/bridge` 7, `@forge/react` 12), so every API call was checked against the installed type definitions rather than older examples.
- Chose an end-to-end slice before widening each layer (D-10).

### Blocked
- **Open risk:** the docs require `app.rovo` metadata for apps with `rovo:mcp` from 5 Jan 2027, but `@forge/manifest` 13.9.1 (the newest) rejects it. Left out of the manifest with a comment; re-check the schema before submission.
- Every new Forge app needs a Developer Space, and the CLI can only list spaces, not create one. That is a one-time console step before the first deploy.

---

## How this log is kept

This log is updated after every meaningful step: a deploy, a live check, a bug found or fixed, a decision made, or a review finding. Entries say what was verified and how (unit test, live run on the development site, or review), cite the commits involved, and record failures as plainly as successes. New decisions go in [DECISIONS.md](DECISIONS.md) and platform checks in [SPIKES.md](SPIKES.md); this log links to them rather than repeating them.
