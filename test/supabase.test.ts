import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Credits, memoryStore, supabaseStore, supabaseMigrationSql, type Grant } from "../src/index.ts";
import { fakeSupabase } from "./fake-supabase.ts";
import { realPg, uniquePrefix } from "./pg.ts";

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

const pglites: PGlite[] = [];
after(async () => {
  for (const pg of pglites) await pg.close();
});

async function pglite(): Promise<Query> {
  const pg = new PGlite();
  pglites.push(pg);
  await pg.exec(supabaseMigrationSql());
  return (sql, params) => pg.query(sql, params);
}

describe("supabase migration", () => {
  test("migrations/supabase.sql is supabaseMigrationSql() with the default prefix", () => {
    const file = readFileSync(new URL("../migrations/supabase.sql", import.meta.url), "utf8");
    assert.equal(file, supabaseMigrationSql());
    assert.equal(supabaseMigrationSql("credit_"), file);
  });

  test("prefix is applied everywhere and validated", () => {
    const sql = supabaseMigrationSql("gc_");
    assert.ok(sql.includes("public.gc_codes") && sql.includes("public.gc_redeem("));
    assert.ok(!sql.includes("credit_"));
    assert.throws(() => supabaseMigrationSql("bad-prefix;"), TypeError);
  });

  test("is idempotent", async () => {
    const pg = new PGlite();
    pglites.push(pg);
    await pg.exec(supabaseMigrationSql());
    await pg.exec(supabaseMigrationSql());
  });

  test("RLS on with no policies; functions SECURITY DEFINER, pinned search_path, not executable by PUBLIC", async () => {
    const q = await pglite();
    const rls = (await q(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('credit_codes','credit_redemptions','credit_ledger','credit_accounts') ORDER BY relname`)).rows;
    assert.equal(rls.length, 4);
    assert.ok(rls.every((r) => r.relrowsecurity === true));
    assert.equal((await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename LIKE 'credit_%'`)).rows[0].n, 0);
    const fns = (await q(`SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname LIKE 'credit_%' ORDER BY proname`)).rows;
    assert.deepEqual(fns.map((f) => f.proname), ["credit_account", "credit_append_if_version", "credit_history", "credit_redeem", "credit_revoke"]);
    for (const f of fns) {
      assert.equal(f.prosecdef, true, f.proname);
      assert.deepEqual(f.proconfig, ['search_path=""'], f.proname);
    }
    await q(`CREATE ROLE nobody_in_particular`);
    const exec = (await q(`SELECT bool_or(has_function_privilege('nobody_in_particular', oid, 'EXECUTE')) AS any FROM pg_proc WHERE proname LIKE 'credit_%'`)).rows[0];
    assert.equal(exec.any, false);
  });

  test("the store creates no schema: without the migration it fails loudly", async () => {
    const pg = new PGlite();
    pglites.push(pg);
    const credits = new Credits(supabaseStore(fakeSupabase((s, p) => pg.query(s, p))));
    await assert.rejects(credits.mint({ grant: { unit: "u", amount: 1 } }), /supabaseStore insert credit_codes/);
    await assert.rejects(credits.balance("a", "u"), /supabaseStore rpc credit_account/);
  });

  test("supabaseStore rejects a non-client", () => {
    assert.throws(() => supabaseStore({} as never), TypeError);
    assert.throws(() => supabaseStore({ from() {}, rpc() {} } as never, { prefix: "x;drop" }), TypeError);
  });
});

