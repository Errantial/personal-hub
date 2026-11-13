# Android release plan

Status: proposal approved by the owner on 2026-11-02 (decision D58). Nothing in this plan is implemented yet unless it is marked done. Emulator results and Kompakt hardware results are recorded separately in [android.md](android.md).

## Release bar

- Personal sideload onto the owner's Mudita Kompakt, installed over Android wireless debugging. No Play Store, Google Services or FCM.
- Signed release APK built from a tagged commit, with a recorded SHA-256 checksum.
- Calendar, class and reminder screens work offline for both viewing and editing, using the same durable outbox rules as tasks: stable IDs, optimistic versions, ordered replay, conflict retention and tombstones.
- Reminders alert on the device while the app is closed and after a reboot.
- About a week of daily use on the Kompakt before the release is called done.

## Current state (2026-11-07)

- Done: bundled UI, native cookie session, task outbox, cached viewing of any GET response loaded at least once (calendar, class and reminder screens included), Back gesture handling, `adjustResize` keyboard behavior, blank-launch recovery, immediate e-ink persistence, and hiding the bottom bar above the soft keyboard. Emulator QA passed (PR #59), and the Kompakt baseline passed the final hardware re-test on `da36089`.
- Signing path: git-derived versions, the version shown in Settings › Account, environment-only release signing, `apksigner` verification and a SHA-256 file are implemented. The production keystore was created 2026-11-07 (RSA 4096, alias `personal-hub`, certificate SHA-256 `F9:F1:69:37:1A:E0:E7:FA:D1:3B:0A:99:B3:10:BE:54:FC:28:94:01:00:C8:91:1F:BC:51:8D:C3:10:92:53:E7`) and backed up outside the repository. The production-signed APK is `0.1.0+f433b9c` (code 254), SHA-256 `d5d14945d4d0306533018ca8d76efef26e3161ca53f106fddf741818122ad127`.
- Update feed (2026-11-13): the owner-authorized server check, `release-manifest.json` contract, signed release tooling, Android `AppUpdater` plugin and Settings › Account › App updates are implemented on `release/2026-11-13`. No release was published by this work, desktop remains a reserved slot, and the installer prompt/permission/download path still needs emulator and Kompakt evidence.
- Offline edits: classes, topics, reminders, calendar series, per-occurrence overrides/deletes, individual and selected academic work, Undo restore and cached Recently deleted pages are done (2026-11-04 to 2026-11-06: queued create/edit/delete, reminder controls, event and occurrence projection, batch projection and retained conflicts).
- Native reminders: implemented 2026-11-04 with `@capacitor/local-notifications` 8.3.1. Emulator checks passed for scheduling, the permission and exact-alarm states, and delivery with the app process killed and the screen off. Reboot survival and Mudita power modes remain hardware checks.
- Production: `https://localhost` is now allowed beside `https://hub.ecg.name`; a live POST with that origin returned the normal credential error and a random origin returned 403. Deploying current `main` is blocked because production is running a newer unmerged release (`551167b`, migrations through 076) while `main` stops at migration 072; see [the deployment note](../deploy/oracle-linux/README.md#production-state-2026-11-07).
- Missing: Kompakt evidence for native alarms (reboot and power modes), the week of daily use, and reconciliation of the newer production release before `main` can be redeployed.

## Phases

### 1. Kompakt baseline (go/no-go)

Completed 2026-11-04. A signed debug APK built with `--test` was installed over wireless debugging and used with `adb reverse tcp:3011 tcp:3011` against the isolated synthetic server; the owner's server and database were not used.

- Recorded: MuditaOS K 1.6.1, Android 12/API 31, WebView 149.0.7827.164, 480 × 800 at density 213 (360 CSS px), no Google Services.
- Passed: install and first launch, offline replay after force-stop at version 3, secure context/Web Locks/IndexedDB, no horizontal overflow, e-ink screens, Back gesture, soft keyboard, first-blank-launch recovery, repeat-blank guard, normal launch, bottom-bar hiding above the keyboard, and the synthetic session surviving a reinstall. Details and timings are in [android.md](android.md).
- Known limitations: Calendar Week header labels wrap unevenly at 360 CSS px; toasts are not captured by `screencap` (logcat used); wireless-debugging ports rotate. Sleep/power modes and a week of battery use are still part of Phase 6.

The two hardware findings from the first pass have mitigations that passed the final re-test: foreground process death no longer leaves the app stuck blank, and e-ink changes survive an immediate kill.

### 2. Signed release build

- Keep the release keystore outside the repository, with an offline backup. Every update must be signed with the same key. A different key forces an uninstall, which deletes queued offline edits.
- Done 2026-11-04: `versionCode` and `versionName` come from git, and the version is shown in Settings › Account.
- Signing code done 2026-11-04: `npm run android:build -- --release` signs from environment variables, verifies with `apksigner` and writes a checksum. The pipeline was exercised with a temporary test key: release v1 (code 224) installed, then v2 (code 225) installed over it with the same certificate.
- Done 2026-11-07: production keystore generated on the Windows build host and backed up to server1; production-signed APK `0.1.0+f433b9c` (code 254) built from clean `main`, V2 verified, manifest audited and SHA-256 written. Install on the Kompakt remains.
- Production allowlist done 2026-11-07: `WEB_ORIGINS=https://hub.ecg.name,https://localhost`, env backed up, service restarted, site ready, allowed origin accepted and a random origin rejected. Deploying current `main` is blocked by the production/main divergence recorded in [the deployment note](../deploy/oracle-linux/README.md#production-state-2026-11-07).

### 3. Offline calendar, class and reminder edits

- Generalize the task outbox to a typed job queue that covers events, classes, academic work and reminders, including reminder snooze, pause and cancel. Keep replay order, per-record versions, explicit conflict recovery and delete tombstones.
- Server operations must already be idempotent by operation ID. Confirm each one, and add receipts where they are missing.
- Pending, offline and conflict state stays visible on each touched screen.
- Done 2026-11-04: classes and topics queue create, edit and delete with client-supplied IDs; cached lists project queued changes; replay merges the server record; conflicts stay in the global banner with explicit discard. Browser coverage includes offline class/topic create, edit, delete and one-time replay.
- Done 2026-11-04: reminders queue create, reschedule, snooze, pause, resume, retry and cancel. Cached reminder lists project status/time changes; a snooze queues both the source version and the child reminder; replay merges the server records.
- Done 2026-11-04: calendar series create, edit and delete queue offline. Cached series and occurrence windows project the change, including recurring expansion; replay merges the saved series and refreshes cached occurrence windows.
- Done 2026-11-04: per-occurrence overrides and occurrence-scoped deletes queue offline. The editor falls back to the view's cached occurrence window when its own wider window was never cached; projection patches only the affected date, and replay keeps other server exceptions. Series restore also queues offline through Undo.
- Done 2026-11-04: academic work browse pages are cached. Individual work create, edit and delete queue offline with client-generated ids, project into the cached page and replay once. Work Undo restore also queues offline.
- Done 2026-11-06: selected work changes queue as one atomic batch and project into cached pages; cached Recently deleted pages for tasks, events and work project queued deletes and restores, and restore from that list queues offline.
- Remaining: none for the release bar.
- Browser e2e coverage for every queued kind. Emulator instrumentation covers process death and replay.

### 4. Native reminders

- Done 2026-11-04: `@capacitor/local-notifications` 8.3.1, with no Google Services.
- Done: reconcile at launch, on resume/online, after a server round-trip and whenever the Inbox reminder list changes. Future `queued`/`failed` reminders get a stable alarm; edits replace their own alarm and finished or removed reminders cancel theirs. See [android.md](android.md#native-reminder-alarms).
- Done: notification permission (Android 13+) and exact-alarm state stay visible in Inbox, with enable, retry and exact-settings actions. Denied state never hides the reminder.
- Emulator 2026-11-04: scheduling, exact and inexact states, and delivery after `am kill` with the screen off passed. The reboot attempt crashed the emulator process; future-alarm survival and reboot restore still need evidence.
- Remaining: Kompakt reboot restore, Doze and Mudita power modes.
- Known limit: without push, a reminder created on another device only reaches the phone at its next sync. A periodic background sync (WorkManager) is optional and needs its own decision.
- Known limit: a one-shot alarm whose time passes while the phone is powered off is skipped by plugin 8.3.1's boot restore; the inbox notification still arrives from the server on the next app launch.

### 5. Production hardening

- Over HTTPS: login, session expiry, revocation, and the lock-and-recover flow on the device.
- Upgrade test: install version N, queue offline edits, then install N+1 signed with the same key. Edits survive and replay once.
- In-app updater: exercise the unknown-apps permission toggle, an interrupted/oversized/wrong-digest download (nothing installs), the system installer prompt and an N→N+1 update over the installed release with the same key.
- Recheck that release builds have no request logging, no Android backup and no cleartext traffic.
- Add an install, update and rollback runbook to [android.md](android.md). Rolling back requires an uninstall, so warn when edits are pending.

### 6. Acceptance

- About a week of daily use on the Kompakt: battery, reminder delivery, sync conflicts and readability.
- Record the results in [implementation-log.md](implementation-log.md). Tag the release and keep the signed APK and checksum outside the repository.

## Wireless install procedure

The installing machine must be on the same network as the Kompakt.

1. On the Kompakt, open Developer options, turn on **Wireless debugging**, then choose **Pair device with pairing code**.
2. `adb pair <ip>:<pairing-port>` with the six-digit code. Pairing codes expire quickly and are not recorded.
3. `adb connect <ip>:<debug-port>`. The debug port is shown on the main Wireless debugging screen and differs from the pairing port.
4. `adb -s <ip>:<debug-port> install -r <apk>`.

Turn Wireless debugging off after the session.
