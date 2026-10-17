# Personal Productivity Hub

The [small OpenRouter mail broker](docs/openrouter-mail-broker.md) replaces the TypeSafe dependency in development, preserving scoped two-hop mail access. Deployment, actual model-quality evaluation and owner acceptance remain pending.

[Tasks from mail](docs/mail-tasks.md) now support owner-reviewed capture with an exact body quote, retained source labels and explicit deadline confirmation. AI suggestions from a selected message fill the owner-reviewed capture form; automatic creation remains excluded.

Schedule, task, email, and study hub targeting the web, Android, and Windows.

Status: the owner-authenticated planner includes tasks, recurring calendars, class portfolios, study-plan approval, reminders, memory editing and exact-message email-draft approval. Read-only Canvas feed/API adapters plus the development browser collector preserve source facts and labels; the school blocks token creation, browser/feed reconciliation is implemented, and live two-course/all-selected-course collector acceptance remains separate. Proton Bridge ingestion and Mail browsing are implemented; Windows mail sync was recorded as operating every ten minutes on 2026-10-14. Required Gmail coverage remains unverified. The Today Assistant supports a narrow OpenRouter planner flow with owner review before Apply, an owner-configured server key/model and saved spending limits. Explicit per-ask memory selection and grounded academic task/study proposals are implemented on the live Assistant path; the separate general AI gateway still has disabled dispatch. Narrow OpenRouter mail category/task suggestions are implemented; email sending remains pending. School Outlook now has a metadata-only feasibility/access gate with no OAuth or mailbox access. MCP remains a long-term requirement but compatibility/implementation is deferred until post-v1. The scheduled agent slice is deployed at https://hub.ecg.name as release `519054d` (2026-10-14); the first owner-created agent/run and live acceptance remain pending. See the [scope and exclusions](docs/superpowers/specs/2026-10-14-persistent-agents-design.md#out-of-scope-recorded-for-future-work).

SQL migrations, shared contracts, optimistic versions, retry receipts and tombstones protect durable operations. Browser and provisional Android clients cache loaded views and queue task edits offline; emulator checks passed, while actual Kompakt hardware and closed-app native reminders remain unverified. HTTPS deployment and same-device backup/restore are implemented; release integration and owner daily-use acceptance are tracked in [the backlog](docs/backlog.md).

