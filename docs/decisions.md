# Decision register

Status: pending unless explicitly confirmed. These entries prevent draft recommendations from becoming accidental requirements.

| ID | Decision | Current proposal or question | Why it matters |
| --- | --- | --- | --- |
| D01 | Audience | Confirmed: personal use first, designed for future expansion; ownership checks from day one | OAuth, onboarding, hosting, and isolation scope |
| D02 | Providers | Confirmed: Canvas at canvas.colorado.edu, school email through Outlook, Proton Mail including Gmail, and Proton Calendar. School mailbox backend still to verify | Integration feasibility |
| D03 | Platforms | Confirmed: web on Windows and Android APK first; dedicated Windows app preferred but deferred until the core app is complete | Shells and background behavior |
| D04 | E-ink device | Confirmed: Mudita Kompakt is the primary mobile/e-ink target; Kindle Scribe deferred until the rest of the app is complete | Hardware capabilities and testing |
| D05 | Offline | Confirmed: Android supports offline viewing and edits, durably queued for server synchronization after reconnect | Storage and synchronization complexity |
| D06 | AI authority | Confirmed: AI may change writable calendars without per-action approval; email sending requires explicit approval. Permissions configurable later | Action policy and UX |
| D07 | AI hosting | Confirmed: hosted AI API initially; backend on existing server without sufficient inference compute. Preserve a later self-hosted endpoint option | GPU needs, budget, privacy, and operations |
| D08 | AI data | Confirmed: relevant email/Canvas text only for hosted AI; no screenshots, attachments, or indirect attachment-derived inputs | Processing boundary and retention |
| D09 | Proton availability | Confirmed: paid plan with Bridge. Main server is Ubuntu; Bridge host location/uptime and CPU compatibility still unresolved | Automatic mail sync while devices are off |
| D10 | Canvas access | Personal testing access versus institution-enabled OAuth | Whether the connector can launch |
| D11 | Calendar authority | AI write authority confirmed; actual Proton write route unresolved. Hub-owned study plans proposed; ICS-only sources remain read-only | Separates authorization from provider capability |
| D12 | MCP direction | Confirmed: both inbound hub tools for external assistants and outbound external MCP servers for built-in AI | Authentication and trust boundaries |
| D13 | Costs | Confirmed: minimize routine AI spend; higher spend acceptable for material features/improvements. No numeric budget or cap set | Feasible model and deployment choices |
| D14 | Release scope | Follow milestone order; all listed features remain in the long-term vision | Keeps the initial release measurable |
| D15 | Retention | Agree defaults for mail cache, AI chats, memories, and backups | Storage and deletion behavior |
| D16 | Stack | Implemented: React/Vite + Fastify, TypeScript/Zod contracts, npm workspaces; PGlite development storage and pg production driver using common SQL migrations. In-process durable reminder worker and provisional Capacitor Android shell implemented | Android adoption still depends on Kompakt hardware proof |
| D17 | Workaround adapters | Confirmed prior approach: Canvas browser inspection plus ICS feed; Proton Mail Bridge; Outlook browser inspection; Proton Calendar browser access. Revalidate unattended execution and exact write capabilities | May unlock required Proton workflows |
| D18 | Gmail ingestion | Prefer existing Proton aggregation if it exposes the required messages; prove completeness before requiring a direct Gmail connector | Avoids duplicate ingestion and extra account setup |
| D19 | Initial server | Confirmed planned Oracle Cloud Ubuntu VM: 24 GB RAM, 4 OCPUs; exact shape/architecture, storage, and tenancy pricing to verify | Binary compatibility and capacity |
| D20 | Browser AI input | Text/DOM/accessibility-based fallback only; screenshot-driven hosted computer use excluded. Prototype provider coverage | Automation feasibility under privacy choice |
| D21 | Provider permissions | Confirmed: configurable rules route sensitive requests to a different approved provider. Default and sensitive providers/models still unselected; Claude is an example | Prevents private context reaching an unapproved provider |
| D22 | Sensitivity labeling | Confirmed: only sources or content explicitly labeled by the owner determine sensitive routing. Derived content inherits labels; no automatic sensitivity detection. Unlabeled content uses the configured default route | Owner controls the data boundary |
| D23 | Persistent agents | Confirmed scope addition and reference: CopilotKit/OpenDots at https://github.com/CopilotKit/OpenDots. Feature priorities and runtime adoption remain open; see agent-scope.md | Adds persistent assistants, workspaces, memory and background work |
| D24 | Local development storage | Implementation choice: PGlite embedded PostgreSQL without Docker; DATABASE_URL selects standard PostgreSQL, required in production | Reproducible local setup and one SQL schema |
| D25 | Initial authentication | Implemented: one owner, salted scrypt passwords and revocable cookie sessions; production enrollment requires server token. Password changes rotate all sessions; safe session lists/revocation implemented. Recovery remains upcoming | Protect persisted planner data before integrations |
| D26 | Recurrence | Implementation choice: daily/weekly/monthly intervals, optional count/until; local start time preserved, constant elapsed duration, future DST gaps shift forward and folds use earlier offset; monthly absent dates skipped. Editing anchor/timezone/rule clears exceptions and cancels occurrence reminders | Predictable series editing; see planner.md |
| D27 | Initial reminders | Implementation choice: server worker writes durable in-app notifications; optional browser alerts only while Reminders is open. Push/native closed-app alerts deferred | Separates durable delivery from device notification capability |
| D28 | Interface copy | Confirmed: concise titles/labels; avoid unnecessary flavor text and move useful secondary information into contextual Help, accessible by keyboard/tap/focus | Reduces clutter, including on e-ink screens |
| D29 | Offline prototype | Implemented: browser service-worker shell and owner-scoped IndexedDB task outbox, reused in the bundled Android WebView with separate storage per server origin. Stable IDs, ordered receipt replay, Web Locks, expiry/revocation locking and explicit conflict recovery. Calendar/class/reminder offline edits remain pending | Emulator evidence does not prove Kompakt compatibility |
| D30 | Android prototype | Provisional Capacitor 8.5.3 APK, bundled UI, native HTTP/HttpOnly cookie jar and fixed HTTPS server origin; isolated loopback test build. No Google Services, request logging or Android backup. IndexedDB is the initial device outbox; native alarms/background delivery/release signing pending | Verify actual API/WebView, durability and e-ink behavior on Kompakt |
| D31 | Development priority | Confirmed 2026-10-10: defer actual Kompakt verification and continue core server/site features and backend. Hardware acceptance remains required before claiming device support | Device work no longer gates core development |
| D32 | Planner export | Implemented portable format v1 with owner records/tombstones, labels, exceptions, reminders and inbox history; excludes authentication/operational secrets. Import and full backup/restore remain pending | Reviewable data portability without claiming recovery |

## Next decision sequence

1. Audience, provider list, Android offline behavior, and initial AI authority are confirmed.
2. Server sizing, text-only hosted AI, both MCP directions, and cost priorities are confirmed. Verify CPU shape, Bridge host, numeric spending limits, model provider, and retention during technical setup.
3. Demonstrate the constrained integrations and reminder behavior.
4. Stack and initial authenticated planner slice are implemented. Finish the planner milestone using backlog.md acceptance checks.

No secrets, provider tokens, passwords, or private email samples should be placed in these planning documents.
