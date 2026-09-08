import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { decryptSecret, encryptSecret, validateEncryptionKey } from "./secrets.server";

type DatabaseError = {
  message: string;
  code?: string;
  detail?: string;
};

export type DatabaseResult = {
  // El adaptador conserva temporalmente la forma dinámica del cliente anterior.
  // Las consultas siguen estando parametrizadas y los identificadores validados.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error: DatabaseError | null;
  count?: number | null;
};

type Operation = "select" | "insert" | "update" | "upsert" | "delete";
type Filter = { column: string; operator: "=" | "<>" | ">=" | "<" | "is" | "in"; value: unknown };
type Relation = { output: string; table: string; columns: string; localKey?: string };

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;
const ENCRYPTED_COLUMNS = new Set([
  "token_encrypted",
  "n8n_webhook_secret_encrypted",
  "chatwoot_api_access_token_encrypted",
  "chatwoot_webhook_secret_encrypted",
]);

function storedValue(column: string, value: unknown): unknown {
  return ENCRYPTED_COLUMNS.has(column) ? encryptSecret(value) : value;
}

function readableRow(row: QueryResultRow): QueryResultRow {
  for (const column of ENCRYPTED_COLUMNS) {
    if (column in row) row[column] = decryptSecret(row[column]);
  }
  return row;
}

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Identificador SQL no permitido: ${value}`);
  return `"${value}"`;
}

function splitSelection(selection: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selection) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseSelection(selection = "*"): { columns: string; relations: Relation[] } {
  const scalar: string[] = [];
  const relations: Relation[] = [];
  for (const part of splitSelection(selection)) {
    const relation = part.match(/^([a-z_][a-z0-9_]*)(?::([a-z_][a-z0-9_]*))?\((.*)\)$/i);
    if (relation) {
      const output = relation[1];
      relations.push({
        output,
        table: relation[2] && relation[2] !== "client_id" ? relation[2] : output,
        localKey: relation[2] === "client_id" ? "client_id" : undefined,
        columns: relation[3] || "*",
      });
      continue;
    }
    if (part === "*") scalar.push("*");
    else scalar.push(identifier(part));
  }
  return { columns: scalar.length ? scalar.join(", ") : "*", relations };
}

function withRequiredColumn(columns: string, required: string): string {
  if (columns === "*") return columns;
  const quoted = identifier(required);
  return columns
    .split(",")
    .map((item) => item.trim())
    .includes(quoted)
    ? columns
    : `${columns}, ${quoted}`;
}

function databaseConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Falta DATABASE_URL");
  const sslMode = process.env.DATABASE_SSL?.toLowerCase() ?? "disable";
  return {
    connectionString,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: sslMode === "disable" ? false : { rejectUnauthorized: sslMode !== "no-verify" },
  };
}

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    validateEncryptionKey();
    pool = new Pool(databaseConfig());
    pool.on("error", (error) => console.error("[postgres] idle client error", error));
  }
  return pool;
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

class QueryBuilder implements PromiseLike<DatabaseResult> {
  private operation: Operation = "select";
  private selection = "*";
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private filters: Filter[] = [];
  private orders: { column: string; ascending: boolean }[] = [];
  private rowLimit: number | null = null;
  private singleMode: "single" | "maybe" | null = null;
  private countExact = false;
  private head = false;
  private conflictColumns: string[] = [];

  constructor(private readonly table: string) {
    identifier(table);
  }

  select(columns = "*", options?: { count?: "exact"; head?: boolean }) {
    this.selection = columns || "*";
    this.countExact = options?.count === "exact";
    this.head = options?.head === true;
    return this;
  }

  insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
    this.operation = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: Record<string, unknown>) {
    this.operation = "update";
    this.payload = payload;
    return this;
  }

  upsert(
    payload: Record<string, unknown> | Record<string, unknown>[],
    options?: { onConflict?: string },
  ) {
    this.operation = "upsert";
    this.payload = payload;
    this.conflictColumns = (options?.onConflict ?? "id")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, operator: "=", value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ column, operator: "<>", value });
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push({ column, operator: ">=", value });
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push({ column, operator: "<", value });
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push({ column, operator: "is", value });
    return this;
  }

  in(column: string, value: unknown[]) {
    this.filters.push({ column, operator: "in", value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(value: number) {
    this.rowLimit = Math.max(0, Math.trunc(value));
    return this;
  }

  single() {
    this.singleMode = "single";
    return this.execute();
  }

  maybeSingle() {
    this.singleMode = "maybe";
    return this.execute();
  }

  then<TResult1 = DatabaseResult, TResult2 = never>(
    onfulfilled?: ((value: DatabaseResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private where(values: unknown[]): string {
    if (!this.filters.length) return "";
    const clauses = this.filters.map((filter) => {
      const column = identifier(filter.column);
      if (filter.operator === "is") {
        if (filter.value === null) return `${column} IS NULL`;
        if (filter.value === true) return `${column} IS TRUE`;
        if (filter.value === false) return `${column} IS FALSE`;
        throw new Error("El operador is solo admite null o booleanos");
      }
      if (filter.operator === "in") {
        const list = Array.isArray(filter.value) ? filter.value : [];
        if (!list.length) return "FALSE";
        const placeholders = list.map((item) => {
          values.push(item);
          return `$${values.length}`;
        });
        return `${column} IN (${placeholders.join(", ")})`;
      }
      values.push(filter.value);
      return `${column} ${filter.operator} $${values.length}`;
    });
    return ` WHERE ${clauses.join(" AND ")}`;
  }

  private async hydrate(rows: QueryResultRow[], relations: Relation[]): Promise<QueryResultRow[]> {
    if (!relations.length || !rows.length) return rows;
    const db = getPool();
    for (const relation of relations) {
      identifier(relation.output);
      identifier(relation.table);
      const parsed = parseSelection(relation.columns);
      if (this.table === "clients") {
        const parentIds = rows.map((row) => row.id).filter(Boolean);
        const result = await db.query(
          `SELECT ${withRequiredColumn(parsed.columns, "client_id")} FROM ${identifier(relation.table)} WHERE "client_id" = ANY($1::uuid[])`,
          [parentIds],
        );
        const relatedRows = result.rows.map(readableRow);
        for (const row of rows) {
          row[relation.output] = relatedRows.filter((child) => child.client_id === row.id);
        }
      } else {
        const localKey = relation.localKey ?? `${relation.output.replace(/s$/, "")}_id`;
        identifier(localKey);
        const ids = rows.map((row) => row[localKey]).filter(Boolean);
        const result = ids.length
          ? await db.query(
              `SELECT ${withRequiredColumn(parsed.columns, "id")} FROM ${identifier(relation.table)} WHERE "id" = ANY($1::uuid[])`,
              [ids],
            )
          : { rows: [] as QueryResultRow[] };
        for (const row of rows) {
          row[relation.output] =
            result.rows.map(readableRow).find((related) => related.id === row[localKey]) ?? null;
        }
      }
    }
    return rows;
  }

  private async execute(): Promise<DatabaseResult> {
    try {
      const values: unknown[] = [];
      const parsed = parseSelection(this.selection);
      let sql = "";

      if (this.operation === "select") {
        const columns = this.countExact ? "COUNT(*)::int AS count" : parsed.columns;
        sql = `SELECT ${columns} FROM ${identifier(this.table)}${this.where(values)}`;
        if (!this.countExact && this.orders.length) {
          sql += ` ORDER BY ${this.orders
            .map((order) => `${identifier(order.column)} ${order.ascending ? "ASC" : "DESC"}`)
            .join(", ")}`;
        }
        if (!this.countExact && this.rowLimit !== null) sql += ` LIMIT ${this.rowLimit}`;
      } else if (this.operation === "insert" || this.operation === "upsert") {
        const records = (Array.isArray(this.payload) ? this.payload : [this.payload]).filter(
          (record): record is Record<string, unknown> => !!record,
        );
        if (!records.length) throw new Error("Insert vacío");
        const columns = Object.keys(records[0]).filter((key) =>
          records.some((record) => record[key] !== undefined),
        );
        columns.forEach(identifier);
        const tuples = records.map((record) => {
          const placeholders = columns.map((column) => {
            values.push(record[column] === undefined ? null : storedValue(column, record[column]));
            return `$${values.length}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        sql = `INSERT INTO ${identifier(this.table)} (${columns.map(identifier).join(", ")}) VALUES ${tuples.join(", ")}`;
        if (this.operation === "upsert") {
          this.conflictColumns.forEach(identifier);
          const updates = columns
            .filter((column) => !this.conflictColumns.includes(column))
            .map((column) => `${identifier(column)} = EXCLUDED.${identifier(column)}`);
          sql += ` ON CONFLICT (${this.conflictColumns.map(identifier).join(", ")}) DO ${updates.length ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"}`;
        }
        sql += ` RETURNING ${parsed.columns}`;
      } else if (this.operation === "update") {
        const payload = this.payload as Record<string, unknown>;
        const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
        if (!entries.length) throw new Error("Update vacío");
        const setters = entries.map(([column, value]) => {
          identifier(column);
          values.push(storedValue(column, value));
          return `${identifier(column)} = $${values.length}`;
        });
        sql = `UPDATE ${identifier(this.table)} SET ${setters.join(", ")}${this.where(values)} RETURNING ${parsed.columns}`;
      } else {
        sql = `DELETE FROM ${identifier(this.table)}${this.where(values)} RETURNING ${parsed.columns}`;
      }

      const result = await getPool().query(sql, values);
      if (this.countExact) {
        return {
          data: this.head ? null : result.rows,
          error: null,
          count: result.rows[0]?.count ?? 0,
        };
      }
      const rows = await this.hydrate(result.rows.map(readableRow), parsed.relations);
      if (this.singleMode === "single") {
        if (rows.length !== 1)
          return {
            data: null,
            error: { message: `Se esperaba una fila y se recibieron ${rows.length}` },
          };
        return { data: rows[0], error: null };
      }
      if (this.singleMode === "maybe") {
        if (rows.length > 1)
          return {
            data: null,
            error: { message: `Se esperaba máximo una fila y se recibieron ${rows.length}` },
          };
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    } catch (error) {
      const dbError = error as { message?: string; code?: string; detail?: string };
      return {
        data: null,
        error: {
          message: dbError.message ?? String(error),
          code: dbError.code,
          detail: dbError.detail,
        },
      };
    }
  }
}

export const database = {
  from(table: string) {
    return new QueryBuilder(table);
  },
};

export const databaseAdmin = database;

export async function checkDatabase(): Promise<void> {
  await getPool().query("SELECT 1");
}
