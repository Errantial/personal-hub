# Mail categories and explicit rules

Implemented 2026-10-13. Inbox Mail now organizes imported messages inside the hub, with owner corrections and explicit local rules. This enables no paid classification, AI requests, Proton label/move/delete operations or email sends.

## Category behavior

Categories are Actionable, Academic, Personal, Receipts, Newsletters and Possible spam, plus Uncategorized. They are separate from the message's privacy label. Neither a category nor a rule infers sensitivity, changes inherited labels or authorizes a provider.

Saving a category is a versioned owner choice, including an explicit Uncategorized choice. Rules preserve that choice. **Use rules** clears the override and category; the owner then previews and applies rules to selected mail. Connector refreshes never replace categories or owner corrections. Category changes increment the message version, invalidating stale organization writes and pending AI source references.

## Rule behavior

Rules match either a complete sender address or a literal subject phrase, ignoring case. There are no regexes, wildcard/domain matches, body scans or attachment processing. The oldest matching enabled rule wins, with ID as a deterministic tie-breaker. The displayed list uses that same order. Up to 200 active rules are allowed; each rule has an owned version, and every change advances the owner's rule revision.

Rules run only on explicit selections of at most 100 messages. Preview is write-free and reads one repeatable snapshot. Apply validates the preview's rule revision and every selected message version before changing anything, using deterministic row locks and an atomic repeatable-read transaction. Rolled-back serialization/deadlock conflicts can retry through the existing receipt helper; committed applies never run twice. Owner overrides remain protected. A foreign/missing message, stale version or stale rule revision rejects the whole apply. New mail and rule edits do not run rules automatically.

When no enabled rule matches, applying the preview clears a previous rule category. It preserves an owner-selected category. Unchanged classifications do not bump message versions. A changed matched-rule version updates the captured explanation even when its category is unchanged.

Applied categories retain the rule's ID/version, name, field, match and category as an owned snapshot. Editing or deleting that rule does not rewrite the earlier explanation. Rule deletion is a versioned tombstone; existing rule categories remain until the owner explicitly applies rules again. Message bodies, subjects and sender addresses are not copied into mutation receipts; receipts contain IDs, versions, revisions and category metadata only.

## Contracts

- `GET /api/v1/email/rules`: active rules and revision; `POST`, `PUT /:id`, `DELETE /:id`: operation IDs, expected revision, and expected rule version for edits/deletes.
- `POST /api/v1/email/rules/preview`: selected `{ id, expectedVersion }` references, returning revision and category decisions without saving a preview.
- `POST /api/v1/email/rules/apply`: selected references, `expectedRevision`, `operationId`; returns metadata-only results. Exact retries do not reapply or increment versions twice.
- `PUT /api/v1/email/messages/:id/category`: `operationId`, `expectedVersion`, and either `mode: owner` with a nullable category or `mode: rules` to clear the override.
- Mail list filtering adds `category`, including `uncategorized`, alongside existing folder and cursor filters. Mail list/detail expose category origin and captured rule explanation.

All reads and mutations require owner authorization. Upload tokens cannot manage rules or categories. Mutations recheck sessions inside the receipt transaction. Migrations 049–051 add organization state, retained rule captures and SQL capture integrity without changing applied migrations.

## UI and limits

Inbox Mail has a category filter and selection checkboxes. **Mail rules** expands the rule list/editor, preview and explicit Apply controls. A changed selection or rule revision invalidates a pending preview; late responses cannot replace newer selection state. Category corrections live in message detail, with protected-origin and captured-rule explanations. Errors retain drafts; deliberate reload/cancel/reopen uses the latest versions.

Organization is online-only. Category/rule offline writes, search, rule reordering/restoration, automatic ingestion classification, portable export, grounded deadline extraction and approved-provider AI classification remain pending. Existing mailbox completeness, live upload and scheduling gates remain unchanged. See [verified mail context](ai-mail-context.md) for future paid processing boundaries.
