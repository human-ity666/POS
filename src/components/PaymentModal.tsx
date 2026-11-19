import { useEffect, useMemo, useState } from 'react';
import {
  Banknote,
  CreditCard,
  Plus,
  QrCode,
  ShieldCheck,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import type {
  PaymentMethodConfig,
  PaymentMethodType,
  PosCalculationPreview,
} from '../types';
import { formatRupiah } from '../utils/format';

export interface SubmittedPaymentLine {
  paymentMethodId: string;
  paymentMethodName: string;
  paymentType: PaymentMethodType;
  amount: number;
  tenderedAmount: number;
  referenceNumber: string;
}

interface PaymentModalProps {
  open: boolean;
  preview: PosCalculationPreview | null;
  calculating: boolean;
  paymentMethods: PaymentMethodConfig[];
  customerName: string;
  notes: string;
  onClose: () => void;
  onConfirmPayment: (payload: {
    payments: SubmittedPaymentLine[];
    idempotencyKey: string;
  }) => Promise<void>;
}

interface DraftPaymentRow {
  rowId: string;
  paymentMethodId: string;
  amountInput: string;
  tenderedInput: string;
  referenceNumber: string;
}

function getMethodIcon(type: PaymentMethodType) {
  switch (type) {
    case 'CASH':
      return Banknote;
    case 'QRIS':
      return QrCode;
    case 'DEBIT':
    case 'CREDIT':
      return CreditCard;
    default:
      return Wallet;
  }
}

export function PaymentModal({
  open,
  preview,
  calculating,
  paymentMethods,
  customerName,
  notes,
  onClose,
  onConfirmPayment,
}: PaymentModalProps) {
  const activeMethods = useMemo(
    () => paymentMethods.filter((m) => m.isActive),
    [paymentMethods]
  );

  const [isSplitMode, setIsSplitMode] = useState(false);
  const [selectedMethodId, setSelectedMethodId] = useState<string>('pm-cash');
  const [cashTenderedInput, setCashTenderedInput] = useState<string>('');
  const [singleReference, setSingleReference] = useState<string>('');
  const [splitRows, setSplitRows] = useState<DraftPaymentRow[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grandTotal = preview?.grandTotal ?? 0;

  useEffect(() => {
    if (!open) return;
    const defaultMethod = activeMethods[0]?.id ?? 'pm-cash';
    setIsSplitMode(false);
    setSelectedMethodId(defaultMethod);
    setCashTenderedInput('');
    setSingleReference('');
    setError(null);
    setSubmitting(false);
    setIdempotencyKey(
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    );

    const secondMethod = activeMethods.find((m) => m.id !== defaultMethod)?.id ?? defaultMethod;
    setSplitRows([
      {
        rowId: 'pay-1',
        paymentMethodId: defaultMethod,
        amountInput: String(grandTotal),
        tenderedInput: String(grandTotal),
        referenceNumber: '',
      },
      {
        rowId: 'pay-2',
        paymentMethodId: secondMethod,
        amountInput: '0',
        tenderedInput: '0',
        referenceNumber: '',
      },
    ]);
  }, [open, activeMethods, grandTotal]);

  const selectedMethod =
    activeMethods.find((m) => m.id === selectedMethodId) ?? activeMethods[0];

  const quickCashOptions = useMemo(() => {
    if (grandTotal <= 0) return [0];
    const round10k = Math.ceil(grandTotal / 10000) * 10000;
    const round50k = Math.ceil(grandTotal / 50000) * 50000;
    const round100k = Math.ceil(grandTotal / 100000) * 100000;
    return Array.from(
      new Set([grandTotal, round10k, round50k, round100k, 50000, 100000, 200000])
    )
      .filter((v) => v >= grandTotal)
      .sort((a, b) => a - b)
      .slice(0, 5);
  }, [grandTotal]);

  const singleCashTendered = Math.max(0, Math.round(Number(cashTenderedInput || 0)));
  const singleCashChange =
    selectedMethod?.type === 'CASH' ? singleCashTendered - grandTotal : 0;

  const splitComputed = useMemo(() => {
    let allocated = 0;
    let totalTendered = 0;
    let totalChange = 0;
    let invalidReason: string | null = null;

    const parsedRows = splitRows.map((row) => {
      const pm = activeMethods.find((m) => m.id === row.paymentMethodId);
      const amount = Math.max(0, Math.round(Number(row.amountInput || 0)));
      const tendered =
        pm?.type === 'CASH'
          ? Math.max(0, Math.round(Number(row.tenderedInput || row.amountInput || 0)))
          : amount;
      const change = pm?.type === 'CASH' ? Math.max(0, tendered - amount) : 0;
      if (pm?.type === 'CASH' && tendered < amount) {
        invalidReason = 'Nominal tunai diterima pada salah satu baris kurang dari porsinya.';
      }
      if (pm?.requiresReference && pm.type !== 'CASH' && !row.referenceNumber.trim() && amount > 0) {
        invalidReason = `Nomor referensi wajib diisi untuk ${pm.name}.`;
      }
      allocated += amount;
      totalTendered += tendered;
      totalChange += change;
      return { row, pm, amount, tendered, change };
    });

    const remaining = grandTotal - allocated;
    if (!invalidReason) {
      if (parsedRows.some((r) => r.amount <= 0)) {
        invalidReason = 'Setiap baris metode pembayaran split harus bernilai lebih dari 0.';
      } else if (remaining !== 0) {
        invalidReason =
          remaining > 0
            ? `Alokasi pembayaran masih kurang ${formatRupiah(remaining)}.`
            : `Alokasi pembayaran melebihi tagihan sebesar ${formatRupiah(Math.abs(remaining))}.`;
      }
    }

    return {
      parsedRows,
      allocated,
      remaining,
      totalTendered,
      totalChange,
      invalidReason,
    };
  }, [splitRows, activeMethods, grandTotal]);

  if (!open) return null;

  const handleAddSplitRow = () => {
    const remaining = Math.max(0, splitComputed.remaining);
    const unused =
      activeMethods.find((m) => !splitRows.some((r) => r.paymentMethodId === m.id)) ??
      activeMethods[0];
    if (!unused) return;
    setSplitRows((prev) => [
      ...prev,
      {
        rowId: `pay-${Date.now()}`,
        paymentMethodId: unused.id,
        amountInput: String(remaining),
        tenderedInput: String(remaining),
        referenceNumber: '',
      },
    ]);
  };

  const handleSubmit = async () => {
    if (!preview || calculating || submitting) return;
    setError(null);

    let paymentsPayload: SubmittedPaymentLine[] = [];

    if (!isSplitMode) {
      if (!selectedMethod) {
        setError('Metode pembayaran tidak tersedia.');
        return;
      }
      if (selectedMethod.type === 'CASH') {
        if (singleCashTendered < grandTotal) {
          setError('Uang tunai yang diterima masih kurang dari total tagihan.');
          return;
        }
        paymentsPayload = [
          {
            paymentMethodId: selectedMethod.id,
            paymentMethodName: selectedMethod.name,
            paymentType: selectedMethod.type,
            amount: grandTotal,
            tenderedAmount: singleCashTendered,
            referenceNumber: '',
          },
        ];
      } else {
        paymentsPayload = [
          {
            paymentMethodId: selectedMethod.id,
            paymentMethodName: selectedMethod.name,
            paymentType: selectedMethod.type,
            amount: grandTotal,
            tenderedAmount: grandTotal,
            referenceNumber: singleReference.trim(),
          },
        ];
      }
    } else {
      if (splitComputed.invalidReason) {
        setError(splitComputed.invalidReason);
        return;
      }
      paymentsPayload = splitComputed.parsedRows.map(({ row, pm, amount, tendered }) => ({
        paymentMethodId: pm?.id ?? row.paymentMethodId,
        paymentMethodName: pm?.name ?? 'Lainnya',
        paymentType: pm?.type ?? 'OTHER',
        amount,
        tenderedAmount: tendered,
        referenceNumber: row.referenceNumber.trim(),
      }));
    }

    setSubmitting(true);
    try {
      await onConfirmPayment({
        payments: paymentsPayload,
        idempotencyKey,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyelesaikan pembayaran.');
    } finally {
      setSubmitting(false);
    }
  };

  const canConfirm =
    Boolean(preview) &&
    !calculating &&
    !submitting &&
    (!isSplitMode
      ? Boolean(selectedMethod) &&
        (selectedMethod?.type !== 'CASH' || singleCashTendered >= grandTotal)
      : !splitComputed.invalidReason);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Pembayaran Transaksi"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl overflow-hidden shadow-xl flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Proses Pembayaran</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Pelanggan: <span className="font-medium text-slate-700">{customerName}</span>
              {notes ? ` · Catatan: ${notes}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Tutup modal pembayaran"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          {/* Authoritative Calculation Summary */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5 text-xs tabular-nums">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal Kotor ({preview?.items.reduce((s, i) => s + i.qty, 0) ?? 0} unit)</span>
              <span className="font-mono">{formatRupiah(preview?.subtotal ?? 0)}</span>
            </div>
            {(preview?.lineDiscountTotal ?? 0) > 0 && (
              <div className="flex justify-between text-rose-700">
                <span>Diskon Item</span>
                <span className="font-mono">-{formatRupiah(preview?.lineDiscountTotal ?? 0)}</span>
              </div>
            )}
            {(preview?.transactionDiscountAmount ?? 0) > 0 && (
              <div className="flex justify-between text-rose-700">
                <span>Diskon Transaksi</span>
                <span className="font-mono">
                  -{formatRupiah(preview?.transactionDiscountAmount ?? 0)}
                </span>
              </div>
            )}
            {(preview?.taxAmount ?? 0) > 0 && (
              <div className="flex justify-between text-slate-600">
                <span>PPN</span>
                <span className="font-mono">{formatRupiah(preview?.taxAmount ?? 0)}</span>
              </div>
            )}
            <div className="flex items-baseline justify-between pt-2 border-t border-slate-200">
              <span className="text-sm font-bold text-slate-900">Total Tagihan (Server)</span>
              <span className="font-mono text-2xl font-bold text-teal-800">
                {calculating ? 'Menghitung...' : formatRupiah(grandTotal)}
              </span>
            </div>
          </div>

          {/* Payment Mode Toggle */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setIsSplitMode(false)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  !isSplitMode ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                Pembayaran Tunggal
              </button>
              <button
                type="button"
                onClick={() => setIsSplitMode(true)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  isSplitMode ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                Split / Multi-Metode
              </button>
            </div>

            <span className="text-[11px] text-slate-500 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-teal-700" />
              Anti-ganda aktif
            </span>
          </div>

          {!isSplitMode ? (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium text-slate-700 mb-2">Pilih Metode Pembayaran</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {activeMethods.map((pm) => {
                    const Icon = getMethodIcon(pm.type);
                    const selected = selectedMethod?.id === pm.id;
                    return (
                      <button
                        key={pm.id}
                        type="button"
                        onClick={() => setSelectedMethodId(pm.id)}
                        className={`min-h-[44px] flex items-center gap-2 px-3 py-2.5 text-xs font-semibold rounded-lg border transition-colors text-left ${
                          selected
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        <span className="truncate">{pm.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {selectedMethod?.type === 'CASH' ? (
                <div className="space-y-3 p-4 bg-white border border-slate-200 rounded-xl">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-xs font-semibold text-slate-800">
                      Uang Tunai Diterima
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {quickCashOptions.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setCashTenderedInput(String(preset))}
                          className="min-h-[34px] px-2.5 py-1 text-xs font-mono font-semibold bg-slate-50 border border-slate-300 rounded-lg hover:border-teal-600 text-slate-800"
                        >
                          {preset === grandTotal ? 'Uang Pas' : formatRupiah(preset)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <input
                    type="number"
                    min="0"
                    step="500"
                    value={cashTenderedInput}
                    onChange={(e) => setCashTenderedInput(e.target.value)}
                    placeholder={`Minimal ${formatRupiah(grandTotal)}`}
                    className="w-full font-mono text-base font-semibold px-3.5 py-2.5 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                    autoFocus
                  />
                  <div className="flex items-center justify-between text-sm font-semibold pt-1 tabular-nums">
                    <span className="text-slate-600">Kembalian</span>
                    <span className={singleCashChange >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                      {cashTenderedInput === ''
                        ? 'Masukkan nominal tunai'
                        : singleCashChange >= 0
                        ? formatRupiah(singleCashChange)
                        : `Kurang ${formatRupiah(Math.abs(singleCashChange))}`}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="space-y-2 p-4 bg-white border border-slate-200 rounded-xl">
                  <label className="block text-xs font-semibold text-slate-800">
                    Nomor Referensi / Approval EDC / QRIS{' '}
                    <span className="font-normal text-slate-500">(Opsional untuk V1)</span>
                  </label>
                  <input
                    type="text"
                    value={singleReference}
                    onChange={(e) => setSingleReference(e.target.value)}
                    placeholder={`Contoh: REF-${selectedMethod?.code ?? 'PAY'}-001`}
                    className="w-full font-mono text-xs px-3 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                  <p className="text-[11px] text-slate-500">
                    Nominal ditagihkan penuh sesuai total transaksi:{' '}
                    <span className="font-mono font-semibold text-slate-800">
                      {formatRupiah(grandTotal)}
                    </span>
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2.5">
                {splitRows.map((row, idx) => {
                  const pm = activeMethods.find((m) => m.id === row.paymentMethodId);
                  const isCash = pm?.type === 'CASH';
                  return (
                    <div
                      key={row.rowId}
                      className="p-3 border border-slate-200 rounded-xl bg-white space-y-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-700">
                          Pembayaran #{idx + 1}
                        </span>
                        {splitRows.length > 2 && (
                          <button
                            type="button"
                            onClick={() =>
                              setSplitRows((prev) => prev.filter((r) => r.rowId !== row.rowId))
                            }
                            className="p-1 text-slate-400 hover:text-rose-600"
                            aria-label="Hapus baris pembayaran"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <select
                          value={row.paymentMethodId}
                          onChange={(e) =>
                            setSplitRows((prev) =>
                              prev.map((r) =>
                                r.rowId === row.rowId
                                  ? { ...r, paymentMethodId: e.target.value }
                                  : r
                              )
                            )
                          }
                          className="text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
                        >
                          {activeMethods.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>

                        <div>
                          <input
                            type="number"
                            min="0"
                            value={row.amountInput}
                            onChange={(e) =>
                              setSplitRows((prev) =>
                                prev.map((r) =>
                                  r.rowId === row.rowId
                                    ? {
                                        ...r,
                                        amountInput: e.target.value,
                                        tenderedInput: isCash ? r.tenderedInput : e.target.value,
                                      }
                                    : r
                                )
                              )
                            }
                            placeholder="Porsi Tagihan (Rp)"
                            className="w-full font-mono text-xs px-2.5 py-2 border border-slate-300 rounded-lg tabular-nums"
                          />
                        </div>

                        {isCash ? (
                          <input
                            type="number"
                            min="0"
                            value={row.tenderedInput}
                            onChange={(e) =>
                              setSplitRows((prev) =>
                                prev.map((r) =>
                                  r.rowId === row.rowId
                                    ? { ...r, tenderedInput: e.target.value }
                                    : r
                                )
                              )
                            }
                            placeholder="Tunai Diterima (Rp)"
                            className="w-full font-mono text-xs px-2.5 py-2 border border-slate-300 rounded-lg tabular-nums"
                          />
                        ) : (
                          <input
                            type="text"
                            value={row.referenceNumber}
                            onChange={(e) =>
                              setSplitRows((prev) =>
                                prev.map((r) =>
                                  r.rowId === row.rowId
                                    ? { ...r, referenceNumber: e.target.value }
                                    : r
                                )
                              )
                            }
                            placeholder={
                              pm?.requiresReference ? 'No. Referensi (Wajib)' : 'No. Referensi'
                            }
                            className="w-full font-mono text-xs px-2.5 py-2 border border-slate-300 rounded-lg"
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <button
                  type="button"
                  onClick={handleAddSplitRow}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Tambah Metode
                </button>
                <div className="font-mono tabular-nums space-x-3">
                  <span className="text-slate-600">
                    Teralokasi: <strong>{formatRupiah(splitComputed.allocated)}</strong>
                  </span>
                  <span
                    className={
                      splitComputed.remaining === 0 ? 'text-emerald-700' : 'text-amber-700'
                    }
                  >
                    Sisa: <strong>{formatRupiah(splitComputed.remaining)}</strong>
                  </span>
                  {splitComputed.totalChange > 0 && (
                    <span className="text-emerald-700">
                      Kembalian: <strong>{formatRupiah(splitComputed.totalChange)}</strong>
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5 px-5 py-4 border-t border-slate-200 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Kembali ke Keranjang
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={handleSubmit}
            className="min-h-[44px] px-5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 disabled:text-slate-500 rounded-lg transition-colors"
          >
            {submitting ? 'Menyimpan Transaksi...' : `Bayar & Selesaikan (${formatRupiah(grandTotal)})`}
          </button>
        </div>
      </div>
    </div>
  );
}
