# Tracked Canvas deadlines, task due-times, calendar decluttering, agent awareness and optional Jev — orchestrated implementation plan

> **Owner direction update — 2026-10-20:** For Jev, remove the earlier account-verification/credential-revision/synthetic-quality activation ceremony. Jev runtime is API-key based. Keep the exact pinned model/endpoint, selector, independent provider consent, routing, budgets, grants, no fallback, no resend and cross-adapter receipt isolation. Any older Jev checklist item below that requires `TYPESAFE_VERIFICATION`, credential/account revision, account-specific attestation, or a synthetic-quality pass as a prerequisite to sending is superseded by this update.

## Goal

Ship five related improvements without weakening the current provenance, routing, billing or agent-safety boundaries:

1. **Tracked imported deadlines.** Canvas assignment/quiz deadlines become first-class local records with completion tracking and owner edits instead of remaining read-only calendar decorations.
2. **Optional task due-times.** Owner-created tasks keep their existing optional date-only deadline, but may additionally carry a specific local time with an explicit timezone so a task can mean “due at 5:00 PM” rather than only “due that day.”
3. **Calendar deadline rendering and all-day decluttering.** A Canvas deadline with an actual due time appears at that time in Day/Week rather than consuming the all-day strip, and the remaining all-day strip stays compact/readable even on busy school weeks.
4. **Deadline-watch awareness.** The scheduled `deadline-watch` agent can automatically see eligible tracked Canvas deadlines and make planning proposals from them, while preserving source labels/provenance, Ask-first behavior and the existing no-memory/no-provider-write boundaries.
5. **Optional Jev mail filtering.** Incorporate the existing [optional Jev mail-broker plan](2026-10-19-jev-mail-broker-option.md) as a parallel, independently gated mail-classifier workstream. OpenRouter/Gemini remains the default.

This document is the **orchestrator plan**. It is intentionally organized into dependency waves and worker ownership so an orchestrator can use subagents concurrently without migration-number collisions or repeated broad test runs.

## User feedback being addressed

- The accelerated `deadline-watch` acceptance runs were useful for ordinary owner-created tasks.
- The agent did not appear aware of Canvas-imported assignment deadlines.
- Canvas assignments currently appear in Calendar but do not automatically gain local completion tracking or editable planning metadata.
- Owner-created tasks currently support only a date-only `dueDate`; there is no way to record a specific due time such as 5:00 PM.
- Timed Canvas deadlines are currently shown in the all-day strip even when Canvas supplied a concrete due timestamp.
- The all-day strip can become crowded enough to obscure existing items and make creating new timed events awkward.
- An existing plan proposes making Jev an optional mail relevance classifier while retaining the current OpenRouter/Gemini classifier as default.

## Current architecture findings

### Why imported Canvas deadlines are not tracked

- `canvas_items` (feed/file), `canvas_lms_assignments` (API) and Canvas browser items are retained **source records**, not planner tasks or academic-work rows.
- Existing source-linked planning is deliberate: the owner can create a task or study block from a Canvas source, but imports do not automatically create planner records.
- Manual `academic_work` is owner-entered and date-only. It is intentionally separate from imported Canvas assignments and therefore is not a safe drop-in representation for timed provider deadlines.
- Existing reconciliation uses exact canonical Canvas URLs and never title/date guessing. That exact-identity rule should be reused to deduplicate tracked deadlines.

### Why timed Canvas deadlines crowd the all-day strip

- `apps/web/src/lib/calendar-grid.ts::allDayStrip()` deliberately adds **all Canvas deadlines** to the strip.
- A timed Canvas item carries its timestamp in `StripItem.time`, but it still renders in the strip; `TimeGrid` only lays out planner `Occurrence` records in the hour grid.
- Therefore a 11:59 PM Canvas due time is labeled with a time but still consumes all-day-strip height instead of appearing at 11:59 PM.

### Why `deadline-watch` misses Canvas deadlines

- Agent execution calls `answerTurn(... trigger:'agent')` without academic or memory selections.
- `answerTurn` automatically loads only `livePlannerContext`.
- `livePlannerContext` intentionally excludes tasks/events with `canvasSource`, `academicSource`, mail origin, non-owner origin, labels, class/topic links or uncertain lineage.
- Raw Canvas feed/API/browser records are never queried for scheduled-agent context.
- Manual academic context is explicit-selection-only and agent runs do not supply selections.
- This is a context-model limitation, not a scheduler failure.

### Why user-created tasks cannot have a due time

- `Task` contracts expose only nullable date-only `dueDate`; the database stores `tasks.due_date date`.
- Task create/update, offline replay, batch changes, agenda buckets, Today, Calendar chips and Assistant task projections all assume that date-only representation.
- Adding only an `<input type="time">` would lose meaning across devices/timezones and could not be guarded/replayed reliably.
- Therefore timed tasks need an additive persisted instant plus the timezone used to create/edit that wall-clock value, while retaining `dueDate` for backward-compatible date bucketing.

### Jev baseline

- The deployed broker remains `mail-broker` → `google/gemini-2.5-flash-lite` → `google-vertex`.
- Current broker workflow/grants/lineage/budgeting are provider-neutral in important places, but policy, protocol, execution and UI still contain OpenRouter-specific assumptions.
- The Jev plan uses an **independent selector and consent** while preserving routing, budgets, grants and no-resend/cross-adapter isolation. No separate account-verification object or quality gate is required for runtime activation.

---

## Cross-feature design decisions

### D1. Add a first-class tracked-deadline model; do not silently turn Canvas imports into ordinary tasks

Create a new owned `tracked_deadlines` domain. A tracked deadline is task-like in UX (open/completed, priority, owner notes, editable effective due time) but remains semantically distinct from a planner task:

- completing it means **“locally handled/complete”**, not “submitted in Canvas”;
- it does not write to Canvas;
- it preserves imported-source provenance even after owner edits;
- it can retain due-time precision that the current task model cannot;
- it can be projected to AI under a dedicated, narrower source policy instead of weakening the existing planner-context filter.

Do **not** change the meaning of existing `tasks.completed`, `academic_work.status` or `events.study_status` to absorb imported assignments.

### D2. Deduplicate only by exact Canvas identity

Every eligible Canvas assignment/quiz source derives a canonical identity key from its canonical Canvas URL/path or native provider course+assignment identity. Never merge by title, course name, date or fuzzy similarity.

Recommended canonical form:

`canvas:<school-host>:<assignment-or-quiz-canonical-path>`

The existing reconciliation URL normalization/validation should be factored and reused so feed/API/browser sources agree on the same key. Sources without a safe assignment/quiz identity remain ordinary read-only calendar items and are **not** auto-promoted to tracked deadlines.

