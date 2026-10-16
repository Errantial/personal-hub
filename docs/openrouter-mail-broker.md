# OpenRouter mail broker

Implemented in development on `ai/openrouter-mail-broker`, 2026-10-16. Validation receipts are in [implementation-log.md](implementation-log.md). Deployment, actual model-quality evaluation and owner live acceptance remain pending. This replaces the TypeSafe-specific adapter in J1-J4; the older Jev documents retain historical receipts. See the [approved direction and plan](openrouter-mail-broker-plan.md).

## Runtime

The broker uses `google/gemini-2.5-flash-lite` through OpenRouter pinned to `google-vertex`. The receiving Assistant model remains separately configured. Mail-enabled owner asks and scheduled agents use the existing broker grants, candidate snapshots, continuations, dependency manifests and downstream hold transfer. No direct-mail or alternative-provider fallback exists. Restricted, unknown-origin and attachment-derived content remain blocked; Personal requires permission at both hops.

Each batch receives bounded text and server-assigned candidate keys. Strict output contains exactly one relevance enum per key. Only `directly_relevant` is selected; the server forwards original text in deterministic snapshot order. No generated summary or self-reported confidence grants access. Invalid/foreign/duplicate/missing keys, extra fields, refusals, model changes and truncated responses discard selection. Complete candidate dependencies remain attached to derived history, including unselected candidates.

Before paid admission, public catalog reads verify text-model pricing and the pinned host's ZDR endpoints, structured outputs, max-token support, context/output capacity and prices. Host-specific prices must fit the configured quote, including output; nonzero per-request endpoint fees block this initial adapter. Requests disable reasoning, caching, redirects and retries, use strict JSON output, and pin ZDR/no-data-collection routing. Catalog reads carry neither credentials nor owner data. A catalog failure blocks before reservations or disclosure. Endpoint observations do not prove actual model quality.

Reservation uses the complete 20 KiB serialized-envelope ceiling plus token-template allowance within the configured input bound and 2,048 output tokens. Actual charges settle from OpenRouter-reported usage/cost, including invalid output and confirmed overruns; an overrun blocks selection while recording its full cost. Missing trustworthy billing, oversized responses and uncertain transport retain the original hold. Both hops count against the logical-request, owner and agent limits. Stored profile, consent, source, label, grant, budget and lease guards remain enforced immediately before handoff and forwarding.

No schema migration is needed: existing generic broker receipt columns store the new versioned envelope/rubric/threshold identity. Old uncertain/completed batches are receipts, never invitations to resend to the replacement model. Old selections and derived forwarding/history bindings fail current policy checks. Existing grants preserve their saved scope but approve no new provider. `TYPESAFE_VERIFICATION` remains parseable for legacy environment compatibility only; it is unused by the broker. TypeSafe execution/protocol code has been removed.

## Server configuration

Reuse the existing protected `AI_SECRET_OPENROUTER` key. Add a `mail-broker` entry to the server's `AI_PROVIDER_PROFILES` array, preserving other entries. Do not paste credentials into chat or commit the environment file. This example contains no secret and is not installed by development:

```json
{
  "alias": "mail-broker",
  "adapter": "openrouter",
  "upstreamProvider": "google-vertex",
  "model": "google/gemini-2.5-flash-lite",
  "credentialEnv": "AI_SECRET_OPENROUTER",
  "enabled": true,
  "maxInputCharacters": 20480,
  "maxOutputTokens": 2048,
  "pricing": {
    "revision": "openrouter-mail-2026-10-16",
    "validUntil": "2026-11-15T00:00:00Z",
    "inputTokenLimit": 32000,
    "inputMicrosPerMillionTokens": 100000,
    "outputMicrosPerMillionTokens": 400000
  },
  "retentionDisclosure": {
    "revision": "openrouter-zdr-v1",
    "summary": "OpenRouter and Google Vertex receive bounded eligible mail text. Zero-retention endpoints only; no data collection, caching or fallback. This is not confidential computing."
  }
}
```

Recheck current terms, host prices and availability before using or renewing this dated example. At these rates the batch reservation is $0.004020, plus separately reserved receiving-model headroom. This is an application bound, not a vendor spending guarantee. Configure upstream account spending controls too. Changes to safe profile fields, credential presence, pricing or disclosures invalidate prior consent; replacing a credential value alone does not silently change the approved model/host.

After deployment and separately authorized evaluation, the owner approves the broker under Settings > AI > Mail access, allows `mail-broker` for the desired labels under Permissions, saves owner/agent connector/date grants and retains existing limits. The receiving Assistant still needs its own approval. No TypeSafe account or operator attestation is needed. Server configuration, owner approval and successful evaluation are distinct steps.

## Owner controls

Mail access displays broker model/OpenRouter/host, current approval, retention disclosure and input/output prices. Approve/Revoke uses the existing versioned consent API and registry revision, with idempotent operations, disabled offline writes and explicit reload after a conflict. Existing Use mail and Jev approval never approve this destination. Providers remains a read-only registry inspector; broker approval is available in Mail access.

Configured readiness is local configuration/permission readiness. `endpointStatus: unchecked` explicitly separates it from endpoint checks performed at each paid batch; no background paid health probe exists. The UI explains this distinction. Coverage/freshness, clipping, partial/blocked/uncertain outcomes, original messages sent and older-mail continuation retain J4 behavior. Imported coverage never establishes external Gmail/Proton completeness.

## Synthetic quality evaluation

`tests/fixtures/mail-broker-evaluation.json` supplies 60 labeled cases: exact evidence, paraphrases/multiple matches, topic-only/no matches, prompt injection, ambiguity and clipped excerpts. No real mail is included. Expected labels are hand-specified product fixtures, not model outputs or private-mail calibration.

For a separately authorized model run, send only each case's intent and candidate excerpts through the production rubric; keep expected labels out of the model input. Then supply one prediction per case as `{ "caseId": "chemistry-exact", "selectedKeys": ["m1"] }` in a JSON array. Score offline:

```sh
node scripts/evaluate-mail-broker.mjs predictions.json
```

The scorer rejects missing/duplicate cases and foreign/duplicate references and requires at least 90% direct-relevance precision and recall. It has no provider transport or credentials. Fake-adapter integration tests prove enforcement and recovery, not these quality thresholds. No actual model run has been performed. Owner live acceptance must separately assess usefulness and completeness warnings before expanding use.
