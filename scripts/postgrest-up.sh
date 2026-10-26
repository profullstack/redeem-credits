#!/usr/bin/env bash
# Starts a throwaway Postgres + PostgREST pair for test/postgrest.test.ts, with
# Supabase-like roles (anon, authenticated, service_role BYPASSRLS, authenticator)
# and the default-prefix migration applied. Prints the env to export.
set -euo pipefail
PG_PORT=${PG_PORT:-55433}
REST_PORT=${REST_PORT:-55434}
SECRET=${POSTGREST_JWT_SECRET:-redeem-credits-test-secret-at-least-32-chars}
NET=rc-e2e
docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f rc-e2e-pg rc-e2e-rest >/dev/null 2>&1 || true
docker run -d --rm --name rc-e2e-pg --network "$NET" -e POSTGRES_PASSWORD=pw -p 127.0.0.1:$PG_PORT:5432 postgres:17-alpine >/dev/null
for _ in $(seq 60); do docker exec rc-e2e-pg pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
sleep 1
docker exec -i rc-e2e-pg psql -v ON_ERROR_STOP=1 -q -U postgres <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator LOGIN PASSWORD 'pw' NOINHERIT;
GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Supabase's default privileges hand everything to anon/authenticated; the migration must take it back.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
SQL
docker exec -i rc-e2e-pg psql -v ON_ERROR_STOP=1 -q -U postgres < "$(dirname "$0")/../migrations/supabase.sql"
docker run -d --rm --name rc-e2e-rest --network "$NET" -p 127.0.0.1:$REST_PORT:3000 \
  -e PGRST_DB_URI=postgres://authenticator:pw@rc-e2e-pg:5432/postgres \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$SECRET" \
  postgrest/postgrest:v14.17 >/dev/null
for _ in $(seq 60); do curl -fs "http://127.0.0.1:$REST_PORT/" >/dev/null 2>&1 && break; sleep 1; done
echo "export POSTGREST_URL=http://127.0.0.1:$REST_PORT POSTGREST_JWT_SECRET=$SECRET TEST_PG_URL=postgres://postgres:pw@127.0.0.1:$PG_PORT/postgres"
