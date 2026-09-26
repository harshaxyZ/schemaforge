-- SchemaForge demo production target: intentionally imperfect data model.
-- The migration agent reaches this database through sf_reader and sf_executor.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sf_reader') THEN
    CREATE ROLE sf_reader LOGIN PASSWORD 'sf_reader_pass';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sf_executor') THEN
    CREATE ROLE sf_executor LOGIN PASSWORD 'sf_executor_pass';
  END IF;
END
$$;

CREATE TABLE users (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255),
  name       VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE users IS 'Registered customers';
COMMENT ON COLUMN users.email IS 'Intentionally nullable migration target for the hackathon demo';

CREATE TABLE products (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  price      DECIMAL(10,2) NOT NULL,
  category   VARCHAR(100),
  stock      INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE orders (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  total      DECIMAL(10,2),
  status     VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE order_items (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER REFERENCES orders(id),
  product_id INTEGER REFERENCES products(id),
  quantity   INTEGER NOT NULL,
  price      DECIMAL(10,2) NOT NULL
);

CREATE INDEX idx_users_email          ON users (email);
CREATE INDEX idx_products_category    ON products (category);
CREATE INDEX idx_orders_user_id       ON orders (user_id);
CREATE INDEX idx_orders_status        ON orders (status);
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
CREATE INDEX idx_order_items_product  ON order_items (product_id);

-- Durable replay/audit ledger. sf_executor can append/update but cannot own/drop it.
CREATE TABLE schemaforge_execution_ledger (
  nonce                  UUID PRIMARY KEY,
  rehearsal_id           TEXT NOT NULL,
  migration_hash         CHAR(64) NOT NULL,
  assertions_hash        CHAR(64) NOT NULL,
  baseline_fingerprint   CHAR(64) NOT NULL,
  expected_fingerprint   CHAR(64) NOT NULL,
  post_fingerprint       CHAR(64),
  action                 TEXT NOT NULL,
  approved_at            TIMESTAMPTZ NOT NULL,
  expires_at             TIMESTAMPTZ NOT NULL,
  executed_at            TIMESTAMPTZ,
  status                 TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  error                  TEXT
);

ALTER TABLE users OWNER TO sf_executor;
ALTER TABLE products OWNER TO sf_executor;
ALTER TABLE orders OWNER TO sf_executor;
ALTER TABLE order_items OWNER TO sf_executor;
ALTER SEQUENCE users_id_seq OWNER TO sf_executor;
ALTER SEQUENCE products_id_seq OWNER TO sf_executor;
ALTER SEQUENCE orders_id_seq OWNER TO sf_executor;
ALTER SEQUENCE order_items_id_seq OWNER TO sf_executor;

GRANT CONNECT ON DATABASE schemaforge_prod TO sf_reader, sf_executor;
GRANT USAGE ON SCHEMA public TO sf_reader, sf_executor;
GRANT CREATE ON SCHEMA public TO sf_executor;
GRANT SELECT ON users, products, orders, order_items TO sf_reader;
GRANT SELECT, INSERT ON schemaforge_execution_ledger TO sf_executor;
GRANT UPDATE (status, executed_at, post_fingerprint, error) ON schemaforge_execution_ledger TO sf_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, products, orders, order_items TO sf_executor;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sf_executor;
ALTER DEFAULT PRIVILEGES FOR ROLE sf_executor IN SCHEMA public GRANT SELECT ON TABLES TO sf_reader;

COMMIT;
