#!/usr/bin/env bash
# Explicitly reset the disposable local shadow database.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5434}"
export PGUSER="${PGUSER:-sf_shadow}"
export PGPASSWORD="${PGPASSWORD:-sf_shadow_pass}"
export PGDATABASE="${PGDATABASE:-schemaforge_shadow}"
export SCHEMAFORGE_CONFIRM_RESET="${SCHEMAFORGE_CONFIRM_RESET:-}"

if [[ "${SCHEMAFORGE_CONFIRM_RESET}" != "YES" ]]; then
  echo "Refusing destructive shadow reset. Re-run with SCHEMAFORGE_CONFIRM_RESET=YES." >&2
  exit 2
fi

printf 'SchemaForge shadow reset: %s@%s:%s/%s\n' "$PGUSER" "$PGHOST" "$PGPORT" "$PGDATABASE"
exec "${SCRIPT_DIR}/validate-migration.sh"
