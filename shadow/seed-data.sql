-- ============================================================================
-- SchemaForge v2.0 — Shadow Database Seed Data
-- Deterministic bulk generation using generate_series + random()
-- PostgreSQL 16 compatible
-- ============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- Lock the RNG seed for full reproducibility across runs
-- --------------------------------------------------------------------------
SELECT setseed(0.42);

-- --------------------------------------------------------------------------
-- 500 users with realistic names and emails
-- --------------------------------------------------------------------------
-- First-name and last-name pools are rotated via modular arithmetic so every
-- combination is deterministic and plausible.
-- --------------------------------------------------------------------------
INSERT INTO users (email, name, created_at, updated_at)
SELECT
    -- email: first.last<n>@<domain>
    LOWER(first_names[(i % 40) + 1]) || '.' ||
    LOWER(last_names[((i * 7) % 30) + 1]) ||
    i::TEXT || '@' ||
    (ARRAY['gmail.com','outlook.com','yahoo.com','proton.me','fastmail.com','company.io'])[(i % 6) + 1],

    -- display name
    first_names[(i % 40) + 1] || ' ' || last_names[((i * 7) % 30) + 1],

    -- created_at: spread across the past 2 years
    TIMESTAMPTZ '2024-01-01 00:00:00+00' + (i * INTERVAL '1 day' * 1.46),

    -- updated_at: created_at + 0–30 days
    TIMESTAMPTZ '2024-01-01 00:00:00+00' + (i * INTERVAL '1 day' * 1.46)
        + ((i % 30) * INTERVAL '1 day')

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

-- --------------------------------------------------------------------------
-- 100 products across 5 categories
-- --------------------------------------------------------------------------
INSERT INTO products (name, price, category, stock, created_at)
SELECT
    product_prefix[((i - 1) % 20) + 1] || ' ' || product_suffix[((i * 3) % 15) + 1],
    -- price: $4.99 – $999.99, deterministic from i
    ROUND((4.99 + (i * 9.95))::NUMERIC, 2),
    -- category rotation
    (ARRAY['Electronics','Clothing','Books','Home','Sports'])
        [((i - 1) % 5) + 1],
    -- stock: 0 – 500
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

-- --------------------------------------------------------------------------
-- 200 orders with varied statuses
-- --------------------------------------------------------------------------
-- Status distribution: ~40% completed, 25% pending, 20% shipped, 15% cancelled
-- --------------------------------------------------------------------------
INSERT INTO orders (user_id, total, status, created_at)
SELECT
    -- user_id: 1–500
    ((i * 3) % 500) + 1,
    -- total: $10 – $2000, computed deterministically
    ROUND((10 + (i * 9.73))::NUMERIC, 2),
    -- status by bucket
    CASE
        WHEN i % 20 < 8  THEN 'completed'
        WHEN i % 20 < 13 THEN 'pending'
        WHEN i % 20 < 17 THEN 'shipped'
        ELSE                   'cancelled'
    END,
    TIMESTAMPTZ '2024-06-01 12:00:00+00' + (i * INTERVAL '1 day' * 0.9)
FROM generate_series(1, 200) AS s(i);

-- --------------------------------------------------------------------------
-- 400 order_items linking orders ↔ products
-- --------------------------------------------------------------------------
INSERT INTO order_items (order_id, product_id, quantity, price)
SELECT
    -- order_id: 1–200, each order gets ~2 items
    ((i - 1) / 2) + 1,
    -- product_id: 1–100
    ((i * 7) % 100) + 1,
    -- quantity: 1–5
    (i % 5) + 1,
    -- unit price snapshot
    ROUND((4.99 + ((((i * 7) % 100) + 1) * 9.95))::NUMERIC, 2)
FROM generate_series(1, 400) AS s(i);

COMMIT;
