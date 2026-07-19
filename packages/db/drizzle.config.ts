import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTransactionPoolerUrl } from "./src/client";

// Load the repo-root .env regardless of where drizzle-kit is invoked from
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../.env") });
config();

// Migrations are SESSION-pooler-only (port 5432, or a direct connection):
// drizzle-kit holds a migration lock and runs multi-statement DDL that the
// transaction pooler (6543) breaks. The runtime app is the reverse — it
// targets 6543 (src/client.ts disables prepared statements there). Refuse
// loudly rather than fail halfway through a migration.
if (process.env.DATABASE_URL && isTransactionPoolerUrl(process.env.DATABASE_URL)) {
  throw new Error(
    "DATABASE_URL targets the transaction pooler (port 6543). drizzle-kit needs " +
      "the SESSION pooler (port 5432) or a direct connection — swap the port and re-run.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
