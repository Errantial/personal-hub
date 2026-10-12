# Frontend development plan

Status: plan approved 2026-10-10 with the owner decisions in §6; Phases 0 and 1 merged into `main` at `2e8f922`. Phases 2, 2b, 3, 4 and 5 are implemented and validated on branch `ui/phase-4` (not merged). Later phases are proposals until implemented. Rules come from [ui-guidelines.md](ui-guidelines.md); behavior to preserve comes from [ui-agent-ledger.md](ui-agent-ledger.md).

## 1. Current state (audit, 2026-10-10)

Audited by reading every web component and by screenshots of an isolated synthetic instance at 1366 px and 360 px in both themes.

**Strong foundations to keep:** shared Zod contracts; relative `/api` transport with native cookie path; durable task outbox with stable IDs, ordered replay, conflict retention and owner-scoped cache; version/operation-ID discipline in every editor; e-ink theme toggle; skip link; 44 px minimum buttons; `<details>` Help; 29 Playwright scenarios with role-based selectors and a 320 px overflow check.

**Problems, by impact:**

| # | Problem | Evidence |
| --- | --- | --- |
| 1 | Today is not a Today view. It shows a Tasks panel and a legacy one-time Events panel; no agenda, due/overdue grouping, reminders or Canvas deadlines | `PlannerBoard.tsx` |
| 2 | Editors are always open and dominate every screen; the first useful content on Calendar starts ~650 px down on desktop and off-screen on a phone | Calendar/Today screenshots |
| 3 | No URLs: views are React state. Reload returns to Today; browser/Android Back leaves the app; no deep links | `App.tsx` `useState<View>` |
| 4 | Sync panel "Online · 0 pending changes" takes a full panel on every screen | `SyncStatus.tsx` |
| 5 | Mobile navigation consumes ~250 px at the top before any content | 360 px screenshots |
| 6 | Preferences is a 3,300 px page mixing account, appearance and four AI scaffolding panels; Connections is 2,250 px | page heights |
| 7 | Inconsistent typography: 10–12 px labels/buttons next to 16 px text, serif display headings, unstyled `.meta` class; Unicode icons (`⌘` for Connections) | `styles.css` |
| 8 | Each component re-implements load/abort/busy/error/operation-ID logic (~10 copies); page-wide `busy` disables unrelated controls | all workspaces |
| 9 | `window.confirm`, free-text IANA timezone inputs, internal jargon in primary UI ("preflight", "source version 3", "Repeated-time offset") | various |
| 10 | 600 kB single JS chunk (React, Temporal polyfill, Zod, all screens); service worker caches only files already fetched and keys navigations by URL | `dist/assets`, `public/sw.js` |
| 11 | ~40% of `styles.css` is dead (welcome card, orbit art, feature grid) | `styles.css` |

## 2. Strategy

- **Incremental rewrite ("strangler"), not big-bang.** Build the new shell and shared primitives, then replace one screen at a time. Old components keep working inside the new shell until replaced. Each step ships with `npm run check` and `npm run test:e2e` green.
- **Behavior-first.** Before replacing a screen, list its ledger behaviors and the e2e tests that cover them; extend tests for any uncovered state *before* rewriting.
- **No backend changes required for Phases 0–6.** Today and Tasks compose existing endpoints. Small additive API improvements (e.g. a Today summary endpoint, a task restore operation) are listed as optional and need backend agreement.
- **No new runtime dependencies by default.** Hand-roll the router (~100 lines over the History API) and primitives on native elements. Any dependency is a decision (§6).
- **E-ink verification stays an explicit gate.** Emulator and browser results are recorded as such; Kompakt claims wait for hardware (D31).

## 3. Phases

Sizes are relative (S ≈ 1–2 sessions, M ≈ 3–5, L ≈ 6+). Order is the dependency order; 3–7 can be reordered after Phase 2.

### Phase 0 — Foundations (M) — completed 2026-10-10

Goal: change architecture without visible regressions. Visible changes were limited to the new font, type sizes and control borders.

