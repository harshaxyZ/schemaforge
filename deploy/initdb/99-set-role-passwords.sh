#!/bin/sh
# Replaces the demo passwords from docker/init-prod.sql with the values from deploy/.env.
# Runs once, when the production volume is first initialised.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v reader_pw="$SF_READER_DB_PASSWORD" -v executor_pw="$SF_EXECUTOR_DB_PASSWORD" <<'SQL'
ALTER ROLE sf_reader PASSWORD :'reader_pw';
ALTER ROLE sf_executor PASSWORD :'executor_pw';
SQL
