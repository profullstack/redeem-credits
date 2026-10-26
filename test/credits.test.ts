import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { Credits, memoryStore, sqliteStore, postgresStore, supabaseStore, supabaseMigrationSql, normalizeCode, computeBalance, monthIndex, type CreditStore } from "../src/index.ts";
import { fakeSupabase } from "./fake-supabase.ts";
import { realPg, uniquePrefix } from "./pg.ts";

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0); // 2026-10-26 12:00 UTC

function clock(start = T0) {
  const c = { t: start, now: () => c.t, set: (ms: number) => (c.t = ms) };
  return c;
}

type Maker = () => Promise<CreditStore> | CreditStore;

const pglites: PGlite[] = [];
after(async () => {
  for (const pg of pglites) await pg.close();
});

const stores: [string, Maker][] = [
  ["memory", () => memoryStore()],
  ["sqlite (node:sqlite, prepare shape)", () => sqliteStore(new DatabaseSync(":memory:"))],
  [
    "sqlite (bun:sqlite query shape)",
    () => {
      const db = new DatabaseSync(":memory:");
      return sqliteStore({ exec: (s: string) => db.exec(s), query: (s: string) => db.prepare(s) });
    },
  ],
  [
    "postgres (PGlite)",
    () => {
      const pg = new PGlite();
      pglites.push(pg);
      return postgresStore(pg as unknown as { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> });
    },
  ],
  [
    "supabase (rpc functions on PGlite via fake supabase-js)",
    async () => {
      const pg = new PGlite();
      pglites.push(pg);
      await pg.exec(supabaseMigrationSql());
      return supabaseStore(fakeSupabase((sql, params) => pg.query(sql, params)));
    },
  ],
];
const pool = realPg();
if (pool) {
  stores.push([
    "supabase (rpc functions on real Postgres via fake supabase-js)",
    async () => {
      const prefix = uniquePrefix();
      await pool.query(supabaseMigrationSql(prefix));
      return supabaseStore(fakeSupabase((sql, params) => pool.query(sql, params)), { prefix });
    },
  ]);
}

