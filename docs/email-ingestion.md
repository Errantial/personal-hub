# Proton Mail ingestion (read-only)

Implemented 2026-10-13 (plan step 5, first half; D48, D51). Proton Bridge runs on the owner's always-on Windows computer; Bridge's official Linux build does not support the Oracle VM's ARM64 CPU. A small connector on that computer reads mail through Bridge and uploads it to the hub over HTTPS. Bridge is never exposed beyond loopback. Selected-message category/task suggestions and Assistant mail reading are implemented through narrow OpenRouter flows. The separate general verified-context gateway still has disabled dispatch. Windows mail sync was recorded as operating every ten minutes on 2026-10-14; required Gmail coverage remains unverified.

## Owner decisions (2026-10-13)

- Upload headers and the plain-text body (HTML converted to text, 32,000-character cap). Attachments are never uploaded; only their count is kept.
- Read every folder and label except Spam and Trash.
- First import: 30 days before the connector is added; new mail afterwards.
- The connector's owner-chosen label (default Personal) applies to every imported message. Current narrow live mail flows require explicit Allow Personal mail before Personal disclosure and always exclude Restricted content. The general gateway separately evaluates inherited routing rules; categories never authorize disclosure.

## Completeness proof (2026-10-13, this computer)

`npm run check --workspace @hub/email-connector` read 15 folders read-only, printing counts only:

- All Mail: 44,205 messages; 1,001 in the last 30 days, equal to the distinct Message-IDs across all folders. This establishes coverage of the observed Bridge snapshot, not ongoing delivery completeness.
- The Gmail label (42,956 messages) has its newest observed message on 2026-09-28, with 1 message in the last 30 days and 718 in the last 90. Proton's Inbox is current. Check Proton's Gmail forwarding/import; this snapshot cannot establish why newer Gmail mail is absent. The hub cannot see Gmail mail that never reaches Proton.

A `sync --dry-run` then parsed the same 1,846 folder entries (1,001 distinct, all with a Message-ID) without uploading.

## Connector (`apps/email-connector`)

Settings live outside the repository in `%APPDATA%\personal-hub\email-connector.json` (or `HUB_CONNECTOR_CONFIG`):

```json
{
  "hubUrl": "https://hub.ecg.name",
  "hubToken": "hubc_… (from Settings › Connections › Email)",
  "bridge": {
    "host": "127.0.0.1",
    "port": 1143,
    "security": "ssl",
    "user": "Bridge IMAP username",
    "password": "Bridge-generated password"
  }
}
```

The file holds secrets; never commit, print or share it. Bridge must be on a loopback address. Bridge's own certificate is self-signed, so verification is relaxed for that loopback connection only.

- `npm run check --workspace @hub/email-connector`: read-only folder/count report.
- `npm run sync --workspace @hub/email-connector [-- --dry-run]`: upload new mail, or parse locally and print counts only.

Sync asks the hub for each folder's UIDVALIDITY and last uploaded UID, opens folders with EXAMINE (flags never change), uploads new messages oldest first in batches of 25, then records the folder's high-water mark. Missing or incomplete fetch results stop the run before advancing that batch. A changed UIDVALIDITY restarts that folder; messages de-duplicate by Message-ID (or a SHA-256 of the source when it is missing), and folder membership accumulates. Messages above 15 MiB are stored with headers only and marked shortened, although their raw source is still fetched locally; attachment counts for these messages are unavailable. Errors print only our own messages and error names, never IMAP server text. Configure Task Scheduler to avoid overlapping runs.

Operation recorded 2026-10-14: a Windows scheduled job runs every ten minutes. Do not install a duplicate job as a prerequisite to further development. Audit its installed version, non-overlap behavior and recovery from host sleep/Bridge outages before changing it. Running from the development checkout depends on its branch; a separately versioned install directory is preferred. This status is a dated operating receipt, not a fresh inspection of the job.

## Hub routes

Owner (session):

- `GET /api/v1/email/connectors` lists connectors with per-folder `exists` (Bridge count), `inWindow` (since the start date) and `imported`. `imported < inWindow` means a folder is not yet complete.
- `POST /api/v1/email/connectors` `{ operationId, name, sensitivity }` → 201 `{ connector, token }`. The token (`hubc_` + 32 random bytes) is shown once; only its SHA-256 is stored.
- `POST /api/v1/email/connectors/:id/revoke` `{ operationId, expectedVersion }` stops the token immediately. Imported mail stays.
- `GET /api/v1/email/messages?limit&before&folder` pages newest first (received time, then ID) with a 200-character snippet. `GET /api/v1/email/messages/:id` returns headers and the full stored text.

Connector (bearer token, no browser origin; exempt from the browser origin check only on `/api/v1/email/connector/*` with a `hubc_` bearer token):

- `GET /api/v1/email/connector/state` → `{ since, folders: [{ path, uidValidity, lastUid }] }`.
- `POST /api/v1/email/connector/batch` (4 MiB limit) → `{ stored, lastUid }`. Positions never move backwards except on a new UIDVALIDITY.

Session cookies cannot call connector routes and tokens cannot read mail. Migration 047 adds `email_connectors`, `email_folders` and `email_messages`.

Owner create/revoke writes require `operationId`. Durable receipts contain connector IDs only, never tokens. A lost create response cannot recover its one-time token: retry returns `TOKEN_ALREADY_ISSUED` without creating a duplicate; reload Connections, revoke the inaccessible connector, and create a replacement. Revocation retries reuse the receipt without incrementing the version twice. Uploads lock the connector row, serializing cursor changes with other uploads and revocation.

## Validation

API tests: one-time token and hash-only storage, cookie/token separation, de-duplication across folders, folder positions and UIDVALIDITY restart, paging and folder filter, body size limit, revocation and version conflicts. Connector tests: plain text, HTML-only conversion, group addresses, attachment counting without content, truncation and hashed keys. Browser test: create a connector, upload with its token, folder counts, Inbox › Mail list/detail (plain text, never HTML), revoke. Historical 2026-10-13 live read-only validation: the check and dry run above uploaded no mail. The subsequent 2026-10-14 operating status records live upload/scheduling; it does not supply a current Gmail comparison or a new failure-recovery receipt. Do not copy message content into logs or the repository.

## Known limits

[Mail categories and rules](mail-organization.md) now organize imported records locally and preserve owner corrections through connector refreshes. Provider flags, labels, folders and bodies remain read-only.

The [verified mail context gateway](ai-mail-context.md) now accepts explicitly selected message references. Updated collectors declare message-body origin; older imported text remains unavailable for AI context. This foundation itself enables no classification or paid calls; separately implemented selected-message suggestions and Assistant mail reading use narrow live paths. Mail list/detail now expose a source `version`.

P10 now records connector attempts, successful contact, imports, complete configured-window collections and bounded error categories separately, and the final empty folder batch is explicitly marked as a complete observation. Complete observations reconcile normalized folder membership for that connector/path/UIDVALIDITY generation: missing memberships are retired only after a full configured-window snapshot, moves keep the retained message while changing proven memberships, and partial/failed observations never remove unseen records. Legacy rows are not backfilled with invented UID evidence, so existing folder arrays remain until a future complete observation proves membership. The historical Gmail snapshot still needs a bounded owner-reviewed comparison; it is not a current diagnosis or proof of ongoing completeness. Automatic classification/application and provider mailbox changes remain excluded; selected-message suggestions do not establish autonomous filtering.
