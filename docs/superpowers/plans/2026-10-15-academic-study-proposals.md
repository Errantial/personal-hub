# P8 part 2: deterministic study proposals

Status: implemented in development with validation in progress; see [contracts and limitations](../../ai-study-suggestions.md). P8 part 1 supplies source-linked tasks. The following design records P8 part 2's behavior; deployment and owner acceptance remain pending.

## Intended behavior

An owner ask can suggest a bounded study-planning date range grounded in explicitly selected open manual work. The model does not generate calendar slots. The owner opens the existing study-plan screen, reviews a fresh deterministic preview, saves a draft and approves it through the existing operations. Task/assignment deadlines remain distinct from reserved study intervals. Submitted/cancelled work stays closed; unknown effort/deadlines remain visible.

## Implementation sequence

1. Add a distinct study-planning suggestion contract carrying only a validated range and server-resolved academic references. Do not reuse generic event.create or accept provider-supplied record IDs, context revisions, slots or approvals. Preserve the ordinary task/event contracts and legacy turn reads.
2. Revalidate the saved suggestion digest, owner, selected work/class versions, open status, source eligibility and destination-label floor before creating a draft. Use the existing schedule lock and deterministic preview/draft operations. Preview results stay local; they are not added to provider messages or admitted as inference context.
3. Persist the draft-to-answer origin and idempotency receipt atomically. Approval must revalidate that origin as well as the ordinary study context revision, availability, goals, conflicts and capacity. Retain the answer's conservative labels alongside every deterministic contributing source label. Add an append-only migration only after defining the durable draft/origin relationship; never infer lineage for older drafts.
4. Reuse the existing study-plan screen for warnings, trimming, fresh revision, approval and cancellation. Any source/context change requires deliberate review; never silently rebase. Cancellation preserves later edited/completed/deleted blocks using the existing operation. Preserve lineage and academic links on tombstones and restoration.
5. Keep workload-plan provenance blocked for inference. Creating a study proposal must not certify old workload history or import Canvas facts. External calendar coverage remains unchecked and its warning stays visible.

## Required evidence

Synthetic tests must cover stale work/class, closed/deleted/archived sources, relabeling, forged range/source/slot/approval input, source change after draft but before approval, full/zero capacity, changed planner conflicts, DST, duplicate/lost-response/restart receipts, atomic rollback, inherited labels, cancellation with later owner edits and unknown-versus-zero effort. Test that previews are never sent back to a provider and that generated workload blocks remain inference-ineligible. Browser checks must prove the existing study editor/approval/cancellation flow is reused, with visible incomplete/external-calendar warnings and accessible narrow-screen review. No real providers, owner database or device claims belong in routine validation.
