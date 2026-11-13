# Release 2026-11-13: app updates, agent capabilities phase 2, Outlook browser

Status: approved scope for implementation on `release/2026-11-13`. Nothing here
authorizes a main-branch merge or production deploy. Those remain behind an
exact-SHA `REVIEW APPROVED` gate.

## Owner decisions

- **Desktop:** release feed only. Build the GitHub release stream and the Android
  in-app updater now; reserve a desktop artifact slot in the manifest and release
  tooling, but do not add a new desktop application in this release.
- **Outlook:** read-only browser/computer-use connector. Use a dedicated local
  Playwright profile and normal interactive Outlook Web sign-in. No Microsoft
  Graph OAuth, send, write, calendar, attachment or cookie-export scope.
- **Assistant:** full-app capability matrix phase 2: classes/topics, academic
  work, and tracked-deadline overrides/completion.

## Release shape

Three implementation branches, each starting from this branch and opening a pull
request **against `release/2026-11-13`**, not `main`:

1. `feat/app-updates` — release manifest/feed, server update check, Android
   in-app download and install prompt, Settings surface, release tooling/docs.
2. `feat/agent-capabilities-phase-2` — capability registry entries, context refs,
   execute/undo/audit paths, tests and docs for phase 2.
3. `feat/outlook-browser` — migration 080, contracts, owner and collector routes,
   bounded Outlook Web extractor, local connector, Connections UI, tests and docs.

After each PR is reviewed and fixed, merge it into `release/2026-11-13`. Run the
combined validation on that branch. Open one final release PR from
`release/2026-11-13` to `main` and stop for exact-SHA approval. Deploy only after
that approval.

Migration ownership:

- `080_outlook_browser.sql` belongs to `feat/outlook-browser`.
- The other two branches should avoid migrations. If one is unavoidable, use the
  next unused number only after coordinating with the release owner; do not claim
  080.

## Workstream A — release feed and in-app updates

### Server

- Add an owner-authorized update check endpoint, for example
  `GET /api/v1/app/update?platform=android&versionCode=<installed>`.
- Read the latest stable GitHub release for `Errantial/personal-hub` through a
  server-side fetcher. Support `GITHUB_TOKEN` from the environment for rate
  limits, but never expose it or any GitHub credential to the client.
- Prefer a release asset named `release-manifest.json` with:
  - `versionName`, monotonically comparable `versionCode`, `channel`;
  - `android` asset `{ url, sha256, size }` or null;
  - `desktop` array of artifacts `{ platform, url, sha256, size }` (empty now);
  - bounded release notes text.
- Validate the manifest and asset names/hosts. Cache the GitHub response for a
  short bounded interval and degrade to a clear `UPDATE_UNAVAILABLE` state.
- Tests use a fake GitHub fetcher. No test may call GitHub.

### Android

- Add a small native Capacitor plugin for:
  - installed `versionName`/`versionCode`;
  - whether this app may install packages;
  - opening the Android “install unknown apps” settings for this package;
  - downloading the manifest APK, verifying its SHA-256, and launching the
    system package-installer prompt through the existing FileProvider.
- Add `REQUEST_INSTALL_PACKAGES`. Preserve the existing signature requirement;
  Android itself rejects an APK signed by a different key.
- Only manifest-supplied HTTPS URLs are accepted. Enforce a bounded download
  size and delete failed/partial files. Never install silently.
- Pass `versionCode` into the web build so the Settings surface can compare
  builds even when the native bridge is unavailable.

### Web

- Add Settings › Account › App updates: current version, check button, last
  check, available version and bounded notes, progress/error state, permission
  state, and a download/install action. The check must work without leaving the
  page and must not block the rest of Settings.
- Show the desktop slot honestly: no desktop build is published in this release.
- Keep concise labels and put secondary explanation in accessible Help text.

### Release tooling and docs

- Add a release script/runbook that requires a clean tree, builds or accepts the
  signed APK, computes SHA-256, writes `release-manifest.json`, and creates or
  updates a GitHub release with the APK, checksum and manifest. Support optional
  `--desktop` assets so the feed is ready for a later desktop app.
- Document tag format, asset names, version comparison, rollback limits, and the
  fact that production signing keys never enter CI or the repository.
- No production signing key, APK upload or GitHub release is created by tests or
  by this release implementation without separate owner authorization.

### Acceptance

- A synthetic release manifest shows “update available”, correct version
  comparison, notes, permission state and a usable download/install path.
- A stale/older installed version does not offer a downgrade.
- Network, GitHub, malformed manifest and digest failures are visible and do not
  install anything.
- Android debug build compiles; emulator install/update is reported separately
  from Kompakt hardware.
- Server, web unit and focused browser tests pass.

## Workstream B — assistant capability matrix phase 2

Add owner-scoped capabilities through the existing registry, not separate
handlers. Each capability must have a zod schema, context-ref resolution,
optimistic version check, risk tier, execute path, before/after snapshot, audit
row and Undo.

### Capability scope

- **Classes:** `course.create`, `course.update`, `course.delete` (and restore if
  the existing soft-delete/cascade behavior can be reversed safely). Creating a
  class is Tier 1; delete is Tier 2.
- **Topics:** `topic.create`, `topic.update`, `topic.delete`, with class context
  refs. Creating/updating is Tier 1; delete is Tier 2.
- **Academic work:** `academicWork.create`, `academicWork.update`,
  `academicWork.delete`, `academicWork.restore`. Status/grade rules must match
  the existing owner routes; a score cannot be erased implicitly. Create/update
  Tier 1; delete/restore Tier 2.
- **Tracked deadlines:** `trackedDeadline.update` for title override, priority,
  notes, due override and sensitivity; `trackedDeadline.complete` and
  `trackedDeadline.reopen`. These are Tier 1 owner-data updates but must never
  claim submission, mastery or source completeness.