### D3. Keep provider facts and owner overrides separate

`tracked_deadlines` should store local state/overrides; `tracked_deadline_sources` binds one or more exact provider sources. Effective display fields are resolved from current provider facts plus owner overrides.

Local owner state should include at least:

- `completed_at` nullable timestamp (open when null);
- `priority` (`low|normal|high`, default `normal`);
- `notes`;
- nullable `title_override`;
- due override mode + value, sufficient to express `provider`, owner-set timed due, owner-set date-only due, or explicitly unknown;
- optimistic `version`, timestamps and tombstone/ignore state if product UX needs “hide without complete”.

Do not overwrite owner overrides on a Canvas refresh. Provider refreshes update the provider-side facts only.

### D4. Preserve source authority; make alternate timing an explicit owner choice

For one canonical deadline:

1. An owner due override wins.
2. Otherwise, the tracked deadline keeps a stable **primary source** and uses that source's current timing as its effective provider timing.
3. Exact-reconciled API/browser/feed sources may expose a more precise or different due value as an alternate fact, but they do not silently replace the primary source's value.
4. When an alternate exact source supplies a same-date timestamp where the primary source is date-only, show an explicit **Use timed Canvas value** action. Accepting it writes a versioned owner due override (or an explicitly reviewed primary-source switch if that mechanism is implemented).
5. If sources disagree on date or timestamp, mark `sourceConflict` and require owner review.
6. Never pick a winner merely because one adapter is newer or richer.

The immediate Calendar fix does **not** depend on cross-source arbitration: timed feed entries already carry `startsAt`; Feature 3 moves those existing timed values from the all-day strip into the hour grid. This preserves the current reconciliation contract while fixing the reported UI defect.

### D5. Browser/file provenance stays more restricted than server-fetched network metadata

For hosted AI eligibility:

- `calendar-file` derived text remains blocked.
- browser-only captured text remains blocked until that collector receives an explicit AI-certification design; this plan does not add one.
- a tracked deadline may be AI-eligible only when the exact projected fields can be re-derived from a current approved **network Canvas feed/API source** (or from owner-entered overrides whose inherited label/provenance floor is still respected).
- if a deadline has only browser/file evidence, it can still be tracked/displayed/completed locally, but `deadline-watch` must count it as withheld rather than transmit it.

### D6. Give `deadline-watch` a dedicated read-only deadline projection instead of weakening `livePlannerContext`

Do not remove `!task.canvasSource` / `!event.canvasSource` from the existing planner-context eligibility rules.

Add a separate `deadlineContext` projection and manifest source kind used automatically only for the `deadline-watch` template in the first release. This keeps the authority expansion narrow and reviewable.

The model may use deadlines to propose ordinary planner tasks/events, but it cannot directly mark a tracked deadline complete or edit its imported metadata. Completion/editing remains owner UI/API authority.

### D7. New planner actions created from a tracked deadline retain durable lineage

If the model creates a task/event because of `dN` deadline context, the saved proposal must carry a server-owned `deadlineSource` reference and snapshot. Do not let the model or browser supply arbitrary source IDs.

This requires a second migration after the core deadline table so tasks/events can retain immutable tracked-deadline lineage, analogous to existing Canvas/academic source snapshots.

### D8. Timed deadlines belong in the hour grid; all-day congestion gets a bounded disclosure

- Timed tracked deadlines render as **point deadline markers** in Day/Week at their effective due timestamp.
- They do not consume all-day-strip rows.
- Date-only tracked deadlines remain in the all-day strip.
- Week/Day all-day cells show a bounded number of chips by default (recommended 3) plus an accessible `+N more` / `Show all` disclosure per day.
- Expansion must not cover or disable hour-grid “new event” hit targets.
- Month view keeps its existing compact-chip behavior but uses the new tracked deadline source instead of duplicate raw Canvas chips when a tracked deadline exists.

### D9. Jev remains independent of deadline work

The Jev selector/classifier work must not share migrations, configuration, grants or rollout gates with deadline tracking. It can develop concurrently after migration numbers are reserved.

### D10. Timed tasks extend task deadlines; they do not become calendar reservations

Keep `dueDate` as the existing nullable local planning date. Add optional timed-deadline metadata only when the owner chooses a time:

- `dueAt`: exact UTC instant, nullable;
- `dueTimeZone`: IANA timezone used to render/re-edit that due wall time, nullable;
- when `dueAt` is set, `dueDate` is also set to the corresponding local date in `dueTimeZone`;
- clearing the time keeps the date unless the owner also clears the date;
- clearing the date clears `dueAt`/`dueTimeZone` atomically;
- date-only tasks remain byte/behavior compatible and require no inferred midnight/noon instant;
- a timed task is still a **deadline point**, not reserved calendar duration and not an event.

The server validates the wall-clock conversion with the same Temporal/DST principles as Calendar: nonexistent local times are rejected and repeated local times require deterministic handling rather than silently selecting an offset. UI defaults the timezone to the current device/viewing timezone but stores it explicitly.

Timed task display should be additive:

- Tasks/Today show the local due time when present;
- Calendar Day/Week may render timed tasks as point deadline markers in the hour grid, while date-only tasks remain all-day deadline chips;
- agenda/browse “overdue/today/upcoming/later” classification remains date-based for compatibility, with within-day ordering by `dueAt` when present;
- reminders remain a separate explicit subsystem; adding a due time does not automatically schedule a reminder.

---

## Migration ownership and sequencing

To prevent concurrent workers from choosing the same migration number:

| Migration | Owner | Purpose |
| --- | --- | --- |
| `073_task_due_times.sql` | Timed-task worker | Add nullable exact due instant/timezone to tasks with consistency checks/index support; preserve existing `due_date` semantics |
| `074_tracked_deadlines.sql` | Deadline foundation worker | `tracked_deadlines`, exact source bindings, constraints/views/indexes; no AI or planner-action linkage yet |
| `075_tracked_deadline_planner_links.sql` | Agent/lineage worker | Task/event immutable tracked-deadline source references/snapshots and supporting provenance views |
| `076_mail_broker_settings.sql` | Jev broker worker | Versioned owner mail-classifier selector from the existing Jev plan |

Rules:

- No other worker creates a migration in this program.
- Applied migrations 001–072 remain byte-identical.
- `073` is independently additive to the existing tasks table.
- `074` is independently additive and must not depend on timed-task behavior.
- `075` may depend on `074`, never on timed-task or Jev state.
- `076` is independently additive to the broker tables and must not depend on task/deadline state.
- The Jev subplan is reconciled to use migration 076 rather than its earlier 073/074 draft numbers.

---

# Feature 1 — Automatically tracked, completable and editable Canvas deadlines

## Product behavior

