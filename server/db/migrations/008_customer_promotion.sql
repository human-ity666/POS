-- Phase 09: Customer Management, Basic Loyalty Architecture & Promotion Engine

-- 1. Extend customers with membership & loyalty columns
ALTER TABLE customers ADD COLUMN membership_number TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN loyalty_points INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0);
ALTER TABLE customers ADD COLUMN total_points_earned INTEGER NOT NULL DEFAULT 0 CHECK (total_points_earned >= 0);
ALTER TABLE customers ADD COLUMN total_points_redeemed INTEGER NOT NULL DEFAULT 0 CHECK (total_points_redeemed >= 0);

UPDATE customers
SET membership_number = 'MBR-' || substr('0000' || rowid, -4, 4)
WHERE TRIM(membership_number) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_membership_number
  ON customers(membership_number COLLATE NOCASE)
  WHERE TRIM(membership_number) != '';

-- 2. Basic configurable loyalty rules (singleton)
CREATE TABLE IF NOT EXISTS loyalty_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  points_per_amount INTEGER NOT NULL DEFAULT 10000 CHECK (points_per_amount > 0),
  point_value_rp INTEGER NOT NULL DEFAULT 100 CHECK (point_value_rp >= 0),
  min_redeem_points INTEGER NOT NULL DEFAULT 10 CHECK (min_redeem_points >= 0),
  max_redeem_percent INTEGER NOT NULL DEFAULT 50 CHECK (max_redeem_percent >= 0 AND max_redeem_percent <= 100),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO loyalty_settings (
  id, enabled, points_per_amount, point_value_rp, min_redeem_points, max_redeem_percent, updated_at
) VALUES (
  1, 1, 10000, 100, 10, 50, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- 3. Loyalty point transaction ledger
CREATE TABLE IF NOT EXISTS loyalty_point_transactions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('EARN', 'REDEEM', 'ADJUST')),
  points_delta INTEGER NOT NULL,
  points_before INTEGER NOT NULL CHECK (points_before >= 0),
  points_after INTEGER NOT NULL CHECK (points_after >= 0),
  reference_number TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT,
  actor_name TEXT NOT NULL DEFAULT 'Sistem',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loyalty_trx_customer
  ON loyalty_point_transactions(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_trx_transaction
  ON loyalty_point_transactions(transaction_id);

-- 4. Promotions & extensible rule targets
CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  promo_type TEXT NOT NULL CHECK (promo_type IN ('PERCENT', 'FIXED_AMOUNT', 'SPECIAL_PRICE', 'BUY_X_GET_Y', 'BUNDLE')),
  scope TEXT NOT NULL CHECK (scope IN ('PRODUCT', 'TRANSACTION', 'CATEGORY', 'BUNDLE')),
  discount_value NUMERIC NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  max_discount_amount INTEGER CHECK (max_discount_amount IS NULL OR max_discount_amount >= 0),
  min_purchase_amount INTEGER NOT NULL DEFAULT 0 CHECK (min_purchase_amount >= 0),
  min_qty INTEGER NOT NULL DEFAULT 1 CHECK (min_qty >= 1),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  stackable INTEGER NOT NULL DEFAULT 0 CHECK (stackable IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 10,
  rule_json TEXT NOT NULL DEFAULT '{}',
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  created_by_user_id TEXT,
  created_by_name TEXT NOT NULL DEFAULT 'Sistem',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promotions_status_dates
  ON promotions(status, start_date, end_date);

CREATE TABLE IF NOT EXISTS promotion_targets (
  id TEXT PRIMARY KEY,
  promotion_id TEXT NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('PRODUCT', 'CATEGORY')),
  target_id TEXT NOT NULL,
  required_qty INTEGER NOT NULL DEFAULT 1 CHECK (required_qty >= 1)
);

CREATE INDEX IF NOT EXISTS idx_promotion_targets_promo
  ON promotion_targets(promotion_id);
CREATE INDEX IF NOT EXISTS idx_promotion_targets_target
  ON promotion_targets(target_type, target_id);

-- 5. Extend store_settings with discount limit & stacking policies
ALTER TABLE store_settings ADD COLUMN allow_promo_stacking INTEGER NOT NULL DEFAULT 1 CHECK (allow_promo_stacking IN (0, 1));
ALTER TABLE store_settings ADD COLUMN allow_manual_with_promo INTEGER NOT NULL DEFAULT 0 CHECK (allow_manual_with_promo IN (0, 1));
ALTER TABLE store_settings ADD COLUMN max_cashier_discount_percent NUMERIC NOT NULL DEFAULT 25 CHECK (max_cashier_discount_percent >= 0 AND max_cashier_discount_percent <= 100);
ALTER TABLE store_settings ADD COLUMN max_authorized_discount_percent NUMERIC NOT NULL DEFAULT 100 CHECK (max_authorized_discount_percent >= 0 AND max_authorized_discount_percent <= 100);

-- 6. Extend transactions & transaction_items for archived promo & loyalty breakdown
ALTER TABLE transactions ADD COLUMN promotion_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE transactions ADD COLUMN promotion_discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (promotion_discount_amount >= 0);
ALTER TABLE transactions ADD COLUMN loyalty_points_earned INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_earned >= 0);
ALTER TABLE transactions ADD COLUMN loyalty_points_redeemed INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_redeemed >= 0);
ALTER TABLE transactions ADD COLUMN loyalty_discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_discount_amount >= 0);
ALTER TABLE transactions ADD COLUMN applied_promotions_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE transaction_items ADD COLUMN promotion_id TEXT;
ALTER TABLE transaction_items ADD COLUMN promotion_name TEXT NOT NULL DEFAULT '';
ALTER TABLE transaction_items ADD COLUMN promotion_discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (promotion_discount_amount >= 0);
