# Provider access, spending limits and saved answers

Owner decisions recorded 2026-10-11: prefer first evaluations through Claude Code/Codex subscription access when supported; otherwise use a general API provider such as OpenRouter. Prem is the preferred confidential-provider candidate for owner-labeled personal/restricted context. Monthly spending must not exceed $50; initial per-request allowance is $0.25. Answers may be saved only with explicit consent for that request.

## Implemented spending and retention

Migration 040 installs a $50 database ceiling and initializes existing owners to $50/month and $0.25/request. Existing settings change version when adjusted; recorded spend, uncertain holds and historical receipts remain. Runtime tests never touch the owner's database; the owner's settings change when their server next applies migrations. Freshly enrolled owners without a saved policy remain blocked until budget configuration. Owner writes cannot raise the monthly ceiling; per-request limits remain configurable within it. Historical exported policies/receipts can still parse higher old values without authorizing new spending. GET /api/v1/ai/budget includes hardMonthlyLimitMicros=50000000.

This is an application admission ceiling. A real adapter must first establish a complete worst-case billable bound, including system/envelope overhead, all token categories and provider/router fees. No live dispatch is enabled, so the app does not claim an upstream billing guarantee. Subscription quotas, API credits and paid extra usage are different accounting paths; a subscription is not a fabricated zero-dollar API invoice. Paid fallback/top-ups must never be activated implicitly. Configure an upstream spending boundary before production paid use.

POST /api/v1/ai/requests accepts optional saveAnswer. Omitted/false means temporary; true is affirmative per-request consent stored with the request. Existing operation identities remain compatible when the field is omitted; reusing a successful operation ID with changed consent conflicts. Existing/legacy requests remain nonconsenting. There is no global automatic-save switch or retroactive opt-in.

Migration 041 adds owned saved answers. Only completed, validated synthetic text results with saveAnswer=true can be stored. Answer saving, attempt result metadata, request state and budget settlement commit atomically. Invalid output is never saved; a storage/accounting failure preserves the uncertain hold and never resends. Request prompts remain unretained. Saved output consists of the bounded answer and source-linked suggestion notes, plus captured labels and the safe admitted context manifest.

GET /api/v1/ai/requests/:id/answer returns the owned saved answer or a content-cleared tombstone; absent/foreign records are 404. DELETE on the same path takes operationId and the independent saved-answer expectedVersion. It clears output, records deletedAt and advances the answer version, with metadata-only retry receipts. Parent request/attempt versions do not change. Answers cannot be edited/restored. A retry or restart never generates another provider call or resurrects forgotten text; saved answers remain readable after restart.

Request status/history and create/hide/forget receipts never include answer text. The dedicated answer read and portable records.aiSavedAnswers export do include consented text. Older format-v1 exports default this array empty. Attempt resultMetadata.retained records whether output was saved at confirmation; current answer/tombstone state is authoritative after forgetting. A completed attempt with invalid output is not a useful answer or completed planner action. All current answers are explicitly synthetic; public/live dispatch remains disabled.

Hiding request metadata retains its separately saved answer. Forgetting a source memory does not erase independently consented saved answers, exports, backups or user copies. Saved answers are currently not AI context references; future reuse must recheck complete current source provenance/labels. Forgetting removes current logical answer text, not historical database pages/WAL or separately retained copies. UI controls must explain these limits and render output as untrusted text.

## Verified documentation and unresolved runtime work

The registry now accepts declared adapter identifiers claude-code, codex-subscription, openrouter and prem-confidential, alongside existing API adapter declarations. Safe profiles expose accessMode and nullable upstreamProvider; they remain declarations with health=not_checked and dispatchEnabled=false. Configured means an enabled profile with a referenced server credential, not a verified subscription session, working SDK, available model or confidential route. No SDK dependency, subscription credential import, CLI subprocess, account sign-in or live inference was added in this slice. Models must come from the actual configured account/catalog and receive a verified profile/price/disclosure before use.

### Codex subscription path

[Subscription isolation readiness](ai-subscription-isolation.md) now names the required account/runtime/input/usage checks explicitly. Codex preparation remains unavailable; local CLI availability and settings do not prove the full effective boundary.

