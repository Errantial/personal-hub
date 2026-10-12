# Email draft approval foundation

Backend implemented 2026-10-11. This stores explicit owner-entered plain-text drafts and exact-message approval records. It does not connect a mailbox, import messages, compose provider invitations, send email, queue delivery, execute AI or verify sender identity. UI review controls and verified send adapters remain pending.

Subsequent [email attempt lifecycle](email-attempts.md) adds internal test-only one-attempt consumption, uncertainty and owned metadata history/export. All send previews remain blocked. Synthetic outcomes are not real delivery evidence; an attempted revision cannot receive fresh approval or a second attempt.

## Message and ownership

All records and routes require owner authorization. The complete message contains connection (`proton-mail` or `outlook-mail`), purpose (`email`, `calendar-invitation`, `calendar-attendee-update`, `calendar-cancellation`), sender address, ordered To/Cc/Bcc arrays, subject, plain-text body, empty attachments array and owner-applied sensitivity.

Use 1-50 recipients combined, with no duplicates across lists (case-insensitive duplicate check). Addresses are trimmed; preserve their stored case. Subject is at most 200 characters, without CR/LF/null; body is at most 12000 characters, without null. Subject/body whitespace and body line endings are preserved. Empty subject/body are allowed. Cc/Bcc/attachments default empty, purpose defaults email, sensitivity defaults unlabeled. Display normalized server fields before approval.

Only empty attachments are accepted. No bytes, URLs, attachment descriptors, HTML mode, screenshots, source references, credentials, client approval flags or arbitrary headers are supported. Body text is not rendered HTML. Purpose is an owner declaration, not proof that this text is a complete provider calendar invitation or cancellation. No event/thread/reply linkage or MIME/ICS generation is implemented.

Drafts are outside AI-reference/cache/outbox allowlists. An owner label is not proof of source-text provenance; this slice does not establish any email/attachment-derived text as approved hosted-AI input. No provider or AI calls occur. Content is private persisted owner data, never logged or written into repository fixtures from real accounts. Examples/tests use synthetic messages only.

## Draft lifecycle

| Route | Behavior |
| --- | --- |
| POST `/api/v1/email/drafts` | `{ operationId, message }` creates version 1 and immutable revision 1 atomically |
| GET `/api/v1/email/drafts/:id` | Full current draft, current approval or null, status pending/approved/deleted; includes owned tombstones |
| PUT `/api/v1/email/drafts/:id` | `{ operationId, expectedVersion, message }` replaces the complete message, increments version, revokes active approvals and captures a revision atomically |
| DELETE `/api/v1/email/drafts/:id` | `{ operationId, expectedVersion }` retains a tombstone/new revision and revokes approval |
| POST `/api/v1/email/drafts/:id/restore` | Same versioned input; restores a new pending revision, never prior approval |

Every update invalidates approval, including a same-message save and label-only changes. Deletion/restoration also advance the version and retain a revision. Approval/revocation change separate approval records, not the draft content version. Conflicting versions return 409 `VERSION_CONFLICT`; invalid deletion/restore state returns `DRAFT_STATE_CONFLICT`. Foreign/missing drafts return 404; ordinary update of a deleted draft returns 404.

Drafts, revisions and approvals remain retained in private storage/export. Delete hides a draft; it does not erase body, Bcc, history or receipt data. Permanent erasure and retention controls are pending. Make this limitation visible when offering deletion. No automatic mail-cache retention policy or provider-content ingestion is introduced.

## Exact-message approval

POST `/api/v1/email/drafts/:id/approve` requires `{ operationId, expectedVersion, reviewedContentHash, decision: 'approve-exact-message' }`. Owners must inspect the actual stored sender, all recipient lists, subject, body, purpose/connection, label and explicit lack of attachments. The server hashes the complete normalized message with SHA-256 and binds approval to the owned immutable revision/version/hash. A hash is an integrity identifier, not a secret or an approval by itself.

Stale versions conflict; a mismatched reviewed hash returns `EMAIL_REVIEW_CONFLICT`. Deleted drafts cannot be approved. Current and revision payload integrity must verify or return `EMAIL_PAYLOAD_UNAVAILABLE`; corruption never becomes send authority. One unrevoked approval per revision is enforced by owned SQL foreign keys and a unique index. Different explicit approve requests for the already approved revision return that approval without duplicates.

POST `/api/v1/email/drafts/:id/approvals/:approvalId/revoke` uses `{ operationId, expectedVersion }`, where expectedVersion is the approval version. Revocation increments approval version and preserves its approvedAt/history. Revoke and edit/approve share draft-first row lock order. Owners may deliberately create a new approval for an unchanged revision after revocation if that revision has no attempt. An attempted revision remains consumed. Revoked approvals never revive through retries/restoration.

Mutations acquire the draft row lock before reading message/current approval in a separate statement. Under PostgreSQL Read Committed, each statement has a fresh snapshot, so the later read includes commits that occurred while waiting for the lock. This matters because approval changes do not advance the draft content version. See [PostgreSQL isolation documentation](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED). Standard PostgreSQL concurrency coverage remains opt-in and unverified locally.

