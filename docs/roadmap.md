# Development roadmap

No delivery dates are assigned before integration feasibility, budget, and development capacity are known. As of 2026-10-10, actual Kompakt verification is deferred by owner request; core server/site work continues independently. Hardware checks remain release acceptance requirements.

The core server/site now includes account controls and portable export, plus a read-only Canvas calendar feed baseline with durable refreshes and personal annotations. Imported entries appear in Calendar and explicitly linked class portfolios. Connections creates source-linked tasks/study blocks while preserving provenance and owner edits. Live account completeness and email/AI integration gates remain open.

Completed locally: React/Vite web, Fastify API, shared contracts, owner authentication, migrations, versioned task/calendar CRUD, recurring/all-day calendar, class/topic portfolios, study blocks and durable in-app reminders. Browser offline tasks and a provisional Capacitor APK pass isolated checks, including Android process-restart/replay. The broader planner milestone still requires actual Kompakt verification and native device alerts. Development/check commands, isolated tests and a CI definition are present. See [implementation backlog](backlog.md), [Android prototype](android.md) and [local development](development.md). Account and hardware feasibility gates remain open.

## 0. Resolve product and integration gates

Deliver: Kompakt APK/WebView/offline/local-reminder demonstration without Google Services; Oracle VM CPU compatibility and numeric AI limits; Canvas feed/API/text-browser comparison; Outlook access with text-browser fallback; Proton Mail/Gmail completeness and supported Bridge host; Proton Calendar text-browser write test. Server size, hosted API direction, and no-screenshot/no-attachment policy are confirmed.

Exit: no foundational workflow relies on an unverified provider capability. Unsupported functionality has an explicit fallback or is removed from the release promise.

Windows uses the website in this release. Dedicated Windows UI and Kindle Scribe feasibility are deferred until the core app is complete; neither blocks these gates. A small Bridge connector can still be required earlier.

## 1. Reliable planner foundation

Deliver: authenticated personal account with expansion-ready ownership, Today, tasks, calendar, reminders, basic class/topic records, e-ink theme, settings, versioned persistence, and Android offline viewing/editing with a durable queue.

Exit: task deadline differs from study time; recurrence/time-zone cases work; reconnect does not duplicate edits; conflicts are visible; denied notification permission is understandable; users can navigate the core flow in monochrome.

## 2. Academic synchronization and study planning

Deliver: authorized read-only Canvas adapter, connection status, deduplication, source links, class portfolios, manual confidence tracking, and editable study suggestions.

Exit: changed provider deadlines update once; personal notes survive; missing grades remain unknown; study plans respect capacity and pinned events; source disconnection is handled.

## 3. Email ingestion and categorization

Deliver: school Outlook mail and Proton Mail including Gmail through proven ingestion paths, configurable rules, category correction, optional AI classification, and task/deadline suggestions with evidence. Implement and validate adapters independently.

Exit: repeated ingestion creates no duplicates; messages cannot instruct the assistant to take actions; uncertain extraction needs review; outage status is visible; mail retention and server data access match the user's settings.

## 4. AI actions and durable memory

Deliver: natural-language planner operations, typed action gateway, automatic writable-calendar changes, explicit email-send approval, execution receipts, inspectable memory, provider-routing permissions, context limits, and cost controls. Calendar-generated emails use the same approval rule. Implement the content/routing gateway before any earlier milestone enables hosted AI processing.

Exit: stale approvals cannot execute changed payloads; duplicate requests cannot duplicate tasks; mixed-success operations report accurately; memory deletion reaches retrieval indexes; the planner works when AI is unavailable.

## 5. MCP and selectively expanded automation

Deliver: both inbound hub MCP tools and outbound connections to a bounded allowlist, narrow scopes, authentication, text-only filtering, configurable permissions, and additional supported external writes. Default calendar authority and email approval are established.

Exit: tool callers cannot access another user; disconnection cancels pending writes; untrusted content cannot authorize actions; audit records trace actor, consent, payload, and result.

## 6. Persistent responsibilities (Dots/OpenDots scope)

Deliver: durable ongoing goals/jobs, scheduled/event-triggered reviews, persistent agent identity/context, results/activity history, pause/resume/cancel and bounded delegation. Build on earlier provider routing, memory, action permissions, integration and MCP work. Optional project spaces/pages and additional channels follow prioritization. See [persistent agent scope](agent-scope.md).

Exit: jobs survive restarts without duplicate side effects; user steering/stop controls work; every step inherits sensitivity and cost limits; approval requests cannot be bypassed by delegated work; outcomes and failures remain visible.

## Release verification

Run meaningful tests for domain behavior, sync retries/conflicts, authorization boundaries, recurrence/daylight-saving cases, AI policy enforcement, and provider adapter contracts. Use captured synthetic/redacted fixtures rather than depending on live accounts for routine tests.

On actual target devices, verify closed-app reminders, reboot, denied/revoked permissions, offline use, keyboard/screen-reader navigation, and e-ink readability. An emulator alone cannot prove physical e-ink performance or all manufacturer power behavior.

For the initial release, target the owner's Mudita Kompakt firmware and Windows browser. Verify the app needs no Google Services and shows stale server data honestly when background updates are delayed. Do not add Kindle Scribe or dedicated Windows packaging to the release gate.

Before live reliance: restore a backup, verify export/deletion, exercise provider revocation, recover failed jobs, and ensure logs do not contain credentials or private content.

Inspect actual model requests with synthetic fixtures: screenshots, attachments, attachment-derived text, MCP binary content, and linked resources cannot bypass the text-only boundary. Exercise cost limits and stronger-model routing without live private content.

Verify sensitive source text, memory, history, summaries, and new tool results never reach an unapproved provider. Simulate approved-provider failure and ensure retries remain blocked/queued rather than leaking to the default. Test third-party MCP argument destinations separately.
