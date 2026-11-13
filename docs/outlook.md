# School Outlook access gate

## Status — 2026-10-16

P12 begins with a capability/access gate, not a mailbox adapter. The hub can now record bounded owner-confirmed feasibility findings for the school mailbox without signing in to Microsoft, requesting consent, storing OAuth tokens or reading mail. A separate release-branch read-only [browser collector](outlook-browser.md) is implemented in development; it is not Graph access. No live school-account or tenant access was used to implement or test this gate or the browser collector.

Microsoft's current Graph permission reference distinguishes delegated `Mail.ReadBasic` from delegated `Mail.Read`: `Mail.ReadBasic` excludes message bodies, body preview, attachments and extended properties. The planned bounded plain-text body adapter therefore requires delegated `Mail.Read`, not `Mail.ReadBasic`. Do not request send, write or calendar scopes for this read-only milestone. See [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#mailread).

Tenant policy remains an account-specific gate. Microsoft Entra allows administrators to restrict or disable user consent even for permissions that are not inherently admin-consent-only, and can require administrator review. See [user consent settings](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent) and [user/admin consent overview](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/user-admin-consent-overview).

## Recorded findings

Settings › Connections › School Outlook records five versioned findings only:

- mailbox backend: unknown, Exchange Online / Microsoft 365, or another backend;
- tenant class: unknown, school-managed Entra tenant, or another tenant/account type; the gate deliberately stores no tenant identifier;
- required mailbox scope: unknown, primary mailbox only, or shared mailbox required;
- app registration: unknown, owner can register, school admin must register, or registration is blocked;
- delegated `Mail.Read` consent: unknown, user consent allowed, admin consent required, or delegated consent blocked.

The server derives one visible outcome: Access not established, Ready for delegated adapter work, Admin action required, Mailbox scope review required, or Access blocked. Ready requires an Exchange Online backend, a confirmed school-managed tenant, primary-mailbox scope, an owner-available app-registration path and user-allowed delegated consent. These states are metadata, not proof of a granted OAuth scope. A saved Ready state means only that the recorded prerequisites are compatible with the next adapter implementation.

Writes are owner-scoped, optimistic-versioned and idempotent. Portable export includes the bounded gate metadata and checked timestamp. There are no tenant IDs, client secrets, authorization codes, refresh/access tokens, account addresses, message IDs or mailbox contents in this table or mutation receipts.

## Next adapter boundary

Only after the live gate establishes an Exchange Online backend, exact mailbox scope, app-registration path and consent policy should development add OAuth/token lifecycle and Graph reads. The first adapter should:

- use delegated Graph v1.0 access for the signed-in owner, never tenant-wide application permissions as an automatic fallback;
- request delegated `Mail.Read` only for bounded body ingestion; add a shared-mail delegated permission only if the actual mailbox scope requires it;
- project bounded plain text and metadata without attachment fetch;
- request `Prefer: IdType="ImmutableId"` on each relevant message request so moves within the mailbox do not change stored message identity; see [immutable Outlook IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id);
- follow opaque paging and delta links exactly, persist their state durably, and handle expired delta state with bounded resynchronization;
- treat disappearance from one folder as possible move or deletion rather than global removal until reconciliation proves it;
- handle throttling, interrupted pages and revoked authorization explicitly;
- keep webhooks as a later optimization that wakes delta reconciliation rather than replacing it.

If the school blocks app registration or delegated consent, record the precise blocked capability and required school action. Do not silently escalate to application permissions. Authorized browser collection is a separate implementation route documented in [outlook-browser.md](outlook-browser.md); it does not replace this Graph access gate.

## Read-only browser collector (development, 2026-11-13 release)

A separate [Outlook Web browser collector](outlook-browser.md) is implemented in development for the release branch. It does not use this Graph access gate, OAuth, Graph scopes or tenant permissions. It uses a dedicated local headful browser profile, normal interactive school sign-in/MFA and a bounded DOM projection of selected folders and reading panes. It stores only bounded metadata and plain text, never HTML, attachments, raw headers, cookies or session data, and performs no explicit send, move, flag, delete, compose or calendar action. Opening a reading pane may follow the account's normal Outlook Web read/unread and read-receipt settings; the collector clicks no mark-read or send control, and live read-state behavior is an owner gate.

The collector has its own migration 080 tables, owner routes under `/api/v1/connections/outlook/browser`, collector routes under `/api/v1/outlook/browser/collector/`, one-time hash-only `hubob_…` tokens, explicit folder selection, optimistic versions, exact retries and append-only captures. The existing `outlook_access_gate` findings are unchanged and remain a separate metadata surface.

No live school account, Microsoft credential, cookie, screenshot, real mail or attachment was used to implement or test this slice. Live sign-in/MFA, actual Outlook Web selectors, two-folder/all-selected-folder coverage and unattended scheduling remain owner acceptance gates; see the [collector runbook and checklist](outlook-browser.md#live-owner-acceptance-gate).
