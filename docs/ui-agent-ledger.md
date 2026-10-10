# UI agent ledger

Started 2026-10-10. This is a handoff record for the later UI rewrite, not a design specification. Read [product scope](product.md), [development](development.md), [backlog](backlog.md), and [planner behavior](planner.md) alongside it. Entries describe implemented behavior unless explicitly marked pending.

## Working agreement

- Prioritize functional backend work now; visual refinement is deferred to the UI agent.
- Prefer a concise title or label. Put secondary explanations in keyboard- and tap-accessible Help or expandable details. Keep actionable errors, pending/offline/conflict states, and essential warnings visible.
- Preserve shared contracts, relative `/api` URLs, authorization, versions, operation IDs, and retained drafts when replacing components. A successful request and a confirmed provider action are different states.
- Record new behavior, required states, contract changes, and known limitations here as development proceeds. Do not describe proposals as shipped features.

## Implementation map

| Area | Starting points | Behaviors to preserve |
| --- | --- | --- |
| App/navigation | `apps/web/src/App.tsx` | Owner authorization gates private views; preferences include e-ink mode. |
| Authentication/account | `AuthGate.tsx`, `AccountSettings.tsx` | Enrollment, sign-in, password reauthentication, session rotation/revocation, planner export. |
| Tasks/sync | `PlannerBoard.tsx`, `SyncStatus.tsx`, `lib/offline.ts` | Durable task outbox, stable IDs, version conflicts, same-owner recovery. |
| Calendar | `CalendarWorkspace.tsx`, shared `occurrences.ts` | Timezones, date-only events, recurring series/occurrences, separate study blocks and imported deadlines. |
| Classes | `AcademicWorkspace.tsx`, `ClassCanvasEntries.tsx`, `ClassCanvasAssignments.tsx` | Manual class/topic assessments, explicit Canvas links, cached loaded portfolios. |
| Reminders | `ReminderWorkspace.tsx` | Durable server inbox/worker state and explicit optional browser permission. |
| Canvas | `CanvasConnection.tsx`, `CanvasLmsConnection.tsx`, `CanvasReconciliation.tsx` | Independent feed/API facts, explicit reconciliation, retained note/conflict drafts. |
| Source planning | `CanvasPlanning.tsx`, `CanvasAssignmentPlanning.tsx`, `CanvasPlannerWork.tsx`, `PlannerSource.tsx` | Captured/current provenance, versioned explicit creation, grouped task/study visibility. |
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

Server inbox delivery and native notification delivery are separate. Browser alerts currently require permission and an open Reminders view. Keep permission denial, pause, retry, cancellation, worker failure, and inbox read state understandable. Closed-app push/native alarms are pending.

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
