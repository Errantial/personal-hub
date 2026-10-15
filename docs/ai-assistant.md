# Planner assistant (first live AI flow)

Implemented 2026-10-13 (plan step 4, D47). The Assistant on Today and its conversation page turn natural-language requests into proposed task and event changes through OpenRouter. Owner requests change nothing until Apply; changes use the ordinary versioned planner writes and can be undone. Since the P5/P6 boundary 2 slice, Apply and Undo are server-owned and derived records keep inherited labels and origin. The older general gateway remains separate from dispatch.

## Scheduled agents (D57, deployed 2026-10-14 as release 519054d)

Agents share `answerTurn`, privacy checks, text-only mail access, spending holds and conversation history with owner requests. Runs are turns with `trigger: 'agent'`; owner replies in pinned conversations steer later runs. Settings > AI > Actions governs automatic changes with Undo, ask-first proposals and dropped blocked proposals (`notAllowed`). Uncertain requests and expired leases are never resent. Open threads and agent states refresh periodically; failed prechecks stay visible even without a turn.

Inbox and Today link run notifications to retained conversations. Opening a conversation marks only its own notifications read, paging unread history (up to 10,000 rows per pass, with a visible warning at the limit). Read failures can be retried. Agent notifications never trigger browser alerts. See the [design and exclusions](superpowers/specs/2026-10-14-persistent-agents-design.md#out-of-scope-recorded-for-future-work); the first owner-created agent/run and live owner acceptance remain pending.

## Owner decisions (2026-10-13)

- Review, then Apply: the model only proposes; the owner selects and applies.
- Personal/Restricted items, source-linked records and unknown label history are left out of this initial context; the response reports how many were withheld. The model cannot change them. Richer source processing belongs to the verified context gateway.
- The assistant lives on Today; the model is chosen in Settings › AI › Assistant (default `anthropic/claude-haiku-5.5`).
- Spending: the existing $50 monthly ceiling and per-request limit (owner-set, $0.25 planned) apply.

## Server configuration

`AI_SECRET_OPENROUTER` in the server environment holds the OpenRouter key. It stays in server memory and is never returned, logged, exported or sent anywhere except as the bearer token to `https://openrouter.ai/api/v1/chat/completions`. Without it, the assistant reports "Not set up". Spending limits must also be saved in Settings › AI, otherwise requests stop with `BUDGET_UNSET` before anything is sent.

On the Oracle VM, add the key in your own SSH session (never in chat):

```sh
sudoedit /etc/personal-hub/hub.env      # add: AI_SECRET_OPENROUTER=sk-or-...
sudo systemctl restart personal-hub
```

Set an upstream credit limit on the OpenRouter key as a second boundary.

## Routes

- `GET /api/v1/assistant/settings` → `{ settings: { model, version, configured } }`. Unsaved owners get the default model at version 1. `configured` says only whether the key is present.
- `PUT /api/v1/assistant/settings` `{ model, expectedVersion }` → optimistic save; stale versions return `VERSION_CONFLICT`. Models must be `author/slug` from a supported author (Anthropic, OpenAI, Google, Mistral, xAI, DeepSeek), else `ASSISTANT_MODEL_UNSUPPORTED`. Availability is checked at request time.
- `POST /api/v1/assistant/requests` `{ operationId, text (1–1000), timeZone, conversationId? }` → `{ request, turn }`. `conversationId` continues a conversation or starts one under a client-made ID; omitted, the server makes one. A foreign or deleted conversation returns `NOT_FOUND` before anything is held.
- `GET /api/v1/assistant/conversations` → newest 100 with at least one turn: `{ id, title (first ask, 80 chars), turnCount, version, createdAt, updatedAt }`.
- `GET /api/v1/assistant/conversations/:id` → `{ conversation, turns }`; each turn has the ask, the request receipt with reply and proposals, and per-proposal `items` (`proposed`/`applied`/`failed`/`undone`, applied record, error, stored `applyId`/`undoId`).
- `DELETE /api/v1/assistant/conversations/:id` `{ expectedVersion }` → tombstone; turn text, proposals and items are cleared. Repeats succeed.
- `POST /api/v1/assistant/turns/:id/apply` and `POST /api/v1/assistant/turns/:id/undo` `{ expectedVersion, indexes, operationId }` → the server applies or undoes the selected saved proposals through the ordinary versioned planner writes and returns the updated turn. Stale versions return `VERSION_CONFLICT`; replaying an `operationId` returns the saved turn without a second write; a mail-derived (read-only) turn refuses Apply with `PROPOSAL_READ_ONLY`; an item that was never applied returns `NOT_APPLIED`. The server re-verifies each proposal's identity and origin before writing.
- `PUT /api/v1/assistant/turns/:id/items` `{ expectedVersion, items }` → only echoes the server's saved item state; any client-chosen state or write ID is refused with `SERVER_OWNED_APPLY` (or `PROPOSAL_READ_ONLY` first on mail-derived turns).

## Request lifecycle

1. A repeated `operationId` with the same text, time zone and conversation returns the stored turn and never calls the model again; a changed payload returns `OPERATION_CONFLICT`. A retry while the first attempt is still being answered returns `ASSISTANT_REQUEST_PENDING`.
   Follow-ups resend up to 10 earlier asks and replies (8,000 characters, newest kept) as plain user/assistant messages before the current context. Earlier proposals and context are not resent.
2. The model's price comes from OpenRouter's public catalog (cached for an hour, no key or owner data sent). Missing, non-text or variable-price models return `ASSISTANT_MODEL_UNAVAILABLE`; OpenRouter's public zero-data-retention endpoint list (same cache and rules) must show an allowed host serving the model with structured outputs, or the request returns `ASSISTANT_MODEL_NOT_PRIVATE`. A failed read of either list returns `ASSISTANT_CATALOG_UNAVAILABLE`. Nothing is held or sent in any of these cases.
3. Context: up to 150 open tasks (title, due date, priority) and up to 150 one-time events from one day ago to 30 days ahead (title, local start/end), with refs (`t1`, `e1`) instead of IDs. Notes, repeating events, completed tasks, labeled items, source-linked records and unknown academic label history are excluded.
4. A worst-case charge is computed (every request byte as a prompt token + 500, the full 1,500-token output allowance, any per-request fee, +25%) and reserved in the existing budget ledger. Per-request and monthly limits apply (`REQUEST_BUDGET_EXCEEDED`, `MONTHLY_BUDGET_EXCEEDED`). The reservation is marked uncertain and the request row inserted in the same transaction, before transmission.
5. One request: limited to the author's allowed hosts (`only`/`order`): Anthropic models on Anthropic, Google Vertex or Amazon Bedrock; OpenAI models on OpenAI or Azure; Google on Vertex; Mistral, xAI and DeepSeek on their own platforms. Clouds hosting another author's model were allowed in October 2026 because Anthropic and OpenAI offer no zero-retention endpoint of their own on OpenRouter; `allow_fallbacks: false`, `require_parameters: true`, `data_collection: deny`, `zdr: true`, response caching disabled, strict JSON-schema output, `usage.include`. No tools, no retries, no redirects, 45-second timeout, 256 KiB response limit.
6. Settlement:
   - 400/401/402/403/404/413/422/429 are refusals before processing: the hold is released and the request is `failed` with a reason (`unauthorized`, `payment-required`, `unavailable`, `rate-limited`, `rejected`).
   - Reported usage settles the reservation at the exact reported cost (decimal lexeme, rounded up to microdollars). The request is `completed`; `reason` is null, `invalid`, `provider-error` or `blocked` (refusal, truncation, non-text parts, a different model or a cache hit).
   - Timeout, transport failure, unreadable responses or missing cost leave the request `uncertain` and the full hold in place. Nothing is resent; there is no automatic reconciliation yet.

## Mail reading (D56)

With **Use mail** ticked (`useMail: true`; the box's state is saved as `useMail` in the assistant settings so every device shows it), one ask may take up to three calls, each reserved, sent and settled on its own (`planner-round` request rows linked through `ai_conversation_turn_rounds`, with operation IDs derived from the ask's):

1. The planner request plus a mail instruction. The model either answers, or returns 1–3 `mailSearch` terms with no actions.
2. The server searches subjects and sender name/address (literal, case-insensitive) over the owner's mail, newest first. It keeps up to 20 messages the labels allow: strongest of message and connector label, Restricted never, Personal only with **Allow Personal mail**, and verified body origin only. Matches kept out are counted, not described. Ref, sender, subject and date go to the model, which either answers or returns up to 5 `read` refs.
3. The chosen messages are re-checked and their bodies sent, cut to 6,000 characters; the model answers.

Unticked asks are a single call and never touch mail. Messages are passed as data with an instruction to ignore instructions inside them. The last usable answer is the turn's answer; its proposals are the only ones offered. If a later call is refused, fails or cannot be admitted (for example the monthly limit), the earlier answer stays and the turn's `mailNote` says why. The turn stores which messages were sent (`mail`: id, subject, sender, received, whether the body was read) and how many were left out (`mailWithheld`). The turn's receipt sums cost and holds across its calls and takes status and reason from the last call. Migration 056 adds these columns and the round table.

## Proposals

The model may return up to 10 actions; each is checked and converted server-side, invalid ones are counted as `dropped`:

- `task.create` (title, due date, priority, notes) and `task.update` (title, due date or clear, priority, completed) of a context task.
- `event.create` (timed local start/end in the request timezone, end defaulting to +1 hour; or all-day with an inclusive last day) and `event.update` (title, start/end of a timed one-time event; moving only the start keeps the duration).
- Skipped local times (DST gaps) are rejected; repeated times use the earlier offset only through `disambiguation: 'reject'`, which also rejects them.

Updates carry the full record the model saw. The server applies each selected proposal through the ordinary `PUT /api/v1/tasks/:id` or `PUT /api/v1/calendar/:id` with that version, so a change made in between returns a conflict instead of being overwritten; creates use `POST`. Each write has its own stable operation ID. Undo deletes created items and restores updated ones to their previous fields, newest first. Apply and Undo are online-only, never queued, and composed on the server from the saved proposal and its recorded origin — not from a client-supplied body.

## Output lineage

Migration 062 records durable output provenance. Each planner record created or updated by Apply inherits the answer's conservative label union (`ai_origin = 'bound-derived'`, `ai_labels`) and is linked to its turn in `ai_planner_origins`; the answer's source and label capture is kept once per turn in `ai_turn_origins`. Records written by hand are `owner-entered`; records that predate this migration are `legacy-unknown`. Triggers keep the inherited label floor and origin through ordinary edits, Undo, detach, deletion and restore, and propagate a later source relabel to dependent derived records — including tombstones. Because only fully bound answers carry a capture, a proposal whose origin or digest cannot be re-verified is refused rather than applied, and existing/legacy derived records stay ineligible for later inference. These rows hold no prompt, proposal, message or reply text.

## Storage and retention

Migration 046 adds `ai_assistant_settings` and `ai_assistant_requests`. Request rows keep metadata only: operation ID and payload hash, model, reservation, status/reason, generation ID, token counts, cost, proposal/dropped/withheld counts and timestamps. Since migration 055 (D55), `ai_conversations` and `ai_conversation_turns` keep each ask, reply, the proposals (including the target records as sent) and their applied/undone state on the owner's server, for use across devices, until the owner deletes the conversation; deletion leaves a tombstone and clears the text. Turns are written before transmission (ask only) and completed after settlement. Migration 062 adds the origin/label capture tables described above, which hold no ask, reply, proposal or message text and survive conversation deletion. These tables are not yet in the portable export.

## Validation

API tests inject the provider exchange and forbid global fetch: missing key, unset budget, context withholding and ID-free payloads, pinned no-fallback request, proposal conversion and dropping, exact cost settlement, no-resend retries, operation conflicts, refused/uncertain/invalid outcomes, per-request limit and model settings. Server-owned Apply/Undo tests verify idempotent operation IDs, version conflicts, refusal of forged client item state (`SERVER_OWNED_APPLY`), refusal of a proposal changed after capture, and that an applied record keeps `bound-derived` labels and its `ai_planner_origins` link after the conversation is deleted. Browser tests cover the not-set-up state, model save, Apply/Undo through the server-owned operations with a lost-response retry and no browser planner writes, and conflict handling. No real provider or paid request was used.

## Known limits

No mail search by body text or date, no conversation rename or search, no reconciliation of uncertain holds, no repeating-event or delete actions, no labeled-item support, no memory or academic context, and no export of assistant records.