1. **Design tokens and CSS structure.** Self-hosted Atkinson Hyperlegible Next (§6). `styles/tokens.css` (spacing, type, radius, color for both themes per guidelines §4), `styles/base.css` (reset, focus, typography), per-component CSS files. Delete dead CSS. Keep existing class names used by tests until their screens are replaced. Implemented as `tokens.css`, `base.css` and `legacy.css` (the pre-rewrite rules, removed screen by screen), plus `shell.css` from Phase 1.
2. **Router.** Typed route table (`/today`, `/calendar`, `/tasks`, `/classes/:id?`, `/inbox`, `/settings/:section?`), `pushState`/`popstate`, link component, focus-to-heading and `document.title` on navigation. Unknown paths → Today. Calendar date/view query parameters are parsed now and wired into the Calendar screen in Phase 4. Implemented: current six views with URLs; Phase 1 renames paths to the confirmed navigation.
3. **Service worker and bundling.** Navigation requests fall back to the cached app shell (`/` → `index.html`) regardless of path; precache all built assets from a Vite-generated manifest on install (with a versioned cache name and old-cache cleanup), so lazy route chunks work offline after first load. Then split routes with `React.lazy`. Set build/CSS target to Chromium 113. Implemented: views outside Today load lazily and are prefetched after sign-in; the initial chunk fell from 604 kB to 525 kB. It is dominated by react-dom, Zod and the Temporal polyfill pulled in through the shared contracts barrel, so the original ≤ 250 kB target needs a contracts change (Temporal-dependent helpers in a separate entry point, lighter schemas for the client). That is tracked in Phase 8; until then the budget is no growth above the recorded baseline.
4. **Data primitives.** `useResource(path, schema)` (abort, offline cache fallback with `cachedAt`, reload, error), `useMutation()` (operation-ID reuse for unchanged retries, new ID on changed payload, conflict detection returning the draft, per-control pending). Unit-test both with Vitest against fake transport. Migrate one simple screen (Reminders inbox) to prove them. Implemented in `lib/hooks.ts` and `lib/operations.ts`: operation identity is unit-tested in Node, the hooks are covered through Reminders e2e tests (including a lost-response retry). `useResource` does not expose cache freshness yet; it is added when a screen first shows "Cached <time>".
5. **Offline status API.** Implemented as `queued` (task IDs) and `locked` fields on `offlineStatus()` in `lib/offline.ts`, so rows can show Queued/Conflict/Locked inline. No outbox semantics change.
6. **Test harness.** Add `@axe-core/playwright` checks to existing scenarios; a theme × width matrix helper (320/1280 × standard/eink) for overflow and target-size assertions (script measuring every interactive element ≥ 44 px). Screenshots stay disabled in CI; a local-only script (like the one used for this audit) produces review images under `.artifacts/`. Implemented as `tests/e2e/accessibility.spec.ts` (standard 1280 px with 44 px targets, e-ink 320 px with 48 px targets); every view had zero axe violations after the token change.

Acceptance: all existing e2e tests pass unchanged except URL-based navigation additions; reload preserves the current view; Back works in Chromium; offline reload of `/calendar` works after one online visit; bundle report recorded in the ledger. Result: met — 110 unit/API tests (1 PostgreSQL test skipped without TEST_DATABASE_URL) and 37 browser tests passed; offline navigation to unvisited views was also verified against a production build. Android Back with History routing is still to be checked on the emulator.

### Phase 1 — App shell and global patterns (M) — completed 2026-10-10

