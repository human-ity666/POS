-- Store-wide Buka/Tutup Toko defaults and separate Buka Toko / Tutup Toko permissions

-- Enforce Buka Toko before sales/hold transactions by default
UPDATE shift_settings
SET require_open_shift_for_sales = 1,
    updated_at = datetime('now')
WHERE id = 1;

-- Ensure shifts:close permission exists and backfill roles that currently have shifts:open
INSERT OR IGNORE INTO permissions (id, code, module, action, label, description)
VALUES (
  'perm-shf-close',
  'shifts:close',
  'Buka/Tutup Toko & Kas',
  'execute',
  'Tutup Toko',
  'Menutup operasional toko dan melakukan rekonsiliasi kas fisik'
);

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, 'perm-shf-close'
FROM role_permissions rp
INNER JOIN permissions p ON p.id = rp.permission_id
WHERE p.code = 'shifts:open';
