# AI permissions and provider routing

[Editable owner memory](memory.md) stores explicit preferences/goals/facts and owner label history with disable/forget controls. It remains outside AI context references and retrieval; enabling it does not verify text origin or grant provider disclosure. Future integration must evaluate every retained label, current version/tombstone and source provenance before routing, and invalidate active derived copies on forgetting.

Implemented [typed action permissions](ai-actions.md) are a separate owner policy/authority preview. They do not authorize model dispatch or prove provider write capability; mandatory email approval and existing text/provenance/routing gates remain in force. [Email draft approvals](email-drafts.md) retain explicit exact-message review records separately. No action executor or sender/provider send capability is enabled.

## Confirmed requirement

The owner can set rules that route sensitive requests to a different approved AI provider. For example, routine context might use Claude while personal context uses another selected provider. Neither provider has been selected yet. A different provider is not automatically more private; approval is an explicit user configuration based on the intended data boundary.

Routing permissions are separate from action permissions. Every provider must obey text-only input restrictions, validated calendar actions, and explicit email-send approval. Routing to a private provider does not grant it additional app authority.

## Settings

### Implemented: permissions and read-only preview

Preferences includes AI permissions and Routing preview. This remains a policy simulation; dispatch is disabled. Separate server profiles, spending limits, and metadata-only preflights are implemented in the [gateway foundation](ai-gateway.md). Profiles are empty by default, and no SDK/transport, health/model verification, conversation, AI memory retrieval, paid request or agent runtime is enabled. Saving routing aliases does not connect a provider.

Set allowed provider aliases and an optional preferred alias for Unlabeled, Personal and Restricted. Aliases are lowercase identifiers, not URLs, model names or secrets. Defaults allow no destination. A request can have an explicit owner label and owned source references. The web preview currently offers task context; the API also accepts calendar, class, topic and Canvas feed/assignment references. Sources require current versions and owner authorization. Preview text is accepted only to model the request shape; it is neither returned, persisted nor sent to another service, and its wording never determines a label.

The server resolves all explicit and inherited labels from a consistent database snapshot. Personal and Restricted are independent permission sets: a strongest display label does not discard another applied label. A labeled derived record inherits all applied ancestor labels; unlabeled ancestors do not add a separate restriction to that labeled record. Independently unlabeled request text or sources still require the Unlabeled route. Permitted destinations are the intersection of every included label's allowed aliases. Configure sensitive aliases under Unlabeled too if ordinary request text should be combined with sensitive context.

Among that intersection, the strongest included label's preferred alias wins when permitted; otherwise its first permitted alias wins. Simulated availability is checked only after selection. An unavailable selected alias blocks even if another approved alias is simulated available; it never silently retries a default or alternate destination. Screenshot/attachment fields are rejected, and uploaded-file-derived context blocks before selection. Historical non-file planner snapshots without complete captured/current label arrays return PROVENANCE_UNAVAILABLE; the server does not invent historical labels or rewrite those snapshots.

Permission writes use optimistic versions and atomic operation receipts. Unchanged lost-response retries return the original result. Reload permissions preserves edited fields while adopting the latest version; save those fields before previewing. Previews require the current policy version, do not create mutation receipts, and return only labels, source IDs/versions, a simulated decision and fixed reasons. Export adds safe policy aliases/versions and provenance; preview text and credentials are excluded.

| Route | Behavior |
| --- | --- |
| `GET /api/v1/ai/routing` | Owner's current policy; deny-by-default version 1 before first save |
| `PUT /api/v1/ai/routing` | Versioned/idempotent permission update |
| `POST /api/v1/ai/routing/preview` | Read-only, text-only policy simulation with server-resolved context |

Migrations 011 and 012 add owned policies and complete label views without changing earlier migrations. Synthetic checks cover owner isolation, incompatible mixed labels, preferred-provider unavailability, current/captured provenance, missing historical label arrays, archived ancestors, blocked file-derived records, stale versions, strict request fields and lost-response retries. The optional standard PostgreSQL check covers populated reconciliation/provenance views and policy preview; local execution still requires a disposable TEST_DATABASE_URL.

Migrations 014 and 015 add academic label history to calendar records and topics. New academic records retain every captured label, including an explicit label hidden by a stronger parent label. Source relabeling appends labels and invalidates affected versions, including series with class/topic occurrence replacements. Study detachment, occurrence cancellation and later label changes never erase captured history. Current ancestors and captured history both constrain the preview. Ordinary new calendar records without academic provenance start with an empty history; older calendar/topic records remain null because historical ancestors cannot be reconstructed. Null history blocks routing, while planner editing still works. No review/reset workflow for captured or unknown history is implemented yet. Export preserves these arrays/nulls, and older files default to null.

Academic writes lock class, then topic, then event, matching source-label propagation. The optional PostgreSQL check also races academic edits with label propagation; conflicts are permitted, deadlock/internal-error responses are not. Local PGlite checks validate transitions and upgrade preservation, but do not establish standard PostgreSQL concurrency behavior.

### Planned: provider execution

