# Local subscription runtime metadata doctor

Implemented 2026-10-12. npm run ai:runtime-doctor performs an explicit local version/help inspection for selected Claude/Codex native executables. It supplies no inference input or auth command and cannot enable provider dispatch. It is a diagnostic, not an isolation verifier or account check.

## Operation

Supply at least one absolute local executable path. Native claude/claude.exe and codex/codex.exe names are accepted; relative paths, remote shares, shell/batch shims, duplicate/unknown options and non-file targets are rejected. The command validates the selected files and creates an empty temporary working directory under the workspace's .artifacts/runtime-probe. Cleanup is restricted to that verified directory.

```powershell
npm run ai:runtime-doctor -- --claude 'C:/path/to/claude.exe' --codex 'C:/path/to/codex.exe'
```

Either runtime can be selected alone. There is no PATH discovery, installation, provider credential option, shell invocation or automatic retry. Each runtime runs version once and, only after a recognized successful identity, help once. Codex help is restricted to app-server help; the server itself is not started and no protocol schema is generated.

Child processes use shell=false, windowsHide=true, ignored stdin and piped output. The child environment contains fixed NO_COLOR/TERM/LANG values and validated SystemRoot/WINDIR when present. Parent PATH, home/config/session selectors, provider credentials, cloud credentials, proxies and runtime-injection variables are excluded. No parent environment dump or raw native output appears in reports. This environment filtering is not an OS sandbox: native programs still execute as the current OS user and may have access to its resources. Dedicated account/config/filesystem/network isolation remains unverified.

## Bounds and reports

Each command has a five-second deadline and a combined 256 KiB stdout/stderr limit with strict UTF-8 decoding. Abort, deadline, oversized output and process errors produce redacted failures. The direct child is killed on failure; timeout completion does not wait forever for a close event or successful kill. The diagnostic does not claim process-tree containment. Late injected results are ignored and never cause a second command.

Only bounded numeric version identities and declared option/command rows are recognized. Prose mentioning a flag does not satisfy it. Claude requirements are derived from the same fixed controls used by the request draft, preventing drift. Codex currently checks strict config/listen flags and schema-generator availability. See the official [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands). Help advertising does not prove that managed configuration or tools are effectively disabled.

JSON reports contain adapter, version, status=controls-advertised|missing-controls|probe-failed, bounded missing control names and redacted failure reason. All statuses retain dispatchEnabled=false, isolation=unverified, account=not_checked and billing=unverified. Paths, raw help/errors, credentials and prompt text are absent from the diagnostic JSON. npm may echo the operator's command line normally; executable paths are not credential arguments. Exit zero means advertised controls were found, not permission to send text. Reports are not stored in the hub, cannot be uploaded as verification and do not clear existing subscription blockers.

## Validation and remaining work

Ten focused mocked tests cover environment filtering, both runtimes, misleading help, unsafe paths/launch options, redacted failures, deadlines/late replies, no stdin/shell, native output bounds/UTF-8, abort/kill failure and rejection of auth/inference/injected environment commands. Routine tests invoke no real CLI or provider. A separate explicit local metadata inspection succeeded for Claude Code 2.1.296 and Codex CLI 0.162.0; all runtime/account/billing fields remain unverified. No login, credential-file inspection/import, inference or paid request was performed. Final npm run check passed lint, strict types, formatting, production builds and 401 API/client tests; one optional standard PostgreSQL test was skipped. Browser tests were not rerun because UI/authentication code was unchanged. No owner database or device tests were used.

No migration, dependency, public API/authentication/UI change or provider enable switch is added. Dedicated runtime/login, effective tool/configuration disclosure, exact model entitlement, complete usage/retry bounds, native output/accounting and confidential-route verification remain pending.
