#!/usr/bin/env bash
# ============================================================================
# SchemaForge v2.0 — Shadow Database Validation Script
# Drops and recreates the shadow database, seeds schema + data + edge cases,
# then prints row counts for verification.
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (override via environment)
# ---------------------------------------------------------------------------
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5434}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-schemaforge_shadow}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ---------------------------------------------------------------------------
# Step 1 — Drop and recreate the shadow database
# ---------------------------------------------------------------------------
info "Dropping database '${PGDATABASE}' if it exists..."
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${PGDATABASE}';" \
    > /dev/null 2>&1 || true

psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
    -c "DROP DATABASE IF EXISTS ${PGDATABASE};" \
    > /dev/null 2>&1

psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
    -c "CREATE DATABASE ${PGDATABASE};" \
    > /dev/null 2>&1

ok "Database '${PGDATABASE}' created."

# ---------------------------------------------------------------------------
# Step 2 — Run seed files in order
# ---------------------------------------------------------------------------
SEED_FILES=(
    "${SCRIPT_DIR}/seed-schema.sql"
    "${SCRIPT_DIR}/seed-data.sql"
    "${SCRIPT_DIR}/seed-edge-cases.sql"
)

for sql_file in "${SEED_FILES[@]}"; do
    if [[ ! -f "$sql_file" ]]; then
        fail "Seed file not found: ${sql_file}"
    fi
    info "Running $(basename "$sql_file")..."
    psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
        -v ON_ERROR_STOP=1 \
        -f "$sql_file" \
        > /dev/null 2>&1
    ok "$(basename "$sql_file") applied."
done

# ---------------------------------------------------------------------------
# Step 3 — Print row counts for each table
# ---------------------------------------------------------------------------
echo ""
info "Row counts for '${PGDATABASE}':"
echo "  ─────────────────────────────────────"

for table in users products orders order_items; do
    count=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
        -t -A -c "SELECT COUNT(*) FROM ${table};")
    printf "  %-15s %s rows\n" "${table}" "${count}"
done

echo "  ─────────────────────────────────────"

# ---------------------------------------------------------------------------
# Step 4 — Quick edge-case verification
# ---------------------------------------------------------------------------
echo ""
info "Edge-case verification:"

null_emails=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -t -A -c "SELECT COUNT(*) FROM users WHERE email IS NULL;")
echo "  NULL emails:        ${null_emails}  (expected: 14)"

dup_emails=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -t -A -c "SELECT COUNT(*) FROM users WHERE email = 'duplicate@example.com';")
echo "  Duplicate emails:   ${dup_emails}  (expected: 3)"

null_fk_orders=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -t -A -c "SELECT COUNT(*) FROM orders WHERE user_id IS NULL;")
echo "  NULL FK orders:     ${null_fk_orders}  (expected: 1)"

boundary_orders=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -t -A -c "SELECT COUNT(*) FROM orders WHERE user_id >= 498;")
echo "  Boundary FK orders: ${boundary_orders}  (expected: 3)"

zero_qty=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -t -A -c "SELECT COUNT(*) FROM order_items WHERE quantity = 0;")
echo "  Zero-qty items:     ${zero_qty}  (expected: 1)"

echo ""
ok "Shadow database validation complete."
