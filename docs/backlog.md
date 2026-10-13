# Implementation backlog

Updated 2026-10-13. This is the work queue; product.md remains the full scope, decisions.md records choices, and roadmap.md sets milestone order. Completed work and validation receipts are in [implementation-log.md](implementation-log.md).

## Current plan (approved 2026-10-12)

New backend features are frozen until steps 2–3 are done (D49); fixes and backend work those steps require are allowed.

1. **Stabilize repository** — done 2026-10-12: backend work committed, `main` updated, stale UI branches removed, private GitHub remote and CI added.
2. **UI for existing backend endpoints**, in order: batch changes and undo/restore (Tasks, Calendar and class Work selected changes done 2026-10-12, with Undo and Recently deleted); academic work (class Work section done 2026-10-12) and study-plan approval (settings, goals and plan screen done 2026-10-12); reminder snooze, inbox history and paged reminder history (implemented); memory editor and email draft review (done 2026-10-13). Step 2 is implemented locally; Memory, email drafts and reminder history still require PR integration into main. Contracts are in [ui-agent-ledger.md](ui-agent-ledger.md).
3. **Deploy for daily use** on the Oracle VM: server deployment implemented 2026-10-13 at `https://hub.ecg.name` on Oracle Linux ARM64, with PostgreSQL, HTTPS, root-only setup token and verified same-device backup/restore. Owner enrollment, daily-use validation and development-data transfer remain pending. Encrypted off-host backups are deferred by owner choice. See the [operating guide](../deploy/oracle-linux/README.md).
4. **First live AI flow**: natural-language task/event creation and edits through existing planner operations, via OpenRouter with an owner-configurable model in Settings (initially Claude Haiku 5.5, D47), within the $0.25 request / $50 monthly caps. Implemented 2026-10-13 as the Today Assistant (review, then Apply; labeled items withheld); see [ai-assistant.md](ai-assistant.md). Live use needs the server key, saved spending limits and a first real request.
5. **Email ingestion**: prove Proton Bridge completeness (Oracle VM if supported, otherwise an always-on local machine, D48), read-only first; then AI filtering through the gateway.

Later: bidirectional MCP, persistent agents, Kompakt hardware verification, Outlook mailbox, Windows app.

Canvas access update (2026-10-13): owner token creation is blocked. A [one-course browser DOM proof](canvas-browser.md) passed; a durable, read-only browser collector is proposed and remains separate from the completed calendar-feed adapter. This proof does not reorder the approved milestones or claim a new working connection. Import contracts/provenance, completeness, session expiry and source reconciliation remain required.

## Deferred Android verification

Actual Kompakt verification is deferred by owner request (2026-10-10) and does not block core server/site development. Browser task outbox, stable IDs, cached viewing, session-expiry/revocation locking, conflict retention and cache cleanup are implemented. A provisional Capacitor APK bundles the UI and WebView outbox, uses native cookie transport and separates cache per server. AOSP emulator checks prove offline create/edit/completion survives force-stop and replays once. Actual Kompakt API/WebView/e-ink checks, native alarms, denied permissions and reboot/power-mode behavior remain deferred. Calendar/class/reminder offline edits and background delivery remain pending.

Acceptance remaining for the broader planner milestone: an Android edit survives process death and synchronizes once; closed-app reminders and denied/revoked permissions are understood; monochrome navigation works on actual Kompakt hardware. Current web tests distinguish task deadlines from reserved study intervals and exercise recurrence/DST, conflict preservation, permission denial and 320px e-ink layout.

## Integration gates, before dependent features

- Verify Oracle CPU architecture, supported Bridge host/uptime, and persistent storage.
- Compare authorized Canvas API, calendar feed, and text-browser coverage; never store the private calendar URL in the repository.
- Verify the school mailbox backend/Graph consent and text-browser fallback coverage.
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

The standard PostgreSQL check is opt-in via TEST_DATABASE_URL and configured in CI; CI has not run remotely. Android SDK command-line tools are installed, but actual Kompakt, closed-app native reminders, production TLS and release signing are unverified. T3's Device panel could not attach to the booted emulator; verification used Android instrumentation and adb instead. No production deployment or real provider connection has occurred.

## Interface guideline

Prefer concise titles and labels. Use keyboard/tap-accessible contextual Help for useful secondary explanations. Keep errors, pending/offline/conflict state and essential warnings visible. Marketing/welcome copy has been removed from the current screens.