All mutation receipts are owner-scoped and atomic. Exact successful retries return historical results without reapplying writes, even after later edits/revocation/deletion/restart. A successful operation ID reused with changed payload returns `OPERATION_CONFLICT`. Failed transactions retain no receipt and no partial revision/revocation. Preserve exact requests after lost responses, then refresh current state: a historical approval receipt is not evidence of current approval.

Approval is an explicit owner review action. Future model/MCP tools must not receive authority to call approve or impersonate owner approval. No model/action executor currently exists. Approval does not verify account access, sender identity, provider capability, final provider payload or hosted-AI routing/consent/budget.

## Browsing and history

GET `/api/v1/email/drafts` accepts limit 1-100/default 25, deleted=false/true/all (default false), and paired after UUID/expectedCursorVersion. Summaries exclude body and recipient addresses, retaining sender/subject/recipient count/purpose/connection/label/status/hash/timestamps/current approval. UUID ascending. Missing/foreign/wrong-deletion-state anchors return 404; changed draft content versions conflict. Approval-state changes do not increment the draft cursor version. Refresh after mutations and guard delayed responses; pages are not frozen.

GET `/api/v1/email/drafts/:id/revisions` accepts limit 1-100/default 25 and optional positive afterVersion, returning body-free revision metadata ascending by version and nextAfterVersion. Unknown anchors return 404. GET `/api/v1/email/drafts/:id/revisions/:version` retrieves the full immutable owned message/hash for review, including prior approved messages. Integrity is checked.

GET `/api/v1/email/drafts/:id/approvals` pages metadata by UUID ascending with limit 1-100/default 25 and paired after/expectedCursorVersion. Revocations change approval cursor versions; foreign/wrong-draft anchors return 404. History remains available after draft deletion. Metadata alone does not show the approved body; load the referenced draftVersion revision for complete review.

Migration 031 adds drafts/revisions/approvals with composite owned revision/hash foreign keys. Export adds default-empty arrays emailDrafts, emailDraftRevisions and emailApprovals, including tombstones/revocation history/private message text. Existing format-v1 files remain parseable; no import exists. Export integrity/row/size checks reject unavailable/oversized data rather than return a partial history.

## Blocked send preview

POST `/api/v1/email/drafts/:id/send-preview` takes `{ expectedVersion, approval?: { id, expectedVersion } }`. Without an explicit reference it inspects the current active approval. With a reference it verifies owned same-draft approval/version and reports missing/current/revoked/stale. Edits/deletion/restoration make prior revision approvals stale; same-revision explicit revocation reports revoked. A stale approval record version conflicts before classification.

Every response has status blocked and executionEnabled false. Missing/revoked/stale approvals include EMAIL_APPROVAL_REQUIRED and corresponding APPROVAL_REVOKED/APPROVAL_STALE reasons; tombstones include DRAFT_DELETED. Even current approval always includes SENDER_UNVERIFIED, SEND_CAPABILITY_UNVERIFIED and EMAIL_EXECUTION_UNAVAILABLE. The read-only snapshot rechecks session/draft/revision integrity and policy-independent mandatory email approval. No preview changes records, creates receipts, queues delivery or sends.

There is no live send endpoint, worker, provider reconciliation or retry-after-uncertain-send mechanism. Internal test-only consumption/attempt history is implemented separately in email-attempts.md. Preview includes current-revision attempt or null, consumed state, EMAIL_ATTEMPT_EXISTS and EMAIL_DELIVERY_UNCERTAIN; inspect these even when draft status is approved. A future live adapter must revalidate exact current payload/approval/account capability atomically, preserve no-resend uncertainty, and never silently alter recipients/body/attachments or add a signature/invitation payload after review. Added material requires a new reviewed revision. Calendar authority and action-policy preview never substitute for email approval. UI review and actual provider dispatch remain pending.

## Validation

`npm run check` passed lint, strict types, formatting, production builds and 268 API/client tests; one optional standard PostgreSQL test was skipped because its isolated URL is unset. Twelve new synthetic tests cover strict text-only fields/unsupported AI references, normalized hash review, receipt/concurrency/version conflicts, every material field and same-message invalidation, revoke/reapprove, edit/approval races, forced atomic rollback, owner/session/foreign-key isolation, guarded body-free history, integrity/export rejection, populated upgrade, tombstones/export and persisted restart. Memory and isolated `.artifacts` fixtures forbid network calls.

Optional PostgreSQL coverage adds distinct simultaneous approvals, duplicate receipts, edit invalidation, blocked preview and export, but remains unverified locally. Browser tests were not rerun because UI/authentication-layer code was unchanged. No owner database reads/resets, real mailbox/provider calls, paid AI or device tests occurred. UI review, attachment/provider payload support and actual sending remain pending.

Final verification after the approval-lock read change: all 12 email draft tests passed again; targeted lint/format checks and `git diff --check` passed.
