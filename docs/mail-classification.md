# AI mail category suggestions

Implemented 2026-10-13 (plan step 5, AI filtering; D52). In Inbox › Mail, **AI suggestions** sends selected messages to OpenRouter and returns one suggested category per message with a short reason. Nothing is categorized until the owner applies suggestions; applied suggestions are saved as ordinary owner categories (`PUT /api/v1/email/messages/:id/category`, `mode: 'owner'`) with the version the model saw, so a message changed in between is a conflict, not an overwrite. Categories never change labels or routing ([mail-organization.md](mail-organization.md)).

## Owner decision (2026-10-13)

OpenRouter is allowed for Personal-labeled mail, by an explicit owner switch: Settings › AI › Assistant › **Allow Personal mail for category suggestions** (`allowPersonalMail`, default off, versioned with the assistant settings). Restricted mail is never sent. Unlabeled mail needs no switch.

## Route

`POST /api/v1/email/classify` `{ operationId, messages: [{ id, expectedVersion }] }` (1–20 distinct) → `mailClassifyResponseSchema`: `{ request | null, blocked }`.

- Each selected message is checked in one read: the strongest of its own and its connector's label decides. `blocked` lists `restricted`, `personal-not-allowed`, `provenance` (no `message-body-v1` declaration; older imports stay blocked as in [ai-mail-context.md](ai-mail-context.md)) and `changed` (missing or a different version).
- If nothing is eligible, `request` is null: no hold, no request, no charge.
- Eligible messages are sent with refs (`m1`…) instead of IDs: sender, subject, received date and the first 3,000 characters of the stored text. Recipients, folders, Message-IDs, attachments and connector data are not sent. The system prompt treats message text as data.
- The request uses the shared live lifecycle (`apps/api/src/ai/live-request.ts`, also used by the Assistant): price check, worst-case hold within the per-request and monthly limits, uncertain before sending, one pinned no-fallback zero-retention exchange with strict JSON-schema output, then release, settlement at the reported cost, or a kept hold when the outcome is unknown. Request rows (`kind = 'mail-classify'`, migration 053) keep metadata only; suggestions are returned once. A repeated operation ID returns the receipt without calling the model; a changed selection under the same ID conflicts.
- Suggestions with unknown or repeated refs are dropped and counted.

## UI

The **AI suggestions** section sits under Rules in Inbox › Mail and works on the current selection (at most 20).

- **Suggest categories for n** shows any "Not sent" messages with their reasons, then model, cost and outcome. For an unknown outcome it shows the held amount and says nothing is resent.
- **Suggested categories** lists one checkbox per suggestion, selected by default ("Subject → Category"), with the model's reason. **Apply n categories** saves them one at a time; each line then shows Applied or Not applied with the reason.
- A different selection clears the suggestions. Mail's post-apply refresh keeps the result visible.

Costs under one cent are shown to the microdollar (for example $0.00015), so small charges never display rounded down.

## Validation

API tests cover: label and provenance blocking (with blocked text absent from the request), the Personal switch, ID-free pinned payloads, unsaved suggestions, dropped refs, retries without resending, changed versions, and invalid output being charged. Browser tests cover review then apply through the real category route (with the classify endpoint stubbed) and the settings switch. No real provider or paid request was used.

## Known limits

No automatic or background classification, no batch beyond 20, no suggestions for deadlines/tasks yet (manual capture exists in [mail-tasks.md](mail-tasks.md)), and older imports need a re-import to become eligible.
