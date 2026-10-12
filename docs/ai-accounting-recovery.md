# Offline charge-only accounting recovery

Implemented 2026-10-12. An internal synthetic recovery function can now settle exact reported usage from the durable protocol observation without provider I/O, prompt resupply, answer reconstruction or a caller-supplied charge. Public dispatch/confirmation routes, workers and live invoice verification remain disabled.

## Recovery authority

recoverSyntheticOpenRouterAccounting requires test configuration, an owned request ID and the expected independent attempt version. A complete state=reported protocolObservation supplies generation ID, native counts, exact micro-dollar cost and output state. Missing observations and identifier-only uncertain observations return PROTOCOL_USAGE_UNAVAILABLE; the full hold remains. Recording a generation ID alone does not establish a bill.

For a new settlement, the attempt version is checked under the existing budget/request/attempt lock order. Observation identity/counts/cost/output state must still match. Atomic settlement updates reservation, attempt and request together. Failure rolls back accounting while preserving the immutable observation and original hold. No external call or retry occurs. Concurrent recovery settles only once; an identical old-version replay of already-settled observed usage returns current metadata without writes.

Recovery does not change owner consent or claim a live invoice. Current account/route verification, complete upstream billing bounds and verified provider reconciliation remain necessary before real usage. The synthetic function books a previously observed test report, not new inference. Hiding/cancelling uncertain requests remains blocked; after settlement, ordinary hiding and metadata-only replay continue to work.

## Lost text and saved answers

Migration 044 extends resultMetadata.status with unavailable. A validated protocol report whose output text is absent recovers as completed accounting with synthetic=true, retained=false, status=unavailable, answerCharacters=null and suggestionCount=null. protocolMetadata.outputState remains validated to describe the original observation; resultMetadata describes current result availability. Missing text is not represented as invalid output or an empty answer.

Rejected/blocked/error reports retain status=invalid result metadata; provider-error accounting is failed and other coherent reports are completed. Recovery never inserts an answer, even when saveAnswer=true. Per-request consent allows saving actual validated text; it cannot recreate lost text. A late result cannot overwrite an unavailable confirmation or backfill an answer. A new deliberate request remains separate.

Replaying recovery after normal successful settlement preserves the original result metadata and independently saved answer. Replaying after forgetting never restores text. SQL checks require unavailable metadata to be nonretained with null counts and completed accounting backed by matching validated protocol observation/metadata and exact native usage. The existing saved-answer consent trigger rejects unavailable result insertion. Old validated/invalid records and export parsing remain compatible.

## UI and validation

Owned attempt reads/export may now include status=unavailable in resultMetadata. Keep confirmed charges distinct from available answers and completed actions. An unavailable answer has no text to show or save; offer no automatic resend/regeneration. Existing dedicated answer read/forget, version guards, owner labels and unavailable-provider blocking remain unchanged. No new UI/authentication code or recovery endpoint is added.

Ten new focused tests cover populated upgrade, answer-storage rollback followed by recovery, exact cost/hold replacement, missing evidence, ownership/test guards, attempt-version and hide behavior, concurrent/idempotent settlement, successful/forgotten answers, late-backfill and SQL/schema rejection, atomic accounting rollback, rejected/error classification and recovery across two restarts. Final npm run check passed lint, strict types, formatting, production builds and 383 API/client tests; one optional standard PostgreSQL test was skipped. All ten new focused recovery tests passed, including concurrency, atomic rollback, populated migration and two persisted restarts. Browser tests were not rerun because UI/authentication code was unchanged. No owner database, real provider, paid AI or device tests were used. Tests use isolated synthetic databases and forbid fetch; no real provider, paid inference, owner database reset or device test is used.
