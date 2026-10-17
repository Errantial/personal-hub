# School Outlook access gate

## Status — 2026-10-16

P12 begins with a capability/access gate, not a mailbox adapter. The hub can now record bounded owner-confirmed feasibility findings for the school mailbox without signing in to Microsoft, requesting consent, storing OAuth tokens or reading mail. No live school-account or tenant access was used to implement or test this gate.

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

If the school blocks app registration or delegated consent, record the precise blocked capability and required school action. Do not silently escalate to application permissions. Authorized browser feasibility remains a separate proposal.
