# Grounded study suggestions

Implemented in development (P8 part 2); deployment and owner acceptance are separate. An owner ask with explicitly selected open manual academic work can suggest one positive date range of at most 14 days. The provider returns only dates and admitted `w` references. The server resolves work/class versions and titles, assigns the suggestion ID, and drops forged references, closed work, duplicate references or extra fields such as slots/approval. Ordinary task/event proposals and legacy turn reads remain compatible. Scheduled agents receive no new academic scope or automatic study authority.

## Review and approval

The answer shows its selected sources and **Review study plan**. That link opens the existing Study plan screen with the suggested range fixed. The owner deliberately previews, saves a draft, reviews/trims it and approves it using the existing operations. No model-supplied slot, context revision or approval is accepted. The deterministic preview still uses the owner's goals, availability and complete local planning context; selection grounds the suggestion, not an exclusive class filter for the local planner. No new schedule optimizer is added.

External calendars remain unchecked. Missing deadlines/effort remain unknown; zero effort remains zero. Task/assignment deadlines stay distinct from reserved study time. Reservation, cancellation and block completion do not change assignment submission, estimated effort or mastery. Existing pending/error/conflict states remain visible. An unavailable or changed source requires a new reviewed answer, not a silent rebase.

## Backend contracts

- Completed turns add optional `studySuggestions`: at most one `{id,from,to,sources}`; sources contain server-resolved work/class versions and titles. Legacy turns return an empty array. Conversation deletion clears suggestions with the other answer text.
- `GET /api/v1/assistant/turns/:id` reads an owned visible turn using a fresh authenticated read-only snapshot.
- `POST /api/v1/study/preview` and `POST /api/v1/study/plans` accept an optional `assistant: {turnId,suggestionId}` in addition to their existing inputs. A supplied reference must match the exact saved range and digest and the currently eligible academic sources/destination. These operations send no provider requests.
- Migration 067 stores a new suggestion column and owned draft-to-answer origin records. Draft origin and operation receipt commit atomically under the existing owner schedule lock. Exact receipt retries preserve the historical result. New draft/edit/approve writes and receipt reads recheck the session.
- Linked draft edit and approval revalidate the saved origin, source/class versions, open/available status, complete source eligibility and approved-destination label floor. Approval also uses the existing context revision, capacity, conflicts, future-time and empty-plan checks. A changed deterministic context requires deliberate preview/revision; a changed admitted source cannot be rebased into the old answer.
- Every resulting block retains conservative answer labels, deterministic contributing source labels, AI origin and workload links. Source-derived study blocks remain inference-ineligible; this does not certify workload-plan provenance. Tombstones/restoration and later owner edits preserve the existing lineage floor.

Mail-dependent suggestions remain readable only and offer no review link; their origin cannot create or approve a study draft. Pause, agent actions, mail grants, routing, budgets, memory and external calendars gain no new authority. Cancellation/hiding remains available when an origin becomes unavailable, and cancellation preserves later edited/completed/deleted blocks through the existing behavior.

## Validation boundaries

API tests use synthetic sources and fake provider replies. Browser tests use a documented test-only origin adapter with the real deterministic study operations; the API tests separately exercise the real saved-answer/draft origin boundary. Narrow/e-ink and scoped accessibility checks are browser evidence, not Kompakt hardware evidence. No actual provider call, paid evaluation, production migration/deployment or owner database reset is part of routine validation.
