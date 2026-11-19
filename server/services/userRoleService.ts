import { getDb } from '../db/database.ts';
import { hashSecret } from '../utils/crypto.ts';
import { recordAuditLog } from './auditService.ts';
import { loadUserSummary } from './authService.ts';
import { ServiceError } from './errors.ts';
import type { Permission, Role, UserSummary } from '../../src/types.ts';

export function listUsers(): UserSummary[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT id FROM users ORDER BY created_at DESC')
    .all() as Array<{ id: string }>;
  return rows
    .map((r) => loadUserSummary(db, r.id))
    .filter((u): u is UserSummary => u !== null);
}

export function getUserDetail(userId: string): UserSummary {
  const db = getDb();
  const user = loadUserSummary(db, userId);
  if (!user) {
    throw new ServiceError(404, 'Pengguna tidak ditemukan.');
  }
  return user;
}

export function createUser(
  input: {
    username?: unknown;
    email?: unknown;
    fullName?: unknown;
    password?: unknown;
    pin?: unknown;
    roleIds?: unknown;
    isActive?: unknown;
  },
  actor: UserSummary
): UserSummary {
  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const fullName = typeof input.fullName === 'string' ? input.fullName.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const pin = typeof input.pin === 'string' ? input.pin.trim() : '';

  if (!username || username.length < 3 || !/^[a-z0-9._-]+$/.test(username)) {
    throw new ServiceError(
      400,
      'Username minimal 3 karakter (hanya huruf, angka, titik, underscore, atau strip).'
    );
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ServiceError(400, 'Format email tidak valid.');
  }
  if (!fullName) {
    throw new ServiceError(400, 'Nama lengkap wajib diisi.');
  }
  if (password.length < 6) {
    throw new ServiceError(400, 'Kata sandi minimal 6 karakter.');
  }
  if (pin && !/^\d{4,6}$/.test(pin)) {
    throw new ServiceError(400, 'PIN harus berupa 4 hingga 6 digit angka.');
  }

  const roleIds = Array.isArray(input.roleIds)
    ? input.roleIds.filter((r): r is string => typeof r === 'string' && r.length > 0)
    : [];
  if (roleIds.length === 0) {
    throw new ServiceError(400, 'Pengguna harus memiliki minimal satu role.');
  }

  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .get(username, email) as { id: string } | undefined;
  if (existing) {
    throw new ServiceError(409, 'Username atau email sudah digunakan.');
  }

  const roleCheck = db.prepare('SELECT id FROM roles WHERE id = ?');
  for (const rid of roleIds) {
    if (!roleCheck.get(rid)) {
      throw new ServiceError(400, `Role "${rid}" tidak ditemukan.`);
    }
  }

  const nowIso = new Date().toISOString();
  const userId = `usr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const isActive = input.isActive === false ? 0 : 1;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO users (id, username, email, full_name, password_hash, pin_hash, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      username,
      email,
      fullName,
      hashSecret(password),
      pin ? hashSecret(pin) : null,
      isActive,
      nowIso,
      nowIso
    );

    const insertUserRole = db.prepare(
      'INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, ?, ?)'
    );
    for (const rid of new Set(roleIds)) {
      insertUserRole.run(userId, rid, nowIso);
    }

    recordAuditLog(db, {
      action: 'USER_CREATED',
      entityType: 'user',
      entityId: userId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Buat akun baru "${username}" (${fullName})`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getUserDetail(userId);
}

