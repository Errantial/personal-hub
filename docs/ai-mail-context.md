# Verified mail context

Implemented 2026-10-13 as the original prerequisite for email classification through the provider-routing gateway. This slice added source resolution, bounded text assembly and integrity binding; by itself it did not enable classification, paid dispatch, background processing or provider-side mail changes. Later Assistant/mail-broker slices added separately gated live mail use without changing these provenance rules.

## Source contract

`mail-message` references use the message's owned `id` and `expectedVersion`, exposed by the Mail list/detail contracts. The gateway resolves both the stored message label and its connector's owner-selected label. Neither body wording nor model output infers sensitivity. All resolved labels must permit the selected provider; an unavailable approved destination blocks without falling back.

Migration 048 adds the message version and nullable `text_origin`. The updated authenticated Bridge collector declares `message-body-v1` after parsing headers and the message body separately from attachments. This is a declaration from the owner's scoped collector, not independent verification of delivery or a cryptographic attestation of the collector program. Upload-token access must remain private. Older collectors can still upload for local browsing, but missing declarations block AI context with `PROVENANCE_UNAVAILABLE`.

Existing imports are not backfilled or automatically certified. Re-uploading the same Message-ID with a new declaration does not replace its original text or upgrade unknown provenance. A deliberate legacy review/reimport workflow remains future work. A legacy record stays readable in Mail.

## Projection and binding

Only subject, From/To/Cc, sent/received timestamps, bounded body text and the `bodyTruncated` flag are projected. Folder names, Message-ID, raw MIME, attachment counts/names/content, connector names and credentials are excluded. Text attachments never become message body context. Truncation remains explicit; the gateway rejects an oversized combined envelope instead of assembling a partial source list.

The existing format-v1 manifest adds `mailConnector: { id, version }` only for mail sources. Non-mail manifests omit it, preserving old context bindings. Each mail fragment binds the message ID/version, connector ID/version, complete labels and projected character count. Folder-membership refreshes do not change the projected source text or message version.

Owned source resolution and assembly share a repeatable snapshot. Existing request integrity hashes bind the exact payload and manifest; prompts and message bodies are not copied into preflight/request records or operation receipts. Admission and synthetic final callback checks re-resolve the same sources. Modified text is detected even without a message-version increment. Connector revocation increments its version and invalidates pending bindings; stored mail remains available for a deliberate new assessment, while its upload token remains revoked.

## Boundaries and next work

The general gateway context preview remains transient, `no-store`, owner-authorized and dispatch-disabled. The live Assistant has a separate, explicitly gated mail path, now brokered under the recorded grant/routing/accounting controls; this historical gateway slice should not be read as disabling that later path. Routine tests use synthetic messages/databases and prohibit network calls.

Classification categories, owner corrections, explicit rules, selected-message suggestions, live Assistant mail controls and approved-provider execution were delivered in later slices. The current remaining mail gates are source completeness/freshness, owner usefulness and any provider-side writes/sends. Attachments and attachment-derived text remain excluded; there is no implicit permission bypass, and email sends still require their own explicit approval path.
