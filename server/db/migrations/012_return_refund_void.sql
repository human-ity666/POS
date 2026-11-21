-- Phase 11: Return, Refund & Void

-- 1. Rebuild transactions to support VOIDED status, REFUNDED / PARTIALLY_REFUNDED payment statuses,
--    and tracked return/refund/void totals & approval metadata while preserving all completed records.
CREATE TABLE transactions_p11 (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('NEW', 'IN_PROGRESS', 'HELD', 'CANCELLED', 'COMPLETED', 'VOIDED')),
  payment_status TEXT NOT NULL DEFAULT 'PAID' CHECK (payment_status IN ('UNPAID', 'PARTIAL', 'PAID', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED')),
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL DEFAULT 'Pelanggan Umum',
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
  line_discount_total INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_total >= 0),
  transaction_discount_type TEXT NOT NULL DEFAULT 'AMOUNT' CHECK (transaction_discount_type IN ('AMOUNT', 'PERCENT')),
  transaction_discount_value NUMERIC NOT NULL DEFAULT 0 CHECK (transaction_discount_value >= 0),
  transaction_discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (transaction_discount_amount >= 0),
  promotion_ids_json TEXT NOT NULL DEFAULT '[]',
  promotion_discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (promotion_discount_amount >= 0),
  loyalty_points_earned INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_earned >= 0),
  loyalty_points_redeemed INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_redeemed >= 0),
  loyalty_discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_discount_amount >= 0),
  applied_promotions_json TEXT NOT NULL DEFAULT '[]',
  discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  apply_tax INTEGER NOT NULL DEFAULT 0 CHECK (apply_tax IN (0, 1)),
  tax_amount INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total INTEGER NOT NULL CHECK (total >= 0),
  cash_received INTEGER NOT NULL DEFAULT 0 CHECK (cash_received >= 0),
  change_amount INTEGER NOT NULL DEFAULT 0 CHECK (change_amount >= 0),
  payment_method TEXT NOT NULL DEFAULT 'Tunai',
  total_cost INTEGER NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  gross_profit INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT UNIQUE,
  shift_id TEXT REFERENCES cashier_shifts(id) ON DELETE SET NULL,
  cashier_id TEXT,
  cashier_name TEXT NOT NULL,
  held_at TEXT,
  cancelled_at TEXT,
  completed_at TEXT,
  return_status TEXT NOT NULL DEFAULT 'NONE' CHECK (return_status IN ('NONE', 'PARTIAL', 'FULL')),
  returned_total INTEGER NOT NULL DEFAULT 0 CHECK (returned_total >= 0),
  refunded_total INTEGER NOT NULL DEFAULT 0 CHECK (refunded_total >= 0),
  void_number TEXT,
  void_reason TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  voided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  voided_by_name TEXT,
  void_approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  void_approved_by_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO transactions_p11 (
  id, invoice_number, status, payment_status, customer_id, customer_name,
  subtotal, line_discount_total, transaction_discount_type, transaction_discount_value,
  transaction_discount_amount, promotion_ids_json, promotion_discount_amount,
  loyalty_points_earned, loyalty_points_redeemed, loyalty_discount_amount, applied_promotions_json,
  discount_amount, apply_tax, tax_amount, total,
  cash_received, change_amount, payment_method, total_cost, gross_profit,
  notes, idempotency_key, shift_id, cashier_id, cashier_name,
  held_at, cancelled_at, completed_at,
  return_status, returned_total, refunded_total,
  void_number, void_reason, voided_at, voided_by_user_id, voided_by_name,
  void_approved_by_user_id, void_approved_by_name,
  created_at, updated_at
)
SELECT
  id, invoice_number, status, payment_status, customer_id, customer_name,
  subtotal, line_discount_total, transaction_discount_type, transaction_discount_value,
  transaction_discount_amount, promotion_ids_json, promotion_discount_amount,
  loyalty_points_earned, loyalty_points_redeemed, loyalty_discount_amount, applied_promotions_json,
  discount_amount, apply_tax, tax_amount, total,
  cash_received, change_amount, payment_method, total_cost, gross_profit,
  notes, idempotency_key, shift_id, cashier_id, cashier_name,
  held_at, cancelled_at, completed_at,
  'NONE', 0, 0,
  NULL, '', NULL, NULL, NULL, NULL, NULL,
  created_at, updated_at
FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_p11 RENAME TO transactions;

CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_transactions_shift_id ON transactions(shift_id);
CREATE INDEX IF NOT EXISTS idx_transactions_return_status ON transactions(return_status);

