# Canvas browser fallback

## Status — 2026-10-16

The owner reports that school policy blocks personal Canvas token creation. The existing API adapter cannot be configured through that path. Calendar feed/ICS import remains separate; institution-approved OAuth remains an alternative requiring administrator-issued credentials.

A live **read-only feasibility test** succeeded on 2026-10-13 through the owner's normal authenticated Canvas browser session. P11 now has a development implementation of the bounded local collector, owned durable ingestion, owner-visible coverage/settings and explicit browser/calendar-feed reconciliation. No new live school access was performed while implementing it. It is not yet an installed scheduled job, all-course acceptance receipt or verified hosted-AI source.

## Completed proof

- After the T3 browser runtime restarted, the saved Default profile returned to the Canvas dashboard without another login. The dashboard exposed nine course links.
- One academic course was selected explicitly. DOM navigation reached its Assignments page without an API token, cookie export, hidden API requests or provider writes.
- The list loaded dynamically after the document's initial load. An immediate empty DOM result was not treated as an empty course. Later repeated reads consistently found 27 unique assignment links/titles, 10 exact machine-readable due timestamps and 17 records without dates. All ten timestamps parsed; no due label lacked its timestamp, and no loading indicator remained in the inspected list.
- Projection selectors were `#content a.ig-title`, `li.assignment` and `.assignment-date-due [datetime]`. Canonical same-origin assignment paths identified the records. Actual private titles, IDs, grades, dates and page contents are not included in this receipt or fixtures.
- Native T3 snapshot still timed out on a fresh public page after restart. The bounded DOM-read/navigation route remained usable. Snapshot/native-click recovery is a separate tool issue; it is not proof of an account/API-access failure.

The test did not import anything into the hub, compare with a live calendar feed, verify all courses/terms or enable AI. There was no attachment download, screenshot or paid model call. Authentication secrets were not read or exported. The original page inspection revealed that assignment lists can also contain scores; a future collector must project selected fields locally rather than capture full-page text.

## Development connector

`apps/canvas-browser-connector` is a read-only local process. It launches a dedicated persistent Chrome or Edge profile **headful** with Playwright Core; login and MFA remain normal interactive browser actions. The configured profile directory must be new/empty on first use or already contain the exact Personal Hub profile marker, so pointing the collector at a normal Chrome/Edge user-data directory fails closed. It never exports cookies/storage, takes screenshots, reads hidden API responses or performs provider writes. Its configuration belongs outside the repository at `%APPDATA%\personal-hub\canvas-browser-connector.json` by default (or the path named by `HUB_CANVAS_BROWSER_CONFIG`):

```json
{
  "hubUrl": "https://hub.example.invalid",
  "hubToken": "hubcb_REPLACE_WITH_ONE_TIME_TOKEN",
  "profilePath": "C:\\Users\\you\\AppData\\Local\\personal-hub\\canvas-browser-profile",
  "browserChannel": "chrome"
}
```

Settings › Connections › Canvas › Browser collector creates/replaces the collector token once, shows source health, and lets the owner explicitly select discovered courses, link them to an existing local class and apply source/course/item labels and personal notes. Revocation stops collector access but retains imported records. The browser token is SHA-256-only in server storage and is excluded from mutation receipts and portable export.

Each run binds the source version and selected-course coverage revision and has a durable attempt whose active lease advances on successful attempt-bound collector progress. Browser launch failure is recorded as a bounded failed attempt rather than leaving old health untouched. Discovery uses the Canvas `/courses` page, waits for a stable scoped DOM and accepts at most 100 canonical same-origin course identities. Selected courses are then visited at their assignment list. The collector projects only resource kind (`assignment` or `quiz`), numeric provider identity, canonical same-origin URL, displayed title, exact machine-readable `datetime` with an explicit offset/Z or null, and capture time. Assignment and quiz IDs are separate identities even when their numbers match. Descriptions, grades, scores, submissions, files, attachments, screenshots, full-page text and browser/session exports are excluded.

Coverage is deliberately conservative. Never synced, Syncing, Current, Stale, Partial, Sign in required, Revoked and Error are distinct. Source and per-course contact/import/complete timestamps stay separate, and source completion is bound to a dedicated selected-course coverage revision: changing the selected set immediately invalidates Current until that exact set completes. A run can finish Current only after a complete `/courses` discovery and a complete observation for every course selected at attempt start. DOM readiness requires a multi-second quiet period with no loading marker; loading that never stabilizes, an empty DOM result, active search/filter state, pagination/collapsed traversal signals, inaccessible courses, unexpected navigation, Canvas `/login`/logout or foreign-origin redirects, malformed identities/timestamps and traversal bounds become Sign in required/Partial/Error rather than an empty complete snapshot. The ingestion protocol can represent a proven complete empty course without inventing an import timestamp, but the browser runtime deliberately treats an empty DOM as Partial until a future Canvas-specific empty-state proof is implemented. Only complete course observations mark unseen browser items missing; partial/inaccessible observations never prune them. Discovery and course/finish uploads have durable exact retry behavior.

Migration 070 keeps browser provenance in `canvas_browser_*` tables, separate from calendar-feed/ICS and Canvas API records. Provider refresh updates only current browser provider facts/availability; owner notes, labels and class links are retained. Every observed assignment/quiz also gets an append-only attempt-bound capture, so changed titles/due dates do not erase prior provider observations. Portable export includes safe browser source/course/current-item/capture records but no collector token, attempt hashes or browser profile/session data. Browser capture by itself does **not** certify hosted-AI provenance and is not merged with feed/API identity automatically.

Migration 071 adds a separate owner-confirmed browser/calendar-feed association. Settings › Connections › Canvas › Matching lists retained browser items alongside exact canonical-URL feed candidates and keeps titles, dates, availability, notes, labels and source records independent. A link can be created only when both records are currently available, their current versions match and the canonical Canvas URLs are exactly equal; one active feed item cannot be claimed by two browser items. Later title/date disagreement or feed disappearance does not rewrite browser facts, choose a deadline winner or remove the association. An absent feed item is therefore never deletion evidence for the browser record. Removing a link retains a tombstone, and safe link metadata is included in portable export. This association still does not certify browser text for hosted AI.

Run a configured development collection with `npm run sync --workspace @hub/canvas-browser-connector`. There is intentionally no installed scheduler yet: first live acceptance must prove two differently structured courses, every selected course, changed and undated work, delayed loading, inaccessible/expired-session behavior and an owner comparison without exposing private titles in receipts. Only after that proof should an unattended local schedule be installed/audited. Institution-approved OAuth remains preferable if the school later provides a developer key.

Grades, submissions, assignment descriptions, provider writes, automatic planner creation and autonomous actions remain outside this slice. Live owner comparison across the browser and calendar feed remains part of P11 acceptance; the development reconciliation layer does not substitute for that gate. No institutional restriction bypass is implemented or intended.
