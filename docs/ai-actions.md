# Typed action permissions

Backend settings and authority preview implemented 2026-10-11. D57 adds Settings > AI > Actions and enforcement in scheduled agent runs (implemented locally 2026-10-14; rollout pending): automatic categories apply hub planner changes with Undo, ask-first waits for Apply, and blocked categories are dropped and counted. Owner Assistant requests always ask first. The authority preview remains non-executing and never grants approval. [Exact-message email approval records](email-drafts.md) remain separate; email sending is unavailable. See the [agent scope and exclusions](superpowers/specs/2026-10-14-persistent-agents-design.md#out-of-scope-recorded-for-future-work).

## Owner settings

GET `/api/v1/ai/actions` returns `{ version, policy }`. Unsaved owners receive version 1 without inserting a row, with `policy: { tasks: 'approval-required', calendar: 'automatic', email: 'approval-required' }` (D57). Saved policies are unchanged.

Calendar defaults reflect confirmed authority on writable calendars; current execution writes hub records only. Tasks default to ask-first. Owners may select automatic, approval-required or blocked task/calendar modes. Email is always approval-required. Manual planner operations remain available when automation is blocked.

PUT requires `{ operationId, expectedVersion, policy }`, with exactly tasks/calendar/email fields. Writes are optimistic, atomic, owner-scoped and receipt-backed. The first successful save advances version 1 to 2. Concurrent same-version distinct writes allow one winner. Stale versions return `VERSION_CONFLICT`; a saved operation ID reused with changed payload returns `OPERATION_CONFLICT`. Exact retries return historical results even after later changes/restart. Preserve the exact request after a lost response and refresh before another action.

Migration 030 adds only `ai_action_policies`; existing planner records, source history, receipts and prior migrations are unchanged. SQL constraints enforce the shape and mandatory email approval. Portable export adds `records.aiActions`: nullable/default-null for older format-v1 files, current/default owner settings in new exports. No settings import or execution token is added.

## Authority preview

POST `/api/v1/ai/actions/preview` takes `{ expectedPolicyVersion, action }`:

| Kind | Connection | Additional field |
| --- | --- | --- |
| `task.create`, `task.update`, `task.delete`, `task.restore` | `hub` | None |
| `calendar.create`, `calendar.update`, `calendar.delete`, `calendar.restore` | `hub`, `canvas`, `proton-calendar`, `outlook-calendar` | `outboundEmail`: none (default), invitation, attendee-update, cancellation |
| `email.send` | `proton-mail`, `outlook-mail` | None |

Descriptors contain no titles, source IDs/text, sender, recipients, body, attachments, screenshots, provider endpoints, credentials, approval flags or client capability declarations. Unsupported fields/actions/connection combinations return 400. This is an authority descriptor, not validation or approval of actual planner/email arguments.

The response includes the normalized action, policy version, `policyDecision`, `emailApprovalRequired`, `writeCapability`, `executionEnabled: false` and blockers:

| Field/reason | Meaning |
| --- | --- |
| `policyDecision` | Owner category mode: automatic, approval-required or blocked |
| `writeCapability: local` | Manual hub operations exist; no AI executor is enabled |
| `writeCapability: read-only` | Canvas is a read-only import target |
| `writeCapability: unverified` | External mail/calendar write adapter is not proven |
| `POLICY_BLOCKED` | Owner policy blocks the automation category |
| `OWNER_APPROVAL_REQUIRED` | Task/calendar mode requires approval; no approval workflow exists yet |
| `EMAIL_APPROVAL_REQUIRED` | Every send or declared calendar outbound email requires separate explicit email approval |
| `READ_ONLY_TARGET` | Permission cannot turn Canvas imports into a writable target |
| `WRITE_CAPABILITY_UNVERIFIED` | Calendar authority does not establish provider write capability |
| `OUTBOUND_EMAIL_UNSUPPORTED` | Hub calendar operations do not send invitations/attendee updates/cancellations |
| `ACTION_EXECUTION_UNAVAILABLE` | Present for every preview; nothing executes through this endpoint |

Automatic calendar policy plus a Proton invitation still returns email approval and unverified-capability blockers. Calendar approval does not substitute for approval of the actual email. `outboundEmail: none` is a descriptor, not proof that a provider suppresses messages. A future adapter must verify actual suppression/send behavior and require explicit approval of the actual sender, recipients, subject, body and attachments for every outbound email.

Preview uses a read-only repeatable snapshot with owner/session and current-policy checks. It stores no preview, creates no receipt, queues no action, changes no planner record and calls no provider. Automatic policy is not an execution authorization, provenance certificate, approval receipt or paid model consent. This endpoint creates no approval records; the separate email draft API retains exact-message review history. No live dispatcher, synthetic action execution or gateway/action integration is implemented.

## UI and future integration

The Actions panel is implemented. Preserve failed-save drafts and retry identities; conflicts require explicit reload. Keep policy, provider capability, email approval and execution state distinct. Routes are online-only, outside cache/outbox/AI-reference allowlists; ordinary offline planner edits retain their behavior.

Before future dispatch, revalidate current policy, owned target versions, complete text provenance/provider routing, provider capability, budget/consent/retention and required exact-payload approval. Use existing authorized/versioned planner operations. Never trust a client preview, outbound-email descriptor or earlier policy result as runtime authority. Email approvals and internal test-only consumption/attempts now exist separately (email-drafts.md, email-attempts.md); live provider verification and action/gateway execution enforcement remain pending. This authority preview does not consume approval or admit an attempt.

## Original backend validation (2026-10-11)

`npm run check` passed lint, strict types, formatting, production builds and 256 API/client tests; one optional standard PostgreSQL test was skipped because its isolated URL is unset. Nine new synthetic tests cover defaults/read-only previews, all supported action kinds, mandatory email/invitation/attendee/cancellation approval, capability separation, strict content/override rejection, optimistic/concurrent/historical receipts, owner/session isolation, unaffected manual planner writes, export compatibility, populated migration upgrade/SQL constraints and persisted restart. Fixtures use memory or isolated `.artifacts` databases with network calls forbidden.

Optional PostgreSQL coverage adds duplicate policy writes, invitation capability/approval preview and export, but remains unverified locally. Browser tests were not rerun for that backend-only slice. No owner database reads/resets, real provider calls, paid AI or device tests occurred. D57 implementation and validation are recorded separately in implementation-log.md.
