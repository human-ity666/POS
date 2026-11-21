import { useMemo, useState } from 'react';
import { Calendar, Download, Eye, Printer, Receipt, RotateCcw, Search } from 'lucide-react';
import type { PaymentMethodConfig, Transaction, TransactionStatus } from '../types';
import { downloadCSV, formatDateTime, formatRupiah } from '../utils/format';

interface TransactionsViewProps {
  transactions: Transaction[];
  heldTransactions: Transaction[];
  paymentMethods: PaymentMethodConfig[];
  canReturnVoid?: boolean;
  onViewReceipt: (transaction: Transaction) => void;
  onOpenReceiptDetail?: (transaction: Transaction) => void;
  onViewDetail: (transaction: Transaction) => void;
  onOpenReturnVoid?: (transaction: Transaction) => void;
}

const STATUS_META: Record<TransactionStatus, { label: string; cls: string }> = {
  NEW: { label: 'BARU', cls: 'text-slate-600' },
  IN_PROGRESS: { label: 'BERJALAN', cls: 'text-sky-700' },
  HELD: { label: 'DITAHAN', cls: 'text-amber-700' },
  CANCELLED: { label: 'DIBATALKAN', cls: 'text-rose-700' },
  COMPLETED: { label: 'SELESAI', cls: 'text-emerald-700' },
  VOIDED: { label: 'DI-VOID', cls: 'text-rose-700' },
};