1. Shell: left rail ≥ 1024 px; bottom tab bar < 1024 px (Today, Calendar, Tasks, Classes, More); header with title, sync indicator, one primary action. Remove eyebrow, avatar, footer API indicator; move Sign out and the E-ink toggle to Settings, with an E-ink shortcut in the More menu (§6).
2. Sync indicator replacing `SyncStatus` panel: compact text, expandable details with Sync now, conflict list linking to the task, Help. Server-unavailable and session-ended become page banners.
3. Primitives: `Button` (primary/secondary/quiet/danger), `Field` (label, hint, error with `aria-describedby`), `ErrorSummary`, `Banner`, `StatusChip`, `ItemRow`, `ConfirmDialog` (`<dialog>`), `HelpTip` (toggletip), `EmptyState`, `Pager` (e-ink paging), `TimeZoneSelect` (`Intl.supportedValuesOf`), `LabelControl` (content label).
4. Replace `window.confirm` everywhere with `ConfirmDialog`.
5. Session check state: `AuthGate` currently renders the sign-in form while the stored/online session is still being checked, so every load briefly shows Sign in (an extra full refresh on e-ink). Show a neutral "Checking sign-in…" status until the check settles.
6. Settings route with sections: Account, Appearance, Connections, AI, Data (export). Existing components are mounted in their sections unchanged at first, which immediately fixes the 3,300 px Preferences page.

Acceptance: navigation tests updated to new labels; 320 px no overflow on every route; axe passes with no serious/critical issues on the shell; e-ink theme has no shadows, gray fills or transitions (computed-style assertion).

Result: met. Implemented as specified, with these adjustments:

- The header has no primary action yet; "Add task" arrives with Today/Tasks quick capture (Phases 2–3), since today's forms are still inline.
- Sync details expand in the page flow below the header. A floating panel covered page controls (found by a browser test), so it was dropped.
- Primitives are built when a screen first needs them, avoiding unused code. Phase 1 built `Banner`, `ConfirmDialog` (`useConfirm`), the `Help` toggletip, `Link` and `Icon`. `Button`, `Field`, `ErrorSummary`, `StatusChip`, `ItemRow`, `EmptyState`, `Pager`, `TimeZoneSelect` and `LabelControl` move to the phase that first uses them (Phases 2–4).
- No separate "Data" section: export stays in Account with password and sessions.
- Session-ended remains the existing locked sign-in screen rather than a banner, because private views must not render after a 401.
- The initial chunk grew 7 kB (525 → 532 kB) for shell code every screen needs; 532 kB is the new baseline.
- Also fixed: the sign-in screen ignored the stored e-ink preference; unstyled buttons used the browser's gray fill.

### Phase 2 — Today (M) — completed 2026-10-10

Composition from existing cached endpoints: `/api/v1/tasks`, `/api/v1/calendar/occurrences` (today, viewing timezone), `/api/v1/connections/canvas/calendar` (today), `/api/v1/notifications`.

Sections, in order: **Needs attention** (conflicts, failed reminders, overdue tasks — overdue shown, deadline never changed), **Today's schedule** (events, study blocks, Canvas deadlines as point items, all-day first), **Due today / Upcoming 7 days** (tasks), **Unread reminders** (count + latest 3, link to Inbox). Quick capture: "Add task" title + optional due date, offline-capable via the outbox.

Each section loads independently; a failed Canvas read does not hide the planner (existing rule). Cached sections show "Cached <time>".

Decided (§6): the legacy one-time **Events** panel (`/api/v1/events`) is removed from Today in favor of the Calendar editor. The ledger notes the Today quick editor uses device-local time; the replacement uses the Calendar editor's timezone handling.

Acceptance: e2e for overdue display, Canvas deadline vs reserved study time distinction, offline cached Today with queued quick capture replaying once, section failure isolation, 320 px e-ink layout.

Result: met. `TodayView` loads tasks, occurrences, Canvas, reminder status and notifications independently. Quick capture sits directly below the header, expands on demand and explicitly distinguishes queued from saved tasks. Existing conflict banners remain above the view; full task editing stays in Tasks and event editing in Calendar. Date grouping updates at midnight/on focus using the device timezone. Cached reads expose their own timestamps; refresh remains manual or on remount rather than polling. `npm run check` passed 112 tests (1 optional PostgreSQL test skipped), and all 43 browser tests passed, including four new Today scenarios. Initial JS is 532.42 kB, with Today in a separate 7.82 kB precached chunk. Kompakt/Android Back/TalkBack remain unverified.

