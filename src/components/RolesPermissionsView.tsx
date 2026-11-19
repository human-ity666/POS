import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Plus, Shield, Trash2, X } from 'lucide-react';
import type { Permission, Role, UserSummary } from '../types';
import { apiFetch, ApiError } from '../utils/api';

interface RolesPermissionsViewProps {
  currentUser: UserSummary;
  onRolesChanged?: () => void;
}

export function RolesPermissionsView({ currentUser, onRolesChanged }: RolesPermissionsViewProps) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string>('');
  const [draftCodes, setDraftCodes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const canEdit = currentUser.permissions.includes('roles:edit');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rolesRes, permsRes] = await Promise.all([
        apiFetch<{ roles: Role[] }>('/api/roles'),
        apiFetch<{ permissions: Permission[] }>('/api/permissions'),
      ]);
      setRoles(rolesRes.roles);
      setPermissions(permsRes.permissions);
      if (rolesRes.roles.length > 0) {
        setSelectedRoleId((prev) => {
          const stillExists = rolesRes.roles.find((r) => r.id === prev);
          const target = stillExists ?? rolesRes.roles[0];
          setDraftCodes(target.permissionCodes);
          return target.id;
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal memuat data role & izin.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const selectedRole = useMemo(
    () => roles.find((r) => r.id === selectedRoleId) ?? null,
    [roles, selectedRoleId]
  );

  const handleSelectRole = (role: Role) => {
    setSelectedRoleId(role.id);
    setDraftCodes(role.permissionCodes);
    setSaveMessage(null);
    setError(null);
  };

  const permissionsByModule = useMemo(() => {
    const map = new Map<string, Permission[]>();
    for (const p of permissions) {
      const arr = map.get(p.module) ?? [];
      arr.push(p);
      map.set(p.module, arr);
    }
    return Array.from(map.entries());
  }, [permissions]);

  const togglePermission = (code: string) => {
    if (!canEdit) return;
    setSaveMessage(null);
    setDraftCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  const hasChanges = useMemo(() => {
    if (!selectedRole) return false;
    if (draftCodes.length !== selectedRole.permissionCodes.length) return true;
    const setA = new Set(selectedRole.permissionCodes);
    return draftCodes.some((c) => !setA.has(c));
  }, [selectedRole, draftCodes]);

  const handleSavePermissions = async () => {
    if (!selectedRole || !canEdit) return;
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    try {
      const res = await apiFetch<{ role: Role }>(`/api/roles/${selectedRole.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissionCodes: draftCodes }),
      });
      setRoles((prev) => prev.map((r) => (r.id === res.role.id ? res.role : r)));
      setDraftCodes(res.role.permissionCodes);
      setSaveMessage(`Hak akses untuk role "${res.role.name}" berhasil disimpan.`);
      onRolesChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal menyimpan hak akses.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRole = async (role: Role) => {
    if (!canEdit || role.isSystem) return;
    setError(null);
    try {
      await apiFetch<{ ok: boolean }>(`/api/roles/${role.id}`, { method: 'DELETE' });
      const remaining = roles.filter((r) => r.id !== role.id);
      setRoles(remaining);
      if (remaining[0]) {
        handleSelectRole(remaining[0]);
      }
      onRolesChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal menghapus role.');
    }
  };

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
        Memuat konfigurasi role & izin...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-xl">
          {error}
        </div>
      )}
      {saveMessage && (
        <div className="p-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center gap-2">
          <Check className="w-4 h-4 shrink-0" />
          <span>{saveMessage}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left: Role List */}
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-teal-700" />
              <h2 className="text-sm font-semibold text-slate-900">Daftar Role</h2>
            </div>
            {canEdit && (
              <button
                type="button"
                onClick={() => setCreateModalOpen(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 rounded-lg"
              >
                <Plus className="w-3.5 h-3.5" />
                Role Baru
              </button>
            )}
          </div>

          <div className="divide-y divide-slate-100">
            {roles.map((role) => {
              const active = role.id === selectedRoleId;
              return (
                <div
                  key={role.id}
                  className={`p-4 flex items-start justify-between gap-2 transition-colors ${
                    active ? 'bg-teal-50/60' : 'hover:bg-slate-50'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleSelectRole(role)}
                    className="flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900">{role.name}</span>
                      <span className="text-[11px] text-slate-500 font-mono tabular-nums">
                        {role.userCount} user · {role.permissionCodes.length} izin
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 mt-1 leading-relaxed">{role.description}</p>
                  </button>
                  {canEdit && !role.isSystem && (
                    <button
                      type="button"
                      onClick={() => handleDeleteRole(role)}
                      title="Hapus Role Kustom"
                      className="p-1.5 text-slate-400 hover:text-rose-600 rounded-md"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Permission Matrix */}
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
          {selectedRole ? (
            <>
              <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Matriks Hak Akses — {selectedRole.name}
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {draftCodes.length} dari {permissions.length} izin diaktifkan
                    {selectedRole.isSystem ? ' · Role bawaan sistem' : ''}
                  </p>
                </div>

                {canEdit && (
                  <button
                    type="button"
                    disabled={!hasChanges || saving}
                    onClick={handleSavePermissions}
                    className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:bg-slate-200 disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap"
                  >
                    {saving ? 'Menyimpan...' : 'Simpan Perubahan Izin'}
                  </button>
                )}
              </div>

              <div className="divide-y divide-slate-200">
                {permissionsByModule.map(([moduleName, perms]) => (
                  <div key={moduleName} className="p-4">
                    <h4 className="text-xs font-bold text-slate-900 mb-3">{moduleName}</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                      {perms.map((perm) => {
                        const checked = draftCodes.includes(perm.code);
                        return (
                          <label
                            key={perm.code}
                            className={`flex items-start gap-2.5 p-2.5 rounded-lg border transition-colors ${
                              checked
                                ? 'bg-teal-50/40 border-teal-300'
                                : 'bg-white border-slate-200 hover:bg-slate-50'
                            } ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}
                          >
                            <input
                              type="checkbox"
                              disabled={!canEdit}
                              checked={checked}
                              onChange={() => togglePermission(perm.code)}
                              className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-slate-900">
                                  {perm.label}
                                </span>
                                <span className="font-mono text-[10px] text-slate-500">
                                  {perm.action}
                                </span>
                              </div>
                              <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                                {perm.description}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-xs text-slate-500">
              Pilih role untuk melihat izin modul.
            </div>
          )}
        </div>
      </div>

      {/* Create Custom Role Modal */}
      <CreateRoleModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={(created) => {
          setRoles((prev) => [...prev, created]);
          handleSelectRole(created);
          onRolesChanged?.();
        }}
      />
    </div>
  );
}

function CreateRoleModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (role: Role) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ role: Role }>('/api/roles', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description,
          permissionCodes: ['pos:view', 'products:view'],
        }),
      });
      onCreated(res.role);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal membuat role baru.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Buat Role Baru"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">Buat Role Kustom Baru</h3>
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
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Nama Role</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contoh: Kepala Gudang"
              className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Deskripsi</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tugas & tanggung jawab role..."
              className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
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
              {submitting ? 'Membuat...' : 'Buat Role'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
