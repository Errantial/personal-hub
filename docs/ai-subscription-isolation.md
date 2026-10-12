# Subscription isolation requirements and Claude request draft

Implemented 2026-10-12. Provider readiness now distinguishes subscription runtime isolation and usage verification from ordinary profile configuration. A pure Claude CLI request builder prepares bounded text and fixed controls, but does not launch a process or establish isolation. Codex launch preparation remains unavailable until its complete effective tool/configuration boundary is verified. Live inference is disabled for both.

## Owner-facing readiness

Claude Code/Codex subscription profiles add SUBSCRIPTION_ISOLATION_REQUIRED and SUBSCRIPTION_USAGE_VERIFICATION_REQUIRED blockers. subscriptionRequirements is {status:unverified,requestPreparation:claude-cli-draft|unavailable,checks:[...]}. Checks require a dedicated application account, effective configuration, empty toolset, ephemeral history, text-only disclosure, exact model entitlement, no paid fallback, complete usage bound and known retry behavior. Other adapters and legacy readiness objects default this field to null.

Approval, a configured credential reference, an installed CLI and a configured token-price quote cannot satisfy these requirements. The existing synthetic byte-token harness now blocks declared subscription routes before creating an attempt/hold. It must not turn subscription quota into a fabricated zero-dollar API receipt. No configuration flag, verification upload or public endpoint can mark these checks passed. Existing routing, owner authorization, spending ceilings and unavailable-provider blocking remain.

## Prepared Claude request

buildClaudeSubscriptionRequest accepts a configured Claude subscription profile and already assembled text/manifest. It checks text length against the manifest and bounds the supplied text plus static system instructions. Exact-context/provenance/owner authorization must still be revalidated by the gateway; a length match alone is not authority. Generic and latest model aliases, flag-like values, whitespace/control characters and unavailable/non-Claude profiles are rejected.

The internal draft keeps supplied text on stdin, uses an argv array with shell=false, and adds controls for restricted/safe mode, disabled built-in tools, an empty exclusive MCP configuration, disabled skills/session persistence/browser integration and denied unattended permission prompts. It supplies neither working directory, inherited environment nor executable path. Its dispatchEnabled=false and verification=required are mandatory. The builder imports no subprocess/network APIs and receives no credential. It does not implement native output parsing, accounting, provider retries or a complete native/system token bound.

The [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) separates built-in-tool and MCP control. It also describes retained managed-policy effects and an estimated spending threshold that can overshoot. Those controls need verification in the dedicated runtime; the draft is not proof. The CLI budget flag is omitted because it cannot establish the owner's hard spending limit. No optional model-fallback flag, continuation/resume path, debug logging or subscription login is added.

## Codex boundary and operating limits

[Local runtime metadata doctor](ai-runtime-doctor.md) now checks selected executables' version/help advertisements with bounded output and a filtered environment. It performs no account check or inference and cannot satisfy the isolation/usage requirements below.

Official [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference) documents shell/tool feature controls and history settings. [App-server](https://learn.chatgpt.com/docs/app-server) supports persistent and ephemeral conversation operations. Neither an empty dynamic-tool list nor a history setting by itself proves all local tools, hooks, skills, plugins, project instructions and other data sources are absent. A complete effective-runtime check remains required before a Codex request draft or inference is enabled.

Use a dedicated app login/OS or container boundary, with separately controlled runtime configuration, session storage and network policy. Never copy this development agent's credentials or configure its home/session storage for the hub. Read-only sandboxing still permits reads and cannot establish the text-only boundary alone. Account entitlement, extra usage/API credits, exact model selection, actual outbound input and retry/charge behavior must be verified separately. Prem confidential inference remains a separate approved-route requirement; subscriptions are not confidentiality evidence.

Only local CLI help was inspected in this slice. No account login, credential-file inspection/import, inference subprocess, provider call, paid request, dependency or migration was added. Installed/help-supported controls are preparation evidence only, not account/runtime verification.

## Validation

Eight focused tests cover stdin/argv boundaries, explicit controls, shell-looking input, invalid text/manifest/envelope/model/profile rejection, safe subscription readiness, owner authorization, legacy compatibility, configured/approved-but-unverified access and blocked byte-token admission without holds. Existing provider-policy tests also pass. Final npm run check passed lint, strict types, formatting, production builds and 391 API/client tests; one optional standard PostgreSQL test was skipped. Eight new focused preparation tests and existing provider-policy coverage passed. Browser tests were not rerun because UI/authentication code was unchanged. Only local CLI help was inspected; no owner database, subscription login, credential import, inference, paid AI or device tests were used. Tests use isolated synthetic data and forbid fetch. UI/authentication code and public dispatch remain unchanged.
