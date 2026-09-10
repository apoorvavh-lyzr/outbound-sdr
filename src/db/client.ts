import { createRequire } from "node:module";
import { POSTGRES_ALTERS, POSTGRES_DDL, SQLITE_ALTERS, SQLITE_DDL } from "./schema.js";

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

/**
 * Decides whether a Postgres connection should use TLS.
 *
 * Railway wires services together over a private network, and its Postgres
 * does NOT offer SSL on the internal hostname - asking for it there fails with
 * "The server does not support SSL connections". Its PUBLIC proxy hostname does
 * use TLS, but with a certificate that will not verify against a public CA, so
 * verification is relaxed rather than skipping encryption entirely.
 */
export function resolvePostgresSsl(connectionString: string): false | { rejectUnauthorized: boolean } {
  // An explicit sslmode in the URL always wins.
  if (/\bsslmode=disable\b/.test(connectionString)) return false;
  if (/\bsslmode=(require|prefer|verify-ca|verify-full)\b/.test(connectionString)) {
    return { rejectUnauthorized: /\bsslmode=verify-full\b/.test(connectionString) };
  }

  let host = "";
  try {
    host = new URL(connectionString).hostname;
  } catch {
    host = connectionString;
  }

  // Local development and private service-to-service networks: no TLS offered.
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const isPrivate = host.endsWith(".internal") || host.endsWith(".local");
  if (isLocal || isPrivate) return false;

  return { rejectUnauthorized: false };
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
        ssl: resolvePostgresSsl(this.connectionString),
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
    for (const alter of POSTGRES_ALTERS) {
      await pool.query(alter);
    }
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
    const handle = await this.getHandle();
    handle.exec(SQLITE_DDL);
    for (const alter of SQLITE_ALTERS) {
      try {
        handle.exec(alter);
      } catch {
        // Column already present - the table was created by the current DDL.
      }
    }
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
