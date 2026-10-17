# Inbound MCP design (P13)

Status: deferred to post-v1 by owner decision on 2026-10-17. This document remains a design/research artifact only. It does not enable MCP transport, add an MCP SDK, create an external endpoint, grant an external assistant access, or approve any private export. P14-P16 are not part of the v1 delivery sequence.

## Goal and boundary

The first inbound MCP capability is a small read-only surface for one explicitly chosen external client/version. It must reuse the hub's existing owner authorization, provenance, label, optimistic-version and bounded-read rules without treating browser cookies, AI-provider permission, OAuth client identity, or an MCP tool annotation as export authorization.

The initial proposal remains limited to:

- bounded Today metadata;
- filtered task browsing;
- score-free academic deadlines;
- narrow agent-status metadata.

Initial MCP explicitly excludes mail bodies, unrestricted search, bulk export, files/resources, policy changes, agent creation, email sending, calendar/provider writes, memory export and arbitrary database access. Task writes are a later P15 decision after read-only acceptance. Outbound MCP remains a separate P16 scope.

## Threat model

| Threat | Required control / denial behavior |
| --- | --- |
| Browser session reused as MCP authority | MCP uses a dedicated HTTPS resource surface with bearer authorization. Browser-cookie-only requests fail. A browser login may identify the owner during consent/setup but never silently creates an MCP grant. |
| Stolen, expired or replayed bearer token | Validate token on every request for expiry, revocation, owner, audience/resource and least scope. Rejected tokens disclose no private record existence beyond a bounded authorization error. |
| Wrong OAuth audience/resource | Require an exact hub resource audience. A token minted for another API/client cannot authorize hub reads. |
| OAuth client identity confused with downstream destination | Bind private export to a separate owner-approved named-client grant carrying the intended downstream assistant/service destination. OAuth client identity alone is insufficient proof of where exported data ultimately goes. Unknown destination/provenance denies private export. |
| Client silently broadens data after consent | Grants enumerate permitted tool/data classes and least scopes. Each discovery/page/call re-evaluates current grant revision, labels, provenance and source state. No “all hub data” scope exists in the initial design. |
| Cross-owner / guessed IDs | Resolve every supplied ID under the authenticated owner. Foreign IDs fail without returning the foreign record. Never trust caller-provided owner IDs. |
| Stale task/page cursor | Reuse guarded cursor/version semantics. A stale cursor or changed anchor/version fails explicitly rather than returning a mixed snapshot. |
| Record relabeled/revoked between calls | Re-check current owner labels, source provenance and export grant at each tool call/page. A previously visible record can become withheld later. |
| Broad internal endpoint reused accidentally | MCP gets narrow projections, not the browser Today response, planner export, full academic schema or full agent schema. Internal fields that are not part of the MCP projection remain unreachable. |
| Grade/score leakage | Academic MCP projection is score-free. Never serialize `grade`, points, submission details, private notes or attachment/provider payloads. |
| Agent private-history/cost leakage | Agent status projection exposes only approved status metadata. Conversation text, goals, detailed budgets/spend, caps and private execution payloads are excluded unless separately approved later. |
| Mail/body leakage via “Today” or related records | The MCP Today projection omits inbox notification content and any mail body/message text. Mail bodies remain out of initial inbound MCP entirely. |
| Schema/catalog drift | Record tool/schema revision/hash in acceptance. Client behavior on `tools/list` / changed schemas must be tested for the exact client version; stale schema assumptions cannot authorize a call. |
| Origin/header/version confusion | Enforce expected HTTPS/origin/header/protocol-version behavior for the chosen client. Reject unsupported or ambiguous version/header combinations rather than guessing. |
| Logs become a secondary disclosure path | Metadata-only logs/receipts: client/version, protocol revision, tool name, result category, counts/bytes, schema/grant revisions, timestamps. Never log bearer tokens, auth codes, cookies, private text, query bodies, record titles, mail data or secrets. |
| External client approves its own authority | MCP clients cannot grant themselves new export scope, change hub action policy, approve email, create agents or borrow scheduled-agent permissions. Owner approval happens through a separate hub-controlled flow. |

## First-client compatibility matrix

Do not choose or pin an SDK before the owner selects the actual first client. Keep one row per exact client version/build/platform, because remote-MCP, OAuth registration and tool-refresh behavior may differ by build.

