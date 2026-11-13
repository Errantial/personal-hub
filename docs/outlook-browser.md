# Read-only Outlook Web browser collector

## Status — 2026-11-13 release development

The hub has a development implementation of a read-only, owner-driven Outlook Web browser collector. It is separate from the [Outlook Graph access gate](outlook.md): it does not sign in with Microsoft OAuth, request Graph scopes or store OAuth tokens. It uses a dedicated local browser profile with normal interactive Outlook Web sign-in and MFA, projects a bounded allowlist of fields from the rendered page and uploads bounded plain text to the hub.

No live school account, Microsoft credential, cookie, screenshot, attachment or real mail was used to implement or test this slice. Synthetic fixtures only. Live sign-in, real Outlook Web selectors, mailbox coverage and unattended scheduling remain an owner gate and are **not** release claims.

## Product boundary

Allowed:

- discover folders shown by the normal Outlook Web session;
- let the owner select folders;
- open each selected folder in the bounded collector window;
- open each visible message in its reading pane;
- project folder identity/name, message identity, optional conversation identity, subject, sender display/address, received time, snippet, plain-text body, canonical Outlook Web URL and capture time;
- record source/folder coverage, attempts, error categories and owner notes/labels.

Not implemented or authorized:

- Microsoft Graph, OAuth, app registration, tenant-wide access or delegated scopes;
- cookie or browser-storage export;
- hidden API response reading or network interception of message content;
- screenshots, OCR, attachments or attachment-derived text;
- HTML storage, raw headers or session data;
- send, reply, delete, move, flag, archive or any other explicit provider-side write;
- calendar access or invitation/cancellation email side effects;
- automatic task creation, AI dispatch or autonomous actions.

Opening a message in Outlook Web can update its read/unread state or trigger normal account read-receipt behavior, depending on the school account's Outlook Web settings. The collector does not click mark-read, flag, move or send controls, but it cannot promise that Outlook itself performs no server-side state change when the reading pane opens. This is part of the live owner acceptance gate; it is not described as a guaranteed zero-side-effect read.

## Server and migration

Migration `080_outlook_browser.sql` is additive. It creates owner-scoped tables:

- `outlook_browser_sources`: SHA-256 collector token hash, issue/revoke time, source label, optimistic version, selected-folder coverage revision and health timestamps;
- `outlook_browser_attempts`: bounded collection attempts, source/coverage versions, discovery status, counts and outcome/error category;
- `outlook_browser_folders`: discovered/provider folder identity, canonical URL, availability, explicit selection, owner notes/label and per-folder contact/import/complete coverage;
- `outlook_browser_messages`: current folder-scoped message records with bounded metadata and plain text;
- `outlook_browser_folder_observations`: one append-only-style durable observation per attempt/folder with a payload hash and counts;
- `outlook_browser_message_captures`: append-only per-attempt snapshots of metadata and snippet, protected by an immutable trigger.

The migration does not alter or backfill `outlook_access_gate`. A production-copy upgrade fixture verifies that existing owner records and access-gate findings are unchanged.

## Stored data limits

- At most 200 discovered folders.
- At most 200 messages per selected folder in one observation window.
- Message subject 500 characters; sender display 200; sender address 320; snippet 2,000; plain-text body 20,000; canonical URL 2,000.
- Received time is an exact instant or null. It is never inferred from a display label.
- Current messages keep the plain-text body. Append-only captures keep metadata and snippet, not a second copy of the body. Message detail and portable export add a read-time `effectiveSensitivity` to each capture by combining the current source, folder and message labels; immutable snapshot bytes are never rewritten by a later relabel.
- Message identity is folder-scoped because Outlook Web folds folder membership into the rendered list. The same provider message visible in two selected folders is retained as two current records rather than silently merged.
- Export includes safe source/folder/current-message/capture records with read-time effective sensitivity. It excludes collector tokens, token hashes, attempt hashes, active-attempt IDs and browser profile/session data.

## Routes

Owner-authorized, under `/api/v1/connections/outlook/browser`:

| Method/path | Purpose |
| --- | --- |
| `GET` | Source health, folders, 200 most recent message summaries and recent attempts |
| `PUT` | Versioned source label |
| `POST /token` | Create or replace the `hubob_…` collector token; shown once |
| `POST /revoke` | Revoke collector access; imported records remain |
| `PUT /folders/:id` | Versioned folder selection, notes and label |
| `PUT /messages/:id` | Versioned message notes and label |
| `GET /messages/:id` | Current plain-text message detail and bounded captures |

Collector-authorized with the `hubob_…` bearer token, under `/api/v1/outlook/browser/collector/`:

| Method/path | Purpose |
| --- | --- |
| `GET state` | Selected folders and current source version |
| `POST attempt` | Start or exactly retry an attempt; one active attempt per source |
| `POST discovery` | Record the complete/partial discovered folder list |
| `POST folder` | Upload one complete/partial/inaccessible folder observation, including its bounded message window (the Canvas collector pattern; there is no separate message route) |
| `POST attempt/finish` | Finish complete/partial/failed with a bounded error category |

Owner routes use the normal session, origin policy and operation receipts. Collector routes use a bearer token and are exempt from browser CSRF origin checks only for that token form. Token retries do not re-show a token. Exact attempt/folder payload retries return the original counts; changed retries are rejected.

## Local connector

