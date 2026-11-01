# Android prototype

The Capacitor APK bundles the React UI. The framework remains provisional until the owner's Mudita Kompakt passes the checks in [platforms.md](platforms.md). Native local alarms and background synchronization are not implemented.

## Build

Use Node 24/npm 11, JDK 21, SDK platform 36 and build tools 35.0.0. Gradle 8.14.3 is pinned with its distribution checksum, Android Gradle Plugin is 8.13.0, and minimum API is 24. That minimum is a build setting, not verified Kompakt compatibility. Check actual device API/WebView first. [Capacitor requirements](https://capacitorjs.com/docs/updating/8-0), [environment setup](https://capacitorjs.com/docs/getting-started/environment-setup).

The build script discovers the Windows SDK and Temurin JDK 21. To override discovery, or on another OS, set `ANDROID_HOME` and `ANDROID_JAVA_HOME`. Environment changes apply only to build children. Android Studio's JDK 25 is unsuitable for this pinned Gradle version.

```sh
npm ci
npm run android:build -- --origin https://your-hub.example
```

Output: `.artifacts/android/personal-hub-debug.apk`. The API origin is fixed public build configuration; there is no runtime server picker yet. The server must allow `https://localhost` in `WEB_ORIGINS` alongside the website's HTTPS origin. Native HTTP sends that origin and the existing owner cookie; server authorization and mutation checks remain intact. Do not remove origin checks or enable browser CORS.

`--release` creates an **unsigned** release APK; signing/distribution is pending. Release builds reject the test connection flag and disable cleartext traffic. Debug builds use the machine's development key and a distinct application ID, `dev.personalhub.app.debug`.

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

Record emulator and hardware results separately. Actual Kompakt API/WebView, input, viewport, monochrome contrast, scrolling/ghosting, sleep modes and battery remain device gates. Local reminder permission denial, closed-app delivery and reboot recovery need implementation and testing. Production TLS login/session recovery and release signing are separate acceptance checks.

## Shell changes and the 2026-11-01 emulator regression

The 2026-11-01 shell update routes the system Back gesture through WebView history, backgrounding the task when no history remains while keeping the callback enabled for later presses. The activity declares `adjustResize` for the soft keyboard. The instrumentation test follows the current route/editor selectors, completes through the editor's **Completed** checkbox rather than the hidden row checkbox, and asserts the row checkbox is disabled while that editor is open.

A second desktop emulation pass on 2026-11-01 re-tested branch `fix/android-qa-findings` at `9ff82e7` with an APK rebuilt from that commit: Android 15/API 35, WebView 124.0.6367.219, Pixel 9 AVD at 360 CSS px and 320 CSS px, WSL2 with KVM. All seven checks passed: offline notes and completion replayed with the expected receipt and no false conflict; the workspace banner cleared after reconnect; the editor was in view at both widths; two consecutive Back presses returned to Today and then backgrounded the app; a real touch raised the soft keyboard with `adjustResize`; e-ink radios, 320 px nav labels and calendar hour labels were legible; and all four instrumentation phases passed with the task at version 3. Screenshots and the isolated database were retained on the desktop host only.

A follow-up fixed the one remaining low-severity banner edge case: when only the workspace bootstrap failed and task sync kept succeeding, no `online` event fired, so the banner could persist beside "Online · All saved". A successful sync now triggers one workspace retry. The calendar also opens a quarter hour above its first row so the opening hour label is not split by the scroll edge.

A focused re-check rebuilt the APK from `38da2c6` and made the server unreachable at the device loopback, then restored it without toggling device networking (zero `online`/`offline` events). A manual sync cleared both the banner and the header summary without pressing Retry; a queued create and note edit replayed to the expected versions; and the first calendar hour label was fully visible at 360 CSS px. All five focused checks passed with no new defects.

These are emulator results. Actual Kompakt API/WebView, input, viewport, monochrome contrast, scrolling/ghosting, sleep modes, battery and release signing remain hardware gates.
