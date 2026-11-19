ALTER TABLE store_settings ADD COLUMN store_logo_url TEXT NOT NULL DEFAULT '';
ALTER TABLE store_settings ADD COLUMN receipt_paper_width TEXT NOT NULL DEFAULT '80mm' CHECK (receipt_paper_width IN ('58mm', '80mm', 'A4'));
ALTER TABLE store_settings ADD COLUMN receipt_show_logo INTEGER NOT NULL DEFAULT 1 CHECK (receipt_show_logo IN (0, 1));
ALTER TABLE store_settings ADD COLUMN receipt_show_qr INTEGER NOT NULL DEFAULT 1 CHECK (receipt_show_qr IN (0, 1));
ALTER TABLE store_settings ADD COLUMN receipt_header_note TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS receipt_snapshots (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  receipt_number TEXT NOT NULL UNIQUE,
  verification_token TEXT NOT NULL,
  store_name TEXT NOT NULL,
  store_address TEXT NOT NULL,
  store_phone TEXT NOT NULL,
  store_logo_url TEXT NOT NULL DEFAULT '',
  receipt_header_note TEXT NOT NULL DEFAULT '',
  receipt_footer TEXT NOT NULL DEFAULT '',
  tax_rate NUMERIC NOT NULL DEFAULT 0,
  print_count INTEGER NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  last_printed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_print_logs (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  copy_number INTEGER NOT NULL CHECK (copy_number >= 1),
  print_type TEXT NOT NULL CHECK (print_type IN ('ORIGINAL', 'REPRINT')),
  layout_format TEXT NOT NULL CHECK (layout_format IN ('58mm', '80mm', 'A4', 'DIGITAL')),
  driver_id TEXT NOT NULL DEFAULT 'browser-dialog',
  printed_by_user_id TEXT,
  printed_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipt_print_logs_trx
  ON receipt_print_logs(transaction_id, created_at DESC);

-- Backfill immutable receipt snapshots for existing COMPLETED transactions
INSERT OR IGNORE INTO receipt_snapshots (
  transaction_id,
  receipt_number,
  verification_token,
  store_name,
  store_address,
  store_phone,
  store_logo_url,
  receipt_header_note,
  receipt_footer,
  tax_rate,
  print_count,
  last_printed_at,
  created_at
)
SELECT
  t.id,
  t.invoice_number,
  lower(hex(randomblob(8))),
  COALESCE((SELECT store_name FROM store_settings WHERE id = 1), 'KassaRitel'),
  COALESCE((SELECT store_address FROM store_settings WHERE id = 1), ''),
  COALESCE((SELECT store_phone FROM store_settings WHERE id = 1), ''),
  COALESCE((SELECT store_logo_url FROM store_settings WHERE id = 1), ''),
  COALESCE((SELECT receipt_header_note FROM store_settings WHERE id = 1), ''),
  COALESCE((SELECT receipt_footer FROM store_settings WHERE id = 1), ''),
  COALESCE((SELECT tax_rate FROM store_settings WHERE id = 1), 11),
  1,
  COALESCE(t.completed_at, t.created_at),
  COALESCE(t.completed_at, t.created_at)
FROM transactions t
WHERE t.status = 'COMPLETED';
