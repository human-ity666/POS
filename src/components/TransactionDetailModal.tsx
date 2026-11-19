import { Printer, ReceiptText, X } from 'lucide-react';
import type { Transaction, TransactionStatus } from '../types';
import { formatDateTime, formatRupiah } from '../utils/format';

interface TransactionDetailModalProps {
  transaction: Transaction | null;
  onClose: () => void;
  onPrintReceipt: (trx: Transaction) => void;
  onOpenReceiptDetail?: (trx: Transaction) => void;
  onResumeHeld?: (trx: Transaction) => void;
  onCancelHeld?: (trx: Transaction) => void;
}

const STATUS_LABEL: Record<TransactionStatus, { text: string; cls: string }> = {
  NEW: { text: 'BARU', cls: 'text-slate-700' },
  IN_PROGRESS: { text: 'BERJALAN', cls: 'text-sky-700' },
  HELD: { text: 'DITAHAN', cls: 'text-amber-700' },
  CANCELLED: { text: 'DIBATALKAN', cls: 'text-rose-700' },
  COMPLETED: { text: 'SELESAI', cls: 'text-emerald-700' },
};

export function TransactionDetailModal({
  transaction,
  onClose,
  onPrintReceipt,
  onOpenReceiptDetail,
  onResumeHeld,
  onCancelHeld,
}: TransactionDetailModalProps) {
  if (!transaction) return null;

  const statusMeta = STATUS_LABEL[transaction.status];

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Detail Transaksi"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl overflow-hidden shadow-xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-mono text-base font-bold text-slate-900">
                {transaction.invoiceNumber}
              </h3>
              <span className={`text-xs font-bold ${statusMeta.cls}`}>· {statusMeta.text}</span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              Dibuat {formatDateTime(transaction.createdAt)} · Kasir: {transaction.cashierName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Tutup detail transaksi"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <p className="text-slate-500">Pelanggan</p>
              <p className="font-semibold text-slate-900 mt-0.5">{transaction.customerName}</p>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <p className="text-slate-500">Status Pembayaran</p>
              <p className="font-semibold text-slate-900 mt-0.5">{transaction.paymentStatus}</p>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <p className="text-slate-500">Metode Pembayaran</p>
              <p className="font-semibold text-slate-900 mt-0.5">{transaction.paymentMethod}</p>
            </div>
          </div>

          {transaction.notes && (
            <div className="p-3 text-xs bg-amber-50/70 border border-amber-200 rounded-lg text-amber-900">
              Catatan transaksi: {transaction.notes}
            </div>
          )}

          {/* Items Table */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                  <th className="py-2.5 px-3">Produk</th>
                  <th className="py-2.5 px-3 text-right">Qty</th>
                  <th className="py-2.5 px-3 text-right">Harga Satuan</th>
                  <th className="py-2.5 px-3 text-right">Diskon Item</th>
                  <th className="py-2.5 px-3 text-right">PPN Item</th>
                  <th className="py-2.5 px-3 text-right">Subtotal Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {transaction.items.map((item, idx) => (
                  <tr key={`${item.productId}-${idx}`}>
                    <td className="py-2.5 px-3">
                      <p className="font-semibold text-slate-900">{item.name}</p>
                      <p className="font-mono text-[11px] text-slate-500">
                        {item.sku ? `${item.sku} · ` : ''}
                        {item.barcode}
                        {item.priceOverride ? ' · Harga Override' : ''}
                      </p>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      {item.qty} {item.unit}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      {formatRupiah(item.sellPrice)}
                      {item.priceOverride && item.originalSellPrice !== undefined && (
                        <span className="block text-[10px] text-slate-400 line-through">
                          {formatRupiah(item.originalSellPrice)}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-rose-700">
                      {(item.lineDiscountAmount ?? 0) > 0
                        ? `-${formatRupiah(item.lineDiscountAmount ?? 0)}`
                        : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-slate-600">
                      {(item.taxAmount ?? 0) > 0 ? formatRupiah(item.taxAmount ?? 0) : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono font-semibold text-slate-900">
                      {formatRupiah(item.subtotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Payment Lines Breakdown */}
          {transaction.payments && transaction.payments.length > 0 && (
            <div className="border border-slate-200 rounded-xl p-3.5 space-y-2">
              <p className="text-xs font-semibold text-slate-800">Rincian Pembayaran</p>
              <div className="divide-y divide-slate-100 text-xs tabular-nums">
                {transaction.payments.map((p) => (
                  <div key={p.id} className="py-1.5 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-semibold text-slate-900">{p.paymentMethodName}</span>
                      {p.referenceNumber && (
                        <span className="font-mono text-[11px] text-slate-500 ml-2">
                          Ref: {p.referenceNumber}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-right">
                      <span className="font-semibold text-slate-900">{formatRupiah(p.amount)}</span>
                      {p.changeAmount > 0 && (
                        <span className="text-[11px] text-emerald-700 ml-2">
                          (Bayar {formatRupiah(p.tenderedAmount)} · Kembali{' '}
                          {formatRupiah(p.changeAmount)})
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Totals Breakdown */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5 text-xs tabular-nums">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal Kotor</span>
              <span className="font-mono">{formatRupiah(transaction.subtotal)}</span>
            </div>
            {transaction.lineDiscountTotal > 0 && (
              <div className="flex justify-between text-rose-700">
                <span>Total Diskon Item</span>
                <span className="font-mono">-{formatRupiah(transaction.lineDiscountTotal)}</span>
              </div>
            )}
            {transaction.transactionDiscountAmount > 0 && (
              <div className="flex justify-between text-rose-700">
                <span>Diskon Transaksi</span>
                <span className="font-mono">
                  -{formatRupiah(transaction.transactionDiscountAmount)}
                </span>
              </div>
            )}
            {transaction.taxAmount > 0 && (
              <div className="flex justify-between text-slate-600">
                <span>PPN</span>
                <span className="font-mono">{formatRupiah(transaction.taxAmount)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm font-bold text-slate-900 pt-2 border-t border-slate-200">
              <span>Grand Total</span>
              <span className="font-mono text-teal-800">{formatRupiah(transaction.total)}</span>
            </div>
            {transaction.status === 'COMPLETED' && (
              <div className="flex justify-between text-[11px] text-emerald-700 pt-1">
                <span>Estimasi Laba Kotor (Modal {formatRupiah(transaction.totalCost)})</span>
                <span className="font-mono font-semibold">{formatRupiah(transaction.grossProfit)}</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2.5 px-5 py-3.5 border-t border-slate-200 bg-white">
          {(transaction.status === 'HELD' || transaction.status === 'IN_PROGRESS') &&
            onCancelHeld && (
              <button
                type="button"
                onClick={() => onCancelHeld(transaction)}
                className="px-3.5 py-2 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100"
              >
                Batalkan Transaksi
              </button>
            )}
          {(transaction.status === 'HELD' || transaction.status === 'IN_PROGRESS') &&
            onResumeHeld && (
              <button
                type="button"
                onClick={() => onResumeHeld(transaction)}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800"
              >
                Lanjutkan di Kasir
              </button>
            )}
          {transaction.status === 'COMPLETED' && (
            <>
              {onOpenReceiptDetail && (
                <button
                  type="button"
                  onClick={() => onOpenReceiptDetail(transaction)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100"
                >
                  <ReceiptText className="w-3.5 h-3.5" />
                  Halaman Struk Lengkap
                </button>
              )}
              <button
                type="button"
                onClick={() => onPrintReceipt(transaction)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800"
              >
                <Printer className="w-3.5 h-3.5" />
                Pratinjau & Cetak
              </button>
            </>
          )}
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
