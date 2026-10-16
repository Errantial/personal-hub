# Manual academic AI context

Implemented 2026-10-12. The verified text gateway accepts explicitly selected manual academic work and its directly linked task/study records. Public dispatch remains disabled. These references add no inference, planner actions, automatic retrieval or provider access.

## Work references and projection

`kind=academic-work` requires `id`, `expectedVersion` and `expectedCourseVersion`. The class version is required only for this kind. Both records must belong to the owner and be active; an archived class or deleted work is unavailable. Submitted/cancelled work remains inspectable when its class is active.

The text projection contains only title, kind, notes, date-only deadline, estimated minutes, priority and recorded status. It excludes scores, class/instructor text, provider records and attachments. This is owner-entered manual text, not verified Canvas submission or performance. The safe manifest adds `academicCourse={id,version}`. Owner labels and retained work/class label history constrain the full provider intersection; unavailable approved destinations never fall back.

## Direct planner origins

Tasks and one-time study blocks created through the academic planning endpoint may now supply their own allowlisted planner text. The gateway checks the owned immutable origin, complete captured planning fields, captured/current source identities, versions and all inherited labels. It does not project the source work's text or grades. Manifest `academicPlanning` retains safe link/source/class metadata; source or class changes invalidate the private binding even when the planner version stays unchanged. Deleted work and archived original classes block context, including after a study block detaches from its class.

Migration 045 prevents deletion or rewriting of direct origin identity, snapshot and capture time, and prevents removal of applied labels. Existing rows and receipts are preserved. Direct study creation preserves complete class/topic label history. Incomplete legacy history and workload-plan blocks remain blocked; direct origin verification does not certify the separate workload-plan path.

## Lifecycle and compatibility

Preflight, request admission and the final synthetic callback recheck share the existing snapshot, exact-context, routing, consent and budget gates. Stale references fail before a hold. Changes after committed admission prevent the callback and retain uncertainty. Guidance may refer to the admitted academic source, but grants no action authority. Per-request answer saving and content-clearing forget tombstones remain unchanged.

New metadata is omitted from ordinary/older manifests, preserving their serialized integrity bindings. Public history/export remain metadata-only; saved answer text remains confined to dedicated reads/export with explicit consent. UI source selection, offline references, workload-plan provenance and live execution remain pending.

## Verification

Synthetic checks cover strict references/manifests, bounded projections, score exclusion, inherited-label intersections, ownership, stale/deleted/archived ancestors, text damage, final revalidation, saved guidance/forget, direct planner detachment, immutable SQL captures, populated upgrade, oversize envelopes and persisted restart. Standard PostgreSQL coverage is added but requires the disposable `TEST_DATABASE_URL`; a skipped check is not verification of that driver. Tests do not access the owner's database or call providers.

All 41 context tests pass, including 18 new academic tests and seven new transient-review tests. The full API/client run passed 487 tests with one optional PostgreSQL skip; refreshed lint/types/formatting and production builds passed after excluding a generated browser snapshot from project formatting. Twelve additional Calendar-management tests passed separately. Browser verification retains three reproducible narrow Canvas overflow failures after a fresh isolated rerun, documented in the UI ledger. No native inference, paid AI or device test was used.

## Live owner asks (P7)

Implemented 2026-10-15 on `ai/academic-context` (development, not deployed). A live owner ask may now carry explicit, version-pinned manual academic work, separate from the disabled gateway path above. `POST /api/v1/assistant/requests` accepts an optional `academic` array of `{ id, expectedVersion, expectedCourseVersion }` (up to 20, unique ids); the class version is required for every entry. Selection is per work item only — there is no class-level "all open work" mode.

The prepare snapshot resolves each selection from `academic_work` joined to its active `courses` row and sends only an allowlisted projection: title, kind, date-only due date, estimated minutes, status and priority, with positional `w1…` refs. Notes, grades, class/instructor text, provider data and attachments never leave the server. A missing deadline or effort stays `null`, never zero or "none". The operation hash includes `academic` only when non-empty, so a device that omits an empty selection still replays an earlier no-academic operation.

Identity and version problems block the ask before any hold: missing, foreign or deleted work returns `404 NOT_FOUND`; a stale work or class version returns `409 VERSION_CONFLICT` ("Reload academic context."); an archived class returns `409 ACADEMIC_CLASS_ARCHIVED`. No request or reservation row is written in those cases. Labels are the deduped union of the work's retained `academic_labels`, the work sensitivity and the class sensitivity. A selection whose labels the destination may not receive is withheld and counted on the request (Restricted never sends; Personal only while **Allow Personal mail** is on) rather than failing the ask.

Each sent item is recorded in the sealed manifest as an `academic-work-v1` / `kind=academic-work` source carrying its labels and `academicCourse={id,version}`, bound by a private digest. The final transmission guard re-projects every bound academic source and withholds the send as `context-changed` (no charge, hold released) if the work or class was edited, deleted, relabelled or changed between prepare and transmit, matching the planner and mail guards. History eligibility re-verifies bound academic sources, so a follow-up keeps an unchanged academic turn and drops a changed one. Applied proposals inherit the academic labels and `bound-derived` origin through the existing lineage. Sent summaries are persisted on the turn (`ai_conversation_turns.academic`, migration 063) and survive conversation deletion; agent runs never carry academic sources.

The composer picker and withheld-item coverage UI are the next slice; grounded academic proposals (P8) follow later. Validation is recorded in [implementation-log.md](implementation-log.md).
