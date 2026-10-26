/**
 * @profullstack/redeem-credits
 *
 * Redeemable credit codes for every Profullstack site: mint a scarce code
 * ("CR-7K3M-QX9D-2F8H-W4TN"), hand it to someone, they redeem it for a grant
 * of credits (one-off or every calendar month), and the site spends against
 * the balance. Codes are stored only as sha256 hashes.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * every:'month' -> amount is granted each calendar month (UTC) from redemption,
 * for `months` months (null = forever); unused does not roll over.
 * every null/absent -> one-off amount, never expires.
 */
export type Grant = { unit: string; amount: number; every?: "month" | null; months?: number | null };

export type MintOptions = {
  grant: Grant;
  label?: string;
  /** default 1 */
  maxRedemptions?: number;
  /** epoch ms; null = never */
  expiresAt?: number | null;
  /** default 'CR' */
  prefix?: string;
  createdBy?: string;
};

export type MintedCode = {
  /** plaintext, shown once */
  code: string;
  id: string;
  label: string;
  grant: Grant;
  maxRedemptions: number;
  expiresAt: number | null;
  createdAt: number;
};

export type RedeemFailure = "invalid" | "expired" | "used_up" | "already_redeemed" | "revoked";

export type RedeemResult = { ok: true; grant: Grant; codeId: string } | { ok: false; reason: RedeemFailure };

export type CodeInfo = {
  id: string;
  label: string;
  grant: Grant;
  maxRedemptions: number;
  redemptions: number;
  expiresAt: number | null;
  createdAt: number;
  revokedAt: number | null;
};

export type HistoryEntry = { unit: string; amount: number; kind: "grant" | "spend"; source: string; at: number };

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/** A code as persisted: the plaintext never is, only its sha256 hex hash. */
export type CodeRecord = CodeInfo & { hash: string; createdBy: string | null };

/** One row of the append-only ledger. Monthly grants carry every/months. */
export type LedgerEntry = {
  userId: string;
  unit: string;
  amount: number;
  kind: "grant" | "spend";
  every: "month" | null;
  months: number | null;
  source: string;
  at: number;
};

export type StoreRedeemResult = { ok: true; code: CodeRecord } | { ok: false; reason: RedeemFailure };

/**
 * Persistence for codes (hashed), redemptions and the credit ledger.
 *
 * Concurrency contract:
 * - redeemCode must be atomic: it enforces maxRedemptions and one redemption
 *   per (code, user), increments the counter, records the redemption and
 *   appends the grant to the ledger, or does none of it.
 * - appendIfVersion is a compare-and-swap on a per-(user, unit) version
 *   counter: it appends the entry and bumps the version only if the version
 *   still equals `version`. Spends use it so two concurrent spends can never
 *   both pass the balance check.
 * - account must read the version BEFORE the entries.
 */
