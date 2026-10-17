# Implementation backlog

## Current milestone: small OpenRouter mail broker (2026-10-16)

PR #48 merged as `f895cb6`; the synthetic runner passed 829 local tests (three optional PostgreSQL skips) and Linux/Windows/PostgreSQL CI on `831d065`. Actual paid model evaluation, configuration/deployment and owner acceptance remain pending. P8 part 2 study suggestions merged in PR #49, P9 explicit per-ask memory and forget/history enforcement merged in PR #50, P10 source-health and connector reconciliation merged in PR #51 as `d6311b6`, P11 browser runtime/ingestion merged in PR #52 as `d1cb055`, browser/calendar-feed reconciliation merged in PR #53 as `fc0fffb`, and P12 Outlook access-gate development merged in PR #54 as `2fa12fd`. Live two-course/all-selected-course Canvas acceptance, owner feed comparison and scheduler installation remain separate gates. P12's migration 072 plus owner-visible, versioned backend/tenant-class/mailbox-scope/app-registration/delegated-consent findings perform no Microsoft sign-in, OAuth/token storage, mailbox read or permission request; the actual Graph adapter remains blocked on account-specific gate evidence. P13 is preserved as a design-only [inbound MCP threat/grant/auth specification](mcp-inbound-design.md), but the owner moved MCP compatibility and P13-P16 implementation to post-v1 on 2026-10-17. No client, SDK, auth service, export destination or MCP endpoint is selected or enabled.

The [replacement](openrouter-mail-broker-plan.md) merged in PR #46 as `b52745c` on 2026-10-16. Linux, Windows and PostgreSQL CI passed on source commit `0530fc9`. The adapter, strict relevance enums, independently approved `mail-broker` profile, pinned ZDR/host-price checks, two-hop accounting/lineage and Mail access approval controls are implemented. Existing grants and historical receipts are preserved. See [runtime/setup/evaluation](openrouter-mail-broker.md). Model-quality evaluation, server configuration, backed-up staged deployment and owner live acceptance remain pending. No paid inference or private-mail acceptance is implied.

PR #47 merged as `eaf9a5e`, adding offline production-envelope preparation and strict recorded-completion decoding. Its full local check passed 823 tests (three optional PostgreSQL skips), and Linux/Windows/PostgreSQL CI passed on `129cad2`. The later capped synthetic executor and broker workflow/control slices are also integrated; actual paid execution remains separately authorized and unperformed. P8 parts 1 and 2 and P9-P12 are integrated. See the [P8 plan](superpowers/plans/2026-10-15-academic-study-proposals.md).

Older entries below retain their dated implementation history. Product scope remains in product.md, decisions in decisions.md and validation receipts in implementation-log.md. Current remaining work is dominated by live/account/device acceptance and source-coverage gates rather than missing P8-P12 local implementation; MCP is post-v1.

## Approved next sequence (2026-10-14)