export function updateUser(
  userId: string,
  input: {
    username?: unknown;
    email?: unknown;
    fullName?: unknown;
    roleIds?: unknown;
  },
  actor: UserSummary
): UserSummary {
  const db = getDb();
  const current = loadUserSummary(db, userId);
  if (!current) {
    throw new ServiceError(404, 'Pengguna tidak ditemukan.');
  }

  const username =
    input.username !== undefined ? String(input.username).trim().toLowerCase() : current.username;
  const email =
    input.email !== undefined ? String(input.email).trim().toLowerCase() : current.email;
  const fullName =
    input.fullName !== undefined ? String(input.fullName).trim() : current.fullName;

  if (!username || username.length < 3 || !/^[a-z0-9._-]+$/.test(username)) {
    throw new ServiceError(400, 'Format username tidak valid.');
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ServiceError(400, 'Format email tidak valid.');
  }
  if (!fullName) {
    throw new ServiceError(400, 'Nama lengkap wajib diisi.');
  }

  const duplicate = db
    .prepare('SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?')
    .get(username, email, userId) as { id: string } | undefined;
  if (duplicate) {
    throw new ServiceError(409, 'Username atau email sudah dipakai akun lain.');
  }

  const nextRoleIds = Array.isArray(input.roleIds)
    ? input.roleIds.filter((r): r is string => typeof r === 'string' && r.length > 0)
    : current.roles.map((r) => r.id);

  if (nextRoleIds.length === 0) {
    throw new ServiceError(400, 'Pengguna harus memiliki minimal satu role.');
  }

  const nowIso = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE users SET username = ?, email = ?, full_name = ?, updated_at = ? WHERE id = ?
    `).run(username, email, fullName, nowIso, userId);

    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
    const insertRole = db.prepare(
      'INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, ?, ?)'
    );
    for (const rid of new Set(nextRoleIds)) {
      insertRole.run(userId, rid, nowIso);
    }

    recordAuditLog(db, {
      action: 'USER_UPDATED',
      entityType: 'user',
      entityId: userId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Perbarui profil/role pengguna "${username}"`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getUserDetail(userId);
}