for (const [name, make] of stores) {
  describe(`Credits on ${name}`, () => {
    async function setup() {
      const c = clock();
      const credits = new Credits(await make(), { now: c.now });
      return { c, credits };
    }

    test("mint returns a well-formed 80-bit code and redeem grants it", async () => {
      const { credits } = await setup();
      const m = await credits.mint({ grant: { unit: "minutes", amount: 1000, every: "month" }, label: "Preshy", createdBy: "anthony" });
      assert.match(m.code, /^CR-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
      assert.equal(m.label, "Preshy");
      assert.equal(m.maxRedemptions, 1);
      assert.equal(m.expiresAt, null);
      assert.equal(m.createdAt, T0);
      assert.deepEqual(m.grant, { unit: "minutes", amount: 1000, every: "month", months: null });
      const r = await credits.redeem(m.code, "preshy");
      assert.deepEqual(r, { ok: true, grant: { unit: "minutes", amount: 1000, every: "month", months: null }, codeId: m.id });
      assert.equal(await credits.balance("preshy", "minutes"), 1000);
      assert.equal(await credits.balance("preshy", "other-unit"), 0);
      assert.equal(await credits.balance("someone-else", "minutes"), 0);
    });

    test("redeem accepts sloppy input: case, spaces, dashes, O/I/L look-alikes", async () => {
      const { credits } = await setup();
      const m = await credits.mint({ grant: { unit: "u", amount: 1 }, maxRedemptions: 3 });
      const sloppy = " " + m.code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l") + " ";
      assert.equal((await credits.redeem(sloppy, "a")).ok, true);
      assert.equal((await credits.redeem(m.code.replace(/-/g, ""), "b")).ok, true);
    });

    test("invalid codes", async () => {
      const { credits } = await setup();
      await credits.mint({ grant: { unit: "u", amount: 1 } });
      assert.deepEqual(await credits.redeem("CR-0000-0000-0000-0000", "a"), { ok: false, reason: "invalid" });
      assert.deepEqual(await credits.redeem("", "a"), { ok: false, reason: "invalid" });
      assert.deepEqual(await credits.redeem("nope", "a"), { ok: false, reason: "invalid" });
    });

    test("expired", async () => {
      const { c, credits } = await setup();
      const m = await credits.mint({ grant: { unit: "u", amount: 5 }, expiresAt: T0 + 1000 });
      c.set(T0 + 1000);
      assert.deepEqual(await credits.redeem(m.code, "a"), { ok: false, reason: "expired" });
      c.set(T0 + 999);
      assert.equal((await credits.redeem(m.code, "a")).ok, true);
    });

    test("used_up and already_redeemed", async () => {
      const { credits } = await setup();
      const m = await credits.mint({ grant: { unit: "u", amount: 5 }, maxRedemptions: 2 });
      assert.equal((await credits.redeem(m.code, "a")).ok, true);
      assert.deepEqual(await credits.redeem(m.code, "a"), { ok: false, reason: "already_redeemed" });
      assert.equal((await credits.redeem(m.code, "b")).ok, true);
      assert.deepEqual(await credits.redeem(m.code, "c"), { ok: false, reason: "used_up" });
      assert.equal(await credits.balance("a", "u"), 5);
      assert.equal(await credits.balance("c", "u"), 0);
      const [info] = await credits.list();
      assert.equal(info!.redemptions, 2);
    });

    test("revoked, list and revoke", async () => {
      const { c, credits } = await setup();
      const a = await credits.mint({ grant: { unit: "u", amount: 1 }, label: "first" });
      c.set(T0 + 5);
      const b = await credits.mint({ grant: { unit: "u", amount: 2 }, label: "second" });
      await credits.revoke(a.id);
      await credits.revoke(a.id); // idempotent
      await assert.rejects(credits.revoke("crd_nope"), /unknown code id/);
      assert.deepEqual(await credits.redeem(a.code, "x"), { ok: false, reason: "revoked" });
      const list = await credits.list();
      assert.deepEqual(
        list.map((l) => [l.id, l.label, l.revokedAt, l.redemptions]),
        [
          [b.id, "second", null, 0],
          [a.id, "first", T0 + 5, 0],
        ],
      );
      assert.ok(!("hash" in list[0]!), "list never exposes hashes");
    });

    test("monthly allowance resets each UTC calendar month, no rollover", async () => {
      const { c, credits } = await setup();
      const m = await credits.mint({ grant: { unit: "minutes", amount: 1000, every: "month" } });
      await credits.redeem(m.code, "p");
      assert.deepEqual(await credits.spend("p", "minutes", 300, "call 1"), { ok: true, balance: 700 });
      c.set(Date.UTC(2026, 9, 31, 23, 59, 59, 999));
      assert.equal(await credits.balance("p", "minutes"), 700);
      c.set(Date.UTC(2026, 10, 1, 0, 0, 0, 0));
      assert.equal(await credits.balance("p", "minutes"), 1000);
      assert.deepEqual(await credits.spend("p", "minutes", 1000), { ok: true, balance: 0 });
      assert.deepEqual(await credits.spend("p", "minutes", 1), { ok: false, balance: 0 });
      c.set(Date.UTC(2027, 0, 15)); // across the year boundary
      assert.equal(await credits.balance("p", "minutes"), 1000);
    });

    test("months limit counts the redemption month as month one", async () => {
      const { c, credits } = await setup();
      const m = await credits.mint({ grant: { unit: "min", amount: 100, every: "month", months: 2 } });
      await credits.redeem(m.code, "p");
      assert.equal(await credits.balance("p", "min"), 100); // Oct
      c.set(Date.UTC(2026, 10, 30)); // Nov
      assert.equal(await credits.balance("p", "min"), 100);
      c.set(Date.UTC(2026, 11, 1)); // Dec
      assert.equal(await credits.balance("p", "min"), 0);
    });

    test("spend uses this month's allowance first, then one-off credits", async () => {
      const { c, credits } = await setup();
      await credits.grant("p", { unit: "min", amount: 500 }, "bonus");
      await credits.grant("p", { unit: "min", amount: 1000, every: "month" });
      assert.equal(await credits.balance("p", "min"), 1500);
      assert.deepEqual(await credits.spend("p", "min", 1200), { ok: true, balance: 300 });
      // Next month: fresh 1000 + the 300 one-off left over.
      c.set(Date.UTC(2026, 10, 3));
      assert.equal(await credits.balance("p", "min"), 1300);
      assert.deepEqual(await credits.spend("p", "min", 900), { ok: true, balance: 400 });
      // Monthly is consumed first, so the one-off 300 is intact.
      c.set(Date.UTC(2026, 11, 3));
      assert.equal(await credits.balance("p", "min"), 1300);
      const before = await credits.history("p", "min");
      assert.deepEqual(await credits.spend("p", "min", 1301), { ok: false, balance: 1300 });
      assert.equal((await credits.history("p", "min")).length, before.length, "a refused spend records nothing");
      assert.deepEqual(await credits.spend("p", "min", 1300), { ok: true, balance: 0 });
    });

    test("one-off credits never expire", async () => {
      const { c, credits } = await setup();
      const m = await credits.mint({ grant: { unit: "u", amount: 42 } });
      await credits.redeem(m.code, "p");
      c.set(Date.UTC(2030, 0, 1));
      assert.equal(await credits.balance("p", "u"), 42);
    });

    test("history lists grants and spends in order", async () => {
      const { c, credits } = await setup();
      const m = await credits.mint({ grant: { unit: "u", amount: 10 } });
      await credits.redeem(m.code, "p");
      c.set(T0 + 1);
      await credits.spend("p", "u", 4, "thing");
      c.set(T0 + 2);
      await credits.grant("p", { unit: "v", amount: 1 });
      assert.deepEqual(await credits.history("p"), [
        { unit: "u", amount: 10, kind: "grant", source: `code:${m.id}`, at: T0 },
        { unit: "u", amount: 4, kind: "spend", source: "thing", at: T0 + 1 },
        { unit: "v", amount: 1, kind: "grant", source: "admin", at: T0 + 2 },
      ]);
      assert.equal((await credits.history("p", "v")).length, 1);
    });

    test("concurrency: two redeems of a 1-use code, exactly one wins", async () => {
      const { credits } = await setup();
      const m = await credits.mint({ grant: { unit: "u", amount: 1 } });
      const rs = await Promise.all([credits.redeem(m.code, "a"), credits.redeem(m.code, "b")]);
      assert.equal(rs.filter((r) => r.ok).length, 1);
      assert.deepEqual(rs.find((r) => !r.ok), { ok: false, reason: "used_up" });
      const [info] = await credits.list();
      assert.equal(info!.redemptions, 1);
    });

    test("concurrency: same user redeeming twice at once gets one grant", async () => {
      const { credits } = await setup();
      const m = await credits.mint({ grant: { unit: "u", amount: 7 }, maxRedemptions: 10 });
      const rs = await Promise.all([credits.redeem(m.code, "a"), credits.redeem(m.code, "a"), credits.redeem(m.code, "a")]);
      assert.equal(rs.filter((r) => r.ok).length, 1);
      assert.equal(await credits.balance("a", "u"), 7);
    });

    test("concurrency: parallel spends never overdraw", async () => {
      const { credits } = await setup();
      await credits.grant("a", { unit: "u", amount: 1000 });
      const rs = await Promise.all(Array.from({ length: 5 }, () => credits.spend("a", "u", 300)));
      assert.equal(rs.filter((r) => r.ok).length, 3);
      assert.equal(await credits.balance("a", "u"), 100);
    });

    test("validation", async () => {
      const { credits } = await setup();
      await assert.rejects(credits.mint({ grant: { unit: "", amount: 1 } }), TypeError);
      await assert.rejects(credits.mint({ grant: { unit: "u", amount: 0 } }), TypeError);
      await assert.rejects(credits.mint({ grant: { unit: "u", amount: 1, months: 2 } }), /every/);
      await assert.rejects(credits.mint({ grant: { unit: "u", amount: 1, every: "month", months: 0 } }), TypeError);
      await assert.rejects(credits.mint({ grant: { unit: "u", amount: 1 }, maxRedemptions: 0 }), TypeError);
      await assert.rejects(credits.mint({ grant: { unit: "u", amount: 1 }, prefix: "no-dash" }), TypeError);
      await assert.rejects(credits.spend("a", "u", -1), TypeError);
      await assert.rejects(credits.redeem("CR-0000-0000-0000-0000", ""), TypeError);
    });

    test("custom prefix and no prefix", async () => {
      const { credits } = await setup();
      const a = await credits.mint({ grant: { unit: "u", amount: 1 }, prefix: "gift" });
      assert.match(a.code, /^GIFT-\w{4}-\w{4}-\w{4}-\w{4}$/);
      assert.equal((await credits.redeem(a.code.toLowerCase(), "x")).ok, true);
      const b = await credits.mint({ grant: { unit: "u", amount: 1 }, prefix: "" });
      assert.match(b.code, /^\w{4}-\w{4}-\w{4}-\w{4}$/);
      assert.equal((await credits.redeem(b.code, "x")).ok, true);
    });
  });
}

describe("SQLite specifics", () => {
  test("codes are stored only as sha256 hashes", async () => {
    const db = new DatabaseSync(":memory:");
    const credits = new Credits(sqliteStore(db));
    const m = await credits.mint({ grant: { unit: "u", amount: 1 } });
    const rows = db.prepare("SELECT * FROM credit_codes").all();
    const dump = JSON.stringify(rows);
    const body = m.code.replace(/-/g, "").slice(2);
    assert.ok(!dump.includes(m.code) && !dump.includes(body), "plaintext code leaked into the table");
    assert.equal((rows[0] as { hash: string }).hash, createHash("sha256").update(m.code).digest("hex"));
  });

  test("configurable table prefix", async () => {
    const db = new DatabaseSync(":memory:");
    const credits = new Credits(sqliteStore(db, { prefix: "gc_" }));
    await credits.grant("a", { unit: "u", amount: 1 });
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(names.filter((n) => n.startsWith("gc_")), ["gc_accounts", "gc_codes", "gc_ledger", "gc_redemptions"]);
    assert.throws(() => sqliteStore(db, { prefix: "bad; DROP" }), TypeError);
  });

  test("two connections to one file: 1-use code redeemed once, spends never overdraw", async () => {
    const dir = mkdtempSync(join(import.meta.dirname, ".tmp-"));
    try {
      const file = join(dir, "c.sqlite");
      const open = () => {
        const db = new DatabaseSync(file);
        db.exec("PRAGMA busy_timeout = 5000");
        return new Credits(sqliteStore(db));
      };
      const one = open();
      const two = open();
      const m = await one.mint({ grant: { unit: "u", amount: 1000 } });
      const rs = await Promise.all([one.redeem(m.code, "a"), two.redeem(m.code, "b")]);
      assert.equal(rs.filter((r) => r.ok).length, 1);
      const winner = rs[0]!.ok ? "a" : "b";
      const spends = await Promise.all([one.spend(winner, "u", 600), two.spend(winner, "u", 600)]);
      assert.equal(spends.filter((s) => s.ok).length, 1);
      assert.equal(await two.balance(winner, "u"), 400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Postgres specifics", () => {
  test("codes are stored only as hashes, tables use the prefix", async () => {
    const pg = new PGlite();
    pglites.push(pg);
    const credits = new Credits(postgresStore(pg as never, { prefix: "gc_" }));
    const m = await credits.mint({ grant: { unit: "u", amount: 1, every: "month", months: 3 } });
    const { rows } = await pg.query<{ hash: string; recur: string; months: number }>("SELECT * FROM gc_codes");
    assert.equal(rows[0]!.hash, createHash("sha256").update(m.code).digest("hex"));
    assert.ok(!JSON.stringify(rows).includes(m.code.slice(3)));
    assert.equal(rows[0]!.recur, "month");
    assert.equal(rows[0]!.months, 3);
  });
});

describe("normalizeCode", () => {
  test("canonical grouping", () => {
    assert.equal(normalizeCode("cr-7k3m-qx9d-2f8h-w4tn"), "CR-7K3M-QX9D-2F8H-W4TN");
    assert.equal(normalizeCode("  CR 7K3M QX9D 2F8H W4TN "), "CR-7K3M-QX9D-2F8H-W4TN");
    assert.equal(normalizeCode("CR7K3MQX9D2F8HW4TN"), "CR-7K3M-QX9D-2F8H-W4TN");
    assert.equal(normalizeCode("cr—7k3m_qx9d.2f8h/w4tn"), "CR-7K3M-QX9D-2F8H-W4TN");
    assert.equal(normalizeCode("7K3MQX9D2F8HW4TN"), "7K3M-QX9D-2F8H-W4TN");
  });
  test("folds Crockford look-alikes in the body only", () => {
    assert.equal(normalizeCode("CR-OOOO-IIII-LLLL-oil0"), "CR-0000-1111-1111-0110");
    assert.equal(normalizeCode("GOLD-0000-1111-2222-3333"), "GOLD-0000-1111-2222-3333");
  });
  test("short input is compacted, not padded", () => {
    assert.equal(normalizeCode("ab-c d"), "ABCD");
    assert.equal(normalizeCode(""), "");
    assert.equal(normalizeCode(undefined as unknown as string), "");
  });
  test("is idempotent", () => {
    const s = "CR-7K3M-QX9D-2F8H-W4TN";
    assert.equal(normalizeCode(normalizeCode(s)), s);
  });
});

describe("month math", () => {
  test("monthIndex is UTC", () => {
    assert.equal(monthIndex(Date.UTC(2026, 11, 31, 23, 59)) + 1, monthIndex(Date.UTC(2027, 0, 1)));
  });
  test("computeBalance ignores future-dated entries", () => {
    const e = { userId: "a", unit: "u", kind: "grant" as const, every: null, months: null, source: "x" };
    assert.equal(computeBalance([{ ...e, amount: 5, at: 10 }, { ...e, amount: 7, at: 30 }], 20), 5);
  });
});