### Phase 2b — Appearance customization and profiles (M) — completed 2026-10-12

Owner-requested addition: extensive UI/UX customization in Settings, including colors, and appearance profiles that can be saved and loaded.

1. Settings › Appearance: adjustable accent, background, surface and text colors; text size, spacing/density and control shape. Provide useful defaults, a live preview, and reset controls. Theme changes must preserve readable contrast and visible focus, errors and sync/conflict state.
2. Named profiles: save current appearance, load, rename, replace and delete with confirmation. Include standard and e-ink defaults. Loading a profile must not change account, routing, task or integration settings.
3. Persist locally for offline startup and the bundled APK. Clearly disclose the device-local scope; cross-device profile sync/export needs a separately agreed contract. Invalid or outdated saved values fall back to safe defaults.
4. Keep e-ink monochrome and animation-free regardless of custom colors. Preserve keyboard/tap access and minimum targets; custom density cannot shrink controls below the accessibility floor.

Acceptance: profile persistence/reload, modified-profile state, invalid-value recovery, reset without deleting saved profiles, contrast/focus checks, offline use, 320 px overflow and e-ink overrides. 

Result: met. Settings › Appearance has Display (e-ink, text size, density, control shape), Colors (accent, background, surface, text) and Profiles (Standard and E-ink built in; save, load, rename, replace and delete up to 20, with confirmation for destructive steps). Everything is device-local (`hub:eink`, `hub:appearance`, `hub:appearance-profiles`, `hub:appearance-profile`), applied before first paint, and never sent to the server. Other colors are derived from the four chosen ones and checked for contrast (4.5:1 text, 3:1 borders/accent); a failing set is rejected with the ratio shown and the previous theme stays. E-ink forces monochrome and square corners and hides color editing; the 44/48 px target floor holds at every density. Invalid stored values fall back to defaults. 6 unit and 7 browser tests; the accessibility, e-ink styling and overflow suites pass with a custom dark theme. Cross-device sync/export is not built.

### Phase 3 — Tasks (M) — completed 2026-10-12

List with filters (Open · Due soon · Overdue · No date · Done), grouping by due date, inline completion, row chips (high priority, label, Canvas/Class work source, Queued/Conflict/Locked). Detail editor at `/tasks/:id` with all fields and the source panels. Conflict flow: draft retained, explicit "Load latest version", Save disabled until then.

Reevaluated against the backend that landed while the UI was paused (2026-10-12):

- **Delete** is now reversible: an online delete shows an **Undo** notice (restore with the tombstone version), and a **Recently deleted** section lists deleted tasks with Restore. Offline deletes keep a confirmation because they cannot be undone until synced.
- **Conflict banner stays global.** Discard-local-changes stays in the shell banner (it must be reachable from every screen); each conflict gets an **Open task** link instead of moving the action.
- **Deferred:** `/tasks/browse` (server search/paging) and `/tasks/batch` (selected changes) would break the offline list; they return with a select mode when the list needs paging. The agenda endpoint stays Today's concern.

Acceptance: port all `hub.spec.ts` and `offline.spec.ts` task scenarios to the new screen without weakening assertions (lost response retry, conflict draft, two-tab replay, revoked-session lock, sign-out guard).

Result: met. `TasksView` (lazy chunk) reads the cached `/api/v1/tasks` list, so offline, outbox and conflict behavior is unchanged; filters are URLs (`/tasks?filter=…`, `/tasks/:id`), keyboard- and link-accessible. Narrow screens show the editor alone with a Back link; ≥ 1024 px shows list and editor side by side. Quick capture and `ReadState` were extracted from Today and shared. The legacy `PlannerBoard` is removed. All 51 browser tests pass, including 6 new Tasks scenarios (grouping/filter URLs, Undo and Recently deleted, title validation, unknown-task address, axe/overflow/target checks at 1280 px standard and 320 px e-ink) and the ported task, offline, Canvas and conflict scenarios.