- Do not add batch operations, mail actions, memory, study goals or external
  writes in this slice.

### Context and model surface

- Extend the assistant context only with allowlisted planning fields needed for
  these operations. Preserve refs (`c`, `p`, `w`, `d`) and pin versions.
- Add explicit prompt instructions for the new refs and the prohibition on
  inferring grades, completion of imported work, or source completeness.
- Never expose private IDs, notes outside the allowlist, grades that were not
  explicitly selected, or owner account/auth/policy state.

### Tests and docs

- Registry parsing, ref resolution, owner isolation, stale versions, tier and
  auto-approve behavior, audit snapshots, undo/restore and repeated retry.
- Existing task/event/reminder capability behavior remains unchanged.
- Update the capability matrix, Settings grants/copy if needed, UI ledger and
  implementation receipt. No paid provider call or real agent execution.

## Workstream C — Outlook read-only browser connector

### Product boundary

This is an owner-driven, read-only browser collector, separate from the existing
Outlook Graph access gate. It does not sign in with Microsoft OAuth, store tokens,
request Graph scopes, export cookies, read hidden API responses, take screenshots,
download attachments, send mail, write mail, or touch calendars. It uses a
dedicated persistent Outlook Web profile with normal interactive sign-in/MFA.
Live account access is an owner gate; tests use synthetic HTML only.

### Server and migration 080

- Add additive owner-scoped tables for the source/token hash, selected folders,
  current message records, append-only captures and bounded collection attempts.
- Store collector tokens as SHA-256 only; show the token once; support revocation.
- Keep source health, per-folder coverage and last-complete timestamps distinct.
  Partial or inaccessible folder observations must never prune unseen messages.
- Store only bounded metadata and plain text: provider message identity,
  conversation identity if stable, folder, subject, sender display/address,
  received time, snippet/body plain text, canonical Outlook Web URL, capture
  time and source labels. No HTML, attachments, raw headers, cookies or session
  data.

### Contracts and routes

- Owner routes under `/api/v1/connections/outlook/browser` for status, token
  create/replace/revoke, folder selection, source label and message browsing.
- Collector routes under `/api/v1/outlook/browser/collector/` with a
  `hubob_…` bearer token for attempt start, folder observation, message upload
  and attempt finish.
- Owner authorization, optimistic versions, idempotency receipts, stable retry
  semantics and export-safe records, matching the Canvas browser collector
  patterns.
- No mutation of the existing `outlook_access_gate` findings.

### Local connector

- Add `apps/outlook-browser-connector`, a Playwright Core process like the Canvas
  connector. It must launch a dedicated persistent Chrome/Edge profile headful,
  fail closed if the profile is not new/empty or lacks the Personal Hub marker,
  and never point at a normal browser profile.
- Discover selected folders, open each folder, wait for a stable message list,
  scroll a bounded window, open each message, project only the allowlisted fields
  and upload bounded plain text. Detect sign-in/MFA/foreign-origin/partial DOM
  states and report them rather than treating them as empty.
- Use synthetic fixtures for Outlook Web list/reading-pane markup. Do not put
  private subjects, addresses, IDs or bodies into fixtures or receipts.

### Web UI and docs

- Connections › School Outlook gets a separate “Browser collector (read-only)”
  section/tab with health, token lifecycle, folder selection, source label,
  coverage, imported-message list/detail and error/retry states. Keep the
  existing Graph access gate visible and distinct.
- Explain that this is read-only, local, normal-sign-in browser collection and
  not a Microsoft Graph connection.
- Add runbook, live acceptance checklist, privacy/security boundaries, and an
  explicit statement that no live school account was used in tests.

### Acceptance

- Synthetic extractor tests cover list/reading pane, delayed loading, duplicate
  messages, missing fields, sign-in required, partial folder, malformed DOM and
  foreign-origin navigation.
- Server tests cover token hashing/revocation, owner isolation, idempotent
  retries, folder coverage, no-prune-on-partial, message projection and export.
- Migration 080 applies to a fresh synthetic database and a production-copy
  upgrade fixture; no applied migration is edited.
- Web tests cover the collector states and 320px accessibility.
- Connector typecheck and unit tests pass. Live Outlook sign-in, coverage and
  unattended scheduling remain an owner gate, not a release claim.

## Review and fix phases

1. Each implementation agent self-reviews the full diff, runs focused tests and
   opens a PR against `release/2026-11-13` with `NEEDS REVIEW <url> <exact SHA>`.
2. A separate review agent per PR reviews that exact SHA against this plan,
   inspects the diff, runs focused tests and reports blocking and non-blocking
   findings. Review agents do not approve production.
3. Findings go back to the implementation agent for fixes. Fixes are pushed and
   re-reviewed at the new exact SHA.
4. Merge each green PR into `release/2026-11-13`. Resolve shared-file conflicts
   there, preserving each workstream’s contracts and docs.
5. Run combined validation on the release branch: `npm run check`,
   `npm run test:e2e`, the PostgreSQL suite, `test-release-tree.sh`, production
   builds and the migration checks for 080.
6. Open the final release PR to `main`. Report the exact head SHA and wait for
   `REVIEW APPROVED` before merging or deploying.

## Global constraints

- Do not change owner credentials, send real mail, touch Proton Bridge/laptop
  mail sync, call real providers, make paid AI requests, or use private owner
  data in tests.
- Do not reset, seed or mutate the owner’s development database.
- Never log credentials, tokens, cookies, private mail, message bodies or setup
  secrets.
- Preserve owner authorization, optimistic versions, idempotency receipts,
  tombstones and additive migrations.
- Production deploy remains owner-gated and follows the existing backup,
  staged-artifact, migration, readiness and smoke-test runbook.