P5 boundary 1 is implemented on `ai/live-context-admission` (merged in [PR #37](https://github.com/Errantial/personal-hub/pull/37), not deployed): one-click pinned-destination approval, exact live envelopes, cumulative source checks, bound new history and read-only mail-dependent proposals. See the [specification](live-context-admission-design.md) and [boundary plan](superpowers/plans/2026-10-15-live-context-admission-boundary-1.md).

P5/P6 boundary 2 is implemented and integrated: durable derived-record lineage (`ai_origin`/`ai_labels`, `ai_turn_origins`, `ai_planner_origins`; migration 062) and server-owned Apply/Undo replace client-composed planner writes. Apply inherits the answer's conservative labels and origin, re-verifies proposal origin/digest, and the inherited floor survives edits, Undo, deletion and restore; legacy and unverified derived records stay ineligible for inference. Deployment/live acceptance remain separate from integration.

P7 manual academic context is implemented and integrated ([plan](superpowers/plans/2026-10-15-academic-context-p7.md)): live owner asks carry explicit, version-pinned `academic` work selections (≤20), projected to the allowlisted planning fields only (never notes or grades); blocked selections fail before any hold, disallowed labels are withheld and counted, and the sealed manifest and final guard re-verify each bound source with history eligibility. Migration 063 records the sent summaries on the turn, and applied proposals inherit the academic labels and `bound-derived` origin. The composer picker/coverage UI and grounded P8 proposals were delivered in later slices; live deployment/acceptance remain separate. See the [implementation receipt](implementation-log.md).

The owner approved autonomous development according to the [post-agents development plan](post-agents-development-plan.md): reliability and daily-use acceptance, shared live context/history/output provenance, manual academic assistance, explicit per-ask memory, source coverage improvements, then inbound and outbound MCP in separate gated slices. The recommended defaults are authorized for implementation; account-specific access, destinations and live acceptance retain their gates. Existing implemented editors/planners are reused. Work starts with P1/P2/P4; broader context expansion remains blocked on P5/P6.

First batch implemented in [PR #35](https://github.com/Errantial/personal-hub/pull/35) (not deployed): present-status reconciliation and [acceptance checklist](agents-acceptance.md); atomic worker effects/result persistence, lease fencing, independent heartbeat, legacy receipt recovery, pre-fetch goal/label checks and durable per-exchange agent allowance admission (migration 058); staged artifact/migration/service-user preflight and explicit rollback compatibility evidence. Validation: full check passed 653 tests, all 144 browser cases passed, and Linux/Windows/PostgreSQL CI passed, including two-worker races and the Linux filesystem fixture. Receipts are in implementation-log.md. Actual service-user preflight and owner live acceptance remain pending. Full history/output provenance regressions and enforcement remain P5/P6, not completed P1 acceptance.

P3 run visibility is implemented and integrated: authoritative run states and bounded owned history, separate active execution and chronological latest run, scheduler configuration/liveness, progress/deadline warnings and settled/held/remaining allowance. Migration 059 leaves legacy timing unknown. Retry requires server evidence of no charged/uncertain exchange or existing effect; explicit Run now remains a new operation. Connector freshness/completeness is handled by the later P10 work. Live owner acceptance remains separate.

## Current plan (approved 2026-10-12)

New backend features are frozen until steps 2–3 are done (D49); fixes and backend work those steps require are allowed.

1. **Stabilize repository** — done 2026-10-12: backend work committed, `main` updated, stale UI branches removed, private GitHub remote and CI added.
2. **UI for existing backend endpoints**, in order: batch changes and undo/restore (Tasks, Calendar and class Work selected changes done 2026-10-12, with Undo and Recently deleted); academic work (class Work section done 2026-10-12) and study-plan approval (settings, goals and plan screen done 2026-10-12); reminder snooze, inbox history and paged reminder history (implemented); memory editor and email draft review (done 2026-10-13). Step 2 is implemented and integrated into main; PRs 8–10 merged 2026-10-13. Contracts are in [ui-agent-ledger.md](ui-agent-ledger.md).
3. **Deploy for daily use** on the Oracle VM: server deployment implemented 2026-10-13 at `https://hub.ecg.name` on Oracle Linux ARM64, with PostgreSQL, HTTPS, root-only setup token and verified same-device backup/restore. Owner enrollment, daily-use validation and development-data transfer remain pending. Encrypted off-host backups are deferred by owner choice. See the [operating guide](../deploy/oracle-linux/README.md).
4. **First live AI flow**: natural-language task/event creation and edits through existing planner operations, via OpenRouter with an owner-configurable model in Settings (initially Claude Haiku 5.5, D47), within the $0.25 request / $50 monthly caps. Implemented 2026-10-13 as the Today Assistant (review, then Apply; labeled items withheld); see [ai-assistant.md](ai-assistant.md). Live use needs the server key, saved spending limits and a first real request.
5. **Email ingestion**: prove Proton Bridge completeness (Oracle VM if supported, otherwise an always-on local machine, D48), read-only first; then AI filtering through the gateway. Read-only ingestion implemented 2026-10-13 with Bridge on the owner's Windows computer and a local connector; observed Bridge snapshot coverage was verified read-only, while Gmail delivery completeness remains unresolved (latest observed message 2026-09-28). Live upload needs this release deployed, a connector token and a scheduled task. AI filtering is next. See [email-ingestion.md](email-ingestion.md).

Approved 2026-10-14 (D54–D56), all done and deployed:

1. **Dark theme** following the device by default, with Light/Dark/Match device in Settings › Appearance.
2. **Assistant page** in the sidebar with server-side conversation history.
3. **Assistant mail reading**: search subjects and senders, then read up to five bodies; each answer lists the messages sent.
4. **UI rework** ([spec](superpowers/specs/2026-10-14-ui-rework-design.md)): Today as one ordered list with an Add/Ask bar; Assistant as a chat; Calendar with Proton-style Week/Day/Month grids. PRs 26–28, live as release `b7f7af1`.

Live operation (2026-10-14): mail sync runs every 10 minutes from the owner's Windows computer; the server has the OpenRouter key and spending limits.

Deployed 2026-10-14 as release `519054d` (D57; first owner-created agent/run and live acceptance pending): **persistent agents**. [Design](superpowers/specs/2026-10-14-persistent-agents-design.md): scheduled agents (Daily plan, Mail triage, Deadline watch, custom) as pinned Assistant conversations, run by an in-process worker under the action settings and a per-agent monthly cap. PR stack: [backend #30](https://github.com/Errantial/personal-hub/pull/30), [UI #31](https://github.com/Errantial/personal-hub/pull/31), [notifications/docs #32](https://github.com/Errantial/personal-hub/pull/32), brought into main by [integration #33](https://github.com/Errantial/personal-hub/pull/33). Out of scope for this slice (listed in the design and agent-scope.md): event triggers, parallel runs, delegation, MCP, web browsing, sending email, external calendar writes, memory edits, voice, personas, learning, auto-resume after a cap pause, push notifications.

Later (not yet ordered): bidirectional MCP, Kompakt hardware verification, Outlook mailbox, Windows app.

Step 5 gateway foundation (2026-10-13): [verified mail context](ai-mail-context.md) is implemented with owned message references, bounded text projections, retained labels and exact message/connector integrity binding. Older imports without body-origin declarations remain blocked for AI context. Classification, corrections, selection UI and approved live provider execution remain next work; this does not complete live upload/scheduling acceptance.

Integration status (2026-10-13): PR 15 merged Assistant, Mail and verified mail context directly into main. This does not establish deployment or live-use acceptance of those features.

Step 5 organization (2026-10-13): [mail categories and explicit rules](mail-organization.md) are implemented with owner corrections, preview/atomic apply, literal matching and retained explanations. This completes the local organization/correction slice; approved-provider AI classification, grounded deadline proposals and live upload/scheduling acceptance remain next work.

Step 5 AI suggestions (2026-10-13): [AI mail category suggestions](mail-classification.md) send selected, verified mail to OpenRouter under the owner's labels (Personal by explicit switch, Restricted never) and are applied only by the owner. Deployment (2026-10-13): `main` at `4491762` is live on the VM with migrations through 048 after a verified pre-deploy backup; later PRs need another deploy.

Step 5 AI task suggestions (2026-10-13): [suggestions from one message](mail-task-suggestions.md) must quote the body exactly and only fill the manual capture form; deadlines still need owner confirmation. With category suggestions, this completes step 5's AI filtering scope; live use needs deployment, the server key, spending limits and the connector schedule.

Step 5 task capture (2026-10-13): [manual tasks from mail](mail-tasks.md) are implemented with exact supporting quotes, immutable source links/labels, explicit deadline confirmation and owner review before creation. This supplies the manual capture path; automatic AI extraction/proposals and approved-provider classification remain pending. Mail-derived task context stays blocked for AI until its integrity binding is supported.

Canvas access update (2026-10-13): owner token creation is blocked. A [one-course browser DOM proof](canvas-browser.md) passed; a durable, read-only browser collector is proposed and remains separate from the completed calendar-feed adapter. This proof does not reorder the approved milestones or claim a new working connection. Import contracts/provenance, completeness, session expiry and source reconciliation remain required.

## Deferred Android verification

Actual Kompakt verification is deferred by owner request (2026-10-10) and does not block core server/site development. Browser task outbox, stable IDs, cached viewing, session-expiry/revocation locking, conflict retention and cache cleanup are implemented. A provisional Capacitor APK bundles the UI and WebView outbox, uses native cookie transport and separates cache per server. AOSP emulator checks prove offline create/edit/completion survives force-stop and replays once. Actual Kompakt API/WebView/e-ink checks, native alarms, denied permissions and reboot/power-mode behavior remain deferred. Calendar/class/reminder offline edits and background delivery remain pending.

Acceptance remaining for the broader planner milestone: an Android edit survives process death and synchronizes once; closed-app reminders and denied/revoked permissions are understood; monochrome navigation works on actual Kompakt hardware. Current web tests distinguish task deadlines from reserved study intervals and exercise recurrence/DST, conflict preservation, permission denial and 320px e-ink layout.

## Integration gates, before dependent features

- Verify Oracle CPU architecture, supported Bridge host/uptime, and persistent storage.
- Compare authorized Canvas API, calendar feed, and text-browser coverage; never store the private calendar URL in the repository.
- Use the [Outlook access gate](outlook.md) to verify the school mailbox backend, school-managed tenant, mailbox scope, app-registration route and Graph delegated-consent policy. Implement a read-only Graph adapter only if that live gate permits it; browser fallback remains a separate proposal.
- Prove Proton Mail/Gmail completeness through Bridge and a text-only Proton Calendar write path.
- Confirm provider/model choices, numeric spending caps, and data retention before paid AI processing.

## AI and persistent-agent sequence

Implement the text/provenance/provider-routing gateway, typed action policies and email approval records before enabling hosted AI. Editable owner memory storage/control is implemented separately in memory.md; verified AI retrieval remains pending. Owned responsibility lifecycle, explicit UTC/local review admission and blocked run/activity history are implemented in responsibilities.md; background scheduling, autonomous dispatch and real result/activity execution remain pending. Next add verified runtime context/routing/permission/budget enforcement, leases/stop controls, bounded delegation and bidirectional MCP. Every agent step and retrieved/tool context inherits routing and permission checks. See agent-scope.md and ai-permissions.md.

Typed action policy settings and authority preview are implemented in [ai-actions.md](ai-actions.md); exact-message email review records are implemented in [email-drafts.md](email-drafts.md). Runtime action enforcement, approval consumption and verified final provider payload/capability remain required before execution; neither permission preview nor a draft approval completes those gates.

The next live execution slice is planned. Profiles, bounded preflight, numeric settings, durable requests and synthetic attempts/recovery are implemented; they do not enable paid execution. Remaining production acceptance:

- Server provider registry maps saved aliases to protected credentials, supported models and actual availability; arbitrary client endpoints and simulated availability cannot authorize dispatch.
- Bounded text context has an owned/versioned provenance manifest for every fragment. Policy/source versions and complete labels are revalidated before transmission; forbidden file/image content and unknown provenance block.
- Adapt the durable blocked/uncertain/failed/completed request lifecycle to verified provider calls. Lost responses, restarts and retries must preserve the existing pinned-destination and no-resend boundaries; synthetic checks alone do not verify paid provider semantics.
- Owner-selected provider/model, retention and numeric spending limits are configured before paid execution; tests use fake adapters and exercise budget exhaustion without network charges.
- Model actions use existing authorized/versioned planner operations. Email sends, invitations and cancellation emails require explicit approval; external calendar writes need a proven writable adapter. Memory, agent execution and MCP remain later slices.

## Verification still outstanding

The standard PostgreSQL check is opt-in via TEST_DATABASE_URL and configured in CI; remote CI acceptance remains unverified. Android SDK command-line tools are installed, but actual Kompakt, closed-app native reminders and release signing are unverified. T3's Device panel could not attach to the booted emulator; verification used Android instrumentation and adb instead. Oracle HTTPS deployment through commit 265a99d is implemented; newer releases, owner daily use and paid provider calls remain unverified.

## Interface guideline

Prefer concise titles and labels. Use keyboard/tap-accessible contextual Help for useful secondary explanations. Keep errors, pending/offline/conflict state and essential warnings visible. Marketing/welcome copy has been removed from the current screens.


P7 composer follow-up is implemented on ai/academic-selection-ui (not deployed; check and all 156 browser cases passed): explicit per-ask version-pinned manual work selection, guarded active-class browsing, retained failed-ask selections and recorded academic coverage/aggregate withholding. P8 grounded study proposals remain next. See ui-agent-ledger.md and implementation-log.md.

P8 part 1 is implemented in development on ai/academic-proposals (not deployed; check and all 156 browser cases passed): grounded manual-work task creates through existing academic planner operations, source review, fresh version/open-state checks and retained source/AI lineage through retry and Undo. P8 part 2 remains deterministic study preview/approval integration with capacity/conflict checks; no AI study reservation or automatic workload-plan provenance is claimed.
