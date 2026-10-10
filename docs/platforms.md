# Target platforms

## Initial release

| Target | Delivery | Required behavior |
| --- | --- | --- |
| Windows | Responsive website | Full hub workflow, keyboard support, readable calendar/inbox, server sync |
| Mudita Kompakt | Sideloadable Android APK | E-ink interface, offline viewing/edits, durable queue, local reminders, no Google Services requirement |
| Oracle Cloud Ubuntu, 24 GB RAM / 4 OCPUs | Backend, worker, hosted AI API client | Persistent data/jobs, connectors, policies, memory, client sync; verify CPU shape |

The Android framework remains provisional until tested on the actual Kompakt. A responsive web frontend packaged with Capacitor is the current candidate; do not commit solely on an ordinary Android emulator result.

## Kompakt constraints

Mudita documents that MuditaOS K is based on AOSP, allows sideloading through Mudita Center, and does not support Google Services. Third-party apps may behave differently on its e-ink device. [Official third-party app support](https://support.mudita.com/en/support/solutions/articles/77000577356), [APK installation procedure](https://support.mudita.com/en/support/solutions/articles/77000595285-installing-third-party-apps-via-mudita-center).

Architecture implications:

- Bundle the app UI locally so viewing/editing does not require loading a remote website.
- Avoid required Google sign-in SDKs, Firebase Cloud Messaging, or Google Play Services integrations. Connect accounts through the backend where practical, with a tested browser-based authentication flow when needed.
- Use local storage and native local alarms/reminders. Prove their actual presentation on Mudita firmware; standard Android notification behavior is not sufficient evidence.
- Refresh on app open and reconnect, and use best-effort platform background sync. Background scheduling is not a guarantee of instant server updates.
- Keep text readable, controls large, and layouts stable. Provide tap-based navigation and a list/agenda alternative to drag-heavy calendar interactions.
- Use a static monochrome theme with no animation, no streaming token-by-token repaint by default, and no color-only status indicators.
- Keep AI computation and browser-provider automation on the server or connector host.
- Do not require device rooting or operating-system modifications for the initial release.

## Minimum device proof

Record actual firmware, Android API level, available WebView/version, and display viewport during device testing; do not infer them from generic Android compatibility claims.

1. Install a signed development APK and show the bundled UI without network access.
2. Create/edit a task offline, restart the app, and reconnect; verify persistence and server reconciliation.
3. Test local reminder presentation while the app is closed, after reboot, and in the device's available power/offline modes. Document actual limits.
4. Confirm login/session recovery and the network path to the owner's server.
5. Check text entry, touch targets, scrolling, ghosting, calendar readability, and background battery impact.

## Deferred platforms

Dedicated Windows app: revisit shell choice, tray behavior, auto-start, closed-app notifications, signing, and updates after the core app is complete. A Bridge ingestion process is a separate operational requirement and can precede this UI.

Kindle Scribe: no implementation or compatibility promise in the initial plan. Investigate its supported access methods and interaction constraints only after the rest of the app is complete.
