# AI task suggestions from mail

Implemented 2026-10-13 (plan step 5, grounded proposals). In an open message, **Create task from mail › Suggest tasks with AI** asks OpenRouter for up to five tasks. A suggestion only fills the existing manual capture form ([mail-tasks.md](mail-tasks.md)): the owner reviews the title and quote, and a suggested deadline arrives unconfirmed, so **Create task** stays disabled until **I checked and confirm this deadline** is ticked. Nothing is created automatically.

## Route

`POST /api/v1/email/messages/:id/task-suggestions` `{ operationId, expectedVersion, timeZone }` → `mailTaskSuggestResponseSchema`: `{ request | null, blocked }`.

- Eligibility is the same as category suggestions ([mail-classification.md](mail-classification.md)): Restricted never, Personal only with the owner's switch, verified body origin only, current version only. A blocked message returns `request: null` with the reason: no hold, no request, no charge.
- Sent: sender, subject, sent (or received) date, the stored body (up to 32,000 characters), the owner's local date and time zone (for words like "Friday"). No message ID, folders, recipients or attachments.
- The model must return each task's supporting quote verbatim. The server keeps only suggestions whose trimmed quote occurs literally in the stored body and whose date is a valid calendar date; the rest are dropped and counted. The capture route then re-verifies the quote against the latest body when the owner creates the task.
- Shared live lifecycle (`apps/api/src/ai/live-request.ts`, request `kind = 'mail-tasks'`, migration 054): worst-case hold within spending limits, uncertain before sending, one pinned no-fallback zero-retention exchange, settlement at the reported cost, kept hold when unknown. Suggestions are returned once and never stored; a retried operation never resends.

## Validation

API tests: exact-quote filtering (paraphrases and invalid dates dropped), ID-free payload, capture of a kept suggestion through the manual route, blocked Restricted mail, no-resend retries and version changes. Browser test: a suggestion fills the form, the deadline stays unconfirmed and the button disabled until confirmed, then the task is created. No real provider or paid request was used.

## Known limits

One message at a time, no automatic scanning, no calendar events or reminders, and mail-derived tasks stay withheld from AI context.