`apps/outlook-browser-connector` is a Playwright Core process. It launches a dedicated persistent Chrome or Edge profile **headful**. The profile directory must be new/empty on first use or already contain the exact Personal Hub Outlook profile marker, so pointing it at a normal Chrome/Edge profile fails closed. Sign-in and MFA remain normal interactive browser actions in the opened window; the connector waits a bounded configured interval, detects sign-in/MFA overlays and reports `sign-in-required` or `mfa-required`. Discovery requires an Outlook `/mail` route with a folder-list container, not just any same-origin page.

Configuration lives outside the repository at `%APPDATA%\personal-hub\outlook-browser-connector.json` by default, or the path named by `HUB_OUTLOOK_BROWSER_CONFIG`:

```json
{
  "hubUrl": "https://hub.example.invalid",
  "hubToken": "hubob_REPLACE_WITH_ONE_TIME_TOKEN",
  "profilePath": "C:\\Users\\you\\AppData\\Local\\personal-hub\\outlook-browser-profile",
  "browserChannel": "chrome",
  "outlookOrigin": "https://outlook.office.com",
  "signInWaitSeconds": 300
}
```

`outlookOrigin` must be the exact Outlook Web origin shown after the owner's normal sign-in: `https://outlook.office.com`, `https://outlook.office365.com`, `https://outlook.cloud.microsoft` or `https://outlook.live.com`. Any other committed origin is reported as `foreign-origin` and no fields are projected. Microsoft login hosts are recognized only for the bounded interactive sign-in wait; a school-hosted SSO/ADFS page on another domain is not allowlisted, so complete sign-in in the dedicated profile before the collection or treat `foreign-origin` as a live gate.

Run a configured development collection:

```sh
npm run sync --workspace @hub/outlook-browser-connector
```

The connector never exports cookies/storage, takes screenshots, reads hidden API responses, downloads attachments, logs private page text or performs provider writes. It navigates to canonical same-origin folder/message URLs, requires a stable list with no loading marker, active search/filter or pagination signal, opens messages individually and projects only the allowlisted fields. Logs contain only bounded categories.

## Coverage semantics

Visible states are `never-synced`, `syncing`, `current`, `stale`, `partial`, `sign-in-required`, `mfa-required`, `revoked` and `error`.

- `current` requires a complete folder discovery, at least one selected folder, a complete observation for every folder selected at attempt start, and a matching selected-folder coverage revision.
- Changing the selected set immediately invalidates `current` until that exact set completes.
- A complete folder observation marks unseen messages missing **within that folder only**. Partial, inaccessible, sign-in, MFA or failed observations never prune unseen messages.
- A complete observation requires a proven stable, fully linked identity window: every rendered `role="option"` resolves to a message identity, two bounded scroll sweeps reach the same identity set, and there is no unresolved skeleton, virtualized/recycled-row signal, `aria-setsize`/total-count gap, generic load-more, `rel="next"` pagination or collapsed section. Any such signal reports `partial` and never prunes. The server also rejects a `complete` observation with zero messages; the connector reports an empty folder as partial until live empty-state proof exists.
- A folder that redirects elsewhere, returns 403/404 or loses a reading pane becomes partial or inaccessible rather than an empty complete snapshot. The rendered list is verified against the requested folder before upload.
- A message missing a required subject, sender, reading pane or valid exact timestamp is skipped and makes the folder partial. Reading-pane projection is scoped to a single visible pane, requires stable content and a non-empty body or an explicit empty-body marker, verifies message identity and never follows body links as the sender. Unsafe or decorated canonical URLs fail validation instead of being guessed.
- `stale` uses a six-hour freshness threshold. A collector that runs less often will visibly show stale rather than current.
- Token revocation keeps imported records and shows `revoked`; a replacement token restores collector access.

## Live owner acceptance gate

Complete these checks with the owner's normal school sign-in before claiming live Outlook collection:

1. Create a new dedicated profile and finish the normal school sign-in/MFA interactively. Rerun and verify the profile reuses the session without another login.
2. Confirm the configured `outlookOrigin` matches the committed address and that a deliberately foreign navigation is reported as `foreign-origin`.
3. Verify folder-list and message-reading-pane selectors against at least two structurally different folders, including delayed network loading. The synthetic fixtures do not prove the live Outlook Web markup.
4. Select at least two folders and finish a complete run. Compare retained counts/subjects with the owner's Outlook UI without putting private titles, addresses, IDs or bodies into receipts.
5. Sign out in the dedicated profile and confirm `sign-in-required`; confirm partial/inaccessible folders did not mark unseen messages missing.
6. Confirm no attachment, HTML, screenshot, cookie or hidden API content exists in stored records or export. Revoke the token and confirm collector requests fail while records remain.
7. Confirm how the school account's Outlook Web reading-pane settings treat read/unread state and read receipts when a message opens. Record the observed behavior; the collector performs no explicit mark-read or send control, but Outlook itself may change server-side state.

Unattended scheduling is intentionally not installed. Only after the checklist passes should a local schedule be designed and audited; the collector requires the owner's interactive session and is not an always-on server job.

## Validation

- Synthetic connector tests cover delayed loading, duplicate list rows, missing fields, sign-in/MFA/foreign-origin classification, partial folders and malformed DOM.
- API tests cover hash-only tokens, one-time issuance, revocation, owner isolation, idempotent retries, complete-only pruning, coverage invalidation, message projection and export exclusions.
- Migration tests cover a fresh synthetic database and a populated production-copy upgrade fixture through migration 080.
- Web browser tests cover the separate access-gate/browser sections, token lifecycle, folder selection, message detail, error states and 320 px overflow.
- No live Outlook/Microsoft account, credential, cookie, screenshot, attachment, real mail or paid provider call was used.
