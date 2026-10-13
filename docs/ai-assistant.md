# Planner assistant (first live AI flow)

Implemented 2026-10-13 (plan step 4, D47). The **Assistant** box on Today turns a natural-language request into proposed task and event changes through OpenRouter. Nothing changes until the owner applies the proposals; applied changes use the ordinary versioned planner writes and can be undone. This is the only feature that sends requests to a provider. The older routing, preflight and synthetic request machinery is unchanged and still not used for dispatch.

## Owner decisions (2026-10-13)

- Review, then Apply: the model only proposes; the owner selects and applies.
- Personal/Restricted items are left out of the context (no confidential provider exists yet); the response reports how many were withheld. The model cannot change them.
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
- `POST /api/v1/assistant/requests` `{ operationId, text (1–1000), timeZone }` → `{ request }` (`assistantRequestSchema`).

## Request lifecycle

1. A repeated `operationId` with the same text/timezone returns the stored receipt (`resultAvailable: false`) and never calls the model again; a changed payload returns `OPERATION_CONFLICT`.
2. The model's price comes from OpenRouter's public catalog (cached for an hour, no key or owner data sent). Missing, non-text or variable-price models return `ASSISTANT_MODEL_UNAVAILABLE`; a failed catalog read returns `ASSISTANT_CATALOG_UNAVAILABLE`. Nothing is held or sent in either case.
3. Context: up to 150 open tasks (title, due date, priority) and up to 150 one-time events from one day ago to 30 days ahead (title, local start/end), with refs (`t1`, `e1`) instead of IDs. Notes, repeating events, completed tasks and labeled items are excluded.
4. A worst-case charge is computed (every request byte as a prompt token + 500, the full 1,500-token output allowance, any per-request fee, +25%) and reserved in the existing budget ledger. Per-request and monthly limits apply (`REQUEST_BUDGET_EXCEEDED`, `MONTHLY_BUDGET_EXCEEDED`). The reservation is marked uncertain and the request row inserted in the same transaction, before transmission.
5. One request: pinned to the author's first-party upstream (`only`/`order`), `allow_fallbacks: false`, `require_parameters: true`, `data_collection: deny`, `zdr: true`, response caching disabled, strict JSON-schema output, `usage.include`. No tools, no retries, no redirects, 45-second timeout, 256 KiB response limit.
6. Settlement:
   - 400/401/402/403/404/413/422/429 are refusals before processing: the hold is released and the request is `failed` with a reason (`unauthorized`, `payment-required`, `unavailable`, `rate-limited`, `rejected`).
   - Reported usage settles the reservation at the exact reported cost (decimal lexeme, rounded up to microdollars). The request is `completed`; `reason` is null, `invalid`, `provider-error` or `blocked` (refusal, truncation, non-text parts, a different model or a cache hit).
   - Timeout, transport failure, unreadable responses or missing cost leave the request `uncertain` and the full hold in place. Nothing is resent; there is no automatic reconciliation yet.

## Proposals

The model may return up to 10 actions; each is checked and converted server-side, invalid ones are counted as `dropped`:

- `task.create` (title, due date, priority, notes) and `task.update` (title, due date or clear, priority, completed) of a context task.
- `event.create` (timed local start/end in the request timezone, end defaulting to +1 hour; or all-day with an inclusive last day) and `event.update` (title, start/end of a timed one-time event; moving only the start keeps the duration).
- Skipped local times (DST gaps) are rejected; repeated times use the earlier offset only through `disambiguation: 'reject'`, which also rejects them.

Updates carry the full record the model saw. Apply sends the ordinary `PUT /api/v1/tasks/:id` or `PUT /api/v1/calendar/:id` with that version, so a change made in between returns a conflict instead of being overwritten. Creates use `POST`. Each write has its own stable operation ID. Undo deletes created items and restores updated ones to their previous fields, newest first. Apply and Undo are online-only and never queued.

## Storage and retention

Migration 046 adds `ai_assistant_settings` and `ai_assistant_requests`. Request rows keep metadata only: operation ID and payload hash, model, reservation, status/reason, generation ID, token counts, cost, proposal/dropped/withheld counts and timestamps. The prompt, reply and proposals are returned once and never stored. These tables are not yet in the portable export.

## Validation

API tests inject the provider exchange and forbid global fetch: missing key, unset budget, context withholding and ID-free payloads, pinned no-fallback request, proposal conversion and dropping, exact cost settlement, no-resend retries, operation conflicts, refused/uncertain/invalid outcomes, per-request limit and model settings. Browser tests cover the not-set-up state, model save, apply/undo through the real planner endpoints with the assistant endpoints stubbed, and conflict handling. No real provider or paid request was used.

## Known limits

No request history view, no reconciliation of uncertain holds, no repeating-event or delete actions, no labeled-item support, no memory or academic context, and no export of assistant records.
