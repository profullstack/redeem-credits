// Regenerates migrations/supabase.sql from supabaseMigrationSql() (default prefix).
import { writeFileSync, mkdirSync } from "node:fs";
import { supabaseMigrationSql } from "../src/index.ts";

mkdirSync(new URL("../migrations/", import.meta.url), { recursive: true });
writeFileSync(new URL("../migrations/supabase.sql", import.meta.url), supabaseMigrationSql());
