import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, RotateCcw, ShieldAlert, X } from 'lucide-react';
import type {
  PaymentMethodConfig,
  RefundPaymentType,
  RefundRecord,
  RefundRecordStatus,
  ReturnCalculationPreview,
  ReturnDispositionFinal,
  ReturnEligibilityDetail,
  ReturnStockDisposition,
  StoreData,
  TransactionReturn,
  TransactionReturnItem,
  TransactionVoidRecord,
} from '../types';
import { apiFetch, ApiError } from '../utils/api';
import { formatRupiah } from '../utils/format';

interface ReturnCreateModalProps {
  open: boolean;
  eligibility: ReturnEligibilityDetail | null;
  paymentMethods: PaymentMethodConfig[];
  onClose: () => void;
  onSuccess: (result: {
    returnRecord: TransactionReturn;
    refundRecord: RefundRecord;
    store?: StoreData;
  }) => void;
  onRequestRefundPin: (opts: { title: string; description: string }) => Promise<string>;
}

const DISPOSITION_OPTIONS: Array<{ value: ReturnStockDisposition; label: string; hint: string }> = [
  { value: 'SELLABLE', label: 'Layak Jual (Restok)', hint: 'Stok produk otomatis bertambah' },
  { value: 'DAMAGED', label: 'Rusak (Tidak Restok)', hint: 'Dicatat sebagai barang rusak' },
  { value: 'UNSELLABLE', label: 'Tidak Layak Jual', hint: 'Tidak menambah stok jual' },
  {
    value: 'PENDING_INSPECTION',
    label: 'Menunggu Inspeksi QC',
    hint: 'Stok belum bertambah sampai QC selesai',
  },
];

const RETURN_REASONS = [
  'Barang cacat / rusak saat diterima',
  'Salah pilih barang / varian',
  'Kemasan terbuka / mendekati kedaluwarsa',
  'Kesalahan input kasir',
  'Permintaan penukaran pelanggan',
];

