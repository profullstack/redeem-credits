/**
 * A tiny PostgREST-free stand-in for supabase-js: maps the calls supabaseStore
 * makes (from().select().order().range(), from().insert(), rpc()) onto SQL
 * against any `query(sql, params) -> { rows }` (PGlite, pg Pool). rpc() uses
 * named-argument notation, as PostgREST does.
 */
import type { SupabaseLike, SupabaseError } from "../src/index.ts";

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
type Res = { data: any; error: SupabaseError | null };

const ident = (s: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`);
  return `"${s}"`;
};

async function run(query: Query, sql: string, params: unknown[]): Promise<{ rows: any[]; error: SupabaseError | null }> {
  try {
    return { rows: (await query(sql, params)).rows, error: null };
  } catch (err) {
    const e = err as { message?: string; code?: string };
    return { rows: [], error: { message: String(e.message ?? err), code: e.code } };
  }
}

export type FakeSupabase = SupabaseLike & { calls: { from: string[]; rpc: string[] } };

export function fakeSupabase(query: Query): FakeSupabase {
  const calls = { from: [] as string[], rpc: [] as string[] };
  return {
    calls,
    from(table: string) {
      calls.from.push(table);
      return {
        select(columns = "*") {
          const orders: string[] = [];
          let limit: [number, number] | null = null;
          const exec = async (): Promise<Res> => {
            const cols = columns === "*" ? "*" : columns.split(",").map((c) => ident(c.trim())).join(", ");
            let sql = `SELECT ${cols} FROM public.${ident(table)}`;
            if (orders.length) sql += ` ORDER BY ${orders.join(", ")}`;
            if (limit) sql += ` LIMIT ${limit[1] - limit[0] + 1} OFFSET ${limit[0]}`;
            const r = await run(query, sql, []);
            return { data: r.error ? null : r.rows, error: r.error };
          };
          const chain: any = {
            order(column: string, o?: { ascending?: boolean }) {
              orders.push(`${ident(column)} ${o?.ascending === false ? "DESC" : "ASC"}`);
              return chain;
            },
            range(from: number, to: number) {
              limit = [from, to];
              return chain;
            },
            then(ok: (v: Res) => unknown, bad?: (e: unknown) => unknown) {
              return exec().then(ok, bad);
            },
          };
          return chain;
        },
        insert(values: Record<string, unknown> | Record<string, unknown>[]) {
          const list = Array.isArray(values) ? values : [values];
          const exec = async (): Promise<Res> => {
            const cols = Object.keys(list[0]!);
            const params: unknown[] = [];
            const tuples = list.map((row) => `(${cols.map((c) => (params.push(row[c]), `$${params.length}`)).join(", ")})`);
            const r = await run(query, `INSERT INTO public.${ident(table)} (${cols.map(ident).join(", ")}) VALUES ${tuples.join(", ")}`, params);
            return { data: null, error: r.error };
          };
          return exec();
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown> = {}) {
      calls.rpc.push(fn);
      const exec = async (): Promise<Res> => {
        const names = Object.keys(args);
        const sql = `SELECT public.${ident(fn)}(${names.map((n, i) => `${ident(n)} => $${i + 1}`).join(", ")}) AS r`;
        const r = await run(query, sql, names.map((n) => args[n]));
        return { data: r.error ? null : r.rows[0]?.r ?? null, error: r.error };
      };
      return exec();
    },
  };
}