describe("supabaseStore goes through rpc for the atomic parts", () => {
  test("redeem and spend call the functions, codes stored as hashes only", async () => {
    const q = await pglite();
    const client = fakeSupabase(q);
    const credits = new Credits(supabaseStore(client));
    const m = await credits.mint({ grant: { unit: "u", amount: 100 } });
    assert.ok((await credits.redeem(m.code, "a")).ok);
    assert.deepEqual(await credits.spend("a", "u", 30), { ok: true, balance: 70 });
    await credits.revoke(m.id);
    assert.deepEqual(client.calls.rpc, ["credit_redeem", "credit_account", "credit_append_if_version", "credit_revoke"]);
    assert.deepEqual([...new Set(client.calls.from)], ["credit_codes"]);
    const rows = (await q(`SELECT * FROM credit_codes`)).rows;
    assert.ok(!JSON.stringify(rows).includes(m.code.slice(3)));
  });

  test("append_if_version is a compare-and-swap", async () => {
    const q = await pglite();
    const call = async (v: number) =>
      (await q(`SELECT public.credit_append_if_version('a','u',1,'spend',NULL,NULL,'x',1,$1) AS r`, [v])).rows[0].r;
    assert.equal(await call(0), true);
    assert.equal(await call(0), false);
    assert.equal(await call(1), true);
    assert.equal((await q(`SELECT count(*)::int AS n FROM credit_ledger`)).rows[0].n, 2);
  });

  test("list pages past one page of rows", async () => {
    const q = await pglite();
    const credits = new Credits(supabaseStore(fakeSupabase(q)));
    await Promise.all(Array.from({ length: 1003 }, (_, i) => credits.mint({ grant: { unit: "u", amount: 1 }, label: `c${i}` })));
    const list = await credits.list();
    assert.equal(list.length, 1003);
    assert.equal(new Set(list.map((c) => c.id)).size, 1003);
  });
});

const backends: [string, () => Promise<{ query: Query; prefix: string }>][] = [
  ["PGlite", async () => ({ query: await pglite(), prefix: "credit_" })],
];
const pool = realPg();
if (pool) {
  backends.push([
    "real Postgres",
    async () => {
      const prefix = uniquePrefix();
      await pool.query(supabaseMigrationSql(prefix));
      return { query: (s, p) => pool.query(s, p), prefix };
    },
  ]);
}

for (const [name, make] of backends) {
  describe(`supabaseStore concurrency on ${name}`, () => {
    test("30 users race for a 5-use code: exactly 5 win, ledger agrees", async () => {
      const { query, prefix } = await make();
      const credits = new Credits(supabaseStore(fakeSupabase(query), { prefix }));
      const m = await credits.mint({ grant: { unit: "u", amount: 10 }, maxRedemptions: 5 });
      const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => credits.redeem(m.code, `user${i}`)));
      assert.equal(rs.filter((r) => r.ok).length, 5);
      assert.ok(rs.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "used_up"));
      const codes = await credits.list();
      assert.equal(codes[0]!.redemptions, 5);
      assert.equal((await query(`SELECT count(*)::int AS n FROM ${prefix}ledger`)).rows[0].n, 5);
      assert.equal((await query(`SELECT count(*)::int AS n FROM ${prefix}redemptions`)).rows[0].n, 5);
    });

    test("one user redeeming a multi-use code 10 times at once gets one grant", async () => {
      const { query, prefix } = await make();
      const credits = new Credits(supabaseStore(fakeSupabase(query), { prefix }));
      const m = await credits.mint({ grant: { unit: "u", amount: 10 }, maxRedemptions: 100 });
      const rs = await Promise.all(Array.from({ length: 10 }, () => credits.redeem(m.code, "same")));
      assert.equal(rs.filter((r) => r.ok).length, 1);
      assert.ok(rs.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "already_redeemed"));
      assert.equal(await credits.balance("same", "u"), 10);
      assert.equal((await credits.list())[0]!.redemptions, 1);
    });

    test("25 parallel spends of 100 against 1000 (two Credits instances): exactly 10 succeed, never negative", async () => {
      const { query, prefix } = await make();
      const one = new Credits(supabaseStore(fakeSupabase(query), { prefix }));
      const two = new Credits(supabaseStore(fakeSupabase(query), { prefix }));
      await one.grant("a", { unit: "u", amount: 1000 });
      const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => (i % 2 ? one : two).spend("a", "u", 100)));
      assert.equal(rs.filter((r) => r.ok).length, 10);
      assert.equal(await one.balance("a", "u"), 0);
      const spent = (await query(`SELECT COALESCE(sum(amount),0)::float AS s FROM ${prefix}ledger WHERE kind = 'spend'`)).rows[0].s;
      assert.equal(spent, 1000);
    });
  });
}

