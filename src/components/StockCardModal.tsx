import { useCallback, useEffect, useState } from 'react';
import { Download, FileSpreadsheet, RefreshCw, X } from 'lucide-react';
import type { StockCardResponse, StockMovementType, StockStatusLevel } from '../types';
import { apiFetch } from '../utils/api';
import { downloadCSV, formatDateTime, formatNumber, formatRupiah } from '../utils/format';

interface StockCardModalProps {
  productId: string | null;
  onClose: () => void;
}

export function movementTypeLabel(type: StockMovementType): string {
  switch (type) {
    case 'PENJUALAN':
      return 'Penjualan Kasir';
    case 'STOCK_IN':
      return 'Barang Masuk';
    case 'RESTOK':
      return 'Restok Cepat';
    case 'ADJUSTMENT_IN':
      return 'Penyesuaian (+)';
    case 'ADJUSTMENT_OUT':
      return 'Penyesuaian (-)';
    case 'OPNAME':
      return 'Stok Opname';
    case 'RETURN_IN':
      return 'Retur Layak Jual (+)';
    case 'VOID_IN':
      return 'Void Transaksi (+)';
    case 'STOK_AWAL':
      return 'Stok Awal';
  }
}

export function stockStatusLabel(status: StockStatusLevel): { label: string; className: string } {
  switch (status) {
    case 'NEGATIVE':
      return { label: 'Negatif', className: 'text-rose-700 font-semibold' };
    case 'OUT':
      return { label: 'Habis', className: 'text-rose-700 font-semibold' };
    case 'LOW':
      return { label: 'Menipis', className: 'text-amber-700 font-semibold' };
    case 'SAFE':
      return { label: 'Aman', className: 'text-emerald-700 font-semibold' };
  }
}

