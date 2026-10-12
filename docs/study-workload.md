# Study workload source history

Implemented backend; UI integration is pending. Migration 027 appends owned workload contexts, source snapshots and Calendar block links. It does not reconstruct older source history or enable AI/provider execution.

## Capture and lifecycle

New drafts capture every eligible open academic-work input to the ranking context, including classes that receive no proposed blocks. A known empty workload is recorded explicitly. Draft creation and deliberate revision atomically save the preview and replace its workload snapshot; exact retry receipts neither recapture nor duplicate sources. Approved, cancelled and hidden snapshots are retained. There is no full draft revision timeline.

Snapshots contain work ID/version, class ID/version/label, date-only deadline, nullable full effort estimate, priority, status, effective sensitivity and the complete captured label array. The origin is `owner-entered-planning-fields`. Titles, notes, scores and attachment text are not read or copied. This records the fields that influenced class ranking, not a specific assignment allocated to a block or proof that a deadline can be met.

Approval validates the current preview context and captured source count/revision, then atomically creates Calendar blocks and links them to the plan's context. A partial failure rolls back all blocks/links. All blocks share the same normalized source set; sources are not duplicated for each block. A missing workload context on a draft with eligible work blocks with `STUDY_WORKLOAD_UNCAPTURED`. Incomplete context/counts block with `PROVENANCE_UNAVAILABLE`. Reload a preview and deliberately revise; no automatic backfill occurs. Existing stale-context checks still apply first.

Source changes never rewrite deadlines, notes, titles, completion state or times on an existing Calendar block. Later owner-applied work/class labels propagate through source links, including blocks in another class, deleted blocks and blocks detached from their original class/topic. Effective sensitivity retains stronger captured labels; masked new labels also advance block versions. Unknown `academicLabels: null` stays unknown. Reapplying an already captured work label does not advance derived block versions. Cancel/hide, source deletion/restoration and class archival retain references and facts. Source relabeling can cause plan cancellation to preserve affected blocks at their later versions.

## Inspection contracts

All reads require owner authorization and use a consistent read-only snapshot. Shared schemas are in `packages/contracts/src/study-workload.ts`.

- GET `/api/v1/study/plans/:id/workload` also permits owned hidden plans.
- GET `/api/v1/calendar/:id/workload` also permits owned event tombstones. Links survive ordinary edits, detachment, cancellation and deletion/restoration.
- Both accept `limit` 1-200 (default 50), owned `after` work ID and optional positive `expectedPlanVersion`. Sources sort by work UUID ascending. `nextAfter` is null on the last page. A foreign/unknown cursor or one removed by draft revision returns 404. A changed expected plan version returns `VERSION_CONFLICT`; reset paging and retain the owner draft.

`studyWorkloadResponseSchema` includes plan ID/version/status/hidden state; optional event ID/version/deleted timestamp; context revision/capture time/total source count; and paged `sources` with `snapshot`, `current`, and `changed`.

`history` distinguishes `captured`, `unavailable` (legacy plan history), and `not-linked` (event without a durable context link). `captured` with source count zero is a known empty workload; unavailable/null is not zero. Absence of a link does not prove an older block was never influenced by workload. Current facts include all work statuses, deletion timestamp and class archival. `changed` means the work or class version changed, including changes to fields not copied into snapshots; it does not claim a particular planning field changed. Each page has consistent current facts, but multiple requests are not a frozen current-source snapshot. Include the returned plan version on subsequent pages and guard delayed responses.

UI should label this view "Plan workload inputs" or "Workload history", distinguishing captured facts from current ones. Use the work ID with the owned academic-work detail route for editable record details. Keep missing/zero estimates, changed source versions, deleted/archived sources, unavailable history, pending/offline/error states and current event versions explicit. No source mutation or detached-link removal endpoint exists.

## Export, AI and limits

Planner format-v1 export adds `studyWorkloadContexts`, `studyWorkloadSources`, and `studyEventContexts`, including hidden plans and deleted block references. Older exports default these arrays to empty. Existing per-array 10000-record and 16 MiB file limits block oversized downloads rather than truncate them. Owner-scoped composite foreign keys preserve source ownership and prevent orphaned/cross-owner links. Permanent purge/import policies remain pending.

Capturing planning fields does not verify the origin of source text or approve hosted AI input. Workload-derived blocks still have `academicLabels: null` and the preview still warns `ACADEMIC_WORK_PROVENANCE_INCOMPLETE`; the gateway rejects their event context with `PROVENANCE_UNAVAILABLE`. Neither workload inspection nor academic-work references are added to AI's context allowlist. Future source-content provenance must be verified before changing this restriction. Live dispatch remains disabled.

All new operations are online-only, outside response caching and the task outbox. Per-plan capture is bounded to 5000 eligible sources, and plans retain the existing 200-slot limit. Explicit [manual academic task/study creation](academic-planning.md) is implemented separately from plan workload history. Offline history, automatic per-assignment allocation, richer optimization, provider writes/conflict checks and UI controls remain pending.

## Validation

Final `npm run check` passed lint, strict types, formatting, builds and 197 API/client tests; one optional PostgreSQL test was skipped because its isolated URL is unset. All 43 isolated browser tests passed with migration 027. Ten additional study tests cover metadata-only capture, known empty versus unknown history, owner isolation, paging/version guards, cross-owner foreign keys, deliberate revision, source lifecycle, cross-class label propagation, atomic approval rollback/retry and populated migration upgrade. Restart coverage verifies retained sources and links. Standard PostgreSQL coverage is added but unverified locally. Tests used synthetic isolated databases; no real providers, paid AI, owner database resets or device tests occurred.
