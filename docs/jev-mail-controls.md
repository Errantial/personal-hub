# Brokered mail controls (J4)

Implemented in development on `ai/jev-broker-workflow`, stacked on J1–J3. Not deployed. The controls below are the owner-facing surface for the [J3 workflow](jev-mail-workflow.md); they do not enable live TypeSafe disclosure, which still needs operator account evidence, owner approval and staged release.

## Settings › AI › Mail access

One panel reports broker readiness and holds an explicit grant for the owner's own asks and for each scheduled agent.

- Readiness is server truth, shown as a status line with the reason each blocker exists: missing provider profile, missing pinned model, missing or expired account verification, missing provider consent, unverified pricing, blocked Assistant destination, no approved route, or an unset or exhausted limit. A configured profile never implies account setup or working mail access.
- A grant is a versioned, owner-written rule: on/off, the connectors it covers, and an optional inclusive `receivedAfter`/exclusive `receivedBefore` window. Date inputs cover whole days. Turning access off keeps the saved scope so it can be reviewed; a scope with no sources cannot be saved enabled.
- The form follows the server after a save or a deliberate reload, keeps the owner's draft after a failed write, and offers a reload action on a version conflict. It never invents a grant from an existing Use mail choice, and a saved scope survives a revoked connector while naming it as revoked or missing instead of silently dropping it.
- Revoked connectors cannot be chosen again. Removing one from a saved scope requires an explicit save.
- Writes are disabled offline; saved scopes remain readable so the owner can see what a future ask would allow.

The existing Use mail switch is unchanged and approves neither a grant nor TypeSafe disclosure. A mail ask without a grant stops with `MAIL_BROKER_APPROVAL_REQUIRED`, which the composer shows as an actionable message linking to this panel.

## Answer coverage and older-mail search

A brokered turn shows what was actually searched and sent, outside the collapsed turn details so limits and refusals stay visible:

- Search status (pending, partial, completed, blocked, uncertain), how many imported records were inspected and judged, how many messages were sent, how many were cut, and why the scan stopped. Every stop reason has its own sentence, so `hasMore` never implies an exhaustive search.
- Per-connector import freshness: the newest imported timestamp or "Never imported", and the first imported day.
- A Help control stating that this counts imported mail only and that mailbox completeness is unverified.
- `Search older mail` appears when the saved snapshot has more older imported mail. It is offered only on owner asks, since an agent's continuation is bound to that agent's grant and goal. It marks the next ask, which sends the owner's own words as the new intent; the composer also turns Use mail on, because an older-mail search cannot run without it, and says so. Cancelling leaves the ask text untouched.

## Verification

Four isolated Chromium cases cover grant save/reload/conflict, the blocked-state copy, revoked-source reporting, the 320px layout with keyboard and tap Help, WCAG checks, and the coverage line plus an older-mail ask carrying its continuation token. Full `npm run check` (810 unit/API tests) and the sequential browser suite (160 cases) pass. All mail is synthetic; no provider, mailbox or owner database was used.

## Still owner-gated

Real TypeSafe account terms, token-bound billing evidence, provider approval, routing for the broker alias, spending limits, a backed-up staged deployment and owner live acceptance. Until then the panel honestly reports that mail asks are blocked.