# Development after scheduled agents

Researched 2026-10-14; approved for autonomous development by the owner afterward. Implement the recommended defaults and sequence below, preserving capability-specific acceptance gates. Account access, external disclosure destinations, new credentials and explicitly excluded authority still require their stated gates. [Product scope](product.md), [decisions](decisions.md) and D57 remain authoritative where this plan preserves exclusions. Completed delivery and live acceptance are separate.

## Recommended direction

Make the deployed planner and scheduled agents dependable, then give them trustworthy academic context, then explicitly selected memory. Improve connector coverage alongside that work. Introduce MCP through a small inbound read surface before considering outbound tools.

The important dependency is **verified context and derived-data provenance before richer AI behavior**. Existing verified academic/memory context belongs to the general gateway, whose dispatch is disabled. The live Assistant is a separate path. Connecting more records directly to that path would bypass protections already designed elsewhere.

Keep the existing Fastify/React/contracts/PostgreSQL architecture, in-process worker and narrow OpenRouter transport. A queue service, vector database, new agent framework or microservices are not required for these milestones. Functional backend work comes first; preserve the current UI behavior and defer visual refinement.

## Verified starting point

Repository baseline: deployed release `519054d`, migration 057, with the deployment receipt on `docs/agents-deployment`. This is a planning snapshot, not a fresh production audit.

| Area                    | Implemented / evidenced                                                                                                          | Still unproven or absent                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Scheduled agents        | Pinned conversations, schedules, action policies, per-agent spend threshold, Inbox results; PRs 30–33 integrated and deployed    | First owner-created agent/run and daily-use acceptance                                                 |
| Release validation      | Prior receipt: 628 automated tests, 144 browser tests, PostgreSQL CI; verified isolated backup restores and runtime health       | These checks do not prove live usefulness or account coverage                                          |
| Live Assistant          | Narrow OpenRouter planner/mail flow; owner limits; uncertain outcomes are not resent                                             | Shared verified context admission, complete history lineage and derived-output provenance              |
| Academic work and study | Work/class management, deterministic study planning and approval UI; verified manual academic projections in the general gateway | Live academic context; certified workload-derived context; complete Canvas collection                  |
| Memory                  | Owner editor, labels, enable/disable/forget and verified explicit selection in the general gateway                               | Live per-request selection; D57 excludes automatic agent memory reads/edits                            |
| Mail                    | Bridge connector, mail browsing and live Assistant reading; Windows sync recorded as operating every ten minutes                 | Required Gmail coverage, move/deletion reconciliation and complete freshness semantics                 |
| Canvas                  | ICS/API adapters and one-course browser feasibility                                                                              | School blocks owner-created tokens; approved API access and durable browser collection not established |
| Outlook                 | Integration direction agreed                                                                                                     | Actual mailbox backend, tenant permissions and adapter feasibility                                     |
| MCP                     | Both directions in long-term product scope                                                                                       | Transport, authorization, export permissions, client compatibility and runtime tools                   |

The first maintenance slice must reconcile older “pending” statements in README/development/integration/memory/study docs against dated receipts. For example, the latest backlog records operating mail sync while older ingestion docs still call scheduling pending. Preserve historical receipts; correct present-tense summaries rather than treating old status as a new deployment task.

### Findings that affect the order

These are code-audit findings requiring targeted regression tests, not claims of observed production incidents:

- `assistant.ts` currently reads bounded eligible tasks/events and excludes academic/source-linked records. Deadline watch does not yet mean comprehensive academic deadline awareness. Eligibility filtering occurs after capped selection, so omitted records cannot be described as an empty workload.
- `assistant-conversations.ts` resends raw recent asks/replies without resolving source labels or revocation. Turning mail off does not remove information already carried in prior answers. Future forgotten memory must not survive as redisclosed conversation context.
- Assistant-generated task/event proposals lack a complete admitted-source lineage. Derived text can become an unlabeled planner record. Fix this boundary for existing mail-derived outputs before adding more sources; do not invent provenance for old records.
- Worker `last_tick` is written after awaited execution using the tick-start time. Long valid runs can look unhealthy. A ten-minute lease does not by itself fence later planner effects after a stalled execution loses ownership.
- Per-agent spending currently checks the threshold before a run and pauses after it is reached. It is not a reserved hard ceiling for the next complete multi-round request. The shared owner budget remains a separate constraint.
- Planner effects and saving the final agent-turn item state are separate operations. Crash recovery must reconcile durable operation receipts, including partially applied multi-item turns, without resending a paid request.

