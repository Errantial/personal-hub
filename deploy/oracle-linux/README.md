# Oracle Linux deployment

Deployed 2026-10-13 at https://hub.ecg.name from application commit `265a99d`. Updated the same day to `main` at `4491762` (Assistant, Mail ingestion, verified mail context; migrations through 048) after a verified backup/restore check; release `265a99d` is kept for rollback. The inspected host is Oracle Linux 9.7 / ARM64, with two CPUs, 10 GiB RAM and a 30 GiB root filesystem. The existing Java service was preserved. The server has a fresh database; development records have not been transferred. Planner JSON exports are not supported imports.

## Current release (2026-10-14)

Release `519054d` is live at https://hub.ecg.name with persistent agent backend, Assistant controls, action settings and linked Inbox/Today notifications. PRs 30–32 are merged; integration PR 33 brought the notification layer from its merged stack base into main. The release tree matches the code validated by 628 tests and all 144 browser cases. The first owner-created agent/run and live acceptance remain pending; see the [approved exclusions](../../docs/superpowers/specs/2026-10-14-persistent-agents-design.md#out-of-scope-recorded-for-future-work).

The artifact checksum and all 56 previously applied migration files matched before activation. Fresh backups were restored into isolated verification databases before activation (`20261015T050757Z`) and after migration 057 (`20261015T050919Z`), including the manifest and synthetic receipt checks. API/Caddy are active; HTTPS readiness passes, and live HTML, entry bundle and service worker match the staged build. `/sw.js` retains `Cache-Control: no-cache`. Agent endpoints return 401 without an owner session; the server-side worker heartbeat is healthy, with zero agents configured. An authenticated HTTP worker-health read was not performed because this verification browser had no owner session. No paid request or agent was created for verification.

The first activation failed because the staging directory inherited restrictive permissions; readiness triggered a code rollback to `b7f7af1`. Public release files were made readable/traversable by the service user, runtime imports were checked as `hub`, and the second activation succeeded. The private environment remains root-owned mode 0600. Keep release directories service-readable when making staged files root-owned. Previous release `b7f7af1` is retained for code rollback; rollback never restores an older database automatically.

## Owner setup

Open https://hub.ecg.name and create the owner account with your own email/password. In your own SSH terminal, retrieve the server setup token:

```sh
sudo sed -n 's/^SETUP_TOKEN=//p' /etc/personal-hub/hub.env
```

Enter it in the site's setup form; keep it out of chat, commits and logs. After enrollment, remove the `SETUP_TOKEN` line using `sudoedit /etc/personal-hub/hub.env` and restart `personal-hub`. This deployment did not enroll a synthetic owner or reset the development database. Some recursive DNS resolvers initially cached the missing hostname; public DNS and HTTPS verification passed, but local propagation may still need time.

## Runtime

- `/srv/personal-hub/releases/265a99d`: built API/UI, contracts, migrations and production dependencies; root-owned after staging. `/srv/personal-hub/current` is the release symlink.
- `/opt/personal-hub/node`: checksum-verified Node 24.21.0 / npm 11.19.0 ARM64 runtime. `/opt/personal-hub/caddy`: checksum-verified Caddy 2.11.7 ARM64 binary.
- `/etc/personal-hub/hub.env`: root-readable production configuration. PostgreSQL 16.15 uses the `hub` Unix account/role over a peer-authenticated local socket. Database TCP and API ports remain loopback-only.
- `personal-hub.service`: unprivileged API, 384 MiB JS heap / 640 MiB service memory limit, supervised restart and filesystem restrictions.
- `personal-hub-caddy.service`: separate user, managed HTTPS, HTTP redirect, static deep-link fallback and same-origin `/api` proxy. `/sw.js` uses `Cache-Control: no-cache`. Access logging is not enabled; its admin port stays on loopback.

The host firewall and owner-configured Oracle Cloud rules allow TCP 80/443. SSH and the existing port-25565 service are preserved.

## Assistant key

The Today Assistant needs an OpenRouter key ([details](../../docs/ai-assistant.md)). In your own SSH session, add `AI_SECRET_OPENROUTER=<key>` with `sudoedit /etc/personal-hub/hub.env`, then `sudo systemctl restart personal-hub`. Keep the key out of chat, commits and logs, and give it a credit limit in OpenRouter. Also save spending limits in Settings › AI. Without the key, the assistant shows "Not set up" and no provider is contacted.

## Reproduce or update