export interface CreditStore {
  insertCode(code: CodeRecord): Promise<void>;
  redeemCode(hash: string, userId: string, at: number): Promise<StoreRedeemResult>;
  listCodes(): Promise<CodeRecord[]>;
  /** false when no code has that id */
  revokeCode(id: string, at: number): Promise<boolean>;
  appendLedger(entry: LedgerEntry): Promise<void>;
  account(userId: string, unit: string): Promise<{ version: number; entries: LedgerEntry[] }>;
  appendIfVersion(entry: LedgerEntry, version: number): Promise<boolean>;
  history(userId: string, unit?: string): Promise<LedgerEntry[]>;
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BODY_LENGTH = 16; // 16 x 5 bits = 80 bits of entropy

function randomCrockford(n: number): string {
  const bytes = randomBytes(n);
  let out = "";
  // 256 is a multiple of 32, so masking keeps the distribution uniform.
  for (let i = 0; i < n; i++) out += CROCKFORD[bytes[i]! & 31];
  return out;
}

/**
 * Canonical form of a code as a person might type it: case, spaces, dashes and
 * any other punctuation are ignored, and in the 16-character random body the
 * Crockford look-alikes O -> 0 and I/L -> 1 are folded. Returns
 * "PREFIX-XXXX-XXXX-XXXX-XXXX" (or "XXXX-XXXX-XXXX-XXXX" with no prefix);
 * input shorter than a code body comes back compacted and uppercased.
 */
export function normalizeCode(input: string): string {
  const s = String(input ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (s.length < BODY_LENGTH) return s;
  const prefix = s.slice(0, s.length - BODY_LENGTH);
  const body = s
    .slice(-BODY_LENGTH)
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  const groups = [body.slice(0, 4), body.slice(4, 8), body.slice(8, 12), body.slice(12, 16)];
  return (prefix ? [prefix, ...groups] : groups).join("-");
}

/** sha256 hex of a normalized code: the only form a code is ever stored in. */
export function hashCode(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** Constant-time comparison of two hex hashes. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(String(a), "hex");
  const y = Buffer.from(String(b), "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Why a redemption is refused, or null if it may proceed. Shared by every store. */
export function rejectReason(code: CodeRecord | null | undefined, alreadyRedeemed: boolean, at: number): RedeemFailure | null {
  if (!code) return "invalid";
  if (code.revokedAt != null) return "revoked";
  if (code.expiresAt != null && at >= code.expiresAt) return "expired";
  if (alreadyRedeemed) return "already_redeemed";
  if (code.redemptions >= code.maxRedemptions) return "used_up";
  return null;
}

function grantEntry(code: CodeRecord, userId: string, at: number): LedgerEntry {
  return {
    userId,
    unit: code.grant.unit,
    amount: code.grant.amount,
    kind: "grant",
    every: code.grant.every ?? null,
    months: code.grant.months ?? null,
    source: `code:${code.id}`,
    at,
  };
}

function normalizeGrant(g: Grant): { unit: string; amount: number; every: "month" | null; months: number | null } {
  if (!g || typeof g !== "object") throw new TypeError("grant is required");
  const unit = typeof g.unit === "string" ? g.unit.trim() : "";
  if (!unit || unit.length > 64) throw new TypeError("grant.unit must be a non-empty string (max 64 chars)");
  if (typeof g.amount !== "number" || !Number.isFinite(g.amount) || g.amount <= 0) {
    throw new TypeError("grant.amount must be a positive number");
  }
  const every = g.every ?? null;
  if (every !== null && every !== "month") throw new TypeError("grant.every must be 'month' or null");
  const months = g.months ?? null;
  if (months !== null) {
    if (every === null) throw new TypeError("grant.months only applies to every: 'month'");
    if (!Number.isInteger(months) || months < 1) throw new TypeError("grant.months must be a positive integer or null");
  }
  return { unit, amount: g.amount, every, months };
}

// ---------------------------------------------------------------------------
// Monthly math (UTC calendar months)
// ---------------------------------------------------------------------------

/** Months since year 0, UTC: Oct 2026 and Nov 2026 differ by exactly 1. */
export function monthIndex(ms: number): number {
  const d = new Date(ms);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

function allowanceIn(recurring: LedgerEntry[], month: number): number {
  let total = 0;
  for (const g of recurring) {
    const start = monthIndex(g.at);
    if (month >= start && (g.months == null || month < start + g.months)) total += g.amount;
  }
  return total;
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

/**
 * Available balance at `now` from one unit's ledger entries:
 * this month's recurring allowance minus this month's spends (floored at 0),
 * plus one-off grants minus whatever any month's spends overflowed into them.
 */
export function computeBalance(entries: LedgerEntry[], now: number): number {
  const current = monthIndex(now);
  const recurring: LedgerEntry[] = [];
  let oneOff = 0;
  const spentByMonth = new Map<number, number>();
  for (const e of entries) {
    if (e.at > now) continue;
    if (e.kind === "grant") {
      if (e.every === "month") recurring.push(e);
      else oneOff += e.amount;
    } else {
      const m = monthIndex(e.at);
      spentByMonth.set(m, (spentByMonth.get(m) ?? 0) + e.amount);
    }
  }
  let overflow = 0;
  for (const [month, spent] of spentByMonth) overflow += Math.max(0, spent - allowanceIn(recurring, month));
  const monthlyLeft = Math.max(0, allowanceIn(recurring, current) - (spentByMonth.get(current) ?? 0));
  return round(monthlyLeft + oneOff - overflow);
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

export class Credits {
  private store: CreditStore;
  private now: () => number;

  constructor(store: CreditStore, opts?: { now?: () => number }) {
    if (!store) throw new TypeError("a CreditStore is required");
    this.store = store;
    this.now = opts?.now ?? Date.now;
  }

  async mint(o: MintOptions): Promise<MintedCode> {
    const grant = normalizeGrant(o?.grant);
    const maxRedemptions = o.maxRedemptions ?? 1;
    if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) throw new TypeError("maxRedemptions must be a positive integer");
    const expiresAt = o.expiresAt ?? null;
    if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new TypeError("expiresAt must be epoch ms or null");
    const prefix = (o.prefix ?? "CR").toUpperCase();
    if (!/^[A-Z0-9]{0,12}$/.test(prefix)) throw new TypeError("prefix must be 0-12 letters/digits");
    const code = normalizeCode(prefix + randomCrockford(BODY_LENGTH));
    const createdAt = this.now();
    const label = o.label ?? `${grant.amount} ${grant.unit}${grant.every === "month" ? "/month" : ""}`;
    const id = "crd_" + randomCrockford(12).toLowerCase();
    await this.store.insertCode({
      id,
      hash: hashCode(code),
      label,
      grant,
      maxRedemptions,
      redemptions: 0,
      expiresAt,
      createdAt,
      revokedAt: null,
      createdBy: o.createdBy ?? null,
    });
    return { code, id, label, grant: { ...grant }, maxRedemptions, expiresAt, createdAt };
  }

  async redeem(code: string, userId: string): Promise<RedeemResult> {
    requireUser(userId);
    const normalized = normalizeCode(code);
    if (normalized.replace(/-/g, "").length < BODY_LENGTH) return { ok: false, reason: "invalid" };
    const r = await this.store.redeemCode(hashCode(normalized), userId, this.now());
    if (!r.ok) return r;
    return { ok: true, grant: { ...r.code.grant }, codeId: r.code.id };
  }

  async balance(userId: string, unit: string): Promise<number> {
    requireUser(userId);
    const { entries } = await this.store.account(userId, unit);
    return computeBalance(entries, this.now());
  }

  async spend(userId: string, unit: string, amount: number, note?: string): Promise<{ ok: boolean; balance: number }> {
    requireUser(userId);
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) throw new TypeError("amount must be a positive number");
    for (let attempt = 0; attempt < 50; attempt++) {
      const at = this.now();
      const { version, entries } = await this.store.account(userId, unit);
      const balance = computeBalance(entries, at);
      if (amount > balance + 1e-9) return { ok: false, balance };
      const entry: LedgerEntry = { userId, unit, amount, kind: "spend", every: null, months: null, source: note ?? "spend", at };
      if (await this.store.appendIfVersion(entry, version)) return { ok: true, balance: round(balance - amount) };
    }
    throw new Error("spend: too much contention on this account, try again");
  }

  async grant(userId: string, g: Grant, source?: string): Promise<void> {
    requireUser(userId);
    const grant = normalizeGrant(g);
    await this.store.appendLedger({
      userId,
      unit: grant.unit,
      amount: grant.amount,
      kind: "grant",
      every: grant.every,
      months: grant.months,
      source: source ?? "admin",
      at: this.now(),
    });
  }

  async list(): Promise<CodeInfo[]> {
    const rows = await this.store.listCodes();
    return rows.map((c) => ({
      id: c.id,
      label: c.label,
      grant: { ...c.grant },
      maxRedemptions: c.maxRedemptions,
      redemptions: c.redemptions,
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
      revokedAt: c.revokedAt,
    }));
  }

  /** Idempotent; throws only for an id that was never minted. */
  async revoke(codeId: string): Promise<void> {
    const found = await this.store.revokeCode(codeId, this.now());
    if (!found) throw new Error(`unknown code id: ${codeId}`);
  }

  async history(userId: string, unit?: string): Promise<HistoryEntry[]> {
    const rows = await this.store.history(userId, unit);
    return rows.map((e) => ({ unit: e.unit, amount: e.amount, kind: e.kind, source: e.source, at: e.at }));
  }
}

function requireUser(userId: string): void {
  if (typeof userId !== "string" || !userId) throw new TypeError("userId must be a non-empty string");
}

// ---------------------------------------------------------------------------
// Memory store
// ---------------------------------------------------------------------------

export function memoryStore(): CreditStore {
  const byHash = new Map<string, CodeRecord>();
  const byId = new Map<string, CodeRecord>();
  const redeemed = new Set<string>();
  const ledger: LedgerEntry[] = [];
  const versions = new Map<string, number>();
  const key = (a: string, b: string) => `${a}\u0000${b}`;
  const clone = (c: CodeRecord): CodeRecord => ({ ...c, grant: { ...c.grant } });

  // Every method body below runs synchronously, so each one is atomic.
  return {
    async insertCode(code) {
      if (byHash.has(code.hash) || byId.has(code.id)) throw new Error("duplicate code");
      const c = clone(code);
      byHash.set(c.hash, c);
      byId.set(c.id, c);
    },
    async redeemCode(hash, userId, at) {
      const found = byHash.get(hash);
      const code = found && sameHash(found.hash, hash) ? found : null;
      const reason = rejectReason(code, code ? redeemed.has(key(code.id, userId)) : false, at);
      if (reason || !code) return { ok: false, reason: reason ?? "invalid" };
      code.redemptions += 1;
      redeemed.add(key(code.id, userId));
      ledger.push(grantEntry(code, userId, at));
      return { ok: true, code: clone(code) };
    },
    async listCodes() {
      return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).map(clone);
    },
    async revokeCode(id, at) {
      const c = byId.get(id);
      if (!c) return false;
      if (c.revokedAt == null) c.revokedAt = at;
      return true;
    },
    async appendLedger(entry) {
      ledger.push({ ...entry });
    },
    async account(userId, unit) {
      const version = versions.get(key(userId, unit)) ?? 0;
      return { version, entries: ledger.filter((e) => e.userId === userId && e.unit === unit).map((e) => ({ ...e })) };
    },
    async appendIfVersion(entry, version) {
      const k = key(entry.userId, entry.unit);
      if ((versions.get(k) ?? 0) !== version) return false;
      versions.set(k, version + 1);
      ledger.push({ ...entry });
      return true;
    },
    async history(userId, unit) {
      return ledger.filter((e) => e.userId === userId && (unit === undefined || e.unit === unit)).map((e) => ({ ...e }));
    },
  };
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

function tablePrefix(prefix: string | undefined): string {
  const p = prefix ?? "credit_";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(p)) throw new TypeError("table prefix must match /^[A-Za-z_][A-Za-z0-9_]*$/");
  return p;
}

function num(v: unknown): number {
  return Number(v);
}

function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function rowToCode(r: Record<string, unknown>): CodeRecord {
  return {
    id: String(r.id),
    hash: String(r.hash),
    label: String(r.label ?? ""),
    grant: { unit: String(r.unit), amount: num(r.amount), every: r.recur === "month" ? "month" : null, months: numOrNull(r.months) },
    maxRedemptions: num(r.max_redemptions),
    redemptions: num(r.redemptions),
    expiresAt: numOrNull(r.expires_at),
    createdAt: num(r.created_at),
    revokedAt: numOrNull(r.revoked_at),
    createdBy: r.created_by == null ? null : String(r.created_by),
  };
}

function rowToEntry(r: Record<string, unknown>): LedgerEntry {
  return {
    userId: String(r.user_id),
    unit: String(r.unit),
    amount: num(r.amount),
    kind: r.kind === "spend" ? "spend" : "grant",
    every: r.recur === "month" ? "month" : null,
    months: numOrNull(r.months),
    source: String(r.source ?? ""),
    at: num(r.at),
  };
}

/** DDL for the four tables. Exported so apps can put it in their own migrations. */
export function schemaSql(dialect: "sqlite" | "pg", prefix = "credit_"): string[] {
  const p = tablePrefix(prefix);
  const big = dialect === "pg" ? "BIGINT" : "INTEGER";
  const real = dialect === "pg" ? "DOUBLE PRECISION" : "REAL";
  const serial = dialect === "pg" ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  return [
    `CREATE TABLE IF NOT EXISTS ${p}codes (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount ${real} NOT NULL,
  recur TEXT,
  months INTEGER,
  max_redemptions INTEGER NOT NULL,
  redemptions INTEGER NOT NULL DEFAULT 0,
  expires_at ${big},
  created_at ${big} NOT NULL,
  revoked_at ${big},
  created_by TEXT
)`,
    `CREATE TABLE IF NOT EXISTS ${p}redemptions (
  code_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at ${big} NOT NULL,
  PRIMARY KEY (code_id, user_id)
)`,
    `CREATE TABLE IF NOT EXISTS ${p}ledger (
  id ${serial},
  user_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount ${real} NOT NULL,
  kind TEXT NOT NULL,
  recur TEXT,
  months INTEGER,
  source TEXT NOT NULL,
  at ${big} NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS ${p}ledger_user_unit ON ${p}ledger (user_id, unit, at)`,
    `CREATE TABLE IF NOT EXISTS ${p}accounts (
  user_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, unit)
)`,
  ];
}

// ---------------------------------------------------------------------------
// SQLite store (bun:sqlite, node:sqlite, better-sqlite3)
// ---------------------------------------------------------------------------

export type SqliteStatement = {
  get(...p: unknown[]): unknown;
  all(...p: unknown[]): unknown[];
  run(...p: unknown[]): unknown;
};

/**
 * bun:sqlite's Database matches the `query` shape; node:sqlite's DatabaseSync
 * and better-sqlite3's Database match the `prepare` shape. Either works.
 */
export type SqliteLike =
  | { exec(sql: string): void; query(sql: string): SqliteStatement }
  | { exec(sql: string): void; prepare(sql: string): SqliteStatement };

export function sqliteStore(db: SqliteLike, opts?: { prefix?: string }): CreditStore {
  const p = tablePrefix(opts?.prefix);
  const anyDb = db as { query?: (sql: string) => SqliteStatement; prepare?: (sql: string) => SqliteStatement };
  const compile =
    typeof anyDb.query === "function"
      ? anyDb.query.bind(db)
      : typeof anyDb.prepare === "function"
        ? anyDb.prepare.bind(db)
        : null;
  if (!compile) throw new TypeError("sqliteStore needs a database with query() (bun:sqlite) or prepare() (node:sqlite, better-sqlite3)");
  const cache = new Map<string, SqliteStatement>();
  const stmt = (sql: string): SqliteStatement => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = compile(sql)));
    return s;
  };
  const get = (sql: string, ...params: unknown[]) => (stmt(sql).get(...params) ?? null) as Record<string, unknown> | null;
  const all = (sql: string, ...params: unknown[]) => stmt(sql).all(...params) as Record<string, unknown>[];
  // changes() works the same on every driver, unlike run()'s return value.
  const run = (sql: string, ...params: unknown[]): number => {
    stmt(sql).run(...params);
    return num(get("SELECT changes() AS n")?.n ?? 0);
  };
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  };

