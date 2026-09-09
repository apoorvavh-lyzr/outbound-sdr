import { describe, expect, it } from "vitest";
import { createDatabase, resolvePostgresSsl } from "../src/db/client.js";

describe("resolvePostgresSsl", () => {
  it("disables TLS on Railway's private network", () => {
    // Railway's internal Postgres does not offer SSL; requesting it fails with
    // "The server does not support SSL connections".
    expect(
      resolvePostgresSsl("postgresql://postgres:pw@postgres.railway.internal:5432/railway"),
    ).toBe(false);
  });

  it("relaxes verification on Railway's public proxy", () => {
    // Reachable from outside, but the certificate will not verify publicly.
    expect(resolvePostgresSsl("postgresql://postgres:pw@monorail.proxy.rlwy.net:41234/railway")).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("disables TLS for local development", () => {
    expect(resolvePostgresSsl("postgresql://postgres@localhost:5432/dev")).toBe(false);
    expect(resolvePostgresSsl("postgresql://postgres@127.0.0.1:5432/dev")).toBe(false);
  });

  it("honours an explicit sslmode in the URL", () => {
    expect(resolvePostgresSsl("postgresql://u:p@host/db?sslmode=disable")).toBe(false);
    expect(resolvePostgresSsl("postgresql://u:p@host/db?sslmode=require")).toEqual({
      rejectUnauthorized: false,
    });
    expect(resolvePostgresSsl("postgresql://u:p@host/db?sslmode=verify-full")).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("lets sslmode=require override a private hostname", () => {
    expect(resolvePostgresSsl("postgresql://u:p@db.railway.internal/db?sslmode=require")).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("defaults to TLS for any ordinary remote host", () => {
    expect(resolvePostgresSsl("postgresql://u:p@db.example.com:5432/prod")).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("does not throw on an unparseable connection string", () => {
    expect(() => resolvePostgresSsl("not a url")).not.toThrow();
  });
});

describe("createDatabase driver selection", () => {
  it("chooses Postgres for postgres:// and postgresql:// URLs", () => {
    expect(createDatabase("postgres://u:p@h/db").dialect).toBe("postgres");
    expect(createDatabase("postgresql://u:p@h/db").dialect).toBe("postgres");
  });

  it("falls back to in-memory SQLite when DATABASE_URL is unset", () => {
    // Local dev should not require a database to be running.
    expect(createDatabase(undefined).dialect).toBe("sqlite");
    expect(createDatabase("").dialect).toBe("sqlite");
  });

  it("supports a SQLite file path for persistence between restarts", () => {
    expect(createDatabase("sqlite:/tmp/dev.db").dialect).toBe("sqlite");
  });
});
