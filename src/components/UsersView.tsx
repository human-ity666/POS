import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Edit3,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  Search,
  UserCheck,
  UserCog,
  UserX,
  X,
} from 'lucide-react';
import type { Role, UserSummary } from '../types';
import { apiFetch, ApiError } from '../utils/api';
import { formatDateTime } from '../utils/format';

interface UsersViewProps {
  currentUser: UserSummary;
}

export function UsersView({ currentUser }: UsersViewProps) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  const [formModalOpen, setFormModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserSummary | null>(null);
  const [detailUser, setDetailUser] = useState<UserSummary | null>(null);
  const [resetTargetUser, setResetTargetUser] = useState<UserSummary | null>(null);

  const canCreate = currentUser.permissions.includes('users:create');
  const canEdit = currentUser.permissions.includes('users:edit');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [usersRes, rolesRes] = await Promise.all([
        apiFetch<{ users: UserSummary[] }>('/api/users'),
        currentUser.permissions.includes('roles:view')
          ? apiFetch<{ roles: Role[] }>('/api/roles')
          : Promise.resolve({ roles: [] }),
      ]);
      setUsers(usersRes.users);
      setRoles(rolesRes.roles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal memuat daftar pengguna.');
    } finally {
      setLoading(false);
    }
  }, [currentUser.permissions]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter === 'ACTIVE' && !u.isActive) return false;
      if (statusFilter === 'INACTIVE' && u.isActive) return false;
      if (roleFilter !== 'ALL' && !u.roles.some((r) => r.name === roleFilter)) return false;
      if (!q) return true;
      return (
        u.fullName.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q)
      );
    });
  }, [users, search, roleFilter, statusFilter]);

  const availableRoleNames = useMemo(() => {
    const set = new Set<string>();
    users.forEach((u) => u.roles.forEach((r) => set.add(r.name)));
    roles.forEach((r) => set.add(r.name));
    return Array.from(set).sort();
  }, [users, roles]);

  const handleToggleStatus = async (user: UserSummary) => {
    setError(null);
    try {
      const res = await apiFetch<{ user: UserSummary }>(`/api/users/${user.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      setUsers((prev) => prev.map((u) => (u.id === res.user.id ? res.user : u)));
      if (detailUser?.id === res.user.id) setDetailUser(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal mengubah status pengguna.');
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-xl flex items-center justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="font-semibold">
            Tutup
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[260px]">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari nama, username, atau email..."
              className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            aria-label="Filter role"
            className="text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-600"
          >
            <option value="ALL">Semua Role</option>
            {availableRoleNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(
              [
                { id: 'ALL', label: 'Semua' },
                { id: 'ACTIVE', label: 'Aktif' },
                { id: 'INACTIVE', label: 'Nonaktif' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  statusFilter === tab.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {canCreate && (
          <button
            type="button"
            onClick={() => {
              setEditingUser(null);
              setFormModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            Tambah Pengguna
          </button>
        )}
      </div>

      {/* Users Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                <th className="py-3 px-4">Nama & Username</th>
                <th className="py-3 px-4">Email</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Login Terakhir</th>
                <th className="py-3 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-500">
                    Memuat daftar pengguna...
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-500">
                    Tidak ada pengguna yang sesuai filter.
                  </td>
                </tr>
              ) : (
                filteredUsers.map((user) => (
                  <tr key={user.id} className="hover:bg-slate-50/70">
                    <td className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => setDetailUser(user)}
                        className="text-left group"
                      >
                        <p className="font-semibold text-slate-900 group-hover:text-teal-700">
                          {user.fullName}
                        </p>
                        <p className="font-mono text-[11px] text-slate-500 mt-0.5">
                          @{user.username}
                          {user.hasPin ? ' · PIN Aktif' : ''}
                        </p>
                      </button>
                    </td>
                    <td className="py-3 px-4 text-slate-600">{user.email}</td>
                    <td className="py-3 px-4 text-slate-800 font-medium">
                      {user.roles.map((r) => r.name).join(', ')}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span
                        className={`font-semibold ${
                          user.isActive ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {user.isActive ? 'Aktif' : 'Nonaktif'}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                      {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Belum pernah login'}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setDetailUser(user)}
                          title="Detail Pengguna"
                          className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md"
                          aria-label={`Detail ${user.username}`}
                        >
                          <UserCog className="w-4 h-4" />
                        </button>
                        {canEdit && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingUser(user);
                                setFormModalOpen(true);
                              }}
                              title="Edit Pengguna"
                              className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md"
                              aria-label={`Edit ${user.username}`}
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setResetTargetUser(user)}
                              title="Reset Password / PIN"
                              className="p-1.5 text-slate-600 hover:text-teal-800 hover:bg-teal-50 rounded-md"
                              aria-label={`Reset password ${user.username}`}
                            >
                              <KeyRound className="w-3.5 h-3.5" />
                            </button>
                            {user.id !== currentUser.id && (
                              <button
                                type="button"
                                onClick={() => handleToggleStatus(user)}
                                title={user.isActive ? 'Nonaktifkan Akun' : 'Aktifkan Akun'}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                                  user.isActive
                                    ? 'text-rose-700 bg-rose-50 hover:bg-rose-100'
                                    : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                                }`}
                              >
                                {user.isActive ? (
                                  <>
                                    <UserX className="w-3 h-3" />
                                    Nonaktifkan
                                  </>
                                ) : (
                                  <>
                                    <UserCheck className="w-3 h-3" />
                                    Aktifkan
                                  </>
                                )}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit User Modal */}
      <UserFormModal
        open={formModalOpen}
        editingUser={editingUser}
        roles={roles}
        onClose={() => setFormModalOpen(false)}
        onSaved={(saved) => {
          setUsers((prev) => {
            const exists = prev.some((u) => u.id === saved.id);
            return exists ? prev.map((u) => (u.id === saved.id ? saved : u)) : [saved, ...prev];
          });
        }}
      />

      {/* User Detail Modal */}
      {detailUser && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Detail Pengguna"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg overflow-hidden shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div>
                <h3 className="text-base font-semibold text-slate-900">{detailUser.fullName}</h3>
                <p className="font-mono text-xs text-slate-500 mt-0.5">
                  @{detailUser.username} · {detailUser.email}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailUser(null)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                <div>
                  <span className="text-slate-500">Status Akun</span>
                  <p
                    className={`font-semibold mt-0.5 ${
                      detailUser.isActive ? 'text-emerald-700' : 'text-rose-700'
                    }`}
                  >
                    {detailUser.isActive ? 'Aktif' : 'Nonaktif'}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">Otorisasi PIN</span>
                  <p className="font-semibold text-slate-900 mt-0.5">
                    {detailUser.hasPin ? 'PIN Terpasang' : 'Belum Diatur'}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">Role</span>
                  <p className="font-semibold text-slate-900 mt-0.5">
                    {detailUser.roles.map((r) => r.name).join(', ')}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">Login Terakhir</span>
                  <p className="font-mono text-slate-700 mt-0.5 tabular-nums">
                    {detailUser.lastLoginAt ? formatDateTime(detailUser.lastLoginAt) : '-'}
                  </p>
                </div>
              </div>

              <div>
                <p className="font-semibold text-slate-700 mb-2">
                  Izin Efektif ({detailUser.permissions.length})
                </p>
                <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg p-3 bg-slate-50/50 grid grid-cols-2 gap-1.5 font-mono text-[11px] text-slate-700">
                  {detailUser.permissions.map((p) => (
                    <span key={p} className="truncate">
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-200">
              {canEdit && (
                <button
                  type="button"
                  onClick={() => {
                    const target = detailUser;
                    setDetailUser(null);
                    setResetTargetUser(target);
                  }}
                  className="px-3.5 py-2 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 rounded-lg"
                >
                  Reset Password / PIN
                </button>
              )}
              <button
                type="button"
                onClick={() => setDetailUser(null)}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Password / PIN Modal */}
      <ResetPasswordModal
        user={resetTargetUser}
        onClose={() => setResetTargetUser(null)}
        onUpdated={(updated) => {
          setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
        }}
      />
    </div>
  );
}

function UserFormModal({
  open,
  editingUser,
  roles,
  onClose,
  onSaved,
}: {
  open: boolean;
  editingUser: UserSummary | null;
  roles: Role[];
  onClose: () => void;
  onSaved: (user: UserSummary) => void;
}) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setShowPass(false);
    if (editingUser) {
      setUsername(editingUser.username);
      setEmail(editingUser.email);
      setFullName(editingUser.fullName);
      setPassword('');
      setPin('');
      setSelectedRoleIds(editingUser.roles.map((r) => r.id));
    } else {
      setUsername('');
      setEmail('');
      setFullName('');
      setPassword('');
      setPin('');
      const cashierRole = roles.find((r) => r.name === 'Cashier');
      setSelectedRoleIds(cashierRole ? [cashierRole.id] : roles[0] ? [roles[0].id] : []);
    }
  }, [open, editingUser, roles]);

  if (!open) return null;

  const toggleRole = (roleId: string) => {
    setSelectedRoleIds((prev) =>
      prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]
    );
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (selectedRoleIds.length === 0) {
      setError('Pilih minimal satu role untuk pengguna.');
      return;
    }
    setSubmitting(true);
    try {
      const res = editingUser
        ? await apiFetch<{ user: UserSummary }>(`/api/users/${editingUser.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              username,
              email,
              fullName,
              roleIds: selectedRoleIds,
            }),
          })
        : await apiFetch<{ user: UserSummary }>('/api/users', {
            method: 'POST',
            body: JSON.stringify({
              username,
              email,
              fullName,
              password,
              pin: pin || undefined,
              roleIds: selectedRoleIds,
            }),
          });
      onSaved(res.user);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal menyimpan pengguna.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={editingUser ? 'Edit Pengguna' : 'Tambah Pengguna'}
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h3 className="text-base font-semibold text-slate-900">
            {editingUser ? 'Ubah Data Pengguna' : 'Buat Akun Pengguna Baru'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Nama Lengkap</label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Contoh: Rina Kartika"
              className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Username</label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="rina.kasir"
                className="w-full font-mono text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="rina@toko.id"
                className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          {!editingUser && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Kata Sandi Awal
                </label>
                <div className="relative">
                  <input
                    type={showPass ? 'text' : 'password'}
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min. 6 karakter"
                    className="w-full text-sm px-3 pr-9 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                  >
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  PIN Otorisasi (Opsional)
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="4-6 digit angka"
                  className="w-full font-mono text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>
          )}

          <div>
            <p className="text-xs font-medium text-slate-700 mb-2">Role Pengguna</p>
            <div className="space-y-1.5 max-h-36 overflow-y-auto border border-slate-200 rounded-lg p-2.5">
              {roles.map((role) => (
                <label
                  key={role.id}
                  className="flex items-start gap-2.5 p-1.5 hover:bg-slate-50 rounded cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedRoleIds.includes(role.id)}
                    onChange={() => toggleRole(role.id)}
                    className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                  />
                  <div className="text-xs">
                    <p className="font-semibold text-slate-900">{role.name}</p>
                    <p className="text-[11px] text-slate-500">{role.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg"
            >
              {submitting ? 'Menyimpan...' : editingUser ? 'Simpan Perubahan' : 'Buat Pengguna'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ResetPasswordModal({
  user,
  onClose,
  onUpdated,
}: {
  user: UserSummary | null;
  onClose: () => void;
  onUpdated: (user: UserSummary) => void;
}) {
  const [newPassword, setNewPassword] = useState('');
  const [newPin, setNewPin] = useState('');
  const [updatePin, setUpdatePin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setNewPassword('');
      setNewPin('');
      setUpdatePin(false);
      setError(null);
    }
  }, [user]);

  if (!user) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!newPassword && !updatePin) {
      setError('Isi kata sandi baru atau aktifkan ubah PIN.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{ user: UserSummary }>(`/api/users/${user.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({
          ...(newPassword ? { newPassword } : {}),
          ...(updatePin ? { newPin } : {}),
        }),
      });
      onUpdated(res.user);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal mereset kredensial.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Reset Kata Sandi"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Reset Kredensial Pengguna</h3>
            <p className="text-xs text-slate-500 mt-0.5">@{user.username}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Kata Sandi Baru (kosongkan jika tidak diubah)
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min. 6 karakter"
              className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={updatePin}
                onChange={(e) => setUpdatePin(e.target.checked)}
                className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
              />
              Atur / Ubah PIN Otorisasi
            </label>
            {updatePin && (
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                placeholder="4-6 digit angka (kosongkan untuk hapus PIN)"
                className="w-full font-mono text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg"
            >
              {submitting ? 'Menyimpan...' : 'Simpan Reset'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
