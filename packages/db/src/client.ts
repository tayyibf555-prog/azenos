import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as schema from "./schema/index";

// Load the repo-root .env regardless of invocation cwd, then any local .env
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env") });
config();

let client: postgres.Sql | undefined;

export function getDbUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — copy .env.example to .env and run `pnpm db:local`",
    );
  }
  return url;
}

/**
 * Serverless deploys must use Supabase's TRANSACTION-mode pooler (port 6543):
 * session mode (5432) pins one server connection per client and exhausts the
 * pool under deploy overlap (observed as /api/projects 500s). Transaction mode
 * multiplexes clients across few server connections, so server session state
 * no longer belongs to this client — postgres-js named prepared statements
 * (default `prepare: true`) break there ("prepared statement … does not
 * exist"). Detection is by port: 6543 is the transaction pooler by Supabase
 * convention. Scoped to 6543 rather than unconditional so local dev (:54329)
 * and the session pooler (:5432 — still required by `pnpm migrate`, see
 * drizzle.config.ts) keep prepared statements, byte-identical to before. An
 * unparseable URL fails safe (prepare disabled — worst case a per-query
 * re-parse, never a pooler error); postgres() surfaces truly broken URLs.
 */
export function isTransactionPoolerUrl(url: string): boolean {
  try {
    return new URL(url).port === "6543";
  } catch {
    return true;
  }
}

function getClient(): postgres.Sql {
  if (!client) {
    const url = getDbUrl();
    client = postgres(url, {
      max: 10,
      onnotice: () => {},
      prepare: !isTransactionPoolerUrl(url),
    });
  }
  return client;
}

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let _db: DrizzleDb | undefined;

export function getDb(): DrizzleDb {
  if (!_db) {
    _db = drizzle({ client: getClient(), schema });
  }
  return _db;
}

// Lazy proxy: importing this module never opens a connection — the first
// property access does. Keeps builds/env-less imports safe.
export const db: DrizzleDb = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    const real = getDb() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? (value as CallableFunction).bind(real) : value;
  },
});

export type Db = DrizzleDb;

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = undefined;
  }
}

export { schema };