Evidence locations: `apps/api/src/features/{assistant,assistant-conversations,agent-worker,agent-run}.ts`, `apps/api/src/ai/{context,live-request}.ts`, `apps/api/src/features/ai-routing.ts`, `apps/web/src/components/{MemorySettings,StudyPlanView}.tsx`, and the existing agent/verified-context tests.

## Non-negotiable boundaries

All private reads/writes remain owner-authorized. Reuse shared contracts, optimistic versions, idempotency receipts and tombstones. Add new numbered migrations; never edit an applied migration. Do not backfill uncertain history with fabricated source bindings.

Hosted AI receives bounded text only, never screenshots, attachments or attachment-derived text. Sensitivity comes from owner labels and inherited provenance. Resolve all applicable routing permissions; an unavailable approved destination blocks or queues without default fallback. Zero retention is a separate requirement, not permission to disclose sensitive text to any provider.

Keep the current owner-configured model and spending settings. No model migration, new provider, paid experiment or real-account test is part of this plan. Email sends, invitations and cancellation emails always require exact explicit owner approval. Calendar authority never proves provider write support.

D57 exclusions remain excluded until separately designed and approved: event triggers, parallel runs, delegation, MCP, web browsing, external writes, automatic memory reads/edits, voice, personas, learning, automatic month-start resume and push/native notifications. Existing Pause allows an already-running run to finish; preserve that behavior unless a separately specified Stop control is approved.

## Delivery order and dependencies

| Stage                         | Outcome                                                                                        | Dependency / exit gate                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A. Reliability and acceptance | Trustworthy worker, spending semantics, receipt recovery, run visibility and release preflight | Synthetic failure gates pass before expanding autonomy                      |
| B. Shared verified context    | Safe live admission, history revocation and inherited output provenance                        | Required before any new academic/memory disclosure or source-derived writes |
| C. Academic assistance        | Useful score-free academic answers, then grounded planner proposals                            | B; manual work first, imported sources individually certified               |
| D. Explicit memory            | Owner selects saved entries for an individual ask                                              | B and a bounded new permission decision; no automatic agent access          |
| E. Integration quality        | Honest coverage/freshness, Canvas collector, Outlook feasibility                               | Freshness work can proceed alongside A/B; each source has its own live gate |
| F. Inbound MCP                | A small, scoped read-only surface for one chosen external client                               | A/B, explicit export/auth decisions and actual client/version proof         |
| G. Outbound MCP               | One allowlisted read server with bounded tool calls                                            | A/B/F experience; separate approval and network/provenance gates            |

Start A and the provenance specification/regression fixtures for B together. Source-health work in E is independent enough to proceed alongside them. Do not hold manual academic usefulness hostage to Canvas or Outlook access. Do not enable new source use until B passes. F/G are later milestones, not one large integration project.

## A. Stabilize the deployed experience

### A1. Establish acceptance and regression fixtures

Create a dated acceptance checklist distinguishing deployment, authenticated readiness, scheduled execution and usefulness. Production receipts should contain metadata only: release, migration, run IDs, timestamps, outcome categories, costs/holds and source coverage. Never copy goals, messages, cookies or credentials into logs.

After implementation authorization, owner-controlled live acceptance should start with one bounded agent, reviewed goals and mail scope, existing caps, and an explicit action policy. Recommend Ask first for this canary without changing global defaults automatically. Observe several scheduled runs, one offline-connector interval and restart recovery; inspect whether the output actually saves a manual planning step. Run synthetic cap/retry/failure tests instead of deliberately spending to a live cap. Do not create agents or make paid calls as routine development tests.

### A2. Make execution ownership and accounting precise

Preserve single-run serialization. Define an execution deadline shorter than the lease, or implement renewal with fencing; select the simpler approach after measuring the bounded current call sequence. Check the current lease and authorization before every planner effect and final result commit. A late response after lease loss may require accounting settlement, but must not apply stale effects or redispatch inference.

