import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const migrationsDir = path.resolve("database/migrations");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    (process.env.DATABASE_SSL ?? "disable") === "disable"
      ? false
      : { rejectUnauthorized: process.env.DATABASE_SSL !== "no-verify" },
});

if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL");

const client = await pool.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const filename of files) {
    const exists = await client.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [
      filename,
    ]);
    if (exists.rowCount) continue;
    const sql = await readFile(path.join(migrationsDir, filename), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      console.log(`[migrate] applied ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}
