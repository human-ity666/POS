import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.ts';
import { generateOpaqueToken, hashToken, verifySecret, hashSecret } from '../utils/crypto.ts';
import { recordAuditLog } from './auditService.ts';
import { ServiceError } from './errors.ts';
import type { PinSensitiveAction, SessionInfo, UserSummary } from '../../src/types.ts';

const ACCESS_TTL_MS = 30 * 60 * 1000; // 30 minutes
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PIN_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

const PIN_ACTION_REQUIRED_PERMISSION: Record<PinSensitiveAction, string> = {
  discount_approval: 'pos:discount_approve',
  price_override: 'pos:price_override',
  void: 'pos:void',
  refund: 'pos:refund',
  stock_adjustment: 'stock:adjust',
};

interface DbUserRow {
  id: string;
  username: string;
  email: string;
  full_name: string;
  password_hash: string;
  pin_hash: string | null;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export function loadUserSummary(db: DatabaseSync, userId: string): UserSummary | null {
  const row = db
    .prepare(`
      SELECT id, username, email, full_name, pin_hash, is_active, last_login_at, created_at, updated_at
      FROM users
      WHERE id = ?
    `)
    .get(userId) as Omit<DbUserRow, 'password_hash'> | undefined;

  if (!row) return null;

  const roles = db
    .prepare(`
      SELECT r.id, r.name
      FROM roles r
      INNER JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ?
      ORDER BY r.name ASC
    `)
    .all(userId) as Array<{ id: string; name: string }>;

  const permRows = db
    .prepare(`
      SELECT DISTINCT p.code
      FROM permissions p
      INNER JOIN role_permissions rp ON rp.permission_id = p.id
      INNER JOIN user_roles ur ON ur.role_id = rp.role_id
      WHERE ur.user_id = ?
      ORDER BY p.code ASC
    `)
    .all(userId) as Array<{ code: string }>;

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    fullName: row.full_name,
    isActive: row.is_active === 1,
    hasPin: Boolean(row.pin_hash),
    roles,
    permissions: permRows.map((p) => p.code),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function loginWithCredentials(params: {
  identifier: string;
  password: string;
  userAgent: string;
  ipAddress: string;
}): {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  sessionId: string;
  user: UserSummary;
} {
  const identifier = params.identifier.trim();
  const password = params.password;

  if (!identifier || !password) {
    throw new ServiceError(400, 'Username/email dan kata sandi wajib diisi.');
  }

  const db = getDb();
  const userRow = db
    .prepare(`
      SELECT id, username, email, full_name, password_hash, pin_hash, is_active, last_login_at, created_at, updated_at
      FROM users
      WHERE username = ? OR email = ?
    `)
    .get(identifier, identifier) as DbUserRow | undefined;

  if (!userRow) {
    recordAuditLog(db, {
      action: 'LOGIN_FAILED',
      entityType: 'auth',
      entityId: identifier,
      actor: identifier,
      summary: `Percobaan login gagal untuk "${identifier}" (akun tidak ditemukan)`,
    });
    throw new ServiceError(401, 'Username/email atau kata sandi salah.');
  }

  if (!verifySecret(password, userRow.password_hash)) {
    recordAuditLog(db, {
      action: 'LOGIN_FAILED',
      entityType: 'auth',
      entityId: userRow.id,
      actorUserId: userRow.id,
      actor: userRow.username,
      summary: `Percobaan login gagal untuk "${userRow.username}" (kata sandi salah)`,
    });
    throw new ServiceError(401, 'Username/email atau kata sandi salah.');
  }

  if (userRow.is_active !== 1) {
    recordAuditLog(db, {
      action: 'LOGIN_FAILED',
      entityType: 'auth',
      entityId: userRow.id,
      actorUserId: userRow.id,
      actor: userRow.username,
      summary: `Percobaan login ditolak karena akun "${userRow.username}" nonaktif`,
    });
    throw new ServiceError(403, 'Akun Anda sedang dinonaktifkan. Hubungi Admin.');
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + ACCESS_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(now + REFRESH_TTL_MS).toISOString();

  const sessionId = `ses-${now}-${Math.random().toString(36).slice(2, 7)}`;
  const accessToken = generateOpaqueToken(32);
  const refreshToken = generateOpaqueToken(32);

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO sessions (
        id, user_id, token_hash, refresh_token_hash, user_agent, ip_address,
        login_at, last_activity_at, expires_at, refresh_expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      sessionId,
      userRow.id,
      hashToken(accessToken),
      hashToken(refreshToken),
      params.userAgent.slice(0, 240),
      params.ipAddress.slice(0, 64),
      nowIso,
      nowIso,
      expiresAt,
      refreshExpiresAt
    );

    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso, userRow.id);

    recordAuditLog(db, {
      action: 'LOGIN_SUCCESS',
      entityType: 'auth',
      entityId: sessionId,
      actorUserId: userRow.id,
      actor: userRow.full_name,
      summary: `Login berhasil (${userRow.username})`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const user = loadUserSummary(db, userRow.id);
  if (!user) {
    throw new ServiceError(500, 'Gagal memuat profil pengguna.');
  }

  return { accessToken, refreshToken, expiresAt, sessionId, user };
}

export function authenticateAccessToken(accessToken: string): {
  user: UserSummary;
  sessionId: string;
} {
  if (!accessToken) {
    throw new ServiceError(401, 'Sesi tidak ditemukan. Silakan login kembali.');
  }
  const db = getDb();
  const tokenHash = hashToken(accessToken);

  const session = db
    .prepare(`
      SELECT id, user_id, expires_at, revoked_at
      FROM sessions
      WHERE token_hash = ?
    `)
    .get(tokenHash) as
    | { id: string; user_id: string; expires_at: string; revoked_at: string | null }
    | undefined;

  if (!session || session.revoked_at) {
    throw new ServiceError(401, 'Sesi tidak valid atau sudah diakhiri.');
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    throw new ServiceError(401, 'Sesi telah kedaluwarsa. Memerlukan refresh atau login ulang.', 'TOKEN_EXPIRED');
  }

  const user = loadUserSummary(db, session.user_id);
  if (!user || !user.isActive) {
    throw new ServiceError(403, 'Akun pengguna tidak aktif atau tidak ditemukan.');
  }

  db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    session.id
  );

  return { user, sessionId: session.id };
}

export function refreshSessionTokens(params: {
  refreshToken: string;
  userAgent: string;
  ipAddress: string;
}): {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  sessionId: string;
  user: UserSummary;
} {
  if (!params.refreshToken) {
    throw new ServiceError(401, 'Refresh token tidak ditemukan.');
  }

  const db = getDb();
  const refreshHash = hashToken(params.refreshToken);
  const session = db
    .prepare(`
      SELECT id, user_id, refresh_expires_at, revoked_at
      FROM sessions
      WHERE refresh_token_hash = ?
    `)
    .get(refreshHash) as
    | { id: string; user_id: string; refresh_expires_at: string; revoked_at: string | null }
    | undefined;

  if (!session || session.revoked_at) {
    throw new ServiceError(401, 'Sesi refresh tidak valid atau telah dicabut.');
  }

  if (new Date(session.refresh_expires_at).getTime() <= Date.now()) {
    throw new ServiceError(401, 'Sesi refresh telah kedaluwarsa. Silakan login kembali.');
  }

  const user = loadUserSummary(db, session.user_id);
  if (!user || !user.isActive) {
    throw new ServiceError(403, 'Akun pengguna dinonaktifkan.');
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + ACCESS_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(now + REFRESH_TTL_MS).toISOString();
  const newAccessToken = generateOpaqueToken(32);
  const newRefreshToken = generateOpaqueToken(32);

  db.prepare(`
    UPDATE sessions
    SET token_hash = ?,
        refresh_token_hash = ?,
        last_activity_at = ?,
        expires_at = ?,
        refresh_expires_at = ?,
        user_agent = ?,
        ip_address = ?
    WHERE id = ?
  `).run(
    hashToken(newAccessToken),
    hashToken(newRefreshToken),
    nowIso,
    expiresAt,
    refreshExpiresAt,
    params.userAgent.slice(0, 240),
    params.ipAddress.slice(0, 64),
    session.id
  );

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresAt,
    sessionId: session.id,
    user,
  };
}

export function logoutSession(params: { accessToken?: string; refreshToken?: string }): void {
  const db = getDb();
  let sessionRow:
    | { id: string; user_id: string }
    | undefined;

  if (params.accessToken) {
    sessionRow = db
      .prepare('SELECT id, user_id FROM sessions WHERE token_hash = ?')
      .get(hashToken(params.accessToken)) as { id: string; user_id: string } | undefined;
  }
  if (!sessionRow && params.refreshToken) {
    sessionRow = db
      .prepare('SELECT id, user_id FROM sessions WHERE refresh_token_hash = ?')
      .get(hashToken(params.refreshToken)) as { id: string; user_id: string } | undefined;
  }

  if (!sessionRow) return;

  const user = loadUserSummary(db, sessionRow.user_id);
  const nowIso = new Date().toISOString();

  db.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(
    nowIso,
    sessionRow.id
  );

  recordAuditLog(db, {
    action: 'LOGOUT',
    entityType: 'auth',
    entityId: sessionRow.id,
    actorUserId: sessionRow.user_id,
    actor: user?.fullName || sessionRow.user_id,
    summary: `Logout dari sesi ${sessionRow.id}`,
  });
}

export function verifyPinAuthorization(params: {
  authorizerIdentifier: string;
  pin: string;
  action: PinSensitiveAction;
  reason?: string;
  requestedBy: UserSummary;
}): {
  pinApprovalToken: string;
  expiresAt: string;
  authorizerName: string;
  action: PinSensitiveAction;
} {
  const identifier = params.authorizerIdentifier.trim();
  const pin = params.pin.trim();
  const requiredPerm = PIN_ACTION_REQUIRED_PERMISSION[params.action];

  if (!requiredPerm) {
    throw new ServiceError(400, 'Jenis aksi otorisasi PIN tidak dikenal.');
  }
  if (!identifier || !pin) {
    throw new ServiceError(400, 'Username/email penyetuju dan PIN wajib diisi.');
  }

  const db = getDb();
  const authorizerRow = db
    .prepare(`
      SELECT id, username, full_name, pin_hash, is_active
      FROM users
      WHERE username = ? OR email = ?
    `)
    .get(identifier, identifier) as
    | { id: string; username: string; full_name: string; pin_hash: string | null; is_active: number }
    | undefined;

  if (!authorizerRow || authorizerRow.is_active !== 1) {
    recordAuditLog(db, {
      action: 'PIN_AUTHORIZATION_FAILED',
      entityType: 'auth',
      entityId: params.action,
      actorUserId: params.requestedBy.id,
      actor: params.requestedBy.fullName,
      summary: `Otorisasi PIN ${params.action} gagal: akun "${identifier}" tidak valid atau nonaktif`,
    });
    throw new ServiceError(401, 'Akun penyetuju tidak ditemukan atau tidak aktif.');
  }

  const authorizerSummary = loadUserSummary(db, authorizerRow.id);
  if (!authorizerSummary || !authorizerSummary.permissions.includes(requiredPerm)) {
    recordAuditLog(db, {
      action: 'PIN_AUTHORIZATION_FAILED',
      entityType: 'auth',
      entityId: params.action,
      actorUserId: authorizerRow.id,
      actor: authorizerRow.full_name,
      summary: `Otorisasi PIN ${params.action} ditolak: ${authorizerRow.username} tidak memiliki izin ${requiredPerm}`,
    });
    throw new ServiceError(403, `Akun "${authorizerRow.username}" tidak memiliki izin untuk aksi ini.`);
  }

  if (!authorizerRow.pin_hash || !verifySecret(pin, authorizerRow.pin_hash)) {
    recordAuditLog(db, {
      action: 'PIN_AUTHORIZATION_FAILED',
      entityType: 'auth',
      entityId: params.action,
      actorUserId: authorizerRow.id,
      actor: authorizerRow.full_name,
      summary: `PIN salah saat otorisasi ${params.action} oleh ${authorizerRow.username}`,
    });
    throw new ServiceError(401, 'PIN otorisasi salah atau belum diatur.');
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + PIN_TOKEN_TTL_MS).toISOString();
  const rawToken = generateOpaqueToken(24);
  const authId = `pin-${now}-${Math.random().toString(36).slice(2, 6)}`;
  const reasonText = params.reason?.trim() || `Otorisasi ${params.action}`;

  db.prepare(`
    INSERT INTO pin_authorizations (
      id, authorizer_user_id, requested_by_user_id, action, reason, token_hash, expires_at, used_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    authId,
    authorizerRow.id,
    params.requestedBy.id,
    params.action,
    reasonText,
    hashToken(rawToken),
    expiresAt,
    nowIso
  );

  recordAuditLog(db, {
    action: 'PIN_AUTHORIZATION_SUCCESS',
    entityType: 'auth',
    entityId: authId,
    actorUserId: authorizerRow.id,
    actor: authorizerRow.full_name,
    summary: `Otorisasi PIN ${params.action} disetujui oleh ${authorizerRow.full_name} untuk ${params.requestedBy.fullName} (${reasonText})`,
  });

  return {
    pinApprovalToken: rawToken,
    expiresAt,
    authorizerName: authorizerRow.full_name,
    action: params.action,
  };
}

export function consumePinApprovalToken(
  db: DatabaseSync,
  rawToken: string,
  expectedAction: PinSensitiveAction
): { authorizerUserId: string } {
  const tokenHash = hashToken(rawToken);
  const row = db
    .prepare(`
      SELECT id, authorizer_user_id, action, expires_at, used_at
      FROM pin_authorizations
      WHERE token_hash = ?
    `)
    .get(tokenHash) as
    | {
        id: string;
        authorizer_user_id: string;
        action: PinSensitiveAction;
        expires_at: string;
        used_at: string | null;
      }
    | undefined;

  if (!row || row.action !== expectedAction) {
    throw new ServiceError(403, 'Token otorisasi PIN tidak valid.');
  }
  if (row.used_at) {
    throw new ServiceError(403, 'Token otorisasi PIN sudah pernah digunakan.');
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new ServiceError(403, 'Token otorisasi PIN sudah kedaluwarsa.');
  }

  db.prepare('UPDATE pin_authorizations SET used_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    row.id
  );
  return { authorizerUserId: row.authorizer_user_id };
}

export function listSessions(viewer: UserSummary, currentSessionId: string): SessionInfo[] {
  const db = getDb();
  const canViewAll = viewer.permissions.includes('sessions:view');

  const rows = (
    canViewAll
      ? db
          .prepare(`
            SELECT s.id, s.user_id, u.username, u.full_name, s.user_agent, s.ip_address,
                   s.login_at, s.last_activity_at, s.expires_at, s.revoked_at
            FROM sessions s
            INNER JOIN users u ON u.id = s.user_id
            ORDER BY s.login_at DESC
            LIMIT 100
          `)
          .all()
      : db
          .prepare(`
            SELECT s.id, s.user_id, u.username, u.full_name, s.user_agent, s.ip_address,
                   s.login_at, s.last_activity_at, s.expires_at, s.revoked_at
            FROM sessions s
            INNER JOIN users u ON u.id = s.user_id
            WHERE s.user_id = ?
            ORDER BY s.login_at DESC
            LIMIT 30
          `)
          .all(viewer.id)
  ) as Array<{
    id: string;
    user_id: string;
    username: string;
    full_name: string;
    user_agent: string;
    ip_address: string;
    login_at: string;
    last_activity_at: string;
    expires_at: string;
    revoked_at: string | null;
  }>;

  const roleStmt = db.prepare(`
    SELECT r.name FROM roles r
    INNER JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ?
  `);

  return rows.map((r) => {
    const roles = roleStmt.all(r.user_id) as Array<{ name: string }>;
    return {
      id: r.id,
      userId: r.user_id,
      username: r.username,
      fullName: r.full_name,
      roleNames: roles.map((x) => x.name),
      userAgent: r.user_agent,
      ipAddress: r.ip_address,
      loginAt: r.login_at,
      lastActivityAt: r.last_activity_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      isCurrent: r.id === currentSessionId,
    };
  });
}

export function revokeSessionById(sessionId: string, actor: UserSummary): void {
  const db = getDb();
  const target = db
    .prepare('SELECT id, user_id, revoked_at FROM sessions WHERE id = ?')
    .get(sessionId) as { id: string; user_id: string; revoked_at: string | null } | undefined;

  if (!target) {
    throw new ServiceError(404, 'Sesi tidak ditemukan.');
  }

  const isOwn = target.user_id === actor.id;
  if (!isOwn && !actor.permissions.includes('sessions:revoke')) {
    throw new ServiceError(403, 'Anda tidak memiliki izin untuk memutus sesi pengguna lain.');
  }

  if (!target.revoked_at) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      target.id
    );
    recordAuditLog(db, {
      action: 'SESSION_REVOKED',
      entityType: 'session',
      entityId: target.id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Sesi ${target.id} dihentikan oleh ${actor.fullName}`,
    });
  }
}

export function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): void {
  if (!currentPassword || newPassword.length < 6) {
    throw new ServiceError(400, 'Kata sandi baru minimal 6 karakter.');
  }
  const db = getDb();
  const row = db
    .prepare('SELECT id, username, full_name, password_hash FROM users WHERE id = ?')
    .get(userId) as
    | { id: string; username: string; full_name: string; password_hash: string }
    | undefined;

  if (!row || !verifySecret(currentPassword, row.password_hash)) {
    throw new ServiceError(401, 'Kata sandi saat ini salah.');
  }

  const nowIso = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hashSecret(newPassword),
    nowIso,
    userId
  );

  recordAuditLog(db, {
    action: 'PASSWORD_RESET',
    entityType: 'user',
    entityId: userId,
    actorUserId: userId,
    actor: row.full_name,
    summary: `Pengguna ${row.username} mengubah kata sandinya sendiri`,
  });
}
