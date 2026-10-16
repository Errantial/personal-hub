# Editable owner memory

Backend implemented 2026-10-11: explicit owner-entered preferences, goals and facts; versioned correction, per-record/global disable controls, guarded browsing, metadata-only retry receipts, content-clearing forget tombstones and portable export. Migration 033 adds owned memory/settings tables. The owner editor, global/per-record enable controls and forget flow were integrated into main in the 2026-10-13 UI batch and are included in deployed release `519054d`. Explicit versioned references exist in the separate verified-context gateway, whose dispatch remains disabled. Live per-ask selection, automatic extraction/retrieval, model writes, embeddings and MCP memory tools remain pending. Memory enabling does not start a provider call. Assistant conversation retention is a separate feature and does not imply memory retrieval.

## Records and settings

Kinds describe saved text only. A goal does not change study-plan weekly goals or class progress; a preference does not automatically change app settings; a fact is not verified provider evidence. All other planner/settings operations remain separate explicit actions.

Input fields: kind=preference/goal/fact, title (trimmed 1–160 characters), content (trimmed 1–4000 characters), observedOn (valid owner-entered date or null), enabled (default true) and sensitivity (default unlabeled). Null characters and unknown fields are rejected. Attachments, source links/descriptors, derived-source manifests, credentials and client-supplied label history/source/timestamps are unsupported. Text is plain text; never render it as trusted HTML.

The server assigns source=owner-entered, UUID, version 1 and createdAt/updatedAt. observedOn is the owner's declared date, not verified provider evidence; createdAt is the server recording date. Current sensitivity is owner-applied. Every save retains the unique set of all previously applied labels plus the current label, even after changing kind/text or weakening the displayed label. No automatic classification or label-history reset exists. Future derived context must inherit every applicable label.

Global settings default `{ version: 1, enabled: false }` without creating a row on reads. Settings and record versions advance separately. Disabled storage remains inspectable/editable/exportable; disabling does not erase content. Neither enabling settings nor enabling a record verifies text provenance or starts AI retrieval/execution. Owner-entered text can have unknown/attachment-derived origin; only the verified-context gateway's allowlisted, versioned owner-entered projection supports explicit memory references; unknown/attachment-derived inputs must not be admitted as trusted context. Live Assistant memory access remains unavailable. Do not copy it into model context by bypassing the gateway.

## Operations and retry behavior

| Endpoint | Input/result |
| --- | --- |
| GET `/api/v1/memory/settings` | Current owned version/enabled |
| PUT `/api/v1/memory/settings` | operationId, expectedVersion, enabled; returns settings |
| POST `/api/v1/memory` | operationId plus complete input fields; returns metadata receipt |
| GET `/api/v1/memory/:id` | Full owned record or text-free forgotten tombstone |
| PUT `/api/v1/memory/:id` | operationId, expectedVersion plus complete replacement fields; returns metadata receipt |
| DELETE `/api/v1/memory/:id` | operationId, expectedVersion; forgets logical text and returns metadata receipt |

All private reads/writes require owner authorization. Missing/foreign IDs return 404; version conflicts return 409. Settings default/current-version updates and record changes use durable atomic mutation receipts. Record row locks serialize edits/forgetting; failures roll back text changes, labels, tombstones and receipts. Forgotten records reject new update/delete operations with MEMORY_FORGOTTEN. There is no restore endpoint; saving again requires a deliberate new record/operation ID.

Memory mutations return only `{ memory: { id, version, deletedAt } }`. Title/content are never copied into mutation receipt results. Refresh detail after a save to obtain normalized current fields; preserve the receipt for a lost-response retry. Exact successful retries return historical metadata, including after forgetting/restart, without rewriting records. Reusing a successful operation ID with changed input returns OPERATION_CONFLICT. A historical receipt does not establish current existence, enable state or version. Settings retries likewise return historical settings; refresh current settings afterward.

## Explicit AI context selection (2026-10-11)

[Verified context](ai-verified-context.md) now supports explicit memory references with both record and global-settings versions. Both must be enabled and the owned record must be nonforgotten. Only allowlisted owner-entered text is projected; complete label history controls routing. Admission and final synthetic callback checks invalidate changed/disabled/forgotten context. No automatic selection, extraction, embedding or retrieval index is enabled. Live AI and UI selection remain pending.

## Forgetting and retention limits

Forgetting clears title, content and observedOn, disables the record, increments version and retains deletedAt plus metadata/label history. Active/disabled browsing and literal text search no longer find that content. Detail/export/forgotten pages expose a text-free tombstone. No memory revision text history or retrieval/index copies are created; metadata-only receipts contain no earlier text to disclose or restore. A stale save cannot resurrect the record. Existing planner/email records and their receipts are not erased by forgetting a memory.