Persist deterministic per-action intent and reconcile existing planner receipts after restart. Enforce the lease fence in the same transaction/serialization boundary as each effect and receipt; a detached check followed by an unguarded write is insufficient. A crash after the first successful write must recover the same effect and item result once, then continue only if current policy permits. Do not infer that a paid inference failed because its result was not persisted. Keep uncertainty visible and non-retryable unless a provider-specific reconciliation proves safety.

Recommend a strict per-agent admission reservation within the shared owner reservation, made before each actual provider exchange rather than speculatively reserving the maximum entire multi-round run. Account for every mail/model round, settled spend and uncertain holds. If the remaining allowance cannot fund the next bounded exchange, stop before that transmission and show the incomplete/blocked result; an earlier exchange may already have incurred cost. Define month assignment, release/settlement and rounding explicitly; do not double-count owner and agent reservations. Test that the sum of settled spend and active/uncertain reservations never exceeds either allowance. This changes threshold semantics and needs an owner decision before implementation.

### A3. Expose actionable status

Separate scheduler liveness, active-run progress and lease expiry. Record actual start/finish timestamps and last progress independently of the injected scheduling time. Show disabled worker separately from unhealthy worker and distinguish queued, running, retry scheduled, blocked, failed, uncertain, completed and cap-paused states. A failure before a turn exists must still have an inspectable result.

Add bounded run history with stable pagination, attempts and redacted error categories. Show settled spend, reserved/uncertain holds, remaining allowance and month boundary. Reuse current Inbox links and conversation history; preserve deleted-agent conversations, read-on-open receipts, quiet agents and reminder behavior. Retry controls must reflect safe backend capability rather than retry every error.

