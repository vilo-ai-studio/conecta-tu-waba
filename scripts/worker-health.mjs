import process from "node:process";
import pg from "pg";
import IORedis from "ioredis";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const redis = new IORedis(process.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
});

try {
  await pool.query("SELECT 1");
  await redis.connect();
  if ((await redis.get("conecta:worker:heartbeat")) === null) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
  await redis.quit().catch(() => undefined);
}
