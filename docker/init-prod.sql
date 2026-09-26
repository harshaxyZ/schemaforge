-- =============================================================================
-- SchemaForge v2.0 — Production Database Init Script
-- Target DB : schemaforge_prod
-- Owner      : sf_admin
-- Read-only  : sf_reader
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. E-commerce schema tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id         SERIAL        PRIMARY KEY,
    email      VARCHAR(255)  NOT NULL UNIQUE,
    name       VARCHAR(255)  NOT NULL,
    created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
    id         SERIAL        PRIMARY KEY,
    name       VARCHAR(255)  NOT NULL,
    price      DECIMAL(10,2) NOT NULL CHECK (price >= 0),
    category   VARCHAR(100),
    stock      INTEGER       NOT NULL DEFAULT 0 CHECK (stock >= 0),
    created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
    id         SERIAL        PRIMARY KEY,
    user_id    INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    total      DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    status     VARCHAR(50)   NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
    id         SERIAL        PRIMARY KEY,
    order_id   INTEGER       NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER       NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity   INTEGER       NOT NULL CHECK (quantity > 0),
    price      DECIMAL(10,2) NOT NULL CHECK (price >= 0)
);

-- ---------------------------------------------------------------------------
-- 2. Useful indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_users_email        ON users (email);
CREATE INDEX IF NOT EXISTS idx_products_category   ON products (category);
CREATE INDEX IF NOT EXISTS idx_orders_user_id      ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders (status);
CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);

-- ---------------------------------------------------------------------------
-- 3. Read-only role
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sf_reader') THEN
        CREATE ROLE sf_reader LOGIN PASSWORD 'sf_reader_pass';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE schemaforge_prod TO sf_reader;
GRANT USAGE   ON SCHEMA public            TO sf_reader;
GRANT SELECT  ON ALL TABLES IN SCHEMA public TO sf_reader;

-- Ensure future tables also grant SELECT to sf_reader automatically
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sf_reader;

COMMIT;
