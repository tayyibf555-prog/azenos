import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// Load the repo-root .env regardless of invocation cwd (mirrors client.ts) so
// DATABASE_URL_RO resolves in CLI/test contexts; a no-op when the runtime
// (Next.js) already provides the env.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env") });
config();

/**
 * Guarded read-only SQL for Ask Azen's `run_sql` tool (spec §9.8, §15).
 *
 * Defense in depth, three layers:
 *  1. A dedicated Postgres role `azen_readonly` (migration 0001): SELECT-only
 *     grants, 5s statement_timeout, BYPASSRLS (access is app-mediated). Even
 *     if every check below were bypassed, the role physically cannot write.
 *  2. `validateReadonlyQuery` — single statement, must be a SELECT/WITH query,
 *     denylist of write/DDL/side-effect keywords.
 *  3. An enforced row LIMIT (wrapped as a subquery so it applies even to
 *     queries that already have their own limit/offset).
 *
 * v1 is single-owner/single-org (spec §15): `run_sql` is the escape hatch for
 * the long tail; the STRUCTURED Ask tools are the org-scoped default. This
 * MUST be revisited before any client-facing chat access exists.
 *
 * Node-only (postgres). Import via "@azen/db/readonly", never the root.
 */

const MAX_ROWS_DEFAULT = 200;
const MAX_ROWS_CAP = 1000;

let roClient: postgres.Sql | undefined;

export function getReadonlyDbUrl(): string {
  const url = process.env.DATABASE_URL_RO;
  if (!url) {
    throw new Error(
      "DATABASE_URL_RO is not set — run_sql needs the azen_readonly role URL (migration 0001 creates the role)",
    );
  }
  return url;
}

function getReadonlyClient(): postgres.Sql {
  if (!roClient) {
    roClient = postgres(getReadonlyDbUrl(), {
      max: 4,
      idle_timeout: 20,
      onnotice: () => {},
      // Applies on direct/session connections only — Supabase's transaction
      // pooler (port 6543) ignores startup params (verified: server reports
      // the 2min default). runReadonlySql therefore ALSO pins the timeout
      // per-transaction via SET LOCAL, which survives every pooling mode.
      connection: { statement_timeout: 5000 },
      prepare: false,
    });
  }
  return roClient;
}

export type ReadonlyValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

// Write / DDL / side-effect keywords. Matched as whole words, case-insensitive.
const FORBIDDEN = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "comment",
  "copy",
  "vacuum",
  "analyze",
  "reindex",
  "cluster",
  "refresh",
  "call",
  "do",
  "merge",
  "lock",
  "set",
  "reset",
  "listen",
  "notify",
  "prepare",
  "execute",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "pg_sleep",
  "pg_read_file",
  "pg_ls_dir",
  "lo_import",
  "lo_export",
  "dblink",
  "pg_terminate_backend",
  "pg_cancel_backend",
];

/** Strip SQL string literals and comments so keyword checks can't be evaded. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/'(?:[^']|'')*'/g, "''") // single-quoted strings
    .replace(/\$\$[\s\S]*?\$\$/g, "''") // dollar-quoted bodies
    .replace(/"(?:[^"]|"")*"/g, '""'); // quoted identifiers
}

export function validateReadonlyQuery(raw: string): ReadonlyValidation {
  const trimmed = raw.trim().replace(/;+\s*$/, ""); // drop a single trailing ;
  if (trimmed.length === 0) return { ok: false, reason: "empty query" };
  if (trimmed.length > 20_000) return { ok: false, reason: "query too long" };

  const scrubbed = stripLiteralsAndComments(trimmed);

  // Exactly one statement (no ; left once literals/comments are removed).
  if (scrubbed.includes(";")) {
    return { ok: false, reason: "only a single statement is allowed" };
  }
  // Must be a read query.
  if (!/^\s*(select|with)\b/i.test(scrubbed)) {
    return { ok: false, reason: "only SELECT / WITH queries are allowed" };
  }
  // No forbidden keyword anywhere (whole-word, case-insensitive).
  const lowered = scrubbed.toLowerCase();
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`).test(lowered)) {
      return { ok: false, reason: `disallowed keyword: ${kw}` };
    }
  }
  // `into` would be SELECT ... INTO (table creation).
  if (/\binto\b/.test(lowered)) {
    return { ok: false, reason: "SELECT INTO is not allowed" };
  }
  return { ok: true, normalized: trimmed };
}

export interface ReadonlyResult {
  ok: true;
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}
export interface ReadonlyError {
  ok: false;
  reason: string;
}

/**
 * Validate → wrap with an enforced LIMIT → run as azen_readonly. Never throws
 * for a bad query or a query error; returns a typed error the tool can relay.
 */
export async function runReadonlySql(
  raw: string,
  opts: { maxRows?: number } = {},
): Promise<ReadonlyResult | ReadonlyError> {
  const check = validateReadonlyQuery(raw);
  if (!check.ok) return { ok: false, reason: check.reason };

  const maxRows = Math.min(
    Math.max(1, opts.maxRows ?? MAX_ROWS_DEFAULT),
    MAX_ROWS_CAP,
  );
  // Wrap so our LIMIT is authoritative regardless of the inner query's own
  // limit; fetch one extra row to detect truncation.
  const wrapped = `select * from (${check.normalized}) as _ask limit ${maxRows + 1}`;

  try {
    const sql = getReadonlyClient();
    // Wrap in a transaction so SET LOCAL scopes the 5s timeout to exactly
    // this statement on exactly this server connection — the role-level
    // default only applies when the URL logs in as azen_readonly, and the
    // connection-level startup param is ignored by the transaction pooler.
    const rows = (await sql.begin(async (tx) => {
      await tx.unsafe("set local statement_timeout = '5s'");
      return tx.unsafe(wrapped);
    })) as unknown as Record<string, unknown>[];
    const truncated = rows.length > maxRows;
    return {
      ok: true,
      rows: truncated ? rows.slice(0, maxRows) : rows,
      rowCount: truncated ? maxRows : rows.length,
      truncated,
    };
  } catch (err) {
    // Provider/SQL error detail stays server-side; the tool gets a terse note.
    console.error("[run_sql] query failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `query error: ${msg.slice(0, 300)}` };
  }
}

export async function closeReadonlyDb(): Promise<void> {
  if (roClient) {
    await roClient.end({ timeout: 5 });
    roClient = undefined;
  }
}
