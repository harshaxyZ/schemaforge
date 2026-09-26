-- ============================================================================
-- SchemaForge v2.0 — Shadow Database Schema (mirrors production)
-- E-commerce schema: users, products, orders, order_items
-- PostgreSQL 16 compatible
-- ============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- Drop existing tables in reverse dependency order
-- --------------------------------------------------------------------------
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders      CASCADE;
DROP TABLE IF EXISTS products    CASCADE;
DROP TABLE IF EXISTS users       CASCADE;

-- --------------------------------------------------------------------------
-- users
-- --------------------------------------------------------------------------
CREATE TABLE users (
    id         SERIAL        PRIMARY KEY,
    email      VARCHAR(255),
    name       VARCHAR(255),
    created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  users       IS 'Registered customers';
COMMENT ON COLUMN users.email IS 'Login email — currently nullable, migration target for NOT NULL';

-- --------------------------------------------------------------------------
-- products
-- --------------------------------------------------------------------------
CREATE TABLE products (
    id         SERIAL        PRIMARY KEY,
    name       VARCHAR(255)  NOT NULL,
    price      DECIMAL(10,2) NOT NULL,
    category   VARCHAR(100),
    stock      INTEGER       DEFAULT 0,
    created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE products IS 'Product catalogue';

-- --------------------------------------------------------------------------
-- orders
-- --------------------------------------------------------------------------
CREATE TABLE orders (
    id         SERIAL        PRIMARY KEY,
    user_id    INTEGER       REFERENCES users(id),
    total      DECIMAL(10,2),
    status     VARCHAR(50)   DEFAULT 'pending',
    created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE orders IS 'Customer orders';

-- --------------------------------------------------------------------------
-- order_items
-- --------------------------------------------------------------------------
CREATE TABLE order_items (
    id         SERIAL        PRIMARY KEY,
    order_id   INTEGER       REFERENCES orders(id),
    product_id INTEGER       REFERENCES products(id),
    quantity   INTEGER       NOT NULL,
    price      DECIMAL(10,2) NOT NULL
);

COMMENT ON TABLE order_items IS 'Line items within an order';

-- --------------------------------------------------------------------------
-- Indexes for common query patterns
-- --------------------------------------------------------------------------
CREATE INDEX idx_users_email          ON users       (email);
CREATE INDEX idx_products_category    ON products    (category);
CREATE INDEX idx_orders_user_id       ON orders      (user_id);
CREATE INDEX idx_orders_status        ON orders      (status);
CREATE INDEX idx_order_items_order_id ON order_items  (order_id);
CREATE INDEX idx_order_items_product  ON order_items  (product_id);

COMMIT;