| Area | Evidence to record for each exact client version/build/platform |
| --- | --- |
| Identity | client name; exact version/build/platform; evidence date/source; owner-selected yes/no; status = research / synthetic / developer-token / interoperable OAuth |
| Protocol | MCP revisions supported; negotiated revision; initialization/session behavior; whether Streamable HTTP is supported; whether the client incorrectly relies on protocol session/GET event-stream resumption |
| Reachability | arbitrary remote HTTPS support; public Internet vs private/VPN reachability; localhost/bridge requirements; proxy restrictions |
| Protected-resource discovery | discovery support; resource metadata behavior; resource/audience handling; bearer placement; cookie-only fallback behavior |
| Authorization-server discovery | discovery behavior; PKCE/authorization-code expectations; refresh/expiry support; logout/revocation behavior |
| Registration | exact registration mode; how `client_id` is obtained; redirect/callback restrictions; secret requirement; compatibility with the chosen auth service/library |
| Export binding | observed OAuth client identity; separately asserted downstream assistant/service destination; owner-approved named grant revision; approved data/tool scopes |
| Tool catalog | initial `tools/list`; tool/schema revision/hash; relist/cache behavior; persistence lifetime; reaction to changed/removed tools or schema fields |
| Runtime behavior | timeout/cancellation behavior; maximum tolerated response size; retry behavior; treatment of authorization failures; stale cursor behavior |
| Acceptance | one actual successful read plus the negative matrix below, using metadata-only receipts |

Developer-token evidence is useful for transport/tool compatibility but is **not** interoperable OAuth completion.

## Named-client grant model

Private MCP export requires an owner-approved named-client grant that is independent of browser sessions, AI provider routing and scheduled-agent authority.

A future P14 grant record should conceptually bind:

- owner;
- human-readable client/grant name;
- observed OAuth client identity/registration identity;
- separately declared downstream assistant/service destination;
- permitted tool/data classes;
- least authorization scopes;
- grant revision and status;
- created/approved/revoked timestamps;
- optional expiry/review time;
- metadata-only destination assurance/source.

The grant does **not** copy private record text. It also does not claim that OAuth client identity cryptographically proves the downstream model/provider. Where downstream provenance is unknown or cannot be owner-approved, private export is denied.

Grant changes are versioned. Every MCP call evaluates the current grant revision, not only the revision that existed when a token was minted. Revocation must therefore stop later private reads even for an otherwise unexpired token.

## Authorization design

P14 should provide a dedicated HTTPS MCP resource endpoint separate from browser-cookie APIs. The exact authorization server/library and client-registration mode remain unresolved until the first client is selected and tested.

The required authorization properties are:

1. protected-resource discovery for the hub MCP resource;
2. an exact resource/audience value for hub MCP;
3. per-request bearer authorization;
4. least scopes aligned to the approved read surface;
5. explicit expiry;
6. immediate server-side grant revocation;
7. token/revocation checks independent of browser session state;
8. no secret/token material in logs or portable export.

Browser login can be used to authenticate the owner while reviewing or approving a grant, but a browser cookie is not a valid MCP credential and cannot be exchanged implicitly for private MCP authority.

Suggested scope shape for later implementation should stay narrow and capability-oriented rather than record-type wildcard export. Exact names remain a P14 implementation detail after the first-client/auth decision.

## Initial read projections

### Today

Do not expose `GET /api/v1/today/summary` verbatim. Build a narrower MCP projection from the same trusted internal primitives.

Initial fields should be limited to bounded planning/attention metadata that has passed export checks, for example task deadline counts/items, score-free academic deadline counts/items, and high-level worker/agent-health metadata if separately permitted. Exclude unread notification text, inbox message content, mail metadata/body, broad schedule dumps and any browser-session-only state.

### Filtered tasks

Reuse the existing owner-scoped task browsing and guarded cursor/version semantics from task management, but project only approved task planning fields. Do not serialize planner rows wholesale. Re-evaluate current provenance/labels and the named-client grant on each page.

Stable item identity/version should be returned so stale client reads can be detected later. A stale cursor/version fails rather than mixing pre/post-edit data.

### Score-free academic deadlines

Reuse the allowlisted score-free pattern already used by verified academic live projections:

- title;
- kind;
- due date or null;
- estimated minutes or null;
- status;
- priority;
- stable source/reference identity and current version as needed for stale detection.

Never expose grade/points, notes, instructor/class private text, submission details, attachment/provider payloads or broad source records. Current class/work versions, archive/delete state, provenance and owner labels must be checked before every export.

### Agent status metadata

Do not expose the full agent record. Initial projection should be limited to status/health information needed for an external assistant to answer “what is my automation doing?” without revealing conversations/goals or granting control.

Candidate metadata: stable agent ID/version, enabled/paused state, current/last run state, high-level timestamps/health category and bounded warning/result categories. Exclude conversation text, goal text, detailed spend/caps/allowance, private tool context, mail scope contents and action-policy mutation controls unless separately approved later.

## Export evaluation order

Every MCP read should apply the same conservative order:

1. authenticate bearer token for the dedicated MCP resource;
2. resolve the authenticated owner and current named-client grant;
3. verify audience/resource, token expiry/revocation and requested least scope;
4. resolve requested record IDs/cursors only under that owner;
5. read a consistent bounded snapshot;
6. resolve current source provenance, inherited labels and availability/version state;
7. evaluate the grant's approved destination/data classes against those labels/provenance;
8. project only the MCP allowlisted fields;
9. enforce count/byte/page limits;
10. return metadata needed for freshness/version review, with a metadata-only receipt.

Failure or unknown provenance blocks the affected private export. A failed lookup must never be interpreted as intentionally unlabeled data.

## Negative acceptance matrix for P14

Before declaring inbound MCP read-only acceptance for the selected client, test at least:

- missing bearer token;
- expired token;
- revoked token/grant;
- wrong resource/audience;
- insufficient scope;
- browser-cookie-only request;
- malformed/unsupported Origin, protocol version or required headers;
- foreign/cross-owner record IDs;
- stale task cursor/version;
- label/provenance change between pages/calls;
- source deletion/archive/forget/revocation where relevant;
- grant destination changed/revoked after token issuance;
- bounded page/count/byte behavior;
- changed/removed tool/schema catalog;
- no secrets/private text in logs or error metadata;
- one actual chosen-client successful read with the exact client version/build/platform recorded.

The tests should use synthetic records except for the separately approved final chosen-client acceptance. A developer-token pilot may prove tool compatibility but cannot be described as completed OAuth interoperability.

## Metadata-only acceptance receipt

A P14 chosen-client receipt should contain only:

- client name/version/build/platform;
- hub server commit/release;
- MCP protocol revision negotiated;
- transport/reachability class;
- authorization and registration path/category;
- approved named-client grant revision;
- approved destination identifier/category and scopes, without credentials;
- resource/audience outcome category;
- tool catalog/schema hash/revision;
- tested tool names;
- negative-case result categories;
- timestamp and overall acceptance outcome.

Do not include bearer tokens, authorization codes, cookies, secrets, private record text/titles, mail data, full request/response bodies or model prompts.

## Explicit owner-gate choices still unresolved for post-v1

P13 does not decide these. They remain required if/when post-v1 MCP work resumes:

1. exact first MCP client plus version/build/platform;
2. exact downstream assistant/service destination the owner is approving;
3. permitted data/tool classes and least scopes for that destination;
4. authorization service/library;
5. OAuth/client registration mode;
6. protocol revision(s) and SDK version after first-client compatibility is proven;
7. endpoint exposure class: public HTTPS, private/VPN, or local/bridge arrangement;
8. approval to proceed from design into actual inbound read implementation and chosen-client acceptance after v1.

These choices are not implied by the owner's general autonomous-development approval. The owner explicitly moved MCP compatibility to post-v1 on 2026-10-17. Inbound task writes and outbound MCP each retain later, separate approval gates.

## Post-v1 handoff criteria

For v1 purposes, P13 is complete as a deferred design artifact when this threat model, first-client matrix template, grant/export boundary, auth requirements, narrow tool projections and acceptance matrix are reviewable and the unresolved owner choices above remain explicit.

When post-v1 MCP resumes, P14 should not start by installing an SDK. It should first resolve the owner-selected client and auth/registration choices, then pin only the protocol/SDK versions actually needed for that client, implement bearer auth and narrow read tools, and run the synthetic negative matrix before any live chosen-client acceptance.
