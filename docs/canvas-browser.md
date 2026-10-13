# Canvas browser fallback

## Status — 2026-10-13

The owner reports that school policy blocks personal Canvas token creation. The existing API adapter cannot be configured through that path. Calendar feed/ICS import remains separate; institution-approved OAuth remains an alternative requiring administrator-issued credentials.

A live **read-only feasibility test** succeeded through the owner's normal authenticated Canvas browser session. This is not a built connector, durable import, scheduled sync or verified hosted-AI source.

## Completed proof

- After the T3 browser runtime restarted, the saved Default profile returned to the Canvas dashboard without another login. The dashboard exposed nine course links.
- One academic course was selected explicitly. DOM navigation reached its Assignments page without an API token, cookie export, hidden API requests or provider writes.
- The list loaded dynamically after the document's initial load. An immediate empty DOM result was not treated as an empty course. Later repeated reads consistently found 27 unique assignment links/titles, 10 exact machine-readable due timestamps and 17 records without dates. All ten timestamps parsed; no due label lacked its timestamp, and no loading indicator remained in the inspected list.
- Projection selectors were `#content a.ig-title`, `li.assignment` and `.assignment-date-due [datetime]`. Canonical same-origin assignment paths identified the records. Actual private titles, IDs, grades, dates and page contents are not included in this receipt or fixtures.
- Native T3 snapshot still timed out on a fresh public page after restart. The bounded DOM-read/navigation route remained usable. Snapshot/native-click recovery is a separate tool issue; it is not proof of an account/API-access failure.

The test did not import anything into the hub, compare with a live calendar feed, verify all courses/terms or enable AI. There was no attachment download, screenshot or paid model call. Authentication secrets were not read or exported. The original page inspection revealed that assignment lists can also contain scores; a future collector must project selected fields locally rather than capture full-page text.

## Proposed connector — not implemented

1. Run a read-only collector in a dedicated, owner-selected local browser profile. Normal login/MFA stays interactive. Session expiry surfaces **Sign in required** and pauses work. T3's saved profile is proof of feasibility, not yet a supported connector runtime.
2. Collect only course/assignment metadata: verified source path, displayed title, exact `datetime` or null, capture time and explicit completeness/readiness state. Reject foreign origins and unsupported link kinds. Quiz IDs and assignment IDs must not be conflated. Missing dates stay null; no year/timezone inference from display text.
3. Bound traversal and wait for a stable loaded view. Handle filtered, collapsed, paginated, unavailable and partially loaded lists explicitly. An incomplete snapshot must not mark unseen records missing. Full school-account coverage remains unverified.
4. Add owned, versioned/idempotent ingestion with distinct browser provenance, durable receipts and preserved annotations/labels. Reimports must deduplicate and never overwrite planner edits or resurrect tombstones. Keep browser facts distinct from API/feed facts until the owner confirms reconciliation.
5. Require explicit local class links and owner-applied source/item labels. Browser capture does not automatically establish approved AI provenance. Future AI retrieval must independently enforce verified origin, inherited labels, provider routing, text-only boundaries, consent and budget. Attachments, attachment-derived text and screenshots remain excluded.

Grades, submissions, assignment descriptions, provider writes and autonomous actions are outside the initial proposal. No browser-sync endpoint, secure connector enrollment, scheduler, completeness check or UI status control exists yet. These need implementation and synthetic contract tests before claiming a supported connection.
