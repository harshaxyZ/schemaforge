#!/usr/bin/env bash
# Recreate and assert the deterministic local shadow demo state.
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5434}"
PGUSER="${PGUSER:-sf_shadow}"
PGDATABASE="${PGDATABASE:-schemaforge_shadow}"
export PGPASSWORD="${PGPASSWORD:-sf_shadow_pass}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SCHEMAFORGE_CONFIRM_RESET:-}" != "YES" ]]; then
  echo "Refusing destructive shadow reset. Set SCHEMAFORGE_CONFIRM_RESET=YES." >&2
  exit 2
fi
if [[ ! "$PGDATABASE" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  echo "Invalid PGDATABASE identifier." >&2
  exit 2
fi

info() { printf '[INFO] %s\n' "$*"; }
ok() { printf '[OK] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }
query_scalar() {
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -t -A -c "$1"
}
assert_eq() {
  local name="$1" actual="$2" expected="$3"
  [[ "$actual" == "$expected" ]] || fail "$name: expected $expected, observed $actual"
  ok "$name = $actual"
}

info "Terminating sessions and recreating ${PGDATABASE}"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${PGDATABASE}' AND pid <> pg_backend_pid();" >/dev/null
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"${PGDATABASE}\";" >/dev/null
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"${PGDATABASE}\";" >/dev/null

for sql_file in seed-schema.sql seed-data.sql seed-edge-cases.sql; do
  info "Applying ${sql_file}"
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -v ON_ERROR_STOP=1 -f "${SCRIPT_DIR}/${sql_file}" >/dev/null
 done

assert_eq "users" "$(query_scalar 'SELECT count(*) FROM users')" "500"
assert_eq "products" "$(query_scalar 'SELECT count(*) FROM products')" "102"
assert_eq "orders" "$(query_scalar 'SELECT count(*) FROM orders')" "204"
assert_eq "order_items" "$(query_scalar 'SELECT count(*) FROM order_items')" "401"
assert_eq "NULL emails" "$(query_scalar 'SELECT count(*) FROM users WHERE email IS NULL')" "14"
assert_eq "duplicate emails" "$(query_scalar "SELECT count(*) FROM users WHERE email = 'duplicate@example.com'")" "3"
assert_eq "NULL order users" "$(query_scalar 'SELECT count(*) FROM orders WHERE user_id IS NULL')" "1"
assert_eq "zero quantities" "$(query_scalar 'SELECT count(*) FROM order_items WHERE quantity = 0')" "1"

ok "Deterministic shadow database is ready."
