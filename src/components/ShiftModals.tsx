import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Calculator,
  CheckCircle2,
  Printer,
  ShieldCheck,
  X,
} from 'lucide-react';
import type {
  CashDenominationCount,
  CashierShift,
  CashMovementType,
  ShiftDetailReport,
  ShiftSettings,
  StoreSettings,
} from '../types';
import { apiFetch } from '../utils/api';
import { formatDateTime, formatRupiah } from '../utils/format';

const IDR_DENOMINATIONS: Array<{ value: number; label: string }> = [
  { value: 100000, label: 'Rp 100.000' },
  { value: 50000, label: 'Rp 50.000' },
  { value: 20000, label: 'Rp 20.000' },
  { value: 10000, label: 'Rp 10.000' },
  { value: 5000, label: 'Rp 5.000' },
  { value: 2000, label: 'Rp 2.000' },
  { value: 1000, label: 'Rp 1.000' },
  { value: 500, label: 'Rp 500' },
  { value: 200, label: 'Rp 200' },
  { value: 100, label: 'Rp 100' },
];

export const CASH_MOVEMENT_LABELS: Record<CashMovementType, string> = {
  CASH_IN: 'Kas Masuk',
  CASH_OUT: 'Kas Keluar',
  EXPENSE: 'Pengeluaran Laci',
  CASH_REFUND: 'Refund Tunai',
};

export function getDiscrepancyLabel(shift: CashierShift): string {
  if (shift.status === 'OPEN') return 'Toko Buka';
  if (shift.discrepancyStatus === 'MATCHED') return 'Sesuai (Pas)';
  if (shift.discrepancyStatus === 'PENDING_APPROVAL') return 'Menunggu Persetujuan Supervisor';
  if (shift.discrepancyStatus === 'APPROVED') return 'Selisih Disetujui';
  return 'Selesai';
}

interface OpenShiftModalProps {
  open: boolean;
  defaultRegisterName?: string;
  onClose: () => void;
  onSuccess: (shift: CashierShift, store: unknown) => void;
}