export function StockCardModal({ productId, onClose }: StockCardModalProps) {
  const [data, setData] = useState<StockCardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const loadCard = useCallback(async () => {
    if (!productId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (typeFilter !== 'ALL') qs.set('type', typeFilter);
      if (dateFrom) qs.set('dateFrom', dateFrom);
      if (dateTo) qs.set('dateTo', dateTo);
      const query = qs.toString();
      const res = await apiFetch<StockCardResponse>(
        `/api/inventory/products/${productId}/stock-card${query ? `?${query}` : ''}`
      );
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat kartu stok produk.');
    } finally {
      setLoading(false);
    }
  }, [productId, typeFilter, dateFrom, dateTo]);

  useEffect(() => {
    if (productId) {
      void loadCard();
    } else {
      setData(null);
      setTypeFilter('ALL');
      setDateFrom('');
      setDateTo('');
    }
  }, [productId, loadCard]);

  if (!productId) return null;

  const handleExport = () => {
    if (!data) return;
    const today = new Date().toISOString().slice(0, 10);
    downloadCSV(
      `kartu-stok-${data.product.sku}-${today}.csv`,
      [
        'ID Mutasi',
        'Waktu',
        'Referensi',
        'Jenis',
        'Perubahan',
        'Saldo Sebelum',
        'Saldo Sesudah',
        'Petugas',
        'Alasan',
        'Catatan',
      ],
      data.movements.map((m) => [
        m.id,
        formatDateTime(m.movementDate || m.createdAt),
        m.referenceId,
        movementTypeLabel(m.type),
        m.qtyDelta,
        m.stockBefore,
        m.stockAfter,
        m.actorName || 'Sistem',
        m.reason || '-',
        m.notes,
      ])
    );
  };

  const stInfo = data ? stockStatusLabel(data.product.stockStatus) : null;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Kartu Stok Produk"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900 truncate">
              Kartu Stok Produk {data ? `· ${data.product.name}` : ''}
            </h3>
            {data && (
              <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                {data.product.sku} · {data.product.barcode} · {data.product.category} · Satuan{' '}
                {data.product.unit}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {data && (
              <button
                type="button"
                onClick={handleExport}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                Ekspor CSV
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              aria-label="Tutup kartu stok"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          {data && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <p className="text-[11px] font-medium text-slate-500">Saldo Saat Ini</p>
                  <p className="font-mono text-base font-bold text-slate-900 tabular-nums mt-0.5">
                    {formatNumber(data.product.currentStock)} {data.product.unit}
                  </p>
                  {stInfo && (
                    <p className={`text-[11px] mt-0.5 ${stInfo.className}`}>
                      Status: {stInfo.label} (Min {data.product.minStock})
                    </p>
                  )}
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <p className="text-[11px] font-medium text-slate-500">Total Masuk (+)</p>
                  <p className="font-mono text-base font-bold text-emerald-700 tabular-nums mt-0.5">
                    +{formatNumber(data.summary.totalIn)}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">Periode tersaring</p>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <p className="text-[11px] font-medium text-slate-500">Total Keluar (-)</p>
                  <p className="font-mono text-base font-bold text-rose-700 tabular-nums mt-0.5">
                    -{formatNumber(data.summary.totalOut)}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">Penjualan & pengurangan</p>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <p className="text-[11px] font-medium text-slate-500">Perubahan Bersih</p>
                  <p className="font-mono text-base font-bold text-slate-900 tabular-nums mt-0.5">
                    {data.summary.netChange > 0
                      ? `+${formatNumber(data.summary.netChange)}`
                      : formatNumber(data.summary.netChange)}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {data.summary.movementCount} mutasi tercatat
                  </p>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <p className="text-[11px] font-medium text-slate-500">Nilai Modal / Unit</p>
                  <p className="font-mono text-base font-bold text-slate-900 tabular-nums mt-0.5">
                    {formatRupiah(data.product.costPrice)}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                    Aset {formatRupiah(data.product.assetValue)}
                  </p>
                </div>
              </div>

              {/* Filter strip */}
              <div className="flex flex-wrap items-center gap-2.5">
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  <option value="ALL">Semua Jenis Mutasi</option>
                  <option value="STOCK_IN">Barang Masuk</option>
                  <option value="PENJUALAN">Penjualan Kasir</option>
                  <option value="ADJUSTMENT_IN">Penyesuaian (+)</option>
                  <option value="ADJUSTMENT_OUT">Penyesuaian (-)</option>
                  <option value="OPNAME">Stok Opname</option>
                  <option value="RETURN_IN">Retur Layak Jual (+)</option>
                  <option value="VOID_IN">Void Transaksi (+)</option>
                  <option value="RESTOK">Restok Cepat</option>
                  <option value="STOK_AWAL">Stok Awal</option>
                </select>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500">Dari:</span>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="font-mono text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
                  />
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500">Sampai:</span>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="font-mono text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
                  />
                </div>
                {(typeFilter !== 'ALL' || dateFrom || dateTo) && (
                  <button
                    type="button"
                    onClick={() => {
                      setTypeFilter('ALL');
                      setDateFrom('');
                      setDateTo('');
                    }}
                    className="text-xs font-medium text-teal-700 hover:text-teal-800 px-2 py-1"
                  >
                    Reset Filter
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void loadCard()}
                  disabled={loading}
                  className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                  Segarkan
                </button>
              </div>
            </>
          )}

          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-3.5">Waktu</th>
                    <th className="py-2.5 px-3.5">Referensi</th>
                    <th className="py-2.5 px-3.5">Jenis Mutasi</th>
                    <th className="py-2.5 px-3.5 text-right">Perubahan</th>
                    <th className="py-2.5 px-3.5 text-right">Awal → Akhir</th>
                    <th className="py-2.5 px-3.5">Petugas</th>
                    <th className="py-2.5 px-3.5">Alasan / Catatan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {loading && !data ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        Memuat riwayat kartu stok...
                      </td>
                    </tr>
                  ) : !data || data.movements.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        <FileSpreadsheet className="w-7 h-7 text-slate-300 mx-auto mb-1.5" />
                        Belum ada catatan pergerakan stok untuk filter ini.
                      </td>
                    </tr>
                  ) : (
                    data.movements.map((mov) => (
                      <tr key={mov.id} className="hover:bg-slate-50/70">
                        <td className="py-2.5 px-3.5 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                          {formatDateTime(mov.movementDate || mov.createdAt)}
                        </td>
                        <td className="py-2.5 px-3.5 font-mono text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                          {mov.referenceId}
                        </td>
                        <td className="py-2.5 px-3.5 whitespace-nowrap">
                          <span
                            className={`font-semibold ${
                              mov.qtyDelta > 0
                                ? 'text-emerald-700'
                                : mov.qtyDelta < 0
                                ? 'text-rose-700'
                                : 'text-slate-600'
                            }`}
                          >
                            {movementTypeLabel(mov.type)}
                          </span>
                        </td>
                        <td
                          className={`py-2.5 px-3.5 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                            mov.qtyDelta > 0
                              ? 'text-emerald-700'
                              : mov.qtyDelta < 0
                              ? 'text-rose-700'
                              : 'text-slate-600'
                          }`}
                        >
                          {mov.qtyDelta > 0 ? `+${mov.qtyDelta}` : mov.qtyDelta}
                        </td>
                        <td className="py-2.5 px-3.5 text-right font-mono tabular-nums whitespace-nowrap">
                          <span className="text-slate-400 mr-1">{mov.stockBefore} →</span>
                          <span
                            className={`font-semibold ${
                              mov.stockAfter < 0 ? 'text-rose-700' : 'text-slate-900'
                            }`}
                          >
                            {mov.stockAfter}
                          </span>
                        </td>
                        <td className="py-2.5 px-3.5 text-slate-700 whitespace-nowrap">
                          {mov.actorName || 'Sistem'}
                        </td>
                        <td className="py-2.5 px-3.5 text-slate-600 max-w-xs truncate">
                          {mov.notes || mov.reason || '-'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
