# UI rework: Today, Assistant, Calendar

Date: 2026-10-14. Status: approved in conversation; this is the written spec for review.

## Intent

The owner finds three screens hard to use:

- **Today** is clunky. It splits "what's due today" between the schedule (Canvas deadlines) and a separate "Due today" box (tasks).
- **Assistant** needs a cleaner, more readable layout.
- **Calendar** blends together. The owner wants a Proton Calendar–style view.

This is a layout and readability rework. It adds no new data, endpoints or migrations. Existing contracts, privacy rules, offline caching, accessibility checks (WCAG 2.2 AA, 44/48 px targets, no overflow at 320 px), e-ink mode and dark theme must keep working.

Owner decisions (2026-10-14):

- Today answers "what do I need to do today" first.
- Quick capture and the Assistant quick ask become one bar.
- The Assistant uses a chat-app layout.
- The Calendar uses a Proton-style shell and opens on the Week time grid.

Delivered as three PRs in this order: Today, Assistant, Calendar. Each updates `docs/ui-agent-ledger.md` and its tests.

## 1. Today

Layout, top to bottom:

1. **Command bar**: one input with a two-option toggle, **Add task** (default) and **Ask assistant**.
   - Add task keeps today's quick-capture behavior and offline queueing.
   - Ask assistant posts to a new conversation (honoring the saved Use mail choice) and navigates to `/assistant/:id`, where the answer and proposals appear. Without a server key, the toggle's Ask option is disabled, with a Help tip.
   - The toggle choice is remembered on the device.
2. **Overdue**: shown only when there are overdue open tasks or failed reminders. It is a red-edged card with one row per item and links to Tasks and Inbox.
3. **Today**: one list for the local date, replacing "Today's schedule" and "Due today".
   - Order: all-day Canvas deadlines and tasks due today, then all-day events, then timed events and study blocks by start time.
   - Each row has a time column ("All day", "Due today" or a time range), a title, and a type tag: Deadline, Task, Event or Study.
   - Task rows link to the task; event rows link to the calendar editor.
   - The empty state reads "Nothing due or scheduled today."
   - Per-source failure and retry messages stay; a failed source doesn't hide the others.
4. **Next 7 days**: a collapsed disclosure showing a count; it expands to the existing upcoming-task list.
5. **Unread reminders**: a collapsed disclosure showing a count; it expands to the latest three with "View all reminders".

Removed:

- The separate Assistant panel and its inline answer on Today. Answers live on the Assistant page.
- The timezone line, which moves into Help.

## 2. Assistant page

Chat-app layout:

- **Conversation list** on the left (about 16rem): New conversation and titles with relative times. Below 1024 px it collapses behind a "Conversations" button that opens a panel. The current conversation is highlighted.
- **Thread**:
  - Your asks are right-aligned accent bubbles.
  - Replies are left-aligned subtle bubbles.
  - The reply holds the error or reason, the reply text and a **changes card**: checkboxes, Apply, Undo, and applied/undone/failed states, using the existing stored item states.
  - Under each reply is one muted **details** line: model · cost · "N messages sent ▸" · "M left out". It expands to the sent-mail list and the counts.
  - Mail notes (stopped early) stay visible as alerts.
- **Composer** is pinned to the bottom of the thread: textarea (Enter asks, Shift+Enter adds a line), Use mail checkbox and Ask.
- **Header** of the thread: title, Delete, and the month's spend in a muted line.
- The thread scrolls to the newest turn after an answer arrives. Focus returns to the composer.
- The behavior is unchanged: storage, retries, write IDs, version conflicts and deletion.

## 3. Calendar

Proton-style shell:

- **Sidebar** (about 15rem, ≥1024 px):
  - **New event**.
  - A **mini month** that navigates to a date.
  - **Show** toggles for Events, Study blocks, Canvas deadlines and Task due dates, remembered on the device.
  - The existing time-zone control.
  - Below 1024 px the sidebar collapses behind a "Calendars" button.
- **Top bar**: Today, ‹ › (step by the current view's span), the date-range title, and a **Day / Week / Month / Agenda** segmented control.
- **Week** (default; the route without `view=` means week from now on, and `view=agenda` keeps today's agenda list):
  - 7 day columns, a time gutter, and hour rows from 00:00 to 24:00. On open, it scrolls to 07:00 or the first event.
  - Timed events are absolutely positioned blocks sized by duration. Overlapping events split the column width.
  - An all-day strip at the top holds all-day events, Canvas deadlines and task due dates.
  - A "now" line shows on today's column.
  - Clicking a block opens the existing editor route. Clicking an empty slot opens New event prefilled with that hour.
- **Day**: the same grid with one column. This is the default below 640 px.
- **Month**: a 6×7 grid with up to 3 chips per day and "+N more", which opens Day for that date. Today is highlighted.
- **Agenda**: the existing list view, kept as is (including batch selection).
- **Colors**: one token per source. Events: accent. Study: violet. Canvas: orange. Tasks: gray. Each is a light and a dark variant meeting 3:1 for blocks and 4.5:1 for text on the block. E-ink uses black outlines plus a text type label, no color.
- **Data**: the same occurrences, Canvas and tasks requests, with range = the visible span.
- **Unchanged**: the editor, recurring-occurrence handling, Recently deleted, batch selection (Agenda only), and URLs for editor routes.
- **Routes**: `calendarViews` gains `month`; the default view becomes `week`.

## Testing

- **Today**:
  - The merged list order and types.
  - Overdue only when relevant.
  - Both bar modes. Add queues offline; Ask navigates to the Assistant.
  - Collapsed sections.
  - Per-source failure.
- **Assistant**:
  - Bubble roles.
  - The changes card applies and undoes.
  - The details line expands to the sent mail.
  - Collapsing the list on narrow screens.
  - The existing page tests are kept.
- **Calendar**:
  - The default week grid.
  - Block placement for a known event, plus an overlap case.
  - The all-day strip includes Canvas and tasks.
  - Show toggles.
  - Month "+N more" opens Day.
  - The mini month navigates.
  - The slot click prefills New event.
  - Agenda batch selection still works.
  - Router tests for `month` and the new default.
- **All three**: added to the accessibility sweep (standard 1280 px and e-ink 320 px) and to the dark contrast sweep.

## Out of scope

- Drag to move or resize events.
- Multiple user calendars or colors per calendar.
- Search.
- New assistant capabilities.
- Changes to data, contracts or the server.