When a Canvas assignment/quiz with a canonical identity appears through the feed, API or browser collector:

1. The server creates or updates exactly one tracked-deadline root for that canonical identity.
2. Import never marks it completed.
3. Refreshes update provider facts but never erase owner completion, notes, priority or overrides. Alternate reconciled timing remains reviewable rather than silently replacing the primary source.
4. Owner can:
   - mark complete/reopen;
   - edit displayed title;
   - edit effective due date/time (or mark it unknown);
   - set priority;
   - add local notes;
   - open the original Canvas source when a safe link exists.
5. Owner edits are local Personal Hub data only. The UI must explicitly say they do not modify Canvas.
6. A source later missing/cancelled remains retained with a visible source state; it is not auto-completed/deleted.
7. If the same exact assignment is observed by multiple Canvas adapters, the UI shows one deadline with source coverage/conflict details rather than duplicate actionable records.

## Data model — migration 074

Recommended tables:

### `tracked_deadlines`

- `id uuid primary key`
- `owner_id uuid` with owned FK
- `provider_kind text` initially `canvas`
- `canonical_key text`
- `version int > 0`
- `completed_at timestamptz null`
- `priority text check low|normal|high`
- `notes text`
- `title_override text null`
- `due_override_kind text check provider|timed|date|unknown`
- `due_at_override timestamptz null`
- `due_date_override date null`
- `due_time_zone text null` for owner-entered wall-time display/re-editing
- `sensitivity` + complete retained labels/label floor following existing owned-source conventions
- `created_at`, `updated_at`, optional `deleted_at` only if explicit hide/delete UX is implemented
- unique `(owner_id, provider_kind, canonical_key)`

Add SQL checks so override-kind/value combinations cannot become ambiguous.

### `tracked_deadline_sources`

Prefer explicit nullable owned foreign keys over an unconstrained polymorphic string ID:

- `deadline_id`, `owner_id`
- exactly one of `canvas_item_id`, `canvas_assignment_id`, `canvas_browser_item_id`
- `is_primary boolean not null default false`; enforce at most one active primary source per owned deadline (prefer a partial unique index where supported)
- captured source version / association timestamp as needed for receipt/debug metadata
- unique active binding per source record
- composite FK back to the owned deadline and owned source table

Source deletion/missing must not cascade-delete the tracked root. The resolver keeps the primary-source choice stable across refreshes; changing it is an explicit reviewed mutation, not a side effect of a richer alternate source arriving.

If database constraints make three nullable FKs too cumbersome, separate association tables per adapter are preferable to a weak `(kind,id)` reference.

## Resolver/foundation code

Create a server-only module such as:

- `apps/api/src/connections/canvas-deadlines.ts`

Responsibilities:

- canonical identity derivation/reuse from reconciliation helpers;
- source-to-deadline upsert under deterministic locks;
- source-fact projection;
- effective deadline resolution and `sourceConflict` calculation;
- effective sensitivity/complete labels;
- source availability summary;
- no network calls of its own.

Call it from the transaction that commits successful feed/API/browser source snapshots so deadline tracking is atomic with imported source state. A failed/partial source refresh must not create a “complete” deadline observation from data that was not committed.

## Contracts and API

Create `packages/contracts/src/tracked-deadlines.ts` and export it.

Suggested endpoints:

- `GET /api/v1/deadlines?status=open|completed|all&from=&to=&limit=&after=`
- `GET /api/v1/deadlines/:id`
- `PUT /api/v1/deadlines/:id` full editable local state + `expectedVersion` + `operationId`
- `POST /api/v1/deadlines/:id/complete`
- `POST /api/v1/deadlines/:id/reopen`

Use existing optimistic-version/idempotent mutation helpers. Exact lost-response retry returns the original receipt; changed payload under an operation ID conflicts.

The response should expose:

- effective title and due (`timed|date|unknown`);
- current owner override state;
- completion/priority/notes/version;
- safe source URL, source availability and source coverage;
- `sourceConflict` with bounded source-kind/date/time metadata, not private raw payloads;
- effective sensitivity/labels;
- `aiEligible` / `aiWithheldReason` only if helpful for diagnostics, never as authorization supplied by the client.

## UI

Primary discoverability:

- Add an **Imported deadlines** section to `TasksView` above or beside ordinary tasks, with open/completed filter and completion control.
- Clicking a deadline from Calendar/Today/Tasks opens a `DeadlineEditor` rather than navigating directly to Canvas.
- Keep a separate `Open in Canvas` link inside the editor.
- Editor copy must distinguish “Personal Hub due override” from “Canvas source due”.
- When provider facts change under an owner override, show both and offer explicit “Use Canvas value” rather than silently clearing the override.

Likely files:

- `apps/web/src/components/TasksView.tsx` / `.css`
- new `apps/web/src/components/DeadlineEditor.tsx`
- new `apps/web/src/components/DeadlineList.tsx` if separation helps ownership
- `apps/web/src/components/TodayView.tsx`
- `apps/web/src/lib/api.ts` cache/offline allowlist decisions
- router types only if a dedicated deadline route/editor state is required

First release may keep writes online-only. Do not automatically put deadline mutations into the existing offline outbox unless a separate worker proves ordering/conflict semantics. Cached previously loaded deadline reads are acceptable if they obey owner/session separation and visibly show offline state.

## Tests

API/unit:

- exact identity dedupe across feed/API/browser;
- no title/date fuzzy merge;
- source refresh preserves completion/owner overrides;
- primary-source timing refresh plus explicit owner adoption of an alternate same-date timed source;
- conflict on disagreeing timed/date sources;
- missing/cancelled source retention;
- owner isolation/session authorization;
- exact mutation retry + changed-operation conflict;
- label strengthening through source/class/reconciliation changes;
- calendar-file/browser-only AI ineligibility retained;
- populated upgrade through migration 074;
- export includes safe tracked-deadline state and source references, excluding operational/browser session data.

Browser:

- imported deadline appears automatically without manual “Create task”;
- complete/reopen;
- edit title/due/priority/notes and reload;
- source refresh does not clobber override;
- conflict presentation + “Use Canvas value”;
- standard + 320px e-ink accessibility/overflow/target checks.

## Commit slices

1. `feat(deadlines): add tracked Canvas deadline model`
2. `feat(deadlines): add owner tracking and editing UI`

---

# Feature 2 — Optional specific due time for owner-created tasks

## Product behavior

Ordinary owner-created tasks keep the existing optional due date and gain an optional specific due time:

