/**
 * End to end through the real @supabase/supabase-js client and a real
 * PostgREST, when POSTGREST_URL and POSTGREST_JWT_SECRET are set
 * (scripts/postgrest-up.sh starts the pair). Skipped otherwise.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Credits, supabaseStore } from "../src/index.ts";

const url = process.env.POSTGREST_URL;
const secret = process.env.POSTGREST_JWT_SECRET;

function jwt(role: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role, iss: "supabase", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${body}.${createHmac("sha256", secret!).update(body).digest("base64url")}`;
}

// supabase-js talks to <url>/rest/v1; a bare PostgREST serves at the root.
function client(role: string) {
  return createClient("http://supabase.local", jwt(role), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://supabase.local/rest/v1", url!), init) },
  });
}

describe("supabaseStore through real supabase-js + PostgREST", { skip: !url || !secret ? "POSTGREST_URL not set" : false }, () => {
  test("mint, redeem, balance, spend, list, revoke, history", async () => {
    const credits = new Credits(supabaseStore(client("service_role")));
    const user = `u${Date.now()}`;
    const m = await credits.mint({ grant: { unit: "minutes", amount: 1000, every: "month" }, maxRedemptions: 3 });
    assert.deepEqual(await credits.redeem(m.code.toLowerCase(), user), { ok: true, grant: { unit: "minutes", amount: 1000, every: "month", months: null }, codeId: m.id });
    assert.deepEqual(await credits.redeem(m.code, user), { ok: false, reason: "already_redeemed" });
    assert.equal(await credits.balance(user, "minutes"), 1000);
    assert.deepEqual(await credits.spend(user, "minutes", 12, "call"), { ok: true, balance: 988 });
    assert.deepEqual(await credits.spend(user, "minutes", 5000), { ok: false, balance: 988 });
    const listed = (await credits.list()).find((c) => c.id === m.id)!;
    assert.equal(listed.redemptions, 1);
    await credits.revoke(m.id);
    await credits.revoke(m.id);
    await assert.rejects(credits.revoke("crd_nope"), /unknown code id/);
    assert.deepEqual(await credits.redeem(m.code, `${user}x`), { ok: false, reason: "revoked" });
    const h = await credits.history(user);
    assert.deepEqual(h.map((e) => [e.kind, e.amount, e.source]), [["grant", 1000, `code:${m.id}`], ["spend", 12, "call"]]);
  });

  test("concurrent redeems and spends over HTTP stay exact", async () => {
    const credits = new Credits(supabaseStore(client("service_role")));
    const tag = `c${Date.now()}`;
    const m = await credits.mint({ grant: { unit: "u", amount: 100 }, maxRedemptions: 4 });
    const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => credits.redeem(m.code, `${tag}-${i}`)));
    assert.equal(rs.filter((r) => r.ok).length, 4);
    const winner = `${tag}-${rs.findIndex((r) => r.ok)}`;
    const spends = await Promise.all(Array.from({ length: 12 }, () => credits.spend(winner, "u", 25)));
    assert.equal(spends.filter((s) => s.ok).length, 4);
    assert.equal(await credits.balance(winner, "u"), 0);
  });

  test("anon and authenticated keys are locked out of tables and functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      const c = client(role);
      const sel = await c.from("credit_codes").select("*");
      assert.equal(sel.error?.code, "42501", `${role} select should fail`);
      const ins = await c.from("credit_ledger").insert({ user_id: "x", unit: "u", amount: 1e9, kind: "grant", source: "hax", at: 1 });
      assert.equal(ins.error?.code, "42501", `${role} insert should fail`);
      const rpc = await c.rpc("credit_append_if_version", { p_user_id: "x", p_unit: "u", p_amount: 1, p_kind: "grant", p_recur: null, p_months: null, p_source: "hax", p_at: 1, p_version: 0 });
      assert.equal(rpc.error?.code, "42501", `${role} rpc should fail`);
      const acc = await c.rpc("credit_account", { p_user_id: "x", p_unit: "u" });
      assert.equal(acc.error?.code, "42501", `${role} account rpc should fail`);
    }
  });
});
