# @profullstack/redeem-credits

Redeemable credit codes for every Profullstack site. Mint a scarce code, hand it
to someone, they redeem it for credits (one-off, or every calendar month), and
your app spends against their balance. Like an invite code: scarce, and it says
someone wanted you in.

- Codes look like `CR-7K3M-QX9D-2F8H-W4TN`: 80 random bits in Crockford base32.
- Codes are stored **only as sha256 hashes**, so a database leak leaks no codes.
- Input is forgiving: case, spaces and dashes are ignored, and `O`/`I`/`L` are read as `0`/`1`.
- Redemption is concurrency-safe: `maxRedemptions` is enforced by a single
  `UPDATE ... WHERE redemptions < max_redemptions`, and each user can redeem a code once.
- Spends are concurrency-safe: a compare-and-swap on a per-account version, so
  parallel spends never overdraw.
- Monthly grants run on UTC calendar months. Unused monthly credits do not roll over.
- Stores: memory, SQLite (`bun:sqlite`, `node:sqlite`, `better-sqlite3`) and Postgres
  (`pg` Pool, PGlite, anything with `query(sql, params) -> { rows }`). The SQL stores
  create their own tables.
- A `redeem-credits` CLI for minting and admin against a SQLite file.

## Quick start

```ts
import { Database } from "bun:sqlite";
import { Credits, sqliteStore } from "@profullstack/redeem-credits";

const credits = new Credits(sqliteStore(new Database("app.sqlite")));
const { code } = await credits.mint({ grant: { unit: "minutes", amount: 1000, every: "month" }, label: "Preshy" });
// give `code` to Preshy; it is never stored in plaintext
const r = await credits.redeem(code, "user_preshy");       // { ok: true, grant, codeId }
await credits.balance("user_preshy", "minutes");             // 1000 this month, 1000 again next month
await credits.spend("user_preshy", "minutes", 12, "call 4821"); // { ok: true, balance: 988 }
```

```sh
npm i @profullstack/redeem-credits   # or: bun add @profullstack/redeem-credits
```

## API

```ts
export type Grant = { unit: string; amount: number; every?: 'month' | null; months?: number | null }
// every:'month' -> amount is granted each calendar month (UTC) from redemption, for `months` months
//                  (null = forever); the redemption month counts as month one; unused does not roll over.
// every null/absent -> one-off amount, never expires.

export type MintOptions = { grant: Grant; label?: string; maxRedemptions?: number /*default 1*/; expiresAt?: number | null /*ms*/; prefix?: string /*default 'CR'*/; createdBy?: string }
export type MintedCode = { code: string /*plaintext, shown once*/; id: string; label: string; grant: Grant; maxRedemptions: number; expiresAt: number | null; createdAt: number }
export type RedeemResult = { ok: true; grant: Grant; codeId: string } | { ok: false; reason: 'invalid' | 'expired' | 'used_up' | 'already_redeemed' | 'revoked' }
export type CodeInfo = { id: string; label: string; grant: Grant; maxRedemptions: number; redemptions: number; expiresAt: number | null; createdAt: number; revokedAt: number | null }

export interface CreditStore { /* codes (hashed), redemptions, ledger: see "Stores" */ }
export function memoryStore(): CreditStore
export function sqliteStore(db: SqliteLike, opts?: { prefix?: string }): CreditStore
export function postgresStore(pool: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }, opts?: { prefix?: string }): CreditStore

export class Credits {
  constructor(store: CreditStore, opts?: { now?: () => number })
  mint(o: MintOptions): Promise<MintedCode>
  redeem(code: string, userId: string): Promise<RedeemResult>        // case/space/dash-insensitive; one redemption per user per code
  balance(userId: string, unit: string): Promise<number>              // current month's recurring grants + one-off grants - spends
  spend(userId: string, unit: string, amount: number, note?: string): Promise<{ ok: boolean; balance: number }>
  grant(userId: string, g: Grant, source?: string): Promise<void>    // direct grant without a code (admin)
  list(): Promise<CodeInfo[]>                                         // newest first; never includes hashes
  revoke(codeId: string): Promise<void>                               // idempotent; throws for an unknown id
  history(userId: string, unit?: string): Promise<{ unit: string; amount: number; kind: 'grant' | 'spend'; source: string; at: number }[]>
}
export function normalizeCode(input: string): string
```

