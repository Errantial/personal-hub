# Personal Productivity Hub

Schedule, task, email, and study hub targeting the web, Android, and Windows.

Status: authenticated web/API planner implemented, including tasks, day/week calendar, all-day and recurring events, individual occurrence edits, class/topic portfolios, manual study blocks, and durable reminders with an in-app inbox. Preferences includes password changes, session revocation and versioned planner JSON export. Read-only Canvas calendar entries appear in Calendar and linked class portfolios; Connections creates source-linked tasks and study blocks with inspectable provenance. A separate Canvas API adapter imports course and assignment metadata, retaining personal notes, labels and explicit class links through durable refreshes. Connections also creates tasks and study blocks from API assignments with captured/current provenance and version checks. Live school access/completeness remains unverified; grades remain pending. Explicit feed/API reconciliation retains separate facts while sharing labels and provenance. Preferences includes AI routing permissions, server profiles, spending limits, and metadata-only preflights; model dispatch remains disabled. Includes SQL migrations, shared TypeScript/Zod contracts, conflict checks and retry deduplication. Browser and provisional Android prototypes cache loaded views and queue task edits offline; APK process-restart/replay checks pass on an AOSP emulator. Email integrations, AI execution, MCP, persistent agents and server deployment remain upcoming. Kompakt hardware verification is deferred while core server/site development continues. Browser alerts require an open Inbox view; closed-app native alerts remain future work.

Backend responsibility reviews now support [local daily/weekly schedules](docs/responsibility-local-schedules.md), preserving wall-clock cadence across DST with explicit missed-slot admission. Review records remain blocked placeholders; UI and agent execution are pending.

The backend also has [verified AI context binding and explicit memory selection](docs/ai-verified-context.md), plus an internal fake-adapter text-result flow. Live model calls and public result delivery remain disabled.

Owner-confirmed AI policy now has a $50 monthly ceiling, a $0.25 initial request allowance and [explicit per-request saved answers](docs/ai-provider-setup.md). Actual subscription/API provider execution remains pending.

[Offline Claude response inspection](docs/ai-claude-response.md) now validates bounded native JSON guidance and source references. Usage remains an unverified estimate; the decoder enables neither inference nor accounting settlement.

[Transient context review](docs/ai-context-preview.md) exposes the bounded text assembly to the owner without saving it or enabling inference.

## Run locally

Requires Node.js 24 and npm 11.

```sh
npm ci
npm run doctor
npm run dev
```

Open `http://127.0.0.1:5173`. Create your owner login on first use. The API runs on port 3001; embedded PostgreSQL data persists in `.data/planner/`. Run `npm run check` for lint, type checks, unit/API tests, formatting, and builds. For browser verification, run `npx playwright install chromium`, then `npm run test:e2e`.

See [development guide](docs/development.md) for setup, configuration, API contracts, database operations and limits. [Implementation backlog](docs/backlog.md) separates completed work from the next milestones.

Confirmed: personal use first with future expansion; school Canvas/calendar, school Outlook email, Proton Mail including Gmail, and Proton Calendar. Android supports offline viewing and queued edits. AI may change writable calendars automatically; sending email requires explicit approval. Permissions will become configurable.

Priority: Windows website and Mudita Kompakt Android APK first. Dedicated Windows app and Kindle Scribe are deferred. Hosted AI API initially, with a later self-hosting option. Paid Proton Bridge access and prior feed/browser automation routes are established; app-specific validation remains.

Planned server: Oracle Cloud Ubuntu, 24 GB RAM and 4 OCPUs. MCP is planned in both directions. Hosted AI receives relevant text only, excluding screenshots and attachments. Keep routine costs low and meter stronger-model features within the owner-confirmed $50 monthly ceiling and $0.25 initial request allowance.

AI permissions include provider-routing rules based only on sources/content explicitly labeled by the owner. Derived context inherits labels; unlabeled content uses the default route. Labeled sensitive context goes to an approved provider with no silent fallback.

