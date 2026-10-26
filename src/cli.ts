#!/usr/bin/env node
/**
 * redeem-credits: mint, list, revoke, redeem, grant, spend and check balances
 * against a SQLite file. Uses bun:sqlite under bun, node:sqlite under node.
 */
import { parseArgs } from "node:util";
import { Credits, sqliteStore, type Grant, type SqliteLike } from "./index.ts";

const HELP = `redeem-credits - redeemable credit codes (SQLite)

Usage: redeem-credits <command> [options]

Commands:
  mint     --unit U --amount N [--monthly [--months N]] [--label L] [--max N]
           [--expires 2026-12-31|30d|<ms>] [--prefix CR] [--by NAME]
  list
  revoke   <codeId>
  redeem   <code> --user ID
  balance  --user ID --unit U
  grant    --user ID --unit U --amount N [--monthly [--months N]] [--source S]
  spend    --user ID --unit U --amount N [--note TEXT]
  history  --user ID [--unit U]

Global options:
  --db PATH            SQLite file (default $REDEEM_CREDITS_DB or ./credits.sqlite)
  --table-prefix P     table prefix (default credit_)
  --json               machine-readable output
  -h, --help

Example:
  redeem-credits mint --db gc.sqlite --unit minutes --amount 1000 --monthly --label "Preshy"
  redeem-credits redeem CR-7K3M-QX9D-2F8H-W4TN --user preshy --db gc.sqlite
`;

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    "table-prefix": { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    unit: { type: "string" },
    amount: { type: "string" },
    monthly: { type: "boolean", default: false },
    months: { type: "string" },
    label: { type: "string" },
    max: { type: "string" },
    expires: { type: "string" },
    prefix: { type: "string" },
    by: { type: "string" },
    user: { type: "string" },
    source: { type: "string" },
    note: { type: "string" },
  },
});

const [command, arg] = positionals;

function fail(msg: string, code = 2): never {
  if (v.json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  else process.stderr.write(`redeem-credits: ${msg}\n`);
  process.exit(code);
}

function need(name: keyof typeof v): string {
  const val = v[name];
  if (typeof val !== "string" || !val) fail(`--${name} is required for ${command}`);
  return val;
}

function number(name: keyof typeof v): number {
  const n = Number(need(name));
  if (!Number.isFinite(n)) fail(`--${name} must be a number`);
  return n;
}

function grantFromFlags(): Grant {
  const g: Grant = { unit: need("unit"), amount: number("amount") };
  if (v.monthly) {
    g.every = "month";
    g.months = v.months ? number("months") : null;
  } else if (v.months) fail("--months needs --monthly");
  return g;
}

function parseExpires(s: string, now: number): number {
  const rel = /^(\d+)([dhm])$/.exec(s);
  if (rel) return now + Number(rel[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[rel[2] as "d" | "h" | "m"];
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) fail(`cannot parse --expires ${s}`);
  return t;
}

async function openDb(path: string): Promise<SqliteLike> {
  if ((globalThis as { Bun?: unknown }).Bun) {
    const mod = "bun:sqlite";
    const { Database } = (await import(mod)) as { Database: new (p: string, o?: object) => SqliteLike };
    return new Database(path, { create: true });
  }
  // node:sqlite still prints an ExperimentalWarning on some versions.
  const emit = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000");
    return db as unknown as SqliteLike;
  } catch (err) {
    fail(`node:sqlite unavailable (needs node >= 22.5; on 22.5-22.12 run with --experimental-sqlite, or use bun): ${(err as Error).message}`);
  } finally {
    process.emitWarning = emit;
  }
}

const iso = (ms: number | null) => (ms == null ? "never" : new Date(ms).toISOString());
const describe = (g: Grant) => `${g.amount} ${g.unit}${g.every === "month" ? `/month${g.months ? ` x${g.months}` : ""}` : " one-off"}`;
const out = (json: unknown, text: string) => process.stdout.write((v.json ? JSON.stringify(json, null, 2) : text) + "\n");

async function main(): Promise<void> {
  if (v.help || !command || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const known = ["mint", "list", "revoke", "redeem", "balance", "grant", "spend", "history"];
  if (!known.includes(command)) fail(`unknown command ${command} (try --help)`);
  const db = await openDb(v.db ?? process.env.REDEEM_CREDITS_DB ?? "credits.sqlite");
  const credits = new Credits(sqliteStore(db, { prefix: v["table-prefix"] }));

  switch (command) {
    case "mint": {
      const m = await credits.mint({
        grant: grantFromFlags(),
        label: v.label,
        maxRedemptions: v.max ? number("max") : undefined,
        expiresAt: v.expires ? parseExpires(v.expires, Date.now()) : null,
        prefix: v.prefix,
        createdBy: v.by,
      });
      out(m, `${m.code}\n  id ${m.id}  ${describe(m.grant)}  max ${m.maxRedemptions}  expires ${iso(m.expiresAt)}\n  (shown once: only its hash is stored)`);
      return;
    }
    case "list": {
      const rows = await credits.list();
      const text = rows.length
        ? rows
            .map(
              (c) =>
                `${c.id}  ${c.redemptions}/${c.maxRedemptions}  ${describe(c.grant)}  ${c.label}` +
                `${c.revokedAt != null ? "  REVOKED" : c.expiresAt != null && c.expiresAt <= Date.now() ? "  EXPIRED" : ""}`,
            )
            .join("\n")
        : "(no codes)";
      out(rows, text);
      return;
    }
    case "revoke": {
      if (!arg) fail("usage: revoke <codeId>");
      try {
        await credits.revoke(arg);
      } catch (err) {
        fail((err as Error).message, 1);
      }
      out({ ok: true, id: arg }, `revoked ${arg}`);
      return;
    }
    case "redeem": {
      if (!arg) fail("usage: redeem <code> --user ID");
      const r = await credits.redeem(arg, need("user"));
      out(r, r.ok ? `ok: ${describe(r.grant)} (code ${r.codeId})` : `refused: ${r.reason}`);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "balance": {
      const user = need("user");
      const unit = need("unit");
      const balance = await credits.balance(user, unit);
      out({ user, unit, balance }, `${balance} ${unit}`);
      return;
    }
    case "grant": {
      const user = need("user");
      const g = grantFromFlags();
      await credits.grant(user, g, v.source);
      out({ ok: true, user, grant: g }, `granted ${describe(g)} to ${user}`);
      return;
    }
    case "spend": {
      const user = need("user");
      const unit = need("unit");
      const r = await credits.spend(user, unit, number("amount"), v.note);
      out({ ...r, user, unit }, r.ok ? `ok, ${r.balance} ${unit} left` : `insufficient: ${r.balance} ${unit} available`);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "history": {
      const rows = await credits.history(need("user"), v.unit);
      out(rows, rows.length ? rows.map((h) => `${iso(h.at)}  ${h.kind === "spend" ? "-" : "+"}${h.amount} ${h.unit}  ${h.source}`).join("\n") : "(no history)");
      return;
    }
  }
}

main().catch((err) => fail((err as Error).message ?? String(err), 1));
