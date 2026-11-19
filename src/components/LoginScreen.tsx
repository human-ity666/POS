import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, LogIn, User } from 'lucide-react';
import type { UserSummary } from '../types';
import { apiFetch, ApiError, setStoredTokens } from '../utils/api';

interface LoginScreenProps {
  onLoginSuccess: (payload: {
    user: UserSummary;
    sessionId: string;
    expiresAt: string;
    accessToken: string;
    refreshToken: string;
  }) => void;
}

const QUICK_TEST_ACCOUNTS = [
  { label: 'Admin', identifier: 'admin', password: 'Admin123!', note: 'Akses penuh + PIN 123456' },
  { label: 'Supervisor', identifier: 'supervisor', password: 'Super123!', note: 'Approval + Stok + PIN 654321' },
  { label: 'Kasir', identifier: 'kasir', password: 'Kasir123!', note: 'Terminal Kasir & Riwayat' },
] as const;

export function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedId = identifier.trim();
    if (!trimmedId) {
      setError('Username atau email wajib diisi.');
      return;
    }
    if (!password) {
      setError('Kata sandi wajib diisi.');
      return;
    }

    setLoading(true);
    try {
      const data = await apiFetch<{
        user: UserSummary;
        sessionId: string;
        expiresAt: string;
        accessToken: string;
        refreshToken: string;
      }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: trimmedId, password }),
      });
      setStoredTokens(data.accessToken, data.refreshToken);
      onLoginSuccess(data);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Gagal terhubung ke server autentikasi.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-10 px-4 sm:px-6">
      <div className="w-full max-w-md mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">KassaRitel</h1>
          <p className="text-sm text-slate-600 mt-1">
            Masuk ke terminal kasir dan manajemen stok toko ritel.
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {error && (
              <div
                role="alert"
                className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg"
              >
                {error}
              </div>
            )}

            <div>
              <label
                htmlFor="login-identifier"
                className="block text-xs font-semibold text-slate-700 mb-1.5"
              >
                Username atau Email
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="login-identifier"
                  type="text"
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="Contoh: admin atau kasir@kassaritel.id"
                  className="w-full text-sm pl-9 pr-3 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="login-password"
                className="block text-xs font-semibold text-slate-700 mb-1.5"
              >
                Kata Sandi
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Masukkan kata sandi"
                  className="w-full text-sm pl-9 pr-10 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Lihat kata sandi'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 rounded"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-lg transition-colors"
            >
              <LogIn className="w-4 h-4" />
              {loading ? 'Memverifikasi Sesi...' : 'Masuk ke Sistem'}
            </button>
          </form>

          <div className="pt-4 border-t border-slate-200">
            <p className="text-[11px] font-semibold text-slate-500 mb-2">
              Akun Uji Bawaan (klik untuk mengisi form):
            </p>
            <div className="space-y-1.5">
              {QUICK_TEST_ACCOUNTS.map((acc) => (
                <button
                  key={acc.identifier}
                  type="button"
                  onClick={() => {
                    setIdentifier(acc.identifier);
                    setPassword(acc.password);
                    setError(null);
                  }}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs bg-slate-50 hover:bg-teal-50 border border-slate-200 hover:border-teal-300 rounded-lg transition-colors"
                >
                  <span>
                    <span className="font-semibold text-slate-900">{acc.label}</span>
                    <span className="text-slate-500 ml-1.5">· {acc.note}</span>
                  </span>
                  <span className="font-mono text-[11px] text-teal-800 shrink-0">
                    {acc.identifier}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
