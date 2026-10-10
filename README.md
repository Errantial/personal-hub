# Personal Productivity Hub

Schedule, task, email, and study hub targeting the web, Android, and Windows.

Status: authenticated web/API planner implemented, including tasks, day/week calendar, all-day and recurring events, individual occurrence edits, class/topic portfolios, manual study blocks, and durable reminders with an in-app inbox. Includes SQL migrations, shared TypeScript/Zod contracts, conflict checks and retry deduplication. Browser and provisional Android prototypes cache loaded views and queue task edits offline; APK process-restart/replay checks pass on an AOSP emulator. Account integrations, Kompakt hardware verification, AI/MCP/persistent agents and server deployment remain upcoming. Browser alerts require an open Reminders view; closed-app native alerts remain future work.

## Run locally

Requires Node.js 24 and npm 11.

```sh
npm ci
npm run doctor
npm run dev
```

Open `http://127.0.0.1:5173`. Create your owner login on first use. The API runs on port 3001; embedded PostgreSQL data persists in `.data/planner/`. Run `npm run check` for lint, type checks, unit/API tests, formatting, and builds. For browser verification, run `npx playwright install chromium`, then `npm run test:e2e`.

See [development guide](docs/development.md) for setup, configuration, API contracts, database operations and limits. [Implementation backlog](docs/backlog.md) separates completed work from the next milestones.

Confirmed: personal use first with future expansion; school Canvas/calendar, school Outlook email, Proton Mail including Gmail, and Proton Calendar. Android supports offline viewing and queued edits. AI may change writable calendars automatically; sending email requires explicit approval. Permissions will become configurable.

Priority: Windows website and Mudita Kompakt Android APK first. Dedicated Windows app and Kindle Scribe are deferred. Hosted AI API initially, with a later self-hosting option. Paid Proton Bridge access and prior feed/browser automation routes are established; app-specific validation remains.

Planned server: Oracle Cloud Ubuntu, 24 GB RAM and 4 OCPUs. MCP works in both directions. Hosted AI receives relevant text only, excluding screenshots and attachments. Keep routine costs low and meter stronger-model features; a numeric cap remains unset.

AI permissions include provider-routing rules based only on sources/content explicitly labeled by the owner. Derived context inherits labels; unlabeled content uses the default route. Labeled sensitive context goes to an approved provider with no silent fallback.

## Start here

1. [Product requirements](docs/product.md): user experience, feature scope, and acceptance criteria.
2. [Architecture](docs/architecture.md): platform strategy, data model, sync, AI, and privacy.
3. [Integration feasibility](docs/integrations.md): Canvas and Proton constraints, with official sources.
4. [Development roadmap](docs/roadmap.md): proof-of-concept gates and delivery order.
5. [Decision register](docs/decisions.md): assumptions and unanswered questions.
6. [Target platforms](docs/platforms.md): Kompakt constraints and deferred device scope.
7. [Deployment and AI policy](docs/deployment.md): Ubuntu services, CPU compatibility, text boundary, and cost controls.
8. [AI permissions and routing](docs/ai-permissions.md): sensitivity rules, provider selection, and context boundaries.
9. [Persistent agent scope](docs/agent-scope.md): OpenAI Dots/OpenDots-style responsibilities, scheduled work, memory and controls.
10. [Implementation backlog](docs/backlog.md): current progress, acceptance checks, unresolved verification and next work.
11. [Android prototype](docs/android.md): APK builds, isolated emulator server and hardware boundaries.

## Working direction

Build a dependable daily planner first, then connect academic deadlines and email, then add AI actions through the same validated operations used by the UI. Introduce basic class tracking and an e-ink-friendly interface early.

The central planning constraint is Proton: desktop Bridge access and read-only calendar feeds do not provide an unrestricted cloud/mobile integration. Investigate the owner's previous automation workarounds and verify the required workflows before choosing a hosting or desktop strategy.

## Readiness boundaries

- Initial audience, required accounts, target devices, and offline behavior are agreed.
- Local web/API development is unblocked and has an authenticated persistence slice.
- Canvas authentication and required Proton workflows still need app-specific demonstrations before dependent integration features are promised.
- Server-side AI data access and model hosting are agreed.
- Kompakt packaging/offline/closed-app notification behavior remains an open device gate.
- The first implementation milestone has bounded scope and measurable acceptance criteria.

Research baseline: 2026-10-09; implementation/scope updated 2026-10-10. Recheck provider requirements when implementation starts.