`npm run check` passed (406 tests, 1 optional PostgreSQL test skipped). Tasks is a separate 14.1 kB precached chunk. Initial JS is 561.99 kB (532.42 kB after Phase 2): the shell changed by only a few hundred bytes, so the growth comes from the backend's new shared-contract schemas reaching the client barrel. Track it under Phase 8's contracts entry-point split.

### Phase 4 — Calendar (L)

1. **Agenda view (default):** chronological, day-grouped list for a 7-day window with Previous/Next/Today and a date input; all-day first; Canvas entries marked read-only; study blocks show class/topic/status.
2. **Week view:** seven labelled day sections (columns ≥ 1280 px, stacked below), no positioned time grid in this phase (accessibility and e-ink; revisit later).
3. **Editor route** (`/calendar/new`, `/calendar/:id`, `/calendar/:id/occurrence/:date`): sections Basics, Time (all-day toggle, start/end, `TimeZoneSelect`), Repeat, Study (class/topic/status), Label. Show the DST ambiguity choice only when the entered time is actually ambiguous (computed via the shared `wallTimeToInstant`), replacing the always-visible "Repeated-time offset" select.
4. **Recurring edits:** choosing Edit/Delete on a recurring item opens a dialog: "This occurrence" / "Entire series", with the series-reset warning shown only when anchor/timezone/rule fields change.
5. Viewing timezone as a header control using `TimeZoneSelect`.

Acceptance: port `features.spec.ts` calendar scenarios (stale draft preserved through navigation, all-day recurring occurrence edit); add DST gap/fold UI checks; keyboard-only create/edit; agenda readable at 320 px e-ink.

Result: met. `CalendarView` (Agenda/Week/Day by URL) and `CalendarEditor` replace `CalendarWorkspace`; Undo and Recently deleted are shared with Tasks (`DeletedItems`). Delete asks for the scope; the series-reset warning appears only when start, zone, all-day or repeat fields change; the DST choice appears only for an actually repeated time and gaps are rejected. The viewing timezone is a header disclosure and is not persisted. All 60 browser tests pass, including 9 new Calendar scenarios (DST gap/fold, scope dialog, series reset, Undo, keyboard-only create/edit, axe/overflow/target checks at 1280 px and 320 px e-ink) and the ported calendar scenarios. `npm run check` passed (419 tests, 1 optional PostgreSQL test skipped). Calendar is a separate 25.5 kB precached chunk; initial JS is 563.37 kB (561.99 kB after Phase 3). Kompakt/Android Back/TalkBack remain unverified.

### Phase 5 — Classes (M) — completed 2026-10-12

Class list → `/classes/:id` detail with tabs or sections: Topics (progress/confidence as manual assessments with explicit "Not assessed"), Study blocks, Canvas (feed entries, API assignments, linked planner work). "Plan study" opens the Calendar editor pre-filled (class/topic/title; WCAG 3.3.7). Clear wording that grades are not imported and completion ≠ mastery (Help).

Acceptance: port class/Canvas portfolio e2e scenarios including cached offline portfolio viewing and archived-class labels.

Result: met, with one deferral. `ClassesView` + `ClassForms` replace `AcademicWorkspace`: list at `/classes`, add at `/classes/new`, detail at `/classes/:id?section=topics|study|canvas|details`. Topics show "Not assessed" until progress or confidence is entered (no invented 0%), a progress bar only when assessed, Edit, Plan study (opens the Calendar editor with class/topic/title) and Delete with confirmation; the Help states that grades are not imported and finishing study time is not mastery. Study blocks lists the class's calendar events (Upcoming/Earlier), linking to the Calendar editor. Canvas mounts the unchanged entries and assignments (including planner work and cached offline viewing). Class and topic drafts keep their version; a conflict shows "Changed elsewhere", keeps the draft and requires **Load latest version**. Unknown classes explain themselves with a Back link. Below 1024 px the detail replaces the list. 6 new browser tests plus the ported features, canvas and canvas-lms scenarios; unit tests for `lib/classes.ts` and the router.

Deferred: the manual academic Work section (grades, status, workload source history) has backend support but no UI yet. Classes have no archived state in the contract, so there are no archived-class labels.

