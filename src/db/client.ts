import { createRequire } from "node:module";
import { POSTGRES_DDL, SQLITE_DDL } from "./schema.js";

/**
 * Minimal database abstraction over the two drivers we support:
 * PostgreSQL (Railway, production) and node:sqlite (local dev / tests).
 *
 * Deliberately not an ORM - the schema is one table plus an audit table, and
 * hand-written SQL keeps the dependency surface small.
 */
export interface Database {
  readonly dialect: "postgres" | "sqlite";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  migrate(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Rewrites `?` placeholders into `$1, $2, ...` for pg. */
function toPositional(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

class PostgresDatabase implements Database {
  readonly dialect = "postgres" as const;
  private pool: import("pg").Pool | undefined;

  constructor(private readonly connectionString: string) {}

  private async getPool(): Promise<import("pg").Pool> {
    if (!this.pool) {
      const { Pool } = await import("pg");
      this.pool = new Pool({
        connectionString: this.connectionString,
        max: 10,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        // Railway's internal Postgres uses a self-signed certificate.
        ssl: /\bsslmode=disable\b/.test(this.connectionString)
          ? false
          : this.connectionString.includes("localhost") || this.connectionString.includes("127.0.0.1")
            ? false
            : { rejectUnauthorized: false },
      });
    }
    return this.pool;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const pool = await this.getPool();
    const result = await pool.query(toPositional(sql), params as never[]);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.query(sql, params);
  }

  async migrate(): Promise<void> {
    const pool = await this.getPool();
    await pool.query(POSTGRES_DDL);
  }

  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
  }
}

/** Minimal surface of node:sqlite's DatabaseSync that we rely on. */
interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  close(): void;
}

class SqliteDatabase implements Database {
  readonly dialect = "sqlite" as const;
  private handle: SqliteHandle | undefined;

  constructor(private readonly location: string) {}

  /**
   * node:sqlite is resolved lazily through createRequire rather than a static
   * import: it is a recent Node builtin that bundlers and test runners still
   * fail to resolve through their own module graphs. This also keeps it out of
   * the graph entirely for Postgres deployments, which never touch it.
   */
  private async getHandle(): Promise<SqliteHandle> {
    if (!this.handle) {
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const handle = new DatabaseSync(this.location) as unknown as SqliteHandle;
      handle.exec("PRAGMA journal_mode = WAL");
      handle.exec("PRAGMA foreign_keys = ON");
      this.handle = handle;
    }
    return this.handle;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const handle = await this.getHandle();
    return handle.prepare(sql).all(...params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const handle = await this.getHandle();
    handle.prepare(sql).run(...params);
  }

  async migrate(): Promise<void> {
    (await this.getHandle()).exec(SQLITE_DDL);
  }

  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  async close(): Promise<void> {
    this.handle?.close();
    this.handle = undefined;
  }
}

/**
 * Chooses a driver from DATABASE_URL.
 *   postgres://... | postgresql://...  -> PostgreSQL
 *   sqlite::memory: | file path | unset -> node:sqlite
 */
export function createDatabase(databaseUrl: string | undefined): Database {
  if (databaseUrl && /^postgres(ql)?:\/\//.test(databaseUrl)) {
    return new PostgresDatabase(databaseUrl);
  }
  if (!databaseUrl || databaseUrl === "sqlite::memory:") {
    return new SqliteDatabase(":memory:");
  }
  return new SqliteDatabase(databaseUrl.replace(/^sqlite:(\/\/)?/, ""));
}