Official [Codex app-server documentation](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) describes OAuth-authorized ChatGPT plan inference and application-managed token renewal. The model catalog alone does not prove entitlement; a completed inference verifies that request's access. The [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) supports programmable sessions, but read-only sandboxing still allows file reads. Before connecting hub text, isolate configuration/session persistence, disable tools/MCP/web/file access and verify only gateway-approved text reaches the model. Use a dedicated application login/token flow; do not read or copy this development agent's credentials.

### Claude subscription path

[Bounded Claude request preparation](ai-subscription-isolation.md) now builds a static unverified stdin/argv draft and exposes isolation/usage blockers. It does not launch the CLI, sign in or import credentials; native transport and accounting remain pending.

The current [Claude subscription help page](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) describes Agent SDK/claude -p/subscription usage and added API credits for eligible plans. The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) separately restricts offering Claude login/rate limits in third-party products without approval. Personal evaluation and a distributed product login need separate verification; no token extraction or unofficial OAuth API relay is implemented. The SDK includes tools, skills, MCP and sessions by default; the hub needs a verified text-only configuration and separate app/session storage before testing private context.

### OpenRouter

[Offline charge-only recovery](ai-accounting-recovery.md) can settle recorded synthetic reports when result text was lost, with unavailable-answer metadata and no external I/O or answer reconstruction. Per-request consent, existing saved/forgotten answers and no-resend behavior are preserved. Live invoice verification remains pending.

[Protocol recovery observations](ai-protocol-recovery.md) now retain bounded uncertain generation IDs and coherent synthetic usage reports before settlement. They survive settlement failure/restart without storing model text or resending. Live invoice verification and generation lookup remain pending.

[Offline durable accounting](ai-openrouter-accounting.md) now connects coherent synthetic protocol reports to atomic native-token/reported-cost settlement and consented answer saving. Owned attempt reads/export add nullable protocolMetadata; old byte-token results remain compatible. No live dispatch or provider account access is enabled.

[Offline protocol verification](openrouter-protocol.md) now exercises injected synthetic responses, native usage/exact cost, structured guidance, errors, caching and cancellation. It has no default network I/O and cannot run with production configuration. Durable live settlement and actual provider access remain pending.

Profiles require one server-pinned upstreamProvider; changing it changes the safe registry/profile revision and invalidates consent. buildOpenRouterTextRequest prepares a bounded nonstreaming structured-text request to the fixed official endpoint, with one model and pinned only/order values, allow_fallbacks=false, require_parameters=true, data_collection=deny and zdr=true. It adds no tools or model-fallback list and never performs fetch. The full envelope has a character bound; real tokenizer/billing/output/provider verification and networking remain pending.

See [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection). ZDR restricts eligible endpoints; it is not encrypted confidential computation. Treat the router and selected upstream as disclosure destinations in owner-approved retention snapshots. A model/router outage must block; switching from a subscription to OpenRouter is a deliberate configuration decision, not runtime fallback.

### Prem

The [Prem integration overview](https://docs.prem.io/) distinguishes confidential inference from standard ZDR forwarding. Its [platform status](https://docs.prem.io/platform-status) documents current attestation/measurement and served-route assurance gaps. A compatible endpoint or model name is not confidentiality evidence. For labeled context, validate the encrypted SDK/proxy path, key custody, attestation and operator-pinned measurements, selected model/route and billing bounds. Do not disable attestation or substitute the standard ZDR route. Until that evidence and account configuration exist, personal/restricted requests remain blocked with no general-provider fallback.

## Verification

Nine new focused tests pass for the SQL/API ceiling, legacy receipt/spend preservation, omitted/default consent, explicit request consent, private owner access, metadata/text separation, invalid output, atomic storage rollback, immutable content-clearing forget/retry behavior, declared provider modes and pinned no-fallback request preparation. Persisted restart coverage includes both temporary and saved answers. Tests forbid network calls and use isolated synthetic databases. Final npm run check passed lint, strict types, formatting, production builds and 343 API/client tests; one optional standard PostgreSQL test was skipped. All 45 isolated browser regressions passed. Nine new retention/provider-preparation tests passed in focused verification, and restart coverage includes saved answers. The historical above-ceiling retry regression was corrected and the clean full rerun passed. No real providers, paid requests, owner database resets or device tests were used. Verification is also recorded in the backlog and UI ledger; production PostgreSQL and real provider access remain unverified.
