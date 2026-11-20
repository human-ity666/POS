-- Phase 06: Inventory & Stock Control
-- 1. Add configurable negative stock behavior to store_settings
ALTER TABLE store_settings ADD COLUMN allow_negative_stock INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative_stock IN (0, 1));

-- 2. Rebuild products table without CHECK (stock >= 0) so configurable negative stock works cleanly
CREATE TABLE products_new (
  id TEXT PRIMARY KEY,
  barcode TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  cost_price INTEGER NOT NULL CHECK (cost_price >= 0),
  sell_price INTEGER NOT NULL CHECK (sell_price > 0),
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  updated_at TEXT NOT NULL,
  sku TEXT,
  description TEXT NOT NULL DEFAULT '',
  brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  subcategory_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  uom_id TEXT REFERENCES units_of_measure(id) ON DELETE SET NULL,
  variant TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  weight REAL,
  volume REAL,
  special_price INTEGER,
  tax_category TEXT NOT NULL DEFAULT 'STANDARD' CHECK (tax_category IN ('STANDARD', 'EXEMPT', 'REDUCED')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  primary_image_id TEXT,
  created_at TEXT
);

INSERT INTO products_new (
  id, barcode, name, category, unit, cost_price, sell_price, stock, min_stock, updated_at,
  sku, description, brand_id, category_id, subcategory_id, uom_id,
  variant, size, weight, volume, special_price, tax_category, status, primary_image_id, created_at
)
SELECT
  id, barcode, name, category, unit, cost_price, sell_price, stock, min_stock, updated_at,
  sku, description, brand_id, category_id, subcategory_id, uom_id,
  variant, size, weight, volume, special_price, tax_category, status, primary_image_id, created_at
FROM products;

DROP TABLE products;
ALTER TABLE products_new RENAME TO products;

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON products(sku COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_subcategory_id ON products(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock);

-- 3. Rebuild stock_movements with ON DELETE RESTRICT (never delete stock history),
--    extended movement types, user attribution, cost snapshot, reason, and signed balances
CREATE TABLE stock_movements_new (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL,
  barcode TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('PENJUALAN', 'RESTOK', 'STOCK_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'OPNAME', 'STOK_AWAL')),
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

INSERT INTO stock_movements_new (
  id, product_id, sku, product_name, barcode, type, qty_delta,
  stock_before, stock_after, unit_cost, reference_id, reason, notes,
  actor_user_id, actor_name, movement_date, created_at
)
SELECT
  m.id,
  m.product_id,
  COALESCE((SELECT p.sku FROM products p WHERE p.id = m.product_id), ''),
  m.product_name,
  m.barcode,
  m.type,
  m.qty_delta,
  m.stock_before,
  m.stock_after,
  NULL,
  m.reference_id,
  '',
  m.notes,
  NULL,
  'Sistem',
  m.created_at,
  m.created_at
FROM stock_movements m;

DROP TABLE stock_movements;
ALTER TABLE stock_movements_new RENAME TO stock_movements;

CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON stock_movements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements(type);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements(reference_id);

-- 4. Stock In (Receiving) Ledger
CREATE TABLE IF NOT EXISTS stock_receivings (
  id TEXT PRIMARY KEY,
  reference_number TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  barcode TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  cost_price INTEGER NOT NULL CHECK (cost_price >= 0),
  previous_cost_price INTEGER NOT NULL CHECK (previous_cost_price >= 0),
  update_product_cost INTEGER NOT NULL DEFAULT 0 CHECK (update_product_cost IN (0, 1)),
  notes TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  movement_id TEXT NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
  created_by_user_id TEXT,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_receivings_created_at ON stock_receivings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_receivings_product ON stock_receivings(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_receivings_ref ON stock_receivings(reference_number);

-- 5. Stock Adjustments History & Approval Records
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id TEXT PRIMARY KEY,
  reference_number TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  barcode TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('INCREASE', 'DECREASE')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  stock_before INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  approval_status TEXT NOT NULL DEFAULT 'APPROVED' CHECK (approval_status IN ('APPROVED')),
  requested_by_user_id TEXT,
  requested_by_name TEXT NOT NULL,
  approved_by_user_id TEXT,
  approved_by_name TEXT NOT NULL,
  movement_id TEXT NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_created_at ON stock_adjustments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_product ON stock_adjustments(product_id, created_at DESC);

-- 6. Stock Opname (Physical Count Sessions & Discrepancy Lines)
CREATE TABLE IF NOT EXISTS stock_opnames (
  id TEXT PRIMARY KEY,
  opname_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'FINALIZED', 'CANCELLED')),
  notes TEXT NOT NULL DEFAULT '',
  total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  counted_items INTEGER NOT NULL DEFAULT 0 CHECK (counted_items >= 0),
  discrepancy_items INTEGER NOT NULL DEFAULT 0 CHECK (discrepancy_items >= 0),
  total_variance_qty INTEGER NOT NULL DEFAULT 0,
  total_variance_value INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT,
  created_by_name TEXT NOT NULL,
  approved_by_user_id TEXT,
  approved_by_name TEXT,
  approved_at TEXT,
  finalized_by_user_id TEXT,
  finalized_by_name TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_opnames_created_at ON stock_opnames(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_opnames_status ON stock_opnames(status);

CREATE TABLE IF NOT EXISTS stock_opname_items (
  id TEXT PRIMARY KEY,
  opname_id TEXT NOT NULL REFERENCES stock_opnames(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  barcode TEXT NOT NULL,
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  cost_price INTEGER NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  system_stock INTEGER NOT NULL,
  physical_stock INTEGER,
  variance INTEGER NOT NULL DEFAULT 0,
  variance_value INTEGER NOT NULL DEFAULT 0,
  is_counted INTEGER NOT NULL DEFAULT 0 CHECK (is_counted IN (0, 1)),
  notes TEXT NOT NULL DEFAULT '',
  applied_movement_id TEXT REFERENCES stock_movements(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL,
  UNIQUE(opname_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_opname_items_opname ON stock_opname_items(opname_id);
CREATE INDEX IF NOT EXISTS idx_stock_opname_items_product ON stock_opname_items(product_id);
