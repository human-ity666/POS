CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type TEXT NOT NULL CHECK (type IN ('CASH', 'DEBIT', 'CREDIT', 'QRIS', 'OTHER')),
  requires_reference INTEGER NOT NULL DEFAULT 0 CHECK (requires_reference IN (0, 1)),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_sequences (
  seq_key TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at TEXT NOT NULL
);

-- Rebuild transactions and transaction_items cleanly to support Phase 04 states,
-- configurable payment methods, discounts, price overrides, customers, and idempotency.
CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('NEW', 'IN_PROGRESS', 'HELD', 'CANCELLED', 'COMPLETED')),
  payment_status TEXT NOT NULL DEFAULT 'PAID' CHECK (payment_status IN ('UNPAID', 'PARTIAL', 'PAID', 'CANCELLED')),
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL DEFAULT 'Pelanggan Umum',
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
  line_discount_total INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_total >= 0),
  transaction_discount_type TEXT NOT NULL DEFAULT 'AMOUNT' CHECK (transaction_discount_type IN ('AMOUNT', 'PERCENT')),
  transaction_discount_value NUMERIC NOT NULL DEFAULT 0 CHECK (transaction_discount_value >= 0),
  transaction_discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (transaction_discount_amount >= 0),
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
  cashier_id TEXT,
  cashier_name TEXT NOT NULL,
  held_at TEXT,
  cancelled_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO transactions_new (
  id, invoice_number, status, payment_status, customer_id, customer_name,
  subtotal, line_discount_total, transaction_discount_type, transaction_discount_value,
  transaction_discount_amount, discount_amount, apply_tax, tax_amount, total,
  cash_received, change_amount, payment_method, total_cost, gross_profit,
  notes, idempotency_key, cashier_id, cashier_name,
  held_at, cancelled_at, completed_at, created_at, updated_at
)
SELECT
  id, invoice_number, 'COMPLETED', 'PAID', NULL, 'Pelanggan Umum',
  subtotal, 0, 'AMOUNT', discount_amount,
  discount_amount, discount_amount, CASE WHEN tax_amount > 0 THEN 1 ELSE 0 END, tax_amount, total,
  cash_received, change_amount, payment_method, total_cost, gross_profit,
  '', NULL, cashier_id, cashier_name,
  NULL, NULL, created_at, created_at, created_at
FROM transactions;

CREATE TABLE transaction_items_new (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions_new(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  barcode TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  original_sell_price INTEGER NOT NULL DEFAULT 0 CHECK (original_sell_price >= 0),
  sell_price INTEGER NOT NULL CHECK (sell_price >= 0),
  price_override INTEGER NOT NULL DEFAULT 0 CHECK (price_override IN (0, 1)),
  cost_price INTEGER NOT NULL CHECK (cost_price >= 0),
  line_discount_type TEXT NOT NULL DEFAULT 'AMOUNT' CHECK (line_discount_type IN ('AMOUNT', 'PERCENT')),
  line_discount_value NUMERIC NOT NULL DEFAULT 0 CHECK (line_discount_value >= 0),
  line_discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_amount >= 0),
  tax_category TEXT NOT NULL DEFAULT 'STANDARD',
  tax_amount INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0)
);

INSERT INTO transaction_items_new (
  id, transaction_id, product_id, sku, barcode, name, unit, qty,
  original_sell_price, sell_price, price_override, cost_price,
  line_discount_type, line_discount_value, line_discount_amount,
  tax_category, tax_amount, subtotal
)
SELECT
  id, transaction_id, product_id, '', barcode, name, unit, qty,
  sell_price, sell_price, 0, cost_price,
  'AMOUNT', 0, 0,
  'STANDARD', 0, subtotal
FROM transaction_items;

DROP TABLE transaction_items;
DROP TABLE transactions;

ALTER TABLE transactions_new RENAME TO transactions;
ALTER TABLE transaction_items_new RENAME TO transaction_items;

CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_transaction_items_trx ON transaction_items(transaction_id);

CREATE TABLE IF NOT EXISTS transaction_payments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  payment_method_id TEXT REFERENCES payment_methods(id) ON DELETE SET NULL,
  payment_method_name TEXT NOT NULL,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('CASH', 'DEBIT', 'CREDIT', 'QRIS', 'OTHER')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  tendered_amount INTEGER NOT NULL CHECK (tendered_amount >= 0),
  change_amount INTEGER NOT NULL DEFAULT 0 CHECK (change_amount >= 0),
  reference_number TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transaction_payments_trx ON transaction_payments(transaction_id);

INSERT INTO transaction_payments (
  id, transaction_id, payment_method_id, payment_method_name, payment_type,
  amount, tendered_amount, change_amount, reference_number, created_at
)
SELECT
  id || '-pay-0',
  id,
  NULL,
  payment_method,
  CASE
    WHEN payment_method = 'QRIS' THEN 'QRIS'
    WHEN payment_method = 'Kartu Debit' THEN 'DEBIT'
    ELSE 'CASH'
  END,
  total,
  cash_received,
  change_amount,
  '',
  created_at
FROM transactions;
