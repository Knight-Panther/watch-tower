import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedSql = readFileSync(join(__dirname, "../seed.sql"), "utf-8");

const connectionString =
  process.env.DATABASE_URL || "postgres://watchtower:watchtower@127.0.0.1:5432/watchtower";

const pool = new pg.Pool({ connectionString });
try {
  await pool.query(seedSql);
  console.info("[db] seed complete");
} catch (err) {
  console.error("[db] seed failed", err);
  process.exit(1);
} finally {
  await pool.end();
}