This removes logical memory text from current application records/export, not forensic erasure of database pages/WAL, pre-existing backups, downloaded exports, other-device/user copies or independently saved duplicate records. Mutation payload hashes and category/labels/IDs/timestamps remain. Backup retention, physical erasure and distributed cache invalidation remain unresolved. Keep these limits visible in the forget flow. Future retrieval/index/derived-context integration must remove its active copies transactionally and recheck tombstones/versions before model disclosure; this slice does not establish that integration.

## Browsing and export

GET `/api/v1/memory` accepts state=active/disabled/forgotten/all (default active), optional kind/current sensitivity, optional trimmed q (1–100 characters), limit 1–100 (default 25), and paired after UUID/expectedCursorVersion. Search is literal case-insensitive title/content substring matching; wildcard characters have no pattern meaning. No snippets/content are returned, and search terms are not persisted. Forgotten text/date cannot match search after clearing.

Pages contain memories (metadata and title, no content), settings, independent counts for active/disabled/forgotten under the kind/sensitivity/q filters, and nextAfter `{ id, version }` or null. Counts ignore the chosen state/page. Active means stored, enabled and not forgotten; it does not mean currently used by AI, and is independent of the global setting. UUID ascending pages validate owned eligible cursors: missing/foreign/filter-ineligible anchors return 404 and changed eligible anchor versions return 409. Pages are consistent owned read-only snapshots, with session rechecks, not frozen multi-page history. Switching filters resets the cursor; guard delayed responses in the UI.

Portable format-v1 export adds memories and memorySettings. Old files parse with empty memories/null settings. Current export includes disabled text and forgotten metadata under existing 10000-row/16 MiB bounds; oversized exports fail without a partial result. Source/recording date and all labels are preserved. The original backend/export slice added no import, offline cache/outbox or UI. The later owner editor is online-only; these export limits still apply.

## Validation and pending work

Nine isolated synthetic tests pass for field boundaries, owned text/metadata receipts, conflicts/concurrent retries, complete labels, settings/disable independence, rejected malformed AI references, logical forgetting/historical retries, guarded literal-search pages/full counts, owner/session/origin isolation, forced rollback/SQL states, populated migration upgrade/export compatibility and persisted restart. Fetch is forbidden; memory or isolated `.artifacts` databases are used. The owner's database and real providers are untouched.

Optional standard PostgreSQL coverage adds duplicate creates/forgetting, historical retry and text-free export using the disposable test schema; it remains unverified locally while TEST_DATABASE_URL is unset. Full npm run check passed lint, strict types, formatting, production builds and 287 API/client tests; one optional standard PostgreSQL test was skipped. Browser tests were not rerun because UI/authentication-layer code was unchanged. No owner database reads/resets, real providers, paid AI or device tests occurred. That receipt predates the later owner editor and does not describe its validation. Current pending work: live per-ask selection with history/derived-output revocation, automatic retrieval/index invalidation, memory proposals, retention/backup policy and actual memory use by AI. See the later UI receipts in [implementation-log.md](implementation-log.md); no new tests or live memory acceptance are claimed here.

## Explicit per-ask memory selection and history enforcement (P9, 2026-10-16)

The owner can explicitly attach up to 10 active memory items to an Assistant ask through `<AssistantMemoryPicker>`.

1. **Version pinning:** Selections pin both `expectedVersion` of the memory record and `expectedSettingsVersion` of global memory settings. If either version changes, or if the memory item or global memory is disabled, or if the item is forgotten, the ask blocks immediately before placing a budget hold.
2. **Allowlisted projection:** Projected memory items (`memory-item-v1`, assigned `m1...` refs) contain only `ref`, `kind`, `title`, `content` and `observedOn`. Metadata and sensitive database columns never leave the server.
3. **Sensitivity withholding:** Memory items with privacy labels exceeding the approved live destination's sensitivity are withheld at preparation time and counted in `request.withheld`.
4. **Final transmission guard:** `transmitLive` re-verifies digest integrity, record version, global settings version, and label stability prior to provider transmission; unverified or altered items are withheld.
5. **Forget and disable history enforcement:** When a memory item is forgotten (`deleted_at IS NOT NULL`) or disabled (`enabled=false`), or when global `memory_settings.enabled` is false, historical conversation turns that referenced that memory item are immediately withheld by `historySourcesEligible` from future model prompts.
6. **No agent authority:** Scheduled and background agents have no memory read or write authority. Triggering an agent turn with memory selection returns HTTP 400 (`Agents do not have memory authority.`).
7. **Storage:** Migration 068 adds `memory jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(memory) = 'array' AND jsonb_array_length(memory) <= 10)` to `ai_conversation_turns`.