export function ReturnCreateModal({
  open,
  eligibility,
  paymentMethods,
  onClose,
  onSuccess,
  onRequestRefundPin,
}: ReturnCreateModalProps) {
  const [selectedMap, setSelectedMap] = useState<
    Record<string, { selected: boolean; qty: number; stockDisposition: ReturnStockDisposition }>
  >({});
  const [reason, setReason] = useState(RETURN_REASONS[0]);
  const [customReason, setCustomReason] = useState('');
  const [notes, setNotes] = useState('');
  const [refundPaymentType, setRefundPaymentType] = useState<RefundPaymentType>('CASH');
  const [refundMethod, setRefundMethod] = useState('Tunai');
  const [refundReference, setRefundReference] = useState('');
  const [refundStatus, setRefundStatus] = useState<RefundRecordStatus>('COMPLETED');
  const [customRefundAmount, setCustomRefundAmount] = useState<string>('');
  const [preview, setPreview] = useState<ReturnCalculationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState('');

  useEffect(() => {
    if (!open || !eligibility) return;
    const init: Record<
      string,
      { selected: boolean; qty: number; stockDisposition: ReturnStockDisposition }
    > = {};
    for (const item of eligibility.items) {
      init[item.transactionItemId] = {
        selected: false,
        qty: item.remainingQty > 0 ? 1 : 0,
        stockDisposition: 'SELLABLE',
      };
    }
    setSelectedMap(init);
    setReason(RETURN_REASONS[0]);
    setCustomReason('');
    setNotes('');
    setRefundPaymentType('CASH');
    setRefundMethod('Tunai');
    setRefundReference('');
    setRefundStatus('COMPLETED');
    setCustomRefundAmount('');
    setPreview(null);
    setError(null);
    setIdempotencyKey(`ret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }, [open, eligibility]);

  const selectedItemsPayload = useMemo(() => {
    if (!eligibility) return [];
    return eligibility.items
      .filter((it) => it.remainingQty > 0 && selectedMap[it.transactionItemId]?.selected)
      .map((it) => {
        const entry = selectedMap[it.transactionItemId];
        return {
          transactionItemId: it.transactionItemId,
          qty: Math.max(1, Math.min(it.remainingQty, Math.floor(entry?.qty || 1))),
          stockDisposition: entry?.stockDisposition || 'SELLABLE',
        };
      });
  }, [eligibility, selectedMap]);

  useEffect(() => {
    if (!open || !eligibility || selectedItemsPayload.length === 0) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);
    apiFetch<{ preview: ReturnCalculationPreview }>(
      `/api/transactions/${eligibility.transaction.id}/returns/preview`,
      {
        method: 'POST',
        body: JSON.stringify({ items: selectedItemsPayload }),
      }
    )
      .then((res) => {
        if (!cancelled) {
          setPreview(res.preview);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Gagal menghitung kalkulasi refund.');
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, eligibility, selectedItemsPayload]);

  const paymentMethodChoices = useMemo(() => {
    const active = paymentMethods.filter((m) => m.isActive);
    const list: Array<{ label: string; type: RefundPaymentType }> = [
      { label: 'Tunai (Kas Laci)', type: 'CASH' },
      { label: 'Transfer Bank', type: 'TRANSFER' },
    ];
    for (const m of active) {
      if (m.type === 'CASH') continue;
      list.push({
        label: m.name,
        type: m.type as RefundPaymentType,
      });
    }
    list.push({ label: 'Metode Lainnya', type: 'OTHER' });
    return list;
  }, [paymentMethods]);

  if (!open || !eligibility) return null;

  const selectAllRemaining = () => {
    const next = { ...selectedMap };
    for (const item of eligibility.items) {
      if (item.remainingQty > 0) {
        next[item.transactionItemId] = {
          selected: true,
          qty: item.remainingQty,
          stockDisposition: next[item.transactionItemId]?.stockDisposition || 'SELLABLE',
        };
      }
    }
    setSelectedMap(next);
  };

  const handlePaymentChoiceChange = (val: string) => {
    const found = paymentMethodChoices.find((c) => `${c.type}::${c.label}` === val);
    if (!found) return;
    setRefundPaymentType(found.type);
    setRefundMethod(found.type === 'CASH' ? 'Tunai' : found.label);
    setRefundStatus(found.type === 'CASH' ? 'COMPLETED' : 'MANUAL_RECORDED');
  };

  const effectiveReason = reason === '__CUSTOM__' ? customReason.trim() : reason;
  const maxRemaining = preview?.maxRefundableRemaining ?? eligibility.remainingRefundableTotal;
  const suggestedRefund = preview?.totalRefundAmount ?? 0;
  const parsedOverrideAmount =
    customRefundAmount.trim() !== '' ? Number(customRefundAmount) : suggestedRefund;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (selectedItemsPayload.length === 0) {
      setError('Pilih minimal satu item barang untuk diretur.');
      return;
    }
    if (!effectiveReason || effectiveReason.length < 3) {
      setError('Alasan retur wajib diisi minimal 3 karakter.');
      return;
    }
    if (!Number.isFinite(parsedOverrideAmount) || parsedOverrideAmount < 0) {
      setError('Nominal refund tidak valid.');
      return;
    }
    if (parsedOverrideAmount > maxRemaining) {
      setError(
        `Nominal refund (${formatRupiah(parsedOverrideAmount)}) melebihi sisa nilai transaksi (${formatRupiah(maxRemaining)}).`
      );
      return;
    }

    const executeRequest = async (pinApprovalToken?: string) => {
      return apiFetch<{
        returnRecord: TransactionReturn;
        refundRecord: RefundRecord;
        store?: StoreData;
      }>(`/api/transactions/${eligibility.transaction.id}/returns`, {
        method: 'POST',
        body: JSON.stringify({
          items: selectedItemsPayload,
          reason: effectiveReason,
          notes,
          refundMethod,
          refundPaymentType,
          refundReference,
          refundStatus,
          refundAmount: Math.round(parsedOverrideAmount),
          idempotencyKey,
          ...(pinApprovalToken ? { pinApprovalToken } : {}),
        }),
      });
    };

    setSubmitting(true);
    try {
      const res = await executeRequest();
      onSuccess(res);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PIN_REQUIRED') {
        try {
          const token = await onRequestRefundPin({
            title: 'Otorisasi PIN Supervisor · Retur & Refund',
            description: `Retur transaksi ${eligibility.transaction.invoiceNumber} senilai ${formatRupiah(
              parsedOverrideAmount
            )} memerlukan persetujuan Supervisor atau Admin.`,
          });
          const res = await executeRequest(token);
          onSuccess(res);
        } catch (pinErr) {
          setError(pinErr instanceof Error ? pinErr.message : 'Otorisasi PIN gagal.');
        }
      } else {
        setError(err instanceof Error ? err.message : 'Gagal memproses retur barang.');
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
      aria-label="Proses Retur Barang & Refund"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Proses Retur & Refund · {eligibility.transaction.invoiceNumber}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
              No. Struk: {eligibility.receiptNumber} · Sisa Nilai Dapat Di-Refund:{' '}
              {formatRupiah(eligibility.remainingRefundableTotal)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Tutup modal retur"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          {/* Item Selection Table */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-800">
                1. Pilih Barang, Jumlah Retur & Disposisi Stok
              </p>
              <button
                type="button"
                onClick={selectAllRemaining}
                className="px-2.5 py-1 text-[11px] font-semibold text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-md"
              >
                Pilih Semua Sisa Item
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-3 w-10 text-center">Pilih</th>
                    <th className="py-2.5 px-3">Produk (Harga Historis)</th>
                    <th className="py-2.5 px-3 text-right">Beli / Sisa</th>
                    <th className="py-2.5 px-3 text-right">Qty Retur</th>
                    <th className="py-2.5 px-3">Disposisi Stok</th>
                    <th className="py-2.5 px-3 text-right">Nilai Terbayar Sisa</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {eligibility.items.map((item) => {
                    const entry = selectedMap[item.transactionItemId] ?? {
                      selected: false,
                      qty: 1,
                      stockDisposition: 'SELLABLE' as ReturnStockDisposition,
                    };
                    const disabled = item.remainingQty <= 0;
                    return (
                      <tr
                        key={item.transactionItemId}
                        className={disabled ? 'bg-slate-50/60 opacity-60' : 'hover:bg-slate-50/60'}
                      >
                        <td className="py-2.5 px-3 text-center">
                          <input
                            type="checkbox"
                            disabled={disabled}
                            checked={entry.selected && !disabled}
                            onChange={(e) =>
                              setSelectedMap((prev) => ({
                                ...prev,
                                [item.transactionItemId]: {
                                  ...entry,
                                  selected: e.target.checked,
                                  qty: entry.qty > 0 ? entry.qty : 1,
                                },
                              }))
                            }
                            aria-label={`Pilih ${item.name}`}
                            className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                          />
                        </td>
                        <td className="py-2.5 px-3">
                          <p className="font-semibold text-slate-900">{item.name}</p>
                          <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                            {item.sku ? `${item.sku} · ` : ''}
                            {formatRupiah(item.unitPrice)} / {item.unit}
                          </p>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                          <span className="text-slate-600">{item.originalQty}</span>
                          <span className="text-slate-400 mx-1">/</span>
                          <span className="font-bold text-slate-900">{item.remainingQty}</span>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <input
                            type="number"
                            min={1}
                            max={Math.max(1, item.remainingQty)}
                            disabled={disabled || !entry.selected}
                            value={disabled ? 0 : entry.qty}
                            onChange={(e) => {
                              const raw = parseInt(e.target.value || '1', 10);
                              const clamped = Number.isFinite(raw)
                                ? Math.max(1, Math.min(item.remainingQty, raw))
                                : 1;
                              setSelectedMap((prev) => ({
                                ...prev,
                                [item.transactionItemId]: {
                                  ...entry,
                                  qty: clamped,
                                },
                              }));
                            }}
                            aria-label={`Qty retur ${item.name}`}
                            className="w-20 text-right font-mono text-xs px-2 py-1.5 border border-slate-300 rounded-md tabular-nums disabled:bg-slate-100"
                          />
                        </td>
                        <td className="py-2.5 px-3">
                          <select
                            disabled={disabled || !entry.selected}
                            value={entry.stockDisposition}
                            onChange={(e) =>
                              setSelectedMap((prev) => ({
                                ...prev,
                                [item.transactionItemId]: {
                                  ...entry,
                                  stockDisposition: e.target.value as ReturnStockDisposition,
                                },
                              }))
                            }
                            aria-label={`Disposisi stok ${item.name}`}
                            className="text-xs px-2 py-1.5 border border-slate-300 rounded-md bg-white disabled:bg-slate-100"
                          >
                            {DISPOSITION_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono font-semibold text-slate-900 tabular-nums">
                          {formatRupiah(item.remainingRefundableAmount)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Reason & Refund Method */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border border-slate-200 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-800">2. Alasan & Catatan Retur</p>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Alasan Retur *
                </label>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  {RETURN_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                  <option value="__CUSTOM__">Lainnya (tulis manual)...</option>
                </select>
              </div>
              {reason === '__CUSTOM__' && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Keterangan Alasan *
                  </label>
                  <input
                    type="text"
                    value={customReason}
                    onChange={(e) => setCustomReason(e.target.value)}
                    placeholder="Tuliskan alasan retur barang..."
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
              )}
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Catatan Tambahan (Opsional)
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Contoh: Kemasan penyok di sudut kanan..."
                  className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg resize-none"
                />
              </div>
            </div>

            <div className="border border-slate-200 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-800">3. Metode & Nilai Refund</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Metode Refund
                  </label>
                  <select
                    value={`${refundPaymentType}::${
                      paymentMethodChoices.find((c) => c.type === refundPaymentType && (c.label === refundMethod || (refundPaymentType === 'CASH' && c.type === 'CASH')))?.label ?? paymentMethodChoices[0].label
                    }`}
                    onChange={(e) => handlePaymentChoiceChange(e.target.value)}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    {paymentMethodChoices.map((c) => (
                      <option key={`${c.type}::${c.label}`} value={`${c.type}::${c.label}`}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Status Refund
                  </label>
                  <select
                    value={refundStatus}
                    onChange={(e) => setRefundStatus(e.target.value as RefundRecordStatus)}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="COMPLETED">COMPLETED (Selesai / Dibayar)</option>
                    <option value="MANUAL_RECORDED">MANUAL_RECORDED (Non-tunai manual)</option>
                    <option value="PENDING">PENDING (Menunggu transfer/settlement)</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Referensi Refund {refundPaymentType !== 'CASH' ? '(Disarankan)' : '(Opsional)'}
                  </label>
                  <input
                    type="text"
                    value={refundReference}
                    onChange={(e) => setRefundReference(e.target.value)}
                    placeholder={
                      refundPaymentType === 'CASH' ? 'Kas Laci Kasir' : 'No. Ref / Bukti Transfer'
                    }
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Nominal Refund (Rp)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={maxRemaining}
                    value={customRefundAmount}
                    onChange={(e) => setCustomRefundAmount(e.target.value)}
                    placeholder={String(suggestedRefund)}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg font-mono tabular-nums"
                  />
                  <p className="text-[10px] text-slate-500 mt-0.5 tabular-nums">
                    Otomatis: {formatRupiah(suggestedRefund)} (Maks {formatRupiah(maxRemaining)})
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Calculation Preview Box */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="space-y-1">
              <p className="font-semibold text-slate-800">
                Ringkasan Kalkulasi Refund (Menggunakan Harga Historis Transaksi)
              </p>
              <p className="text-slate-600 tabular-nums">
                {previewLoading
                  ? 'Menghitung nilai refund proporsional...'
                  : preview
                  ? `Tipe Retur: ${preview.returnType === 'FULL' ? 'Penuh' : 'Sebagian'} · Subtotal Net: ${formatRupiah(
                      preview.subtotalRefunded
                    )} · PPN: ${formatRupiah(preview.taxRefunded)}${
                      preview.estimatedLoyaltyPointsReversed > 0
                        ? ` · Estimasi Penyesuaian Poin: -${preview.estimatedLoyaltyPointsReversed} poin`
                        : ''
                    }`
                  : 'Centang minimal 1 produk di atas untuk melihat kalkulasi nilai refund.'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] text-slate-500">Total Nilai Refund</p>
              <p className="font-mono text-lg font-bold text-teal-800 tabular-nums">
                {formatRupiah(
                  Number.isFinite(parsedOverrideAmount) ? Math.max(0, parsedOverrideAmount) : 0
                )}
              </p>
            </div>
          </div>
        </form>

        <div className="px-5 py-3.5 border-t border-slate-200 bg-white flex items-center justify-end gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || selectedItemsPayload.length === 0}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {submitting ? 'Memproses Retur...' : 'Konfirmasi & Simpan Retur'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface VoidTransactionModalProps {
  open: boolean;
  eligibility: ReturnEligibilityDetail | null;
  paymentMethods: PaymentMethodConfig[];
  onClose: () => void;
  onSuccess: (result: {
    voidRecord: TransactionVoidRecord;
    refundRecord: RefundRecord;
    store?: StoreData;
  }) => void;
  onRequestVoidPin: (opts: { title: string; description: string }) => Promise<string>;
}

const VOID_REASONS = [
  'Kesalahan input seluruh transaksi oleh kasir',
  'Pelanggan membatalkan pembelian sesaat setelah bayar',
  'Transaksi ganda / terinput dua kali',
  'Kesalahan metode pembayaran saat checkout',
];

export function VoidTransactionModal({
  open,
  eligibility,
  paymentMethods,
  onClose,
  onSuccess,
  onRequestVoidPin,
}: VoidTransactionModalProps) {
  const [reason, setReason] = useState(VOID_REASONS[0]);
  const [customReason, setCustomReason] = useState('');
  const [notes, setNotes] = useState('');
  const [refundPaymentType, setRefundPaymentType] = useState<RefundPaymentType>('CASH');
  const [refundMethod, setRefundMethod] = useState('Tunai');
  const [refundReference, setRefundReference] = useState('');
  const [refundStatus, setRefundStatus] = useState<RefundRecordStatus>('COMPLETED');
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !eligibility) return;
    setReason(VOID_REASONS[0]);
    setCustomReason('');
    setNotes('');
    const firstPay = eligibility.transaction.payments?.[0];
    if (firstPay && firstPay.paymentType !== 'CASH') {
      setRefundPaymentType(firstPay.paymentType as RefundPaymentType);
      setRefundMethod(firstPay.paymentMethodName);
      setRefundStatus('MANUAL_RECORDED');
    } else {
      setRefundPaymentType('CASH');
      setRefundMethod('Tunai');
      setRefundStatus('COMPLETED');
    }
    setRefundReference('');
    setConfirmed(false);
    setError(null);
  }, [open, eligibility]);

  const methodOptions = useMemo(() => {
    const active = paymentMethods.filter((m) => m.isActive);
    const list: Array<{ label: string; type: RefundPaymentType }> = [
      { label: 'Tunai (Kas Laci)', type: 'CASH' },
      { label: 'Transfer Bank', type: 'TRANSFER' },
    ];
    for (const m of active) {
      if (m.type === 'CASH') continue;
      list.push({ label: m.name, type: m.type as RefundPaymentType });
    }
    list.push({ label: 'Metode Lainnya', type: 'OTHER' });
    return list;
  }, [paymentMethods]);

  if (!open || !eligibility) return null;

  const trx = eligibility.transaction;
  const totalRestoreUnits = trx.items.reduce((s, i) => s + i.qty, 0);
  const effectiveReason = reason === '__CUSTOM__' ? customReason.trim() : reason;

  const handleVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!effectiveReason || effectiveReason.length < 3) {
      setError('Alasan void transaksi wajib diisi minimal 3 karakter.');
      return;
    }
    if (!confirmed) {
      setError('Centang konfirmasi sebelum melakukan Void transaksi.');
      return;
    }

    const executeRequest = async (pinApprovalToken?: string) => {
      return apiFetch<{
        voidRecord: TransactionVoidRecord;
        refundRecord: RefundRecord;
        store?: StoreData;
      }>(`/api/transactions/${trx.id}/void`, {
        method: 'POST',
        body: JSON.stringify({
          reason: effectiveReason,
          notes,
          refundMethod,
          refundPaymentType,
          refundReference,
          refundStatus,
          ...(pinApprovalToken ? { pinApprovalToken } : {}),
        }),
      });
    };

    setSubmitting(true);
    try {
      const res = await executeRequest();
      onSuccess(res);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PIN_REQUIRED') {
        try {
          const token = await onRequestVoidPin({
            title: 'Otorisasi PIN Supervisor · Void Transaksi',
            description: `Void transaksi ${trx.invoiceNumber} senilai ${formatRupiah(
              trx.total
            )} memerlukan persetujuan Supervisor atau Admin.`,
          });
          const res = await executeRequest(token);
          onSuccess(res);
        } catch (pinErr) {
          setError(pinErr instanceof Error ? pinErr.message : 'Otorisasi PIN Void dibatalkan.');
        }
      } else {
        setError(err instanceof Error ? err.message : 'Gagal memproses void transaksi.');
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
      aria-label="Void Transaksi Selesai"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl overflow-hidden shadow-xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-700" />
            <h3 className="text-base font-semibold text-slate-900">
              Void Transaksi · {trx.invoiceNumber}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Tutup modal void"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleVoid} className="p-5 overflow-y-auto space-y-4">
          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          <div className="p-3.5 bg-rose-50/70 border border-rose-200 rounded-xl text-xs text-rose-900 space-y-1.5">
            <p className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Rekaman transaksi historis & struk tetap tersimpan (tidak dihapus)
            </p>
            <p className="text-rose-800">
              Void akan mengubah status menjadi <span className="font-mono font-bold">VOIDED</span>,
              mengembalikan seluruh stok (<span className="font-mono font-bold">+{totalRestoreUnits} unit</span>{' '}
              via <span className="font-mono">VOID_IN</span>), membalik poin loyalitas jika ada, dan
              mencatat pengembalian dana senilai{' '}
              <span className="font-mono font-bold">{formatRupiah(trx.total)}</span>.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <p className="text-slate-500">No. Struk Asli</p>
              <p className="font-mono font-semibold text-slate-900 mt-0.5">
                {eligibility.receiptNumber}
              </p>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <p className="text-slate-500">Total Dikembalikan</p>
              <p className="font-mono font-bold text-rose-700 mt-0.5 tabular-nums">
                {formatRupiah(trx.total)}
              </p>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Alasan Void Transaksi *
            </label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white"
            >
              {VOID_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value="__CUSTOM__">Lainnya (tulis manual)...</option>
            </select>
          </div>

          {reason === '__CUSTOM__' && (
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Keterangan Alasan Void *
              </label>
              <input
                type="text"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="Tuliskan alasan void transaksi..."
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Metode Pengembalian Dana
              </label>
              <select
                value={`${refundPaymentType}::${
                  methodOptions.find((m) => m.type === refundPaymentType && (m.label === refundMethod || (refundPaymentType === 'CASH' && m.type === 'CASH')))?.label ?? methodOptions[0].label
                }`}
                onChange={(e) => {
                  const found = methodOptions.find(
                    (m) => `${m.type}::${m.label}` === e.target.value
                  );
                  if (!found) return;
                  setRefundPaymentType(found.type);
                  setRefundMethod(found.type === 'CASH' ? 'Tunai' : found.label);
                  setRefundStatus(found.type === 'CASH' ? 'COMPLETED' : 'MANUAL_RECORDED');
                }}
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white"
              >
                {methodOptions.map((m) => (
                  <option key={`${m.type}::${m.label}`} value={`${m.type}::${m.label}`}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Status Refund
              </label>
              <select
                value={refundStatus}
                onChange={(e) => setRefundStatus(e.target.value as RefundRecordStatus)}
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="COMPLETED">COMPLETED (Selesai)</option>
                <option value="MANUAL_RECORDED">MANUAL_RECORDED (Non-tunai manual)</option>
                <option value="PENDING">PENDING (Menunggu pembatalan EDC/QRIS)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Referensi Pembatalan / Refund
              </label>
              <input
                type="text"
                value={refundReference}
                onChange={(e) => setRefundReference(e.target.value)}
                placeholder="No. Approval EDC / Referensi Transfer"
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Catatan Audit Tambahan
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Opsional..."
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-rose-700 focus:ring-rose-600"
            />
            <span>
              Saya mengerti bahwa tindakan Void ini permanen, stok akan dikembalikan ke gudang, dan
              kejadian ini dicatat dalam log audit sensitif.
            </span>
          </label>
        </form>

        <div className="px-5 py-3.5 border-t border-slate-200 bg-white flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleVoid}
            disabled={submitting || !confirmed}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-rose-700 hover:bg-rose-800 rounded-lg disabled:opacity-50"
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            {submitting ? 'Memproses Void...' : 'Eksekusi Void Transaksi'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface InspectionResolveModalProps {
  item: TransactionReturnItem | null;
  onClose: () => void;
  onSuccess: (result: {
    returnRecord: TransactionReturn;
    item: TransactionReturnItem;
    store?: StoreData;
  }) => void;
  onRequestRefundPin: (opts: { title: string; description: string }) => Promise<string>;
}

export function InspectionResolveModal({
  item,
  onClose,
  onSuccess,
  onRequestRefundPin,
}: InspectionResolveModalProps) {
  const [disposition, setDisposition] = useState<ReturnDispositionFinal>('SELLABLE');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setDisposition('SELLABLE');
    setNotes('');
    setError(null);
  }, [item]);

  if (!item) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const executeRequest = async (pinApprovalToken?: string) => {
      return apiFetch<{
        returnRecord: TransactionReturn;
        item: TransactionReturnItem;
        store?: StoreData;
      }>(`/api/returns/items/${item.id}/resolve-inspection`, {
        method: 'POST',
        body: JSON.stringify({
          disposition,
          notes,
          ...(pinApprovalToken ? { pinApprovalToken } : {}),
        }),
      });
    };

    setSubmitting(true);
    try {
      const res = await executeRequest();
      onSuccess(res);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PIN_REQUIRED') {
        try {
          const token = await onRequestRefundPin({
            title: 'Otorisasi PIN Supervisor · Keputusan Inspeksi QC',
            description: `Penetapan status akhir item retur "${item.productName}" (${item.qty} ${item.unit}) menjadi ${disposition}.`,
          });
          const res = await executeRequest(token);
          onSuccess(res);
        } catch (pinErr) {
          setError(pinErr instanceof Error ? pinErr.message : 'Otorisasi PIN dibatalkan.');
        }
      } else {
        setError(err instanceof Error ? err.message : 'Gagal menyelesaikan inspeksi QC.');
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
      aria-label="Keputusan Inspeksi Barang Retur"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h3 className="text-base font-semibold text-slate-900">Keputusan Inspeksi QC Retur</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
            <p className="font-semibold text-slate-900">{item.productName}</p>
            <p className="font-mono text-[11px] text-slate-600 tabular-nums">
              {item.sku ? `${item.sku} · ` : ''}
              Jumlah: {item.qty} {item.unit} · Nilai Refund: {formatRupiah(item.totalRefundAmount)}
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-slate-600">
              Hasil Pemeriksaan Fisik *
            </label>
            {(
              [
                {
                  val: 'SELLABLE',
                  title: 'Layak Jual (Restok ke Gudang)',
                  desc: `Stok produk otomatis bertambah +${item.qty} ${item.unit} via RETURN_IN.`,
                },
                {
                  val: 'DAMAGED',
                  title: 'Rusak (Damaged)',
                  desc: 'Barang tidak dikembalikan ke stok jual.',
                },
                {
                  val: 'UNSELLABLE',
                  title: 'Tidak Layak Jual (Unsellable)',
                  desc: 'Barang dipisahkan dan tidak menambah stok jual.',
                },
              ] as const
            ).map((opt) => (
              <label
                key={opt.val}
                className={`flex items-start gap-2.5 p-3 border rounded-lg cursor-pointer transition-colors ${
                  disposition === opt.val
                    ? 'border-teal-600 bg-teal-50/50'
                    : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <input
                  type="radio"
                  name="finalDisposition"
                  checked={disposition === opt.val}
                  onChange={() => setDisposition(opt.val)}
                  className="mt-0.5 text-teal-700 focus:ring-teal-600"
                />
                <div>
                  <p className="font-semibold text-slate-900">{opt.title}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Catatan Inspeksi QC
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Contoh: Segel utuh, layak pajang kembali / kemasan robek..."
              className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg resize-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {submitting ? 'Menyimpan...' : 'Simpan Hasil Inspeksi'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface RefundStatusUpdateModalProps {
  refund: RefundRecord | null;
  onClose: () => void;
  onSuccess: (result: { refundRecord: RefundRecord; store?: StoreData }) => void;
}

export function RefundStatusUpdateModal({
  refund,
  onClose,
  onSuccess,
}: RefundStatusUpdateModalProps) {
  const [status, setStatus] = useState<RefundRecordStatus>('COMPLETED');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!refund) return;
    setStatus(refund.status);
    setReferenceNumber(refund.referenceNumber || '');
    setNotes(refund.notes || '');
    setError(null);
  }, [refund]);

  if (!refund) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ refundRecord: RefundRecord; store?: StoreData }>(
        `/api/refunds/${refund.id}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status, referenceNumber, notes }),
        }
      );
      onSuccess(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memperbarui status refund.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Perbarui Status Refund"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h3 className="text-base font-semibold text-slate-900">
            Perbarui Status Refund · {refund.refundNumber}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
            <p className="font-mono font-semibold text-slate-900">
              {refund.invoiceNumber} · {refund.sourceNumber}
            </p>
            <p className="text-slate-600 tabular-nums">
              Metode: {refund.refundMethod} ({refund.paymentType}) · Nominal:{' '}
              <span className="font-mono font-bold text-slate-900">
                {formatRupiah(refund.amount)}
              </span>
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Status Refund *
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as RefundRecordStatus)}
              className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white"
            >
              <option value="COMPLETED">COMPLETED (Dana Telah Diterima/Dibayar)</option>
              <option value="MANUAL_RECORDED">MANUAL_RECORDED (Dicatat Manual)</option>
              <option value="PENDING">PENDING (Menunggu Proses)</option>
              <option value="FAILED">FAILED (Gagal / Dibatalkan Bank)</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Nomor Referensi / Bukti Transfer
            </label>
            <input
              type="text"
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              placeholder="Contoh: TRF-20261120-8812"
              className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg font-mono"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">Catatan Audit</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg resize-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
            >
              {submitting ? 'Menyimpan...' : 'Simpan Perubahan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
