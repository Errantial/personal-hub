# Offline OpenRouter protocol verification

Implemented 2026-10-11. The request builder now has a response decoder and an injected-I/O protocol exercise. This is test infrastructure: it requires NODE_ENV=test and a synthetic-prefixed credential, has no default fetch, exposes no HTTP endpoint and performs no database writes. Production dispatch remains disabled. No migration or dependency is added.

## Exchange boundaries

The exchange uses the fixed OpenRouter chat-completions URL and existing pinned model/upstream, text-only structured output and no-fallback request. Redirects are forbidden. There is one I/O invocation and no retry. Header and body reads share a maximum 30-second deadline; caller cancellation and late responses are handled without processing late output. JSON bodies are limited to 256 KiB with strict UTF-8 decoding, MIME checking and stream cancellation on rejected responses.

X-OpenRouter-Cache=false explicitly disables router response caching. Any returned cache-status header blocks output acceptance while preserving otherwise valid reported usage. Per-request ZDR alone does not establish that response caching is disabled; see [OpenRouter response caching](https://openrouter.ai/docs/guides/features/response-caching). Upstream prompt caching, router retention and confidential inference are separate questions.

## Billing and useful output are independent

The decoder requires a bounded generation identifier, the exact configured model and coherent native prompt/completion/total token counts. It preserves the original numeric cost lexeme using Node 24's JSON parser context, converts dollars with integer arithmetic and rounds upward only at the final micro-dollar boundary. Native reported counts are never replaced with synthetic byte-count estimates.

Valid usage can accompany provider errors, incomplete output, refused/tool/multimodal output, exceeded declared token limits, invalid structured JSON or unrecognized source versions. Those results preserve reported charge metadata but discard output. Top-level and choice errors are checked even in HTTP 200 responses; see [OpenRouter error handling](https://openrouter.ai/docs/api_reference/errors-and-debugging). Valid guidance must match the admitted source kind, ID and version and never carries executable actions.

Missing or inconsistent billing, changed models, malformed responses, transport failure, timeout and cancellation remain uncertain. Uncertainty does not mean free, refunded or safe to resend. Raw provider errors and rejected text are not returned or logged. A generation identifier is bounded protocol metadata, not proof of account entitlement or upstream privacy. The protocol's confirmed status means coherent reported usage only: it does not settle a durable attempt or verify a provider invoice.

## Remaining live integration

[Offline durable accounting](ai-openrouter-accounting.md) now exercises atomic reported-usage settlement, consented saving and no-resend recovery with synthetic I/O. The protocol exercise itself still performs no database writes. The following live verification requirements remain unresolved.

Before live dispatch, bind exact owned context/current provenance, verify approved route/account/model availability, establish a complete worst-case token/fee bound, obtain the existing durable attempt/budget hold, and integrate reported usage with atomic settlement and consented answer saving. Reconcile uncertain outcomes without resending. Verify actual upstream disclosure/retention settings; a model name alone cannot prove them. Subscription isolation and Prem attestation remain pending. No owner account login, credential import or paid inference occurred here.

## Verification

Eleven focused tests pass with injected synthetic responses and a global fetch trap. They cover exact request routing, decimal precision, billing uncertainty, HTTP-200 errors, tool/refusal/multimodal rejection, source grounding, body/destination/MIME limits, caching, configuration guards, stalled headers/body reads, late response cancellation and owner aborts. Full npm run check passed lint, strict types, formatting, production builds and 354 API/client tests; one optional standard PostgreSQL test was skipped. Browser tests were not rerun because UI/authentication code was unchanged. No owner database, real providers, paid AI or device tests were used. UI/authentication code is unchanged; browser and device tests are not part of this slice.
