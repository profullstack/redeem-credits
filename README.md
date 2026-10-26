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
- Stores: memory, SQLite (`bun:sqlite`, `node:sqlite`, `better-sqlite3`), Postgres
  (`pg` Pool, PGlite, anything with `query(sql, params) -> { rows }`) and Supabase
  (supabase-js with the service role key; the atomic parts run in Postgres functions
  called with `rpc()`). The SQLite and Postgres stores create their own tables; the
  Supabase store ships its schema as a migration.
- An `onGrant` hook mirrors every grant into a ledger your site already has.
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
export function supabaseStore(client: SupabaseLike /* a supabase-js client */, opts?: { prefix?: string }): CreditStore
export function supabaseMigrationSql(prefix?: string /* default 'credit_' */): string

export type OnGrant = (userId: string, grant: Grant, source: string) => Promise<void> | void

export class Credits {
  constructor(store: CreditStore, opts?: { now?: () => number; onGrant?: OnGrant })
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
and the store contract types (`CodeRecord`, `LedgerEntry`, `SqliteLike`, `PgLike`,
`SupabaseLike`, `CreditsOptions`).

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

### On Supabase

For a site (Next.js or anything server side) on Supabase, hosted or self-hosted,
with only the supabase-js client and the service role key: no `DATABASE_URL` needed.

1. Add the schema as a migration. Copy `migrations/supabase.sql` from the package
   (`node_modules/@profullstack/redeem-credits/migrations/supabase.sql`) to
   `supabase/migrations/<timestamp>_redeem_credits.sql` and apply it
   (`supabase db push`, or run it in the SQL editor). For another table prefix,
   generate it: `node -e 'import("@profullstack/redeem-credits").then(m => process.stdout.write(m.supabaseMigrationSql("gc_")))'`.
2. Build the store from a service-role client, server side only:

```ts
// lib/credits.ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { Credits, supabaseStore } from "@profullstack/redeem-credits";

// process.env[name] with a non-literal key: Next.js inlines process.env.LITERAL at build time.
const env = (name: string) => process.env[name] ?? "";
let credits: Credits | undefined;
export function getCredits(): Credits {
  return (credits ??= new Credits(
    supabaseStore(createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } })),
  ));
}
```

```ts
// app/api/redeem/route.ts
const r = await getCredits().redeem(code, user.id);   // user from your auth check
```

What the migration sets up:

- the four `credit_*` tables (below) with **row level security enabled and no
  policies**, and all privileges revoked from `anon` and `authenticated`, so the
  browser keys cannot read or write them. Only the service role (which bypasses RLS) can.
- `SECURITY DEFINER` functions with `search_path = ''`, executable only by
  `service_role`: `credit_redeem` (locks the code row, so `maxRedemptions` and one
  redemption per user hold under concurrency), `credit_append_if_version` (the
  compare-and-swap every spend goes through, so parallel spends never overdraw),
  `credit_account` and `credit_history` (one JSON value each, so PostgREST's
  `max-rows` never truncates a ledger) and `credit_revoke`.
- It is idempotent; applying it twice is harmless. The store never creates schema
  at runtime, and fails with `supabaseStore rpc credit_account: ...` if the
  migration is missing.

`supabaseStore` uses only `from(table).select().order().range()`, `from(table).insert()`
and `rpc(fn, args)`. `@supabase/supabase-js` is not a dependency: pass the client
you already have.

### Tables

The SQL stores use four tables, prefixed `credit_` by default (`{ prefix: "gc_" }`
to change it): `credit_codes` (sha256 `hash`, never the code), `credit_redemptions`
(one row per code and user), `credit_ledger` (append-only grants and spends) and
`credit_accounts` (a version counter per user and unit for safe concurrent spends).

## Your own ledger

Some sites already keep credits (`credit_ledger`, `scan_credits`, a `pro_until`
column...). Do not run two balances side by side. Pick one of two patterns:

**Mirror every grant** into your ledger with `onGrant`. It runs after the grant is
committed: once per successful `redeem()` (source `code:<codeId>`) and once per
`grant()` (its `source`, default `"admin"`). Refused redeems and spends never call it.

```ts
const credits = new Credits(supabaseStore(supabase), {
  onGrant: async (userId, grant, source) => {
    await supabase.from("credit_ledger").insert({ user_id: userId, delta: grant.amount, reason: source });
  },
});
```

**Use only your ledger.** Use this module for minting and redeeming codes and nothing
else: call `redeem()`, and on `ok` write `r.grant` into your own ledger yourself. Never
call `balance()` or `spend()`. The `credit_ledger` table still receives one grant row
per redemption, as an audit trail, and is otherwise unused.

```ts
const r = await credits.redeem(code, user.id);
if (!r.ok) return Response.json({ error: r.reason }, { status: 400 }); // invalid | expired | used_up | already_redeemed | revoked
await addToMyLedger(user.id, r.grant.unit, r.grant.amount, `code:${r.codeId}`);
```

Either way:

- If the hook (or your write) throws, the error reaches the caller but the
  redemption stands: the code is used and will answer `already_redeemed` on retry.
  Make the mirror write idempotent on `(userId, source)`, or retry it from a job.
- A monthly code (`every: "month"`) is one grant event. A site with its own ledger
  has to top up monthly itself (a monthly job, or a top-up on read), or mint one-off
  codes instead. For plan-style access, use a day unit (`pro_days`) and treat
  `balance > 0` as the paid plan.

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
npm test          # node --experimental-strip-types --test (memory, node:sqlite, PGlite, Supabase rpc on PGlite)
npm run typecheck
npm run build
npm run migration # regenerate migrations/supabase.sql after changing supabaseMigrationSql()

# real Postgres (concurrency under row locks) and real supabase-js + PostgREST,
# with Supabase-like roles, in Docker:
eval "$(npm run -s e2e:up)" && npm test; npm run e2e:down
```

`TEST_PG_URL` turns on the real-Postgres suites; `POSTGREST_URL` and
`POSTGREST_JWT_SECRET` turn on the supabase-js + PostgREST suite. CI runs all of them.

MIT, Profullstack, Inc.
