# Offline protocol recovery observations

Implemented 2026-10-12. Synthetic OpenRouter exchanges now preserve a bounded protocol observation before attempting atomic settlement. This closes the metadata gap for uncertain response identifiers and coherent usage reports followed by answer/accounting storage failure. Live dispatch, provider reconciliation networking and public confirmation endpoints remain disabled.

## Durable evidence

Migration 043 adds nullable protocol_observation to owned attempts. Shared reads/export expose protocolObservation. Legacy and byte-token attempts default null. All observations have synthetic=true and protocol=openrouter. A reported observation has state=reported, generationId, native usage={inputTokens,outputTokens,actualMicros} and outputState=validated|invalid|provider-error|blocked. An uncertain observation has state=uncertain, nullable generationId and reason=transport|timeout|aborted|response|destination|billing. IDs are bounded to the existing 1-160 ASCII identifier grammar; counts/cost are bounded nonnegative integers. Neither shape accepts prompts, answer text, credentials or raw errors.

Observation recording uses the existing owner/budget/request/attempt lock order and checks the admitted provider. It commits separately before settlement, advancing only the attempt version. Parent request version and budget reservation do not change. The first observation is immutable: identical recording is idempotent; changed recording conflicts. SQL checks enforce the shape, and a trigger forbids replacement/clearing and requires an existing, versioned uncertain attempt for initial recording.

The observation describes what the synthetic protocol returned; it is not a verified invoice, upstream identity, confidential route or successful action. A reported observation can coexist with an uncertain request and null settled cost/result metadata. Missing or changed-model billing remains uncertain even when a generation ID exists. Timeout/transport results without a complete decoded identity record generationId=null. Pre-aborted requests do not create attempts or observations.

## Settlement and failures

[Offline charge-only recovery](ai-accounting-recovery.md) now settles immutable reported usage after lost validated output without reconstructing text. Its result metadata explicitly marks the answer unavailable. Live provider lookup and invoice verification remain pending.

Atomic settlement/saved-answer insertion remains separate. If it fails, the observation survives while the original full uncertain reservation remains held. No result text is returned as successful. Internal synthetic reconciliation must match any recorded generation ID; reported observations additionally bind exact counts, cost and output state. It cannot switch to fake byte-token accounting to bypass these checks. Existing idempotent settlement and forgotten-answer protection remain.

Observation persistence can itself fail, or the process can stop before recording. Those attempts retain the full hold with a null observation and never resend. The observation does not contain output text, so it cannot recover an answer lost after receipt or authorize reconstructing/saving one. Offline charge-only recovery is now implemented separately; provider generation-status lookup and verified live invoice reconciliation remain pending. No worker or automatic settlement is added.

## UI and validation

Show protocol observations as synthetic diagnostic metadata, distinct from settled accounting. A reported charge is not a saved answer; an uncertain generation ID is not successful inference. Preserve current per-request consent, owned answer read/forget, unavailable-provider blocking, metadata-only request history and no automatic retry/refund behavior. Use the attempt version when refreshing diagnostic state; do not infer a parent-version change.

Eight new focused tests cover populated migration/old-schema defaults, uncertain IDs, timeouts, rollback-surviving reports, reconciliation conflicts, idempotency/SQL immutability, strict private-field rejection, ownership/export, test-only/state guards and observation-storage failure. Existing persistent restart coverage now asserts both reported and uncertain observations. Final npm run check passed lint, strict types, formatting, production builds and 373 API/client tests; one optional standard PostgreSQL test was skipped. Eight new focused tests passed and existing restart coverage now checks observations. The initial ownership edge-case failure was corrected before the clean full run. Browser tests were not rerun because UI/authentication code was unchanged. No owner database, real providers, paid AI or device tests were used. Tests use isolated synthetic data and forbid fetch; no owner database, real provider, paid AI or device test is used.
