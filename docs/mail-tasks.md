# Tasks from mail

Implemented: owner-reviewed task capture from an imported message body. This is manual capture; automatic extraction, AI classification and provider execution remain pending.

In Inbox > Mail, open a message and expand **Create task from mail**. Enter a title, copy an exact supporting quote from its body and optionally enter a deadline. A date requires **I checked and confirm this deadline**; no deadline is inferred. The task editor exposes **Mail source**, the exact captured quote, original message version, inherited labels, confirmed date at creation and a link back to the message. Subsequent task edits do not rewrite that capture.

## Durable contract

`POST /api/v1/email/messages/:id/tasks` requires owner authorization, `operationId`, `expectedVersion`, title and a nonblank exact body quote of at most 2,000 characters. Optional task fields are notes, priority, date and client UUID. A nonnull date requires `deadlineConfirmed: true`. No completion, sensitivity, source, attachment or AI fields are accepted. Responses and retry receipts contain only task/message IDs and the initial task version; private quotes and titles are not copied into receipts.

The transaction holds the owner schedule lock and shared message/connector locks, verifies ownership and the message version, and requires `message-body-v1` provenance. The quote must occur literally in the imported body, with no normalization, paraphrase acceptance or attachment search. Duplicate occurrences do not identify a particular position. Quotes from a shortened body are allowed only within its imported text. Legacy imports without body-origin declarations are blocked rather than certified by owner review.

Task creation and its source capture commit atomically. Identical retries return the original metadata without a second task; a changed payload under the same operation ID conflicts. An optional reused client UUID conflicts. Capture rows have owned foreign keys and database guards for body origin, exact supporting text, versions and inherited message/connector labels. Captures cannot be updated or deleted; ordinary planner deletion retains a tombstone and restore retains the capture. Task privacy cannot be lowered below retained source labels. The task schema/export includes `mailSource`; older tasks default to null. Migration 052 is append-only.

Mail-derived tasks are withheld from the narrow Today Assistant even when unlabeled. The general gateway rejects these task references until derived-mail integrity binding is implemented; an explicitly selected original message still uses the verified mail context contract. No text is transmitted or model request performed by capture.

## UI states and limits

Capture is online only and uses the existing idempotent mutation tracker. Pending creation locks mail selection/category controls. Failures retain the draft. Reloading a changed message retains the draft and requires deliberate **Use reviewed message version**; that action clears deadline confirmation. A failed refresh keeps the existing message/form visible and disables writes until Retry succeeds. A successful capture shows **Open task** and prevents accidental second submission from the same form.

Drafts are in memory only and are lost on navigation, tab closure or reload. Capture does not deduplicate deliberate separate task operations by semantic meaning or quote, infer dates/time zones, reserve study time, create reminders or calendar events, send mail or alter Proton. The source quote remains private owner data, including in planner export and owner-scoped task caches. It is retained with task history rather than claiming permanent erasure.