Run `provision.sh HOSTNAME` as root on Oracle Linux ARM64. It preserves an existing database/environment file; it is not a domain-change or reset script. Review existing configuration before rerunning. Pinned binaries come from [Node's release distribution](https://nodejs.org/dist/v24.21.0/) and [Caddy's official release](https://github.com/caddyserver/caddy/releases/tag/v2.11.7); PostgreSQL uses Oracle's signed `postgresql:16/server` module ([Oracle documentation](https://docs.oracle.com/en/operating-systems/oracle-linux/9/relnotes9.4/ol9-features-DynamicProgramming.html)). See [Caddy service guidance](https://caddyserver.com/docs/running#using-the-service).

Build/check locally with Node 24/npm 11. Archive only these paths, excluding `.env`, `.data`, credentials and development databases:

```sh
tar -czf release.tar.gz package.json package-lock.json \
  apps/api/package.json apps/api/dist apps/api/migrations \
  apps/web/package.json apps/web/dist \
  apps/email-connector/package.json \
  packages/contracts/package.json packages/contracts/dist
```

Transfer over SSH, extract into a **new** directory under `/srv/personal-hub/releases`, install as `hub` with the bundled runtime and `npm ci --omit=dev --ignore-scripts`, then make the release root-owned. The home directory stays root-owned, so provisioning points npm at `/var/cache/personal-hub/npm` through a root-owned `/srv/personal-hub/.npmrc`. This release needs no production install scripts; review dependencies that change that assumption.

Take a backup and review migration compatibility before changing the release symlink. Restart the API, check `/api/ready`, then reload Caddy. Keep the previous release until verification. A code rollback does not roll back migrations; never silently restore an older database over current owner data.

### Staged-release preflight (implemented, not yet exercised on the host)

`release-check.mjs` and `preflight.sh` add offline artifact and migration gates. They do not deploy, migrate, load production configuration, start a server/worker or contact a provider. Run the normal application checks from a clean, reviewed checkout first. Record the **full** tested commit and tree (`git rev-parse HEAD` and `git rev-parse 'HEAD^{tree}'`); verify any stacked changes are present on the release branch. The manifest records this operator-supplied identity; it does not independently prove that a build came from that tree, replace review/CI, or authenticate a downloaded artifact.

Transfer `release-check.mjs`, `preflight.sh` and `check-release-tree.sh` from that same reviewed commit together into the server's operator deployment directory, root-owned and not group/world writable. The runtime archive intentionally excludes deployment scripts. Run the server commands below from the parent of `deploy/oracle-linux`, or substitute the verified scripts' absolute paths; do not invoke a stale script from an earlier checkout.

After building, copy only the archive allowlist above into a new clean staging directory, preserving its relative paths. Seal that directory before creating the final archive (do not seal the working checkout, which may contain `.env.example`, private configuration or development data):

```sh
node deploy/oracle-linux/release-check.mjs seal STAGING_RELEASE FULL_COMMIT FULL_TREE
```

Include `release-manifest.json` in the archive above. The seal hashes the exact API/UI/contracts build files, package manifests/lockfile and migration bytes. Missing required entrypoints, symlinks in those artifacts, obvious private environment/data files and an existing seal fail closed. Unlisted root files are not included in the artifact inventory: continue using the archive allowlist, never archive the entire checkout. Keep a trusted copy of the seal/artifact checksum with the release receipt. Build output and declared Git identity still require a trusted build process.

Include the email connector's public package manifest so npm's lockfile workspace link has an existing target. Its source and local configuration stay off the server; this metadata does not run mail collection or install credentials. When adding a workspace, update the staging allowlist and manifest together so clean installation cannot leave a broken workspace link.

Install production dependencies with `npm ci --omit=dev --ignore-scripts` before the preflight; retain the recorded lockfile. Make public release files root-owned and service-readable, with directories traversable and no group/world write permission. Do not change `/etc/personal-hub/hub.env` from root-owned mode 0600. Export the existing **metadata-only** migration manifest immediately before the gate, from the local server administration session:

```sh
sudo sh -c 'umask 077; runuser -u postgres -- psql -d hub -Atqc "SELECT coalesce(json_agg(m ORDER BY name), '\''[]'\''::json) FROM (SELECT name, checksum FROM schema_migrations) m" > /root/hub-applied-migrations.json'
sudo bash deploy/oracle-linux/preflight.sh \
  /srv/personal-hub/releases/RELEASE FULL_COMMIT FULL_TREE \
  /root/hub-applied-migrations.json
```

The root gate requires Node 24, verifies exact artifact hashes and declared identity, and rejects missing/modified applied migrations or newly inserted older migrations. `check-release-tree.sh` requires root ownership and rejects writable regular files/directories. npm workspace and `.bin` symlinks may retain their normal mode 0777, but must be root-owned with existing final targets inside this release; broken/external targets fail. Its `find -P` traversal does not recursively follow links outside the stage. Build artifacts themselves still prohibit symlinks entirely. As the actual `hub` user in an empty environment, it reads every listed artifact and imports the built application/contract modules, resolving their production dependency graph without invoking `buildApp` or `server.js`. As `hub-caddy`, it checks the static tree's traversal and readability. This reproduces the previous inaccessible staging-directory failure before activation. It does not hash installed `node_modules`, prove every lazily loaded optional dependency, or simulate systemd sandboxing; the lockfile-based clean install and actual service readiness remain required.

Run the isolated shell fixture with `bash deploy/oracle-linux/test-release-tree.sh` on Linux. It checks normal npm links, writable-file rejection, escaped targets and broken links, using only a temporary synthetic directory. Windows Git Bash may copy symlinks and reports an explicit skip; that is not a passing Linux/service-user receipt. The optional numeric owner argument on the helper supports unprivileged fixtures; production `preflight.sh` always supplies UID 0.

Keep fresh backup plus isolated restore proof before migration/activation. The preflight compares a captured manifest, not a database lock: serialize releases, take a fresh capture if another deploy/migration can have occurred, and let the runtime migration transaction recheck checksums. After atomic symlink activation/restart, require `/api/ready`, expected static artifact hashes and service stability. Check worker health separately; process readiness does not prove the worker is progressing. Neither script reports live acceptance.

### Code rollback compatibility gate

Before relying on the previous binary after forward migrations, run:

```sh
node deploy/oracle-linux/release-check.mjs rollback \
  CURRENT_RELEASE PREVIOUS_RELEASE POST_UPGRADE_MANIFEST_JSON REVIEWED_RECEIPT_JSON
```

Both releases need verified manifests. Existing pre-manifest releases require a one-time audited seal using their independently confirmed Git identities/artifact hashes; do not invent an identity to enable rollback. The applied manifest must exactly match all current release migrations, with unchanged prior bytes. Extra future migrations or incomplete exports block the gate.

The reviewed receipt is private operator evidence with this JSON shape:

```json
{
  "version": 1,
  "currentDigest": "current release-manifest.json digest",
  "previousDigest": "previous release-manifest.json digest",
  "appliedDigest": "SHA-256 of canonical applied migration object",
  "schemaCompatible": true,
  "isolatedRestorePassed": true,
  "review": "Review reference and isolated restore/old-binary compatibility evidence"
}
```

Canonical applied data is the JSON object mapping migration filename to checksum, sorted by filename using JavaScript `localeCompare`, serialized with `JSON.stringify` and no newline. Only after an actual isolated restore and compatibility exercise should a reviewer assert these booleans. Check old-binary reads/writes, defaults, constraints, new record variants, worker state and idempotency receipts against the upgraded disposable schema. Append-only SQL is not sufficient proof of old-code compatibility. The gate verifies that a declaration matches the exact artifact/schema combination; it cannot establish the truth of the review or tests. Missing/stale/negative evidence blocks automatic code rollback. Prepare this evidence before activation if automated rollback is desired.

No symlink mutation or automatic rollback is implemented by these checks. If compatibility is unproven, stop and preserve owner data for a forward fix or explicitly reviewed recovery. Never automatically restore an old database over current owner writes. Same-device backup policy and root-only secrets remain unchanged.

## Same-device backup and restore

By owner choice, backups stay on this VM. `personal-hub-backup.timer` runs daily around 04:00 UTC with randomized delay and missed-run recovery. `backup.sh` creates a PostgreSQL custom-format dump, validates it, saves a checksum and separately copies the private environment file into `/var/backups/personal-hub` (directory 0700, files 0600). No automatic deletion policy is set; monitor disk space and choose retention.

These are private same-device backups without additional file encryption. They do not protect against VM loss. Encrypted off-host storage is deferred.

```sh
sudo /usr/local/sbin/personal-hub-backup
sudo bash verify-restore.sh
```

Run the verification script from the copied deployment directory. It restores a fresh backup into an isolated `hub_restore_check_*` database, verifies the migration manifest and a synthetic receipt round trip, then drops only that verification database. It never restores over `hub`.

For disaster recovery, stop the API and restore a verified dump into a **new** database using `pg_restore --exit-on-error --no-owner` as a database administrator. Check tables, versions, receipts, authorization and worker state before pointing the API at it. Restore server configuration privately and reestablish the database role/socket permissions. Historical backups retain records that may since have been forgotten; restoring them needs an explicit retention decision. Never blindly resend uncertain external operations. Restore verification starts no provider/send worker.

## Historical initial-deployment validation (2026-10-13)

Application checks passed 516 tests (one optional local PostgreSQL test skipped), lint, types, formatting and builds; all 93 isolated browser tests passed. Actual ARM64 host checks passed shell/systemd syntax, schema migration/startup, API restart/readiness, unauthenticated private-route 401, backup checksum, isolated schema restoration and synthetic receipt restoration. External HTTPS returned ready, owner setup and the correct service-worker header. A read-only live Playwright check passed deep-link startup, setup-token field, 320px layout and no JS errors with a DNS override. The collaborative preview could not resolve the hostname through the locally cached resolver.

This paragraph records the initial deployment's gates, not the current PR/release state: owner enrollment, authenticated daily use, development-data transfer, sustained load, backup retention/off-host protection, standard PostgreSQL concurrency tests on this host and Kompakt hardware were then unverified. The current release receipt above supersedes the historical PR-integration/test counts; keep ongoing owner/hardware acceptance separate from deployment readiness.
