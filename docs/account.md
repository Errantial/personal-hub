# Account controls and planner export

Open Preferences while signed in to change the owner password, view/revoke active sessions, or download planner JSON. These controls require a server connection. Recovery/reset remains unimplemented; retain the password in a password manager.

Password changes require the current password, a different new password of at least 12 characters, and the current credential version. The server hashes the new password, increments that version, revokes all existing owner sessions and issues a replacement session in one transaction. The browser retains the same owner's queued task drafts and records the replacement session's actual expiration. Other devices must sign in again before reading private server data or replaying edits. A device that remains offline cannot discover revocation immediately; its existing local expiry still bounds cached access.

Credential requests are online-only and never stored in planner mutation receipts or the offline outbox. A lost password-change response can be ambiguous: sign in using the new password if the old one no longer works. Login rechecks the verified password hash under the same user lock used by password changes, preventing an old verification from issuing a new session after the change. Current-password verification and session rotation follow the [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) and [session management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

Session lists expose random public IDs, versions, creation/expiration times and a current-session marker. They exclude token hashes, cookies and device fingerprints. Revocation uses an optimistic version and idempotent operation receipt. Use Sign out for the current session so pending local drafts receive the existing sync/discard check. Revoked and expired session records currently remain in the database; retention/pruning is pending.

## Download format

`GET /api/v1/planner/export` requires owner authorization and returns a consistent read-only snapshot with `format: personal-hub-planner`, `formatVersion: 1`, export timestamp, owner ID/email and these collections:

- Tasks, calendar records, courses and topics, including versions, sensitivity labels and delete tombstones.
- Recurrence exceptions, including cancelled or replaced occurrences.
- Reminder schedules and notification inbox history.
- Imported Canvas entries, file/network provenance, personal notes, labels and source settings; private feed URLs and sync lease tokens remain excluded. These are additive format-v1 fields; older exports default to empty Canvas data.

Only explicitly selected planner fields are exported. Authentication records, password/session hashes, setup configuration, mutation receipts and worker lease tokens are excluded. Records retain their stored labels and class/topic links; downstream processing must still apply inherited provenance rules. Treat the downloaded file as private data.

The website requires queued tasks to be synchronized or discarded before downloading. The API exports server records and cannot inspect a client's outbox. Limits are 10,000 records per collection and 16 MiB of serialized JSON; exceeding either returns `413 EXPORT_TOO_LARGE`, without a truncated download. Downloads are verified in Chromium; native Android download behavior is unverified and deferred with device work.

This is a portable data export, not a complete database backup or a supported restore/import format. Automated backups, recovery, import, permanent deletion and production restore acceptance remain pending. Follow development.md for database-aware backup instructions.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/v1/auth/account` | Credential version and active safe session summaries |
| `POST /api/v1/auth/password` | Current/new password and expected credential version; rotates all sessions |
| `POST /api/v1/auth/sessions/:id/revoke` | Operation ID and expected session version; revokes another session |
| `GET /api/v1/planner/export` | Versioned planner JSON attachment |

Unsafe routes retain the existing exact-Origin and JSON checks. Password changes are limited to five requests per fifteen minutes. Migration 003 adds credential versions, public session IDs, session versions and revocation timestamps without modifying applied migrations.