1. A task may have no deadline, a date-only deadline, or a timed deadline.
2. Adding a time requires a due date; the UI asks for the local time and timezone together.
3. The saved record exposes the existing `dueDate` plus nullable `dueAt` and `dueTimeZone`.
4. Clearing only the time returns the task to date-only without changing the date.
5. Clearing the date clears all timed metadata atomically.
6. A timed task is still a task deadline, not a Calendar reservation and not an automatic reminder.
7. Existing tasks migrate with `dueAt=null` and `dueTimeZone=null`; their behavior is unchanged.

## Data model — migration 073

Add nullable columns to `tasks`:

- `due_at timestamptz null`
- `due_time_zone text null`

Keep `due_date date null` as the compatibility/bucketing field. Add SQL/application checks so:

- `due_at` and `due_time_zone` are both null or both non-null;
- timed tasks always have `due_date`;
- server write paths derive/check that the wall date of `due_at` in `due_time_zone` equals `due_date`;
- tombstones, restore, offline replay and mutation receipts preserve the fields exactly.

Do not backfill a guessed time for existing date-only tasks.

## Contracts and API

Modify `packages/contracts/src/core.ts` task schemas and all task projections to add:

- `dueAt: datetime|null`;
- `dueTimeZone: IANA zone|null`.

Task create/update accepts either the existing date-only form or a timed pair. Prefer accepting owner wall-clock input at the browser boundary and converting to the exact instant before persistence using shared Temporal helpers; if API contracts accept wall time directly, bind date/time/timezone together in one strict object so clients cannot send contradictory fields.

Backward-compatible update semantics are mandatory because an older browser/offline outbox may send a full task update without knowing the new fields:

- omitted `dueAt`/`dueTimeZone` + unchanged `dueDate` preserves the existing timed metadata;
- changing or clearing `dueDate` while omitting replacement timed metadata clears the old `dueAt`/`dueTimeZone` so the instant cannot drift onto another date;
- explicit `{ dueAt:null, dueTimeZone:null }` clears only the time while retaining the submitted date;
- completion/priority/notes/title-only changes preserve timed metadata;
- batch due-date changes clear existing timed metadata unless that batch contract is deliberately extended to carry a replacement time.

Update:

- `apps/api/src/planner/routes.ts` create/update/list columns and ordering;
- task-management/batch update contracts so a date change cannot leave stale timed metadata;
- task agenda/browse ordering to keep existing date buckets while sorting timed tasks within a date by instant;
- export/import/upgrade fixtures;
- offline task projection/replay/conflict state.

## UI

Add optional time + timezone to owner-created task entry/edit paths:

- `TasksView` editor;
- `QuickCapture` and command-bar capture;
- any dedicated create form that currently exposes `dueDate`;
- batch deadline changes may remain **date-only** in the first release unless an explicit “set date and time” batch UX is implemented and tested.

Recommended task editor UX:

- Due date (optional)
- Due time (optional)
- Timezone, shown only when time is set; defaults to current device timezone
- “Clear time” keeps the date

Today/Tasks display `Due 5:00 PM` when timed. Date-only tasks continue to display just the date.

## Calendar and AI integration

- Calendar Day/Week renders timed tasks as task deadline point markers at `dueAt`; date-only tasks remain in the all-day/task deadline strip.
- Month/Agenda may include the local due time in text without inventing duration.
- The first owner-facing release keeps the existing `planner-task-v1` AI projection date-only so timed-task storage can ship without changing live AI manifests/history eligibility.
- Assistant visibility/proposals for task due-times are a deliberately versioned follow-up (`planner-task-v2` or equivalent) only after structured-output, manifest/history, apply/undo and stale-client preservation tests pass. This follow-up must not relax any existing provenance/source filters and must not block Release B.

## Tests

API/unit:

- null/date-only/timed create and update;
- DST gap rejected; repeated local time handled deterministically according to the chosen contract;
- clear time keeps date; clear date clears time/timezone;
- exact idempotent retry and changed-operation conflict;
- offline queue/replay/conflict preserves timed fields;
- task batch date update clears or deliberately preserves time according to explicit server rule (recommended: date-only batch action clears timed metadata unless batch contract also supplies a time);
- stale/older-client full PUT that omits timed fields preserves an unchanged-date timed deadline rather than silently clearing it;
- export/upgrade/postgres populated migration;
- Today/agenda ordering and overdue boundaries remain correct.

Browser:

- create/edit timed task, reload and cross-timezone display;
- date-only task regression;
- clear-time and clear-date flows;
- timed task point marker does not block creating Calendar events;
- 320px/e-ink/a11y coverage.

## Commit slices

1. `feat(tasks): add optional timed deadlines`
2. `feat(web): edit and display task due times`
3. optional later `feat(ai): propose timed task deadlines` if kept out of the first deployable slice

---

# Feature 3 — Timed deadline placement and compact all-day layout

## Calendar data source change

Calendar should prefer tracked deadlines for assignment/quiz presentation. Raw Canvas items that already have a tracked-deadline canonical identity should not render a duplicate chip.

Retain raw Canvas rendering for non-deadline Canvas calendar entries and for unsupported/untracked source records.

## Hour-grid representation

Extend `calendar-grid.ts` with a deadline-specific point layout rather than coercing a deadline into a fake one-hour event.

Recommended type:

```ts
type DeadlineMarker = {
  key: string;
  title: string;
  minute: number;
  deadlineId: string;
  completed: boolean;
};
```

`layoutDeadlines()`:

- includes only effective `timed` deadlines on that local day;
- places the marker at the exact due minute;
- uses a minimum visual height (for example 18–24 px) without implying reserved duration;
- participates in overlap columns with timed events/deadlines so labels do not fully cover one another;
- has distinct accessible text such as `Deadline: …, due 11:59 PM`;
- completed markers may be visually de-emphasized or hidden by a source/filter toggle, but must remain reachable when “completed” is shown.

Do not represent point deadlines as planner `Occurrence`; keep the semantic distinction explicit.

Likely files:

- `apps/web/src/lib/calendar-grid.ts`
- `apps/web/src/components/TimeGrid.tsx`
- `apps/web/src/components/MonthGrid.tsx`
- `apps/web/src/components/CalendarView.tsx`
- `apps/web/src/components/CalendarView.css`
- `apps/web/src/components/TimeGrid.css`
- `apps/web/src/components/CalendarShell.tsx` source filters/legend if needed

## Compact all-day strip

For Day/Week:

- move timed deadlines out of the strip entirely;
- render all-day events, date-only deadlines and due tasks in deterministic groups;
- default to at most **3 visible chips per day**;
- render `+N more` / `Show all` as a real button with `aria-expanded` and a per-day controlled region;
- expansion affects only that day's strip; collapse restores bounded height;
- source filters apply before the count so `+N more` is truthful;
- preserve keyboard navigation and 44px/target-size rules;
- no absolute overlay may cover the hour-grid new-event slots.