### Phase 6 — Inbox (S)

Notifications (unread first, mark read, latest 200 note), scheduled reminders with status chips and Pause/Resume/Retry/Cancel, add/reschedule editor, worker health line ("Reminder worker last seen <time>" / stale warning), browser alert permission states (Not enabled · Allowed · Blocked by browser · Only while Inbox is open). Rename Reminders → Inbox; email arrives here later as a separate section.

Acceptance: port reminder delivery/pause/resume and denied-permission scenarios.

### Phase 7 — Settings: Connections and AI (L)

1. **Connections:** one card per provider with status line. Canvas card opens a detail with three tabs: Calendar feed (settings, sync, import ICS, entries, history), Canvas API (settings, sync, courses/assignments), Matching (reconciliation). Entry/assignment rows reuse `ItemRow`; Create task / Plan study open the respective editors pre-filled with source refs (online-only, with the reason shown when offline). Planned Outlook/Proton: "Not available yet" rows.
2. **AI:** single page with a top status "AI requests are off" and sections Permissions (per-label allowed/preferred providers as a table), Spending limits, Providers (read-only server profiles), Request checks (renamed preflight, with history). Consolidate the duplicate task pickers in routing preview and request checks into one `ContextPicker` (ledger known debt). Preserve the `hub-ai-settings-changed` reload behavior and all blocked reasons, translated to plain text with the code in details.

Acceptance: port `canvas*.spec.ts`, `ai-routing.spec.ts`, `ai-preflight.spec.ts` without weakening retry/conflict/no-provider-call assertions.

### Phase 8 — Hardening and device pass (M)

- Accessibility audit: NVDA + Chrome keyboard pass of every route; TalkBack on the emulator; fix and record.
- E-ink: `Pager` on long lists in e-ink mode; audit for timer-driven repaints; verify no layout shift on status changes (CLS-style assertion in Playwright).
- Android: Back button behavior with History routing on the emulator (add `@capacitor/app` only if needed, §6); 130% text zoom; safe areas; offline navigation between lazy routes after process restart.
- Performance: split Temporal-dependent contracts helpers into a separate entry point and evaluate lighter client-side schemas to approach a ≤ 250 kB initial chunk; bundle budget check in CI (fail over budget); emulator cold start and route switch timings recorded in the ledger.
- Docs: update ledger, development.md (routes, test commands), README status.

### Reevaluation 2026-10-12

Backend added AI request/attempt lifecycles, study planning, academic work, reminder snooze, restore and task browse/batch while the UI was paused. None changes the phase order: Phases 4–7 below stay as planned, with these additions.

- **Phase 4 Calendar:** deleted events are restorable (`/planner/deleted?kind=calendar`); add the same Undo/Recently deleted pattern as Tasks. Study planning previews and academic deadline agenda are inputs to the Agenda view.
- **Phase 5 Classes:** manual academic work and the workload source history belong in the class detail (Work section).
- **Phase 6 Inbox:** reminder snooze and inbox history are part of the reminder editor and list.
- **Phase 7 Settings › AI:** request/attempt history, budget and consent surfaces are read-only status plus explicit controls; no live dispatch exists yet, so label everything synthetic.

### Later (not scheduled)

Assistant screen (proposal cards, activity/receipt list, approvals), email Inbox categories, memory management, notification preferences, study plan suggestions. These start only when their backend capabilities exist; guidelines §8 already defines their UX rules.

## 4. Cross-cutting acceptance (every phase)

