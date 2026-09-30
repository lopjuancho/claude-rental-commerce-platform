#!/usr/bin/env bash
# Prepare a disposable Postgres database for integration tests (ADR 0007).
#   TEST_DB_ADMIN_URL  superuser connection to an existing server (default: local postgres)
#   TEST_DB_NAME       database to (re)create (default: rental_commerce_test)
# With the Supabase CLI stack instead, run `supabase db reset` and point DATABASE_URL at it.
set -euo pipefail

ADMIN_URL="${TEST_DB_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}"
DB_NAME="${TEST_DB_NAME:-rental_commerce_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_URL="${ADMIN_URL%/*}/${DB_NAME}"
export PGOPTIONS="-c client_min_messages=warning"

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "drop database if exists ${DB_NAME} with (force);" -c "create database ${DB_NAME};"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "alter database ${DB_NAME} set search_path = \"\$user\", public, extensions;"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/shim/supabase_shim.sql"

for f in "$ROOT"/supabase/migrations/*.sql; do
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

if [[ "${WITH_SEED:-0}" == "1" ]]; then
  # One transaction, as the Supabase CLI applies it (the seed declares its organization gates once).
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q --single-transaction -f "$ROOT/supabase/seed.sql"
fi

echo "Test database ready: ${DB_URL}"
