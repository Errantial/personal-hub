# Android prototype

The Capacitor APK bundles the React UI. The framework remains provisional until the owner's Mudita Kompakt passes the checks in [platforms.md](platforms.md). Native local reminder alarms are implemented; background synchronization is not.

The path to a release is in [android-release-plan.md](android-release-plan.md) (D58). The signed GitHub release feed and in-app updater are described in [app-updates.md](app-updates.md).

## Build

Use Node 24/npm 11, JDK 21, SDK platform 36 and build tools 35.0.0. Gradle 8.14.3 is pinned with its distribution checksum, Android Gradle Plugin is 8.13.0, and minimum API is 24. That minimum is a build setting, not verified Kompakt compatibility. Check actual device API/WebView first. [Capacitor requirements](https://capacitorjs.com/docs/updating/8-0), [environment setup](https://capacitorjs.com/docs/getting-started/environment-setup).

The build script discovers the Windows SDK and Temurin JDK 21. To override discovery, or on another OS, set `ANDROID_HOME` and `ANDROID_JAVA_HOME`. Environment changes apply only to build children. Android Studio's JDK 25 is unsuitable for this pinned Gradle version.

```sh
npm ci
npm run android:build -- --origin https://your-hub.example
```

Output: `.artifacts/android/personal-hub-debug.apk`. The API origin is fixed public build configuration; there is no runtime server picker yet. The server must allow `https://localhost` in `WEB_ORIGINS` alongside the website's HTTPS origin. Native HTTP sends that origin and the existing owner cookie; server authorization and mutation checks remain intact. Do not remove origin checks or enable browser CORS.

Every build gets `versionCode` = the commit count of `HEAD` and `versionName` = `<package version>+<short commit>` (with `.dirty` for uncommitted changes). The name is shown in Settings › Account › App updates, and the build script also passes the code into the web bundle so the version comparison works even before the native bridge responds. The script writes a `.sha256` file next to each APK.

`--release` builds a **signed** APK, `personal-hub-<versionName>.apk`, and refuses to run without a signing key, an `--origin https://...` server origin, or with uncommitted changes. It verifies the result with the SDK's `apksigner`. Supply the key only through the environment:

- `HUB_ANDROID_KEYSTORE`: absolute path to the release keystore, kept outside the repository with an offline backup.
- `HUB_ANDROID_KEYSTORE_PASSWORD` and `HUB_ANDROID_KEY_ALIAS`.
- `HUB_ANDROID_KEY_PASSWORD`: only if it differs from the keystore password.

The production key was created 2026-11-07 on the Windows build host: `C:\Users\Emil\.personal-hub-signing\personal-hub-release.jks`, alias `personal-hub`, RSA 4096, validity 10000 days. Its password is in the sibling `personal-hub-release.password`; the directory and both files are ACL-restricted to Emil and SYSTEM. The offline backup is `/mnt/data/secrets/personal-hub-signing/` on server1 (directory 0700, files 0600). Every later release must use the same key. A different key forces an uninstall, which deletes queued offline changes. Never commit or log the keystore or its passwords.

Certificate SHA-256 fingerprint: `F9:F1:69:37:1A:E0:E7:FA:D1:3B:0A:99:B3:10:BE:54:FC:28:94:01:00:C8:91:1F:BC:51:8D:C3:10:92:53:E7`.

Release builds reject the test connection flag and disable cleartext traffic. Debug builds use the machine's development key and a distinct application ID, `dev.personalhub.app.debug`.

## Install, update and rollback runbook

Prerequisites: the release APK and its `.sha256` file, the matching certificate fingerprint recorded with the release, `adb` from the SDK, and the Kompakt on the same network with wireless debugging enabled.

1. Verify the download before installing:
   ```sh
   sha256sum -c personal-hub-<version>.apk.sha256
   apksigner verify --print-certs personal-hub-<version>.apk
   ```
   The certificate digest must match the previous release. A different key cannot update an installed app.
2. Install or update with `adb -s <serial> install -r personal-hub-<version>.apk`. Android keeps app data, the native session, cached views, queued edits, and pending alarms when the signature matches.
3. Open Settings › Account and confirm the app version matches the APK.
4. If the server origin changed, confirm `https://localhost` is in `WEB_ORIGINS` and the app can sign in.

**Rollback.** Android does not allow installing a lower `versionCode` over a higher one. A rollback therefore requires an uninstall, which deletes the app's private data, cached views, queued offline edits, the native session, and pending alarms. Before uninstalling:

- Sync and resolve every queued change; confirm the header says **Online · All saved**.
- Export the planner JSON from Settings if the current data matters.
- Cached "Recently deleted" pages and reminder history are removed with the app data; the records remain on the server.

Prefer a forward fix with a higher `versionCode` over a rollback. If a rollback is unavoidable, uninstall (`adb uninstall <package>`), install the older APK, sign in again, and re-create alarms from the server reminders.

**Signing key.** Every release must use the same key. Keep the keystore outside the repository with an offline backup and record its certificate fingerprint with each release. Never put the keystore path or passwords in the repository, a build log, or chat.

**Release audit.** Release builds set `android:allowBackup="false"`, `android:usesCleartextTraffic="false"`, `loggingBehavior: "none"`, and the Capacitor request logger off. The `--test` origin is rejected. The APK does not include Google Services or Firebase. Recheck these in the built APK's merged manifest and confirm no test key or test connection is packaged before distributing it.

## In-app updates

Settings › Account › App updates checks the latest stable GitHub release through the owner-authorized server endpoint and offers a bounded download/install action. The native `AppUpdater` plugin reports the installed version and whether this package may install unknown apps, opens the Android setting for this package, downloads only a manifest-supplied HTTPS URL, verifies its SHA-256 and declared size, and launches Android's package-installer prompt through the existing `FileProvider`. It never installs silently and deletes failed or partial files. The app declares `REQUEST_INSTALL_PACKAGES`.

The manifest, tag and release runbook are in [app-updates.md](app-updates.md). The website can check the release feed but does not install; Settings says to open the Android app. No desktop build is published in this release. An update must use the same production signing key; Android rejects a different key. Emulator and Kompakt evidence for the installer prompt, permission toggle and download path is still required separately from server/web tests.

## Native reminder alarms

`@capacitor/local-notifications` 8.3.1 schedules reminder alarms on Android without Google Services. The Capacitor project root lists the plugin so `cap sync` registers its Gradle module; the web workspace imports it lazily and only on Android.

- The app reconciles at launch, when the shell resumes or comes online, after a server round-trip, and whenever the Inbox reminder list changes.
- Future `queued` or `failed` reminders get one alarm each. A stable FNV-1a hash of the reminder UUID is the Android notification id, so a rescheduled or renamed reminder cancels its own alarm and is scheduled again. Removed or finished reminders cancel theirs. Notifications the app did not schedule are left alone.
- Alarms use the `reminders` channel (high importance), the `hub_notification` monochrome icon, and `allowWhileIdle`. Exact delivery needs the Android exact-alarm setting; when it is denied the plugin schedules an inexact alarm and Inbox shows **Approximate**.
- If notification permission is missing, Inbox shows **Not enabled** with an **Enable device alarms** button. A denied permission shows **Blocked in Android settings**; after the owner allows it in Android settings, **Check again** re-reads the state. Requesting permission happens only from that button.
- Sign-out and session lock cancel the app's pending alarms and remove its delivered alerts so private reminder titles do not remain in the shade or on the lock screen.
- Android cancels alarms on **force-stop**. Test closed-app delivery with HOME and `adb shell am kill <package>` (or by swiping the app away), not with `force-stop`.
- The plugin's boot receiver restores pending alarms after a reboot (its manifest declares `RECEIVE_BOOT_COMPLETED`). A one-shot alarm whose time already passed while the phone was off is skipped; the inbox notification arrives from the server on the next launch. Doze and Mudita power modes may delay inexact alarms.

Device check: create a reminder about two minutes ahead, background or kill the app process, and confirm the notification appears; reboot with an alarm still in the future and confirm it fires afterwards. Then deny notifications or the exact-alarm setting and confirm Inbox reports the state instead of silently dropping the reminder.

Android 15/API 35 emulator result (2026-11-04, build `0.1.0+2db789f (test)`): Inbox showed **Allowed** with the scheduled count and **Approximate** while the exact-alarm setting was denied; granting `SCHEDULE_EXACT_ALARM` removed the approximate line. `dumpsys alarm` showed a `RTC_WAKEUP` with `window=0 exactAllowReason=permission` on the plugin's `TimedNotificationPublisher`. With the app process killed by `am kill` and the screen off, the alarm posted a `reminders`-channel notification titled **Personal Hub reminder**. The reboot attempt crashed the emulator process; a cold boot ran `LocalNotificationRestoreReceiver`, but the past-due one-shot alarm was not reposted, so future-alarm survival across a reboot still needs evidence. This is not Kompakt hardware.

## Isolated emulator workflow

```sh
npm run android:build -- --test
npm run android:server
```

The test APK connects to `http://127.0.0.1:3011` on the device. Keep the synthetic server running in another terminal, then use the SDK's `adb`, replacing the serial with the selected emulator:

```sh
adb -s emulator-5554 reverse tcp:3011 tcp:3011
adb -s emulator-5554 install -r .artifacts/android/personal-hub-emulator.apk
```

Open Personal Hub and enroll a synthetic account. The server creates a unique database under `.artifacts/android-test/`, binds loopback, reads no `.env`, and never touches `.data/planner`. Each invocation creates a fresh synthetic workspace. This test APK does not connect to the owner's server.

1. Load Today and its tasks. Enable e-ink appearance.
2. Remove forwarding: `adb -s emulator-5554 reverse --remove tcp:3011`.
3. Create a task, edit its notes and complete it. Check the pending count.
4. Force-stop: `adb -s emulator-5554 shell am force-stop dev.personalhub.app.debug`. Reopen without forwarding and verify cached access and queued changes.
5. Restore forwarding, select Sync now, and verify one server task with the expected final version. Reopen again to check native session persistence.

The Android instrumentation test `OfflineDeviceTest` has separate `enroll`, `queueOfflineTask`, `survivesRestartOffline` and `reconnect` phases. Build with `gradlew :app:assembleDebugAndroidTest`, install its test APK, and run each phase with `adb shell am instrument -w -e class dev.personalhub.app.OfflineDeviceTest#PHASE dev.personalhub.app.debug.test/androidx.test.runner.AndroidJUnitRunner`. Change forwarding and force-stop between phases as above; do not run all phases together against an arbitrary server.

The enrollment fixture is `android@example.test` / `synthetic-android-password`. Run `node scripts/android-receipt.mjs --empty` after the offline queue phase and `node scripts/android-receipt.mjs` after reconnect for independent server checks. These fixtures belong only to the isolated emulator server.

Verified 2026-10-10 on a new AOSP Android 14/API 34 emulator, WebView 113.0.5672.136, 720 × 1280 display at density 320 (360 CSS pixels wide). All four phases passed, including secure-context/Web Locks support, no service-worker controller, cached edits after process death, persistent cookie login, e-ink preference persistence and no horizontal overflow. Server receipts showed zero tasks offline and one completed task at version 3 after replay. Device panel attachment failed; adb and Android instrumentation supplied the evidence. This is not a Kompakt hardware result.

## Storage and privacy

Transactional IndexedDB stores the prototype's cache/outbox in the bundled WebView's app storage, with a separate database per API origin. This does not claim SQLite, encrypted offline records, a device unlock gate or guaranteed background delivery. Replay requires Web Locks; unsupported WebViews leave changes queued. Do not clear app data with pending edits. Session expiry/revocation and conflict handling reuse the browser rules. Uninstall deletes app data; Android backup is disabled.

Native service workers are disabled because the shell is bundled. API callers keep relative paths and use an explicit native HTTP transport. Its cookie jar persists the HttpOnly session; the app never copies cookies into the offline cache. Redirects and Capacitor request/bridge logging are disabled, including debug builds. Google Services, Firebase and Play Services are not required. [Native HTTP](https://capacitorjs.com/docs/apis/http).

## Remaining acceptance

Record emulator and hardware results separately. Actual Kompakt API/WebView, input, viewport, monochrome contrast, scrolling/ghosting, sleep modes and battery remain device gates. Native reminder alarms passed emulator scheduling, permission-state and closed-app delivery checks; future-alarm reboot survival, Doze and Mudita power modes still need device evidence. Production TLS login/session recovery and release signing are separate acceptance checks. The in-app updater has server/web/unit coverage but no emulator or Kompakt install-prompt, permission-toggle or downloaded-APK evidence yet.

## Shell changes and the 2026-11-01 emulator regression

The 2026-11-01 shell update routes the system Back gesture through WebView history, backgrounding the task when no history remains while keeping the callback enabled for later presses. The activity declares `adjustResize` for the soft keyboard. The instrumentation test follows the current route/editor selectors, completes through the editor's **Completed** checkbox rather than the hidden row checkbox, and asserts the row checkbox is disabled while that editor is open.

A second desktop emulation pass on 2026-11-01 re-tested branch `fix/android-qa-findings` at `9ff82e7` with an APK rebuilt from that commit: Android 15/API 35, WebView 124.0.6367.219, Pixel 9 AVD at 360 CSS px and 320 CSS px, WSL2 with KVM. All seven checks passed: offline notes and completion replayed with the expected receipt and no false conflict; the workspace banner cleared after reconnect; the editor was in view at both widths; two consecutive Back presses returned to Today and then backgrounded the app; a real touch raised the soft keyboard with `adjustResize`; e-ink radios, 320 px nav labels and calendar hour labels were legible; and all four instrumentation phases passed with the task at version 3. Screenshots and the isolated database were retained on the desktop host only.

A follow-up fixed the one remaining low-severity banner edge case: when only the workspace bootstrap failed and task sync kept succeeding, no `online` event fired, so the banner could persist beside "Online · All saved". A successful sync now triggers one workspace retry. The calendar also opens a quarter hour above its first row so the opening hour label is not split by the scroll edge.

A focused re-check rebuilt the APK from `38da2c6` and made the server unreachable at the device loopback, then restored it without toggling device networking (zero `online`/`offline` events). A manual sync cleared both the banner and the header summary without pressing Retry; a queued create and note edit replayed to the expected versions; and the first calendar hour label was fully visible at 360 CSS px. All five focused checks passed with no new defects.

These are emulator results. Actual Kompakt API/WebView, input, viewport, monochrome contrast, scrolling/ghosting, sleep modes, battery and release signing remain hardware gates.

## Kompakt hardware results (2026-11-03, first pass)

Device: Mudita Kompakt, MuditaOS K 1.6.1, Android 12/API 31 (build SP1A.210812.016, patch 2026-09-24), arm64-v8a, 480 × 800 at density 213 (360 CSS px, pixel ratio 1.33), `com.android.webview` 149.0.7827.164 as the only WebView provider, no Google Play Services. The test APK from `6433e3a` was installed over wireless debugging from the owner's desktop against the isolated loopback server.

- Passed: install and first launch (enrollment screen drawn, no WebView errors); instrumentation phases enroll, queueOfflineTask and survivesRestartOffline; both server receipts (zero tasks while offline, then one completed task at version 3 after replay); secure context, Web Locks and IndexedDB present, no service worker; no horizontal overflow at 360 CSS px; cold start about 1.8 s.
- Failed: the reconnect phase's e-ink persistence assertion. Sync completed, but `hub:eink` read `false`. Likely cause, not yet proven: the appearance setting is stored only in `localStorage`, and the process was killed about a second after the change, before Chromium flushed it to disk.
- Blank launch (diagnosed in a second session after a reboot): if the app process dies while the app is in the **foreground** (`am force-stop`, or a crash via `am crash`), the next launch shows a blank page. ActivityManager queues the WebView renderer service but never starts its isolated process, and logs no error or SELinux denial. This reproduced 10 out of 10 times. The stock WebView Shell app behaves the same way, so this is a MuditaOS/WebView defect, not Personal Hub code, and it is not a system-wide isolated-process limit.
  - What does not trigger it: killing the process while the app is **backgrounded** (HOME, then kill), whether by force-stop, `am kill` or a crash.
  - What clears it: going HOME and then killing the process. HOME and relaunching alone does not.
  - For users: Settings › Apps › Force stop happens while the app is in the background, so it clears a stuck launch.
  - Mitigation (implemented 2026-11-04): if no page becomes visible within 8 s of the app reaching the foreground, `MainActivity` shows "Personal Hub did not start. Open it again.", moves to the background and exits after 1.5 s, so the next launch starts cleanly. A second blank launch within 2 minutes does not exit again; it shows the Settings › Apps › Force stop instruction instead. Verified on the Kompakt on build `240e95d`: the app exits about 1.9 s after the toast and the next launch renders, repeated three times; a normal launch is unaffected. The first version had an overflow bug in the "recently recovered" check that made the very first blank launch show the Force stop message and never exit; it is fixed in `da36089` and confirmed on the 2026-11-04 re-test below.
  - Device tests must go HOME before every force-stop.
- E-ink setting: confirmed cause. On build `6433e3a`, e-ink was lost whenever the process was killed within about 1 s of the change (twice out of two). Appearance settings are now also copied to IndexedDB on every change and restored at startup if localStorage kept an older state. On build `240e95d` all six trials kept e-ink, including the immediate kill.
- Screens (e-ink, 360 CSS px, build `240e95d`): Today, navigation, Tasks, Calendar Week and Day, and Settings had no horizontal overflow or clipped labels; text is black on white except placeholders at about 4.6:1. Back goes Calendar → Today, then backgrounds the app with the process alive. Known limitations: Week header labels wrap unevenly ("Fri 6" and "Sat 7" fit on one line, other days stack). The soft keyboard works, but the fixed bottom bar rose above it and covered the Add field's buttons; the bar is now hidden while a text field has focus on touch screens (confirmed on the 2026-11-04 re-test below).
- Battery was 26% at the end of the run; battery drain over a day has not been measured.
- The screen checks blocked by the first blank WebView were completed in later runs; the 2026-11-04 re-test below covers the remaining recovery and keyboard items.

## Kompakt hardware re-test (2026-11-04, final)

Device and build: same Kompakt (MuditaOS K 1.6.1, Android 12/API 31, WebView 149.0.7827.164, 360 CSS px). The APK was built from `da36089` (version `0.1.0+da36089`, SHA-256 `fc54c66a0f50c16d7c2df7ff38fcbee302578c45f28a0f7c4b1ea688fc30f082`) and installed over wireless debugging against the isolated synthetic server. App data and the synthetic session survived the install.

- First blank launch (recovery sentinel cleared): a foreground force-stop followed by a launch stayed blank, then showed "Personal Hub did not start. Open it again." at +8.73 s, moved to the background and died 1.92 s later. The next launch rendered Today in 1.75 s with no toast. The old first-launch overflow bug did not recur.
- Repeat blank within 2 minutes: "Force stop it in Settings › Apps, then open it again." appeared at +10.53 s and the app stayed open and resumed, as designed. A second repeat also stayed open.
- Normal launch: rendered in 1.75 s, no toast, process alive and resumed after 13 s.
- Keyboard: tapping the Add field raised the IME (`mInputShown=true`); `innerHeight` fell from 565 to 303, the bottom nav became `display:none` with a 0×0 rect, and the input (bottom 247.7) plus Add button (bottom 303.68) stayed unobscured. Tapping outside hid the keyboard and restored the nav to `display:flex`.
- No fatal exceptions, ANRs or new app errors; the app stayed signed in as the synthetic account and e-ink was preserved.
- Known limitations unchanged: Calendar Week header labels wrap unevenly at 360 CSS px; toasts are not captured by `screencap` (logcat used); wireless-debugging ports rotate and mDNS was not advertising during the run.
