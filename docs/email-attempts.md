# Email attempt lifecycle

Implemented 2026-10-11: durable test-only synthetic email attempts, one-attempt revision/approval consumption, confirmed synthetic outcomes, owned metadata history and export. Migration 032 adds records and composite owned approval/payload foreign keys. This is an internal test harness; no real transport, HTTP send/retry/confirmation endpoint, worker, credentials or production enable switch exists. All send previews still block execution. [Email drafts](email-drafts.md) remain the owner review foundation.

## Admission and consumption

`beginSyntheticEmailAttempt` requires NODE_ENV=test, an owned draft ID/current content version, an owned approval ID/current metadata version and reviewed content hash. It locks the draft using the same order as edits/revocation, reads fresh approval state, verifies the immutable captured revision, rejects tombstones/revocation/stale content and requires sender/to/cc/bcc addresses in reserved `.test` domains. Calendar purposes use the same checks; no actual invitation payload is generated.

The transaction inserts an uncertain attempt bound to the exact revision, hash, approval ID and admitted approval version. Unique constraints permit one attempt per owned revision and per approval. This record is the durable consumption claim; it does not change the content version or pretend approval was revoked. Approval version is historical admission metadata, while the immutable identity/hash tuple has a same-owner approval foreign key.

Only the first claim returns the normalized message in memory. Exact admission retries return the existing attempt after later edits, deletion, revocation or restart, without a payload or dispatch permission. Different approval/hash parameters for an attempted revision conflict. Fresh approve operations on that revision return EMAIL_ATTEMPT_EXISTS; historical successful approval receipts retain their original result and never reset consumption. Not-sent also consumes the revision. A deliberately saved and explicitly reviewed new revision can have a new attempt; this is not an automatic retry.

## Synthetic execution and uncertainty

`executeSyntheticEmail` checks test configuration and synthetic adapter kind before admission. After consumption commits, it invokes the callback once outside any database transaction/retry loop, supplying only attempt ID and reviewed normalized message. No credentials are supplied. Concurrent callers/restarts inspect the existing claim without invoking the callback.

The result must be exactly `{ outcome: 'sent' | 'not-sent' }`. These are synthetic test outcomes, not evidence of real acceptance or recipient delivery. Confirmation moves uncertain/version 1 to the terminal outcome/version 2 with finishedAt. Same-outcome retries are read-only; a different terminal outcome conflicts. Only the internal test harness confirms; there is no owner/provider confirmation route.

Thrown callbacks, malformed/extra-field results, lost responses, process death and database confirmation failures retain uncertainty and consumption. No exception/provider-response text is stored or logged. Uncertainty may mean the callback never began or may have completed; timeout/restart never establishes not-sent. Internal confirmation resolves a known synthetic outcome without transport invocation. No automatic recovery dispatch, reset, fallback or attempt deletion exists.

Consumption commits at the dispatch boundary. Later edits, deletion or revocation cannot prove cancellation of a claimed message. The callback receives the approved revision, never its replacement. Competing edit/admission either admits the previously approved revision before the edit or rejects stale admission. Live cancellation, provider reconciliation, verified sender/capability, MIME/attachment/signature payload verification and no-duplicate delivery across independently reviewed revisions remain pending.

## Owned history and previews

| Endpoint | Contract |
| --- | --- |
| GET `/api/v1/email/drafts/:id/attempts` | Metadata-only UUID-ascending page; limit 1–100 (default 25), paired after/expectedCursorVersion; nextAfter `{ id, version }` or null |
| GET `/api/v1/email/drafts/:id/attempts/:attemptId` | Owned same-draft metadata detail, including tombstone history |
| POST `/api/v1/email/drafts/:id/send-preview` | Existing read-only blocked preview, plus current-revision attempt or null and consumed state |

Metadata: id, draftId, draftVersion, contentHash, approvalId, approvalVersion, adapter=synthetic, status=uncertain/sent/not-sent, version, createdAt, updatedAt, finishedAt. Reads omit sender, recipients/Bcc, subject, body and callback/errors. Existing authorized revision detail permits exact-message inspection. Confirmation changes cursor version (409); foreign/wrong-draft/missing cursors return 404. Cursors guard changed anchors, not frozen multi-page history. Reads use owned consistent snapshots/session rechecks.

Preview inspects the current revision. An attempt marks approvalState consumed (an explicit older revision remains stale), adds EMAIL_ATTEMPT_EXISTS and, if uncertain, EMAIL_DELIVERY_UNCERTAIN. A later edited revision has no current attempt until separately approved/claimed; old history remains. Approval-required and sender/capability/execution blockers remain; executionEnabled=false always. Draft status approved means reviewed, not unused send permission; inspect preview/attempt history.

Format-v1 export adds default-empty emailAttempts under existing row/size limits. Attempts/history survive draft delete/restore; retention/permanent erasure remain unresolved. No offline cache/outbox or AI/MCP context/dispatch path is added.

## UI handoff and live gates

Distinguish synthetic outcomes from real sending. Keep uncertainty visible and require review; never automatically resend, treat not-sent as renewed permission or replay sends through the task outbox. Explain that edits/revocation do not retract a claimed dispatch. Refresh current draft, preview and attempts after historical receipt retries. Keep Bcc/revision text behind owned explicit detail reads.

Future live adapters must verify the actual final payload/account/write capability at admission, atomically consume approval, retain a provider-bound attempt identity, distinguish acceptance from delivery and reconcile uncertain outcomes without retransmission. New material requires new review; a test configuration/adapter declaration never verifies capability. UI review, provider verification/reconciliation and actual sending remain pending.

## Validation

`npm run check` passed lint, strict types, formatting, production builds and 278 API/client tests; one optional standard PostgreSQL test was skipped. All ten new attempt tests also passed in a focused rerun. Coverage includes concurrent claims/competing edits, durable consumption, blocked previews, exact approval/hash/owner gates, test-only configuration/addresses, malformed/thrown callbacks, failed confirmation, immutable revisions, terminal conflicts, private guarded history/session revocation/SQL constraints, populated upgrade and persisted restart. Fetch is forbidden; fixtures use memory or isolated `.artifacts` databases. No owner database reads/resets, real mailbox/provider calls, paid AI or device tests occurred.

Optional standard PostgreSQL coverage adds simultaneous distinct claims, concurrent idempotent confirmation and attempt export in the disposable test schema. It remains unverified locally while TEST_DATABASE_URL is unset. Browser tests were not rerun because UI/authentication-layer code is unchanged. A nondeterministic test assertion based on UUID page order was corrected to explicitly construct the invalid SQL state being checked; the final full run passed.
