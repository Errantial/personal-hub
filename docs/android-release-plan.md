# Android release plan

Status: proposal approved by the owner on 2026-11-02 (decision D58). Nothing in this plan is implemented yet unless it is marked done. Emulator results and Kompakt hardware results are recorded separately in [android.md](android.md).

## Release bar

- Personal sideload onto the owner's Mudita Kompakt, installed over Android wireless debugging. No Play Store, Google Services or FCM.
- Signed release APK built from a tagged commit, with a recorded SHA-256 checksum.
- Calendar, class and reminder screens work offline for both viewing and editing, using the same durable outbox rules as tasks: stable IDs, optimistic versions, ordered replay, conflict retention and tombstones.
- Reminders alert on the device while the app is closed and after a reboot.
- About a week of daily use on the Kompakt before the release is called done.

## Current state (2026-11-02)

- Done: bundled UI, native cookie session, task outbox, cached viewing of any GET response loaded at least once (calendar, class and reminder screens included), Back gesture handling, `adjustResize` keyboard behavior. Emulator QA passed (PR #59).
- Missing: Kompakt hardware results, signing, versioning (`versionCode 1`), offline edits outside tasks, native reminders.

## Phases

### 1. Kompakt baseline (go/no-go)

Install a signed debug APK built with `--test` over wireless debugging. Use `adb reverse tcp:3011 tcp:3011` to reach the isolated synthetic server. The owner's server and database are not used.

- Record the firmware version, Android API level, WebView version and viewport.
- Rerun the emulator checks and the [platforms.md](platforms.md) checklist: offline replay after force-stop, Web Locks, e-ink contrast and ghosting, touch and keyboard input, Back gesture, 320 px layout, sleep and power modes.
- Stop and reconsider the shell if Web Locks are missing, the WebView is too old for the bundle, or e-ink rendering is unusable.

Found on the hardware so far (details in [android.md](android.md)): a foreground process death leaves the next launch blank (OS/WebView defect, needs a native recovery path). The e-ink setting may be lost if the app is killed right after it changes.

### 2. Signed release build

- Keep the release keystore outside the repository, with an offline backup. Every update must be signed with the same key. A different key forces an uninstall, which deletes queued offline edits.
- Done 2026-11-04: `versionCode` and `versionName` come from git, and the version is shown in Settings › Account.
- Done 2026-11-04 (keystore not yet created): `npm run android:build -- --release` signs from environment variables, verifies with `apksigner` and writes a checksum. Versions come from git.
- Production: deploy current `main` and add `https://localhost` to `WEB_ORIGINS`.

### 3. Offline calendar, class and reminder edits

- Generalize the task outbox to a typed job queue that covers events, classes, academic work and reminders, including reminder snooze, pause and cancel. Keep replay order, per-record versions, explicit conflict recovery and delete tombstones.
- Server operations must already be idempotent by operation ID. Confirm each one, and add receipts where they are missing.
- Pending, offline and conflict state stays visible on each touched screen.
- Browser e2e coverage for every queued kind. Emulator instrumentation covers process death and replay.

### 4. Native reminders

- Add `@capacitor/local-notifications`. It does not require Google Services.
- After each sync, on resume and after each local reminder edit, reconcile server reminders into local alarms, keyed by reminder ID and version. Cancel, snooze, delivery and read state remove or replace alarms, so nothing fires twice.
- Notification permission (Android 13+) and exact-alarm permission (Android 12+): denied or revoked state stays visible, with a route to system Settings.
- Reschedule after reboot. Test Doze and Mudita power modes.
- Known limit: without push, a reminder created on another device only reaches the phone at its next sync. A periodic background sync (WorkManager) is optional and needs its own decision.

### 5. Production hardening

- Over HTTPS: login, session expiry, revocation, and the lock-and-recover flow on the device.
- Upgrade test: install version N, queue offline edits, then install N+1 signed with the same key. Edits survive and replay once.
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
