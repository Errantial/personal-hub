# Scheduled agent acceptance

Baseline reconciled 2026-10-14: deployed release `519054d`, migration 057, D57 scheduled agents. This checklist separates completed implementation/deployment from owner-controlled live acceptance. It contains no owner goals, mail content, credentials or private source text. Later releases must record their own validation rather than inherit this snapshot as proof.

## Evidence already recorded

- Backend, UI and notifications integrated through PRs 30–33; release `519054d` deployed at https://hub.ecg.name.
- Historical automated receipt: `npm run check` passed 628 tests, with one optional standard PostgreSQL test skipped locally. Final complete browser run passed 144 cases using synthetic providers and isolated databases. PostgreSQL CI passed on the code branches; this does not turn the local skip into a passing test.
- Deployment receipt: artifact/migration bytes checked; backup/isolated restore verified before activation and after migration 057; runtime import checked as service user after correcting staging permissions. API/Caddy active, public readiness and deployed asset hashes verified; unauthenticated agent routes return 401.
- Server-side worker heartbeat was healthy with zero configured agents at deployment. An authenticated HTTP health read, first owner-created agent/run and live usefulness remained unverified.
- Windows mail sync was recorded as operating every ten minutes. Its existence does not prove required Gmail coverage, freshness during outages or move/deletion reconciliation.

Sources: [implementation log](implementation-log.md), [operating receipt](../deploy/oracle-linux/README.md#release-519054d-2026-10-14), [backlog](backlog.md). No new live audit is claimed by this document.

## Synthetic development gates

These checks use fake providers, clocks and isolated databases. Never trigger paid inference, seed/reset the owner's database, or exhaust a live spending cap to prove a boundary. Existing historical passes do not establish that the proposed regression work has been implemented.

- [ ] Record the tested commit, migration range and actual `npm run check` result for each code slice. Run `npm run test:e2e` sequentially afterward for UI/auth changes.
- [ ] Run queue concurrency/fencing tests on disposable standard PostgreSQL; record a skip as unverified. Include two workers, expiry and a late response after ownership loss.
- [ ] Test heartbeat/progress timestamps during a valid long run and distinguish worker disabled, stalled and actively processing states.
- [ ] Inject restart/failure before reservation, after dispatch, before/after every planner effect and before item/result persistence. Reconcile durable write receipts without duplicate effects or provider redispatch.
- [ ] Test no-key, unavailable/private-host catalog, stale agent version, labels, safe refusal versus uncertain outcome, retry eligibility, cap admission, holds, month/timezone boundaries and manual resume after cap pause.
- [ ] Preserve Pause-finish-running behavior and verify action policy/version checks at the actual write boundary. Any separate Stop behavior needs its own contract.
- [ ] Reproduce history/output provenance cases: mail switched off after an earlier mail answer, source relabel/revocation between rounds, and derived proposals saved as planner records. Add academic/memory cases before enabling either source.
- [ ] Preserve owner authorization, no silent routing fallback, text-only/body-origin restrictions, idempotent Apply/Undo and conflict drafts. Confirm synthetic payloads contain no forbidden attachment-derived text.
- [ ] Verify run/precheck errors, uncertainty, notification/read-on-open pagination and lost-response recovery. Preserve quiet agents and reminder alert behavior; test narrow light/dark/e-ink layouts and keyboard/tap interactions when touched.
- [ ] Exercise release preflight against an unreadable stage as the service user. Keep migrations append-only, verify isolated restore and check forward-schema compatibility before code rollback; never automatically restore an old database over owner writes.

The [post-agents plan](post-agents-development-plan.md) defines these improvements. They are not a claim that every current behavior already passes them. The deployed baseline uses a pre-run threshold and can cross it during a run. The first development batch adds strict per-exchange admission reservations with migration 058; deployment and live acceptance of that change remain separate. The implementation log records exactly which synthetic cases ran; unchecked items here include broader future gates.

## Owner-controlled live acceptance

Current status: **pending**. Development authorization is not evidence that any of these checks occurred. Routine development must not create a live agent or dispatch a paid request merely to complete this checklist.

Use one owner-selected bounded agent first, with reviewed goal/mail scope, existing request/monthly limits and an explicit action policy. Ask first is recommended for this canary; do not change global policy automatically. Keep scope within D57: no memory, MCP, external calendar writes, email sends, delegation or event triggers.

- [ ] Owner-authenticated agent/settings/conversation/worker reads succeed on the recorded release. Verify health through the supported owned interface; do not expose anonymous worker diagnostics to achieve this.
- [ ] Owner creates the first agent with the intended timezone, local schedule, mail selection and cap. Confirm previewed next run and pinned conversation; creation does not count as execution.
- [ ] Observe a manual run and several scheduled runs. Record planned slot versus actual start/finish, outcome category and whether results appear once in the correct conversation/Inbox. Do not claim comprehensive academic deadlines from the current bounded planner context.
- [ ] Review the result against the owner's intended planning step. Record useful/needs-change with a brief nonprivate reason, without copying the goal, answer or mail. A completed provider response alone is not usefulness acceptance.
- [ ] For ask-first proposals, the owner deliberately reviews Apply/Undo and verifies the resulting hub records. Automatic mode needs an explicitly selected bounded hub-only trial; it is not a prerequisite for the read/ask-first canary.
- [ ] Pause prevents new admissions, while an already-running run may finish. Resume deliberately; Run now creates no duplicate live run. Delete leaves retained conversation behavior consistent with the UI contract.
- [ ] Confirm notifications/read-on-open on the owner's device without duplicate reminder alerts. Quiet agents remain quiet. Offline/pending/conflict states remain visible and do not imply server execution stopped.
- [ ] Observe an ordinary offline-connector interval and recovery when convenient; do not disable owner services as a routine test. Record coverage/freshness limitations rather than infer no new mail from an empty result.
- [ ] At an agreed maintenance restart, confirm retained runs/conversations and no duplicate effects. Fault/crash injection belongs in isolated tests; an ordinary restart does not prove every recovery boundary.
- [ ] Review settled cost and unresolved holds without intentionally approaching/exhausting a live cap. Uncertain outcomes are investigated without blind Retry. Record local ledger values as reported, not as independent provider-invoice verification.

Canvas/Gmail completeness, Outlook consent, memory forget/history behavior and MCP client acceptance each need their own later source gate. Actual Kompakt, closed-app reminders and screen-reader verification stay distinct from Chromium/AOSP results. Encrypted off-host backups remain owner-deferred.

## Receipt format and closure

Append completed checks to [implementation-log.md](implementation-log.md) with date/timezone, release/commit, migration, environment (synthetic/local PostgreSQL/CI/owner live), nonprivate run identifier if appropriate, start/finish/outcome category, cost/hold units, source coverage and unresolved limitations. Do not store goal/answer/message text, mail subjects, private URLs, session identifiers, tokens or full provider payloads. Owner IDs and internal run IDs are not a substitute for redaction.

Use **passed**, **failed**, **not run** or **blocked by capability**, with the evidence source. Do not mark synthetic validation as live acceptance or treat unavailable account access as an implementation success. Close deployment acceptance only for the recorded release; close usefulness acceptance only after the owner reviews results. Keep unresolved limitations visible in the backlog and UI ledger before expanding autonomy or context.
