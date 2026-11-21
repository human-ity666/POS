-- Allow 'item_cancel' in pin_authorizations.action CHECK constraint for Batalkan Item PIN override

CREATE TABLE pin_authorizations_new (
  id TEXT PRIMARY KEY,
  authorizer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('discount_approval', 'price_override', 'void', 'refund', 'stock_adjustment', 'item_cancel')),
  reason TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO pin_authorizations_new (
  id, authorizer_user_id, requested_by_user_id, action, reason, token_hash, expires_at, used_at, created_at
)
SELECT
  id, authorizer_user_id, requested_by_user_id, action, reason, token_hash, expires_at, used_at, created_at
FROM pin_authorizations;

DROP TABLE pin_authorizations;

ALTER TABLE pin_authorizations_new RENAME TO pin_authorizations;
