import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, X } from 'lucide-react';
import type { PinSensitiveAction } from '../types';
import { apiFetch, ApiError } from '../utils/api';

interface PinAuthorizationModalProps {
  open: boolean;
  action: PinSensitiveAction;
  actionTitle: string;
  description: string;
  onClose: () => void;
  onAuthorized: (result: {
    pinApprovalToken: string;
    authorizerName: string;
    expiresAt: string;
  }) => void;
}

export function PinAuthorizationModal({
  open,
  action,
  actionTitle,
  description,
  onClose,
  onAuthorized,
}: PinAuthorizationModalProps) {
  const [authorizerIdentifier, setAuthorizerIdentifier] = useState('supervisor');
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPin('');
      setReason('');
      setError(null);
      setShowPin(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!authorizerIdentifier.trim() || !pin.trim()) {
      setError('Username penyetuju dan PIN wajib diisi.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{
        pinApprovalToken: string;
        expiresAt: string;
        authorizerName: string;
        action: PinSensitiveAction;
      }>('/api/auth/verify-pin', {
        method: 'POST',
        body: JSON.stringify({
          authorizerIdentifier: authorizerIdentifier.trim(),
          pin: pin.trim(),
          action,
          reason: reason.trim() || actionTitle,
        }),
      });
      onAuthorized(res);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Gagal memverifikasi PIN otorisasi.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Otorisasi PIN Supervisor"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-amber-700" />
            <h3 className="text-sm font-semibold text-slate-900">Otorisasi PIN Diperlukan</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Tutup otorisasi PIN"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="p-3 bg-amber-50/70 border border-amber-200 rounded-lg">
            <p className="text-xs font-semibold text-amber-900">{actionTitle}</p>
            <p className="text-xs text-amber-800 mt-0.5 leading-relaxed">{description}</p>
          </div>

          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Username / Email Penyetuju (Supervisor atau Admin)
            </label>
            <input
              type="text"
              value={authorizerIdentifier}
              onChange={(e) => setAuthorizerIdentifier(e.target.value)}
              placeholder="supervisor atau admin"
              className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              PIN Otorisasi (4–6 digit)
            </label>
            <div className="relative">
              <input
                type={showPin ? 'text' : 'password'}
                inputMode="numeric"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                placeholder="Masukkan PIN"
                className="w-full font-mono text-sm px-3 pr-10 py-2 border border-slate-300 rounded-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              <button
                type="button"
                onClick={() => setShowPin((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700"
                aria-label={showPin ? 'Sembunyikan PIN' : 'Lihat PIN'}
              >
                {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              PIN uji bawaan: Supervisor (<span className="font-mono">654321</span>) · Admin (<span className="font-mono">123456</span>)
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Alasan / Catatan Audit (opsional)
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Contoh: Diskon pelanggan grosir"
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
              {submitting ? 'Memverifikasi...' : 'Setujui dengan PIN'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