export function TransactionsView({
  transactions,
  heldTransactions,
  paymentMethods,
  canReturnVoid = true,
  onViewReceipt,
  onOpenReceiptDetail,
  onViewDetail,
  onOpenReturnVoid,
}: TransactionsViewProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | TransactionStatus>('ALL');
  const [methodFilter, setMethodFilter] = useState<string>('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Combine completed/cancelled/in-progress list with held transactions, deduplicated
  const allTransactions = useMemo(() => {
    const map = new Map<string, Transaction>();
    for (const t of transactions) map.set(t.id, t);
    for (const h of heldTransactions) {
      if (!map.has(h.id)) map.set(h.id, h);
    }
    return Array.from(map.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [transactions, heldTransactions]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allTransactions.filter((t) => {
      if (statusFilter !== 'ALL' && t.status !== statusFilter) return false;
      if (methodFilter !== 'ALL') {
        const matchesMethod =
          t.paymentMethod.toLowerCase().includes(methodFilter.toLowerCase()) ||
          (t.payments ?? []).some(
            (p) => p.paymentMethodName.toLowerCase() === methodFilter.toLowerCase()
          );
        if (!matchesMethod) return false;
      }
      const dateStr = t.createdAt.slice(0, 10);
      if (dateFrom && dateStr < dateFrom) return false;
      if (dateTo && dateStr > dateTo) return false;
      if (!q) return true;
      return (
        t.invoiceNumber.toLowerCase().includes(q) ||
        t.cashierName.toLowerCase().includes(q) ||
        t.customerName.toLowerCase().includes(q) ||
        t.items.some(
          (i) => i.name.toLowerCase().includes(q) || (i.sku && i.sku.toLowerCase().includes(q))
        )
      );
    });
  }, [allTransactions, search, statusFilter, methodFilter, dateFrom, dateTo]);

  const summary = useMemo(() => {
    const completed = filtered.filter((t) => t.status === 'COMPLETED');
    return {
      totalRows: filtered.length,
      completedCount: completed.length,
      revenue: completed.reduce((s, t) => s + t.total, 0),
      profit: completed.reduce((s, t) => s + t.grossProfit, 0),
    };
  }, [filtered]);

  const handleExportCSV = () => {
    const today = new Date().toISOString().slice(0, 10);
    downloadCSV(
      `riwayat-transaksi-${today}.csv`,
      [
        'No. Struk',
        'Status',
        'Tanggal',
        'Pelanggan',
        'Kasir',
        'Metode',
        'Item',
        'Subtotal',
        'Diskon',
        'PPN',
        'Total',
        'Laba Kotor',
      ],
      filtered.map((t) => [
        t.invoiceNumber,
        t.status,
        formatDateTime(t.createdAt),
        t.customerName,
        t.cashierName,
        t.paymentMethod,
        t.items.map((i) => `${i.name} (${i.qty}x)`).join('; '),
        t.subtotal,
        t.discountAmount,
        t.taxAmount,
        t.total,
        t.grossProfit,
      ])
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Transaksi Selesai / Ditampilkan</p>
          <p className="font-mono text-xl font-bold text-slate-900 tabular-nums mt-1">
            {summary.completedCount}{' '}
            <span className="text-xs font-normal text-slate-500">/ {summary.totalRows}</span>
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Total Penjualan (Selesai)</p>
          <p className="font-mono text-xl font-bold text-teal-800 tabular-nums mt-1">
            {formatRupiah(summary.revenue)}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Estimasi Laba Kotor</p>
          <p className="font-mono text-xl font-bold text-emerald-700 tabular-nums mt-1">
            {formatRupiah(summary.profit)}
          </p>
        </div>
      </div>

      {/* Filters Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari no. struk, pelanggan, kasir, atau barang..."
              className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs text-slate-600">
              <Calendar className="w-3.5 h-3.5 text-slate-400" />
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                aria-label="Tanggal mulai"
                className="text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono"
              />
              <span>–</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                aria-label="Tanggal akhir"
                className="text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono"
              />
            </div>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'ALL' | TransactionStatus)}
              aria-label="Filter status transaksi"
              className="text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">Semua Status</option>
              <option value="COMPLETED">Selesai</option>
              <option value="VOIDED">Di-Void</option>
              <option value="HELD">Ditahan (Hold)</option>
              <option value="IN_PROGRESS">Berjalan</option>
              <option value="CANCELLED">Dibatalkan</option>
            </select>

            <select
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
              aria-label="Filter metode pembayaran"
              className="text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
            >
              <option value="ALL">Semua Metode</option>
              {paymentMethods.map((m) => (
                <option key={m.id} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={handleExportCSV}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Ekspor CSV
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                <th className="py-3 px-4">No. Struk & Status</th>
                <th className="py-3 px-4">Waktu</th>
                <th className="py-3 px-4">Barang & Pelanggan</th>
                <th className="py-3 px-4">Pembayaran</th>
                <th className="py-3 px-4 text-right">Total</th>
                <th className="py-3 px-4 text-right">Laba</th>
                <th className="py-3 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    <Receipt className="w-7 h-7 text-slate-300 mx-auto mb-2" />
                    <p className="font-medium text-slate-700">
                      Tidak ada transaksi sesuai filter
                    </p>
                  </td>
                </tr>
              ) : (
                filtered.map((trx) => {
                  const meta = STATUS_META[trx.status];
                  return (
                    <tr key={trx.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 whitespace-nowrap">
                        <p className="font-mono font-semibold text-slate-900">
                          {trx.invoiceNumber}
                        </p>
                        <p className={`text-[11px] font-bold mt-0.5 ${meta.cls}`}>
                          {meta.label} · {trx.paymentStatus}
                        </p>
                        {trx.returnStatus && trx.returnStatus !== 'NONE' && trx.status === 'COMPLETED' && (
                          <p className="text-[10px] font-semibold text-amber-700 mt-0.5">
                            {trx.returnStatus === 'FULL' ? 'Retur Penuh' : 'Retur Sebagian'} (
                            {formatRupiah(trx.refundedTotal ?? 0)})
                          </p>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                        {formatDateTime(trx.createdAt)}
                      </td>
                      <td className="py-3 px-4 max-w-sm">
                        <p className="text-slate-800 truncate">
                          {trx.items.map((i) => `${i.name} (${i.qty}×)`).join(', ')}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {trx.customerName} · {trx.items.reduce((s, i) => s + i.qty, 0)} unit ·
                          Kasir: {trx.cashierName}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-slate-700 whitespace-nowrap">
                        {trx.paymentMethod}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-slate-900 tabular-nums whitespace-nowrap">
                        {formatRupiah(trx.total)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-emerald-700 tabular-nums whitespace-nowrap">
                        {trx.status === 'COMPLETED' ? formatRupiah(trx.grossProfit) : '—'}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onViewDetail(trx)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
                          >
                            <Eye className="w-3 h-3" />
                            Detail
                          </button>
                          {(trx.status === 'COMPLETED' || trx.status === 'VOIDED') && (
                            <>
                              <button
                                type="button"
                                onClick={() => onViewReceipt(trx)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 rounded-md transition-colors"
                              >
                                <Printer className="w-3 h-3" />
                                Struk
                              </button>
                              {onOpenReceiptDetail && (
                                <button
                                  type="button"
                                  onClick={() => onOpenReceiptDetail(trx)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors"
                                >
                                  <Receipt className="w-3 h-3" />
                                  Halaman Struk
                                </button>
                              )}
                            </>
                          )}
                          {trx.status === 'COMPLETED' && onOpenReturnVoid && (
                            <button
                              type="button"
                              disabled={!canReturnVoid}
                              title={
                                !canReturnVoid
                                  ? 'Akun Anda tidak memiliki hak akses Retur / Refund atau Void Transaksi.'
                                  : undefined
                              }
                              onClick={() => onOpenReturnVoid(trx)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors"
                            >
                              <RotateCcw className="w-3 h-3" />
                              Retur / Void
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