export function setUserActiveStatus(
  userId: string,
  isActive: boolean,
  actor: UserSummary
): UserSummary {
  if (userId === actor.id && !isActive) {
    throw new ServiceError(400, 'Anda tidak dapat menonaktifkan akun Anda sendiri.');
  }
  const db = getDb();
  const target = loadUserSummary(db, userId);
  if (!target) {
    throw new ServiceError(404, 'Pengguna tidak ditemukan.');
  }

  const nowIso = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?').run(
      isActive ? 1 : 0,
      nowIso,
      userId
    );
    if (!isActive) {
      db.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').run(
        nowIso,
        userId
      );
    }
    recordAuditLog(db, {
      action: 'USER_STATUS_CHANGED',
      entityType: 'user',
      entityId: userId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `${isActive ? 'Aktifkan' : 'Nonaktifkan'} akun "${target.username}"`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getUserDetail(userId);
}

export function resetUserPasswordOrPin(
  userId: string,
  input: { newPassword?: unknown; newPin?: unknown },
  actor: UserSummary
): UserSummary {
  const newPassword = typeof input.newPassword === 'string' ? input.newPassword : '';
  const newPin = typeof input.newPin === 'string' ? input.newPin.trim() : undefined;

  if (!newPassword && newPin === undefined) {
    throw new ServiceError(400, 'Masukkan kata sandi baru atau PIN baru.');
  }
  if (newPassword && newPassword.length < 6) {
    throw new ServiceError(400, 'Kata sandi baru minimal 6 karakter.');
  }
  if (newPin && !/^\d{4,6}$/.test(newPin)) {
    throw new ServiceError(400, 'PIN harus berupa 4 hingga 6 digit angka.');
  }

  const db = getDb();
  const target = loadUserSummary(db, userId);
  if (!target) {
    throw new ServiceError(404, 'Pengguna tidak ditemukan.');
  }

  const nowIso = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE;');
  try {
    if (newPassword) {
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
        hashSecret(newPassword),
        nowIso,
        userId
      );
    }
    if (newPin !== undefined) {
      db.prepare('UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?').run(
        newPin ? hashSecret(newPin) : null,
        nowIso,
        userId
      );
    }

    recordAuditLog(db, {
      action: 'PASSWORD_RESET',
      entityType: 'user',
      entityId: userId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Reset ${newPassword ? 'kata sandi' : ''}${newPassword && newPin !== undefined ? ' & ' : ''}${newPin !== undefined ? 'PIN' : ''} untuk "${target.username}"`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getUserDetail(userId);
}

export function listPermissions(): Permission[] {
  const db = getDb();
  return db
    .prepare('SELECT id, code, module, action, label, description FROM permissions ORDER BY module, code')
    .all() as unknown as Permission[];
}

export function listRoles(): Role[] {
  const db = getDb();
  const roleRows = db
    .prepare('SELECT id, name, description, is_system, created_at FROM roles ORDER BY is_system DESC, name ASC')
    .all() as Array<{
    id: string;
    name: string;
    description: string;
    is_system: number;
    created_at: string;
  }>;

  const permStmt = db.prepare(`
    SELECT p.code
    FROM permissions p
    INNER JOIN role_permissions rp ON rp.permission_id = p.id
    WHERE rp.role_id = ?
  `);
  const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM user_roles WHERE role_id = ?');

  return roleRows.map((r) => {
    const perms = permStmt.all(r.id) as Array<{ code: string }>;
    const cnt = countStmt.get(r.id) as { cnt: number };
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      isSystem: r.is_system === 1,
      permissionCodes: perms.map((p) => p.code),
      userCount: cnt.cnt,
      createdAt: r.created_at,
    };
  });
}

export function createRole(
  input: { name?: unknown; description?: unknown; permissionCodes?: unknown },
  actor: UserSummary
): Role {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!name || name.length < 2) {
    throw new ServiceError(400, 'Nama role wajib diisi (minimal 2 karakter).');
  }

  const db = getDb();
  const exists = db.prepare('SELECT id FROM roles WHERE name = ?').get(name) as { id: string } | undefined;
  if (exists) {
    throw new ServiceError(409, `Role "${name}" sudah ada.`);
  }

  const roleId = `role-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const nowIso = new Date().toISOString();
  const codes = Array.isArray(input.permissionCodes)
    ? input.permissionCodes.filter((c): c is string => typeof c === 'string')
    : [];

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('INSERT INTO roles (id, name, description, is_system, created_at) VALUES (?, ?, ?, 0, ?)').run(
      roleId,
      name,
      description || `Role kustom ${name}`,
      nowIso
    );

    const findPerm = db.prepare('SELECT id FROM permissions WHERE code = ?');
    const insertRp = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    for (const code of codes) {
      const p = findPerm.get(code) as { id: string } | undefined;
      if (p) insertRp.run(roleId, p.id);
    }

    recordAuditLog(db, {
      action: 'ROLE_CREATED',
      entityType: 'role',
      entityId: roleId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Buat role baru "${name}" dengan ${codes.length} izin`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const created = listRoles().find((r) => r.id === roleId);
  if (!created) throw new ServiceError(500, 'Gagal memuat role baru.');
  return created;
}

export function updateRolePermissions(
  roleId: string,
  input: { name?: unknown; description?: unknown; permissionCodes?: unknown },
  actor: UserSummary
): Role {
  const db = getDb();
  const existing = db
    .prepare('SELECT id, name, description, is_system FROM roles WHERE id = ?')
    .get(roleId) as
    | { id: string; name: string; description: string; is_system: number }
    | undefined;

  if (!existing) {
    throw new ServiceError(404, 'Role tidak ditemukan.');
  }

  const nextName =
    existing.is_system === 1
      ? existing.name
      : input.name !== undefined && String(input.name).trim()
      ? String(input.name).trim()
      : existing.name;
  const nextDescription =
    input.description !== undefined ? String(input.description).trim() : existing.description;

  const codes = Array.isArray(input.permissionCodes)
    ? input.permissionCodes.filter((c): c is string => typeof c === 'string')
    : null;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('UPDATE roles SET name = ?, description = ? WHERE id = ?').run(
      nextName,
      nextDescription,
      roleId
    );

    if (codes !== null) {
      db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
      const findPerm = db.prepare('SELECT id FROM permissions WHERE code = ?');
      const insertRp = db.prepare(
        'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
      );
      for (const code of codes) {
        const p = findPerm.get(code) as { id: string } | undefined;
        if (p) insertRp.run(roleId, p.id);
      }
    }

    recordAuditLog(db, {
      action: 'ROLE_PERMISSIONS_UPDATED',
      entityType: 'permission',
      entityId: roleId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Perbarui konfigurasi role "${nextName}"${codes ? ` (${codes.length} izin aktif)` : ''}`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const updated = listRoles().find((r) => r.id === roleId);
  if (!updated) throw new ServiceError(500, 'Gagal memuat role.');
  return updated;
}

export function deleteRole(roleId: string, actor: UserSummary): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT id, name, is_system FROM roles WHERE id = ?')
    .get(roleId) as { id: string; name: string; is_system: number } | undefined;

  if (!existing) {
    throw new ServiceError(404, 'Role tidak ditemukan.');
  }
  if (existing.is_system === 1) {
    throw new ServiceError(400, `Role bawaan sistem "${existing.name}" tidak dapat dihapus.`);
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
    recordAuditLog(db, {
      action: 'ROLE_DELETED',
      entityType: 'role',
      entityId: roleId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Hapus role kustom "${existing.name}"`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}
