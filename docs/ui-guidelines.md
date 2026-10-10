# UI/UX guidelines

Status: adopted 2026-10-10; owner decisions are recorded in [frontend-plan.md §6](frontend-plan.md#6-owner-decisions-confirmed-2026-10-10) and decision D46. These rules guide the UI rewrite in [frontend-plan.md](frontend-plan.md). Behavior that must survive the rewrite is recorded in [ui-agent-ledger.md](ui-agent-ledger.md); product scope is in [product.md](product.md). Where this document conflicts with product.md or AGENTS.md, those win.

## 1. Principles

1. **Answer the three questions first.** Every primary screen supports: what needs attention today, what to study next, what changed in connected accounts ([product.md](product.md)). Content that answers none of them belongs in Settings or a detail view.
2. **Honest state over reassuring polish.** Never show a request as done before the server confirms it. A saved request, a queued edit, a confirmed server write and a confirmed provider action are different states with different labels. Show what is stale, cached, pending, conflicted, blocked or unverified.
3. **Owner intent is never lost.** Drafts survive errors, conflicts, reloads and lost responses. No surface silently overwrites, discards or merges owner input.
4. **One design, two displays.** Every screen works on a Windows desktop browser and on a 4.3-inch monochrome e-ink phone. Design for the e-ink constraint first (monochrome, no motion, stable layout, large targets), then add density and tint for desktop.
5. **Quiet by default.** Titles and labels, not sentences. Secondary explanation lives in Help. Essential warnings, errors, and pending/offline/conflict state stay visible (D28).
6. **Same operations for UI and AI.** The UI never invents a shortcut the server would reject; future AI proposals render through the same item views and the same before/after language.

## 2. Target displays

| Target | Facts that constrain design | Source |
| --- | --- | --- |
| Windows browser | Keyboard and mouse; widths 1024–1920 px; full workflow required | [platforms.md](platforms.md) |
| Mudita Kompakt | 4.3" E Ink touchscreen, 800×480 px (~217 ppi); AOSP-based MuditaOS K, no Google Services; sideloaded apps are "not optimized" | [Mudita specs](https://support.mudita.com/en/support/solutions/articles/77000577372-mudita-kompakt-technical-specifications), [third-party apps](https://support.mudita.com/en/support/solutions/articles/77000577356) |
| Kompakt WebView | User-reported Chromium 128 (unverified); AOSP 12 base reported on the forum | [forum](https://forum.mudita.com/t/android-webview-is-very-outdate-update-asap/13767) |
| Emulator baseline | Verified WebView 113, 360 CSS px wide | [android.md](android.md) |

Design widths: **320 px** (worst-case Kompakt CSS width; the existing e2e check), **360 px** (verified emulator), **768 px**, **1280 px**. Nothing may overflow horizontally at 320 px.

**Platform feature floor: Chromium 113** until the Kompakt WebView is measured. Allowed: CSS custom properties, grid, `gap`, container queries, `:has()`, `dvh`, `inert`, `<dialog>`, `<details>`, `Intl.supportedValuesOf`. Not allowed without a fallback: Popover API (Chrome 114), anchor positioning, `@starting-style`, `light-dark()`, `field-sizing`, View Transitions. Set the Vite/CSS build target accordingly.

## 3. Information architecture

Proposed navigation (product.md main screens, mapped to implemented features):

| Destination | Contains now | Later |
| --- | --- | --- |
| Today | Due/overdue tasks, today's agenda (events, study blocks, Canvas deadlines), unread reminders, sync state | Suggested study, important email |
| Calendar | Agenda (default) and week views, event/series editor | Writable external calendars |
| Tasks | All tasks, quick capture, filters (open/done/overdue/no date) | Recurrence, estimates |
| Classes | Class list → class detail (topics, study blocks, linked Canvas records) | Grades, study plans |
| Inbox | Reminder notifications and reminder schedules | Email categories and suggestions |
| Settings | Account, Appearance, Connections, AI, Data export | Notifications, memory, MCP |
| Assistant | — (not shown until implemented) | Requests, proposals, history |

Rules:

- Connections and AI controls move under Settings. They are configuration, not daily destinations. A connection problem that affects daily data surfaces as a status line on the screen it affects (e.g. "Canvas last import 3 days ago" on Today/Calendar), linking to Settings.
- Never show navigation to unimplemented features. Planned connections appear only inside Settings › Connections as "Not available yet".
- Each destination and each detail has a URL (`/today`, `/calendar?date=…&view=week`, `/classes/:id`, `/settings/ai`). Browser Back, Android Back, reload and bookmarks restore the same view. Drafts are not stored in URLs.
- Two disclosure levels at most: screen → detail/editor. If a third is needed, simplify ([NN/g progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)).

### Layout

- **≥ 1024 px:** left navigation rail (labels visible), content max 1200 px, optional right detail pane for editors (list stays visible).
- **< 1024 px:** bottom tab bar with Today, Calendar, Tasks, Classes, More (Inbox, Settings). Inbox shows an unread count as text ("Inbox 3"), not a dot. Editors open as full-screen views with a header Back/Close and URL entry, not modals stacked over lists.
- Global header holds only: screen title, a compact sync indicator, and at most one primary action (e.g. "Add task"). Sign out and appearance move to Settings.
- Remove decorative elements: eyebrow captions ("YOUR PERSONAL HUB"), avatar letter, "Personal workspace", footer API indicator. API connectivity is part of the sync indicator.

## 4. Visual foundations

Implement as CSS custom properties in one tokens file; components never use raw values.

### Spacing and size

- 4 px base: `--space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 24, `-6` 32, `-7` 48.
- Touch targets: **minimum 44×44 CSS px** for every control; **48 px** in e-ink mode and on the bottom bar. At least 8 px between adjacent targets. WCAG 2.5.8 requires 24 px; we exceed it because a missed tap on e-ink costs a full refresh. The visual glyph can be smaller than the hit area.
- Radius: 6 px controls, 8 px surfaces; 0–4 px in e-ink mode (rounded black borders ghost and read as heavy).

### Typography

- One family: **Atkinson Hyperlegible Next** (SIL OFL), self-hosted as a Latin-subset variable woff2 bundled with the app — never from a third-party CDN (privacy, offline, APK). Fallback stack `system-ui, "Segoe UI", Roboto, sans-serif` with `font-display: swap`. Drop the Georgia display headings: mixed families add noise and Georgia's thin strokes render poorly on e-ink.
- Scale (rem, root 16 px): caption 0.8125, body-small 0.875, **body 1.0**, title-small 1.125, title 1.25, page-title 1.5. No text below 0.8125 rem (13 px); current 10–12 px labels and buttons are removed. Body line height 1.5, headings 1.25.
- Weights: 400 body, 600 emphasis/headings. No weights below 400.
- Use rem for type and spacing so Android WebView text zoom and browser zoom scale the layout instead of clipping it. Never force `setTextZoom(100)`; test at 130% text zoom ([Capacitor Text Zoom](https://capacitorjs.com/docs/apis/text-zoom)).
- Dates/times: always `Intl.DateTimeFormat` with explicit timezone; tabular numerals (`font-variant-numeric: tabular-nums`) in agenda times and amounts.

### Color and themes

Two themes, one structure. Themes may only change tokens; layout, spacing and content must be identical (stable layout is an e-ink requirement and keeps tests theme-independent).

| Token | Standard | E-ink |
| --- | --- | --- |
| `--bg` | near-white neutral | `#fff` |
| `--surface` | `#fff` | `#fff` |
| `--text` | near-black, ≥ 12:1 on bg | `#000` |
| `--text-muted` | ≥ 4.5:1 on surface | `#000` (de-emphasize by size/weight, never gray) |
| `--border` | ≥ 3:1 for control boundaries | `#000` |
| `--accent` | one brand color ≥ 4.5:1 | `#000` |
| `--danger`, `--warning` | distinct hue + icon/text | `#000` + text/glyph |
| `--selected-bg` | tint | `#000` with `#fff` text (inversion) |

- **Meaning is never carried by color alone** — every status has text and, where useful, a glyph or border style (WCAG 1.4.1; product.md e-ink requirement).
- E-ink: pure black and white for UI shapes; no gray fills, shadows, gradients or images beyond line art. Selection = inversion or 2 px border + underline. Disabled = dashed border plus "(unavailable)" text where the reason matters, not reduced opacity.
- No dark theme in this release (looks poor on e-ink and doubles visual QA). Respect `prefers-contrast: more` by switching standard-theme muted tokens to full contrast.

### Icons

Replace Unicode glyph icons (◷ ▦ ⌘) — they vary by font and `⌘` means "Command" on macOS. Use a small inline SVG set (≈10 icons, 1.5–2 px strokes, no fills), always paired with a visible label in navigation. Icon-only buttons need an accessible name and a hit area per §4.

### Motion

None in e-ink mode; in standard mode only ≤ 150 ms opacity/position for disclosure, disabled under `prefers-reduced-motion`. No spinners that animate continuously on e-ink: use static text ("Saving…") instead. No skeleton shimmer. Progressive rendering is fine: reserve final positions, then fill content (avoids reflow-induced refreshes).

## 5. E-ink rules

From Mudita's MMD framework (ripple/animation off, monochrome scheme, frugal updates — [MMD](https://klibs.io/project/mudita/MMD), [Mudita developers](https://mudita.com/developers/)) and practitioner guidance ([e-ink principles](https://friends.grishka.me/posts/168524), [HN discussion](https://hn.nuxt.dev/item/49213660)):

- **Stable layout.** Already-rendered content does not move unless the user caused it. Reserve space for status lines, errors and counts so their appearance does not shift content. No auto-dismissing toasts.
- **Batch updates.** Do not re-render lists on timers. Background sync updates a single status region; list content refreshes when the user acts (open screen, pull "Refresh", submit). Never repaint a clock every second.
- **Tap, don't drag.** No drag-and-drop or swipe as the only path (WCAG 2.5.7). Calendar rescheduling is an edit form; reordering, if added, uses Move up/down.
- **Page over scroll where practical.** Long lists in e-ink mode offer discrete "Previous page / Next page" (keeping one item of overlap) in addition to normal scroll. Avoid scroll-linked effects and sticky elements that repaint while scrolling, except the fixed bottom bar.
- **Explicit refresh.** Offer a manual "Refresh" for nonurgent content (product.md). Reminder/sync engines are not slowed by visual batching.
- **No streaming repaint.** Future AI output renders whole paragraphs or the complete response, never token-by-token, in e-ink mode.
- **Contrast through structure.** Group with whitespace and 1–2 px black rules; avoid boxes inside boxes.

E-ink mode remains an owner preference (persisted, as today); a later option may default it on when the native shell reports the Kompakt. Hardware acceptance is still required before claiming Kompakt support.

## 6. Interaction patterns

### Lists and items

- One item row component for tasks, events, study blocks, Canvas entries and reminders: title, one meta line (time/due, class, source), status chips, and up to two inline actions. Other actions go in the item's detail view or a "More actions" menu.
- Completing a task is a single tap on a 44 px checkbox and is reversible inline (uncheck). Completion state uses strikethrough **and** "Done" text for screen readers.
- Read-only imported items (Canvas) show a "Canvas · read-only" chip and never show Edit/Delete. Their personal notes/labels are edited in the detail view.

### Forms and editors

- Editors are closed by default. "Add task" opens a quick-capture field (title + optional due date); full fields are in the detail editor. This replaces the always-open forms that currently dominate Today and Calendar.
- Labels above fields, always visible; no placeholder-only labels. Required is the default; mark optional fields "(optional)".
- Use native inputs (`type=date`, `datetime-local`, `select`) for keyboard, screen reader and Android picker support. Replace free-text timezone fields with a searchable list from `Intl.supportedValuesOf('timeZone')`, defaulting to the device zone.
- Content label (Unlabeled/Personal/Restricted) is one consistent segmented control with Help, shown in every editor that supports labels, and is displayed on items as a chip only when not Unlabeled.
- Primary action at the end of the form, left-aligned on desktop, full-width on narrow screens. Destructive actions are separated and never adjacent to Save.
- Busy state: the submitting button shows "Saving…", is disabled, and the form stays filled. Other unrelated controls remain usable (avoid page-wide `busy`).

### Errors and validation

Follow [GOV.UK error message](https://design-system.service.gov.uk/components/error-message/) rules:

- Field errors appear next to the field, linked with `aria-describedby`, prefixed for screen readers ("Error:"); forms with more than one error also show a summary at the top that links to each field.
- Wording says what happened and how to fix it, using the field label: "Enter a title", "End must be after start". No "invalid", "oops", "please", "sorry", or raw codes.
- Server/operational problems (unavailable, conflict, session ended) are not field errors; they use the status banner patterns below.
- Keep all entered values on error.

### Destructive and conflicting actions

- Prefer undo for reversible actions; confirm only irreversible or high-consequence ones, to avoid confirmation fatigue ([undo over confirmation](https://notes.andymatuschak.org/zXH4ASvHNz488hCNgrBjQJK)). Tombstoned deletes are server-reversible in principle, but no restore API exists yet — so deletes currently need confirmation. Replace `window.confirm` with an in-page `<dialog>` that restates the object ("Delete task 'Essay draft'?"), puts focus on Cancel, and names the action button "Delete task".
- Discarding queued offline changes and revoking sessions always require confirmation.
- Conflicts (409 VERSION_CONFLICT): show "Changed elsewhere" banner on the editor with the draft intact, a "Load latest version" action, and Save disabled until the reload completes (existing ledger rule). Show a field-level comparison when the server version is available.

### Help

- Help is a **toggletip**: a button labelled "Help" (accessible name "Help: <topic>") that reveals text in an adjacent live region on click/tap/Enter, closes with Escape or outside tap ([Inclusive Components](https://inclusive-components.design/tooltips-toggletips/)). No hover-only tooltips, no `title` attributes. The current `<details>` implementation is acceptable as an interim fallback.
- At most one Help per section, placed consistently at the right of the section heading (WCAG 3.2.6 Consistent Help). Do not place Help between a label and its input.
- Help text is plain, ≤ 3 sentences, and contains no actions or links required to complete a task.

## 7. State vocabulary

Use these exact words everywhere (UI, tests, ledger). Each state has text; glyphs are optional reinforcements.

| Domain | States (UI label) |
| --- | --- |
| Connectivity | Online · Offline · Server unavailable · Session ended |
| Task sync | Saved · Queued (n) · Syncing · Conflict · Rejected · Locked (sign in to sync) |
| Freshness | Updated `<time>` · Cached `<time>` · Not loaded offline |
| Canvas source | Available · Cancelled · Not in latest feed · Read-only · Account unverified |
| Reminder | Queued · Running · Paused · Delivered · Failed · Cancelled |
| Study block | Planned · Completed · Cancelled |
| AI | Preview only · Blocked: `<reason>` · Configured (health not checked) · Credential missing · Disabled |

### Status surfaces

- **Sync indicator** (header, always present): one short line, e.g. "Online", "Offline · 2 queued", "Conflict · 1". Expanding it shows details and "Sync now". Do not render a full panel when there is nothing to report (currently "Online · 0 pending changes" occupies a panel on every screen).
- **Page banner** (top of content, persistent until resolved): server unavailable, session ended, conflicts, cached/offline view of this screen. Uses `role="alert"` only when newly raised by a user action; otherwise `role="status"` to avoid repeated announcements.
- **Inline status** (in item rows/editors): queued, conflict, read-only, source changed.
- No transient toasts for anything the owner must act on.

### Empty, loading and offline

- Loading: reserve layout, show "Loading tasks…" text; no spinners in e-ink.
- Empty: one line stating the state and the primary action ("No tasks due today. Add task"). No illustrations.
- Offline and not cached: "Not available offline. Connect to load this view." Offline but cached: show content with "Cached <time>" and disable online-only actions with the reason visible ("Connect to edit calendar").

## 8. Trust, privacy and AI UX

Grounded in Microsoft's [Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/haxtoolkit/library/) (G1 make clear what the system can do, G2 how well, G9 efficient correction, G11 why the system did what it did, G16 consequences, G17 global controls, G18 notify about changes) and the project's AI rules (AGENTS.md, [ai-permissions.md](ai-permissions.md)):

- **Capability honesty (G1/G2).** Label simulations "Preview only" and disabled dispatch "AI requests are off". "Configured" never implies reachable or working. Do not show an Assistant destination until execution exists.
- **Routing explanations (G11).** Show labels involved, rule applied, destination alias, and the block reason in plain words with the code as secondary text. Never show private text in history views.
- **Change receipts (G16/G18).** Future automatic calendar changes appear in an Activity list with before/after values, actor (You/Assistant), time, and Undo where supported. A model statement is never shown as a receipt.
- **Email approval.** Send/invite/cancel approvals show sender, recipients, subject, full body and attachments list, bound to that exact version; editing the draft invalidates approval. Approve and Reject are equally prominent; nothing auto-approves.
- **Global controls (G17).** One Settings › AI page holds routing permissions, spending limits, provider status and history. A single visible "AI requests: Off" state appears there.
- **Labels are owner actions.** The label control never suggests a label from content.
- **Untrusted content.** Imported text (Canvas descriptions, future email) renders as plain escaped text, visually distinct (quoted block with source chip), never as instructions or buttons.

## 9. Accessibility (target WCAG 2.2 AA)

- Semantic landmarks: one `header`, `nav`, `main` per view; skip link retained. Each view sets a unique `<h1>` and `document.title`, and moves focus to the `<h1>` (or `main`) after navigation.
- Full keyboard operation with visible 3 px focus outline (2 px offset) in both themes; focus never hidden behind the fixed bottom bar or header (2.4.11) — set `scroll-padding` accordingly.
- Dialogs: native `<dialog>` with `showModal()`, labelled, focus returned to the trigger. Background `inert`.
- Targets per §4; no drag-only actions (2.5.7); no cognitive tests at login and allow password managers/paste (3.3.8); don't require re-entering known data (3.3.7) — e.g. Plan study pre-fills class/topic/title.
- Live regions: one polite region for sync/status updates, assertive only for new user-caused errors.
- Calendar: the agenda (list) view is the default and the accessible primary view; the week view is a visual alternative, structured as labelled day sections, not a grid of positioned boxes ([Google Calendar guidance](https://support.google.com/accessibility/answer/6101541?hl=en)).
- Text resizes to 200% (browser) and 130% (Android text zoom) without loss of content.
- Test with keyboard only, NVDA + Chrome on Windows, TalkBack on the Android emulator, and axe in Playwright.

## 10. Copy

- Sentence case. Titles are nouns ("Tasks"), buttons are verb + object ("Add task", "Load latest version", "Delete class").
- Avoid internal terms in primary UI: "operation", "version", "tombstone", "preflight", "receipt", "alias", "provenance". Use them in Help or detail rows only where the owner needs them to diagnose. ("Preflight" becomes "Request check".)
- Times: relative when near ("Today 2:00 PM", "Tomorrow"), absolute otherwise; always show the timezone when it differs from the viewing timezone.
- No marketing, welcome or encouragement copy (D28).

## 11. Engineering rules for UI code

- Shared contracts and relative `/api` URLs only; no new client-side business rules that duplicate server validation beyond immediate form checks.
- One mutation helper owns operation IDs, lost-response retry reuse and conflict handling (`useMutation`-style hook); components do not reimplement `pending.current` logic.
- One query helper owns abort, cached/offline fallback, freshness metadata and reload (`useResource`). Screens never set a global `busy` for unrelated controls.
- Components are small and typed; no component over ~250 lines. CSS uses tokens and one class per component namespace (`.task-row`, `.task-row__meta`), co-located files.
- Prefer native elements before ARIA. Add a headless library only if a needed widget (combobox, menu) cannot be built accessibly in < 150 lines; if added, prefer React Aria components imported per-widget and measure bundle impact ([comparison](https://www.pkgpulse.com/guides/react-aria-vs-radix-primitives-2026)).
- Performance budget: initial JS ≤ 250 kB minified for the Today route; route chunks lazy-loaded and **precached for offline** (see plan). Measure on the emulator with CPU throttling.
- Every state in §7 that a screen can reach has a Playwright test; selectors use roles and accessible names so visual changes don't weaken assertions (ledger rule).

## 12. Review checklist (per screen)

- [ ] Works at 320 px, 1280 px, standard and e-ink, 200% zoom; no horizontal overflow.
- [ ] All targets ≥ 44 px (48 px e-ink); no drag-only actions; no color-only meaning.
- [ ] Loading, empty, error, offline-cached, offline-uncached, conflict states designed and tested.
- [ ] Drafts survive conflict, lost response and reload; Save disabled while reloading versions.
- [ ] Keyboard path complete; focus visible and managed; screen reader names correct.
- [ ] No animation in e-ink; no timer-driven repaint of content.
- [ ] Copy follows §10; Help is a single consistent toggletip.
- [ ] Ledger updated with any contract, state or limitation change.
