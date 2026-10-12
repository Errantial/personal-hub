# Offline OpenRouter durable accounting

Implemented 2026-10-12. The injected-I/O OpenRouter protocol exercise now connects to owned durable requests, atomic attempt accounting and explicitly consented saved answers through executeSyntheticOpenRouterRequest. It requires test configuration and synthetic-prefixed credentials. There is no default fetch, production switch, public dispatch endpoint or owner account access. Every result remains synthetic.

## Admission and settlement

[Protocol recovery observations](ai-protocol-recovery.md) now preserve uncertain identifiers and coherent synthetic reports before settlement. The observation is immutable metadata and cannot recover lost answer text or establish a live invoice.

The integration uses the existing exact-context binding, owner route/consent checks and budget-first admission lock. A committed attempt becomes uncertain before its single injected exchange. Current context/provenance, consent, routing and budget are rechecked immediately before that exchange. Existing attempts return their current state without transmitting again, including after a restart or storage failure. A pre-aborted request or rejected real/non-test configuration creates no attempt.

Coherent reported native input/output counts and exact reported cost settle the reservation directly. They are not converted to the older fake adapter's byte-token pricing. Existing synthetic byte-token execution retains its original behavior. Reported overruns are recorded at their actual amount and included in budget overrun totals; settlement never clips an invoice to a reservation or pretends a known charge was free. These are synthetic protocol reports, not verified live invoices. A complete upstream billable bound is still required before real dispatch can enforce the owner's spending ceiling.

Migration 042 adds nullable protocol_metadata. Owned request/attempt reads and portable export expose protocolMetadata={synthetic:true,protocol:openrouter,generationId,outputState}. Generation IDs are restricted to 1-160 ASCII letters, digits, underscores or hyphens. outputState is validated, invalid, provider-error or blocked. Old/byte-token attempts default null; prompts, raw errors and rejected output are absent. SQL checks reject unknown keys and malformed metadata.

Provider-error maps to failed; validated/invalid/blocked results with coherent usage map to completed accounting. Completed is not proof of useful output or successful planner action. Missing billing, timeout, cancellation or transport uncertainty leaves the full uncertain hold and null confirmation metadata. No automatic retry or refund is inferred. Durable protocol observations now preserve bounded uncertain identities; verified provider lookup and reconciliation remain pending.

## Answers and recovery

Validated output is returned only from the immediate internal test call. It is saved only when the original request has saveAnswer=true. Native token counts are checked against admitted limits; the old byte-token equality requirement applies only to the original fake adapter. Structured output/source-version/character limits still apply. Attempt metadata, cost settlement, request state and saved answer insertion commit together. A storage failure rolls back all of them and keeps the full hold; no text is returned as a successful result.

Internal synthetic reconciliation can confirm the same known result without provider I/O. Matching counts, exact cost, generation identity, output state and result metadata are idempotent; changed values conflict. Reconciliation after forgetting never restores cleared answer text. Owned answer reads/forget/export and metadata-only history retain their existing contracts. Public usage/confirmation endpoints are not added.

## Validation and remaining work

Eleven focused tests cover reported billing versus byte counts, consent, temporary output, invalid/error/blocked charges, uncertain outcomes, atomic storage rollback/reconciliation, conflicting/repeated results, forgetting, owner/SQL isolation, configuration/abort guards, overruns, populated migration and persisted restart. Final npm run check passed lint, strict types, formatting, production builds and 365 API/client tests; one optional standard PostgreSQL test was skipped. All eleven new focused tests passed. The initial lint issues in test fixtures were corrected before the clean full run. Browser tests were not rerun because UI/authentication code was unchanged. No owner database, real providers, paid AI or device tests were used. Tests use isolated synthetic databases and forbid fetch; no live provider, paid inference, owner database reset or device test occurs.

Live provider transport, verified upstream/account/privacy, complete worst-case fees/token accounting, subscription isolation and Prem attestation remain pending. Protocol metadata does not prove actual upstream identity or confidentiality. Public dispatch and live answer delivery remain disabled.
