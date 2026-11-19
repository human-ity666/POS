import { useEffect, useState, type FormEvent } from 'react';
import { Check, KeyRound, X } from 'lucide-react';
import type { UserSummary } from '../types';
import { apiFetch, ApiError } from '../utils/api';
import { formatDateTime } from '../utils/format';

interface ProfileModalProps {
  open: boolean;
  user: UserSummary;
  onClose: () => void;
}

export function ProfileModal({ open, user, onClose }: ProfileModalProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCurrentPassword('');
      setNewPassword('');
      setError(null);
      setSuccess(null);
    }
  }, [open]);

  if (!open) return null;

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      await apiFetch<{ ok: boolean }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setSuccess('Kata sandi Anda berhasil diperbarui.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal memperbarui kata sandi.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Profil Pengguna"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Profil Akun Saya</h3>
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

        <div className="p-5 space-y-4">
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1.5">
            <div className="flex justify-between">
              <span className="text-slate-500">Nama Lengkap</span>
              <span className="font-semibold text-slate-900">{user.fullName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Email</span>
              <span className="text-slate-800">{user.email}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Role Aktif</span>
              <span className="font-semibold text-teal-800">
                {user.roles.map((r) => r.name).join(', ')}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Login Terakhir</span>
              <span className="font-mono text-slate-700 tabular-nums">
                {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Sesi pertama'}
              </span>
            </div>
          </div>

          <form onSubmit={handleChangePassword} className="space-y-3 pt-2 border-t border-slate-200">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
              <KeyRound className="w-3.5 h-3.5 text-teal-700" />
              <span>Ubah Kata Sandi</span>
            </div>

            {error && (
              <div className="p-2.5 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                {error}
              </div>
            )}
            {success && (
              <div className="p-2.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5" />
                <span>{success}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Kata Sandi Saat Ini
              </label>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Kata Sandi Baru (min. 6 karakter)
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Tutup
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg"
              >
                {saving ? 'Menyimpan...' : 'Perbarui Kata Sandi'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