Also exported for advanced use: `computeBalance(entries, now)`, `monthIndex(ms)`,
`hashCode(normalized)`, `schemaSql(dialect, prefix)` (the DDL, for your own migrations)
and the store contract types (`CodeRecord`, `LedgerEntry`, `SqliteLike`, `PgLike`).

### Rules worth knowing

- **Reasons**, checked in this order: `invalid` (no such code), `revoked`, `expired`
  (`now >= expiresAt`), `already_redeemed` (this user, this code), `used_up`.
- **Spend order**: spends in a month count against that month's recurring allowance
  first, then against one-off credits. So a user with 1,000/month and a 500 bonus who
  spends 1,200 in October has 300 bonus left, and 1,300 on November 1st.
- **A refused spend records nothing** and returns `{ ok: false, balance }` with what
  is available.
- `normalizeCode` returns the canonical `PREFIX-XXXX-XXXX-XXXX-XXXX` form (the last 16
  letters/digits are the body; anything before them is the prefix). Shorter input
  comes back compacted and uppercased.
- `now` is injectable (`new Credits(store, { now: () => fakeTime })`) for tests.

## Stores

### SQLite

```ts
// bun
import { Database } from "bun:sqlite";
sqliteStore(new Database("app.sqlite"));

// node >= 22.5
import { DatabaseSync } from "node:sqlite";
sqliteStore(new DatabaseSync("app.sqlite"));

// better-sqlite3 (uses prepare() instead of query(); both shapes are accepted)
import Database from "better-sqlite3";
sqliteStore(new Database("app.sqlite"));
```

If several processes share the file, set `PRAGMA busy_timeout = 5000` on each connection.
Writes run in `BEGIN IMMEDIATE` transactions.

### Postgres

```ts
import pg from "pg";
postgresStore(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
```

Every statement is atomic on its own, so it works on a pool without pinning a
connection. Tables are created on first use (`CREATE TABLE IF NOT EXISTS`).

### Tables

Both SQL stores create four tables, prefixed `credit_` by default (`{ prefix: "gc_" }`
to change it): `credit_codes` (sha256 `hash`, never the code), `credit_redemptions`
(one row per code and user), `credit_ledger` (append-only grants and spends) and
`credit_accounts` (a version counter per user and unit for safe concurrent spends).

## CLI

```sh
npx @profullstack/redeem-credits mint --db gc.sqlite --unit minutes --amount 1000 --monthly --label "Preshy"
redeem-credits list    --db gc.sqlite
redeem-credits redeem  CR-7K3M-QX9D-2F8H-W4TN --user preshy --db gc.sqlite
redeem-credits balance --user preshy --unit minutes --db gc.sqlite
redeem-credits grant   --user preshy --unit minutes --amount 60 --db gc.sqlite
redeem-credits spend   --user preshy --unit minutes --amount 12 --note "call 4821" --db gc.sqlite
redeem-credits revoke  crd_rd3814n4kzbq --db gc.sqlite
redeem-credits history --user preshy --db gc.sqlite
```

Options: `--max N`, `--months N`, `--expires 2026-12-31|30d|<ms>`, `--prefix GIFT`,
`--by NAME`, `--table-prefix P`, `--json`. `--db` defaults to `$REDEEM_CREDITS_DB`
or `./credits.sqlite`. Runs on `bun:sqlite` under bun and `node:sqlite` under node
(>= 22.5; on 22.5 to 22.12 pass `--experimental-sqlite`). A refused redeem or spend
exits 1.

## Development

```sh
npm install
npm test          # node --experimental-strip-types --test (memory, node:sqlite, PGlite)
npm run typecheck
npm run build
```

MIT, Profullstack, Inc.
