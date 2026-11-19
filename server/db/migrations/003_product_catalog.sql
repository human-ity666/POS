CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_brands_name ON brands(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS units_of_measure (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL
);

ALTER TABLE products ADD COLUMN sku TEXT;
ALTER TABLE products ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN subcategory_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN uom_id TEXT REFERENCES units_of_measure(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN variant TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN size TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN weight REAL;
ALTER TABLE products ADD COLUMN volume REAL;
ALTER TABLE products ADD COLUMN special_price INTEGER;
ALTER TABLE products ADD COLUMN tax_category TEXT NOT NULL DEFAULT 'STANDARD' CHECK (tax_category IN ('STANDARD', 'EXEMPT', 'REDUCED'));
ALTER TABLE products ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE'));
ALTER TABLE products ADD COLUMN primary_image_id TEXT;
ALTER TABLE products ADD COLUMN created_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON products(sku COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_subcategory_id ON products(subcategory_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

CREATE TABLE IF NOT EXISTS product_barcodes (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL UNIQUE COLLATE NOCASE,
  barcode_type TEXT NOT NULL DEFAULT 'EAN-13' CHECK (barcode_type IN ('EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'CODE-128', 'CODE-39', 'QR', 'INTERNAL')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_barcodes_product ON product_barcodes(product_id);
CREATE INDEX IF NOT EXISTS idx_product_barcodes_code ON product_barcodes(barcode COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size >= 0),
  image_url TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  is_ai_reference INTEGER NOT NULL DEFAULT 0 CHECK (is_ai_reference IN (0, 1)),
  reference_angle TEXT NOT NULL DEFAULT 'front' CHECK (reference_angle IN ('front', 'back', 'side', 'top', 'packaging', 'other')),
  ai_embedding_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (ai_embedding_status IN ('PENDING', 'READY', 'NOT_APPLICABLE')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);
