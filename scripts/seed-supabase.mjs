import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const connectionString = process.env.SF_PROD_WRITE_URL || process.env.SF_PROD_READONLY_URL;
console.log('Connecting to Supabase...');
const client = new pg.Client({ connectionString });
await client.connect();

console.log('Connected! Creating tables...');
await client.query(`
  DROP TABLE IF EXISTS order_items CASCADE;
  DROP TABLE IF EXISTS orders CASCADE;
  DROP TABLE IF EXISTS products CASCADE;
  DROP TABLE IF EXISTS users CASCADE;
  DROP TABLE IF EXISTS schemaforge_execution_ledger CASCADE;

  CREATE TABLE users (
    id         SERIAL PRIMARY KEY,
    email      VARCHAR(255),
    name       VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

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
`);

console.log('Tables created. Seeding data...');
await client.query(`
  SELECT setseed(0.42);

  INSERT INTO users (email, name, created_at, updated_at)
  SELECT
      LOWER(first_names[(i % 40) + 1]) || '.' ||
      LOWER(last_names[((i * 7) % 30) + 1]) ||
      i::TEXT || '@' ||
      (ARRAY['gmail.com','outlook.com','yahoo.com','proton.me','fastmail.com','company.io'])[(i % 6) + 1],
      first_names[(i % 40) + 1] || ' ' || last_names[((i * 7) % 30) + 1],
      TIMESTAMPTZ '2024-01-01 00:00:00+00' + (i * INTERVAL '1 day' * 1.46),
      TIMESTAMPTZ '2024-01-01 00:00:00+00' + (i * INTERVAL '1 day' * 1.46) + ((i % 30) * INTERVAL '1 day')
  FROM generate_series(1, 500) AS s(i),
  LATERAL (SELECT ARRAY[
      'Alice','Bob','Carol','David','Eve','Frank','Grace','Hank',
      'Iris','Jack','Karen','Leo','Mona','Nate','Olivia','Paul',
      'Quinn','Rita','Sam','Tina','Uma','Vince','Wendy','Xander',
      'Yara','Zane','Aiden','Bella','Caleb','Diana','Ethan','Fiona',
      'George','Holly','Ivan','Julia','Kyle','Luna','Mason','Nora'
  ] AS first_names) fn,
  LATERAL (SELECT ARRAY[
      'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller',
      'Davis','Martinez','Anderson','Taylor','Thomas','Hernandez',
      'Moore','Martin','Jackson','Thompson','White','Lopez','Lee',
      'Clark','Lewis','Robinson','Walker','Young','Allen','King',
      'Wright','Scott','Hill'
  ] AS last_names) ln;

  INSERT INTO products (name, price, category, stock, created_at)
  SELECT
      product_prefix[((i - 1) % 20) + 1] || ' ' || product_suffix[((i * 3) % 15) + 1],
      ROUND((4.99 + (i * 9.95))::NUMERIC, 2),
      (ARRAY['Electronics','Clothing','Books','Home','Sports'])[((i - 1) % 5) + 1],
      (i * 5) % 501,
      TIMESTAMPTZ '2024-03-01 08:00:00+00' + (i * INTERVAL '3 days')
  FROM generate_series(1, 100) AS s(i),
  LATERAL (SELECT ARRAY[
      'Premium','Classic','Ultra','Nano','Pro',
      'Elite','Smart','Eco','Turbo','Flex',
      'Prime','Max','Core','Swift','Zen',
      'Nova','Arc','Apex','Vertex','Pulse'
  ] AS product_prefix) pp,
  LATERAL (SELECT ARRAY[
      'Widget','Gadget','Device','Module','Unit',
      'Kit','Pack','Set','Bundle','Gear',
      'Tool','System','Hub','Station','Dock'
  ] AS product_suffix) ps;

  INSERT INTO orders (user_id, total, status, created_at)
  SELECT
      ((i * 3) % 500) + 1,
      ROUND((10 + (i * 9.73))::NUMERIC, 2),
      CASE
          WHEN i % 20 < 8  THEN 'completed'
          WHEN i % 20 < 13 THEN 'pending'
          WHEN i % 20 < 17 THEN 'shipped'
          ELSE                   'cancelled'
      END,
      TIMESTAMPTZ '2024-06-01 12:00:00+00' + (i * INTERVAL '1 day' * 0.9)
  FROM generate_series(1, 200) AS s(i);

  INSERT INTO order_items (order_id, product_id, quantity, price)
  SELECT
      ((i - 1) % 200) + 1,
      ((i * 7) % 100) + 1,
      (i % 5) + 1,
      ROUND((9.99 + (i * 3.14))::NUMERIC, 2)
  FROM generate_series(1, 500) AS s(i);
`);

console.log('Applying realistic edge cases (14 NULL emails for rehearsal testing)...');
await client.query(`
  UPDATE users
  SET email = NULL, updated_at = TIMESTAMPTZ '2026-09-20 12:00:00+00'
  WHERE id IN (7, 23, 42, 58, 91, 104, 137, 189, 215, 256, 301, 348, 412, 467);
`);

const countUsers = await client.query('SELECT count(*) FROM users');
const countNulls = await client.query('SELECT count(*) FROM users WHERE email IS NULL');
const countProducts = await client.query('SELECT count(*) FROM products');
const countOrders = await client.query('SELECT count(*) FROM orders');
const countItems = await client.query('SELECT count(*) FROM order_items');

console.log('Seeding COMPLETE:');
console.log(`- Users: ${countUsers.rows[0].count} (including ${countNulls.rows[0].count} intentional NULL emails for pre-flight testing)`);
console.log(`- Products: ${countProducts.rows[0].count}`);
console.log(`- Orders: ${countOrders.rows[0].count}`);
console.log(`- Order Items: ${countItems.rows[0].count}`);

await client.end();