Month view can retain its existing compact maximum, but source ordering should become:

1. date-only tracked deadlines/tasks that are actionable today;
2. all-day planner/study events;
3. remaining items by stable title/time order.

Do not imply that a due-time marker reserves calendar time.

## Agenda behavior

Agenda rows should display the tracked deadline effective due time/date and completion state. A tracked deadline row opens the local editor; its source link remains secondary.

## Tests

- timed deadline never appears in all-day strip;
- 11:59 PM deadline lands in the correct timezone/day and hour position;
- DST boundary cases use the viewing timezone and do not invent nonexistent wall times;
- date-only deadline stays in strip;
- exact three-chip bound plus correct `+N more` count;
- expanding one day does not expand others;
- source filters recompute count;
- all-day congestion does not obscure/capture clicks intended for hour-grid slots;
- overlap with events/deadlines remains readable;
- month/agenda do not duplicate raw Canvas + tracked deadline;
- axe/keyboard/320px/e-ink tests.

Suggested commit: `feat(calendar): place tracked deadlines at due time`

---

# Feature 4 — Make `deadline-watch` safely aware of tracked deadlines

## Context contract

Add a new projection, for example `tracked-deadline-v1`:

```ts
{
  ref: 'd1',
  title,
  due: { kind: 'timed', at: 'YYYY-MM-DDTHH:MM' }
     | { kind: 'date', date: 'YYYY-MM-DD' }
     | { kind: 'unknown' },
  priority,
  completed: false
}
```

Do not send:

- Canvas descriptions;
- class/instructor names unless separately approved later;
- grades/submission content;
- source URLs/IDs;
- browser/file-derived source text;
- owner notes unless a later explicit decision adds them.

Only open deadlines in a bounded horizon should be selected. For the first `deadline-watch` slice, use overdue + the next **7 days**, sorted by due then ID, with a hard maximum of **50 transmitted deadlines** so the existing 350-source live-manifest ceiling still leaves room for the planner context and guard dependencies. Report additional eligible/withheld counts as metadata rather than silently truncating. Unknown-date records may be counted/withheld but should not crowd the first scheduled-agent slice unless the user later asks for an “unscheduled work” agent.

## Eligibility and provenance

Create `trackedDeadlineContext()` / `trackedDeadlineSources()` in `apps/api/src/ai/live-projections.ts` or a dedicated sibling module.

Eligibility requires all of:

- owned active tracked deadline;
- not completed/ignored;
- effective label allowed by the selected Assistant destination;
- at least one current network `calendar-feed` or Canvas API source sufficient to re-project the transmitted fields, **or** a server-defined owner override whose full inherited provenance/label floor is still acceptable;
- not attachment-derived through any current/captured association;
- not browser-only uncertified text;
- no unresolved source conflict affecting a transmitted field.

Ineligible items increment a coverage/withheld count; do not leak their title/date in the reason.

## Scope the automatic read to `deadline-watch`

Extend the internal agent call so `answerTurn` knows the agent template, or supply an explicit internal context policy enum such as:

- `agentContext: 'planner'` for existing templates;
- `agentContext: 'planner+deadlines'` for `deadline-watch`.

Do not infer permission from goal text.

Owner Assistant behavior remains unchanged in this slice. If later desired, explicit owner deadline selection can mirror P7 academic selection as a separate feature.

## Manifest and final guard

- Add `tracked-deadline-v1` to the live-manifest source schema.
- Seal ID/version/effective labels/source dependencies + projection digest before hold/send.
- Bind and recheck the responsibility's admitted version/template as part of this authority: a run admitted as `deadline-watch` must not keep deadline context if the responsibility is edited to another template before transmission.
- Final guard re-resolves the deadline and exact source dependencies; completion, override, label, source conflict or source-version changes cause `context-changed` before transmission.
- History eligibility must revalidate tracked-deadline sources just like planner/academic/mail sources.
- Agent retry behavior remains unchanged: one pre-send `context-changed` retry is allowed by current worker semantics; an uncertain provider call is never resent.

## Model instructions and proposal lineage

Add instructions for deadline refs:

- deadline records are planning deadlines, not proof of Canvas submission;
- do not mark them completed;
- use them to propose sufficient preparation time before due time/date;
- never claim source completeness.

Allow `task.create` and/or `event.create` to cite a `dN` ref. The server resolves that ref and writes `deadlineSource` itself.

Migration 075 should add durable planner linkage/snapshots, analogous to existing Canvas/academic source snapshots, so downstream planner records inherit the deadline's effective labels and source provenance. The owner may edit the resulting task/event later without changing the source deadline.

Files likely affected:

- `apps/api/src/features/agent-worker.ts`
- `apps/api/src/features/agent-run.ts` only if template/context metadata is threaded there
- `apps/api/src/features/assistant.ts`
- `apps/api/src/ai/live-projections.ts`
- `apps/api/src/ai/live-manifest.ts`
- `apps/api/src/ai/live-guard.ts`
- `apps/api/src/ai/live-history.ts`
- planner provenance/source helpers
- `packages/contracts` proposal/source schemas
- `apps/api/migrations/075_tracked_deadline_planner_links.sql`

## Tests

Mandatory focused cases:

1. `deadline-watch` sees eligible network-imported tracked deadline.
2. Daily-plan/custom agents do not automatically gain deadline context.
3. Completed deadline omitted.
4. Personal/Restricted routing respects destination labels.
5. `calendar-file` deadline withheld.
6. browser-only deadline withheld.
7. source conflict affecting title/due withheld.
8. source/override/version change between prepare/send → zero provider handoff and released unsent hold.
9. source change after a confirmed turn makes that history source ineligible.
10. no Canvas URL/internal ID leaves the server.
11. create action from `dN` stores immutable deadline source snapshot/labels.
12. Ask-first leaves proposal unapplied; Automatic applies only under explicit current action policy.
13. existing task/event planner context eligibility is unchanged.
14. scheduled-agent memory remains forbidden.
15. no Canvas/provider write exists anywhere in the path.

Acceptance canary after deployment:

- one owner-authorized `deadline-watch` run with a harmless known tracked deadline;
- Tasks/Calendar remain Ask first;
- confirm coverage indicates deadline context was eligible without recording private title/text in the receipt;
- usefulness reviewed by owner;
- no expansion to browser-only/file-derived deadlines from one successful canary.

Suggested commits:

1. `feat(ai): add guarded tracked deadline projection`
2. `feat(agents): give deadline watch tracked deadline context`

---

# Feature 5 — Optional Jev mail classifier

The detailed provider-specific design remains in [2026-10-19-jev-mail-broker-option.md](2026-10-19-jev-mail-broker-option.md). The orchestrator should treat it as a parallel workstream with these reconciled constraints:

## Required behavior

- OpenRouter/Gemini remains the missing-row/default `mail-broker` selection.
- Add owner-selectable `jev-mail`, exact versioned Jev model only.
- Independent provider consent and routing permission; the server-held Jev API key is the only Jev-specific credential requirement.
- No fallback between classifiers.
- Every retrieval is immutably pinned to one selector/profile/consent/verification/protocol identity before provider handoff.
- Selector changes invalidate unfinished retrievals/continuations but do not reinterpret old receipts.
- Existing mail grants and receiving Assistant destination remain independent.
- Direct single-attempt TypeSafe HTTP transport; no SDK retry behavior.
- The existing 60-case synthetic corpus remains optional evaluation tooling, not a runtime activation prerequisite.
- Live Jev configuration/private-mail canary remains a later explicit owner/operator gate.

## Reconciled migration number

Use `076_mail_broker_settings.sql`. Migration 073 is reserved for timed tasks, 074 for tracked deadlines and 075 for tracked-deadline planner/AI lineage. Update every earlier “pre-073/pre-074” compatibility assertion in the Jev subplan to pre-076.

## Concurrency boundary

Jev workers own only:

- broker selector/settings contracts/migration 076;
- broker adapter/policy/execution/lineage;
- Jev protocol/config/verification;
- mail-access UI;
- broker evaluation tooling/tests/docs.

They do not modify tracked-deadline tables, Calendar layout, deadline agent context or migration 075.

If both workstreams need `packages/contracts/src/index.ts`, `apps/api/src/config.ts`, general docs or CI, the orchestrator resolves those small integration collisions after worker commits rather than giving overlapping edit ownership.

---

# Orchestrator execution strategy

## Principle

Use **two lanes at once**:

1. a **development lane** where subagents work ahead concurrently on non-overlapping features after interfaces/migration ownership are stable; and
2. a **release lane** where the orchestrator serializes merge → production deploy → smoke verification for each completed feature.

A later feature may be developed and fully tested before an earlier release finishes, but production deployments stay dependency/migration ordered. Do not hold a finished independent feature until the whole program is complete.

## Continuous feature release protocol

For every feature below, the orchestrator treats “finished” as a release gate, not merely a worker handoff:

1. Worker/subagents finish implementation and focused tests on their branch/worktree.
2. Orchestrator reviews the diff, resolves shared-file collisions, and runs the feature's integration tests on the exact candidate commit.
3. Run `git diff --check`, formatting/type checks for affected workspaces, populated migration/upgrade checks when the feature has a migration, and the feature's focused browser/API suite.
4. Merge the feature to the release/integration branch as its own reviewable commit or compact commit series.
5. Re-run the feature-critical smoke suite on the merged commit. Worker-branch green tests are not sufficient evidence.
6. Deploy that merged commit to the real server through the existing sealed release/preflight/backup procedure.
7. Run a bounded production smoke using only the feature's already-authorized scope. Record release commit/tree, migration set, service health and metadata-only smoke evidence in `docs/implementation-log.md`.
8. If production smoke fails, stop the release lane, diagnose, and issue a forward fix/redeploy. Do not automatically restore an old database over owner writes. Application rollback is manual/reviewed and must remain schema-compatible.
9. Only after the production smoke is accepted does the release lane advance to the next ready feature.

Standing authorization in this plan covers merging and deploying **completed implementation features** to the real Personal Hub server under the existing release safety procedure. It does **not** authorize a new paid/private external-provider experiment, new account consent, broader mail disclosure, or destructive owner-data action. Those remain separate explicit gates. In particular, Jev code may be deployed unselected/unapproved, but private-mail Jev activation still follows its own live gate.

## Planned production release order

Use this order unless an earlier item is already deployed or the orchestrator proves a later item has no migration/dependency conflict:

1. **Release A — Calendar decluttering / timed Canvas placement** (Feature 3's raw-feed-compatible UI slice; no migration). Deploy as soon as its focused Calendar suite passes. This immediately relieves the reported all-day congestion without waiting for tracked-deadline storage.
2. **Release B — Timed owner tasks** (Feature 2, migration 073). Deploy API/contracts/UI/offline behavior together; optional AI proposal support may follow as a smaller later release if it would delay owner-facing functionality.
3. **Release C — Tracked Canvas deadlines** (Feature 1, migration 074). Deploy tracking/API/editor/export; Calendar then switches from raw assignment chips to tracked records where available.
4. **Release D — Deadline-watch tracked-deadline context** (Feature 4, migration 075). Deploy lineage/projection/guard/agent wiring only after Release C is live and verified.
5. **Release E — Optional Jev classifier implementation** (Feature 5, migration 076). Deploy code/profile support with OpenRouter still selected/default and Jev unapproved unless its separate live gates have been explicitly satisfied.

If Release B/C/D/E finishes development early, keep it rebased and ready; do not deploy it ahead of an unapplied lower-numbered migration. Parallel development is encouraged, production migration order is not.

## Wave 0 — Baseline and coordination (orchestrator, sequential)

1. Record exact starting commit/tree and clean/known-untracked state.
2. Preserve the existing Jev plan as a reviewed input and reconcile its migration number to 076.
3. Freeze the architectural decisions in this document before product-code edits.
4. Reserve migrations 073/074/075/076 exactly as above.
5. Run/record focused baseline suites only (tasks/offline, Canvas/reconciliation/calendar, agent, broker); do not burn time on full e2e before changes.
6. Create an integration checklist and file-ownership matrix for workers.

Do not let a worker “simplify” by auto-creating normal tasks or by removing the current AI source filters.

## Wave 1 — Parallel independently deployable foundations

Spawn up to four workers:

### Worker A — Timed-task foundation (Release B)

Owns:

- migration 073;
- task contracts/create/update/list/export/offline projection;
- task editor/quick-capture timed fields if file ownership is manageable, otherwise publish a stable contract for a UI worker;
- focused task/offline/upgrade tests.

Must not change Canvas/tracked-deadline/Jev code. AI proposal support is optional and should be split if it slows Release B.

### Worker B — Calendar decluttering + raw timed Canvas placement (Release A)

Owns:

- `calendar-grid.ts`, `TimeGrid`, `MonthGrid`, Calendar CSS/tests;
- first ships timed **existing Canvas feed** points into the hour grid and bounded all-day expansion without waiting for tracked-deadline storage;
- prepares an adapter seam so Release C can later swap tracked deadlines in without rewriting layout.

Must not create DB/API logic.

### Worker C — Deadline data foundation (Release C)

Owns:

- migration 074;
- tracked-deadline contracts/API/source resolver;
- Canvas feed/API/browser materialization hooks;
- export/upgrade/API tests.

Must not touch AI or Calendar layout except shared contract exports.

### Worker D — Jev adapter/selector backend (Release E, work-ahead)

Owns:

- migration 076 and Tasks 1–4/6–7 of the Jev subplan where practical;
- backend/evaluation tests.

Must preserve the current OpenRouter broker baseline unchanged and must not enable private Jev use.

The release lane should take Worker B first if it is ready because Release A has no migration. Worker A may deploy next as migration 073. Worker C follows as migration 074. Worker D may continue in parallel but cannot deploy migration 076 before 075 exists in production.

## Wave 2 — Parallel UI, AI lineage and Jev UI

After Worker C's tracked-deadline contracts stabilize (development may begin before production deployment):

There are more candidate slices than worker slots. Run at most the available safe concurrency (normally three or four), prioritizing Release C/D dependency work; queue/revive the remaining workers as slots free rather than spawning overlapping edits.

### Worker E — Deadline UI (Release C)

Owns:

- Deadline editor/list/Tasks/Today presentation and browser tests;
- consumes Worker C's agreed API contracts;
- adapts Calendar to prefer tracked records without changing Worker B's core layout algorithms.

### Worker F — Deadline AI projection + manifest guard (Release D)

Owns:

- `live-projections`, manifest/guard/history, projection tests;
- **not** agent template wiring yet if separating risk helps.

### Worker G — Deadline planner lineage + migration 075 (Release D)

Owns:

- migration 075;
- task/event deadline-source snapshots;
- proposal conversion/apply/undo/provenance tests.

### Worker H — Agent wiring (Release D)

Owns:

- `agent-worker` / `answerTurn` internal context-policy threading;
- `deadline-watch`-only activation and worker/restart/cap tests.

Coordinate F/G/H on shared `assistant.ts`: either give `assistant.ts` exclusively to F and have H provide a small patch/handoff, or sequence H after F. Do not have multiple workers edit the same large file concurrently.

### Worker I — Jev Settings UI (Release E)

Owns the Jev subplan UI/browser slice after Worker D's selector/readiness contracts are integrated.

### Worker J — Timed-task AI polish (optional follow-up to Release B)

If not included in Release B, owns Assistant structured-output/proposal/apply/undo support for task due times. This must not block the owner-facing timed-task release.

## Wave 3 — Integration hardening

Orchestrator or a dedicated integration worker:

1. Reconcile shared exports/config/error-copy/CI files.
2. Verify timed-task fields survive offline replay/export and never imply a reminder/calendar reservation.
3. Remove duplicate raw Canvas deadline rendering once tracked deadline data is present.
4. Verify no deadline completion path writes Canvas.
5. Verify the default mail broker is still OpenRouter when no selector row exists.
6. Audit every migration and upgrade fixture in numerical order.
7. Add cross-feature regression: changing the mail classifier cannot affect deadline/task context or agent source admission; changing a task/deadline cannot mutate mail broker state.

## Wave 4 — Focused qualification in parallel

Workers may concurrently run **non-overlapping** focused suites:

- Deadline/API/upgrade/PostgreSQL.
- Timed-task/API/offline/upgrade/PostgreSQL.
- Calendar component/unit + focused Calendar Playwright.
- Agent/live-projection/lineage/restart tests.
- Broker/Jev/evaluation + mail-broker Playwright.

Avoid concurrent Playwright jobs if the repo uses fixed ports and `reuseExistingServer:false`; serialize browser suites or assign distinct supported ports only if the config explicitly supports it. Do not kill unknown shared dev servers.

## Wave 5 — Program-wide qualification after incremental releases (orchestrator, sequential)

After all incrementally deployed features are integrated, run one final program-wide qualification on the exact final tree:

1. affected workspace typechecks;
2. focused Vitest/API suites one last time;
3. `npm run check`;
4. full `npm run test:e2e` sequentially;
5. disposable PostgreSQL migration/upgrade tests;
6. Linux + Windows + PostgreSQL CI;
7. `git diff --check`;
8. independent security/provenance review.

Record exact test commit/tree. This final pass supplements, not replaces, each feature's earlier merge/deploy/smoke receipt. Do not describe worker-branch passes as proof of a merged or deployed tree.

---

# Suggested worker prompts

The orchestrator should include the global safety constraints plus a narrow ownership list in each worker prompt.

## Deadline foundation worker prompt

> Implement migration 074 and the tracked-deadline domain only. Auto-materialize exact-identity Canvas assignment/quiz deadlines from committed feed/API/browser source state, preserve source provenance and owner overrides, and add owned/versioned/idempotent API + focused tests. Never fuzzy-match, never write Canvas, never auto-create planner tasks/events, and do not touch AI/calendar UI. Return changed files, focused validation and integration assumptions.

## Timed-task worker prompt

> Implement migration 073 and optional specific due-times for ordinary owner tasks. Preserve existing nullable date-only `dueDate` semantics; add a nullable exact due instant plus explicit IANA timezone, with strict consistency/DST handling. Update task API/contracts/offline/export/UI and focused tests. Timed tasks remain task deadline points, not Calendar reservations or automatic reminders. Do not relax existing AI provenance filters; keep AI timed-task proposal support separable if it would delay the owner-facing release.

## Calendar worker prompt

> Make timed tracked deadlines render as point markers in Day/Week and remove them from the all-day strip. Add a bounded per-day all-day disclosure (3 visible + `+N more`) without obstructing hour-grid event creation. Keep date-only deadlines in the strip, avoid raw-Canvas duplicates, preserve timezone/DST semantics, keyboard/a11y/e-ink behavior and run focused unit/Playwright tests. Do not modify API/migrations/AI.

## Agent-context worker prompt

> Add a dedicated guarded tracked-deadline projection for `deadline-watch` only. Keep existing planner exclusions intact. Network feed/API-backed, unlabeled/allowed, non-file/non-browser-only, conflict-free deadlines may be projected with title/due/priority only; final guard/history must reverify them. No memory authority, no Canvas write, no direct deadline completion. Add exhaustive synthetic tests and metadata-only coverage reporting.

## Jev worker prompt

> Implement the optional Jev mail-classifier plan using migration 076. Preserve OpenRouter/Gemini as default and all existing grant/provenance/budget/no-resend behavior. Independent selector/consent, exact versioned model, direct single-attempt TypeSafe HTTP, no fallback and cross-adapter receipt isolation are mandatory. Jev runtime configuration is API-key based; no separate account-verification object is required.

---

# Integration acceptance matrix

## Tracked deadlines

- [ ] Canvas assignment/quiz with canonical identity automatically appears once as a tracked deadline.
- [ ] Feed/API/browser exact associations do not produce duplicate actionable deadlines.
- [ ] Owner can complete/reopen and edit local deadline fields.
- [ ] Canvas refresh cannot erase local completion/overrides.
- [ ] Source missing/cancelled is visible and retained.
- [ ] Source disagreement is visible; no guessed overwrite.
- [ ] No mutation sends a write to Canvas.

## Timed owner tasks

- [ ] Existing no-date/date-only tasks remain behavior-compatible.
- [ ] Owner can optionally set a specific due time + timezone on a task.
- [ ] Stored `dueAt` resolves to the same local `dueDate` in `dueTimeZone`.
- [ ] Clearing only time keeps the due date; clearing the date clears timed metadata.
- [ ] DST-invalid local times are rejected rather than guessed.
- [ ] Offline replay/conflict/export/restore preserve timed fields exactly.
- [ ] Timed tasks render as deadline points, not reserved Calendar duration.
- [ ] Adding a due time does not silently create a reminder.

## Calendar

- [ ] Timed deadline renders in hour grid at due time.
- [ ] Date-only deadline stays in all-day strip.
- [ ] Week/Day all-day strip is bounded by default with accessible expansion.
- [ ] No raw Canvas/tracked-deadline duplicate appears.
- [ ] Empty hour slots remain easy to click/tap for new events.
- [ ] Agenda/Month/Today display consistent effective due/completion state.

## Deadline-watch agent

- [ ] Eligible tracked deadlines appear in `deadline-watch` context.
- [ ] Other agent templates do not gain automatic deadline authority.
- [ ] File-derived/browser-only/conflicted/labeled disallowed deadlines are withheld.
- [ ] Final guard blocks changed deadline/source before send.
- [ ] Source-linked proposals retain deadline lineage.
- [ ] Ask-first behavior remains intact.
- [ ] No memory, Canvas write, email send or new external-calendar authority is introduced.

## Optional Jev

- [ ] OpenRouter remains default/missing-row behavior.
- [ ] Jev selector is versioned and independent of grants/downstream Assistant choice.
- [ ] Jev requires independent consent/routing and a configured server API key; no separate account-evidence object is required.
- [ ] Cross-adapter switch never resends/reinterprets an old batch.
- [ ] Existing OpenRouter broker regression suite remains green.
- [ ] Jev synthetic evaluation is optional evidence, not a private-mail runtime prerequisite.

---

# Rollout and live gates

The **continuous feature release protocol above is authoritative**: each feature is merged and deployed when its own implementation/qualification gate closes rather than waiting for the full program.

## Release A — Calendar layout

1. Deploy the no-migration timed-Canvas/hour-grid + bounded-all-day UI slice immediately after focused Calendar qualification.
2. Smoke the owner's Calendar: timed Canvas entries appear at their actual time; date-only entries remain all-day; event creation hit targets remain usable.
3. Record the deployed commit/tree. Do not wait for tracked-deadline storage.

## Release B — Timed owner tasks (migration 073)

1. Deploy task schema/API/offline/UI timed-deadline support after populated migration and focused task/browser tests pass.
2. Smoke create → edit → clear time → reload on a harmless owner-created test task; avoid copying task text into receipts.
3. Confirm date-only existing tasks remain unchanged and no reminder/event was created implicitly.
4. Optional AI proposal support can deploy separately after its own focused apply/undo/provenance tests.

## Release C — Tracked Canvas deadlines (migration 074)

1. Deploy tracked deadline materialization/API/editor/export and adapt Calendar to prefer tracked assignment deadlines.
2. Verify owner-visible deadline counts/duplicates/source conflicts against real Canvas data without sending that data to AI.
3. Verify complete/reopen/local overrides survive a normal source refresh and never write Canvas.

## Release D — Deadline-watch context (migration 075)

1. Deploy guarded deadline projection/lineage/agent wiring only after Release C is healthy.
2. Run one bounded owner-authorized `deadline-watch` canary under Ask first and the current cap.
3. Confirm metadata-only coverage indicates eligible deadline context; verify no browser/file-only source was disclosed.
4. Owner judges usefulness; keep source completeness limitations visible.

Do not use a successful canary to claim Canvas feed/API/browser completeness.

## Release E — Jev implementation (migration 076)

Deploy the selectable-broker implementation only after its synthetic/code gates pass, while leaving OpenRouter selected/default and Jev unapproved/unselected unless its separate live prerequisites are already satisfied. Then follow Task 9 of the Jev subplan separately. Private mail or paid Jev testing is not implied by code deployment; each account/privacy/paid/live step remains explicitly gated.

---

# Documentation updates after implementation

Update only after the corresponding code is actually merged/verified:

- `docs/canvas.md` — automatic tracked-deadline behavior and provider-vs-owner fields.
- `docs/canvas-api.md`, `docs/canvas-browser.md`, `docs/canvas-reconciliation.md` — canonical identity/source participation and conflict semantics.
- `docs/academic-work.md` / `academic-agenda.md` — clarify tracked imported deadlines remain separate from manual academic work.
- `docs/planner.md`, `docs/development.md`, task-management/agenda docs — optional timed task semantics and date-bucket compatibility.
- `docs/ai-assistant.md`, `docs/agent-scope.md`, `docs/responsibilities.md` — narrow `deadline-watch` context authority.
- `docs/ui-agent-ledger.md` — deadline visibility, Calendar UI and broker selector.
- `docs/backlog.md` / `docs/decisions.md` — close implemented items and retain source-completeness/live gates.
- broker docs per the Jev subplan.
- `docs/implementation-log.md` — exact commit/tree/test/deploy receipts, metadata only.

Historical receipts should not be rewritten to imply the new behavior existed earlier.

---

# Definition of done

The orchestrator may call this program complete only when:

1. Imported Canvas assignment/quiz deadlines automatically have durable local tracking, completion and owner-edit semantics without provider writes.
2. Owner-created tasks can optionally carry a specific due time/timezone while existing date-only behavior remains compatible and no implicit reminder/calendar reservation is created.
3. Timed deadlines/tasks render at their due time, and the Day/Week all-day strip remains bounded/readable.
4. `deadline-watch` automatically receives only the approved tracked-deadline projection with final provenance/label/version rechecks and can make ordinary Ask-first planning proposals from it.
5. Existing task/event planner-context privacy filters remain intact.
6. OpenRouter/Gemini is still the default mail classifier, while Jev is an optional independently approved adapter with no cross-provider fallback/resend/receipt reinterpretation.
7. Every completed feature has its own merged production release + smoke receipt; no feature waits for the entire program solely for batching convenience.
8. All migrations are append-only, populated upgrades pass in PGlite and disposable PostgreSQL, and the exact final integration tree passes broad local + remote qualification.
9. Live owner/private/provider acceptance is recorded separately from synthetic implementation evidence.