-- 2. Rebuild stock_movements to allow RETURN_IN and VOID_IN movement types
CREATE TABLE stock_movements_p11 (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL,
  barcode TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('PENJUALAN', 'RESTOK', 'STOCK_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'OPNAME', 'STOK_AWAL', 'RETURN_IN', 'VOID_IN')),
  qty_delta INTEGER NOT NULL,
  stock_before INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  unit_cost INTEGER,
  reference_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT,
  actor_name TEXT NOT NULL DEFAULT 'Sistem',
  movement_date TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

INSERT INTO stock_movements_p11 (
  id, product_id, sku, product_name, barcode, type, qty_delta,
  stock_before, stock_after, unit_cost, reference_id, reason, notes,
  actor_user_id, actor_name, movement_date, created_at
)
SELECT
  id, product_id, sku, product_name, barcode, type, qty_delta,
  stock_before, stock_after, unit_cost, reference_id, reason, notes,
  actor_user_id, actor_name, movement_date, created_at
FROM stock_movements;

DROP TABLE stock_movements;
ALTER TABLE stock_movements_p11 RENAME TO stock_movements;

CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON stock_movements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements(type);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements(reference_id);

-- 3. Returns Master Ledger
CREATE TABLE IF NOT EXISTS transaction_returns (
  id TEXT PRIMARY KEY,
  return_number TEXT NOT NULL UNIQUE,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL,
  receipt_number TEXT NOT NULL,
  return_type TEXT NOT NULL CHECK (return_type IN ('PARTIAL', 'FULL')),
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'PENDING_INSPECTION')),
  reason TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  subtotal_refunded INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_refunded >= 0),
  discount_adjusted INTEGER NOT NULL DEFAULT 0 CHECK (discount_adjusted >= 0),
  tax_refunded INTEGER NOT NULL DEFAULT 0 CHECK (tax_refunded >= 0),
  total_refund_amount INTEGER NOT NULL CHECK (total_refund_amount >= 0),
  loyalty_points_reversed INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_reversed >= 0),
  refund_method TEXT NOT NULL,
  refund_payment_type TEXT NOT NULL CHECK (refund_payment_type IN ('CASH', 'DEBIT', 'CREDIT', 'QRIS', 'TRANSFER', 'OTHER')),
  refund_reference TEXT NOT NULL DEFAULT '',
  refund_status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (refund_status IN ('COMPLETED', 'PENDING', 'MANUAL_RECORDED', 'FAILED')),
  cash_movement_id TEXT REFERENCES cash_movements(id) ON DELETE SET NULL,
  shift_id TEXT REFERENCES cashier_shifts(id) ON DELETE SET NULL,
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name TEXT NOT NULL,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by_name TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transaction_returns_trx ON transaction_returns(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_returns_created_at ON transaction_returns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transaction_returns_status ON transaction_returns(status);

-- 4. Return Items & Stock Disposition Ledger
CREATE TABLE IF NOT EXISTS transaction_return_items (
  id TEXT PRIMARY KEY,
  return_id TEXT NOT NULL REFERENCES transaction_returns(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  transaction_item_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL DEFAULT '',
  barcode TEXT NOT NULL,
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  original_qty INTEGER NOT NULL CHECK (original_qty > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  line_refund_amount INTEGER NOT NULL CHECK (line_refund_amount >= 0),
  tax_refund_amount INTEGER NOT NULL DEFAULT 0 CHECK (tax_refund_amount >= 0),
  total_refund_amount INTEGER NOT NULL CHECK (total_refund_amount >= 0),
  stock_disposition TEXT NOT NULL CHECK (stock_disposition IN ('SELLABLE', 'DAMAGED', 'UNSELLABLE', 'PENDING_INSPECTION')),
  final_disposition TEXT CHECK (final_disposition IS NULL OR final_disposition IN ('SELLABLE', 'DAMAGED', 'UNSELLABLE')),
  disposition_resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  disposition_resolved_by_name TEXT,
  disposition_resolved_at TEXT,
  disposition_notes TEXT NOT NULL DEFAULT '',
  stock_movement_id TEXT REFERENCES stock_movements(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_return_items_return_id ON transaction_return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_return_items_trx_id ON transaction_return_items(transaction_id);
CREATE INDEX IF NOT EXISTS idx_return_items_disposition ON transaction_return_items(stock_disposition);

-- 5. Voided Transactions Ledger
CREATE TABLE IF NOT EXISTS transaction_voids (
  id TEXT PRIMARY KEY,
  void_number TEXT NOT NULL UNIQUE,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL,
  receipt_number TEXT NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  voided_total INTEGER NOT NULL CHECK (voided_total >= 0),
  refund_method TEXT NOT NULL,
  refund_payment_type TEXT NOT NULL CHECK (refund_payment_type IN ('CASH', 'DEBIT', 'CREDIT', 'QRIS', 'TRANSFER', 'OTHER')),
  refund_reference TEXT NOT NULL DEFAULT '',
  refund_status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (refund_status IN ('COMPLETED', 'PENDING', 'MANUAL_RECORDED', 'FAILED')),
  stock_restored_qty INTEGER NOT NULL DEFAULT 0 CHECK (stock_restored_qty >= 0),
  loyalty_points_reversed INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points_reversed >= 0),
  cash_movement_id TEXT REFERENCES cash_movements(id) ON DELETE SET NULL,
  shift_id TEXT REFERENCES cashier_shifts(id) ON DELETE SET NULL,
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name TEXT NOT NULL,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transaction_voids_created_at ON transaction_voids(created_at DESC);

-- 6. Refund Audit & Payment Records
CREATE TABLE IF NOT EXISTS refund_records (
  id TEXT PRIMARY KEY,
  refund_number TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('RETURN', 'VOID')),
  source_id TEXT NOT NULL,
  source_number TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  refund_method TEXT NOT NULL,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('CASH', 'DEBIT', 'CREDIT', 'QRIS', 'TRANSFER', 'OTHER')),
  reference_number TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'PENDING', 'MANUAL_RECORDED', 'FAILED')),
  notes TEXT NOT NULL DEFAULT '',
  cash_movement_id TEXT REFERENCES cash_movements(id) ON DELETE SET NULL,
  shift_id TEXT REFERENCES cashier_shifts(id) ON DELETE SET NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refund_records_trx ON refund_records(transaction_id);
CREATE INDEX IF NOT EXISTS idx_refund_records_created_at ON refund_records(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refund_records_status ON refund_records(status);