  for (const sql of schemaSql("sqlite", p)) db.exec(sql);

  const insertLedger = (e: LedgerEntry) =>
    run(
      `INSERT INTO ${p}ledger (user_id, unit, amount, kind, recur, months, source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      e.userId,
      e.unit,
      e.amount,
      e.kind,
      e.every ?? null,
      e.months ?? null,
      e.source,
      e.at,
    );

  return {
    async insertCode(c) {
      run(
        `INSERT INTO ${p}codes (id, hash, label, unit, amount, recur, months, max_redemptions, redemptions, expires_at, created_at, revoked_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id,
        c.hash,
        c.label,
        c.grant.unit,
        c.grant.amount,
        c.grant.every ?? null,
        c.grant.months ?? null,
        c.maxRedemptions,
        c.redemptions,
        c.expiresAt ?? null,
        c.createdAt,
        c.revokedAt ?? null,
        c.createdBy ?? null,
      );
    },
    async redeemCode(hash, userId, at) {
      return tx((): StoreRedeemResult => {
        const row = get(`SELECT * FROM ${p}codes WHERE hash = ?`, hash);
        const code = row && sameHash(String(row.hash), hash) ? rowToCode(row) : null;
        const already = code ? !!get(`SELECT 1 AS x FROM ${p}redemptions WHERE code_id = ? AND user_id = ?`, code.id, userId) : false;
        const reason = rejectReason(code, already, at);
        if (reason || !code) return { ok: false, reason: reason ?? "invalid" };
        const n = run(`UPDATE ${p}codes SET redemptions = redemptions + 1 WHERE id = ? AND redemptions < max_redemptions`, code.id);
        if (n !== 1) return { ok: false, reason: "used_up" };
        run(`INSERT INTO ${p}redemptions (code_id, user_id, at) VALUES (?, ?, ?)`, code.id, userId, at);
        insertLedger(grantEntry(code, userId, at));
        return { ok: true, code: { ...code, redemptions: code.redemptions + 1 } };
      });
    },
    async listCodes() {
      return all(`SELECT * FROM ${p}codes ORDER BY created_at DESC, id`).map(rowToCode);
    },
    async revokeCode(id, at) {
      return tx(() => {
        if (!get(`SELECT 1 AS x FROM ${p}codes WHERE id = ?`, id)) return false;
        run(`UPDATE ${p}codes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, at, id);
        return true;
      });
    },
    async appendLedger(e) {
      insertLedger(e);
    },
    async account(userId, unit) {
      // Version first, then entries (see CreditStore).
      const version = num(get(`SELECT version FROM ${p}accounts WHERE user_id = ? AND unit = ?`, userId, unit)?.version ?? 0);
      const entries = all(`SELECT * FROM ${p}ledger WHERE user_id = ? AND unit = ? ORDER BY at, id`, userId, unit).map(rowToEntry);
      return { version, entries };
    },
    async appendIfVersion(e, version) {
      return tx(() => {
        run(`INSERT OR IGNORE INTO ${p}accounts (user_id, unit, version) VALUES (?, ?, 0)`, e.userId, e.unit);
        const n = run(`UPDATE ${p}accounts SET version = version + 1 WHERE user_id = ? AND unit = ? AND version = ?`, e.userId, e.unit, version);
        if (n !== 1) return false;
        insertLedger(e);
        return true;
      });
    },
    async history(userId, unit) {
      const rows =
        unit === undefined
          ? all(`SELECT * FROM ${p}ledger WHERE user_id = ? ORDER BY at, id`, userId)
          : all(`SELECT * FROM ${p}ledger WHERE user_id = ? AND unit = ? ORDER BY at, id`, userId, unit);
      return rows.map(rowToEntry);
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres store (pg Pool, PGlite, anything with query(sql, params) -> { rows })
// ---------------------------------------------------------------------------

export type PgLike = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

/**
 * Works against a pool: every statement is independently atomic, so nothing
 * relies on two statements sharing a connection or a transaction.
 */
export function postgresStore(pool: PgLike, opts?: { prefix?: string }): CreditStore {
  const p = tablePrefix(opts?.prefix);
  let ready: Promise<void> | null = null;
  const init = () =>
    (ready ??= (async () => {
      for (const sql of schemaSql("pg", p)) {
        try {
          await pool.query(sql);
        } catch (err) {
          // Two processes racing CREATE ... IF NOT EXISTS can collide in the catalog.
          const code = (err as { code?: string }).code;
          if (code !== "23505" && code !== "42P07") throw err;
        }
      }
    })().catch((err) => {
      ready = null;
      throw err;
    }));
  const q = async (sql: string, params: unknown[] = []) => {
    await init();
    return (await pool.query(sql, params)).rows as Record<string, unknown>[];
  };
  const ledgerCols = `user_id, unit, amount, kind, recur, months, source, at`;
  const ledgerParams = (e: LedgerEntry) => [e.userId, e.unit, e.amount, e.kind, e.every ?? null, e.months ?? null, e.source, e.at];

  const diagnose = async (hash: string, userId: string, at: number): Promise<StoreRedeemResult> => {
    const row = (await q(`SELECT * FROM ${p}codes WHERE hash = $1`, [hash]))[0];
    const code = row && sameHash(String(row.hash), hash) ? rowToCode(row) : null;
    const already = code ? (await q(`SELECT 1 AS x FROM ${p}redemptions WHERE code_id = $1 AND user_id = $2`, [code.id, userId])).length > 0 : false;
    return { ok: false, reason: rejectReason(code, already, at) ?? "used_up" };
  };

  return {
    async insertCode(c) {
      await q(
        `INSERT INTO ${p}codes (id, hash, label, unit, amount, recur, months, max_redemptions, redemptions, expires_at, created_at, revoked_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [c.id, c.hash, c.label, c.grant.unit, c.grant.amount, c.grant.every ?? null, c.grant.months ?? null, c.maxRedemptions, c.redemptions, c.expiresAt ?? null, c.createdAt, c.revokedAt ?? null, c.createdBy ?? null],
      );
    },
    async redeemCode(hash, userId, at) {
      // 1. Claim a slot. This single UPDATE ... WHERE redemptions < max is the
      //    serialization point for maxRedemptions: concurrent claimers queue on
      //    the row lock and re-check the predicate against the committed row.
      const row = (
        await q(
          `UPDATE ${p}codes SET redemptions = redemptions + 1
           WHERE hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)
             AND redemptions < max_redemptions
             AND NOT EXISTS (SELECT 1 FROM ${p}redemptions r WHERE r.code_id = ${p}codes.id AND r.user_id = $3)
           RETURNING *`,
          [hash, at, userId],
        )
      )[0];
      if (!row || !sameHash(String(row.hash), hash)) return diagnose(hash, userId, at);
      const code = rowToCode(row);
      // 2. Record the redemption and the grant in one statement; the primary
      //    key on (code_id, user_id) settles a same-user race.
      const e = grantEntry(code, userId, at);
      const inserted = await q(
        `WITH r AS (
           INSERT INTO ${p}redemptions (code_id, user_id, at) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING code_id
         )
         INSERT INTO ${p}ledger (${ledgerCols})
         SELECT $2::text, $4::text, $5::double precision, 'grant', $6::text, $7::integer, $8::text, $3::bigint FROM r RETURNING id`,
        [code.id, userId, at, e.unit, e.amount, e.every, e.months, e.source],
      );
      if (inserted.length === 0) {
        // Lost a same-user race: give the slot back.
        await q(`UPDATE ${p}codes SET redemptions = redemptions - 1 WHERE id = $1`, [code.id]);
        return { ok: false, reason: "already_redeemed" };
      }
      return { ok: true, code };
    },
    async listCodes() {
      return (await q(`SELECT * FROM ${p}codes ORDER BY created_at DESC, id`)).map(rowToCode);
    },
    async revokeCode(id, at) {
      const rows = await q(`UPDATE ${p}codes SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1 RETURNING id`, [id, at]);
      return rows.length > 0;
    },
    async appendLedger(e) {
      await q(`INSERT INTO ${p}ledger (${ledgerCols}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, ledgerParams(e));
    },
    async account(userId, unit) {
      // Version first, then entries (see CreditStore).
      const v = await q(`SELECT version FROM ${p}accounts WHERE user_id = $1 AND unit = $2`, [userId, unit]);
      const entries = await q(`SELECT * FROM ${p}ledger WHERE user_id = $1 AND unit = $2 ORDER BY at, id`, [userId, unit]);
      return { version: num(v[0]?.version ?? 0), entries: entries.map(rowToEntry) };
    },
    async appendIfVersion(e, version) {
      await q(`INSERT INTO ${p}accounts (user_id, unit, version) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`, [e.userId, e.unit]);
      // A concurrent spender waits on the UPDATE's row lock, then re-checks
      // version = $9 against the committed row, matches nothing and retries.
      const rows = await q(
        `WITH u AS (
           UPDATE ${p}accounts SET version = version + 1 WHERE user_id = $1 AND unit = $2 AND version = $9 RETURNING 1
         )
         INSERT INTO ${p}ledger (${ledgerCols})
         SELECT $1::text, $2::text, $3::double precision, $4::text, $5::text, $6::integer, $7::text, $8::bigint FROM u RETURNING id`,
        [...ledgerParams(e), version],
      );
      return rows.length > 0;
    },
    async history(userId, unit) {
      const rows =
        unit === undefined
          ? await q(`SELECT * FROM ${p}ledger WHERE user_id = $1 ORDER BY at, id`, [userId])
          : await q(`SELECT * FROM ${p}ledger WHERE user_id = $1 AND unit = $2 ORDER BY at, id`, [userId, unit]);
      return rows.map(rowToEntry);
    },
  };
}