## Start here

1. [Product requirements](docs/product.md): user experience, feature scope, and acceptance criteria.
2. [Architecture](docs/architecture.md): platform strategy, data model, sync, AI, and privacy.
3. [Integration feasibility](docs/integrations.md): Canvas and Proton constraints, with official sources.
4. [Development roadmap](docs/roadmap.md): proof-of-concept gates and delivery order.
5. [Decision register](docs/decisions.md): assumptions and unanswered questions.
6. [Target platforms](docs/platforms.md): Kompakt constraints and deferred device scope.
7. [Deployment and AI policy](docs/deployment.md): Ubuntu services, CPU compatibility, text boundary, and cost controls.
8. [AI permissions and routing](docs/ai-permissions.md): sensitivity rules, provider selection, and context boundaries.
9. [Persistent agent scope](docs/agent-scope.md): OpenAI Dots/OpenDots-style responsibilities, scheduled work, memory and controls.
10. [Implementation backlog](docs/backlog.md): current progress, acceptance checks, unresolved verification and next work.
11. [Android prototype](docs/android.md): APK builds, isolated emulator server and hardware boundaries.
12. [Canvas calendar ingestion](docs/canvas.md): private feed setup, read-only imports, notes and refresh boundaries.
13. [Canvas API metadata](docs/canvas-api.md): private token setup, course/assignment sync, class links and access boundaries.
14. [Canvas reconciliation](docs/canvas-reconciliation.md): confirmed source associations, label provenance and linked planner work.
15. [AI gateway foundation](docs/ai-gateway.md): server profiles, spending limits, bounded preflight and metadata history; execution disabled.
16. [UI agent ledger](docs/ui-agent-ledger.md): behavior and state requirements for the later UI rewrite.
17. [UI/UX guidelines](docs/ui-guidelines.md) and [frontend plan](docs/frontend-plan.md): adopted design rules and the phased UI rewrite; implementation in progress.

## Working direction

Today now shows overdue tasks, today's planner/Canvas schedule, due/upcoming tasks and unread reminders, with independent cached sections and offline task capture. The UI rewrite (Today, Tasks, Calendar, Classes, Inbox, and Settings with Appearance, Connections and AI) is implemented on branch `ui/phase-4`; device and screen-reader verification remain open. See the [frontend plan](docs/frontend-plan.md).

Build a dependable daily planner first, then connect academic deadlines and email, then add AI actions through the same validated operations used by the UI. Introduce basic class tracking and an e-ink-friendly interface early.

The central planning constraint is Proton: desktop Bridge access and read-only calendar feeds do not provide an unrestricted cloud/mobile integration. Investigate the owner's previous automation workarounds and verify the required workflows before choosing a hosting or desktop strategy.

## Readiness boundaries

[Responsibility review inbox](docs/responsibility-inbox.md) adds global blocked/history browsing with current source metadata, full attention counts and atomic versioned selected dismissal. It creates no notifications or execution; UI controls remain pending.

[Responsibility lifecycle and scheduled reviews](docs/responsibilities.md) add owned pause/resume/cancel records, UTC schedules/due previews, atomic owner-selected blocked review admission, run dismissal/activity and export. No background scheduler, agent/provider execution or autonomous actions are enabled. UI integration and runtime gates remain pending.

[Editable owner memory](docs/memory.md) adds preferences/goals/facts, versioned correction/disable controls, metadata-only receipts and logical text removal on forgetting. Owned browsing/export are available; UI and verified AI retrieval remain pending. Enabling memory never starts provider calls.

[Email attempt lifecycle](docs/email-attempts.md) adds durable one-attempt consumption and uncertainty handling through an internal test-only synthetic harness, with owned history/export. Synthetic outcomes do not prove real delivery; no send endpoint, worker or live adapter exists. All send previews remain blocked.

