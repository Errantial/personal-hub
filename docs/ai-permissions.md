# AI permissions and provider routing

## Confirmed requirement

The owner can set rules that route sensitive requests to a different approved AI provider. For example, routine context might use Claude while personal context uses another selected provider. Neither provider has been selected yet. A different provider is not automatically more private; approval is an explicit user configuration based on the intended data boundary.

Routing permissions are separate from action permissions. Every provider must obey text-only input restrictions, validated calendar actions, and explicit email-send approval. Routing to a private provider does not grant it additional app authority.

## Settings

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

Suggested owner-applied labels: personal and restricted, each with allowed destinations. Unlabeled content uses the configured default route. Exact label names remain configurable. Allow labels on connections, individual records/memories, and the current request; a request label does not remove labels carried by retrieved context.

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