- `npm run check` and `npm run test:e2e` pass; tests run on their own ports/synthetic DB; no real providers.
- Guidelines §12 checklist completed for each new screen.
- Ledger entry per phase: new routes, states, limitations, removed UI, test changes.
- No change to contracts, operation-ID/version semantics, outbox behavior or authorization without a ledger note and backend agreement.

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| Rewrite weakens offline/conflict guarantees | Port tests before code; `useMutation` unit tests cover retry/conflict; screen-by-screen replacement |
| Lazy chunks unavailable offline | Phase 0 precache manifest + navigation fallback before any splitting |
| Kompakt WebView older/different than assumed | Chromium 113 feature floor; no Popover/anchor APIs; measure on hardware when D31 lifts |
| Fixed bottom bar hides focus or content | `scroll-padding-bottom`, focus-obscured test |
| Android Back exits app with History routing | Emulator test in Phase 0; App plugin fallback |
| Text zoom breaks layout | rem-based tokens; 130% zoom test |
| Scope creep into visual polish | Guidelines fix the system; no bespoke per-screen styling |

## 6. Owner decisions (confirmed 2026-10-10)

1. **Navigation:** Today · Calendar · Tasks · Classes · Inbox · Settings. Connections and AI move under Settings; Reminders becomes Inbox.
2. **Legacy Events panel:** removed from Today; events are created only through Calendar. Existing events still show in Calendar.
3. **E-ink toggle:** Settings › Appearance plus a shortcut in the More menu; no header button.
4. **Font:** Atkinson Hyperlegible Next, self-hosted (bundled, never loaded from a third-party CDN) so it works offline and in the APK. Latin subset, variable woff2; record its byte cost against the bundle budget.
5. **Dependencies:** hand-rolled router and primitives on native elements. `@capacitor/app` only if emulator testing shows Back exits the app. Any other runtime dependency needs a ledger justification.
6. **Accent color:** keep the current dark green (`#284b40`) for the standard theme; e-ink stays black.
7. **Backend additions accepted for later phases:** task/event restore (undo delete) is now implemented with migration 019, owner authorization, optimistic versions, retry receipts and tests; see ui-agent-ledger.md for its online-only contract. UI Undo controls remain pending, so current deletes still use confirmation. The additive Today attention summary and task agenda are now implemented; see today-summary.md. UI integration remains pending, and Today continues composing existing cached endpoints with independent schedule/imported-source states.

## 7. Sources

Research consulted for the guidelines and this plan:

- Mudita Kompakt [technical specifications](https://support.mudita.com/en/support/solutions/articles/77000577372-mudita-kompakt-technical-specifications), [third-party app support](https://support.mudita.com/en/support/solutions/articles/77000577356), [developer/MMD framework](https://mudita.com/developers/), [MMD library summary](https://klibs.io/project/mudita/MMD), [forum WebView report](https://forum.mudita.com/t/android-webview-is-very-outdate-update-asap/13767)
- E-ink practice: [design principles](https://friends.grishka.me/posts/168524), [HN conventions thread](https://hn.nuxt.dev/item/49213660), [Microchip ePaper fundamentals](https://developerhelp.microchip.com/xwiki/bin/view/software-tools/mgs/dev-kits/epd-ug/fundamentals/)
- Accessibility: [WCAG 2.2 changes (Deque)](https://dequeuniversity.com/resources/wcag-2.2), [Inclusive Components toggletips](https://inclusive-components.design/tooltips-toggletips/), [APG date picker](https://www.w3.org/WAI/ARIA/apg/example-index/dialog-modal/datepicker-dialog.html), [Google Calendar screen reader guidance](https://support.google.com/accessibility/answer/6101541?hl=en)
- UX patterns: [NN/g progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [GOV.UK error messages](https://design-system.service.gov.uk/components/error-message/), [undo vs confirmation](https://notes.andymatuschak.org/zXH4ASvHNz488hCNgrBjQJK), [Ink & Switch local-first](https://inkandswitch.com/local-first/)
- AI UX: [Microsoft HAX guidelines](https://www.microsoft.com/en-us/haxtoolkit/library/), [PAIR Explainability + Trust](https://pair.withgoogle.com/chapter/People%20+%20AI%20Guidebook%20-%20Explainability%20+%20Trust.pdf)
- Platform: [Capacitor Text Zoom](https://capacitorjs.com/docs/apis/text-zoom), [React Aria vs Radix](https://www.pkgpulse.com/guides/react-aria-vs-radix-primitives-2026)