[Email draft approvals](docs/email-drafts.md) add owner-entered plain-text drafts, exact-message review/approval, atomic invalidation, retained history and blocked send previews. No mailbox access, attachments, sender verification or sending is enabled. UI review and verified send adapters remain pending.

[Typed action permissions](docs/ai-actions.md) add owner task/calendar automation modes and a read-only authority/capability preview. Email approval remains mandatory; Canvas is read-only and external writes remain unverified. This authority preview enables no execution or approval; exact-message email review records are available separately. UI controls are pending.

[Task browsing and selected changes](docs/task-management.md) add bounded completed/open task history, full filter counts and atomic versioned batch completion, priority, deadline and delete operations. Source history and owner fields are preserved; UI integration remains pending.

The [task agenda and Today attention summary](docs/today-summary.md) provide full task deadline buckets, guarded paging, manual academic workload counts and current reminder/unread attention in consistent owned reads. UI integration is pending; existing independent Calendar/imported-source views and offline task drafts keep their behavior.

The [academic deadline agenda](docs/academic-agenda.md) now provides owned, date-sorted open manual work across classes, overdue/today/upcoming/undated buckets and full horizon counts with explicit missing estimates. UI and offline integration remain pending; provider deadlines and Calendar reservations stay separate.

[Academic management](docs/academic-management.md) adds guarded all-status browsing and atomic selected status/deadline/effort/priority/deletion with score protection. [Calendar batches](docs/calendar-management.md) add selected whole-record deletion and one-time study-status changes, preserving source/recurrence history. UI/offline controls remain pending.

Manual academic-work backend supports class-linked assignments/exams, owner-entered deadlines/effort/submission/scores, restore/history and missing-data summaries. Explicit [linked task/study creation](docs/academic-planning.md) adds atomic source snapshots, captured/current inspection, paged linked work and status/time reports. [Academic reminders](docs/academic-reminders.md) suppress delivery when work is closed, deleted or in an archived class. [Verified manual academic context](docs/ai-academic-context.md) supports explicit work/class versions and direct planner origins without grades; workload-plan/legacy incomplete provenance stays blocked. New UI controls and live grade/submission import remain pending; see [academic-work contracts](docs/academic-work.md).

Reminder/inbox backend now supports durable snooze, paged history, full unread counts and atomic selected-notification mark-read. These controls await UI integration and retain the existing in-app delivery boundary; see [reminder contracts](docs/planner.md#snooze-and-inbox-history-backend-implemented-2026-10-11).

The study-planning backend now supports saved availability/goals, reasoned priorities using manual assessments and open academic deadlines/effort, planner conflict checks, draft editing, atomic approval/cancellation and progress reports. [Durable workload history](docs/study-workload.md) shows captured/current planning facts and retains source labels through block edits and deletion. Weekly goals remain the time budget; grades and study time do not infer assignment completion. Deleted tasks/calendar records have a paged browsing endpoint. These backend slices await UI integration; see [study contracts](docs/study.md). External calendars are not checked by study previews, and workload-derived blocks remain blocked from AI.

Backend AI lifecycle now includes metadata-only requests, owner cancellation/hiding, and an internal synthetic-only attempt/accounting harness with restart recovery. Live dispatch and lifecycle UI remain pending; see [gateway contracts](docs/ai-gateway.md#durable-requests-and-synthetic-attempts).

- Initial audience, required accounts, target devices, and offline behavior are agreed.
- Local web/API development is unblocked and has an authenticated persistence slice.
- Canvas authentication and required Proton workflows still need app-specific demonstrations before dependent integration features are promised.
- Server-side AI data access and model hosting are agreed.
- Kompakt packaging/offline/closed-app notification behavior remains an open device gate.
- The first implementation milestone has bounded scope and measurable acceptance criteria.

Research baseline: 2026-10-09; implementation/scope updated 2026-10-12. Recheck provider requirements when implementation starts.
