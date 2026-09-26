-- =============================================================================
-- SchemaForge v2.0 — Shadow / Sandbox Database Init Script
-- Target DB : schemaforge_shadow
-- Owner      : sf_shadow
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. E-commerce schema tables  (mirrors production exactly)
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
-- 2. Useful indexes  (mirrors production exactly)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_users_email        ON users (email);
CREATE INDEX IF NOT EXISTS idx_products_category   ON products (category);
CREATE INDEX IF NOT EXISTS idx_orders_user_id      ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders (status);
CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);

COMMIT;
