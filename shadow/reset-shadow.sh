#!/usr/bin/env bash
# ============================================================================
# SchemaForge v2.0 — Quick Shadow Database Reset
# Convenience wrapper: sets shadow DB connection defaults and delegates to
# validate-migration.sh for the full drop → seed → verify cycle.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Shadow DB connection defaults (override via environment if needed)
# ---------------------------------------------------------------------------
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5434}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
export PGDATABASE="${PGDATABASE:-schemaforge_shadow}"

echo "╔══════════════════════════════════════════════╗"
echo "║   SchemaForge v2.0 — Shadow DB Reset         ║"
echo "║   Host: ${PGHOST}:${PGPORT}                        ║"
echo "║   Database: ${PGDATABASE}            ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ---------------------------------------------------------------------------
# Delegate to the full validation script
# ---------------------------------------------------------------------------
if [[ ! -x "${SCRIPT_DIR}/validate-migration.sh" ]]; then
    chmod +x "${SCRIPT_DIR}/validate-migration.sh" 2>/dev/null || true
fi

exec "${SCRIPT_DIR}/validate-migration.sh"