Backend responsibility reviews now support [local daily/weekly schedules](docs/responsibility-local-schedules.md), preserving wall-clock cadence across DST with explicit missed-slot admission. Legacy review records remain blocked placeholders. D57 adds scheduled agents, pinned Assistant conversations, action controls and Inbox results within the [approved exclusions](docs/superpowers/specs/2026-10-14-persistent-agents-design.md#out-of-scope-recorded-for-future-work); release `519054d` is deployed and live owner acceptance remains pending.

[Verified mail context](docs/ai-mail-context.md) now resolves explicitly selected imported messages through the text-only routing gateway, with label inheritance and message/connector integrity binding. This general gateway foundation does not dispatch; selected-message classification is implemented through a separate narrow OpenRouter flow.

[Mail categories and explicit rules](docs/mail-organization.md) now provide local organization, protected owner corrections and previewed selected applies. Categories remain separate from privacy labels; Selected-message AI suggestions are implemented separately; autonomous classification/application and provider-side mail changes remain pending.

[Read-only email ingestion](docs/email-ingestion.md) now includes a local Proton Bridge connector, owner-managed upload tokens and Inbox mail browsing. Headers and bounded plain-text bodies are imported; attachments and provider writes remain excluded. Windows upload/scheduling was recorded as operating on 2026-10-14. Selected-message category/task suggestions are implemented; Gmail delivery completeness remains unverified. The earlier Bridge snapshot does not prove current coverage.

The backend also has [verified AI context binding and explicit memory selection](docs/ai-verified-context.md), plus an internal fake-adapter text-result flow. Dispatch remains disabled on this general gateway; the [narrow planner assistant](docs/ai-assistant.md) is a separate implemented flow.

Owner-confirmed AI policy has a $50 monthly ceiling, a $0.25 initial request allowance and [explicit per-request saved answers](docs/ai-provider-setup.md). Subscription execution and general gateway provider execution remain pending.

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

Current server: Oracle Cloud, Oracle Linux ARM64, 10 GiB RAM and two CPUs. MCP is planned in both directions. Hosted AI receives relevant text only, excluding screenshots, attachments and attachment-derived text. Keep routine costs low within the owner-confirmed $50 monthly ceiling and $0.25 initial request allowance.

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

Today now shows overdue tasks, today's planner/Canvas schedule, due/upcoming tasks and unread reminders, with independent cached sections and offline task capture. The UI rewrite (Today, Tasks, Calendar, Classes, Inbox, and Settings with Appearance, Connections and AI) is integrated into main and deployed; actual Kompakt and screen-reader verification remain open. See the [frontend plan](docs/frontend-plan.md).

Build a dependable daily planner first, then connect academic deadlines and email, then add AI actions through the same validated operations used by the UI. Introduce basic class tracking and an e-ink-friendly interface early.

The central planning constraint is Proton: desktop Bridge access and read-only calendar feeds do not provide an unrestricted cloud/mobile integration. Investigate the owner's previous automation workarounds and verify the required workflows before choosing a hosting or desktop strategy.

## Readiness boundaries

Status reconciled 2026-10-14 against the deployment receipt for release `519054d` and the dated [implementation log](docs/implementation-log.md). The [agent acceptance checklist](docs/agents-acceptance.md) keeps deployment, synthetic checks and live owner acceptance separate. The [post-agents development plan](docs/post-agents-development-plan.md) sets the next gated sequence.

- Task/Calendar selected changes, Undo/Recently deleted, manual academic Work management, study availability/goals/plan approval, reminder snooze/history, memory editing and exact-message email-draft review have UI controls. These online controls do not imply offline batch editing or complete coverage of every backend inspection/report endpoint.
- [Memory](docs/memory.md) supports owner editing, enable/disable and forgetting. Explicit per-ask live Assistant selection is implemented with version pinning and derived-history revocation when a memory is disabled/forgotten; automatic retrieval/ranking, agent memory authority and model-authored memory remain separate work. Enabling memory still does not itself send anything to a provider.
- [Study planning](docs/study.md) is deterministic, supports manual academic workload and creates planner blocks only after approval. External calendars are not checked. Reservations and recorded study time do not establish assignment completion or mastery. Workload-derived AI context remains blocked.
- The [live Assistant](docs/ai-assistant.md), selected-message mail suggestions and scheduled D57 agents use narrow OpenRouter paths. General [gateway dispatch](docs/ai-gateway.md) remains disabled; its synthetic attempt/accounting/context checks do not prove shared live provenance or provider behavior. Complete history/output lineage is a prerequisite for expanding context.
- [Legacy responsibility reviews](docs/responsibilities.md) remain nonexecuting backend placeholders. They are distinct from deployed D57 scheduled agents and their pinned conversations/Inbox notifications. First owner-created agent/run and live usefulness remain pending.
- [Email approvals](docs/email-drafts.md) and the [synthetic attempt harness](docs/email-attempts.md) provide no live send adapter or delivery proof. Every send, invitation and cancellation email still requires explicit approval.
- Canvas calendar/API adapters plus the development browser collector and exact browser/feed reconciliation are implemented, but live two-course/all-selected-course completeness and unattended scheduling remain unverified. School token creation is blocked. Outlook now has a metadata-only access gate; actual account/tenant evidence and mailbox OAuth/read access remain unverified.
- HTTPS deployment and same-device backup/isolated restore are evidenced; encrypted off-host backups remain owner-deferred. Emulator checks do not establish actual Kompakt behavior, closed-app reminders or screen-reader acceptance.

Research baseline: 2026-10-09; present-status reconciliation: 2026-10-14. Recheck provider requirements when implementation starts.