The [gateway foundation](ai-gateway.md) now provides server-declared profile/model names, private credential references, owned numeric limit settings, bounded text projections, and durable blocked preflight metadata. Actual availability, capability/model verification, pricing, integration of the internal reservation/accounting engine with retained executable requests, consent/retention and action execution remain pending. Server preflight never uses client-simulated availability or transmits assembled text.

| Setting | Purpose |
| --- | --- |
| Provider profile | Endpoint, allowed models/capabilities, protected API key reference, and budget limits |
| Default route | Provider/model permitted for routine context |
| Sensitive route | Separately approved provider/model for selected personal or restricted content |
| Source labels | Sensitivity defaults for mail connections, calendars, classes, memories, and user-created records |
| Rule | Conditions, explicit priority, permitted destination(s), and blocked behavior |
| Route history | Rule IDs, sensitivity labels, policy version, provider/model, cost, and status; no raw private content |

Keep provider credentials out of the model and browser. A provider profile can later point to a self-hosted endpoint, but the laptop is not a required initial dependency.

## Initial rule model

Confirmed: only sources or content explicitly labeled by the owner determine sensitive routing. No local patterns, heuristic classifier, or hosted model automatically assigns sensitivity. Content derived from a labeled source inherits that label; this preserves the owner's choice rather than inferring a new category.

Current owner-applied labels are personal and restricted, each with allowed destinations; changing label names is later scope. Unlabeled content uses the configured default route. Stored owner memory labels and future retrieved memory/mail context follow the same boundary. A request label does not remove labels carried by retrieved context.

Do not automatically label Proton mail personal or Canvas routine. The owner chooses these source defaults. Existing content and derived records are re-evaluated after a source label changes. Labels cannot retract content already sent to a provider; apply them before processing where that boundary is required.

For a complete request:

1. Exclude forbidden content: screenshots, attachments, attachment-derived content, credentials, and disallowed resource exports.
2. Assemble bounded context with provenance for user text, history, retrieved facts, summaries, and tool results.
3. Resolve owner-applied labels and inherited labels before contacting any external model/service. An unlabeled item uses the default rule; missing provenance for a derived item is an error, not proof that it is unlabeled.
4. Intersect allowed destinations for all included context. Deny rules take precedence; an ordinary-content rule cannot downgrade a restrictive source label.
5. Within the remaining destinations, choose by explicit rule priority, then configured default. Cost/quality selection can operate only within this permitted set.
6. If no valid destination exists or label/provenance resolution fails, queue/block and show the conflict/error. Do not treat a failed lookup as intentionally unlabeled content.
7. Dispatch through the gateway and record a metadata-only routing receipt.

Example rules (illustrative, not final defaults):

| Match | Permitted route |
| --- | --- |
| Mail connection or memory explicitly labeled personal | Selected sensitive provider |
| Unlabeled course descriptions with no labeled context | Default provider |
| Credentials or excluded attachment/screenshot content | Block/remove; never route as ordinary text |
| Both private and public facts in one request | Destination permitted for all included facts, otherwise block |
| Sensitive provider unavailable or budget exhausted | Queue/block; no default-provider retry |

Retain inherited labels on summaries and AI memory. A summary of mail labeled personal retains that label. Redaction does not automatically remove labels; only an explicit owner policy/change can relax them.

## Tool loops and conversations

Re-evaluate every inference, retry, embedding request, background job, and context export. A request can start unlabeled and acquire an inherited personal label when a tool retrieves owner-labeled mail; the next call must switch to an approved destination before that content is sent.

Provider-specific conversation handles and caches cannot automatically migrate across providers. Rebuild permitted context locally for each call. Once a provider has received data, a later route change cannot retract that disclosure; enforce the rule before transmission.

External MCP tools need destination permissions independent of model permissions. Check outgoing tool arguments, not only incoming results. Inbound external assistants may retrieve only the context their configured export permissions allow; unknown provider identity does not grant access to private records.

## Review and failure behavior

Show the selected provider and a brief explanation such as "personal-mail rule". Rule changes offer synthetic test cases and indicate affected sources. Do not require confirmation for each correctly routed request. Changing permissions is a settings action the assistant cannot grant itself through untrusted content.

When the selected provider lacks required tools/structured-output support, report that limitation or choose another already-approved destination. Never resolve incompatibility by widening data permissions.

Numeric provider budgets and alert thresholds remain to be set before paid automation. Automatic retry is permitted only within existing destination and budget constraints.

## Acceptance cases

- Explicitly labeled sensitive text reaches its configured provider and no unapproved provider/classifier/embedding service/fallback contains it.
- Owner-labeled memory/history routes an otherwise unlabeled user prompt correctly.
- A newly retrieved owner-labeled tool result causes re-routing before the next inference.
- Derived private summaries retain their source label; changing policy invalidates incompatible caches.
- An unavailable sensitive provider produces a queued/blocked job without default fallback.
- Mixed-source context with incompatible destinations is blocked or reduced to an explicitly permitted subset with the omission shown.
- Outgoing MCP tool arguments cannot leak sensitive text to an unapproved server.
- Images and attachments remain excluded even if the sensitive provider accepts them technically.
- Unlabeled text follows the default route even if its wording appears personal; no automatic sensitivity classifier is called.
- Changing a source label affects its summaries and future requests; a label lookup failure blocks rather than defaulting.
