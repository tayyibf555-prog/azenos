# Azen OS

Agency business operating system for Azen AI. The full build contract lives in
[AZEN_OS_SPEC.md](./AZEN_OS_SPEC.md) — read it before writing code. Decisions
and deviations are logged in [docs/DECISIONS.md](./docs/DECISIONS.md).

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo + data spine: schema (24 tables), taxonomy (41 event types), seed + simulate | ✅ done |
| 1 | Ingest pipeline (§6.3), project CRUD + Setup tab, Events tab, ticker, Node SDK | ✅ done |
| 2 | Metrics engine + rollups, Metrics tab + ROI, transcript intake co-pilot (Whisper dictation), client API-cost tracking | ✅ done |
| 3 / 3b | Daily brief + delivery / Ask Azen chat | next |
| 4–6 | Money, bookings, weekly/monthly agents, Scout, Learn | — |

Multi-agent build orchestration (Fable-plans / Opus-4.8-builds / adversarial
verify) is documented in [docs/ORCHESTRATION.md](./docs/ORCHESTRATION.md);
per-phase contracts live in `docs/phaseN/CONTRACTS.md`.

Phase 1 contracts live in [docs/phase1/CONTRACTS.md](./docs/phase1/CONTRACTS.md);
the ingest wire protocol is `X-Azen-Signature: t=<ts>,v1=HMAC-SHA256(secret,
"<ts>.<body>")` (±5 min window), implemented once in `@azen/events/signing`.

## Quickstart

```sh
pnpm install
pnpm db:local        # local Postgres 17 + pgvector on 127.0.0.1:54329
pnpm db:migrate      # apply migrations (schema + RLS + roles)
pnpm seed:demo       # 3 demo clients, 4 projects, ~90 days of events
pnpm dev             # Next.js app (apps/web)
pnpm db:studio       # browse the DB with Drizzle Studio
```

Copy `.env.example` to `.env` first (the defaults point at the local DB).

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm seed:demo` | Wipe + reseed the demo dataset (deterministic) |
| `pnpm simulate --project=<slug>` | Replay a signed day of events against the running ingest endpoint (`--dry` to inspect payloads) |
| `pnpm test` | Vitest — taxonomy validation suite |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm db:generate` | Generate a new Drizzle migration after schema changes (migration-first — never edit schema without one) |
| `pnpm db:local:down` | Stop the local Postgres |

## Workspace layout (spec §11)

```
apps/web            Next.js app — UI + API routes (ingest endpoint lands Phase 1)
packages/config     Pinned model IDs + platform constants (AGENT_MODEL, CHAT_MODEL, …)
packages/events     Event taxonomy: Zod schemas + TS types — single source of truth
packages/db         Drizzle schema (all §4 tables), migrations, seed, simulate CLI
jobs                Trigger.dev v3 tasks (from Phase 2)
docs                Decisions log, templates
```

## Local database

`pnpm db:local` runs a project-local Postgres 17 with pgvector via Homebrew
(data in `.pgdata/`, not a system service). `pnpm db:local:docker` is the
compose alternative if you prefer Docker. The hosted Supabase project is the
production target — once created, fill the `SUPABASE_*` env vars and auth
activates automatically (see docs/DECISIONS.md #2).

## Production database (Supabase pooler ports)

Two pooler modes, two ports, on purpose (docs/DECISIONS.md #19):

- **Runtime (Vercel)** — TRANSACTION pooler, port **6543**. Serverless-safe;
  `packages/db/src/client.ts` auto-disables prepared statements on 6543.
- **Migrations** (`pnpm db:migrate`) — SESSION pooler, port **5432**, only.
  drizzle.config.ts refuses a 6543 URL; swap the port before migrating.
