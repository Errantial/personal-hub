# UI agent ledger

## Persistent agents UI (D57, 2026-10-14)

The Assistant consumes owned `/api/v1/agents` and the shared agent, conversation and turn contracts. Agents stay pinned above ordinary conversations. State labels use the agent time zone; unread run dots are local to this device and clear on opening the thread. A deleted agent leaves its conversation readable. Preserve template defaults, daily/weekly schedules with one to six unique local times, editable time zone, mail choice, monthly cap and spend, Pause/Resume, Run now and confirmed deletion. Run turns replace the owner bubble with a run line, keep applied-item Undo, show blocked-action counts, and offer Retry only for failed requests; uncertain requests are never resent.

Settings > AI > Actions edits the versioned `/api/v1/ai/actions` policy: Tasks and Calendar support Automatic / Ask first / Off; email remains approval-required. Assistant answers always require Apply. Preserve conflict drafts and explicit reload. Agent and policy writes are online-only, use version guards and retain operation IDs across unchanged retries; dialog drafts are in memory and do not survive navigation. Keep errors and offline/pending state visible, modal focus and Escape behavior, 320px layout, dark contrast and e-ink targets. Browser tests disable the worker and remove its provider key. Inbox links/read-on-open follow in PR 3. Actual Kompakt and screen-reader verification remain pending. See the [approved scope and exclusions](superpowers/specs/2026-10-14-persistent-agents-design.md#out-of-scope-recorded-for-future-work).

## Manual tasks from mail (2026-10-13)

Preserve [mail task capture](mail-tasks.md): exact supporting body quote, owner title, optional explicitly confirmed deadline, retained labels/source link and immutable creation capture visible in the task editor. Categories never determine privacy. Keep no-date entry usable, date confirmation cleared on date/source changes, invalid quote visible, pending controls locked, offline state visible and drafts retained after errors and refresh. A changed message requires deliberate source-version review before retry. Failed refresh must keep the existing form mounted. Success links to the task and prevents duplicate submission from that form. Online-only in-memory capture drafts do not survive navigation/restart. Automatic extraction, mail-derived task AI context, paid classification, mail/calendar writes and actual Kompakt acceptance remain pending.

## Canvas access limitation and browser proof (2026-10-13)

The owner's school blocks personal token creation, so **Canvas API not configured** is an actual access gate. A browser DOM feasibility test passed for one course (27 unique links/titles, 10 valid due timestamps, 17 missing dates). It did not import hub data, prove all-course coverage or add a connector. See [canvas-browser.md](canvas-browser.md). Do not expose browser sync as supported yet. A future UI must distinguish sign-in required, loading/partial/filter-limited snapshot, missing due date, source freshness, conflict and failed import; its contracts do not exist yet. Initial collection must project selected metadata locally because assignment pages also contain scores and other unnecessary text. No whole-page prompt export, screenshot/attachment input, automatic sensitivity inference or provider execution is added.

## Deployed web boundary (2026-10-13)

The tested UI through reminder-history commit `265a99d` is served at `https://hub.ecg.name` on the actual Oracle Linux ARM64 VM. Deep links fall back to the shell, `/api` stays same-origin and `/sw.js` uses `Cache-Control: no-cache`. Secure sessions and the setup-token gate remain required. Live unauthenticated setup/deep-link/320px checks passed with no JS errors and private API 401; no synthetic owner was enrolled. Daily use is unverified. Local DNS propagation was incomplete, so the browser check used a hostname/address override. Same-device backups retain private history; off-host protection is deferred by owner choice. Do not promise permanent erasure, migrated development records, live providers or Kompakt acceptance.

## Final backend-hour verification (2026-10-12)

`npm run check` passed lint, strict types, formatting, builds and 505 API/client tests, with one optional PostgreSQL skip. All 32 new academic/Calendar/session tests passed again after the final error-copy correction; targeted lint/formatting and the refreshed API build passed. Compiled API smoke verified all 45 migrations/new routes/receipts/immutable origins with no network calls.

The complete isolated browser rerun passed all 84 tests on ports 5184/3014 with a new synthetic database and builds idle. Earlier overflow/conflict failures below describe previous shared-workspace snapshots, not the current passing run. The initial backend-hour browser run passed 83/84 with an API-unavailable conflict-draft snapshot during overlapping builds; its fresh single-test and complete reruns passed. No assertions were weakened. New batch controls, offline integration, class/topic restoration, standard PostgreSQL and actual Kompakt/provider execution remain pending. This backend work did not edit the concurrently developed UI.

## Backend handoff: academic management and Calendar selections (2026-10-12)

Read [academic management](academic-management.md) and [Calendar selection contracts](calendar-management.md). Academic browse defaults to active classes/all statuses, sorts open before closed with deadline/UUID paging, and returns full filter counts independent of selected status/page. Entries/cursors carry current class versions. Keep filters between pages; reset on refresh/filter changes. Work/class cursor conflicts require reload. The existing academic history/tombstone and deadline-agenda routes remain available.

Academic batches select 1-100 exact IDs/work versions/class versions. Only status, priority, deadline, estimate and deletion are supported; omitted fields remain unchanged, null clears, zero is known effort. `ACADEMIC_SCORE_REVIEW_REQUIRED` blocks the entire selection until an individual explicit score correction. Submission is owner-reported and never completes linked planner work. Archived classes support history/deletion but not work editing; class/topic restoration remains unimplemented and must not be offered as recovery.

Calendar batches select 1-100 exact record IDs/versions. Deletion affects a whole recurring series; show that scope before submission. Study-status changes accept only one-time timed blocks with active ancestors; mixed/recurring/all-day/ordinary selections are wholly rejected. Preserve source labels/unknown history and occurrence edits. Study completion does not prove submission/mastery. Restore uses existing individual endpoints and does not restart cancelled reminders.

Both batches are atomic and online-only. Show pending/error/conflict states; retain drafts/selections and the exact operation ID after a lost response. Historical retries do not reapply changes, so reload current data. Never send a filter-wide selection or include future arrivals silently. UI/offline integration, batch restore and external-provider writes remain pending. No invitation/cancellation email authority is added.

## Earlier browser verification handoff (2026-10-12)

An earlier isolated 84-test browser run returned 75 passes and nine failures while shared UI/backend files were changing. Its fresh rerun of nine affected tests on independent ports 5182/3012 passed six, including preflight lost-response receipts, session/outage handling, e-ink persistence, task lifecycle and lost-save deduplication. At that time, three narrow Canvas overflow checks still failed: canvas.spec.ts planning at line 103, canvas.spec.ts import at line 341 and connections.spec.ts at line 69 for /settings/connections/canvas. Those runs did not establish a complete browser pass; the later final verification above passed all 84 checks without weakening assertions. Both earlier runs used separate synthetic databases; no owner database or device was used.

## Backend handoff: transient context review (2026-10-12)

Read [review contracts](ai-context-preview.md). POST /api/v1/ai/context/preview accepts the preflight input without operationId; it rejects uploaded payload/manifests, saveAnswer, attachments and dispatch flags. Response has preview=true, retained=false, dispatchEnabled=false, nullable payload and a metadata assessment. It creates no records/receipts/holds. Keep the returned text temporary: render as text, clear on source/settings/session changes and exclude it from offline caches, storage and logs.

Review availability and execution readiness are separate. Visible blockers remain authoritative. Denied/unavailable/file-derived/oversized routes return no text. Stale/foreign/deleted/archived/disabled sources error without disclosure. Source changes after review require refreshed versions and a deliberate fresh submission; the original text/references go to the normal request endpoint, never the uploaded preview assembly. No answer-saving consent, action authority or paid permission follows from review. Provider-specific system/native context remains unverified. UI controls and live dispatch are pending. All 41 context tests pass; the full API/client run passed 487 tests with one optional PostgreSQL skip. Refreshed lint/types/formatting and production builds passed; twelve additional Calendar-management tests passed separately. Browser limitations are recorded above. No owner database, paid AI or device was used.

## Backend handoff: manual academic AI context (2026-10-12)

Read [academic context contracts](ai-academic-context.md). References add `kind=academic-work` with required work and class versions. Reject class-version fields on other reference kinds. Assessments/manifests add optional `academicCourse`; directly linked task/event manifests add `academicPlanning` with captured/current source metadata. Ordinary/older manifests omit both fields. Work text excludes recorded grades and class details; linked planner context projects only its own text.

Keep stale-reference errors, deleted/archived source errors and `CONTEXT_CONFLICT` visible; refresh versions and deliberately create a new assessment. Source/class changes can invalidate context without a planner version change. Detached study blocks retain origin labels. Incomplete legacy history and workload-plan blocks remain AI-blocked. Preserve owner-only selection, full inherited routing, no unavailable-provider fallback, explicit saved-answer consent and independent forget behavior. UI selection/offline integration and live dispatch remain pending.

## Backend handoff: offline Claude response inspection (2026-10-12)

Read [response boundaries](ai-claude-response.md). This decoder is internal preparation with no public endpoint or persisted/public contract change. A validated answer is guidance only, not evidence of provider readiness, tool isolation or completed accounting. Every result keeps dispatchEnabled=false, billing=unverified and accounting=unsettled; usageEstimate is an unverified estimate and must not be rendered as actual spend or a zero-dollar subscription receipt.

Invalid/blocked/error output can coexist with a usage estimate. Missing/malformed usage never means free execution. Preserve current unavailable-provider blocking, no fallback/resend, spending caps and per-request answer consent. Session IDs, native error text and other metadata are discarded. Native result persistence, effective runtime/account/model/billing verification and UI integration remain pending. Ten focused synthetic tests and existing OpenRouter protocol tests pass. Final npm run check passed lint, strict types, formatting, production builds and 445 API/client tests; one optional standard PostgreSQL test was skipped. Browser tests were not rerun for this backend slice because it changes no UI/authentication code. No owner database, native inference, real provider, paid AI or device tests were used. No UI/authentication code changes in this slice.

## Backend handoff: local runtime metadata doctor (2026-10-12)

Read [doctor boundaries](ai-runtime-doctor.md). This is an operator command, not a new public endpoint. Runtime JSON can report controls-advertised, missing-controls or probe-failed, but always keeps dispatchEnabled=false, isolation=unverified, account=not_checked and billing=unverified. Exit zero does not authorize inference or establish a working subscription.

The diagnostic exposes only bounded version/status/missing-control metadata and cannot be uploaded to clear readiness gates. Preserve current subscriptionRequirements/blockers, per-request answer consent, spending caps and no-fallback/no-resend behavior. Dedicated account/config/filesystem/network isolation, actual toolset/model/usage and confidential route verification remain pending. No UI/authentication code changes. Final npm run check passed lint, strict types, formatting, production builds and 401 API/client tests; one optional standard PostgreSQL test was skipped. Browser tests were not rerun because UI/authentication code was unchanged. Separate local version/help inspection succeeded for Claude 2.1.296/Codex 0.162.0. No owner database, subscription login, credential import, inference, paid AI or device tests were used.

## Backend handoff: subscription isolation requirements (2026-10-12)

Read [subscription preparation contracts](ai-subscription-isolation.md). Provider readiness and captured request readiness add nullable subscriptionRequirements={status:unverified,requestPreparation:claude-cli-draft|unavailable,checks:[...]}. Other/legacy records default null. Subscription profiles also add SUBSCRIPTION_ISOLATION_REQUIRED and SUBSCRIPTION_USAGE_VERIFICATION_REQUIRED blockers. A configured/approved profile or token-price quote does not establish subscription access or a zero-dollar invoice.

The Claude draft is internal preparation only; no executable, account, environment, working directory or runtime is selected. Codex preparation remains unavailable pending effective isolation checks. Do not show these requirements as passed or offer live submission. Preserve owner routing/labels, $50 ceiling/$0.25 initial allowance, explicit answer consent and no fallback/resend. No migration, UI/authentication code or public dispatch endpoint changes. Final npm run check passed lint, strict types, formatting, production builds and 391 API/client tests; one optional standard PostgreSQL test was skipped. Eight new focused preparation tests and existing provider-policy coverage passed. Browser tests were not rerun because UI/authentication code was unchanged. Only local CLI help was inspected; no owner database, subscription login, credential import, inference, paid AI or device tests were used.

## Backend handoff: offline charge-only recovery (2026-10-12)

Read [recovery contracts](ai-accounting-recovery.md). resultMetadata.status now includes unavailable: completed synthetic accounting, retained=false, answerCharacters=null and suggestionCount=null. protocolMetadata.outputState=validated may coexist with it because the original report was validated but its text was lost. Render availability separately from accounting; do not call unavailable text invalid or show an empty answer.

Recovery uses only recorded native usage, never resends or recreates/saves an answer. saveAnswer consent cannot fabricate missing text. Already-saved answers and forget tombstones survive recovery replay. Uncertain requests still cannot be hidden/cancelled until accounting settles. No public recovery/dispatch route or UI/authentication code is added. Native account/invoice verification, subscription isolation and confidential-route assurance remain pending. Final npm run check passed lint, strict types, formatting, production builds and 383 API/client tests; one optional standard PostgreSQL test was skipped. All ten new focused recovery tests passed, including concurrency, atomic rollback, populated migration and two persisted restarts. Browser tests were not rerun because UI/authentication code was unchanged. No owner database, real provider, paid AI or device tests were used.

## Backend handoff: offline protocol recovery observations (2026-10-12)

Read [recovery contracts](ai-protocol-recovery.md). Attempts add nullable protocolObservation. Reported observations carry generationId, native usage and outputState; uncertain observations carry nullable generationId and a bounded reason. Both identify synthetic OpenRouter test evidence. Old/byte-token attempts default null. Owned request reads/export include it; no public write/confirmation route is added.

Observations are immutable and advance only the attempt version. A reported observation may coexist with uncertain accounting after storage failure; it does not settle cost or prove an available/saved answer. Unknown identity stays null. Keep these states distinct and preserve explicit answer consent/forget, no automatic resend/refund and unavailable-provider blocking. Observations never contain model text or raw errors and cannot reconstruct a lost answer. Live lookup, verified invoices and charge-only lost-answer recovery remain pending. Final npm run check passed lint, strict types, formatting, production builds and 373 API/client tests; one optional standard PostgreSQL test was skipped. Eight new focused tests passed and existing restart coverage now checks observations. The initial ownership edge-case failure was corrected before the clean full run. Browser tests were not rerun because UI/authentication code was unchanged. No owner database, real providers, paid AI or device tests were used.

## Backend handoff: offline OpenRouter durable accounting (2026-10-12)

Read [accounting contracts](ai-openrouter-accounting.md). Attempt reads/export add nullable protocolMetadata={synthetic:true,protocol:openrouter,generationId,outputState}. Old/byte-token attempts default null. This identifies offline test accounting, not a working live provider or verified upstream. No submission/confirmation endpoint is added.

Provider-error produces failed accounting; invalid/blocked output can produce completed accounting with confirmed cost and no answer. Unknown billing/timeout/cancellation preserves the full uncertain hold and cannot trigger automatic retries/refunds. Actual reported overruns are visible through existing budget totals. Keep charges, valid answers and action completion distinct.

Preserve explicit saveAnswer consent, dedicated owned answer reads, independent answer version/forget tombstones and metadata-only request history. Native token counts are not answer byte lengths. Reconciliation/restart never restores forgotten text or resends. All new execution/results remain synthetic; live transport, subscription isolation and confidential-route verification are pending. Final npm run check passed lint, strict types, formatting, production builds and 365 API/client tests; one optional standard PostgreSQL test was skipped. All eleven new focused tests passed. The initial lint issues in test fixtures were corrected before the clean full run. Browser tests were not rerun because UI/authentication code was unchanged. No owner database, real providers, paid AI or device tests were used.

## Backend handoff: offline OpenRouter protocol verification (2026-10-11)

Read [protocol boundaries](openrouter-protocol.md). Public contracts and routes are unchanged; live dispatch remains disabled. Internal test results distinguish coherent reported billing from useful validated output. Provider errors, blocked output and invalid guidance can still have reported charges. Missing billing/transport failures remain uncertain and must never imply a refund or automatic retry. These protocol states do not settle existing durable attempts yet.

Preserve current budgets, per-request saveAnswer consent, answer read/forget, owner labels and unavailable-provider blocking. Text remains untrusted guidance without action authority. Subscription isolation, upstream/account verification, complete billing bounds and Prem confidentiality remain pending. Full npm run check passed lint, strict types, formatting, production builds and 354 API/client tests; one optional standard PostgreSQL test was skipped. Browser tests were not rerun because UI/authentication code was unchanged. No owner database, real providers, paid AI or device tests were used. No UI/authentication code changed in this slice.

## Backend handoff: spending ceiling and per-request saved answers (2026-10-11)

Read [provider/retention contracts](ai-provider-setup.md). Owner-confirmed monthly ceiling is $50; initial request allowance $0.25. Budget read includes hardMonthlyLimitMicros=50000000. Budget writes above it fail; old versions/receipts remain historical. Migration 040 initializes existing owners to these amounts and advances adjusted policy versions without erasing spend/holds. Fresh unsaved budgets remain blocked. Show the hard maximum and preserve drafts on conflicts.

Request submission accepts optional saveAnswer. Default is temporary; the owner must explicitly select save for each request. No retroactive/global consent exists. GET /api/v1/ai/requests/:id/answer returns consented saved output or its tombstone. DELETE takes operationId/current saved-answer version, not request version. It clears output with a metadata-only receipt. Forget does not edit request/attempt versions and there is no restore. Request hide retains the separately saved answer; forgetting memory does not erase independently saved answers. Keep these limits visible in relevant controls.

Saved text appears only in dedicated answer reads and records.aiSavedAnswers export. Status/history/receipts stay metadata-only. resultMetadata.retained describes saving at confirmation; refresh current answer state after forget/retry. Output remains untrusted guidance with no action authority. All current results are synthetic; live calls remain disabled. Shared profiles now declare subscription, OpenRouter and Prem-confidential modes, but configuration/credential presence does not prove account/model/route availability. OpenRouter requires a pinned upstream with no fallback; labeled context must not be silently rerouted. UI save/review/forget controls remain pending. Final npm run check passed lint, strict types, formatting, production builds and 343 API/client tests; one optional standard PostgreSQL test was skipped. All 45 isolated browser regressions passed. Nine new retention/provider-preparation tests passed in focused verification, and restart coverage includes saved answers. The historical above-ceiling retry regression was corrected and the clean full rerun passed. No real providers, paid requests, owner database resets or device tests were used.

## Backend handoff: verified AI context and fake text results (2026-10-11)

Read [verified AI contracts](ai-verified-context.md). Assessments and admitted attempts include nullable contextManifest with owned source versions, complete labels, character counts and projection/boundary identifiers; no text or private binding digest is included. Legacy/unassembled requests need a new assessment before admission. Keep lost-response operation IDs, but refresh current state after historical receipts. CONTEXT_CONFLICT requires a newly assessed request; silently changing the old request's sources/text is unsupported.

Explicit memory references use kind=memory, id, expectedVersion and required expectedMemorySettingsVersion. Fetch current memory settings; global and record enable are both required. Disable/re-enable/edit/forget invalidates pending context. No automatic memory selection/retrieval/index is enabled. Owner labels remain the routing authority; unavailable approved destinations never fall back.

Attempt resultMetadata is null for old/usage-only attempts or { synthetic:true, retained:false, status:validated|invalid, answerCharacters, suggestionCount }. Completed describes confirmed accounting; it does not guarantee valid output or successful delivery. Fake guidance is returned only once internally, never from public request detail/history/export. UI live submission/results, action writes and answer retention remain pending. Do not present fake completion as paid AI or agent work. Treat returned answers/notes as untrusted display text; they grant no tool/action authority. Final npm run check passed lint, strict types, formatting, production builds and 334 API/client tests; one optional standard PostgreSQL test was skipped. Sixteen new focused tests passed. The initial full run included the archived-routing preview regression; it was corrected and the clean full rerun passed. Browser tests were not rerun because UI/authentication-layer code was unchanged. No owner database, real providers, paid AI or device tests were used.

## Backend handoff: local responsibility schedules (2026-10-11)

Read [local schedule contracts](responsibility-local-schedules.md). PUT /api/v1/responsibilities/:id/local-schedule takes operationId, parent expectedVersion and rule { startDate, localTime, timeZone, frequency: daily|weekly, interval: 1-52 }. Saving preserves paused status. Weekly repeats on the start date's weekday. New schedule fields localRule/nextLocalIndex are nullable; check localRule before treating null intervalMinutes as one-time. Existing UTC schedule writes clear local fields; schedule:null clears pending pointers while retaining rule metadata and a tombstone.

Display local date/time/zone separately from the UTC nextDueAt. Compatible DST policy shifts gaps forward and chooses the earlier fold; offer accessible Help. Due preview remains read-only; selected admission creates one blocked placeholder and coalesces missed civil slots, never completed work. Schedule advancement changes schedule.version only; edits/replacement change parent version too. Keep lost-response operation IDs and refresh current records after historical receipts. Show pending/offline/conflict errors and unsupported/inconsistent schedule errors visibly. Closed sources remain excluded; no auto-resume/admission is enabled.

Migration 037 preserves old UTC schedules/receipts and export compatibility. UI/offline controls, background admission and actual agent execution remain pending. Focused verification: 23 tests passed, including eight new local tests; lint/types passed. Full npm run check passed lint, strict types, formatting, production builds and 318 API/client tests; one optional standard PostgreSQL test was skipped. Browser tests were not rerun because UI/authentication-layer code was unchanged. Optional PostgreSQL is unverified locally; no owner database/provider/device access occurred.

## Backend handoff: responsibility review inbox (2026-10-11)

Read [review inbox contracts](responsibility-inbox.md). GET `/api/v1/responsibilities/attention` returns server asOf, full owned active/paused/cancelled(nondeleted)/deleted root counts, dueCount and blocked/cancelled run totals. It is read-only, creates no notification and does not replace Today/planner reads. Counts describe stored state, not execution/completed work; executionEnabled=false always.

GET `/api/v1/responsibilities/runs/inbox`: status=blocked/cancelled/all (blocked default), trigger=manual/schedule/all, optional owned responsibilityId, limit 1–100 (25 default), paired after/expectedCursorVersion. Entries have historical run metadata plus current source id/version/title/status/deletedAt/complete labels and sourceChanged. No goal/prompt/result/provider/tool text is returned. Current source title/labels are not admitted snapshots; hashes/captured labels do not authorize disclosure. Counts apply trigger/parent filters but ignore selected status/page. Ordering is newest createdAt then UUID descending, with microsecond-safe cursor lookup. Source metadata may change without a cancelled run version changing. Filter-ineligible/foreign/missing anchors are 404; eligible version changes 409. Reset cursors on filters and guard delayed reads; never derive full totals from loaded rows.

POST `/api/v1/responsibilities/runs/dismiss-batch` takes stable operationId and 1–50 unique explicit run IDs/current run versions. All owned matching blocked runs cancel atomically with owner-dismissed/version+1 and one event each, or all roll back. Parent versions/schedule pointers remain unchanged. Return order is canonical run UUID; map by ID. Exact retries preserve original results without duplicate activity or touching new arrivals. Keep selection/request stable on lost response, refresh current inbox/attention afterward, and preserve conflict state for deliberate reload. Existing individual dismissal remains supported. Dismissal is not completion, execution, a provider retry or renewed permission.

Required states: blocked/executor unavailable, changed/closed/deleted current source, current versus captured metadata, selected pending dismissal, atomic conflict/rollback, retained deletion history, cursor unavailable, revoked/expired session and read/export error. No migration/dependency, offline cache/outbox integration, AI/MCP reference, notifications, background scheduler or live executor is added. Validation: npm run check passed lint, strict types, formatting, production builds and 310 API/client tests; one optional standard PostgreSQL test was skipped. Eight new focused tests passed, including microsecond ordering, current-source/full-count reads, atomic/overlapping/historical dismissals, pause races, rollback, owner/session/origin isolation and persisted restart/export. UI/authentication-layer code was unchanged, so browser tests were not rerun. PostgreSQL inbox/dismiss/attention coverage remains unverified locally; no owner database or real provider is accessed.

## Backend handoff: three responsibility milestones (2026-10-11)

Selected admission results follow canonical responsibility UUID order; map each run by responsibilityId rather than selection position.

Read [responsibility contracts](responsibilities.md). Migrations 034–036 add lifecycle, UTC review schedules and blocked run/activity history. No background scheduler/worker, agent/model/tool/provider execution or paid request exists. Do not display active as an agent working: it permits schedule previews and owner-invoked blocked placeholders only. No goal changes planner/study goals, settings, memory or email authority. All AI/MCP context refs remain unsupported.

Lifecycle `/api/v1/responsibilities`: POST creates paused records; GET lists title/metadata without goal; GET `/:id` includes full current owner text/tombstones; PUT edits title/goal/sensitivity, retains every applied label and cancels blocked runs. POST `/:id/resume|pause|cancel` and DELETE `/:id` use operationId/current parent version. Pause/cancel/delete invalidate blocked runs; resume never revives them. Cancelled/deleted records cannot resume/edit; no restore. Delete retains current goal/title/labels/history/export, unlike memory forgetting—keep this retention limit visible. Parent writes return metadata-only receipts; refresh detail after saving and after historical retries. No old goal-text revision inspection exists.

Schedule GET/PUT `/:id/schedule`: PUT uses parent expectedVersion and schedule `{ startsAt: UTC Z instant, intervalMinutes: null or 15–10080 }` or null to clear. Set/clear advances parent and schedule versions and cancels blocked runs; operational due admission advances schedule only. Cleared schedules retain metadata/tombstone; exhausted one-time schedules have null nextDueAt without deletion. Constant UTC intervals are elapsed time, not local daily/weekly/cron rules; DST may shift local clock time. Pause hides due work; resume exposes overdue work for deliberate admission, not automatic catch-up.

GET `/due` returns server asOf, full dueCount, items `{ id, version, title, scheduleVersion, nextDueAt }`, executionEnabled=false and nextAfter with all three cursor fields. POST `/admit-due` takes stable operationId and 1–25 unique explicit `{ id, expectedVersion, expectedScheduleVersion }` selections. All commit or roll back together. One-time pointers exhaust; repeating cadence coalesces missed slots into one blocked run and records skippedIntervals without claiming completed work. Already admitted timestamps remain consumed after replacement and return DUE_ALREADY_ADMITTED; offer a deliberate new start time, never an automatic retry. Future/exhausted/cleared schedules and stale versions conflict. Client clocks/filter-wide selection cannot authorize admission.

Manual POST `/:id/runs` uses parent version; run GET list/detail return metadata only and executionEnabled=false. POST `/:id/runs/:runId/dismiss` uses the run's own version; it cancels that blocked placeholder without moving parent/schedule versions. No result/dispatch/retry/confirmation route exists. Input hashes/captured labels are historical integrity metadata, not approval or current routing authority. Later parent labels must remain inherited in future context; current edits cancel blocked runs. Historic receipts may report blocked after cancellation—refresh current history.

Parent/run pages use limit 1–100 (25 default), paired after/expectedCursorVersion; due cursors also require expectedScheduleVersion. Missing/foreign/filter-ineligible anchors return 404; changed eligible versions return 409. Activity GET `/:id/activity` uses immutable UUID cursor and has no goal/result text. UUID order is pagination order, not chronology; display timestamps and never imply before/after goal text or real execution. Reset cursors on filters and guard delayed reads. Export adds four default-empty arrays for roots/schedules/runs/activity, including tombstones/current private text. No offline cache/outbox integration is added; existing task behavior remains.

Required states: paused, scheduling enabled with executor unavailable, closed/deleted, due/exhausted/cleared schedule, coalesced missed intervals, blocked placeholder/cancel reason, missing historical goal text, conflict/reload, rollback/error, revoked/expired session and retained deletion content. UI integration, provenance/routing/retrieval, budgets/permissions, leases/background dispatch, real results and provider reconciliation remain pending. Validation: npm run check passed lint, strict types, formatting, production builds and 302 API/client tests; one optional standard PostgreSQL test was skipped. All 15 focused tests passed, covering ownership/session/SQL isolation, lifecycle, schedules, atomic/conflicting/concurrent/historical receipts, labels, invalidation, paging, rollback, consumed slots, migration/export compatibility and restart. Optional PostgreSQL create/admit/cancel/export coverage remains unverified locally. UI/authentication-layer code was unchanged, so browser tests were not rerun. No owner database or real provider is accessed.

## Backend handoff: editable memory (2026-10-11)

Memory kinds describe saved text only: goals do not change study-plan budgets/class progress, preferences do not automatically apply app settings, and facts are not verified provider records. Keep these controls separate from actual planner/settings actions.

Read [memory contracts](memory.md). New owned `/api/v1/memory` POST/GET, `/:id` GET/PUT/DELETE and `/settings` GET/PUT support manual preferences/goals/facts, correction, disable and forgetting. Fields: kind, title (trimmed 1–160), content (trimmed 1–4000), observedOn nullable date, enabled default true, sensitivity default unlabeled. Server source=owner-entered/createdAt is recording provenance, not proof of AI-safe origin. All applied labels are retained through edits; no client label-history/source overrides are accepted. Global settings default disabled/version 1. Global and record versions are independent; disabling does not erase saved text and enabling never starts AI.

Every write needs a stable operationId; edits/settings/forget need expectedVersion. Memory writes return only `{ memory: { id, version, deletedAt } }`, never title/content in receipts. Fetch detail after saving; preserve the exact request on lost response. Historical receipt retries cannot expose/restore forgotten content, but may carry older versions/state. Refresh current settings/detail before presenting current authority. Conflict drafts stay local until deliberately discarded/reloaded. No memory cache/outbox integration exists; preserve current planner/task offline behavior.

Forgetting clears title/content/observedOn, disables and retains a metadata/label tombstone. New edits/deletes after forgetting return MEMORY_FORGOTTEN; old successful receipts stay metadata-only. No restore exists. A deliberate new save can create a new record. Detail/export/forgotten pages have null text/date. Keep the essential retention limit visible: this removes logical memory text, not pre-existing backups/downloads/device copies, independent duplicates or forensic database remnants. No retrieval/embedding copies exist yet; future integration must invalidate derived copies before disclosure. Never promise permanent erasure of all copies.

GET pages use state=active/disabled/forgotten/all (active default), optional kind/current sensitivity/q, limit 1–100 (25 default), paired after/expectedCursorVersion and nextAfter. Literal case-insensitive q searches title/content; pages omit content/snippets. Counts are full matching active/disabled/forgotten totals independent of selected state/page. Active means per-record enabled/not forgotten, even while global settings are disabled; it does not mean used by AI. Reset cursors on filter changes; guard delayed reads. Filter-ineligible/foreign/missing cursors return 404; changed eligible versions return 409. All reads require session/owner authorization.

Required UI states: unsaved/conflicting correction, saving/refreshing, global disabled, record disabled, forgotten/non-restorable tombstone, missing provenance/AI unavailable, revoked/expired session, unavailable detail and read/export failure. No AI memory reference, extraction, model-generated writes, MCP retrieval or provider call is enabled. Export adds memories and memorySettings; older files default empty/null. Validation: npm run check passed lint, strict types, formatting, production builds and 287 API/client tests; one optional standard PostgreSQL test was skipped. Nine new memory tests also passed in a focused run. PostgreSQL create/forget/retry/export coverage remains unverified locally. UI/authentication-layer code was unchanged, so browser tests were not rerun. No owner database reads/resets, real providers, paid AI or device tests occurred. UI controls, AI provenance/routing integration, retrieval invalidation and backup retention remain pending.

## Backend handoff: email attempt lifecycle (2026-10-11)

Read [email attempt contracts](email-attempts.md). Migration 032 adds test-only synthetic attempt history; no send/retry/confirmation endpoint, worker or live adapter exists. New GET `/api/v1/email/drafts/:id/attempts` and `/attempts/:attemptId` use owned consistent snapshots, metadata-only results and tombstone history. UUID pages use limit 1–100 (25 default), paired after/expectedCursorVersion and nextAfter. Missing/foreign/wrong-draft cursors return 404; confirmation changes version and stale cursors return 409. Pages never return body, subject, sender, recipients/Bcc or callback errors.

Shared attempt fields: id, draftId, draftVersion, contentHash, approvalId, historical approvalVersion, adapter=synthetic, status=uncertain/sent/not-sent, version, createdAt, updatedAt, finishedAt. Export adds default-empty emailAttempts. Synthetic sent/not-sent do not establish real delivery. Initial uncertain claim consumes the revision before the sole callback; uncertainty survives failures/restart. Exact retries return history without re-dispatch. Even not-sent cannot renew approval or trigger a retry; only a deliberately new saved/reviewed revision can get another synthetic attempt.

Send preview adds attempt (current revision or null), approvalState consumed, EMAIL_ATTEMPT_EXISTS and EMAIL_DELIVERY_UNCERTAIN. Explicit older approvals still report stale. All sender/capability/execution blockers remain; executionEnabled=false always. Draft status approved indicates review, not unused send permission. Fresh approval on an attempted revision returns EMAIL_ATTEMPT_EXISTS; historical successful mutation receipts retain original results, so refresh current draft/preview/history before showing present authority.

Required states: synthetic/testing, uncertain requiring review, confirmed synthetic outcome, conflict/reload, unavailable history, revoked/deleted session, changed/deleted draft and prior retained revisions. Keep uncertainty and cancellation limits visible: later edit/delete/revoke cannot retract an already claimed dispatch. Never automatically resend, put sends in the offline task outbox or silently replace the claimed payload with newer text. Existing planner/task offline behavior is unchanged. UI review, live verification/reconciliation, attachment/provider payload support and permanent erase remain pending. Validation: npm run check passed lint, strict types, formatting, production builds and 278 API/client tests; one optional standard PostgreSQL test was skipped. All ten new attempt tests also passed in a focused rerun. Tests cover concurrent claims/edits, exact approval gates, uncertainty/confirmation/rollback, owned guarded history/session/SQL constraints, export, populated upgrade and persisted restart. Optional PostgreSQL claim/confirmation/export coverage remains unverified locally. UI/authentication-layer code was unchanged, so browser tests were not rerun. No owner database reads/resets, real providers, paid AI or device tests occurred.

Started 2026-10-10. This is a handoff record for the later UI rewrite, not a design specification. Read [product scope](product.md), [development](development.md), [backlog](backlog.md), and [planner behavior](planner.md) alongside it. Entries describe implemented behavior unless explicitly marked pending.

## Backend handoff: email draft approvals (2026-10-11)

Backend implemented; UI review and actual sending remain pending. Read [contracts and boundaries](email-drafts.md) and shared emailMessage/emailDraft/emailApproval/request/page/send-preview schemas.

- `/api/v1/email/drafts` supports owner create/list; `/:id` supports current detail/full-message update/delete; `/:id/restore` preserves tombstones/history. Message fields: connection, declared purpose, sender, ordered To/Cc/Bcc, subject, plain body, empty attachments and owner label. 1-50 combined unique recipients, subject <=200 without CR/LF/null, body <=12000 without null. Display normalized stored fields before review; preserve body whitespace. Unsupported attachments/HTML mode/source refs/headers/credentials are rejected. Purpose does not generate provider calendar invitations.
- `/:id/approve` needs exact current draft version/hash and decision approve-exact-message plus operation ID. Show sender, all recipient lists including Bcc, subject/body and explicit no attachments; do not infer approval from draft saving, calendar authority or policy preview. Future AI tools must not approve on the owner's behalf. UI approval controls are not yet implemented.
- Every save, including same-message/label-only edits, delete or restore invalidates approval and captures a new immutable revision. Restore returns pending. `/:id/approvals/:approvalId/revoke` guards the approval version; approval/revoke do not advance draft content version. Reapproval after revocation is a new explicit action. Keep exact uncertain requests; historical receipts never revive current approval and must not overwrite newer drafts.
- Draft list returns body/recipient-address-free summaries, UUID paging, limit 1-100/default25, deleted=false/true/all and paired cursor UUID/version. Cursor guards content versions, not approval-state changes. Revisions metadata pages ascend by version with afterVersion; full `/:id/revisions/:version` shows the referenced approved message. Approvals metadata pages use UUID/version guards. Keep pending/conflict/errors visible, reset/refresh after writes and guard delayed reads; pages are not frozen.
- `/:id/send-preview` takes current draft version plus optional approval ID/version. Reports missing/current/revoked/stale, always blocked/executionEnabled false. Current approval still has sender-unverified, send-capability-unverified and execution-unavailable blockers. No send endpoint, queue/worker, consumption, delivery claim or uncertain-send reconciliation exists. Do not add a Send control implying delivery works.
- Migration 031 and export arrays emailDrafts/emailDraftRevisions/emailApprovals retain body/Bcc/revisions/tombstones/approval history. Delete hides rather than erases history; permanent erase/retention controls are pending and this limitation must be visible. Routes stay online-only/outside cache/outbox/AI references. No hosted text provenance, model dispatch, mailbox access, attachments or device delivery is implemented.

Validation: `npm run check` passed lint, types, formatting, production builds and 268 API/client tests; one optional PostgreSQL test was skipped. Twelve new isolated tests cover exact approval/field invalidation, strict text/unsupported AI refs, ownership/sessions/foreign keys, concurrent/historical receipts, edit races/atomic rollback, integrity/export rejection, guarded history, tombstones/export, populated migration upgrade and restart. PostgreSQL distinct/duplicate approval, edit invalidation/preview/export coverage remains unverified locally. Browser tests were not rerun for unchanged UI/authentication-layer code. No owner database reads/resets, real mailbox/provider calls, paid AI or device tests occurred.

## Backend handoff: typed action permissions (2026-10-11)

Backend settings/preview implemented; UI controls and execution/approval workflows remain pending. Read [contracts and limitations](ai-actions.md), `aiActionSettingsSchema`, `aiActionWriteSchema`, `aiActionPreviewRequestSchema` and `aiActionPreviewResponseSchema`.

Subsequent backend slice: exact-message email draft review records are implemented separately above. The action authority preview does not grant, accept or consume those approvals; general action execution/approval integration remains pending.

- GET/PUT `/api/v1/ai/actions` reads/saves complete owner policy with optimistic versions/receipts. Defaults: tasks blocked, calendar automatic, email approval-required. Task/calendar modes are configurable; email cannot be relaxed. Manual owner planner operations remain available. Preserve drafts on conflict and exact uncertain-write requests; refresh after historical retries.
- POST `/api/v1/ai/actions/preview` requires current policy version and a strict descriptor. Hub tasks and local/external calendar create/update/delete/restore plus external email.send are typed. Calendar outboundEmail is none/invitation/attendee-update/cancellation. No content, source IDs, client capability or approval flags are accepted. Invalid combinations return 400; stale policies conflict.
- Keep policyDecision, writeCapability, emailApprovalRequired and executionEnabled separate. Local means manual hub operations exist; Canvas is read-only, external mail/calendar writes are unverified. Every result has executionEnabled false and ACTION_EXECUTION_UNAVAILABLE. Calendar authority never authorizes outbound email; declared sends/invitations/attendee updates/cancellations require separate actual-payload approval. Hub outbound email is unsupported. A none descriptor does not prove provider suppression.
- Previews are not persisted, queued or executed and create no receipt. They do not verify target versions, content provenance, routing, budget, consent or retention. No approval token/workflow or live action gateway is implemented. Keep blockers visible, guard delayed reads and retain separate gateway limitations.
- Migration 030 adds policies; export adds records.aiActions, nullable/default-null for older files and current/default owner settings in new exports. Routes stay online-only/outside cache/outbox/AI references. Ordinary offline planner edits retain their behavior. No provider, paid AI or device calls are added.

Validation: `npm run check` passed lint, types, formatting, production builds and 256 API/client tests; one optional PostgreSQL test was skipped. Nine new isolated tests verify permission/capability/email boundaries, strict requests, owner/session isolation, conflicts/concurrent/historical receipts, unchanged manual planner access, export compatibility, populated upgrade/SQL constraints and persisted restart. Optional PostgreSQL policy/preview/export coverage remains unverified locally. Browser tests were not rerun for unchanged UI/authentication-layer code. No owner database reads/resets, real providers, paid AI or device tests occurred.

## Backend handoff: task browsing and selected changes (2026-10-11)

Backend implemented; UI integration remains pending. Read [contracts and behavior](task-management.md), `taskBrowseQuerySchema`, `taskBrowseResponseSchema`, `taskBatchRequestSchema` and `taskBatchResponseSchema`.

- GET `/api/v1/tasks/browse` accepts status all/open/completed, priority all/low/normal/high, due any/dated/undated, limit 1-200/default 50, and paired cursor UUID/version. It returns full active task records ordered open first, deadlines ascending/undated last, then UUID. Total/open/completed counts apply priority/due filters across all pages and ignore status selection. The older task list keeps its ordering. Use the separate agenda for local deadline buckets.
- Anchors must still match all selected filters and be undeleted/owned; unavailable anchors return 404, changed eligible versions return conflict. Reset cursors after filters/refresh/writes, guard delayed responses, and retain drafts. A page/count snapshot is consistent; multiple pages are not frozen.
- POST `/api/v1/tasks/batch` selects 1-100 unique explicit IDs/current versions and one action: update with at least one completed/priority/dueDate field, or delete. Omitted fields remain unchanged; null clears the deadline. All selected versions must match, or the whole transaction fails. Do not infer selection from matching totals or show partial success. Returned full tasks/tombstones preserve input order; successful no-op assignments still advance versions.
- Titles, notes, sensitivities, captured/current source metadata and labels remain intact. Completion does not submit academic work, reduce estimates, imply mastery or change imported facts. Deadline changes do not reschedule explicit reminders. Deletion uses ordinary tombstones; restore is per-item. Worker suppression/reopening rules remain unchanged.
- Preserve the exact complete request/operation ID after a lost response. Historical receipt replies may be older than current records; refresh before further actions and keep newer local drafts. Reusing a saved operation ID with changed payload/order returns operation conflict. Retain selection on stale/missing errors and reload before a deliberate new selection/action.
- New APIs are online-only, outside cache/outbox/AI allowlists. Show offline/pending/conflict/errors; server counts exclude queued individual edits. Existing linked-task outbox edits remain. UI batch controls, offline replay and live AI actions are not implemented. No migration/provider/dependency or device changes are added.

Validation: `npm run check` passed lint, types, formatting, production builds and 247 API/client tests, with one optional PostgreSQL test skipped. Eleven new isolated tests cover full counts/paging, strict requests, ownership/session isolation, atomic/conflicting/concurrent writes, durable historical receipts, inherited academic/Canvas provenance, tombstones/restore/export, reminder suppression and restart. PostgreSQL duplicate/competing batch and completed-browse coverage is added but unverified locally. Browser tests were not rerun for unchanged UI/authentication-layer code. No owner database reads/resets, real providers, paid AI or device tests occurred.

## Backend handoff: task agenda and Today attention summary (2026-10-11)

Backend implemented; UI integration remains pending. Read [contracts and boundaries](today-summary.md), `taskAgendaQuerySchema`, `taskAgendaResponseSchema`, `todaySummaryQuerySchema` and `todaySummarySchema`.

- GET `/api/v1/tasks/agenda` requires local `asOf`/exclusive `to` (1-31 days), optional bucket all/overdue/today/upcoming/later/undated, limit 1-200/default 50, and paired cursor ID/version. All active incomplete tasks count, including later/undated; totals are independent of page/bucket. Entries retain full task metadata/provenance. Deadlines sort ascending then UUID, undated last. Changed cursor versions return conflict; completed/deleted/foreign/wrong-bucket anchors return 404. Preserve filters, reset after date/filter/refresh changes, retain drafts and guard delayed responses. Pages are not frozen.
- GET `/api/v1/today/summary` takes only the same date horizon, returning consistent owned task totals, manual academic agenda totals, reminder queued/running/paused/failed/due counts, full unread count, latest three unread notifications and worker state. Tasks include later deadlines; academic counts exclude deadlines at/after `to`. Missing dates/estimates stay explicit. Reminder state is current at server `generatedAt`, independently of the date horizon. Reads never deliver reminders, mark read or create receipts.
- Preserve the existing UI's seven upcoming dates by using `to=today + 8` for an exclusive bound. Keep Calendar and imported-source reads independent: the summary explicitly excludes both. Scope warnings belong in accessible Help; pending/error/conflict and unhealthy worker state remain visible. A queued/due count does not guarantee target availability or delivery.
- Open linked tasks remain open after assignment submission/class archival; do not infer submission from task completion or deduplicate independent records. Source-label propagation can invalidate task cursors/edits. The two new routes remain outside offline cache/outbox and AI references; server counts do not include queued local drafts. Existing Today UI/caching is unchanged. More than 5000 eligible academic inputs blocks the complete summary; unavailable is not zero.

Validation: `npm run check` passed lint, types, formatting, production builds and 236 API/client tests; one optional standard PostgreSQL test was skipped. Nine new isolated tests cover boundaries/paging/full counts, owner/session isolation, source metadata/lifecycle, read-only state and receipts, precise inbox ordering, worker health, size blocking and persisted restart. Compiled API smoke verification passed for task paging/conflicts and independent academic/reminder/unread attention with network calls forbidden. Standard PostgreSQL route coverage is added but unverified locally; no owner resets, real providers, paid AI or device tests occurred.

## Backend handoff: academic planning, reports and reminders (2026-10-11)

Backend implemented; new UI controls remain pending. Read [planning contracts](academic-planning.md), [reminder contracts](academic-reminders.md) and shared `academicPlanningWriteSchema`, `academicPlanningResponseSchema`, `academicPlannerSourceResponseSchema`, `academicPlannerWorkResponseSchema` and `academicPlannerSummarySchema`.

- POST `/api/v1/academic-work/:id/planner-work` requires operation ID, current work/class versions and explicit task fields (`kind: task`) or planned one-time timed Calendar input (`kind: study`, same initial class, at most 180 minutes). Defaults do not copy source text/dates. Only open undeleted work in an active class creates items. Preserve drafts on errors and exact retry identities. Item/snapshot/link/receipt are atomic; different operation IDs deliberately create separate items.
- Tasks/Calendar/legacy events add nullable `academicSource` summary metadata; old records default null. Full reads at `/tasks/:id/academic-source` and `/calendar/:id/academic-source` include owned tombstones, current item version/deletion and optional `expectedVersion`. Distinguish captured/current work facts, original source class versus current block class, deletion/archive and known label history. `changed` compares source versions, not individual fields. Null means no direct academic link, not zero planning influence.
- GET `/academic-work/:id/planner-work` pages current records/snapshots by link UUID (limit 1-200/default 50, `after`, `deleted=false|true|all`). Completed/cancelled items remain visible; source deletion/closure/archive retains history. Owned cursors survive target deletion-state changes; reset after creation/filter changes and guard delayed responses. Pages are not frozen.
- Source changes preserve owner planner fields. Completion never implies submission, grade, estimate reduction or mastery. Direct links differ from automatic plan workload inputs. Labels survive source changes, deletion/restore, detachment and new class/topic/occurrence links; new masked labels advance versions once. Retain offline task drafts on source-label conflicts. Unknown event history remains null; no unlink/existing-item attachment endpoint exists.
- GET `/academic-work/:id/planner-work-summary?from=&to=&timeZone=` reports 1-31 local days. Task/root-record counts cover all linked history; timed occurrence counts/minutes cover the range, with recurrence/exceptions and DST clipping. All-day counts are separate from minutes; overlaps sum as recorded. Source estimates/status are independent. Keep report limitation codes available with Help; oversized reads return `ACADEMIC_WORK_TOO_LARGE`, not partial/zero totals.
- Export adds default-empty `academicPlannerSources` with tombstones/history. Full new APIs remain online-only; embedded source metadata in cached task/Calendar snapshots is historical offline. Ordinary linked-task edits retain the outbox. Every direct academic task/event remains AI-blocked (`PROVENANCE_UNAVAILABLE`), even unlabeled/detached records; planning labels do not verify text origin.
- Reminder writes accept `academic-work`, owned work ID and explicit scheduled instant, with no occurrence date or inferred deadline time. Create/reschedule/resume/retry rechecks availability (`TARGET_UNAVAILABLE`); snooze retains the existing `REMINDER_TARGET_UNAVAILABLE` code. Delivery serializes against source changes and suppresses closed/deleted/archived targets. Reopening/restoring never revives cancelled reminders; parent snooze history remains.
- New academic reminder creation controls are pending; existing rescheduling preserves an API-created academic link. In-app/open-view browser delivery boundaries remain; native/closed-app/Kompakt verification is pending. Migrations 028/029 preserve data/receipts. Verified text provenance, automatic matching/optimizer allocation and provider execution remain pending.

Validation: `npm run check` passed lint, types, formatting, builds and 227 API/client tests; one optional standard PostgreSQL test was skipped. All 45 isolated browser regressions passed, including preserved academic reminder targets and source-label conflicts retaining offline task drafts. Twenty-four new API tests cover planning/reports/reminders, with populated upgrades, rollback, restart, export and owner isolation. Final lint/types/formatting also passed after browser-test changes. A compiled API smoke check applied all 29 migrations in memory and verified linked planning, provenance/report/export, label conflicts, reminder delivery/suppression and historical receipts with network calls forbidden. Standard PostgreSQL coverage remains unverified locally; no real providers, paid AI, owner resets or device tests occurred.

## Backend handoff: academic deadline agenda (2026-10-11)

Backend implemented; UI wiring remains pending. See [agenda contracts](academic-agenda.md), `academicAgendaQuerySchema` and `academicAgendaResponseSchema`.

- GET `/api/v1/academic-work/agenda` requires local date-only `asOf` and exclusive `to` (1-31 days). Optional active owned `courseId`, `bucket=all|overdue|today|upcoming|undated`, limit 1-200/default 50. It includes all older overdue work plus dates before `to` and unknown deadlines; submitted/cancelled/deleted work and archived classes are excluded.
- Entries expose current work/class versions, titles, planning fields, labels and bucket, without notes or grades. Deadlines sort ascending, then ID; undated last. Keep manual work distinct from Canvas/task deadlines and Calendar reservations. No submission/mastery inference or estimate decrement occurs.
- Summary counts/minutes cover all relevant buckets, independent of paging/selected bucket. Null dates/estimates are unknown; zero estimates are known. Counts are not complete school workload: retain `MANUAL_RECORDS_ONLY`. More than 5000 relevant open records blocks with `ACADEMIC_WORK_TOO_LARGE`; unavailable totals are not zero.
- Send both `after` and `expectedCursorVersion` from `nextAfter: { id, version }`. Reset on refresh/filter/date changes, retain drafts and guard delayed responses. Unknown/no-longer-eligible cursors return 404; changed eligible cursor versions return `VERSION_CONFLICT`. Pages are not a frozen snapshot; refresh after changes.
- Reads remain online-only and outside cache/outbox/AI references. Preserve pending/offline/error/conflict states. Archived work remains readable through existing history/detail routes. UI/offline agenda, provider completeness and automatic reconciliation remain pending.

Validation: final `npm run check` passed lint, strict types, formatting, builds and 203 API/client tests; one optional PostgreSQL test was skipped. All 43 isolated browser tests passed. Six new agenda tests verify boundaries/missing data, paging/version conflicts, full counts, ownership, lifecycle and size blocking. Standard PostgreSQL agenda coverage is added but unverified locally. No real providers, paid AI, owner resets or device tests occurred.

## Backend handoff: durable study workload source history (2026-10-11)

Implemented backend contracts; UI controls remain pending. Read [workload source history](study-workload.md) and `packages/contracts/src/study-workload.ts`. Migration 027 preserves old records/receipts and leaves unknown history unknown.

- New drafts capture planning-field snapshots for every eligible workload contributor, including classes with no allocated blocks. Deliberate draft revisions replace the snapshot atomically; approved/cancelled/hidden history is retained. A known empty context differs from legacy unavailable history. No full draft revision timeline exists.
- GET `/api/v1/study/plans/:id/workload` includes owned hidden plans. GET `/api/v1/calendar/:id/workload` includes owned event tombstones and survives block edits, class/topic detachment and cancellation. Both use `studyWorkloadResponseSchema`.
- `history` is `captured`, `unavailable`, or `not-linked`. Captured with zero sources is known empty; null/unavailable and no durable event link are not proof of zero inputs. Show context capture time/revision, source count, and plan ID/version/status/hidden state separately from current event versions/deletion.
- Each source has `snapshot`, `current`, and `changed`. Current facts include deletion/class archival and all work statuses. Changed means a work/class version differs, including edits to uncopied fields. Label the view "Plan workload inputs"; these are ranking dependencies, not assignments specifically allocated/completed by that block. Use the work ID with the academic-work detail route for editing.
- Paging uses `limit` 1-200 (default 50), work UUID ascending, `after` and nullable `nextAfter`. Send `expectedPlanVersion` on later pages. Draft revision can invalidate the version or remove a cursor: retain the owner draft, reset paging and reload on `VERSION_CONFLICT`/404. Guard late responses. Each response is consistent; current facts can change between pages.
- Missing/incomplete workload history blocks approval with `STUDY_WORKLOAD_UNCAPTURED`/`PROVENANCE_UNAVAILABLE`, in addition to existing stale-context checks. Require a fresh preview and deliberate revision; no automatic reconstruction is shipped. Approval creates blocks and context links together; exact retries do not duplicate sources/blocks.
- New work/class labels propagate through source links to other-class, detached and deleted blocks without replacing their titles, notes, times or study status. Masked labels advance block versions too, so Calendar saves can conflict and cancellation can preserve later versions. Source deletion/restore and class archival retain links. There is no unlink or source-history purge endpoint.
- Snapshots copy dates, effort, importance, status, IDs/versions and labels only; no titles, notes or grades. Export adds three default-empty arrays: `studyWorkloadContexts`, `studyWorkloadSources`, `studyEventContexts`, retaining hidden plans/deleted blocks. Existing export limits apply.
- All reads remain online-only and outside cache/outbox. Pending/offline/errors, missing versus zero estimates, changed/deleted/archived sources and unavailable history must stay explicit. Captured planning history does not approve source text for AI: retain `ACADEMIC_WORK_PROVENANCE_INCOMPLETE` and `academicLabels: null`; gateway context remains blocked. UI wiring, offline history, assignment allocation/task creation and verified source-content provenance remain pending.

Validation: final `npm run check` passed lint, strict types, formatting, builds and 197 API/client tests; one optional PostgreSQL test was skipped. All 43 isolated browser tests passed with migration 027. Ten additional study tests and extended restart coverage verify source capture/history, ownership/paging, lifecycle/label propagation, atomic rollback/retry and populated upgrade. Standard PostgreSQL coverage is added but unverified locally. No real providers, paid AI, owner resets or device tests occurred.

## Backend handoff: academic workload in study previews (2026-10-11)

Backend integration is implemented; study UI controls remain pending. Read [study contracts](study.md#academic-workload-signals-implemented-2026-10-11) and `studyWorkloadSchema` before displaying priorities.

- Priority `academicWork` summarizes eligible open records: open/overdue/due-soon counts, earliest known deadline, known full estimated minutes, missing date/estimate counts and highest priority. Historical drafts return null (not evaluated), not zero. New previews with no eligible work return zero counts and null earliest date/priority.
- Overdue is before the requested local `from`; due soon includes `from` through 14 days later. These are class-ranking signals, not guarantees of meeting assignment deadlines or assignment-specific block links. Work priority/effort reasons are explanatory, not measured learning progress.
- Keep `ACADEMIC_DEADLINES_MISSING` and `ACADEMIC_ESTIMATES_MISSING` warnings visible alongside existing capacity/external-calendar warnings. Zero is a known estimate; null is unknown. Label `estimatedOpenMinutes` as estimated open workload, never remaining effort. Calendar time does not reduce this estimate or mark work submitted.
- Weekly goal budgets, full sessions, breaks and daily caps retain their behavior. Zero goals remain disabled. Submitted/cancelled/deleted work and archived classes do not contribute. Scores, titles and notes are not read for ranking.
- Academic changes can yield `STUDY_CONTEXT_CONFLICT`; retain the draft and require a fresh preview followed by deliberate revision. Academic writes share approval's schedule lock; exact receipt retries preserve their original result. Previously saved snapshots remain historical. A `413 STUDY_TOO_LARGE` means unavailable, not a partial or empty plan.
- Workload influences allocation across classes. Show `ACADEMIC_WORK_PROVENANCE_INCOMPLETE` before approval: generated blocks are unavailable to AI pending verified source-content provenance. Durable planning snapshots/source links are now implemented in the handoff above. Approved blocks capture the strongest contributing work label and `academicLabels: null`, so the gateway blocks them with `PROVENANCE_UNAVAILABLE`. Keep manual Calendar editing available; do not treat null as unlabeled. No-work approvals retain existing class/topic inheritance.
- Study APIs remain online-only and outside the AI context allowlist. UI wiring, per-assignment allocation, deadline guarantees, imported workload estimates, offline drafts and provider conflict checks remain pending. No new migration/dependency is required.

Validation: final `npm run check` passed lint, types, formatting, builds and 187 API/client tests; one optional PostgreSQL test was skipped. All 43 isolated browser tests passed. Nine new study tests cover workload scoring/exclusions, unknown versus zero, disabled goals, stale drafts/revision, retained estimates after calendar approval, historical snapshots/export, size blocking, edit/approval serialization, receipt replay and explicit AI provenance rejection. Standard PostgreSQL coverage is added but unverified locally. No provider calls, paid AI, owner resets or device tests occurred.

## Backend handoff: manual academic work (2026-10-11)

Implemented backend contracts; UI integration is pending. See [academic-work contracts](academic-work.md). Use these for class portfolios while keeping manual work, imported Canvas assignments, personal tasks/calendar blocks, recorded scores and self-reported topic confidence distinct.

- Create `/api/v1/academic-work` with `academicWorkWriteSchema`; edit `PUT /:id` with `academicWorkUpdateSchema`. Editable fields: courseId, title, kind, notes, nullable dueDate/estimatedMinutes, priority, status, grade and sensitivity. Record origin is `owner-entered`. The class is immutable; create/edit require an active owned class.
- PUT replaces fields; send current editable values and explicitly include status/grade plus expectedVersion/operationId. Do not send record metadata. Null deadline/estimate/grade means unknown, while zero effort/earned points is known. Score input supports four decimal places, nonnegative earned and positive possible points (up to 1000000). Scores require submitted status; returning to an open status requires deliberate grade clearing. Extra credit is allowed.
- GET `/:id` reads current active/tombstoned work. DELETE `/:id` and POST `/:id/restore` use operationId/expectedVersion. Preserve retry identity and drafts; require review for conflicts. Restore into an archived class is blocked. Class archival retains historical records/scores; do not present them as current actionable work without the class state.
- GET collection supports courseId/status/deleted filters, limit 1-200/default 50, and owned before cursors. `academicWorkListSchema` returns work/nextBefore. No status filter means all statuses. Reset cursors on refresh/filter changes, retain filters when loading more, guard delayed responses, and distinguish empty from failed reads.
- GET `/api/v1/courses/:id/work-summary?asOf=<local date>` separates submissions, scores, overdue open work, unknown deadlines/estimates and known estimated open minutes. Estimates are full owner estimates, not measured remaining work. `recordedPointsPercent` is null without scores; it is a recorded-points ratio, not a final class grade or mastery. Keep `MANUAL_RECORDS_ONLY`/`NOT_FINAL_CLASS_GRADE` available with score details and extra-credit warnings visible where material. A failed/oversized summary means unavailable, not zero.
- Label history inherits class labels and survives later relabeling and deletion/restoration; propagation advances versions even when the display label is unchanged. Export includes records/tombstones; these APIs remain outside offline caching/outbox and AI reference allowlists.
- Open manual deadlines/effort now inform deterministic class ranking in study previews; see the handoff above. Explicit source-linked task/study creation is implemented in the latest handoff. Pending: UI wiring, offline edits, Canvas reconciliation, automatic per-assignment allocation, live grades/submission sync and any AI processing. No automatic provider write, mastery inference or deletion purge is shipped.

Summary copy: `ungradedSubmittedCount` is the number of submissions without a manually recorded score. Display "Score unknown" or "No recorded score"; it does not prove that the school has not graded the work.

Validation: full `npm run check` passed lint, strict types, formatting, builds and 178 API/client tests, including 14 new academic-work tests; one optional PostgreSQL test was skipped because its isolated test URL is unset. All 43 browser tests passed with migration 026. Coverage includes corrected default history filtering, owner isolation, duplicate/competing writes, grade validation, missing/zero distinctions, summary bounds, immutable classes, retained labels/tombstones, archive behavior, exact paging, export, populated migration upgrade and persisted restart. PostgreSQL concurrency coverage is added but unverified locally. Tests used synthetic isolated databases with no provider calls, paid AI, owner resets or hardware verification. UI integration remains pending.

## Backend handoff: reminder snooze and inbox history (2026-10-11)

Implemented backend contracts; UI integration is pending. See [snooze/history behavior](planner.md#snooze-and-inbox-history-backend-implemented-2026-10-11). Shared schemas are in `packages/contracts/src/reminder-inbox.ts`. Reminder records/export add nullable `snoozedFromId`, default null for older records.

- Snooze: `POST /api/v1/reminders/:id/snooze` with `{ operationId, expectedVersion, scheduledAt }`. Use the delivered reminder ID/current version, not the notification ID. `GET /api/v1/reminders/:id` supplies `reminderResponseSchema` for detail/conflict recovery. Response includes source reminder (delivered, advanced version), new queued reminder, and source notification (read). Choose a future explicit instant within 365 days; local-time UI must reject DST gaps and ask for an offset during folds as Calendar does.
- One child per delivery. Snooze preserves targets/occurrence dates without moving deadlines/events. After delivery, the child can be snoozed; cancelling it does not make the source eligible again. Completed/deleted/cancelled targets reject snooze; later changes can suppress delivery. Delivery remains a durable inbox record, not proof of a system alert.
- Preserve exact path/payload/operation ID on uncertain/lost-response retry. Disable competing actions while pending. Show time/state/target/version errors and retain the selected time; conflicts require review rather than automatic version replacement. Reload lists/counts after success because receipts are historical.
- `GET /api/v1/reminders/history?limit=50&before=<id>&status=delivered` uses `reminderHistorySchema`. `GET /api/v1/notifications/history?limit=50&before=<id>&unreadOnly=true` uses `notificationHistorySchema`. Limits are 1-200 and `nextBefore` is null on the final page. Ordering is creation time/ID descending. Preserve filters during paging, reset cursors on refresh/filter changes, and guard late responses. Read/status changes may alter subsequent filtered pages.
- `GET /api/v1/notifications/summary` uses `notificationSummarySchema` and counts all owned unread records, including records outside the legacy 200-item inbox. A failed count means unavailable/stale, not zero. The existing shell still counts the legacy inbox; migrate it during the Inbox rewrite.
- Bulk read: `POST /api/v1/notifications/read` with `{ operationId, notificationIds }`, 1-200 unique selected/loaded IDs. `notificationsReadResponseSchema` returns records in input order. The batch is atomic and preserves existing read timestamps. Label the action "Mark selected read" or "Mark loaded read"; no global mark-all endpoint exists. Later arrivals remain unread on retry.
- All new reads/writes are online-only, outside the response-cache allowlist/task outbox. Preserve pending/offline/failure/conflict states. Existing list and single mark-read endpoints remain compatible; current UI is unchanged. Export retains snooze chains and read/delivery history. Purge/retention, offline snooze, native/background alerts, AI and email remain pending.

Validation: `npm run check` passed lint, strict types, formatting, builds and 164 API/client tests, including 15 new reminder/inbox tests; one optional PostgreSQL test was skipped because its isolated test URL is unset. All 43 browser tests passed with migration 025 on their isolated server/database. Synthetic coverage includes duplicate/competing snoozes, target/occurrence suppression, leased-child cancellation, preserved read timestamps, forced atomic rollback, microsecond cursor ordering, counts beyond 200, selected-read retries, owner isolation, populated upgrade, export and persisted restart. Optional PostgreSQL concurrency coverage is added but unverified locally. No real provider calls, paid AI, owner database resets or hardware verification occurred.

## Backend handoff: task/event restore (2026-10-10)

Implemented API capability; frontend Undo controls are still pending. Tasks and Calendar can now use `POST /api/v1/tasks/:id/restore` and `POST /api/v1/calendar/:id/restore`, with shared `restoreItemSchema`: `{ operationId, expectedVersion }`. The version comes from the DELETE response (or an explicitly reloaded tombstone), not the active record before delete. Responses are `taskResponseSchema`/`calendarResponseSchema`. Legacy events also expose `/api/v1/events/:id/restore` with `eventResponseSchema`.

- Keep Undo pending/error/conflict visible. Preserve the original endpoint, payload and operation ID for lost-response retries. Changing the endpoint/payload needs a new operation ID. Retry receipts are historical; reload lists after a successful restore before claiming the record's current state.
- Restore is online-only and is not supported by the task outbox. Do not enqueue these POSTs or place single-record reads in the offline cache allowlist. Offline deletion keeps its existing queue behavior; Undo integration must wait for confirmed server deletion.
- `GET /api/v1/tasks/:id` and `/api/v1/calendar/:id` read owned active records or tombstones for explicit recovery. 404 means unavailable/unowned; 409 `VERSION_CONFLICT` means reload and review, and `NOT_DELETED` means already active. Deleted-items browsing is now implemented in the later study/recovery slice. Do not automatically adopt a new version and restore after a conflict.
- Restore keeps IDs, owner fields, completion/study status, source provenance, academic links, labels, recurrence and exceptions. It changes `deletedAt`, `updatedAt` and version. Cancelled occurrence exceptions and cancelled reminder jobs stay cancelled; pending jobs retain their current schedule. No reminder recreation is implied.
- Relabeling a class/topic now advances affected deleted derived-record versions and retains all labels for a future restore. Unknown legacy provenance still blocks AI. Archived academic links remain archived.
- Export adds `records.plannerRestorations`, defaulting to `[]` for older files: item kind/ID, deleted/restored versions and timestamps. This is retained history, not a current deletion list or a purge mechanism.

The Today attention summary and task agenda endpoints are now implemented in the latest handoff; Today continues composing existing cached reads until UI integration. Paid AI execution remains disabled.

Verification: `npm run check` passed with 117 API/client tests and one optional standard PostgreSQL test skipped; all 43 browser tests passed on the full rerun. The first browser run had one sign-in failure in the standard accessibility test while build work was still running; it did not recur with builds idle. Restore checks cover matching/competing retries, historical receipts after another deletion, owner isolation, stale versions, rejected override fields, recurrence exceptions, cancelled reminders, archived academic links, complete labels applied while deleted, retained metadata/export and restart recovery. Migration 019 is exercised in isolated embedded databases; concurrent restore coverage was added to the optional PostgreSQL test but has not run locally. Tests never used the owner's development database or real providers.

## Backend handoff: provider quotes and consent (2026-10-10)

Backend-only; UI controls remain pending. Shared schemas/types live in `ai-provider-policy.ts`. Provider profiles now include nullable server `pricing`/`retentionDisclosure` declarations and a per-profile `policyRevision`. A configured profile still has unchecked health/model/price/retention support.

- Read `/api/v1/ai/provider-readiness` online for each profile's `quote`, `consent`, `consentCurrent`, and `blockers`. Always show dispatch disabled. Quotes use configured token allowances, not measured prompt tokens or verified invoices; display exact USD millionths and expiry, without claiming affordability after settings/context change.
- Write `/api/v1/ai/provider-consents/:alias` with `{ approved, expectedVersion, expectedRegistryRevision, operationId }`. Default consent is off/version 1. Present the actual safe model/profile, price declaration and retention summary for explicit owner approval. Never preapprove or infer consent from routing/spending settings.
- Keep pending/retry/conflict drafts visible. Lost-response retries reuse the original endpoint/body/ID. Reload readiness before claiming current approval: a historical receipt can return approved after later revocation. A changed profile invalidates consent; a registry conflict requires reviewing current declarations before a new write.
- Missing/expired pricing, missing disclosure, missing/stale consent, provider configuration and request/month budget gates remain explicit. `DISPATCH_DISABLED`, `PROVIDER_VERIFICATION_REQUIRED` and `TOKEN_BOUND_UNVERIFIED` remain on every readiness result. Credentials are never UI input.
- Preflights add nullable `executionReadiness` metadata. Preserve the primary blocked reason and show additional blockers as details; null on legacy receipts means unavailable historical readiness. Source text is still discarded, with no reservation or queue created.
- Consent reads/writes stay outside offline caching/outbox behavior. Export adds current `aiProviderConsents`, including safe approved profile snapshots; mutation receipts retain historical changes. Neither hide nor revoke implies permanent metadata removal or an upstream deletion request.

Verification: `npm run check` passed with 123 API/client tests and one optional PostgreSQL test skipped; all 43 browser tests passed. Six new synthetic policy tests cover exact rounding/max bounds/expiry, default-off consent, strict inputs and sanitized configuration failures, secret-free fingerprints, owner isolation, duplicate/stale/revoked retries, changed-model invalidation, safe approval snapshots, exact budget equality/holds, metadata-only preflights/export and zero provider calls. PostgreSQL duplicate/competing consent writes are added to the optional isolated-schema test but remain unverified locally.

## Working agreement

- Prioritize functional backend work now; visual refinement is deferred to the UI agent.
- Prefer a concise title or label. Put secondary explanations in keyboard- and tap-accessible Help or expandable details. Keep actionable errors, pending/offline/conflict states, and essential warnings visible.
- Preserve shared contracts, relative `/api` URLs, authorization, versions, operation IDs, and retained drafts when replacing components. A successful request and a confirmed provider action are different states.
- Record new behavior, required states, contract changes, and known limitations here as development proceeds. Do not describe proposals as shipped features.

## Implementation map

| Area | Starting points | Behaviors to preserve |
| --- | --- | --- |
| App/navigation | `apps/web/src/App.tsx` | Owner authorization gates private views; preferences include e-ink mode. |
| Appearance | `AppearanceSettings.tsx`, `lib/appearance.ts`, `styles/tokens.css` | Device-local theme, contrast-checked colors, named profiles, e-ink overrides. |
| Authentication/account | `AuthGate.tsx`, `AccountSettings.tsx` | Enrollment, sign-in, password reauthentication, session rotation/revocation, planner export. |
| Tasks/sync | `TasksView.tsx`, `DeletedItems.tsx`, `QuickCapture.tsx`, `SyncStatus.tsx`, `lib/tasks.ts`, `lib/offline.ts` | Durable task outbox, stable IDs, version conflicts, same-owner recovery. |
| Calendar | `CalendarView.tsx`, `CalendarEditor.tsx`, `DeletedItems.tsx`, `TimeZoneInput.tsx`, `lib/calendar.ts`, shared `occurrences.ts` | Timezones, date-only events, recurring series/occurrences, separate study blocks and imported deadlines. |
| Classes | `ClassesView.tsx`, `ClassForms.tsx`, `lib/classes.ts`, `ClassCanvasEntries.tsx`, `ClassCanvasAssignments.tsx` | Manual class/topic assessments, explicit Canvas links, cached loaded portfolios. |
| Inbox/Reminders | `InboxView.tsx`, `ReminderEditor.tsx`, `lib/reminders.ts` | Durable server inbox/worker state, snooze once, versioned reminder drafts, explicit optional browser permission. |
| Connections/Canvas | `views/ConnectionsView.tsx`, `CanvasConnection.tsx`, `CanvasLmsConnection.tsx`, `CanvasReconciliation.tsx` | Independent feed/API facts, explicit reconciliation, retained note/conflict drafts. |
| Source planning | `CanvasPlanning.tsx`, `CanvasAssignmentPlanning.tsx`, `CanvasPlannerWork.tsx`, `PlannerSource.tsx` | Captured/current provenance, versioned explicit creation, grouped task/study visibility. |
| AI page | `AIView.tsx`, `AIProviders.tsx`, `AIContextPicker.tsx` | All sections mounted at once; shared context fields; Providers read-only. |
| AI permissions | `AIRoutingSettings.tsx`, contracts `ai-routing.ts` | Versioned label rules, deny by default, preview-only status. |
| AI preflight/budget | `AIPreflights.tsx`, `AIBudgetSettings.tsx`, contracts `ai-preflight.ts`/`ai-budget.ts` | Server configuration versus health, blocked metadata history, exact USD amounts, retained reload/retry drafts. |
| Requests/transport | `lib/api.ts`, `lib/transport.ts`, `lib/request-signal.ts` | Owner-separated caches, native cookie transport, abort compatibility. |

Component paths above are relative to `apps/web/src/components` unless qualified. Shared schemas live in `packages/contracts/src`; server routes and error codes are documented in development.md.

## State and interaction requirements

### Authentication and offline tasks

Task edits can be queued offline; calendar, academic, connection, reminder, account, and AI settings writes are online-only. Previously loaded views can be cached; arbitrary ranges or unseen records are not guaranteed offline. Cached data must remain associated with the authenticated owner/server.

Session expiry/revocation locks queued edits until the same owner signs in again. Do not discard an outbox or expose it to another owner. Keep conflict drafts and pending operations visible. Reloading a server version does not silently apply a conflicting edit. Lost-response retries reuse the same operation ID and payload; changed edits need a new operation ID. See offline.ts before changing task forms or sign-out flows.

### Calendar and academics

Date-only task deadlines are not reserved calendar intervals. All-day end dates are exclusive. Recurrences preserve local starts through daylight-saving transitions; occurrence identity uses the original date even when moved. Distinguish series edits, occurrence replacements, and cancellations. Save remains disabled while a conflict reload is pending; reload preserves the draft and clears the warning only after a new version arrives.

Class/topic progress and confidence are manual assessments. Imported assignments do not establish submission, grade, or mastery. Study blocks have planned/completed/cancelled states. A displayed strongest sensitivity label can mask additional applied labels: AI routing checks all of them. Captured academic history survives relabeling, detachment, and occurrence cancellation. Unknown legacy history blocks AI processing, not ordinary planner editing.

### Canvas

Feed and API records remain independent. Confirmed exact-URL reconciliation shares provenance and groups linked planner work; it does not merge facts, suppress agenda entries, or deduplicate planner records automatically. Show conflicting dates/statuses separately. Missing upstream records remain retained, with their last known facts and owner notes.

Source planning is an explicit online action with source/course/version guards. Captured facts remain immutable while current facts can change. A reload must retain the owner draft and adopt the latest source versions before retry. Existing linked tasks retain task offline editing. Grouped work includes completed tasks and excludes delete tombstones; it does not claim Canvas submission.

Canvas tokens and private feeds stay server-side. The API connection exposes a safe upstream account ID; unverified identity and changed-account rejection are meaningful states. Browser/cache state cannot establish live upstream completeness. Imported file-derived text is forbidden AI context even if the visible title seems harmless.

### Reminders

Server inbox delivery and native notification delivery are separate. Browser alerts currently require permission and an open Inbox view. Keep permission denial, pause, retry, cancellation, worker failure, and inbox read state understandable. Closed-app push/native alarms are pending.

### AI

Routing preview is a simulation and never calls a provider. Allowed/preferred entries are aliases, not credentials or arbitrary endpoints. Unsaved rules cannot drive a preview. Request text and independently unlabeled sources contribute the unlabeled rule; personal/restricted labels come only from owner labeling and inherited provenance. Every applicable rule must approve the destination. An unavailable preferred destination blocks rather than silently selecting another approved provider.

Keep file-derived and unknown-provenance blocks actionable. Do not imply natural-language app management, paid execution, memory, scheduled agents, MCP execution, email ingestion, or external calendar writes are implemented. Email sends, invitations, and cancellation emails will require explicit approval.

## Error and retry handoff

Use `RequestError.code` from `lib/api.ts` for structured handling; never render arbitrary server/provider payloads. These recovery paths differ:

| State/code | Required behavior |
| --- | --- |
| Network timeout/lost response | Outcome can be unknown. Preserve draft and exact pending operation ID/payload; retrying must not create a new action. |
| `VERSION_CONFLICT` | Keep input and expose explicit reload. Adopt the new version before deliberate save; do not overwrite draft fields. |
| `REGISTRY_CONFLICT` | Reload safe server profiles/settings before another check; retain input. Revision does not prove health or credential rotation. |
| `OPERATION_CONFLICT` | A key was reused with changed payload. Do not automatically rotate it and repeat a possibly completed action. |
| `RETRY_REQUIRED` | A snapshot race exhausted bounded retries. Retry the same operation; this never authorizes a paid call. |
| `PROVENANCE_UNAVAILABLE` | Incomplete historical labels block AI use. Planner editing remains available; reload cannot reconstruct history. |
| `UNAUTHENTICATED` | Lock private/queued state, retain owner separation, and require sign-in. Cached content is not fresh authorization. |
| Invalid input/incompatible response | Retain the draft and show an error. Schema failure is not success or an empty result. |
| Accepted blocked preflight | A persisted metadata result, separate from an HTTP failure or executable queue. Show its reason; dispatch remains disabled. |

Task transport alone has durable offline mutation support. `cachedPath` in api.ts defines the loaded-view cache allowlist; AI/account/settings endpoints are excluded. Reuse transport helpers instead of introducing a universal offline cache or background mutation retry.

## Deferred UI/device work

Current forms and expandable panels are functional scaffolding. Repeated async/form state and dense nested details can be redesigned, preserving the behavior above. The web production bundle currently has a size advisory (about 603 kB minified); avoid interpreting browser tests as hardware performance evidence.

Actual Mudita Kompakt verification, Kindle Scribe, and a dedicated Windows app are deferred. The provisional Android shell bundles the web UI and uses native transport without request logging. Emulator results do not prove Kompakt WebView, e-ink refresh, power-mode, or native notification behavior.

## Validation for the rewrite

Use Node 24/npm 11. Run `npm run check`, then `npm run test:e2e` for UI/authentication changes. Browser tests own their ports and synthetic database. Keep API/provider fixtures synthetic; never reset the owner's database or send real provider/paid requests for routine verification. Update locators when layout changes without weakening state, privacy, offline, conflict, or retry assertions.

## Change ledger

### 2026-10-13 — Mail: AI task suggestions

- **Create task from mail** gains **Suggest tasks with AI** at the top of the form. Contract: [mail-task-suggestions.md](mail-task-suggestions.md).
  - It shows blocked reasons, model and cost, an outcome-unknown hold, and "n suggestions without an exact quote left out".
  - **Suggested tasks** list: title, the exact quote as a block quote, "Suggested deadline … (check before confirming)", notes, and **Use** (named "Use suggestion: title").
- **Use** fills title, quote and deadline, clears the deadline confirmation and resets errors. Creation and quote checks are unchanged.
- Tests: `tests/e2e/mail-task-suggestions.spec.ts`.

### 2026-10-13 — Mail: AI suggestions

- **Inbox › Mail › AI suggestions** (under Rules), for the current selection (at most 20). Contract: [mail-classification.md](mail-classification.md).
  - **Suggest categories for n** shows "Not sent:" with reasons (Restricted / Personal not allowed / older import / changed), then model, cost and outcome.
  - **Suggested categories** checkboxes ("Subject → Category" plus the model's reason), then **Apply n categories** using owner category writes with the seen version. Each line shows Applied or Not applied; a conflict says "Changed since the suggestion. Ask again."
- **Settings › AI › Assistant**: **Allow Personal mail for category suggestions** switch (versioned, default off) with Help.
- Costs under one cent show every microdollar (`$0.00015`) instead of rounding down.
- Tests: `tests/e2e/mail-suggestions.spec.ts`.

### 2026-10-13 — Mail categories and explicit rules

- PR #16 validation follow-up: the standard PostgreSQL driver test now runs synthetic reminder/LMS batches explicitly instead of polling background timers. UI contracts and required states are unchanged; this test does not establish worker cadence or live-provider readiness.

- Inbox Mail adds Category filtering, per-message selection (maximum 100), Clear selection and an always-available Reload mail control. Paging, owned cursors and plain-text detail remain intact.
- Mail rules is expandable, with literal sender/subject rules, enabled state, editable drafts and confirmed deletion. The oldest enabled matching rule wins. Captured rule explanations survive edits/tombstones. See [contracts](mail-organization.md).
- Preview is write-free. Apply guards the rule revision and every selected message version atomically; owner categories, including Uncategorized, stay protected. Selection/revision changes invalidate previews and abort/ignore late responses.
- Selection/filter/category controls lock during apply. Starting a rule edit invalidates an existing preview; save or cancel before previewing again. Long rule names and captured criteria wrap at narrow widths.
- Message detail adds Category, Save category, Use rules and Reload latest message. Privacy label is named separately. Categories never change sensitivity, inherited labels or provider permissions. Connector refreshes preserve owner corrections.
- Keep pending, offline/error, version-conflict and protected-origin states visible. Failed writes retain drafts and retry identity; deliberate reload/cancel/reopen adopts current versions. Rule/editor changes do not perform provider-side mail actions.
- Known limits: online-only, no rule reordering/restoration, automatic classification, paid AI, portable export or deadline extraction. Browser 320px results are not Kompakt hardware proof.


### 2026-10-13 — Verified mail context gateway (backend)

- Mail list/detail now include `version` for explicit `mail-message` AI context references. Reading Mail still never changes Proton flags or enables model calls.
- Existing context preview/preflight manifests bind message and connector versions plus all stored/current connector labels. No Mail selection or classification controls are implemented yet.
- Future selectors must preserve actionable `PROVENANCE_UNAVAILABLE`, stale-version, unavailable-provider and input-limit states. Do not silently certify legacy imported text or fall back from an unavailable approved provider.
- Show truncation when a selected body is shortened; never imply omitted attachments were analyzed. Attachment counts, filenames, folder names and credentials are excluded from AI projections.
- Connector revocation stops upload and invalidates pending context bindings. Stored messages remain locally readable; a deliberate new assessment can reference verified stored text. Existing token recovery, paging, detail rendering and offline planner behavior remain unchanged.
- Main integration also tightens the narrow Today Assistant: source-linked tasks/events, class/topic-linked events and unknown academic label history are withheld along with Personal/Restricted records. The count says "items left out"; contextual Help names these exclusions. No source-linked proposal can be created from this context.


### 2026-10-13 — Email: Proton Bridge connector and Inbox › Mail

- **Settings › Connections › Email (Proton Bridge)** panel. The Proton Mail placeholder card is removed. Contract: [email-ingestion.md](email-ingestion.md).
  - **Add connector**: Name and **Imported mail label** (default Personal). The token is shown once in a read-only field with **I saved it**.
  - Each connector shows its status (Waiting for first sync / Connected / Revoked), label, import start date, last sync and a folder table: On Bridge, Since start, Imported, with visible "(incomplete)" when Imported is below Since start. Reload connectors refreshes the list, including recovery after a lost token response.
  - **Revoke connector** asks first.
- **Inbox › Mail** (`/inbox/mail`, `/inbox/mail/:id`), between Reminders and Email drafts.
  - Folder filter; newest first, 50 per page with **Load more mail**; a late-cursor message. Rows show the subject link, sender, received time, a 2-line snippet and the attachment count marked "(not imported)".
  - The detail page shows From/To/Cc/Received/Folders/Attachments/Label, then the body as plain pre-wrapped text, never HTML, with a "Shortened" note when truncated. "Back to mail" link.
  - With no connector, Mail links to Connections.
- Tests: `tests/e2e/mail.spec.ts`; `inbox/mail` is added to the accessibility sweep; router tests cover the mail addresses.
- Known limits: read-only, no search, no flags, no deletion tracking, no AI filtering yet.
- Creation retries preserve one connector, but cannot reissue its one-time token. Keep the recovery error visible: reload Connections, revoke it, and add a replacement. Revocation is versioned and receipt-backed. Incomplete folder counts remain visible; a shortened message does not imply that 32,000 characters were available (oversized messages can have headers only).

### 2026-10-14 — Calendar rework (spec: superpowers/specs/2026-10-14-ui-rework-design.md)

- **Routes.** Views are Day, Week, Month and Agenda (`calendarViews`). No `view=` means Week, or Day below 640 px. A chosen view is always written (`view=agenda` included). `/calendar/new?start=YYYY-MM-DDTHH:MM` opens New event at that local time, one hour long. Month is six weeks from the Monday on or before the 1st, and ‹ › move by calendar month.
- **Shell.** The sidebar (15 rem, ≥ 1024 px) has New event, a mini month (buttons named by full date; today `aria-current="date"`; the shown date pressed), the Date field, **Show** checkboxes (Events, Study blocks, Canvas deadlines, Task due dates; saved on the device in `hub:calendar-sources`) and the viewing time zone. Below 1024 px, New event and a **Calendars** button (`aria-expanded`) stay visible and the rest opens as a panel. While an editor is open on wide screens, the sidebar hides so the editor fits beside the view. The top bar has Today, ‹ › ("Previous week", "Next month", and so on), the range title (`h2`, e.g. "May 7 – 13, 2029"), and the view switch (`nav` "Calendar views").
- **Week/Day grid.** Day headers link to Day view. An all-day strip per day lists all-day events, every Canvas deadline (timed ones show their time) and open tasks due that day (`ul` "All day, {date}"). Timed events are blocks positioned by elapsed minutes in the viewing zone, clipped to the day (23/24/25 hours). Overlap groups split into equal columns. Block names are "{title}, {time}" and open the editor (the occurrence for repeats). Each hour is a "New event {weekday} {hour}" button (not in the tab order; New event is the keyboard path). A now line marks today's column. The grid opens scrolled to 07:00 or the first earlier block.
- **Month.** A table of six weeks. Each day has a date link to Day view, up to three chips (the all-day strip first, then timed events by start) and "+N more" to Day view. Today's cell has `aria-current="date"`.
- **Agenda** is the former list, unchanged. Batch selection (Select) is now Agenda-only. Show toggles apply here too (tasks are not listed in Agenda).
- **Colors.** Blocks and chips use the `--kind-*` tokens: event, study, deadline (Canvas) and task, each with light, dark and e-ink values. In e-ink, chips and blocks get black outlines and a visible type prefix ("Event:", "Deadline:"); otherwise the prefix is screen-reader only.
- **Targets.** Grid chips and blocks are at least 24 px (WCAG 2.5.8, with Agenda as the full-size equivalent). Everything else keeps 44/48 px.
- **Limits.** No drag to move or resize, no search, one calendar. On a daylight-saving day the hour labels follow a normal day, so blocks after the change sit an hour off the labels (positions themselves stay within the day). Timed Canvas deadlines appear in the strip, not at their hour.
- Tests: `tests/e2e/calendar.spec.ts` (mini month, Show toggles, narrow sidebar, block placement and editor, slot start, task strip, Day default and now line, month "+N more", accessibility and targets for Day/Week/Month/Agenda/editor at 1280 px and 320 px e-ink), `apps/web/tests/calendar-grid.test.ts`, router and calendar unit tests. Older flows that check list rows now open `view=agenda`.

### 2026-10-14 — Assistant rework (spec: superpowers/specs/2026-10-14-ui-rework-design.md)

- **Chat layout.** Each turn is two bubbles: the ask (`article` "You", right, selected colors) and the answer (`article` "Assistant", left, subtle surface). The answer holds the failure reason, reply, mail note, the **Proposed changes** card (Apply/Undo unchanged) and one collapsed details line: model · cost · N messages sent · M left out (planner labels plus mail) · unused suggestions. Opening it lists the sent mail ("Body sent" or "Subject and sender only") and the left-out counts. Bubbles are at most 80% wide (100% under 480 px) and wrap long text.
- **Page shell.** At ≥ 1024 px a 16 rem conversation list sits beside the thread. Below that, a **Conversations** button (`aria-expanded`) shows the list as a panel, which closes when a conversation is chosen. The thread header has the title (or "New conversation"), Delete, and a muted model/spend line with Help (moved from the page summary).
- **Composer** is sticky at the bottom of the thread (above the mobile bottom bar), with the Ask label visually hidden. After an answer, the newest turn scrolls into view above it and focus returns to the Ask field.
- The mobile bottom bar now has six columns (five destinations plus More); More no longer wraps to a second row.
- Tests: `tests/e2e/assistant.spec.ts` (bubbles and details line, narrow conversation list, scroll and focus after an answer).

### 2026-10-14 — Today rework (spec: superpowers/specs/2026-10-14-ui-rework-design.md)

- **Add or ask** bar at the top: an Add task / Ask assistant radio pair (remembered per device in `hub:command-mode`), one text field, an optional due date in task mode, and Add/Ask. Add task saves through the task transport (offline: "Task queued for sync."). Ask starts a new conversation (honoring the saved Use mail choice) and opens `/assistant/:id`. Without a server key, Ask assistant is disabled with Help.
- **Overdue** (red edge) appears only when there are overdue open tasks or failed reminders.
- **Today · {date}**: one list in the viewing time zone. All-day deadlines and tasks due today come first, then all-day events, then timed items by start. Rows have a time column ("Due today", "All day", "Due 11:59 PM" or a range), a linked title (task, event editor, or Canvas source) with "Cancelled" for withdrawn Canvas items, and a kind tag (Deadline, Task, Event, Study; `--kind-*` tokens with dark and e-ink values). Per-source load or retry messages stay inside this section. The empty state is "Nothing due or scheduled today." The time zone and Canvas import time moved into Help.
- **Next 7 days · N** and **Unread reminders · N** are collapsed `<details>` groups.
- Removed from Today: the inline Assistant panel (answers live on the Assistant page) and the separate Due today box.
- Tests: `tests/e2e/today.spec.ts` (order and tags, Overdue only when relevant, collapsed counts, command bar modes, offline add at 320 px e-ink, per-source failure) and `apps/web/tests/today.test.ts`. Assistant flows formerly on Today are tested on `/assistant`.

### 2026-10-14 — Assistant: Use mail (D56)

- The composer (Today and the Assistant page) has a **Use mail** checkbox next to Ask. Its state is saved in the assistant settings and restored on every device. If saving fails, the choice still applies now and a quiet note says it was not remembered.
- An answer that used mail shows a collapsible "N messages sent (M read) · K left out by labels" list. Each row has subject, sender, received time, and "Body sent" or "Subject and sender only".
- If mail reading stopped early (a failed call or a spending limit), the reason is shown as an alert above the list; the earlier reply stays.
- Help explains the scope: subjects and senders of allowed mail, up to five bodies, never Restricted, Personal only with the Settings › AI switch, up to three calls.
- Tests: `tests/e2e/assistant.spec.ts` (remembered checkbox across reload; sent-mail list). API tests cover search/read rules, label exclusions, schemas per call, cost totals, a failed later call and the saved setting.

### 2026-10-14 — Appearance: dark theme (D54)

- **Settings › Appearance › Display › Theme**: Match device (default), Light, Dark. Disabled in e-ink mode; custom colors replace either palette.
- `:root[data-scheme]` is `light` or `dark` (absent in e-ink); Match device follows live changes of `prefers-color-scheme`. The choice is device-local with the rest of Appearance.
- Dark tokens live in `styles/tokens.css`; text pairs meet 4.5:1, borders/accent 3:1. New styles must use tokens, never raw colors.
- Tests: `tests/e2e/appearance.spec.ts` (device following, fixed choice, e-ink; color-contrast sweep of Today, Tasks, Calendar, Inbox and Settings in dark) and `apps/web/tests/appearance.test.ts`.

### 2026-10-14 — Assistant page (D55)

- **Assistant** (`/assistant`, `/assistant/:conversationId`) is a primary sidebar destination after Today.
  - Summary line: model and this month's spending (of the monthly limit), with Help.
  - **Conversations** list (newest first; title = first ask; updated time) with **New conversation**. Thread: each ask, then reply, cost, left-out/unused counts and proposed changes with Apply/Undo.
  - The composer (Enter asks, Shift+Enter adds a line) continues the open conversation; on a new conversation the first answer moves to its address. **Delete** confirms, then removes the text from the server; applied changes stay.
  - Apply/Undo results are saved to the server; another device sees them and reuses the same write IDs. A newer version elsewhere reloads the thread.
  - Missing or deleted conversations show a recovery link to start a new one.
- **Today › Assistant** is now a quick ask: asks join one conversation until **New conversation**, with **Continue in Assistant**. The former Discard button is gone because answers are stored.
- Tests: `tests/e2e/assistant.spec.ts` (page flow with stubbed assistant endpoints; Today apply/undo and conflict); `/assistant` joins the accessibility sweep; API tests cover storage, follow-up history, deletion and item updates.

### 2026-10-13 — Today: Assistant (first live AI flow)

- **Assistant** panel at the top of Today. Contract: [ai-assistant.md](ai-assistant.md).
  - Without a server key it shows "Not set up" and no form.
  - **Ask** (1–1000 characters, online only) posts `{ text, timeZone }` with a stable operation ID. Enter asks; Shift+Enter adds a line; Enter during IME composition does neither.
  - Shown: the reply as plain text; model and cost; how many labeled items were left out; how many suggestions could not be used; and the failure reason.
  - An uncertain outcome says how much stays held and that nothing is resent. `BUDGET_UNSET` and `MONTHLY_BUDGET_EXCEEDED` link to Settings › AI.
- **Proposed changes** is a checkbox group, all selected by default, with one plain-language line per change.
  - **Apply n changes** sends the ordinary task and calendar writes one at a time. Updates use the version the model saw.
  - Each line then shows Applied, or Not applied with the reason. A conflict says "Changed or removed since the assistant read it. Ask again."
  - **Undo** reverses applied changes newest first. **Discard**/**Done** clears the panel. A retried request shows "already answered" with no proposals.
- **Settings › AI › Assistant**: On/Not set up status, a **Model** field (OpenRouter ID, default `anthropic/claude-haiku-5.5`), **Save model** and version-conflict reload.
  - The page header now reads "AI · Assistant only".
  - The spending-limit chip reads "Used by the Assistant". Routing and request-check panels say they are preview only and not used by the Assistant.
- Tests: `tests/e2e/assistant.spec.ts` (not set up and model save; apply then undo through the real planner API with stubbed assistant endpoints; conflict) and `apps/web/tests/assistant.test.ts`.
- Known limits: no request history, no repeating events or deletions, labeled items never included, results not kept after reload.

### 2026-10-13 — Inbox: Email drafts and exact-message approval

- New **Inbox › Email drafts** (`/inbox/drafts`, `/inbox/drafts/new`, `/inbox/drafts/:id`).
  - **List**: drafts with **Show** (Current or Deleted drafts) and cursor paging with a stale-cursor message. Summaries show subject, status (Not approved, Approved, Deleted), recipient count, a purpose other than email, and saved time. Bodies and addresses are not listed.
  - **New draft / Edit draft** fields: Account (Proton Mail, Outlook), Purpose, From, To/Cc/Bcc (separated by commas, semicolons or new lines), Subject, plain-text Body and **Draft content label**.
  - Client checks run before sending: sender, each address, 1-50 recipients, no case-insensitive duplicates, single-line subject. Attachments are always empty.
  - Editing an approved draft first warns "Saving changes removes the current approval." Version conflicts keep edits through "Load latest version".
- The detail page shows **Message to approve**: the stored, normalized message with every field, "Attachments: None" and the body as plain pre-wrapped text (never HTML).
  - **Approve this exact message** sends `reviewedContentHash` = the loaded `contentHash` with `decision: 'approve-exact-message'`.
  - On `VERSION_CONFLICT`, `EMAIL_REVIEW_CONFLICT` or `DRAFT_STATE_CONFLICT`, the page says "Review it again" and offers **Reload draft**. **Revoke approval** uses the approval version.
- **Sending: not available** is always shown, with the blockers from `POST /send-preview` in words. No send control exists.
- **Delete draft** confirms that the text, recipients and history stay in private storage and exports and that permanent erasure is not available. **Restore draft** needs a new approval.
- Tests: `tests/e2e/drafts.spec.ts` (validation, review, conflict then reload then approve, edit removing approval, delete/restore without sending); `inbox/drafts` and `inbox/drafts/new` are added to the all-view axe and target checks; router tests cover the draft addresses.
- Conflict recovery retains editor text even if loading the latest version fails. Detail actions are disabled together while a write is pending; send-preview blockers reset when the loaded draft changes.
- Tests additionally cover failed conflict reload without losing edits and a committed save with a lost response: retry keeps the operation ID and creates only one revision.
- Known limits: online-only, no revision or approval history views, no mailbox connection, no sending.

### 2026-10-13 — Settings: Memory

- New **Settings › Memory** (`/settings/memory`).
  - **Use memory** switch (`PUT /api/v1/memory/settings`). Help states that it is off by default, starts no AI use, and keeps memories when turned off. A conflict offers **Reload memory**.
  - Filters: **Show** (Active, Disabled, Forgotten, All, with the server's counts), **Type** and literal **Search** (submitted, up to 100 characters). Pages hold 25 items with an `after` cursor and version. Changing filters resets paging and late reads are ignored. A changed cursor shows "The list changed. Reload to see the latest."
  - Rows show the title (or "Forgotten memory"), type, noted date, Disabled/Forgotten and the label. List pages carry no content.
- **Add memory / Edit memory**: Type, Noted on, Title, Memory text, Enabled and **Memory content label**. Edit loads `GET /api/v1/memory/:id` for the full text. Saves return a metadata receipt and the list reloads. A version conflict shows "Changed elsewhere" with **Load latest version**, keeping the edits.
- **Forget memory** asks first. The dialog says the text is cleared from the app and future exports, cannot be restored, and remains in earlier backups and downloaded exports. `MEMORY_FORGOTTEN` has a specific client message.
- Reminder snooze, notification history, the unread summary and "Mark loaded read" were already built by the earlier UI work. Only the reminder history list (`GET /api/v1/reminders/history`) is still unused.
- Tests: `tests/e2e/memory.spec.ts` (switch, add validation, search, conflict then Load latest, disable/Show Disabled, forget leaves a text-free tombstone); `settings/memory` is added to the all-view axe and target checks.
- Known limits: no AI use or retrieval, no import, no restore after forgetting.

### 2026-10-12 — Classes: Study plan (preview, draft, approval)

- **Study plan** link in the Classes list opens `/classes/plan`. Controls: **Starting** date and **Length** (7 or 14 days). **Preview plan** calls `POST /api/v1/study/preview` with no operation ID; it is read-only. The preview shows warnings as visible text, "Why this order" (remaining/target minutes and ranking reasons in words), and blocks grouped by local day in the plan timezone with the total time.
- **Save as draft** sends `POST /plans` with the preview's `contextRevision`. `STUDY_CONTEXT_CONFLICT` asks the owner to preview again.
- **Plans** lists history (20 per page, **Load more plans**) with status, block count, total and saved time. Opening a plan shows its blocks.
  - Draft blocks have **Remove** buttons. **Save draft changes** fetches a fresh preview for the plan's dates and sends `PUT` with the remaining slots and that `contextRevision`; the server revalidates conflicts, availability and limits. **Approve plan** is hidden while removals are unsaved.
  - When approval returns `STUDY_CONTEXT_CONFLICT` or `STUDY_WORKLOAD_UNCAPTURED`, **Recheck draft** saves the unchanged slots against current data. Conflicts or past blocks then surface as errors, and the owner removes those blocks.
- Approved plans show "Added n study blocks to Calendar" and **Cancel plan**. The confirmation explains that edited, completed or deleted blocks are kept. Cancelled plans report how many blocks were kept versus cancelled (`preservedEventIds`). Draft and cancelled plans can be hidden with **Hide plan**; approved plans must be cancelled first.
- **Progress for these dates** (`GET /study/progress`) shows target, planned, completed and cancelled minutes and the percentage done for each class with a goal or study time. Help states that completed is self-recorded and is not mastery.
- The client now maps the `STUDY_*` error codes to specific messages.
- Tests: `apps/web/tests/study.test.ts` (day grouping across timezones, times, totals, range end) and `tests/e2e/study.spec.ts` (preview, save draft, remove a block and save, approve into Calendar, cancel, hide, progress). `/classes/plan` with a preview shown is added to the class accessibility, overflow and target checks.
- Known limits: blocks cannot be moved or resized (remove only), plans have no deep link, and there is no AI involvement.

### 2026-10-12 — Study settings and class weekly goals

- New **Settings › Study** (`/settings/study`) reads and writes `GET/PUT /api/v1/study/preferences`. Fields: Study timezone, Session, Break and Daily limit (minutes), and **Weekly availability** rows (Window n day/start/end, Remove, Add window, up to 28). An end of 00:00 is stored as 1440 (midnight at the end of the day). The client rejects missing times, end-before-start and same-day overlaps, naming the weekday, before sending. A "n h available each week" total is shown. A version conflict shows "Changed elsewhere" with **Load latest version**, which keeps the edits and adopts the new version.
- Each class's **Study blocks** section now has **Weekly goal** (`GET /api/v1/study/goals`, `PUT /api/v1/study/goals/:courseId`): Minutes per week (0-2400; 0 turns planning off), Study priority (5 is highest) and an optional target date. It has the same conflict handling.
- Both are online only. Help explains that only planner calendars are checked and that nothing is scheduled until a plan is approved.
- Tests: `apps/web/tests/study.test.ts` (time conversion, midnight end, overlap and invalid windows); `tests/e2e/study.spec.ts` (save and reload windows, overlap error, conflict then Load latest, class goal validation and save); `settings/study` is added to the all-view axe and target checks.
- Next: the study plan screen (preview, draft, approval, cancel/hide, progress).

### 2026-10-12 — Classes: Work section and selected changes

- New class section **Work** (`/classes/:id?section=work`). It reads `GET /api/v1/academic-work/browse` with `courseState=all`, a **Status** filter (All, Open, Planned, In progress, Submitted, Cancelled) and 50-item pages. **Load more** passes the cursor ID and the work and class versions. A changed or removed cursor shows "The list changed. Reload to see the latest." Changing the filter resets paging and selection; delayed reads are ignored.
- Heading "Work (total)". A summary line shows open, submitted and cancelled counts, the open estimate and missing deadlines/estimates, all from the server summary rather than loaded rows. Help explains that the records are owner-entered, that submitted is self-reported, that scores are not a class grade, and that estimates are full effort.
- Rows show type, deadline or "No deadline", status, priority (1-5, where 5 is highest, matching the study planner's ranking), estimate ("No estimate" for null; 0 is a known value), score and label. There is an **Edit <title>** button on each row.
- **Add work / Edit work** form fields: Title, Type, Deadline, Estimate (minutes), Priority, Status (edit only), Score (points earned and possible, only for Submitted), Notes and **Work content label**. PUT sends every field, so the label and score are never reset by defaults. Choosing a non-submitted status on scored work shows "Saving clears the recorded score (…)". Saving after a change elsewhere offers "Changed elsewhere" with **Load latest version**. Delete has a confirmation and an **Undo** notice. **Recently deleted** lists this class's deleted work (`GET /api/v1/academic-work?deleted=true`) for per-item restore.
- **Select** opens the **Selected work** bar, built on the shared `SelectionBar`. Its changes are Set status, Set priority, Set deadline, Clear deadline, Set estimate, Clear estimate and Delete, sent through one atomic `POST /api/v1/academic-work/batch`. Each item carries the class version the list was read with.
- `ACADEMIC_SCORE_REVIEW_REQUIRED` blocks the whole selection with a visible message. The score must be cleared in the individual editor first.
- The client now maps `ACADEMIC_SCORE_REVIEW_REQUIRED`, `ACADEMIC_CLASS_ARCHIVED` and `CALENDAR_STUDY_SELECTION_REQUIRED` to specific messages. Before this, they showed the generic server error.
- Tests: `apps/web/tests/classes.test.ts` (labels, batch bodies). The e2e test in `tests/e2e/classes.spec.ts` covers add, scoring, a score-blocked batch, a priority batch, batch delete then restore, and individual delete then Undo. The Work section, including Select mode, is added to the axe, overflow and target checks at 1280 px and 320 px e-ink.
- Known limits: no Type or deadline filters in the UI, and no cross-class view. Archived classes are not reachable from the class list. There are no offline reads or writes.

### 2026-10-12 — Calendar: selected changes

- **Select** in the Calendar list header adds a checkbox to each event row ("Select <title>", "(series)" for repeating events) and shows the **Selected events** bar. Selection is per record: checking any occurrence of a series selects the whole series. It belongs to the shown range (changing date/view or leaving Select clears it). Canvas entries are read-only and not selectable.
- Changes: **Mark study done / Mark study planned / Cancel study** (`study-status`) and **Delete**, through one atomic `POST /api/v1/calendar/batch` (1-100 records).
- Study status applies to one-time timed study blocks only. If the selection has anything else, "n selected event(s) is/are not a one-time timed study block." shows and Apply is disabled. Repeating blocks are changed per occurrence in the editor.
- Delete removes whole records. With a series selected, "n repeating series selected: every occurrence is deleted." shows, and the confirmation repeats it. No invitations or cancellation emails are sent. Restore is per item from Recently deleted.
- Conflict, offline, pending and retry behavior is the same as for Tasks. The bar frame is shared (`SelectionBar`), and change controls are disabled while **Review latest versions** loads. Deleting the event open in the editor returns to the list.
- Tests: `apps/web/tests/calendar.test.ts` (eligibility, request bodies) and `tests/e2e/calendar.spec.ts`. The e2e test covers the study-status change, the ineligible-selection block, series scope in the warning and dialog, conflict then review, delete and Recently deleted. It also runs axe, overflow and target checks in Select mode with a series deletion pending.
- Known limits: archived-class study blocks are rejected by the server and the server message is shown. There are no offline batches, no batch restore and no occurrence-level batch.

### 2026-10-12 — Tasks: selected changes

- **Select** (list header, `aria-pressed`) switches row checkboxes from "Complete <title>" to "Select <title>" and shows the **Selected tasks** bar: count, **Select shown (n)** / **Clear selection**, a **Change** choice (Mark done, Mark not done, Set priority, Set due date, Clear due date, Delete) and **Apply to n tasks**. One atomic `POST /api/v1/tasks/batch`; up to 100 explicit IDs.
- A selection keeps each task's version from the moment it was selected, belongs to the current filter (changing filter or leaving Select clears it) and never includes tasks added later. Tasks with queued, locked or conflicting offline edits cannot be selected.
- `VERSION_CONFLICT`/`NOT_FOUND` shows "A selected task changed or was deleted elsewhere. Nothing was changed." with **Review latest versions**, which reloads, keeps still-listed tasks at their latest versions and requires a new Apply (new operation ID). Other failures keep the selection; an unchanged retry reuses the operation ID.
- Online only: offline shows "Selected changes need a connection." and disables Apply. Delete asks "Delete n tasks?" (Cancel focused); afterwards the notice points to Recently deleted, since restore is per item. Success clears the selection, leaves Select, reloads and focuses the list heading; an open editor for a deleted task returns to the list.
- Tests: `apps/web/tests/tasks.test.ts` (request bodies, selection refresh); `tests/e2e/tasks.spec.ts` (atomic priority change, conflict blocks the whole batch then succeeds after review, delete confirmation/Recently deleted; axe/overflow/targets in Select mode at 1280 px and 320 px e-ink).
- Known limits: no offline batches, no batch restore, no selection across filters or server pages.

### 2026-10-10 — Ten study/recovery backend milestones

Validation: full check passed with 149 API/client tests (17 study/recovery tests) and one optional PostgreSQL test skipped; all 43 browser tests passed against the final migrations. Tests use synthetic isolated data and forbid provider calls. Existing UI/offline behavior is preserved; new study/recovery UI controls remain pending.

Implemented backend contracts; UI controls are pending. Read [study planning](study.md) and `packages/contracts/src/study.ts` for the ten endpoint slices and payloads. Existing Calendar blocks, task restore, history receipts and provenance must survive UI integration.

- Preferences are owner/server records with timezone, ISO-weekday windows, session/break length and daily cap. Default availability is empty. Class goals default to zero minutes and are saved with version guards; zero disables scheduling for that goal. Show unknown/unset values without inventing availability or study commitments.
- Priorities use manual confidence/progress and explicit owner goals, with reason codes. They do not infer grades, submission, attendance or learning. Previews make no writes or provider calls. Targets are prorated across an exclusive-end range of at most 14 days; previews suggest full sessions and retain insufficient-time warnings.
- `EXTERNAL_CALENDARS_NOT_CHECKED` must remain visible before approval. Canvas, Proton and other external conflicts are not checked. Planner recurring/moved/cancelled/all-day events and study breaks are checked. DST gaps/folds are skipped with a warning. Do not describe an available slot as verified across connected accounts.
- Save drafts with the preview's `expectedContextRevision`. Edits use current plan version, a fresh preview revision for the same range, and the complete replacement slot array. Context/version conflicts preserve the user's draft. Reload and revise deliberately; do not automatically rebase or silently approve the new schedule.
- Approval requires a future, nonempty draft and creates all ordinary one-time study events atomically. Keep the original operation ID for response-loss retry; receipts are historical and require a subsequent read. Saved event links include approved versions. There is no AI dispatch, external write or email send in approval.
- Cancel changes only still-untouched planned blocks; edited/completed/deleted blocks appear in `preservedEventIds`. A cancelled plan can still have preserved active work. Display this result, and keep access to those Calendar records. Cancellation preserves event records and cancels queued/running/paused event reminders only for blocks it changes.
- Approved plans must be cancelled before hiding. Hidden drafts/cancelled plans retain tombstones. GET plans pages `limit`/owned `before` IDs, including hidden cursors. Plan restore and purge are pending. These controls and settings are online-only; no new cache/outbox paths are added.
- Reports distinguish planned/completed/cancelled/deleted elapsed minutes, clipped to the range. Completed is owner-recorded status. Zero targets have null completion percentage. Reports currently show active classes only; archived history remains in export. Reports do not automatically change topic confidence or progress.
- Deleted browsing uses `GET /api/v1/planner/deleted?kind=task` or `kind=calendar`, with `limit`/owned `before`. Restore uses the returned current tombstone version and existing restore endpoints. A restored cursor returns 404; reload the list. Browsing does not purge records or restart cancelled reminders.
- Export adds `studyPreferences`, `studyGoals` and `studyPlans`, defaulting to null/empty for older files. Plans are excluded from the AI context allowlist; do not pass plan text through a future provider shortcut. Backend bounds are 500 classes, 2,000 topics, 5,000 retained calendar records and 200 slots per draft. Surface actionable bound errors.

### 2026-10-10 — Durable AI request lifecycle backend

Three backend slices are implemented: request records/owner controls, atomic synthetic attempts/accounting, and restart recovery/history/export. UI integration is pending. Shared contracts are in `packages/contracts/src/ai-requests.ts`; see [gateway details](ai-gateway.md#durable-requests-and-synthetic-attempts).

Validation: full check passed with 132 API/client tests and one optional PostgreSQL test skipped; all 43 browser tests passed. Nine lifecycle tests cover synthetic execution/recovery with zero network calls. Real providers and Kompakt hardware remain unverified.

- `POST /api/v1/ai/requests` accepts the preflight write shape. GET list/single-record, POST `/:id/cancel`, and DELETE `/:id` are owner-authorized, online-only routes. Writes preserve operation IDs and expected versions. Pagination uses `limit`/owned `before`; a hidden cursor remains valid. Do not put these operations in the task outbox.
- All public creation is blocked and free of reservations/provider calls. `dispatchEnabled: false` and `textRetained: false` are explicit. Request text cannot be recovered from the record after reload; `requiresTextResupply` is true only while blocked. There is no public resupply/execute route or durable prompt queue. Keep drafts locally only if a separate owner-approved retention design is implemented.
- Show the creation assessment separately from `attempt.admission`: admission captures rechecked routing, source versions, consent/readiness and the price quote. The creation snapshot can differ from later admission. A selected route or approved consent does not enable execution.
- States: blocked can be cancelled or hidden; cancelled/completed/failed can be hidden; uncertain cannot be cancelled, hidden or resent. Uncertain retains the full hold through timeout/restart. Failed with confirmed usage can still have a charge; an overrun remains visible. All attempts currently have `adapter: 'synthetic'`; label them as synthetic, never as real AI work.
- Hiding is a retained tombstone, not permanent deletion. Historical operation receipts can precede later changes/hiding; refresh current state after retries. Preflight history and request history are independently hidden. Planner export includes `records.aiRequests` with safe attempts and tombstones; older files default it to an empty array.
- No provider output, prompt/source text, private digest or input manifest is returned/exported. There are no live dispatch controls, AI actions, automatic retries, usage-confirmation controls, conversation/memory or email approval flows in this slice. Preserve visible blockers and uncertain funds when those features arrive.

### 2026-10-12 — Web visual consistency pass

- Reviewed every screen in a browser against a synthetic, isolated instance (not the owner's database) and fixed shared styling instead of per-screen patches.
- Controls: every button and button-like link uses one size (`--text-small`); Reload/Retry (`.text-button`) are quiet underlined muted text like Help, so they read as controls without competing with the primary action. File inputs use a matching restyled picker button.
- Dates: `lib/format.ts` `formatInstant` ("Oct 12, 6:52 PM", year only when not the current year) replaces long numeric `toLocaleString()` text everywhere it was shown. Calendar/Today day headings keep their own formatters.
- Settings now has its own icon (sliders); it no longer repeats Today's sun.
- Inbox: worker health and browser-alert state share one compact row. Connections: the page heading is readable; the three Canvas panels (feed, API, matching) share one padding and spacing rhythm, with no horizontal overflow at 320 px.
- Not changed: copy, states, routes, or any behavior to preserve above.

### 2026-10-12 — Frontend Phases 6 and 7: Inbox, AI and Connections

- Inbox routes: `/inbox` (Notifications), `/inbox/reminders`, `/inbox/reminders/new`, `/inbox/reminders/:id`; `/reminders` redirects to `/inbox`. Unknown reminder: "This reminder is not available." Below 1024 px the editor replaces the list.
- Notifications: unread first then newest; Mark loaded read and Load older (history) are online-only. A delivered reminder's notification offers Snooze once; the source then shows Snoozed (`REMINDER_ALREADY_SNOOZED` is explained). The nav unread count uses `/notifications/summary` (online-only); the notification list read is cached.
- Reminders: chips Scheduled/Paused/Delivered/Failed/Cancelled; Pause, Resume, Retry, Cancel (confirmed). Only queued, paused, failed and delivered reminders open the editor. The editor keeps its base version; a newer version or conflict disables Save until **Load latest version**. Past times are allowed and delivered on the worker's next check; snooze must be within 365 days. A local time in a DST gap is rejected and a repeated time needs Earlier/Later.
- Worker health and permission state are visible in the status panel; closed-app delivery is still unimplemented.
- AI (`/settings/ai`): one page, all sections mounted. "Request checks" is the renamed preflight; reasons are plain text with the code in details; unavailable approved providers still block, never fall back. Everything remains preview/metadata only; nothing calls a provider. No UI yet for request/attempt history, quotes or consent.
- Connections: `/settings/connections` cards; `/settings/connections/canvas` with `?tab=api|matching` (feed is the default, no query). Outlook/Proton cards read "Not available yet". Region names (`Canvas connection`, `Canvas API connection`, `Canvas reconciliation`) are unchanged.
- Tests: `tests/e2e/inbox.spec.ts`, `connections.spec.ts`, `apps/web/tests/reminders.test.ts`, router tests; shell helpers `inboxRegion`/`showReminders`/`newReminder`/`openCanvas`; features, canvas*, hub and ai-* scenarios ported.
- Known limits: no screen-reader, emulator or Kompakt verification (Phase 8 device items open); Canvas rows not on `ItemRow`; no e-ink `Pager`; initial JS 568.8 kB.

### 2026-10-12 — Frontend Phases 2b and 5: Appearance profiles and Classes

- Appearance (Settings › Appearance, device-local): `localStorage` keys `hub:eink` (mode), `hub:appearance` (colors, text size, density, shape), `hub:appearance-profiles` (≤ 20, names ≤ 40 chars) and `hub:appearance-profile` (active). Applied before first paint in `main.tsx`. Four user colors (accent, background, surface, text) derive the other tokens; a set below 4.5:1 text or 3:1 border/accent contrast is rejected with the measured ratio and the previous theme stays. E-ink forces monochrome and square corners and hides color editing. Targets never fall below 44 px (48 px e-ink). Built-in profiles (Standard, E-ink) cannot be edited or deleted. Loading, replacing and deleting a profile ask for confirmation. Invalid stored data falls back to defaults. Nothing is synced or sent to the server; there is no export.
- Classes routes: `/classes`, `/classes/new`, `/classes/:id` with `?section=study|canvas|details` (Topics is the default and omitted). Unknown id → "This class is not available." with Back. Below 1024 px the detail replaces the list.
- Topics: progress (0–100) and confidence are the owner's own assessments. "Not assessed" shows until either is set; the progress bar appears only when assessed; the list average counts assessed topics only. Plan study / Plan class study hand `{courseId, topicId, title}` to the Calendar editor (not persisted). Delete asks for confirmation; the class delete also removes its topics, while study blocks and Canvas links stay.
- Drafts: class and topic forms keep the `expectedVersion` they started from; a version conflict or newer version shows "Changed elsewhere", keeps the edits, disables Save and requires **Load latest version**. Writes are online-only and idempotent; reads are cached for offline viewing.
- Study blocks: calendar events with the class's `courseId`, split Upcoming (recurring counts here) and Earlier; they link to the Calendar editor. Completing one does not change topic progress.
- Tests: `apps/web/tests/appearance.test.ts`, `classes.test.ts`, router test; `tests/e2e/appearance.spec.ts`, `classes.spec.ts` (addresses, keyboard-only add/assess/delete, conflict draft, study blocks, axe/overflow/targets at 1280 px and 320 px e-ink); class helpers `classesRegion`/`openClass` in `shell.ts`; features/canvas/canvas-lms scenarios ported.
- Known limits: no manual academic Work section (grades, status, workload source history) yet; no archived classes (not in the contract); appearance is per device and not synced; Kompakt rendering of custom colors is unverified.

### 2026-10-12 — Frontend Phase 4: Calendar

- Routes: `/calendar` (Agenda, 7 days from `date`), `?view=week` (Monday-start week) and `?view=day`; `?date=YYYY-MM-DD` is kept in every link. Editor: `/calendar/new`, `/calendar/:id` (series) and `/calendar/:id/occurrence/:date`; the visible window stays in the query so Back returns to it. Navigation links keep an open editor, so a draft survives browsing.
- Data: cached `/api/v1/calendar/occurrences` (viewing timezone, ≤ 93 days) plus the cached Canvas calendar range. Canvas entries are read-only and never open the editor. Agenda hides empty days; Week lists all seven with "Nothing scheduled." There is no time grid.
- Row: title link (recurring rows open the occurrence editor; the editor links to the entire series), time or "All day", "Repeats …", "Edited occurrence", cancelled state, study class/topic/status, "In <zone>" when the event zone differs from the viewing zone.
- Viewing timezone is a header disclosure ("Viewing timezone: …", Apply). It is not persisted and resets on reload. New events navigate to the day they start (in the viewing zone) with an "Added …" notice.
- Editor: sections Basics, Time, Repeat, Study, Label. Draft keeps the `expectedVersion` it started from; `VERSION_CONFLICT` or a newer version arriving shows "Changed elsewhere" with **Load latest version** and a differences list; Save stays disabled until loaded. A series deleted elsewhere blocks Save and keeps the draft. Calendar writes are online-only; the offline error is shown inline.
- Times: an ambiguous local time (fold) shows an Earlier/Later radio group with UTC offsets, only when the entered time is a fold; changing the time or zone resets the choice. A gap time is rejected with a message that names the gap. Reversed times are an inline field error. Saving a change to start/zone/all-day/repeat on a series that has edited occurrences shows "Saving resets this series’ edited occurrences and cancels their reminders." before saving.
- Delete: an occurrence or series asks "This occurrence" / "Entire series" (both danger). Deleting a series shows **Undo** (restore with the tombstone version) and **Recently deleted** (`/planner/deleted?kind=calendar`, online only, shared `DeletedItems`); deleting one occurrence has no Undo. The legacy "Complete session" button is replaced by the Status select in the editor.
- Tests: calendar scenarios in `features.spec.ts`, `hub.spec.ts` and `canvas.spec.ts` were ported; new `tests/e2e/calendar.spec.ts` covers DST gap/fold, scope dialog, series reset, Undo/restore, keyboard-only create/edit, and axe/overflow/target checks at 1280 px and 320 px e-ink. Unit tests: `apps/web/tests/calendar.test.ts`, router test for calendar addresses. Helpers (`showCalendar`, `newEvent`, `calendarDay`) live in `tests/e2e/shell.ts`.
- Known limits: no persisted viewing zone, no study-plan or academic-deadline rows in Agenda yet, no offline calendar writes, no per-field diff for occurrence-only changes. Browser results do not establish Kompakt compatibility.

### 2026-10-12 — Frontend Phase 3: Tasks

- Routes: `/tasks` (Open), `/tasks?filter=due-soon|overdue|no-date|done`, `/tasks/:id` (editor; an optional `filter` is kept for the Back link). Unknown filters fall back to Open; a non-UUID id falls back to the list. Filter links show counts; the list heading shows the visible count.
- Data: the cached full `/api/v1/tasks` list (offline-capable). Filtering/grouping is client-side (`lib/tasks.ts`): Overdue, Today, Next 7 days, Later, No date; Done is one flat list, newest change first. Deadlines are date-only and never changed by grouping. The list reloads when the outbox content changes, not on every status event.
- Row: completion checkbox (`Complete <title>`), title link to the editor, due date, chips for high priority, owner label (Personal/Restricted), Canvas / Class work source, and Queued / Locked / Conflict. Completing a task moves it out of Open; focus moves to the list heading if the row disappears.
- Editor: title (required, focus on error), notes, due date, priority, content label, completed, source panels (Canvas, class work). Save sends `expectedVersion` from when the draft was made; newer server data is never adopted silently. `VERSION_CONFLICT`, or a newer version arriving by reload, shows "Changed elsewhere" with **Load latest version**; Save stays disabled until it is loaded, then a differences list shows the latest values and the draft is kept. A queued sync conflict or a task deleted elsewhere blocks Save with an explanation; the draft remains.
- Delete: online deletes show **Undo** (restore with the tombstone version); offline deletes are confirmed and shown as "queued for sync" with no Undo. **Recently deleted** (`/planner/deleted?kind=task`, online only, paged with Load more) restores tasks. Restore does not restart reminders cancelled by the deletion; the UI says so.
- Global task-conflict banner is unchanged and now links each conflict to **Open task**; Discard local changes stays confirmed there.
- Quick capture and `ReadState` are shared with Today (`QuickCapture.tsx`, `ReadState.tsx`). `PlannerBoard.tsx` (always-open form, Reload list, per-row Edit/Delete) is removed.
- Layout: < 1024 px shows the editor alone with a Back link; ≥ 1024 px keeps the list beside the editor. 44/48 px targets, e-ink status chips use text plus border, no colour-only state.
- Known limits: server search/paging (`/tasks/browse`) is not used; the list loads all tasks. Selected changes (`/tasks/batch`) were added later; see the 2026-10-12 Tasks selection entry. Completing a task from the list while its editor is open for the same task shows "Changed elsewhere" in the editor. Restore needs a connection. Browser/emulator results do not establish Kompakt compatibility.
- Tests: hub, offline, Canvas and conflict scenarios were ported without weakening assertions (labels are now chips, the conflict reload is "Load latest version", completion is verified in Done). New `tests/e2e/tasks.spec.ts` covers grouping/filter URLs, Undo and Recently deleted, title validation, unknown-task address, and axe/overflow/target checks at 1280 px and 320 px e-ink. Shared helpers (`addTask`, `openTask`, `showTasks`) live in `tests/e2e/shell.ts`.

### 2026-10-10 — Frontend Phase 2: Today

- `/today` composes five independently loaded owner-authorized cached endpoints: tasks, today's expanded calendar occurrences, Canvas calendar range, reminder status and notifications. A section failure does not hide successful sections. Each read has its own reload/retry and cached timestamp, rather than inferring freshness from the global connection indicator.
- Needs attention shows open overdue tasks with original date-only deadlines and failed reminders. The shell's persistent task-conflict banner remains above the view. Due today and the following seven dates exclude completed tasks; undated tasks remain accessible in Tasks. Today never changes deadlines or writes reminder state.
- Today's schedule uses the device's IANA timezone and an exclusive one-day range; all-day items come first, then timed events and Canvas entries in chronological order. Study time has its own status; Canvas point deadlines remain read-only source facts with availability and import freshness. Feed/API associations are not merged or inferred here.
- Quick capture expands on demand, focuses the title field and accepts an optional deadline. It uses the existing task mutation transport, stable operation/client IDs and durable outbox. Failed saves retain input; successful capture resets it. Global sync status distinguishes queued changes from confirmed saves. Close returns focus to the capture button.
- Legacy Events editor is removed from Today. Existing events remain in Calendar with its timezone-aware editor. Task CRUD/source/conflict tests now use Tasks; the reversed-time event test uses Calendar and verifies its stored timezone through Edit.
- Date grouping updates at local midnight and on focus. Other sections refresh on request or remount; Today does not poll, raise browser alerts or mark notifications read. Unread preview shows the latest three of the endpoint's bounded notification list, with its unread count and a link to Inbox.
- New `getSnapshot` transport helper exposes authorized cache timestamps without changing payload contracts, cache allowlists, storage format, outbox replay or authorization. Today is a precached lazy chunk; initial JS remains approximately 532 kB.
- Known limits: device timezone is used without a separate Today picker; no inline task editing/completion, API-assignment feed synthesis, study suggestions or email preview. Browser/emulator results do not establish Kompakt compatibility. Appearance profiles/custom colors are planned in Phase 2b, not implemented in this slice.
- Validation: `npm run check` passed (112 tests; 1 optional PostgreSQL test skipped) and all 43 browser tests passed. New Today coverage exercises failed delivery, latest-three unread preview with zero read writes, overdue/due/upcoming grouping, unchanged deadlines, Canvas deadline versus reserved study time, section failure/retry isolation, cached offline reload and quick-capture replay exactly once at 320 px in e-ink. Automated accessibility/target checks pass for every route. Synthetic databases only; desktop visual review caught and corrected panel padding.

### 2026-10-10 — Initial handoff

Recorded the current functional screens, backend boundaries, offline/conflict requirements, complete label history, explicit Canvas reconciliation, and deferred device/agent work. Starting verification receipt: 81 API/client tests passed, 29 browser tests passed; optional standard PostgreSQL check was skipped locally. This receipt predates subsequent entries.

### 2026-10-10 — Server profiles, preflight history, and limits

Preferences now includes server-declared profile visibility, preflight checks/history, and spending-limit forms. See [gateway contracts and reasons](ai-gateway.md). Keep these distinct from simulated Routing preview and from future executed requests.

- `configured` means enabled with a credential present; provider health and model support remain unchecked. Profile identifiers are not secrets, endpoints, or proof that an adapter works.
- Every accepted preflight is blocked. A nested selected route does not mean dispatched, completed, affordable, or authorized for later execution.
- Metadata persists; prompt/source text does not. Null context counts mean not assembled. Hide retains a tombstone and does not permanently erase metadata. Retry responses are historical idempotency results, not live record state.
- Current text projections include base events and current planning fields; they do not include occurrence replacements or captured Canvas snapshot text. A rewrite must not imply broader context coverage.
- Limits are integer USD millionths, displayed with exact decimal conversion. Both blank means unconfigured; zero blocks; request limit must fit the monthly limit. Saving limits does not enable execution, prove affordability, or approve retention. UTC is the planned monthly boundary.
- A settings save emits `hub-ai-settings-changed`. Preflight retains its input, shows a reload state, and disables submission until current policy/budget/task/profile versions load. External changes still produce version conflicts. Reload must not discard input or enable saving while pending.
- These controls are online-only and are not added to the task outbox or offline response cache. History is bounded and pages through owned receipt IDs, including retained hidden cursors.

Known UI debt: separate routing/preflight task pickers and repeated form state are functional scaffolding. Consolidation is deferred. Preserve simulation versus configuration/health distinctions and visible blocking reasons during that redesign.

### 2026-10-10 — Internal budget accounting and late responses

The server now has reservation, uncertain, settled, and released accounting states, with optimistic/idempotent transitions and atomic owner admission. No production worker or HTTP write route uses this engine yet. Preflight checks never reserve or spend money. Price quotes, billing reconciliation, consent/retention and executable requests remain pending.

- Recorded spend is confirmed accounting; held funds are maximum reservations. Uncertain funds are included in held funds, not an additional amount to sum. Never release an uncertain hold automatically after timeout, restart, or a month boundary.
- Current-month totals use UTC admission-month attribution. Earlier-month unresolved/uncertain holds remain tracked and visible separately. These amounts are not a provider invoice or total account spend.
- Amounts/totals must retain exact millionth-USD arithmetic. Aggregate usage arrives as decimal strings, including values above JavaScript's safe integer range. Do not convert totals through `Number` or round before comparisons.
- A confirmed charge above its hold is an overrun, with a visible warning. Changing a limit does not erase holds or recorded charges. Per-request limits currently apply to inference steps; whole-conversation/responsibility budgets are pending.
- Current API settings require a complete usage snapshot. Older exports can have null usage, which means unknown rather than zero. Export includes safe reservation metadata; an in-app reservation detail/workflow is later scope.
- Delayed preflight loads must not overwrite newer loads or clear a settings-change warning. The current implementation guards both load generations and settings changes during a load. Preserve input and require another reload if a save races with that load.
- Valid profile aliases/models can be long. Expanded metadata must wrap on narrow screens; this is functional layout, not a final visual design.

### 2026-10-10 — Gateway validation receipt

`npm run check` passed lint, strict types, formatting, production builds and 102 API/client tests; one standard PostgreSQL test was skipped because the isolated test URL is unset. `npm run test:e2e` passed all 32 browser tests, including lost-response/conflict recovery and the settings-change/load race. Two compiled API smoke checks applied all 18 migrations to isolated in-memory databases and exercised planner/Canvas/routing/export plus preflight/accounting with zero provider calls. The owner database was not used or reset.

The web build remains about 603 kB minified with a size advisory. No new dependency or hardware verification was added. Standard PostgreSQL concurrency, remote CI, live provider health/pricing/dispatch and actual Kompakt behavior remain unverified. Later UI work should preserve these assertions and repeat the UI/authentication suite after its changes.

### 2026-10-10 — UI guidelines and rewrite plan (adopted)

Added [ui-guidelines.md](ui-guidelines.md) and [frontend-plan.md](frontend-plan.md). Owner decisions are recorded in plan §6 and D46; Phase 0 starts on branch `ui/phase-0`. Audit findings recorded in the plan: no URL routing (reload/Back lose the view), always-open editors, a full sync panel on every screen, 600 kB single bundle, and a service worker that caches only fetched files keyed by URL. Lazy-loaded routes must not ship before navigation fallback and asset precaching exist, or offline navigation breaks. Platform floor for the rewrite is Chromium 113 (verified emulator WebView) until Kompakt is measured.

### 2026-10-10 — Phase 0 foundations (branch `ui/phase-0`)

Implemented; see [frontend-plan.md](frontend-plan.md) Phase 0.

- **URLs.** Views live at `/today`, `/calendar`, `/classes`, `/reminders`, `/connections` and `/preferences` (renamed in Phase 1). `/` and unknown paths become `/today` without a history entry. Reload, Back/Forward and bookmarks restore the view; focus moves to the view `<h1>` after navigation and `document.title` follows. `lib/router.ts` re-reads the address bar when it subscribes, because a Back pressed before the listener attached was otherwise lost (found by e2e). Static hosts must serve `index.html` for unknown non-asset paths.
- **Offline shell.** The build writes a versioned precache list into `sw.js` (now `src/sw.js`, served by a Vite plugin in development). Install caches every built asset, so views outside Today, which load lazily and are prefetched after sign-in, work offline after one online load. All navigations share the cached app shell. Lookups ignore `Vary` because servers answer module requests with `Vary: Origin`. Fonts are cached. Native Android still does not register the service worker.
- **Bundle.** Initial chunk 525 kB (was 604 kB), dominated by react-dom, Zod and the Temporal polyfill via the contracts barrel. Reaching ≤ 250 kB needs a contracts entry-point split (Phase 8).
- **Styles.** Tokens/base/legacy layers; self-hosted Atkinson Hyperlegible Next (~53 kB woff2, Latin and Latin-extended); no text below 13 px; control borders ≥ 3:1. E-ink targets are 48 px and disabled controls use dashed borders instead of opacity.
- **Data hooks.** `useResource` (abort, stale-response guard, optional polling) and `useMutation` (per-action operation identity, conflict flag, per-action pending) in `lib/hooks.ts`. Reminders uses them with unchanged markup; mark-read now reuses its operation ID on retry. Other screens still use their own copies until replaced.
- **Offline status.** `offlineStatus()` adds `queued` task IDs and `locked`; not yet shown in the UI.
- **Checks.** `tests/e2e/accessibility.spec.ts` runs axe (WCAG 2.0–2.2 A/AA tags), overflow and target-size checks on every view for standard 1280 px and e-ink 320 px. These automated checks do not replace keyboard or screen-reader passes.
- **Known issue for Phase 1.** `AuthGate` shows the sign-in form while the session check is pending, so every load briefly shows Sign in.
- **Verification.** `npm run check` passed (110 tests; 1 PostgreSQL test skipped); `npm run test:e2e` passed 37 browser tests. Synthetic databases only.

### 2026-10-10 — Phase 1 shell (branch `ui/phase-0`)

Implemented; see [frontend-plan.md](frontend-plan.md) Phase 1.

- **Navigation and URLs.** `/today`, `/calendar`, `/tasks`, `/classes`, `/inbox`, `/settings/{account,appearance,connections,ai}`. `/preferences`, `/connections` and `/reminders` redirect. Wide screens (≥ 1024 px) use a left rail; narrower screens use a fixed bottom bar with More (Inbox, Settings, E-ink mode). Items are links with `aria-current`. Inbox shows the unread notification count as text (refreshed on navigation). `/tasks` temporarily shows the existing task panel; Today is unchanged until Phase 2.
- **Header.** View `<h1>` (focused after navigation, not on first load), the date on Today, and the task sync summary `<Connectivity> · <Queue>` with role `status`: Online/Offline/Server unavailable · All saved / N queued / Conflict · N / Locked · N queued. "Sync" toggles the details region "Task sync" (Sync now, cached time, Help) below the header, in the page flow. Escape closes it and returns focus to the toggle.
- **Banners.** "The hub server is unavailable." with Retry connection, and the "Task conflicts" alert banner listing conflicts with their local drafts. Discard now uses an in-page `<dialog>` that focuses Cancel; queued drafts remain until confirmed.
- **Help.** A "Help" button (`Help: <topic>`, `aria-expanded`) reveals text in a polite live region. Escape and outside clicks close it. Escape is handled by the innermost disclosure only.
- **Settings.** Account (password, sessions, export, Sign out with signed-in email), Appearance (e-ink), Connections (Canvas feed/API/matching and planned accounts), AI (permissions, limits, request checks). Sign-out still refuses while task changes are queued.
- **Startup.** "Checking sign-in…" replaces the sign-in flash; the stored e-ink theme applies before first paint, including the sign-in screen.
- **Tests.** `tests/e2e/shell.ts` helpers (`open`, `openSettings`, `toggleEink`, `syncState`, `syncNow`, `signOut`) navigate through More at narrow widths. The accessibility suite covers every route and Settings section, checks e-ink computed styles (black/white fills only, no shadows or transitions) and that keyboard focus is never fully hidden behind the bottom bar.
- **Known limits.** The More panel overlays the content above the bar while open (closes on Escape, outside tap or navigation). Legacy panels inside screens keep their old structure until their phase. Kompakt hardware, Android Back with History routing, and TalkBack remain unverified.
- **Verification.** `npm run check` passed (112 tests; 1 PostgreSQL test skipped); `npm run test:e2e` passed 39 browser tests. Synthetic databases only.


Final verification after the approval-lock read change: all 12 email draft tests passed again; targeted lint/format checks and `git diff --check` passed.

### 2026-10-13 — Inbox: paged reminder history

- Inbox › Reminders adds an expandable **Reminder history** section. Opening it loads the owner-only `/api/v1/reminders/history` endpoint with the shared `reminderHistorySchema`, 25 records per page, creation timestamp/ID ordering and `before` cursors.
- **History status** filters all/scheduled/delivering/paused/delivered/failed/cancelled. Filter changes reset rows and cursor; delayed reads from an old filter or unmounted view cannot replace current rows. **Reload history** starts a fresh first page; new arrivals are not silently added to the loaded pages.
- **Load more reminders** appends unique IDs. A page failure preserves loaded rows/cursor and offers retry or a fresh reload. Loading, empty and actionable error states remain visible. History is online and read-only; it does not expose mutation controls or cached/outbox writes. Current reminder editing, controls, snooze, earlier reminders and notification behavior are preserved.
- Help explains creation ordering, changing status across pages and the boundary between durable inbox delivery and device alerts. Closed-app native delivery, permanent purge, offline history and frozen cross-page snapshots remain unavailable. No provider execution or backend changes.
- Focused browser checks passed all nine Inbox tests, including real synthetic records paged across 25 rows, failed-page retry without duplicates, delayed filter response and expanded-view axe/overflow/target checks at 1280px standard and 320px e-ink. Broader validation is recorded in implementation-log.md.
