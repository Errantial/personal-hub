# App updates and the GitHub release feed

Status: implemented on `release/2026-11-13` for the Android app; not deployed
and not published. This work created no GitHub release, uploaded no APK and did
not use the production signing key. Desktop is a reserved manifest slot only;
no desktop application is built or published in this release.

## Update check

`GET /api/v1/app/update?platform=android&versionCode=<installed>` requires the
owner session. It reads the latest stable GitHub release for
`Errantial/personal-hub`, prefers a `release-manifest.json` asset, and returns
one of three states:

- `update-available` when the release `versionCode` is greater than the
  installed code;
- `current` for an equal or older release (the server never offers a
  downgrade);
- `unavailable` with a bounded reason such as `RELEASE_NOT_FOUND`,
  `MANIFEST_MISSING`, `MANIFEST_INVALID`, `ANDROID_ASSET_MISSING`,
  `GITHUB_RATE_LIMITED` or `GITHUB_UNAVAILABLE`.

`GITHUB_TOKEN` is optional and read only by the API process. It raises GitHub
API rate limits and is never returned to the browser, written to an export or
logged. A successful GitHub read is cached for five minutes and a failed read
for one minute, so repeat checks do not multiply traffic. A cached response
contains no GitHub credential.

The check makes no real provider or GitHub call in tests: server tests inject a
fake fetcher and assert the asset URL, digest, size, caching and failure states.

## `release-manifest.json`

```json
{
  "formatVersion": 1,
  "channel": "stable",
  "versionName": "0.1.0+abc1234",
  "versionCode": 300,
  "notes": "Bounded release notes shown in Settings.",
  "android": {
    "url": "https://github.com/Errantial/personal-hub/releases/download/android-0.1.0-300/personal-hub-0.1.0+abc1234.apk",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "size": 12345678
  },
  "desktop": []
}
```

Validation is deliberately narrow:

- The manifest is at most 64 KiB; notes are at most 4,000 characters.
- `versionName` is a short safe token and `versionCode` is a positive integer.
- Asset URLs must be HTTPS with no credentials, query or fragment and must start
  at `https://github.com/Errantial/personal-hub/releases/download/`.
- The manifest's Android and desktop URLs must match assets actually attached to
  that GitHub release, including their declared sizes.
- Each referenced asset name is safe; each digest is 64 lowercase hex
  characters; each size is 1 byte to 250 MiB.
- A `desktop` entry is `{ platform, url, sha256, size }`. The array is empty in
  this release.

The Android app re-checks that an update URL starts at the same repository
download path, follows only HTTPS redirects to GitHub asset hosts, aborts above
the declared size, verifies SHA-256 and deletes failed or partial files.

## Tag and asset convention

- Tag: `android-<packageVersion>-<versionCode>`, for example
  `android-0.1.0-300`. The tag is created at the release commit.
- APK: `personal-hub-<versionName>.apk`, for example
  `personal-hub-0.1.0+abc1234.apk`.
- Checksum: `personal-hub-<versionName>.apk.sha256`, in `sha256sum -c` form.
- Manifest: `release-manifest.json`.
- Optional desktop assets: any safe file name supplied with `--desktop`.

`versionCode` is the commit count of the tagged commit, so a forward fix must
include at least one new commit. `versionName` is the package version plus the
short commit. The update endpoint serves only stable `/releases/latest`; a
`--channel beta` release is marked as a GitHub prerelease and is not served by
this check.

## Release runbook

Prerequisites: Node 24/npm 11, a clean checkout, JDK 21 and the Android SDK for
signature verification, and an authenticated `gh` CLI for publishing. The
signing key and its passwords are supplied only through the existing
`HUB_ANDROID_*` environment variables described in [android.md](android.md).

1. Build the signed APK on the machine that holds the production key:

   ```sh
   npm run android:build -- --release
   ```

   The build script refuses uncommitted changes, verifies the signature with
   `apksigner` and writes the `.sha256` file. Never place the keystore in the
   repository, CI, a log, a screenshot or chat.

2. Prepare and inspect the release files without touching GitHub. Write the
   optional notes file first (for example `.artifacts/release-notes.txt`; at most
   4,000 characters), then run:

   ```sh
   npm run release:github -- \
     --apk .artifacts/android/personal-hub-<versionName>.apk \
     --notes-file .artifacts/release-notes.txt
   ```

   The default is a dry run. It writes `.artifacts/release/release-manifest.json`,
   the staged APK, its checksum and the notes file. It does not create a tag,
   call GitHub or upload anything.

3. When the manifest and notes are correct, publish with the explicit flag:

   ```sh
   npm run release:github -- \
     --apk .artifacts/android/personal-hub-<versionName>.apk \
     --notes-file .artifacts/release-notes.txt \
     --publish
   ```

   Publishing requires the Android SDK, verifies the APK signature, requires
   the current commit to be clean, checks that an existing local or remote tag
   points at `HEAD`, and creates or updates the release. An existing release is
   updated with `gh release upload --clobber`, then its title and notes are
   edited. Uploading is a real network write and remains owner-authorized; this
   release implementation did not run it.

   `--build` can run the signed build first. `--tag`, `--repo`, `--channel`,
   `--output-dir` and repeated `--desktop <platform>=<path>` are available.

4. Verify the published release:

   ```sh
   sha256sum -c personal-hub-<versionName>.apk.sha256
   curl -fsSL https://api.github.com/repos/Errantial/personal-hub/releases/latest
   ```

   Do not distribute an APK whose certificate differs from the installed app.
   Android rejects the update; a different key forces an uninstall and deletes
   queued offline edits.

## Android install behavior

Settings › Account › App updates shows the current version, the last check,
permission state, available version, bounded notes and the download/install
action. The native plugin:

- reports installed `versionName`, `versionCode` and whether this package may
  install unknown apps;
- opens Android's install-unknown-apps setting for this package;
- downloads only a manifest-supplied HTTPS URL, enforces the declared and
  maximum size, verifies SHA-256, and launches the system package-installer
  prompt through the existing `FileProvider`;
- never installs silently and never leaves a failed or partial APK in place.

The app declares `REQUEST_INSTALL_PACKAGES`. The owner may need to allow
installs for Personal Hub in Android settings. Installer prompts and settings
screens are Android UI, not Personal Hub UI, so emulator and Kompakt evidence
must be recorded separately.

## Rollback limits

Android does not allow installing a lower `versionCode` over a higher one. A
rollback requires uninstalling the app, which deletes app data, cached views,
queued offline edits, the native session and pending alarms. Sync queued work,
confirm **Online · All saved**, and export planner JSON first. Prefer a forward
fix with a higher code. The server does not offer a downgrade.

## Desktop

The manifest and release tooling accept desktop artifacts so a later desktop
application can share the feed. This release publishes none, and Settings says
so. No desktop build, installer or signing path is added here.
