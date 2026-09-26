-- ============================================================================
-- SchemaForge v2.0 — Edge Case Seeds for Migration Rehearsal
-- 
-- PURPOSE: These intentional data anomalies let SchemaForge demonstrate its
--          ability to detect, report, and remediate violations BEFORE a
--          migration reaches production.
--
-- This file is DETERMINISTIC and REPRODUCIBLE — it targets specific rows
-- by primary key so results are identical on every reset.
-- ============================================================================

BEGIN;

-- **************************************************************************
-- EDGE CASE 1: NULL emails (14 rows)
-- **************************************************************************
-- Scenario: A planned migration will add NOT NULL to users.email.
-- These 14 rows will violate that constraint and MUST be caught by
-- SchemaForge's pre-flight validation.
--
-- We pick user IDs spread across the table to simulate organic data rot
-- rather than a contiguous block (which would be unrealistically easy to
-- spot in a manual review).
-- **************************************************************************
UPDATE users SET email = NULL, updated_at = NOW()
WHERE id IN (
     7,   -- Alice Williams
    23,   -- Xander Smith
    42,   -- Bob Garcia
    58,   -- Iris Johnson
    91,   -- Sam Taylor
   104,   -- Diana Anderson
   137,   -- Frank Thompson
   189,   -- Grace Martinez
   215,   -- Holly White
   256,   -- Caleb Lee
   301,   -- Alice Clark
   348,   -- Nate Lewis
   412,   -- Luna Robinson
   467    -- Ethan Walker
);
-- Expected: exactly 14 rows affected

-- **************************************************************************
-- EDGE CASE 2: Orders that stress FK integrity
-- **************************************************************************
-- Scenario: These orders reference user_ids near the boundary of the
-- users table (id = 498, 499, 500). A migration that truncates or
-- re-sequences the users table must not orphan these rows.
--
-- Additionally, we insert an order with a NULL user_id to test how
-- SchemaForge handles nullable FK columns during analysis.
-- **************************************************************************

-- Order tied to the last user (boundary test)
INSERT INTO orders (user_id, total, status, created_at)
VALUES (500, 1299.99, 'pending', TIMESTAMPTZ '2026-09-01 10:00:00+00');
-- Boundary FK: references the very last user row

-- Order tied to near-last users
INSERT INTO orders (user_id, total, status, created_at)
VALUES (499, 89.50, 'completed', TIMESTAMPTZ '2026-09-05 14:30:00+00');
-- Near-boundary FK test

INSERT INTO orders (user_id, total, status, created_at)
VALUES (498, 450.00, 'shipped', TIMESTAMPTZ '2026-09-10 09:15:00+00');
-- Near-boundary FK test

-- **************************************************************************
-- EDGE CASE 3: Order with NULL user_id (nullable FK)
-- **************************************************************************
-- Scenario: If a migration adds NOT NULL to orders.user_id, this row
-- becomes a violation. SchemaForge must detect it and propose a
-- remediation (assign a default user or delete the orphan order).
-- **************************************************************************
INSERT INTO orders (user_id, total, status, created_at)
VALUES (NULL, 0.00, 'cancelled', TIMESTAMPTZ '2026-09-15 00:00:00+00');
-- NULL FK: anonymous/guest order — tests nullable FK handling

-- **************************************************************************
-- EDGE CASE 4: Duplicate emails (UNIQUE constraint test)
-- **************************************************************************
-- Scenario: If a migration adds a UNIQUE constraint on users.email, these
-- duplicates must be detected. We update 3 existing users to share the
-- same email address.
-- **************************************************************************
UPDATE users SET email = 'duplicate@example.com', updated_at = NOW()
WHERE id IN (150, 275, 399);
-- Expected: 3 rows now share the same email, violating any future UNIQUE constraint

-- **************************************************************************
-- EDGE CASE 5: Extreme price values
-- **************************************************************************
-- Scenario: Tests DECIMAL(10,2) boundary handling during migrations that
-- might alter column precision.
-- **************************************************************************
INSERT INTO products (name, price, category, stock, created_at)
VALUES
    ('Budget Item Zero',       0.01, 'Books',       9999, NOW()),
    ('Luxury Maximum Price', 99999999.99, 'Electronics', 1,    NOW());
-- Min and max representable prices in DECIMAL(10,2)

-- **************************************************************************
-- EDGE CASE 6: Order item with quantity edge values
-- **************************************************************************
-- Scenario: If a migration adds CHECK (quantity > 0), the zero-quantity
-- row must be caught.
-- **************************************************************************
INSERT INTO order_items (order_id, product_id, quantity, price)
VALUES (1, 1, 0, 0.00);
-- Zero quantity — violates a potential CHECK constraint

COMMIT;

-- ============================================================================
-- Summary of planted edge cases:
-- ============================================================================
--   #  | Type              | Count | Purpose
--  ----+-------------------+-------+------------------------------------------
--   1  | NULL emails       |   14  | NOT NULL constraint migration demo
--   2  | Boundary FK refs  |    3  | FK integrity on table-edge user_ids
--   3  | NULL FK (user_id) |    1  | Nullable FK → NOT NULL migration
--   4  | Duplicate emails  |    3  | UNIQUE constraint migration demo
--   5  | Extreme prices    |    2  | DECIMAL precision boundary test
--   6  | Zero quantity     |    1  | CHECK constraint migration demo
-- ============================================================================