if (pool) {
  describe("Supabase roles on real Postgres", () => {
    test("anon/authenticated get nothing, service_role gets the tables and functions", async () => {
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      END $$`);
      const prefix = uniquePrefix();
      // Mimic Supabase's default privileges: everything granted to anon/authenticated up front.
      await pool.query(`CREATE TABLE ${prefix}codes (id text)`);
      await pool.query(`GRANT ALL ON ${prefix}codes TO anon, authenticated`);
      await pool.query(`DROP TABLE ${prefix}codes`);
      await pool.query(supabaseMigrationSql(prefix));
      const priv = async (role: string, sql: string) => (await pool.query(sql.replaceAll("$ROLE", role))).rows[0].ok as boolean;
      for (const role of ["anon", "authenticated"]) {
        assert.equal(await priv(role, `SELECT has_table_privilege('$ROLE', '${prefix}ledger', 'SELECT') AS ok`), false, role);
        assert.equal(await priv(role, `SELECT has_function_privilege('$ROLE', '${prefix}redeem(text,text,bigint)', 'EXECUTE') AS ok`), false, role);
        assert.equal(await priv(role, `SELECT has_function_privilege('$ROLE', '${prefix}account(text,text)', 'EXECUTE') AS ok`), false, role);
      }
      assert.equal(await priv("service_role", `SELECT has_table_privilege('$ROLE', '${prefix}codes', 'INSERT') AS ok`), true);
      assert.equal(await priv("service_role", `SELECT has_function_privilege('$ROLE', '${prefix}redeem(text,text,bigint)', 'EXECUTE') AS ok`), true);
      assert.equal(await priv("service_role", `SELECT has_function_privilege('$ROLE', '${prefix}append_if_version(text,text,double precision,text,text,integer,text,bigint,integer)', 'EXECUTE') AS ok`), true);
    });
  });
}

describe("onGrant", () => {
  const stores: [string, () => Promise<ReturnType<typeof memoryStore>>][] = [
    ["memory", async () => memoryStore()],
    ["supabase (PGlite)", async () => supabaseStore(fakeSupabase(await pglite()))],
  ];
  for (const [name, make] of stores) {
    test(`called once per redeem and per grant, with the right args (${name})`, async () => {
      const seen: [string, Grant, string][] = [];
      const credits = new Credits(await make(), { onGrant: (u, g, s) => void seen.push([u, g, s]) });
      const m = await credits.mint({ grant: { unit: "pro_days", amount: 30, every: "month", months: 3 }, maxRedemptions: 2 });
      assert.equal(seen.length, 0, "mint does not grant");
      const r = await credits.redeem(m.code, "alice");
      assert.ok(r.ok);
      assert.deepEqual(seen, [["alice", { unit: "pro_days", amount: 30, every: "month", months: 3 }, `code:${m.id}`]]);
      // refusals do not call it
      assert.equal((await credits.redeem(m.code, "alice")).ok, false);
      assert.equal((await credits.redeem("CR-0000-0000-0000-0000", "bob")).ok, false);
      assert.equal(seen.length, 1);
      await credits.grant("bob", { unit: "pro_days", amount: 7 }, "invite:alice");
      await credits.grant("carol", { unit: "pro_days", amount: 1 });
      assert.deepEqual(seen.slice(1), [
        ["bob", { unit: "pro_days", amount: 7, every: null, months: null }, "invite:alice"],
        ["carol", { unit: "pro_days", amount: 1, every: null, months: null }, "admin"],
      ]);
      // spends never call it
      await credits.spend("bob", "pro_days", 1);
      assert.equal(seen.length, 3);
    });
  }

  test("awaits an async hook; concurrent redeems call it exactly once per winner", async () => {
    const seen: string[] = [];
    const credits = new Credits(memoryStore(), {
      onGrant: async (u) => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(u);
      },
    });
    const m = await credits.mint({ grant: { unit: "u", amount: 1 }, maxRedemptions: 3 });
    await Promise.all(["a", "b", "c", "d", "e", "a"].map((u) => credits.redeem(m.code, u)));
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen).size, 3);
  });

  test("a throwing hook surfaces to the caller, the grant stays recorded", async () => {
    const credits = new Credits(memoryStore(), {
      onGrant: () => {
        throw new Error("mirror down");
      },
    });
    const m = await credits.mint({ grant: { unit: "u", amount: 5 } });
    await assert.rejects(credits.redeem(m.code, "a"), /mirror down/);
    assert.equal(await credits.balance("a", "u"), 5);
    assert.deepEqual(await credits.redeem(m.code, "a"), { ok: false, reason: "already_redeemed" });
  });

  test("validation", () => {
    assert.throws(() => new Credits(memoryStore(), { onGrant: "nope" as never }), TypeError);
  });
});
