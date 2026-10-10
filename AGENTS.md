# Project development guide

Read README.md and docs/development.md first. docs/product.md is the agreed scope; docs/decisions.md records unresolved choices. docs/backlog.md identifies the current milestone and acceptance checks. Keep completed implementation distinct from proposals.

## Layout and validation

- apps/web: React UI. Use relative /api URLs and shared contracts.
- apps/api: Fastify, owner authorization, durable planner operations, database adapters.
- packages/contracts: Zod request/response schemas and types shared by both apps.
- apps/api/migrations: append-only numbered SQL migrations. Never change an applied migration; add a new one.
- docs: requirements, architecture, operating instructions, and implementation backlog.

Use Node 24/npm 11. Run npm run check for code changes and npm run test:e2e for UI/authentication changes. Browser tests use their own ports and synthetic database. Do not seed or reset the owner's development database during tests. Device tests must distinguish emulators from actual Mudita Kompakt hardware.

## Interface copy

Avoid unnecessary flavor text. Prefer a concise title or label. Put useful secondary explanations in contextual Help controls, hover/focus tips, or expandable details; make them available by keyboard and tap as well as hover. Keep actionable errors, pending/offline/conflict state, and essential warnings visible. Apply this to new features and touched screens.

## Product boundaries

All private records and writes require owner authorization. Preserve optimistic versions, idempotency receipts, and delete tombstones for future offline sync. Development enrollment stays on loopback; production needs HTTPS, standard PostgreSQL, and a server setup token.

Future AI requests must pass the provider-routing gateway: text only, no screenshots/attachments/attachment-derived text. Sensitivity comes only from owner-applied labels and inherited provenance. Unavailable approved providers block/queue; they never silently fall back to the default. Email sends always require explicit approval, including calendar invitations or cancellation emails. Calendar write authority does not prove a provider supports writes.

Never commit or log provider credentials, private feeds, email content, cookies, passwords, or setup tokens. Do not call real providers or send paid AI requests as part of routine tests. Dots/OpenDots parity is a long-term scope reference, not a claim that agent execution is implemented.
