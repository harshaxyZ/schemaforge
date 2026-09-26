-- SchemaForge shadow target: the same application schema and seed set as production.
-- Every rehearsal runs in a serialized transaction that is unconditionally rolled back.

BEGIN;

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

COMMIT;
