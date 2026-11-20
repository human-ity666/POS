-- Phase 09+ Feature & Bugfix Updates:
-- 1. Loyalty earn-on-redeem rule flag on loyalty_settings
-- 2. Restrict held transaction cancel/delete (perm-pos-cancel) to Admin & Supervisor only (revoke from role-cashier)

ALTER TABLE loyalty_settings
  ADD COLUMN disable_earn_on_redeem INTEGER NOT NULL DEFAULT 0 CHECK (disable_earn_on_redeem IN (0, 1));

DELETE FROM role_permissions
WHERE role_id = 'role-cashier'
  AND permission_id = 'perm-pos-cancel';
