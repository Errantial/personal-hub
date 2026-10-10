# Canvas feed/API reconciliation

Connections includes Canvas reconciliation. It proposes comparisons only when a retained feed entry's safe assignment URL exactly equals the URL constructed from an imported API course and assignment ID. Titles and dates alone are never identity evidence. Confirmation is an explicit owner action; no automatic merge, deadline propagation, planner creation or provider write occurs.

## Links and differences

Compare sources shows each title and deadline independently. Missing API deadlines remain unknown. Date-only feed entries are compared as dates rather than guessed instants. A difference does not decide which source is correct; review the actual school account before relying on coverage. Existing source notes, labels and local class links remain separate.

Each feed entry can have one active assignment link; several feed entries can link to the same assignment. Missing/cancelled sources cannot create new links. A successful refresh can change or omit a source without deleting the link. An assignment URL change displays a review warning; this never silently moves the association to a different assignment. Remove link works for changed/missing sources. Relinking requires current available matching identities.

Confirm/remove operations require the link's optimistic version (null only for a new row) and the current feed version. Confirmation additionally requires current assignment and API-course versions. Conflicts retain the selected assignment; Reload link versions refreshes versions deliberately. Unchanged retries use the same operation ID, including when the first response is lost. Exact retries return the original receipt. Links have stable IDs and deletion tombstones; source refreshes never resurrect them.

## Labels and provenance

Active links share the strongest owner-applied source, record and local-class label from both adapters, including archived local classes. Missing provider records still retain those labels. No new label is guessed or written to either source. Source views, planner current metadata and export apply the same effective-label calculation.

Migration 012 additionally preserves complete applied label arrays on source views and newly captured planner snapshots. Current arrays follow active associations; captured arrays remain after unlinking or label changes. The AI routing preview intersects every captured/current label's permissions, rather than using only the strongest display label. Personal and Restricted can have different approved destinations. Older snapshots without complete arrays block routing instead of guessing historical ancestors.

An API assignment associated with any uploaded-calendar-file entry is marked attachment-derived. Assignment-based planner creation captures this flag and the effective label, so later unlinking cannot remove the captured file provenance or sensitivity. Existing planner records also expose current provenance. `plannerTextIsAttachmentDerived` evaluates captured/current flags in addition to calendar-file input kinds. Future AI must exclude direct assignment records marked attachment-derived and evaluate all current/captured labels through the routing gateway. No model dispatch is enabled.

Association changes increment affected feed/assignment versions to invalidate stale planning drafts, without changing the owner's task/event fields or versions. Planner edits, task offline replay and tombstones remain intact. Removing an association relaxes current shared context only; it does not rewrite captured planner snapshots.

## Storage and API

Migration 010 adds owned reconciliation foreign keys, stable rows/tombstones and label/provenance views without modifying applied migrations. Cross-adapter association/planner capture locks the feed source before the API source. Read-only comparison/export uses consistent snapshots. Limits reject oversized retained lists instead of truncating them.

- `GET /api/v1/connections/canvas/reconciliation`: owned feed records, API courses/assignments and links, including tombstones.
- `PUT /api/v1/connections/canvas/reconciliation/:itemId`: versioned/idempotent confirmation or removal. Set assignmentId and assignment/course versions to null when removing.
- Planner format-v1 export adds `canvasReconciliations`, defaulting to an empty array for older exports; operational credentials/jobs are excluded.

Planner work expands on feed/API planning controls and API class portfolios. `GET /api/v1/connections/canvas/planner-work?kind=calendar|assignment-api&itemId=...` requires an owned retained source and reads a consistent snapshot of active tasks/studies from that source and all active confirmed associations. Up to 2,000 associated sources and 1,000 records per work collection are supported; excess fails visibly instead of truncating. Completed tasks remain listed; tombstones do not. Unlinking changes which sources are grouped, without changing their planner records. Previously loaded lists can be viewed from the owner-scoped offline cache. Successful Canvas task/study creation refreshes open lists. Edits use Today/Calendar.

Routine tests use synthetic transport/records and isolated databases. Live school identity/coverage remains unverified. Reconciliation does not deduplicate already-created planner items, suppress feed agenda entries, import grades/submissions or change source class links. Planner completion never implies Canvas submission or mastery.
