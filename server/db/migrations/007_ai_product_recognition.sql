-- Phase 08: AI Product Recognition, Embeddings, Settings & Verification Logs

CREATE TABLE IF NOT EXISTS product_image_embeddings (
  image_id TEXT PRIMARY KEY REFERENCES product_images(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_image_embeddings_product
  ON product_image_embeddings(product_id);

CREATE INDEX IF NOT EXISTS idx_product_image_embeddings_provider
  ON product_image_embeddings(provider_id);

CREATE TABLE IF NOT EXISTS recognition_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_provider_id TEXT NOT NULL DEFAULT 'gemini-vision',
  auto_add_high_confidence INTEGER NOT NULL DEFAULT 0 CHECK (auto_add_high_confidence IN (0, 1)),
  high_confidence_threshold REAL NOT NULL DEFAULT 0.85 CHECK (high_confidence_threshold > 0 AND high_confidence_threshold <= 1),
  medium_confidence_threshold REAL NOT NULL DEFAULT 0.55 CHECK (medium_confidence_threshold > 0 AND medium_confidence_threshold < 1),
  low_confidence_threshold REAL NOT NULL DEFAULT 0.35 CHECK (low_confidence_threshold > 0 AND low_confidence_threshold < 1),
  remote_endpoint_url TEXT NOT NULL DEFAULT '',
  request_timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK (request_timeout_ms >= 3000 AND request_timeout_ms <= 60000),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO recognition_settings (
  id,
  active_provider_id,
  auto_add_high_confidence,
  high_confidence_threshold,
  medium_confidence_threshold,
  low_confidence_threshold,
  remote_endpoint_url,
  request_timeout_ms,
  updated_at
) VALUES (
  1,
  'gemini-vision',
  0,
  0.85,
  0.55,
  0.35,
  '',
  15000,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE TABLE IF NOT EXISTS recognition_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT 'POS_CASHIER' CHECK (context IN ('POS_CASHIER', 'STOCK_OPNAME', 'CATALOG_CHECK', 'API')),
  captured_image_url TEXT,
  captured_image_path TEXT,
  image_width INTEGER,
  image_height INTEGER,
  detected_region_json TEXT NOT NULL DEFAULT 'null',
  ocr_json TEXT NOT NULL DEFAULT '{}',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  top_product_id TEXT,
  top_confidence REAL NOT NULL DEFAULT 0,
  confidence_band TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (confidence_band IN ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN')),
  selected_product_id TEXT,
  outcome TEXT NOT NULL DEFAULT 'PENDING' CHECK (outcome IN ('PENDING', 'CONFIRMED', 'CORRECTED', 'REGISTERED_NEW', 'REJECTED', 'ERROR')),
  is_verified_feedback INTEGER NOT NULL DEFAULT 0 CHECK (is_verified_feedback IN (0, 1)),
  notes TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recognition_logs_created_at
  ON recognition_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recognition_logs_outcome
  ON recognition_logs(outcome);

CREATE INDEX IF NOT EXISTS idx_recognition_logs_selected_product
  ON recognition_logs(selected_product_id);
