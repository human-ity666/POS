import { useState } from 'react';
import { Clock, Play, Trash2, X } from 'lucide-react';
import type { Transaction } from '../types';
import { formatDateTime, formatRupiah } from '../utils/format';

interface HeldTransactionsModalProps {
  open: boolean;
  heldTransactions: Transaction[];
  canResume: boolean;
  canCancel: boolean;
  onClose: () => void;
  onResume: (trx: Transaction) => Promise<void>;
  onCancelHeld: (trx: Transaction, reason?: string) => Promise<void>;
}

export function HeldTransactionsModal({
  open,
  heldTransactions,
  canResume,
  canCancel,
  onClose,
  onResume,
  onCancelHeld,
}: HeldTransactionsModalProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleResume = async (trx: Transaction) => {
    setError(null);
    setBusyId(trx.id);
    try {
      await onResume(trx);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal melanjutkan transaksi yang ditahan.');
    } finally {
      setBusyId(null);
    }
  };

  const handleCancel = async (trx: Transaction) => {
    setError(null);
    setBusyId(trx.id);
    try {
      await onCancelHeld(trx, cancelReason.trim() || undefined);
      setConfirmCancelId(null);
      setCancelReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membatalkan transaksi yang ditahan.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Daftar Transaksi Ditahan"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl overflow-hidden shadow-xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-700" />
            <h3 className="text-base font-semibold text-slate-900">
              Transaksi Ditahan ({heldTransactions.length})
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Tutup daftar hold"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-3">
          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          {heldTransactions.length === 0 ? (
            <div className="py-12 text-center border border-dashed border-slate-200 rounded-xl">
              <Clock className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-700">Belum ada transaksi yang ditahan</p>
              <p className="text-xs text-slate-500 mt-1">
                Gunakan tombol &ldquo;Tahan Transaksi&rdquo; di keranjang kasir untuk menyimpan transaksi sementara.
              </p>
            </div>
          ) : (
            heldTransactions.map((trx) => {
              const totalUnits = trx.items.reduce((s, i) => s + i.qty, 0);
              const isBusy = busyId === trx.id;
              return (
                <div
                  key={trx.id}
                  className="p-4 border border-slate-200 rounded-xl bg-white space-y-2.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-slate-900">
                          {trx.invoiceNumber}
                        </span>
                        <span className="text-xs font-semibold text-amber-700">· DITAHAN</span>
                      </div>
                      <p className="text-xs text-slate-600 mt-0.5">
                        Pelanggan: <span className="font-medium text-slate-800">{trx.customerName}</span> ·
                        Kasir: {trx.cashierName} ·{' '}
                        <span className="font-mono text-[11px] tabular-nums">
                          {formatDateTime(trx.heldAt || trx.createdAt)}
                        </span>
                      </p>
                    </div>
                    <div className="text-right tabular-nums">
                      <p className="font-mono text-sm font-bold text-teal-800">
                        {formatRupiah(trx.total)}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {trx.items.length} baris ({totalUnits} unit)
                      </p>
                    </div>
                  </div>

                  <p className="text-xs text-slate-600 line-clamp-2">
                    {trx.items.map((i) => `${i.name} (${i.qty}×)`).join(', ')}
                  </p>

                  {trx.notes && (
                    <p className="text-[11px] text-slate-500 italic">Catatan: {trx.notes}</p>
                  )}

                  {confirmCancelId === trx.id ? (
                    <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={cancelReason}
                        onChange={(e) => setCancelReason(e.target.value)}
                        placeholder="Alasan pembatalan (opsional)"
                        className="flex-1 min-w-[180px] text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg"
                      />
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleCancel(trx)}
                        className="px-3 py-1.5 text-xs font-semibold text-white bg-rose-700 hover:bg-rose-800 rounded-lg"
                      >
                        Konfirmasi Batal
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmCancelId(null);
                          setCancelReason('');
                        }}
                        className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
                      >
                        Tutup
                      </button>
                    </div>
                  ) : (
                    <div className="pt-2 border-t border-slate-100 flex items-center justify-end gap-2">
                      {canCancel && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => setConfirmCancelId(trx.id)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Batalkan
                        </button>
                      )}
                      {canResume && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleResume(trx)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors"
                        >
                          <Play className="w-3.5 h-3.5" />
                          {isBusy ? 'Memuat...' : 'Lanjutkan ke Kasir'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
