-- Phase 10: Shift & Cash Management

CREATE TABLE IF NOT EXISTS shift_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  require_open_shift_for_sales INTEGER NOT NULL DEFAULT 0 CHECK (require_open_shift_for_sales IN (0, 1)),
  allow_duplicate_open_shifts INTEGER NOT NULL DEFAULT 0 CHECK (allow_duplicate_open_shifts IN (0, 1)),
  require_supervisor_approval_on_discrepancy INTEGER NOT NULL DEFAULT 1 CHECK (require_supervisor_approval_on_discrepancy IN (0, 1)),
  discrepancy_tolerance_rp INTEGER NOT NULL DEFAULT 0 CHECK (discrepancy_tolerance_rp >= 0),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO shift_settings (
  id,
  require_open_shift_for_sales,
  allow_duplicate_open_shifts,
  require_supervisor_approval_on_discrepancy,
  discrepancy_tolerance_rp,
  updated_at
) VALUES (1, 0, 0, 1, 0, datetime('now'));

CREATE TABLE IF NOT EXISTS cashier_shifts (
  id TEXT PRIMARY KEY,
  shift_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  cashier_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  cashier_name TEXT NOT NULL,
  register_name TEXT NOT NULL DEFAULT 'Kasir Utama',
  opening_cash INTEGER NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  opening_notes TEXT NOT NULL DEFAULT '',
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  closed_by_name TEXT,
  cash_sales INTEGER NOT NULL DEFAULT 0 CHECK (cash_sales >= 0),
  cash_received INTEGER NOT NULL DEFAULT 0 CHECK (cash_received >= 0),
  cash_change_given INTEGER NOT NULL DEFAULT 0 CHECK (cash_change_given >= 0),
  cash_refunds INTEGER NOT NULL DEFAULT 0 CHECK (cash_refunds >= 0),
  cash_in_total INTEGER NOT NULL DEFAULT 0 CHECK (cash_in_total >= 0),
  cash_out_total INTEGER NOT NULL DEFAULT 0 CHECK (cash_out_total >= 0),
  expense_total INTEGER NOT NULL DEFAULT 0 CHECK (expense_total >= 0),
  non_cash_sales INTEGER NOT NULL DEFAULT 0 CHECK (non_cash_sales >= 0),
  total_sales INTEGER NOT NULL DEFAULT 0 CHECK (total_sales >= 0),
  transaction_count INTEGER NOT NULL DEFAULT 0 CHECK (transaction_count >= 0),
  expected_cash INTEGER NOT NULL DEFAULT 0,
  actual_cash INTEGER,
  difference INTEGER,
  closing_notes TEXT NOT NULL DEFAULT '',
  closing_denominations_json TEXT NOT NULL DEFAULT '[]',
  discrepancy_status TEXT NOT NULL DEFAULT 'NONE' CHECK (discrepancy_status IN ('NONE', 'MATCHED', 'PENDING_APPROVAL', 'APPROVED')),
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by_name TEXT,
  approved_at TEXT,
  approval_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cashier_shifts_cashier_status ON cashier_shifts(cashier_user_id, status);
CREATE INDEX IF NOT EXISTS idx_cashier_shifts_opened_at ON cashier_shifts(opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_cashier_shifts_status ON cashier_shifts(status);

CREATE TABLE IF NOT EXISTS cash_movements (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES cashier_shifts(id) ON DELETE RESTRICT,
  movement_number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('CASH_IN', 'CASH_OUT', 'EXPENSE', 'CASH_REFUND')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  reference_number TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_movements_shift_id ON cash_movements(shift_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_movements_type ON cash_movements(type);

ALTER TABLE transactions
  ADD COLUMN shift_id TEXT REFERENCES cashier_shifts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_shift_id ON transactions(shift_id);

-- Extend pin_authorizations CHECK constraint with 'shift_discrepancy'
CREATE TABLE pin_authorizations_p10 (
  id TEXT PRIMARY KEY,
  authorizer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('discount_approval', 'price_override', 'void', 'refund', 'stock_adjustment', 'item_cancel', 'shift_discrepancy')),
  reason TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO pin_authorizations_p10 (
  id, authorizer_user_id, requested_by_user_id, action, reason, token_hash, expires_at, used_at, created_at
)
SELECT
  id, authorizer_user_id, requested_by_user_id, action, reason, token_hash, expires_at, used_at, created_at
FROM pin_authorizations;

DROP TABLE pin_authorizations;

ALTER TABLE pin_authorizations_p10 RENAME TO pin_authorizations;