export function OpenShiftModal({
  open,
  defaultRegisterName = 'Kasir Utama',
  onClose,
  onSuccess,
}: OpenShiftModalProps) {
  const [openingCash, setOpeningCash] = useState('0');
  const [registerName, setRegisterName] = useState(defaultRegisterName);
  const [openingNotes, setOpeningNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setOpeningCash('0');
      setRegisterName(defaultRegisterName);
      setOpeningNotes('');
      setError(null);
    }
  }, [open, defaultRegisterName]);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const amount = Number(openingCash || 0);
    if (!Number.isInteger(amount) || amount < 0) {
      setError('Modal awal kas harus berupa bilangan bulat minimal 0.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<{ shift: CashierShift; store: unknown }>('/api/shifts/open', {
        method: 'POST',
        body: JSON.stringify({
          openingCash: amount,
          registerName: registerName.trim() || 'Kasir Utama',
          openingNotes: openingNotes.trim(),
        }),
      });
      onSuccess(res.shift, res.store);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuka toko.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Buka Toko"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Buka Toko</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Catat saldo kas awal laci untuk memulai operasional toko hari ini.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg"
            aria-label="Tutup modal buka toko"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {error && (
            <div className="p-3 font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          <div>
            <label className="block font-semibold text-slate-700 mb-1">
              Modal Awal Kas Laci (Opening Cash / Rp) *
            </label>
            <input
              type="number"
              min={0}
              step={1}
              required
              autoFocus
              value={openingCash}
              onChange={(e) => setOpeningCash(e.target.value)}
              className="w-full font-mono text-base font-semibold px-3 py-2.5 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
            <p className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
              Terbaca: {formatRupiah(Number(openingCash || 0))}
            </p>
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">Nama Terminal / Kassa</label>
            <input
              type="text"
              value={registerName}
              onChange={(e) => setRegisterName(e.target.value)}
              placeholder="Contoh: Kasir Utama / Kassa 1"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">Catatan Buka Toko</label>
            <textarea
              rows={2}
              value={openingNotes}
              onChange={(e) => setOpeningNotes(e.target.value)}
              placeholder="Opsional, misal kondisi laci atau uang receh awal..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] px-4 py-2 font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="min-h-[40px] px-4 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
            >
              {submitting ? 'Membuka Toko...' : 'Konfirmasi Buka Toko'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface CashMovementModalProps {
  open: boolean;
  shift: CashierShift | null;
  initialType?: CashMovementType;
  onClose: () => void;
  onSuccess: (shift: CashierShift, store: unknown) => void;
}

export function CashMovementModal({
  open,
  shift,
  initialType = 'CASH_IN',
  onClose,
  onSuccess,
}: CashMovementModalProps) {
  const [type, setType] = useState<CashMovementType>(initialType);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setType(initialType);
      setAmount('');
      setReason('');
      setReferenceNumber('');
      setNotes('');
      setError(null);
    }
  }, [open, initialType]);

  if (!open || !shift) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const numAmount = Number(amount);
    if (!Number.isInteger(numAmount) || numAmount <= 0) {
      setError('Nominal kas harus berupa bilangan bulat lebih dari 0.');
      return;
    }
    if (!reason.trim()) {
      setError('Alasan / keterangan mutasi kas wajib diisi.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{ shift: CashierShift; store: unknown }>(
        `/api/shifts/${shift.id}/cash-movements`,
        {
          method: 'POST',
          body: JSON.stringify({
            type,
            amount: numAmount,
            reason: reason.trim(),
            referenceNumber: referenceNumber.trim(),
            notes: notes.trim(),
          }),
        }
      );
      onSuccess(res.shift, res.store);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mencatat mutasi kas.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Catat Mutasi Kas Shift"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Catat Kas Masuk / Keluar</h3>
            <p className="text-xs text-slate-500 mt-0.5 font-mono">
              {shift.shiftNumber} · Kas seharusnya saat ini: {formatRupiah(shift.expectedCash)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg"
            aria-label="Tutup modal mutasi kas"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {error && (
            <div className="p-3 font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          <div>
            <label className="block font-semibold text-slate-700 mb-1.5">Jenis Mutasi Kas *</label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { id: 'CASH_IN', label: 'Kas Masuk (+)', desc: 'Tambah modal / receh laci', icon: ArrowDownLeft },
                  { id: 'CASH_OUT', label: 'Kas Keluar (-)', desc: 'Setor brankas / drop kas', icon: ArrowUpRight },
                  { id: 'EXPENSE', label: 'Pengeluaran (-)', desc: 'Beli perlengkapan / ongkos', icon: ArrowUpRight },
                  { id: 'CASH_REFUND', label: 'Refund Tunai (-)', desc: 'Pengembalian tunai pelanggan', icon: ArrowUpRight },
                ] as const
              ).map((opt) => {
                const Icon = opt.icon;
                const active = type === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setType(opt.id)}
                    className={`p-2.5 rounded-lg border text-left transition-colors ${
                      active
                        ? 'border-teal-700 bg-teal-50 text-teal-950'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-semibold">
                      <Icon className="w-3.5 h-3.5 shrink-0" />
                      <span>{opt.label}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">{opt.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Nominal (Rp) *</label>
              <input
                type="number"
                min={1}
                step={1}
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Contoh: 50000"
                className="w-full font-mono text-sm font-semibold px-3 py-2 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">No. Referensi (Opsional)</label>
              <input
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder="Otomatis jika kosong"
                className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">Alasan / Keperluan *</label>
            <input
              type="text"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Contoh: Tambah uang kembalian pecahan kecil / Beli kantong plastik"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">Catatan Tambahan</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Detail tambahan jika ada..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] px-4 py-2 font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="min-h-[40px] px-4 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
            >
              {submitting ? 'Menyimpan...' : 'Simpan Mutasi Kas'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface CloseShiftModalProps {
  open: boolean;
  shift: CashierShift | null;
  shiftSettings: ShiftSettings;
  canApproveDiscrepancy: boolean;
  onRequestSupervisorPin: (opts: { title: string; description: string }) => Promise<string>;
  onClose: () => void;
  onClosed: (report: ShiftDetailReport, store: unknown) => void;
}

export function CloseShiftModal({
  open,
  shift,
  shiftSettings,
  canApproveDiscrepancy,
  onRequestSupervisorPin,
  onClose,
  onClosed,
}: CloseShiftModalProps) {
  const [liveReport, setLiveReport] = useState<ShiftDetailReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [countMode, setCountMode] = useState<'MANUAL' | 'DENOMINATION'>('DENOMINATION');
  const [denomQty, setDenomQty] = useState<Record<number, string>>({});
  const [manualActualCash, setManualActualCash] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [supervisorPinToken, setSupervisorPinToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !shift) return;
    setCountMode('DENOMINATION');
    setDenomQty({});
    setManualActualCash('');
    setClosingNotes('');
    setConfirmed(false);
    setSupervisorPinToken('');
    setError(null);
    setLoadingReport(true);
    apiFetch<{ report: ShiftDetailReport }>(`/api/shifts/${shift.id}`)
      .then((res) => setLiveReport(res.report))
      .catch((err) => setError(err instanceof Error ? err.message : 'Gagal memuat rekonsiliasi shift.'))
      .finally(() => setLoadingReport(false));
  }, [open, shift]);

  const denominationList: CashDenominationCount[] = useMemo(() => {
    return IDR_DENOMINATIONS.map((d) => {
      const qty = Math.max(0, Math.floor(Number(denomQty[d.value] || 0)));
      return {
        denomination: d.value,
        label: d.label,
        qty,
        subtotal: d.value * qty,
      };
    });
  }, [denomQty]);

  const denominationTotal = useMemo(
    () => denominationList.reduce((sum, item) => sum + item.subtotal, 0),
    [denominationList]
  );

  if (!open || !shift) return null;

  const rec = liveReport?.reconciliation;
  const expectedCash = rec?.expectedCash ?? shift.expectedCash;
  const actualCashNum =
    countMode === 'DENOMINATION'
      ? denominationTotal
      : manualActualCash === ''
      ? null
      : Number(manualActualCash);
  const validActualCash =
    actualCashNum !== null && Number.isInteger(actualCashNum) && actualCashNum >= 0;
  const difference = validActualCash ? actualCashNum - expectedCash : null;
  const needsSupervisorApproval =
    difference !== null &&
    Math.abs(difference) > shiftSettings.discrepancyToleranceRp &&
    shiftSettings.requireSupervisorApprovalOnDiscrepancy &&
    !canApproveDiscrepancy &&
    !supervisorPinToken;

  const handleRequestPin = async () => {
    setError(null);
    try {
      const token = await onRequestSupervisorPin({
        title: 'Otorisasi PIN Selisih Tutup Kasir',
        description: `Terdapat selisih kas sebesar ${
          difference !== null ? formatRupiah(Math.abs(difference)) : 'Rp 0'
        } pada shift ${shift.shiftNumber}. Masukkan PIN Supervisor atau Admin untuk menyetujui saat penutupan.`,
      });
      setSupervisorPinToken(token);
    } catch (err) {
      if (err instanceof Error && err.message) {
        setError(err.message);
      }
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!validActualCash || actualCashNum === null) {
      setError('Masukkan nominal kas fisik aktual atau isi hitungan pecahan uang.');
      return;
    }
    if (!confirmed) {
      setError('Harap centang konfirmasi tutup shift terlebih dahulu.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{ report: ShiftDetailReport; store: unknown }>(
        `/api/shifts/${shift.id}/close`,
        {
          method: 'POST',
          body: JSON.stringify({
            actualCash: actualCashNum,
            closingNotes: closingNotes.trim(),
            denominations:
              countMode === 'DENOMINATION' ? denominationList.filter((d) => d.qty > 0) : [],
            confirmed: true,
            ...(supervisorPinToken ? { supervisorPinToken } : {}),
          }),
        }
      );
      onClosed(res.report, res.store);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menutup shift kasir.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Tutup Toko & Rekonsiliasi Kas"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl shadow-xl overflow-hidden flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Tutup Toko &amp; Rekonsiliasi Kas
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 font-mono">
              {shift.shiftNumber} · Dibuka oleh {shift.openedByName || shift.cashierName} ·{' '}
              {shift.registerName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg"
            aria-label="Tutup modal tutup toko"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-5 text-xs">
          {error && (
            <div className="p-3 font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          {loadingReport ? (
            <p className="py-6 text-center text-slate-500">Menghitung rekonsiliasi shift...</p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              {/* Left Column: System Expected Cash Breakdown */}
              <div className="lg:col-span-5 bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                <h4 className="text-sm font-semibold text-slate-900">Ringkasan Kas Sistem</h4>
                <div className="space-y-1.5 tabular-nums">
                  <div className="flex justify-between text-slate-600">
                    <span>Modal Awal Laci</span>
                    <span className="font-mono font-medium text-slate-900">
                      {formatRupiah(rec?.openingCash ?? shift.openingCash)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Penjualan Tunai Bersih</span>
                    <span className="font-mono font-medium text-emerald-700">
                      +{formatRupiah(rec?.cashSales ?? shift.cashSales)}
                    </span>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-500 pl-3">
                    <span>Uang Tunai Diterima (Bruto)</span>
                    <span className="font-mono">{formatRupiah(rec?.cashReceived ?? 0)}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-500 pl-3">
                    <span>Kembalian Diberikan</span>
                    <span className="font-mono">-{formatRupiah(rec?.cashChangeGiven ?? 0)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Kas Masuk (Cash In)</span>
                    <span className="font-mono font-medium text-emerald-700">
                      +{formatRupiah(rec?.cashInTotal ?? shift.cashInTotal)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Kas Keluar (Cash Out)</span>
                    <span className="font-mono font-medium text-rose-700">
                      -{formatRupiah(rec?.cashOutTotal ?? shift.cashOutTotal)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Pengeluaran Laci (Expense)</span>
                    <span className="font-mono font-medium text-rose-700">
                      -{formatRupiah(rec?.expenseTotal ?? shift.expenseTotal)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Refund Tunai</span>
                    <span className="font-mono font-medium text-rose-700">
                      -{formatRupiah(rec?.cashRefunds ?? shift.cashRefunds)}
                    </span>
                  </div>
                  <div className="pt-2 border-t border-slate-200 flex justify-between items-baseline">
                    <span className="font-semibold text-slate-900">Kas Seharusnya (Expected)</span>
                    <span className="font-mono text-base font-bold text-slate-900">
                      {formatRupiah(expectedCash)}
                    </span>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-200 space-y-1 text-[11px] text-slate-500 tabular-nums">
                  <div className="flex justify-between">
                    <span>Total Transaksi Selesai</span>
                    <span className="font-mono text-slate-700">
                      {rec?.transactionCount ?? shift.transactionCount} transaksi
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Penjualan Non-Tunai</span>
                    <span className="font-mono text-slate-700">
                      {formatRupiah(rec?.nonCashSales ?? shift.nonCashSales)}
                    </span>
                  </div>
                  <div className="flex justify-between font-medium text-slate-700">
                    <span>Total Omzet Shift</span>
                    <span className="font-mono">
                      {formatRupiah(rec?.totalSales ?? shift.totalSales)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Right Column: Physical Cash Entry + Denomination Counter + Discrepancy */}
              <div className="lg:col-span-7 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    Perhitungan Kas Fisik Laci
                  </span>
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setCountMode('DENOMINATION')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-md ${
                        countMode === 'DENOMINATION'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      <Calculator className="w-3.5 h-3.5" />
                      Hitung Pecahan
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (manualActualCash === '' && denominationTotal > 0) {
                          setManualActualCash(String(denominationTotal));
                        }
                        setCountMode('MANUAL');
                      }}
                      className={`px-2.5 py-1.5 text-xs font-semibold rounded-md ${
                        countMode === 'MANUAL'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      Input Total Langsung
                    </button>
                  </div>
                </div>

                {countMode === 'DENOMINATION' ? (
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
                      {[IDR_DENOMINATIONS.slice(0, 5), IDR_DENOMINATIONS.slice(5)].map(
                        (col, colIdx) => (
                          <div key={colIdx} className="divide-y divide-slate-100">
                            {col.map((den) => {
                              const qtyVal = denomQty[den.value] ?? '';
                              const qtyNum = Math.max(0, Math.floor(Number(qtyVal || 0)));
                              return (
                                <div
                                  key={den.value}
                                  className="px-3 py-2 flex items-center justify-between gap-2"
                                >
                                  <span className="font-mono font-medium text-slate-700 w-24">
                                    {den.label}
                                  </span>
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-slate-400">×</span>
                                    <input
                                      type="number"
                                      min={0}
                                      step={1}
                                      value={qtyVal}
                                      onChange={(e) =>
                                        setDenomQty((prev) => ({
                                          ...prev,
                                          [den.value]: e.target.value,
                                        }))
                                      }
                                      placeholder="0"
                                      aria-label={`Jumlah pecahan ${den.label}`}
                                      className="w-16 font-mono text-center px-2 py-1 border border-slate-300 rounded tabular-nums"
                                    />
                                  </div>
                                  <span className="font-mono text-[11px] text-slate-600 w-24 text-right tabular-nums">
                                    {formatRupiah(den.value * qtyNum)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )
                      )}
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Total Kas Fisik Aktual (Rp) *
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      required
                      value={manualActualCash}
                      onChange={(e) => setManualActualCash(e.target.value)}
                      placeholder="Masukkan total uang tunai fisik di laci..."
                      className="w-full font-mono text-base font-semibold px-3 py-2.5 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                  </div>
                )}

                {/* Reconciliation Summary Box */}
                <div className="p-3.5 border border-slate-200 rounded-xl bg-white space-y-2 tabular-nums">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 font-medium">Total Kas Fisik Aktual</span>
                    <span className="font-mono text-base font-bold text-slate-900">
                      {validActualCash && actualCashNum !== null
                        ? formatRupiah(actualCashNum)
                        : '-'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t border-slate-100">
                    <span className="text-slate-600 font-medium">Selisih (Aktual - Seharusnya)</span>
                    {difference === null ? (
                      <span className="font-mono text-slate-400">-</span>
                    ) : difference === 0 ? (
                      <span className="inline-flex items-center gap-1 font-mono font-bold text-emerald-700">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Rp 0 (Pas / Sesuai)
                      </span>
                    ) : difference > 0 ? (
                      <span className="inline-flex items-center gap-1 font-mono font-bold text-amber-700">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        +{formatRupiah(difference)} (Lebih)
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-mono font-bold text-rose-700">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        -{formatRupiah(Math.abs(difference))} (Kurang)
                      </span>
                    )}
                  </div>
                </div>

                {needsSupervisorApproval && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-2">
                    <p className="text-amber-900 font-medium">
                      Selisih kas melebihi toleransi (
                      {formatRupiah(shiftSettings.discrepancyToleranceRp)}). Shift dapat ditutup
                      dengan status <strong>Menunggu Persetujuan Supervisor</strong> atau disetujui
                      langsung menggunakan PIN Supervisor/Admin.
                    </p>
                    <button
                      type="button"
                      onClick={handleRequestPin}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-900 bg-white border border-amber-300 hover:bg-amber-100 rounded-lg"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      Verifikasi PIN Supervisor Sekarang
                    </button>
                  </div>
                )}

                {supervisorPinToken && (
                  <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 font-medium flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    PIN Supervisor telah terverifikasi. Selisih akan langsung berstatus Disetujui.
                  </div>
                )}

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Catatan Tutup Kasir
                  </label>
                  <textarea
                    rows={2}
                    value={closingNotes}
                    onChange={(e) => setClosingNotes(e.target.value)}
                    placeholder="Jelaskan kondisi laci atau alasan selisih jika ada..."
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>

                <label className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                  />
                  <span className="text-slate-700">
                    Saya menyatakan perhitungan kas fisik di atas telah diperiksa dengan benar dan
                    siap menutup operasional toko <strong>{shift.shiftNumber}</strong>.
                  </span>
                </label>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] px-4 py-2 font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting || loadingReport || !confirmed || !validActualCash}
              className="min-h-[40px] px-4 py-2 font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg disabled:opacity-40"
            >
              {submitting ? 'Menutup Toko...' : 'Konfirmasi & Tutup Toko'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ApproveDiscrepancyModalProps {
  open: boolean;
  shift: CashierShift | null;
  onClose: () => void;
  onApproved: (report: ShiftDetailReport, store: unknown) => void;
}

export function ApproveDiscrepancyModal({
  open,
  shift,
  onClose,
  onApproved,
}: ApproveDiscrepancyModalProps) {
  const [approvalNotes, setApprovalNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setApprovalNotes('');
      setError(null);
    }
  }, [open]);

  if (!open || !shift) return null;

  const diff = Number(shift.difference ?? 0);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ report: ShiftDetailReport; store: unknown }>(
        `/api/shifts/${shift.id}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({ approvalNotes: approvalNotes.trim() }),
        }
      );
      onApproved(res.report, res.store);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyetujui selisih kas shift.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Setujui Selisih Kas Shift"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Persetujuan Selisih Shift</h3>
            <p className="text-xs text-slate-500 mt-0.5 font-mono">
              {shift.shiftNumber} · {shift.cashierName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg"
            aria-label="Tutup modal persetujuan selisih"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {error && (
            <div className="p-3 font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5 tabular-nums">
            <div className="flex justify-between text-slate-600">
              <span>Kas Seharusnya (Expected)</span>
              <span className="font-mono font-medium">{formatRupiah(shift.expectedCash)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>Kas Aktual Dilaporkan</span>
              <span className="font-mono font-medium">{formatRupiah(shift.actualCash ?? 0)}</span>
            </div>
            <div className="flex justify-between pt-1.5 border-t border-slate-200 font-bold">
              <span>Selisih</span>
              <span className={`font-mono ${diff < 0 ? 'text-rose-700' : 'text-amber-700'}`}>
                {diff >= 0 ? `+${formatRupiah(diff)}` : `-${formatRupiah(Math.abs(diff))}`}
              </span>
            </div>
            {shift.closingNotes && (
              <p className="text-[11px] text-slate-600 pt-1">
                Catatan kasir: {shift.closingNotes}
              </p>
            )}
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">
              Catatan Persetujuan Supervisor
            </label>
            <textarea
              rows={2}
              value={approvalNotes}
              onChange={(e) => setApprovalNotes(e.target.value)}
              placeholder="Contoh: Selisih diterima setelah cek ulang nota..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] px-4 py-2 font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="min-h-[40px] px-4 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
            >
              {submitting ? 'Menyetujui...' : 'Setujui Selisih Shift'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ShiftReportModalProps {
  report: ShiftDetailReport | null;
  storeSettings: StoreSettings;
  canApproveDiscrepancy: boolean;
  onClose: () => void;
  onOpenApprove: (shift: CashierShift) => void;
}

export function ShiftReportModal({
  report,
  storeSettings,
  canApproveDiscrepancy,
  onClose,
  onOpenApprove,
}: ShiftReportModalProps) {
  if (!report) return null;

  const { shift, reconciliation, paymentBreakdown, cashMovements } = report;
  const diff = reconciliation.difference;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 print-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Laporan Shift ${shift.shiftNumber}`}
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl shadow-xl overflow-hidden flex flex-col max-h-[92vh] print-modal-panel">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 no-print">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Laporan Buka/Tutup Toko · {shift.shiftNumber}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Dibuka oleh {shift.openedByName || shift.cashierName}
              {shift.closedByName ? ` · Ditutup oleh ${shift.closedByName}` : ''} ·{' '}
              {getDiscrepancyLabel(shift)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canApproveDiscrepancy && shift.discrepancyStatus === 'PENDING_APPROVAL' && (
              <button
                type="button"
                onClick={() => onOpenApprove(shift)}
                className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                Setujui Selisih
              </button>
            )}
            <button
              type="button"
              onClick={() => window.print()}
              className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
            >
              <Printer className="w-3.5 h-3.5" />
              Cetak Laporan
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg"
              aria-label="Tutup laporan toko"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto space-y-5 text-xs print-scroll-container">
          <div className="print-area space-y-5 bg-white">
            {/* Header Info */}
            <div className="pb-4 border-b border-slate-200 flex flex-wrap justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">{storeSettings.storeName}</h2>
                <p className="text-slate-500">{storeSettings.storeAddress}</p>
                <p className="text-slate-500">{storeSettings.storePhone}</p>
              </div>
              <div className="text-right tabular-nums">
                <p className="font-mono text-sm font-bold text-slate-900">
                  LAPORAN OPERASIONAL TOKO {shift.shiftNumber}
                </p>
                <p className="text-slate-600 mt-0.5">
                  Kassa: <strong className="text-slate-900">{shift.registerName}</strong>
                </p>
                <p className="text-slate-600">
                  Dibuka oleh: <strong className="text-slate-900">{shift.openedByName || shift.cashierName}</strong>{' '}
                  <span className="font-mono text-slate-500">({formatDateTime(shift.openedAt)})</span>
                </p>
                <p className="text-slate-600">
                  Ditutup oleh:{' '}
                  {shift.closedAt ? (
                    <>
                      <strong className="text-slate-900">{shift.closedByName || '-'}</strong>{' '}
                      <span className="font-mono text-slate-500">({formatDateTime(shift.closedAt)})</span>
                    </>
                  ) : (
                    <span className="text-teal-700 font-semibold">Masih Buka (OPEN)</span>
                  )}
                </p>
              </div>
            </div>

            {/* Cash Reconciliation + Sales Summary */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="border border-slate-200 rounded-xl p-4 space-y-2 tabular-nums">
                <h4 className="font-semibold text-slate-900 text-sm pb-1.5 border-b border-slate-100">
                  Rekonsiliasi Laci Kas
                </h4>
                <div className="flex justify-between text-slate-600">
                  <span>Modal Awal (Opening Cash)</span>
                  <span className="font-mono font-medium">{formatRupiah(reconciliation.openingCash)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Penjualan Tunai (Cash Sales)</span>
                  <span className="font-mono font-medium text-emerald-700">
                    +{formatRupiah(reconciliation.cashSales)}
                  </span>
                </div>
                <div className="flex justify-between text-[11px] text-slate-500 pl-3">
                  <span>Tunai Diterima (Cash Received)</span>
                  <span className="font-mono">{formatRupiah(reconciliation.cashReceived)}</span>
                </div>
                <div className="flex justify-between text-[11px] text-slate-500 pl-3">
                  <span>Kembalian (Change Given)</span>
                  <span className="font-mono">-{formatRupiah(reconciliation.cashChangeGiven)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Kas Masuk (Cash In)</span>
                  <span className="font-mono font-medium text-emerald-700">
                    +{formatRupiah(reconciliation.cashInTotal)}
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Kas Keluar (Cash Out)</span>
                  <span className="font-mono font-medium text-rose-700">
                    -{formatRupiah(reconciliation.cashOutTotal)}
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Pengeluaran (Expense)</span>
                  <span className="font-mono font-medium text-rose-700">
                    -{formatRupiah(reconciliation.expenseTotal)}
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Refund Tunai (Cash Refunds)</span>
                  <span className="font-mono font-medium text-rose-700">
                    -{formatRupiah(reconciliation.cashRefunds)}
                  </span>
                </div>
                <div className="pt-2 border-t border-slate-200 flex justify-between font-semibold text-slate-900">
                  <span>Kas Seharusnya (Expected Cash)</span>
                  <span className="font-mono">{formatRupiah(reconciliation.expectedCash)}</span>
                </div>
                <div className="flex justify-between font-semibold text-slate-900">
                  <span>Kas Fisik Aktual (Actual Cash)</span>
                  <span className="font-mono">
                    {reconciliation.actualCash !== null
                      ? formatRupiah(reconciliation.actualCash)
                      : '-'}
                  </span>
                </div>
                <div className="pt-1.5 border-t border-slate-100 flex justify-between font-bold">
                  <span>Selisih (Difference)</span>
                  <span
                    className={`font-mono ${
                      diff === null
                        ? 'text-slate-400'
                        : diff === 0
                        ? 'text-emerald-700'
                        : diff > 0
                        ? 'text-amber-700'
                        : 'text-rose-700'
                    }`}
                  >
                    {diff === null
                      ? '-'
                      : diff === 0
                      ? 'Rp 0 (Pas)'
                      : diff > 0
                      ? `+${formatRupiah(diff)} (Lebih)`
                      : `-${formatRupiah(Math.abs(diff))} (Kurang)`}
                  </span>
                </div>
              </div>

              <div className="border border-slate-200 rounded-xl p-4 space-y-3 tabular-nums">
                <h4 className="font-semibold text-slate-900 text-sm pb-1.5 border-b border-slate-100">
                  Rincian Penjualan &amp; Metode Bayar
                </h4>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2.5 bg-slate-50 rounded-lg">
                    <span className="text-slate-500 block">Total Transaksi</span>
                    <span className="font-mono text-sm font-bold text-slate-900">
                      {reconciliation.transactionCount}
                    </span>
                  </div>
                  <div className="p-2.5 bg-slate-50 rounded-lg">
                    <span className="text-slate-500 block">Total Penjualan</span>
                    <span className="font-mono text-sm font-bold text-teal-800">
                      {formatRupiah(reconciliation.totalSales)}
                    </span>
                  </div>
                </div>

                {paymentBreakdown.length === 0 ? (
                  <p className="text-slate-500 py-3">Belum ada transaksi selesai pada shift ini.</p>
                ) : (
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 text-[11px] text-slate-500">
                        <th className="py-1.5">Metode</th>
                        <th className="py-1.5 text-right">Trx</th>
                        <th className="py-1.5 text-right">Nominal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {paymentBreakdown.map((pb) => (
                        <tr key={`${pb.paymentMethodName}-${pb.paymentType}`}>
                          <td className="py-1.5 font-medium text-slate-800">
                            {pb.paymentMethodName}
                          </td>
                          <td className="py-1.5 text-right font-mono text-slate-600">
                            {pb.transactionCount}
                          </td>
                          <td className="py-1.5 text-right font-mono font-semibold text-slate-900">
                            {formatRupiah(pb.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div className="pt-2 border-t border-slate-100 space-y-1 text-[11px] text-slate-600">
                  <p>
                    Status Rekonsiliasi: <strong>{getDiscrepancyLabel(shift)}</strong>
                  </p>
                  {shift.approvedByName && (
                    <p>
                      Disetujui oleh: <strong>{shift.approvedByName}</strong> (
                      {shift.approvedAt ? formatDateTime(shift.approvedAt) : ''}) —{' '}
                      {shift.approvalNotes}
                    </p>
                  )}
                  {shift.openingNotes && <p>Catatan Buka: {shift.openingNotes}</p>}
                  {shift.closingNotes && <p>Catatan Tutup: {shift.closingNotes}</p>}
                </div>
              </div>
            </div>

            {/* Cash Movements Table */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                <h4 className="font-semibold text-slate-900">
                  Mutasi Kas Shift ({cashMovements.length})
                </h4>
              </div>
              {cashMovements.length === 0 ? (
                <p className="p-4 text-slate-500">Tidak ada mutasi kas manual pada shift ini.</p>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-[11px] text-slate-500 bg-slate-50/50">
                      <th className="py-2 px-3">Waktu</th>
                      <th className="py-2 px-3">Jenis</th>
                      <th className="py-2 px-3">Alasan &amp; Ref</th>
                      <th className="py-2 px-3">Petugas</th>
                      <th className="py-2 px-3 text-right">Nominal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 tabular-nums">
                    {cashMovements.map((m) => (
                      <tr key={m.id}>
                        <td className="py-2 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                          {formatDateTime(m.createdAt)}
                        </td>
                        <td className="py-2 px-3 font-semibold">
                          <span
                            className={
                              m.type === 'CASH_IN' ? 'text-emerald-700' : 'text-rose-700'
                            }
                          >
                            {CASH_MOVEMENT_LABELS[m.type]}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-slate-800">
                          <p className="font-medium">{m.reason}</p>
                          <p className="font-mono text-[10px] text-slate-500">
                            {m.movementNumber}
                            {m.referenceNumber && m.referenceNumber !== m.movementNumber
                              ? ` · Ref: ${m.referenceNumber}`
                              : ''}
                          </p>
                        </td>
                        <td className="py-2 px-3 text-slate-600">{m.actorName}</td>
                        <td
                          className={`py-2 px-3 text-right font-mono font-semibold whitespace-nowrap ${
                            m.type === 'CASH_IN' ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {m.type === 'CASH_IN' ? '+' : '-'}
                          {formatRupiah(m.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Denominations Table (if counted) */}
            {shift.closingDenominations.length > 0 && (
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                  <h4 className="font-semibold text-slate-900">Rincian Pecahan Kas Fisik</h4>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 p-3 tabular-nums">
                  {shift.closingDenominations.map((d) => (
                    <div key={d.denomination} className="p-2 border border-slate-200 rounded-lg">
                      <p className="font-mono text-[11px] text-slate-500">
                        {d.label} × {d.qty}
                      </p>
                      <p className="font-mono font-semibold text-slate-900">
                        {formatRupiah(d.subtotal)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
