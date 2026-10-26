/**
 * Real Postgres for the concurrency tests, when TEST_PG_URL is set (CI runs a
 * postgres service; locally: docker run -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17-alpine
 * and TEST_PG_URL=postgres://postgres:pw@127.0.0.1:55432/postgres). PGlite
 * runs one statement at a time, so only a real server exercises the locks.
 */
import { after } from "node:test";
import { randomBytes } from "node:crypto";
import pg from "pg";

let pool: pg.Pool | null | undefined;

export function realPg(): pg.Pool | null {
  if (pool !== undefined) return pool;
  const url = process.env.TEST_PG_URL;
  pool = url ? new pg.Pool({ connectionString: url, max: 20 }) : null;
  if (pool) {
    const p = pool;
    after(() => p.end());
  }
  return pool;
}

export function uniquePrefix(): string {
  return `t${randomBytes(5).toString("hex")}_`;
}
