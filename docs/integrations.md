# Integration feasibility

Verified against the official documentation below on 2026-10-09. School-specific permissions and account-plan features still need verification with the owner.

## Canvas LMS

Access update (2026-10-13): the owner confirmed personal tokens are blocked. A live read-only DOM proof in one authenticated course found stable unique assignment links and exact/missing due timestamps. See the [sanitized receipt and proposed browser connector](canvas-browser.md). This does not implement syncing, prove all-account coverage or enable AI; the calendar-feed path remains independent.

Implementation update (2026-10-10): a read-only school feed adapter, manual ICS import, durable refresh jobs and separate owner annotations are implemented and verified with synthetic fixtures. See [Canvas setup](canvas.md). Live school access, completeness, richer API/browser enrichment and grades remain unverified.

Confirmed: school Canvas LMS at `canvas.colorado.edu`, including its calendar. The owner has an existing personal ICS feed and previously used a model-driven browser to inspect assignments and alerts. Do not place the personal feed URL in source, documentation, or logs; configure it later as a secret.

- Use the REST API for accessible courses, assignments, submissions, and other allowed academic data.
- A personal testing token can support an owner's prototype if the institution permits it. Do not build onboarding that asks other users to paste personal tokens: Canvas requires OAuth for multi-user applications.
- Hosted institutions issue developer keys through their administrators; OAuth availability is an integration gate.
- Follow pagination and throttling; retries must not create duplicate assignments.
- Begin read-only. Handle assignment-specific due dates, submissions, missing grades, concluded courses, and provider deletions without inventing progress.
- Use the existing personal ICS feed as a candidate baseline for calendar/deadline ingestion. It does not replace assignment details, alerts, grades, or learning-progress data; compare it with the authenticated UI before assuming completeness.
- Prefer authorized API access for richer academic data. Retain browser inspection as a fallback and enrichment route if API access is unavailable or incomplete.

