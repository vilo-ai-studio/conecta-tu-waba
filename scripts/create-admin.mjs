import process from "node:process";
import { hash } from "bcryptjs";
import pg from "pg";

const { Pool } = pg;
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME?.trim() || null;

if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL");
if (!email || !password || password.length < 12) {
  throw new Error("Define ADMIN_EMAIL y ADMIN_PASSWORD de al menos 12 caracteres");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const passwordHash = await hash(password, 12);
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3)
     ON CONFLICT ((lower(email))) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           name = EXCLUDED.name,
           active = true,
           updated_at = now()
     RETURNING id, email`,
    [email, passwordHash, name],
  );
  await pool.query(
    "INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING",
    [result.rows[0].id],
  );
  console.log(`Administrador listo: ${result.rows[0].email}`);
} finally {
  await pool.end();
}