Prefer local metadata-only diagnostics and bounded retention. Do not introduce external telemetry or raw prompts, mail subjects/bodies, query strings, headers or source text into logs. Data minimization is consistent with [OpenTelemetry sensitive-data guidance](https://opentelemetry.io/docs/security/handling-sensitive-data/); adopting its infrastructure is not a prerequisite.

### A4. Harden release preflight

Automate staged artifact checks as the actual service user before activation: directory traversal/read permissions, Node/runtime imports, production dependencies, entrypoint/build manifest and artifact hashes. The last rollout's staging-permission failure is the concrete regression case. Compare the release tree to the tested commit and verify stacked PR changes reached main.

Retain pre-migration backup and isolated restore proof. Check migration compatibility and service readiness before declaring success; report worker readiness separately. Keep atomic release switching and the previous code release. Code rollback must respect forward-applied schema compatibility; never automatically restore an old database over owner writes. Preserve root-only secret permissions. Encrypted off-host backups remain owner-deferred.

**A exit checks:** fake hanging/late provider, expired lease, two-worker race on disposable standard PostgreSQL, shutdown/restart at each effect boundary, safe retry versus uncertainty, partial planner application, strict-cap edge cases if approved, timezone/month boundaries, false-heartbeat regression and service-user unreadable-stage failure. PostgreSQL supports `SKIP LOCKED` for queue consumers, but row claiming does not establish end-to-end exactly-once effects. [PostgreSQL 16 SELECT](https://www.postgresql.org/docs/16/sql-select.html).

## B. Connect live execution to verified context

### B1. Specify one admission boundary

The [live admission implementation specification](live-context-admission-design.md) records the next P5/P6 contract and code anchors. It is planning evidence, not completed live enforcement or expanded source access.

Reuse the verified resolver, bounded projections, immutable captures and exact-envelope binding already implemented. Do not enable the disabled general gateway wholesale. Adapt the existing live lifecycle so both owner asks and scheduled agents use the same source/routing checks while retaining the narrow transport, budget reservations and no-resend behavior.

Resolve selection, source/ancestor versions and projection in a consistent snapshot. Bind the actual outgoing envelope, including eligible history and each later mail round. Immediately before every transmission, revalidate owner authority, current labels, source/connector/memory state, routing permissions, provider availability and spending admission. Source or policy changes block that disclosure. Never turn an uncertain committed attempt into a safe retry merely because new context can be assembled.

Record a durable per-turn source manifest sufficient for revalidation, with source identity, versions, immutable origin/capture references, inherited labels and route/policy binding. Keep private integrity hashes server-side; expose bounded source summaries and reasons to the owner. Do not store duplicated full context in diagnostic receipts.

### B2. Make history revocable and outputs traceable

Retain conversations for owner viewing under D55, but separately determine whether each retained fragment may be sent again. Recommend withholding unbound legacy history from future inference, offering a fresh conversation and explaining the limitation. Newly bound history must be withheld or the request blocked when its sources are deleted, relabeled, disabled, forgotten or no longer permitted. Define behavior for user-authored asks containing quoted source material; never claim automatic detection of all manually pasted private information.

Every derived answer/proposal inherits the admitted source labels and provenance conservatively. Apply must recheck current permissions, source bindings and expected record versions. Edits, undo/restore and detached records cannot remove inherited labels. Initially restrict new source types to read-only answers if output lineage is not ready. Audit existing mail-derived proposals and records; unknown provenance blocks dependent AI use rather than becoming silently certified.

Forgetting means future retrieval and derived-history redisclosure stop; it cannot retract an earlier provider disclosure or promise immediate erasure from backups. Keep owner-visible retention behavior explicit. If a narrower interpretation is chosen, document it before memory launches.

**B exit checks:** source/ancestor edits and label changes between rounds, incompatible multi-label routes, approved destination unavailable, disable/forget/re-enable, legacy turns, mail switched off with prior mail-derived history, exact-envelope mismatch, truncated context, inherited task/event labels, stale Apply, undo/restore and restart uncertainty. Use injected exchanges and isolated databases. Preserve current text-only body-origin checks and reject unknown/file-derived inputs.

## C. Deliver academic value in small steps

**C1 — Read-only manual academic context:** add explicit work/class selection for owner asks, reusing current verified projections. Include title, kind, deadline or unknown, effort estimate or unknown, owner-recorded work status, priority and a stable source reference. Exclude scores, provider submission artifacts/details and attachments. Show selection, withheld records, truncation and manual-only coverage. Do not equate missing dates/effort with no work.

**C2 — Grounded planner proposals:** reuse academic planner operations and deterministic study preview/approval. Keep assignment deadlines distinct from reserved study intervals; a reservation or completed block does not prove academic completion/mastery or automatically subtract estimated effort. Require fresh source revisions, capacity/conflict checks and inherited labels. Suggestions remain reviewable and undoable through existing operations.

**C3 — Bounded scheduled academic scope:** only after C1/C2 evidence, propose an explicit owner-selected class/work scope for an agent. Describe its rolling horizon, eligible open statuses and incomplete data; submitted/cancelled records do not silently become open workload. Do not silently give every existing agent all academic records. Imported Canvas facts and workload-generated plans enter only after their individual provenance gates; manual work remains useful without them.

**C exit checks:** unknown/date-only/exact deadlines, overrides, archived classes, stale sources, unavailable calendar coverage, over-capacity schedules, changed work during approval, no invented grade/progress claims and source-linked edits/undo. Reuse existing study UI rather than building another editor or scheduler.

## D. Add owner-selected memory, not automatic memory

Use the existing memory editor and verified selection foundation. For each individual ask, let the owner select enabled entries and review source labels; bind memory and global settings versions. A global enable switch alone must not start disclosure. Display entries used/withheld and explain retained conversations and forget behavior.

Start without automatic ranking, embeddings, learning, agent memory bindings or AI edits. Those require a separate design and authority decision. A forgotten/disabled entry and its derived history must be withheld or block transmission under B's revalidation rules, including a subsequent round of the same request. Unrelated eligible requests remain usable.

**D exit checks:** selection limits, conflicting routes, stale edit, disable/forget between rounds, forgotten history, offline/conflict drafts, keyboard/tap picker, no auto-selection on reopen and no automatic agent reads.

## E. Improve inputs without overstating completeness

### E1. Shared source-health contract and Gmail coverage

Track attempt, successful contact, successful import, last complete collection/window, cursor progress and bounded error/action categories separately. A successful no-new-items run advances contact health. Expose Never synced, Syncing, Current within configured coverage, Stale, Partial, Sign in required, Revoked and Error. Store per-source/per-course coverage, not one misleading global Connected flag. Agents receive freshness/omission facts and qualify answers when coverage is stale or partial.

Audit the existing operating Windows scheduled job before proposing installation. Package/version it without overlap, preserve local secret files, Bridge loopback access and HTTPS upload. Test interrupted upload, repeat batches, UIDVALIDITY changes, host sleep, Bridge/API outages and revocation. Membership reconciliation must not globally delete a message merely because one folder no longer reports it; partial observations never prune unseen records.

Define required Gmail coverage separately for Inbox arrivals, skip-Inbox/archived arrivals, Sent and history. Proton's current forwarding/connection documentation excludes skip-Inbox and self-addressed arrivals; it is not a complete Gmail mirror. [Proton Gmail forwarding/connection](https://proton.me/support/automatic-forwarding-gmail). Historical Easy Switch imports and ongoing delivery also differ; folder/read-state changes do not become a synchronized mirror. [Easy Switch troubleshooting](https://proton.me/support/troubleshooting-easy-switch).

Use a bounded owner-reviewed Gmail → Proton → Bridge → hub comparison, recording only counts/timestamps. The September 28 newest-message observation is historical evidence to recheck, not a current diagnosis. Keep Proton aggregation if it meets agreed needs. If it cannot, propose direct Gmail feasibility with deduplication/provenance separately; do not silently add access or change filters. Keep Bridge on Windows: current support excludes this Oracle ARM64 host. [Bridge system requirements](https://proton.me/support/operating-systems-supported-bridge).

### E2. Canvas metadata collector

Do not retry blocked personal-token creation as a development task. Institution-approved OAuth remains preferable if permission becomes available; it requires an institution-issued developer key. [Canvas OAuth](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth).

For the browser path, begin with assignment/course identity, resource kind, title, exact due timestamp or null, canonical URL, capture time, coverage and confirmed class association. Exclude page descriptions, grades, submissions, files, screenshots and session exports. Use a dedicated local runtime/profile and normal interactive MFA. The T3 one-course proof does not establish an unattended production collector.

Prove two differently structured courses, then enumerate all selected active courses. Detect loading, pagination/filtering, collapsed lists, inaccessible courses and traversal limits. Empty-before-load is Partial/Error, not no assignments. Keep assignment and quiz identities distinct. Batch upload must be owned, idempotent and versioned, preserving notes, tombstones and immutable captures. Reconcile ICS/browser disagreement through confirmed associations; absence from ICS is not deletion evidence.

If API access becomes available, follow opaque pagination links rather than trusting requested page size, and preserve student-effective override dates/nulls. [Canvas pagination](https://developerdocs.instructure.com/services/canvas/basics/file.pagination), [assignment schema](https://developerdocs.instructure.com/services/canvas/resources/assignments). Certify source text origin and labels separately before hosted AI use.

**Canvas exit checks:** every selected course coverage, changed due date, undated item, loading failure, duplicate/restart, expired session, inaccessible course, partial no-prune and owner comparison. No institutional restriction bypass.

### E3. Outlook access gate, then read-only adapter

First establish Exchange Online/Microsoft 365 backend, tenant, mailbox scope, app-registration availability and consent requirements. Outlook as a client name establishes none of these. Prefer delegated Graph v1.0 access for this mailbox. `Mail.ReadBasic` excludes bodies; bounded body ingestion needs delegated `Mail.Read`. Do not request send/write/calendar scopes. Tenant policy may block user consent even where a delegated permission is not inherently admin-only. [Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference#mailread), [tenant consent policy](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent).

After that gate, implement protected OAuth/token lifecycle, selected folder/window policy, bounded plain-text projection without attachment fetch and scheduled per-folder delta polling. Save opaque paging/delta URLs with durable ingestion; a folder removal may mean move or deletion, not global removal. Use consistent immutable IDs, respecting mailbox boundaries. [Message delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0), [immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).

Handle throttling, interrupted pages, expired delta state, moves and revoked authorization synthetically. Add bounded resynchronization; cursors do not live forever. [Delta limitations](https://learn.microsoft.com/en-us/graph/delta-query-overview). Webhooks are later optimization with renewal/lifecycle recovery, waking delta reconciliation rather than replacing it. [Outlook notifications](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview).

If the school blocks access, report the exact capability and school action needed. Do not escalate automatically to tenant-wide application permissions. Authorized browser feasibility is a separate proposal.

## F. Inbound MCP, read-only first

Choose the first actual client before choosing SDK/version support. Official documentation currently identifies **2026-07-28** as current; earlier revisions use different initialization/session behavior. Pin the SDK and test the supported matrix rather than claiming generic compatibility. [MCP versioning](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning). July Streamable HTTP uses request-scoped responses and no protocol session/GET event-stream resumption; application durability remains the hub's responsibility. [Transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

Provide a dedicated HTTPS resource endpoint, separate from browser cookie APIs. Select an established authorization server/library after testing the first client. Protected-resource discovery, resource audience, per-request bearer authorization, least scopes, expiry and revocation must be explicit. Browser login may establish consent identity but cannot implicitly grant an external assistant private data. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

Create a named-client grant for specific data/export destinations and scopes. OAuth client identity does not prove the downstream model provider. Require explicit owner approval of external disclosure and explain that hub restrictions cannot control all subsequent client behavior after export. Apply ownership, current labels, source provenance and export policy on discovery and every page/call. Unknown destinations or provenance deny private export.

Initial proposed tools: bounded Today summary, filtered task list, score-free academic deadlines and agent status metadata. Use small schemas, stable IDs/versions, guarded cursors and freshness notices. Exclude mail bodies, unrestricted search, bulk export, files/resources, policy changes, agent creation and email sends. Tool annotations are hints, not authorization. [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

Only after read-only acceptance consider hub task create/complete through existing versioned operations and receipts. Do not let an external client approve its own email, elevate action authority or borrow autonomous-agent permissions.

**F exit checks:** missing/expired/revoked/wrong-audience token, insufficient scope, cookie-only access, Origin/version/header mismatch, stale cursor, changed labels, cross-owner IDs, bounded response, no secrets in logs and an actual chosen-client receipt. A developer token pilot must not be described as a completed interoperable OAuth deployment.

## G. Outbound MCP, one approved read server

Start with a specifically approved HTTPS endpoint and a few reviewed read tools. Keep an owner-controlled registry of credentials by reference, exact endpoint, tool/schema hash, argument disclosures, result provenance/label floor, limits and operation classification. Catalog/schema changes pause tools for review. Do not accept arbitrary shell commands, npm packages or stdio startup configuration.

Constrain all URL-bearing discovery/auth/resource surfaces, redirects and DNS at connection time, including loopback/private/link-local/cloud metadata, reserved and mapped IPv6 targets. Use egress controls where feasible. Do not follow arbitrary tool-result URLs or forward inbound bearer tokens. [MCP security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices).

Recheck destination permission for outgoing arguments. Treat results as untrusted, attach immutable source provenance/inherited owner labels, then reroute or block before inference. Plain text does not prove non-attachment origin. Reject images/audio/blobs/embedded resources, unknown origin and automatic resource following. Disable sampling, elicitation, roots, autonomous subscriptions and task extensions until separately specified.

Bound total tool calls, bytes, duration and cost within A's worker/lease model. Reconnect/cancellation does not prove a remote operation had no effect; uncertain results need reconciliation, never blind replay. Stable operation identity plus bound intent is the relevant durability pattern. [AWS idempotent API guidance](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).

**G exit checks:** synthetic malicious descriptions/results, catalog change, routing/label change between calls, payload limits, unsupported content, redirects/DNS rebinding/metadata access, timeout/cancellation/restart and immediate disable/revoke. Owner-selected live read acceptance comes last. External writes remain excluded.

## Proposed PR slices

These are planning identifiers, not GitHub PR numbers. Sizes are relative complexity, not calendar commitments. Final migration numbers follow the then-current main branch.

| Slice | Deliverable                                                                                | Size / prerequisite                                                 |
| ----- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| P1    | Present-status reconciliation, acceptance checklist, provenance/worker regression fixtures | Small–medium; first                                                 |
| P2    | Worker timestamps, lease fencing, receipt recovery and spending semantics                  | Large; P1 and cap decision; split accounting if needed              |
| P3    | Shared run/status contracts, bounded history, spend/holds and source-health UI             | Medium; P2 backend fields; health foundation can start earlier      |
| P4    | Service-user staged-release preflight and rollback compatibility checks                    | Medium; independent after P1                                        |
| P5    | Shared live context admission and exact source/routing binding                             | Large; approved architecture, P1 fixtures                           |
| P6    | History eligibility/revocation and proposal/record lineage migrations                      | Large; P5, legacy-history decision; no expanded context before both |
| P7    | Explicit manual academic context and source/freshness display                              | Medium; P5/P6                                                       |
| P8    | Grounded academic proposals using existing study operations                                | Medium; P7                                                          |
| P9    | Explicit per-ask memory picker and forget/history enforcement                              | Medium; P5/P6 and memory decision                                   |
| P10   | Gmail coverage receipt and connector reconciliation improvements                           | Medium; P3 health; direct Gmail separate if necessary               |
| P11   | Canvas collector runtime, ingestion and reconciliation in separate layers                  | Large; access/runtime decision, per-course proof                    |
| P12   | Outlook access proof, then adapter only if allowed                                         | Small feasibility; large adapter; tenant gate                       |
| P13   | MCP threat model, first-client matrix, grant/export/auth design                            | Medium; explicit approval; can be researched before transport       |
| P14   | Inbound auth and bounded read tools, separated for review                                  | Large; P13, P5/P6; authentication E2E mandatory                     |
| P15   | Optional hub task writes via inbound MCP                                                   | Medium; P14 acceptance and write decision                           |
| P16   | Outbound registry/security harness, then one read server                                   | Large; P13/P14 experience and separate approval                     |

**Recommended next implementation batch:** P1, P2 and P4, with P5/P6 specification and regression work started early. P3 follows the authoritative backend states. Prioritize any reproduced existing provenance disclosure defect as a fix rather than waiting for academic scope. Expand capabilities only after the relevant safety gate, not merely after a dashboard exists.

## Decisions to resolve at the relevant gate

The owner's approval authorizes the recommended development defaults below. Account-specific facts and choices without a recommendation remain unresolved; no access or live acceptance is inferred.

1. **Per-agent cap:** use a reservation before each actual exchange across all rounds, within the existing shared cap; no speculative full-run reservation. Insufficient allowance stops the next round with an incomplete/blocked result, and uncertain holds count until reconciled. This prevents new admissions beyond the saved allowance; it cannot undo previously incurred charges, a later owner cap reduction or unexpected provider-reported overruns.
2. **Execution control:** preserve Pause-finish-running; decide whether a separate Stop is needed and what can still settle after cancellation. Start with bounded deadlines/fencing, not parallel workers.
3. **Live routing and old data:** approve mapping narrow mail consent to full route evaluation; recommend unbound legacy history withheld from inference and unknown derived records blocked. Preserve owner-readable history.
4. **Memory:** approve explicit per-ask selection only; recommend forget/disable preventing derived-history redisclosure too. Automatic agent memory remains deferred.
5. **Academic scope:** recommend manual work first, then explicit scheduled scope; imported sources require individual certification.
6. **Gmail needs:** choose required Inbox/Sent/archive/history coverage before deciding whether Proton is sufficient.
7. **Connector feasibility:** confirm approved local Canvas runtime and selected courses; establish Outlook tenant access before committing to adapters.
8. **MCP disclosure:** choose first client, allowed data/destinations, auth service and protocol versions; approve inbound reads before writes/outbound tools.

## Validation and rollout discipline

For code changes use Node 24/npm 11 and `npm run check`. Run `npm run test:e2e` for UI/authentication changes, sequentially after check because builds share output. All browser/device tests use isolated ports/databases and synthetic records. Do not seed/reset the owner's development database. Standard PostgreSQL concurrency/upgrade tests must actually run against disposable databases; an optional skipped test is not a passing receipt.

Test transitions and failure boundaries, not only happy-path schemas: before admission, after reservation, after provider dispatch, before/after each planner write, before receipt/result persistence and during restart. Include provider mocks, fake clocks, rate limits, uncertain costs, stale versions and permission revocation between rounds. Preserve offline/conflict drafts, 320px layouts, dark/e-ink contrast, keyboard/tap Help and essential visible errors. Actual Kompakt, closed-app reminders and screen-reader checks retain their separate pending status.

Release new source/MCP capabilities disabled until their gate is approved and accepted. Use additive migrations and rollback-compatible feature flags. First ship narrow read-only behavior, then bounded writes through current operations. Record each PR's checks, limitations and live acceptance independently in implementation-log.md. Update the UI ledger with implemented contracts; keep proposed contracts clearly marked until delivery.

Planning work used repository inspection and primary documentation only. It did not access owner records, change live configuration, dispatch paid inference, enable integrations or complete any feature acceptance. Repeat protocol/SDK, tenant and provider capability checks at implementation time; documentation cannot prove account-specific permissions.