Sources: [OAuth and manual token policy](https://www.canvas.instructure.com/doc/api/file.oauth.html), [developer keys](https://developerdocs.instructure.com/services/canvas/oauth2/file.developer_keys), [assignments](https://developerdocs.instructure.com/services/canvas/resources/assignments), [throttling](https://developerdocs.instructure.com/services/canvas/basics/file.throttling), [API basics and pagination](https://developerdocs.instructure.com/get_started).

Proof required: authenticate against the actual school instance, list an accessible course and assignment, validate the effective deadline, follow pagination, repeat the import, and recover from expired/revoked access. Do not request secrets in chat.

If using the feed/browser fallback instead, validate feed UID deduplication and updates/cancellations, map browser-extracted assignments to feed/source records, recover browser login, and surface missing/uncertain data. The one-course live DOM proof establishes a candidate route, not a completed app integration test. No live feed has been accessed as part of this proof.

## Proton Mail

Confirmed: Proton Mail, including Gmail messages already available through Proton. Verify how Gmail is connected and which messages/identities Bridge exposes; do not infer full synchronization from visibility in Proton's web app. Proton documents a Gmail connection for receiving and sending within Proton, but that does not by itself establish this app's Bridge capabilities. [Proton Gmail connection](https://proton.me/support/automatic-forwarding-gmail).

The supported third-party mail route documented by Proton is Bridge: a paid-plan desktop application providing local IMAP/SMTP. It supports Windows, macOS, and Linux, not mobile devices. A browser or Android app cannot directly use a Bridge running on an unrelated Windows computer. [Proton IMAP/SMTP setup](https://proton.me/support/imap-smtp-and-pop3-setup).

Confirmed: the owner has a paid Proton plan with Bridge and has used it for mail access. Candidate design: a small connector talks to Bridge on the host where it runs and sends only opted-in data to the hub through authenticated HTTPS. Keep local IMAP/SMTP listeners private. If hosted on Windows, this connector is independent of the deferred Windows UI; ingestion pauses while its host is asleep, powered off, or disconnected.

An always-on personally controlled Linux host is another hypothesis to evaluate, not an approved managed multi-user integration. Proton documents Linux support and keyring requirements; unattended operation, credential custody, reconnect behavior, and acceptable deployment need separate validation. [Bridge for Linux](https://proton.me/support/bridge-for-linux).

Verify the Ubuntu VM's CPU shape. If Oracle Ampere A1 (ARM) is selected, official Bridge support does not include that Linux architecture. Prefer a supported host plus an authenticated connector unless another route is validated. [Bridge requirements](https://proton.me/support/operating-systems-supported-bridge).

Reading messages through Bridge exposes plaintext to the integrating process. Uploading that content to this app's server expands who can process it; require a clear choice about metadata, snippets, bodies, and attachments.

Status 2026-10-13: read-only ingestion is implemented with Bridge on the owner's Windows computer and a local connector ([email-ingestion.md](email-ingestion.md)). Bridge exposes a Gmail label; its newest message is 2026-09-28, so Gmail delivery into Proton needs checking. Proof required in this app: local read-only ingestion works; Gmail messages are complete; repeat fetches deduplicate; reconnection works; category corrections persist; and the Bridge host's online dependency is understood. Sending and provider-side moves are separate later gates.

## Proton Calendar

Proton documents read-only subscriptions and shared calendar links, and explicitly states that CalDAV/direct two-way external synchronization is unsupported. A paid plan supports sharing a calendar with non-Proton users by link. Export/import is also available. [External subscriptions and CalDAV limitation](https://proton.me/support/subscribe-to-external-calendar), [sharing support](https://proton.me/support/calendar), [calendar export](https://proton.me/support/protoncalendar-calendars).

Plan for reading a supported shared ICS feed into the hub, or letting Proton subscribe to a hub feed. These are separate one-way channels; do not describe them as editable two-way sync. Verify each direction independently. Proton's documented 4–16-hour refresh for external subscriptions applies to feeds Proton reads, not automatically to the hub's own fetch schedule.

The owner previously accessed Proton Calendar through model-driven computer use. Browser automation is therefore a concrete candidate for direct Proton event operations. Validate create/update/delete and recurrence behavior separately; prior calendar access does not yet prove reliable unattended writes.

Shared calendar URLs act as bearer secrets; do not log them or claim they are private merely because the URL is obscure. Minimize fields exposed by a hub feed and support link revocation.

Proof required: create a permitted feed, observe an event update/cancellation and time-zone behavior, verify information exposure, and measure freshness. The hub's own calendar remains writable even when an imported calendar is read-only.

## School email through Outlook

Confirmed: school mail is accessed through Outlook. Outlook is a client; verify whether the mailbox is Microsoft 365/Exchange Online. For that backend, Microsoft Graph is the proposed supported adapter. [Outlook mail API](https://learn.microsoft.com/en-us/graph/outlook-mail-concept-overview).

Use delegated user access for this personal hub, with the smallest needed scopes. School tenant policy may prevent user consent even for scopes normally consentable by a user. Avoid tenant-wide app-only access for this workflow. [Graph permissions overview](https://learn.microsoft.com/en-us/graph/permissions-overview).

Start with delegated `Mail.Read` for ingestion. Add `Mail.ReadWrite` only if provider-side organization is selected; request `Mail.Send` only when approved sending is implemented. Provider consent to `Mail.Send` never replaces the hub's explicit approval for each send. [Permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference).

An Outlook calendar connection is not currently required. Do not request calendar access merely because the account supports it.

Proof required: identify the mailbox backend, verify app registration/consent availability, read representative mail, reconcile changes without duplication, and recover from revoked credentials. If Graph is unavailable, investigate the owner's existing authorized workflow before selecting a fallback.

## Owner-specific workarounds

Recorded prior routes: Canvas browser inspection of assignments/alerts plus a direct personal ICS feed; Proton Mail through Bridge; school Outlook mail via browser inspection; Proton Calendar via browser access. Supported API limitations do not prove these personal workflows cannot work.

Keep workaround adapters separate from domain logic, with explicit read/write capabilities, runtime dependencies, credential/session handling, and health status. Evaluate browser/session automation or unofficial interfaces against the exact required workflow; do not promise reliability before a prototype demonstrates it.

Hosted AI input is confirmed text only. Use DOM/accessibility extraction and locator actions; no screenshots, attachments, or attachment-derived text may reach the model. Re-prototype coverage under this constraint even though prior computer-use workflows succeeded.

For Proton Calendar, investigate a write-capable workaround as a separate gate. Until it passes, autonomous AI changes can operate on the hub calendar, with a hub feed displayed in Proton if acceptable. Read-only ICS imports cannot execute writes to Proton-owned events. Calendar changes must also be checked for outbound email side effects.

For Gmail, prefer one ingestion route through existing Proton aggregation if complete. A direct Gmail connector is a fallback for missing data/capabilities; if both routes are used, preserve source provenance and prevent duplicate presentation.

## MCP

MCP is an interface to tools and context, not a substitute for provider credentials or a guarantee that a provider supports synchronization.

Both directions are confirmed: expose authenticated hub operations and allow the built-in AI to use explicitly configured external MCP servers. Start with bounded tools and an outbound allowlist, scoped per-user credentials, destination checks, action policies, and text-only result filtering. Never forward a provider token as a generic MCP credential. Resource retrieval cannot bypass the screenshot/attachment restriction.

Pin a tested protocol/SDK revision when implementation begins; the specification evolves. [Official MCP specification release](https://blog.modelcontextprotocol.io/posts/2026-07-28/).
