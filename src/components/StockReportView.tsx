import { useMemo, useState } from 'react';
import { AlertTriangle, Download, Search, ArrowUpDown, CheckCircle2 } from 'lucide-react';
import { type Product, type StockMovement, type StockMovementType, type Transaction } from '../types';
import { downloadCSV, formatDateTime, formatNumber, formatRupiah } from '../utils/format';

interface StockReportViewProps {
  products: Product[];
  stockMovements: StockMovement[];
  transactions: Transaction[];
  onQuickRestock: (product: Product) => void;
}

export function StockReportView({
  products,
  stockMovements,
  transactions,
  onQuickRestock,
}: StockReportViewProps) {
  const [activeSubTab, setActiveSubTab] = useState<'alerts' | 'movements' | 'valuation'>('alerts');
  const [movementTypeFilter, setMovementTypeFilter] = useState<'ALL' | StockMovementType>('ALL');
  const [movementSearch, setMovementSearch] = useState('');

  const metrics = useMemo(() => {
    const totalSku = products.length;
    const totalUnits = products.reduce((s, p) => s + p.stock, 0);
    const totalCostValue = products.reduce((s, p) => s + p.costPrice * p.stock, 0);
    const totalRetailValue = products.reduce((s, p) => s + p.sellPrice * p.stock, 0);
    const outOfStock = products.filter((p) => p.stock <= 0);
    const lowStock = products.filter((p) => p.stock > 0 && p.stock <= p.minStock);

    const todayStr = new Date().toISOString().slice(0, 10);
    const todaySales = transactions.filter((t) => t.createdAt.slice(0, 10) === todayStr);
    const todayRevenue = todaySales.reduce((s, t) => s + t.total, 0);
    const todayProfit = todaySales.reduce((s, t) => s + t.grossProfit, 0);
    const todayUnitsSold = todaySales.reduce(
      (s, t) => s + t.items.reduce((isum, i) => isum + i.qty, 0),
      0
    );

    return {
      totalSku,
      totalUnits,
      totalCostValue,
      totalRetailValue,
      outOfStock,
      lowStock,
      needRestockCount: outOfStock.length + lowStock.length,
      todayRevenue,
      todayProfit,
      todayUnitsSold,
    };
  }, [products, transactions]);

  const restockPriorityList = useMemo(() => {
    return products
      .filter((p) => p.stock <= p.minStock)
      .sort((a, b) => a.stock - a.minStock - (b.stock - b.minStock));
  }, [products]);

  const filteredMovements = useMemo(() => {
    const q = movementSearch.trim().toLowerCase();
    return stockMovements.filter((m) => {
      if (movementTypeFilter !== 'ALL' && m.type !== movementTypeFilter) return false;
      if (!q) return true;
      return (
        m.productName.toLowerCase().includes(q) ||
        m.barcode.toLowerCase().includes(q) ||
        m.referenceId.toLowerCase().includes(q) ||
        m.notes.toLowerCase().includes(q)
      );
    });
  }, [stockMovements, movementTypeFilter, movementSearch]);

  const categoryValuation = useMemo(() => {
    const categoryNames = Array.from(
      new Set(products.map((p) => p.category.trim() || 'Tanpa Kategori'))
    ).sort((a, b) => a.localeCompare(b, 'id'));

    return categoryNames
      .map((category) => {
        const items = products.filter((p) => (p.category.trim() || 'Tanpa Kategori') === category);
        const units = items.reduce((s, p) => s + p.stock, 0);
        const costVal = items.reduce((s, p) => s + p.costPrice * p.stock, 0);
        const retailVal = items.reduce((s, p) => s + p.sellPrice * p.stock, 0);
        const potentialMargin = retailVal - costVal;
        return {
          category,
          skuCount: items.length,
          units,
          costVal,
          retailVal,
          potentialMargin,
        };
      })
      .filter((row) => row.skuCount > 0);
  }, [products]);

  const maxCategoryRetailVal = Math.max(1, ...categoryValuation.map((c) => c.retailVal));

  const handleExportStockCSV = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (activeSubTab === 'movements') {
      downloadCSV(
        `laporan-mutasi-stok-${today}.csv`,
        ['Waktu', 'Referensi', 'Barcode', 'Produk', 'Jenis Mutasi', 'Perubahan', 'Stok Awal', 'Stok Akhir', 'Catatan'],
        filteredMovements.map((m) => [
          formatDateTime(m.createdAt),
          m.referenceId,
          m.barcode,
          m.productName,
          m.type,
          m.qtyDelta,
          m.stockBefore,
          m.stockAfter,
          m.notes,
        ])
      );
    } else {
      downloadCSV(
        `laporan-posisi-stok-${today}.csv`,
        ['SKU', 'Barcode', 'Nama Produk', 'Merek', 'Kategori', 'Satuan', 'Status Produk', 'Stok Tersedia', 'Minimum Stok', 'Status Stok', 'Harga Modal', 'Harga Jual', 'Nilai Aset Modal'],
        products.map((p) => [
          p.sku,
          p.barcode,
          p.name,
          p.brandName || '-',
          p.category,
          p.unit,
          p.status,
          p.stock,
          p.minStock,
          p.stock <= 0 ? 'Habis' : p.stock <= p.minStock ? 'Menipis' : 'Aman',
          p.costPrice,
          p.sellPrice,
          p.costPrice * p.stock,
        ])
      );
    }
  };

  const movementLabel = (type: StockMovementType) => {
    switch (type) {
      case 'PENJUALAN':
        return 'Penjualan Kasir';
      case 'RESTOK':
        return 'Restok Masuk';
      case 'OPNAME':
        return 'Stok Opname';
      case 'STOK_AWAL':
        return 'Stok Awal';
    }
  };

  return (
    <div className="space-y-5">
      {/* 4-Column KPI Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Nilai Aset Stok (Modal)</p>
          <p className="font-mono text-xl font-bold text-slate-900 tabular-nums mt-1">
            {formatRupiah(metrics.totalCostValue)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {formatNumber(metrics.totalUnits)} unit · {metrics.totalSku} SKU aktif
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Potensi Nilai Jual Stok</p>
          <p className="font-mono text-xl font-bold text-teal-800 tabular-nums mt-1">
            {formatRupiah(metrics.totalRetailValue)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            Potensi margin {formatRupiah(metrics.totalRetailValue - metrics.totalCostValue)}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Peringatan Restok Otomatis</p>
          <p
            className={`font-mono text-xl font-bold tabular-nums mt-1 ${
              metrics.needRestockCount > 0 ? 'text-amber-700' : 'text-emerald-700'
            }`}
          >
            {metrics.needRestockCount} SKU
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {metrics.outOfStock.length} habis · {metrics.lowStock.length} menipis
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Omzet & Barang Keluar Hari Ini</p>
          <p className="font-mono text-xl font-bold text-slate-900 tabular-nums mt-1">
            {formatRupiah(metrics.todayRevenue)}
          </p>
          <p className="text-xs text-emerald-700 font-medium mt-1 tabular-nums">
            Laba {formatRupiah(metrics.todayProfit)} · {formatNumber(metrics.todayUnitsSold)} terjual
          </p>
        </div>
      </div>

      {/* Sub-navigation & Export Action */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveSubTab('alerts')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              activeSubTab === 'alerts'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Peringatan Restok ({restockPriorityList.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSubTab('movements')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              activeSubTab === 'movements'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Mutasi Stok Otomatis ({stockMovements.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSubTab('valuation')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              activeSubTab === 'valuation'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Valuasi per Kategori
          </button>
        </div>

        <button
          type="button"
          onClick={handleExportStockCSV}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" />
          {activeSubTab === 'movements' ? 'Ekspor CSV Mutasi' : 'Ekspor CSV Posisi Stok'}
        </button>
      </div>

      {/* Tab 1: Automated Restock Alerts */}
      {activeSubTab === 'alerts' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Daftar Prioritas Restok Otomatis</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Produk dengan sisa stok di bawah atau sama dengan batas minimum otomatis muncul di sini setiap ada penjualan.
              </p>
            </div>
          </div>

          {restockPriorityList.length === 0 ? (
            <div className="py-12 text-center">
              <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-900">Semua Stok Dalam Kondisi Aman</p>
              <p className="text-xs text-slate-500 mt-1">
                Tidak ada produk yang berada di bawah batas minimum stok saat ini.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4">Produk</th>
                    <th className="py-3 px-4">Kategori</th>
                    <th className="py-3 px-4 text-right">Stok Sisa</th>
                    <th className="py-3 px-4 text-right">Batas Min</th>
                    <th className="py-3 px-4 text-right">Rekomendasi Order</th>
                    <th className="py-3 px-4 text-right">Estimasi Modal Order</th>
                    <th className="py-3 px-4 text-right">Tindakan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {restockPriorityList.map((item) => {
                    const recommendedQty = Math.max(10, item.minStock * 2 - item.stock);
                    const estCost = recommendedQty * item.costPrice;
                    const isZero = item.stock <= 0;
                    return (
                      <tr key={item.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <AlertTriangle
                              className={`w-4 h-4 shrink-0 ${
                                isZero ? 'text-rose-600' : 'text-amber-600'
                              }`}
                            />
                            <div>
                              <p className="font-semibold text-slate-900">{item.name}</p>
                              <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                                {item.barcode}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-slate-600">{item.category}</td>
                        <td
                          className={`py-3 px-4 text-right font-mono font-bold tabular-nums ${
                            isZero ? 'text-rose-700' : 'text-amber-700'
                          }`}
                        >
                          {item.stock} {item.unit}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-slate-600 tabular-nums">
                          {item.minStock} {item.unit}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-semibold text-teal-800 tabular-nums">
                          +{recommendedQty} {item.unit}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-slate-700 tabular-nums">
                          {formatRupiah(estCost)}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => onQuickRestock(item)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap"
                          >
                            <ArrowUpDown className="w-3.5 h-3.5" />
                            Restok Cepat
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Automated Stock Movement Ledger */}
      {activeSubTab === 'movements' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
              {(
                [
                  { id: 'ALL', label: 'Semua Mutasi' },
                  { id: 'PENJUALAN', label: 'Penjualan (-)' },
                  { id: 'RESTOK', label: 'Restok (+)' },
                  { id: 'OPNAME', label: 'Opname' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setMovementTypeFilter(f.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    movementTypeFilter === f.id
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={movementSearch}
                onChange={(e) => setMovementSearch(e.target.value)}
                placeholder="Cari produk atau no. struk..."
                className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">Waktu</th>
                  <th className="py-3 px-4">Referensi</th>
                  <th className="py-3 px-4">Produk</th>
                  <th className="py-3 px-4">Jenis</th>
                  <th className="py-3 px-4 text-right">Perubahan</th>
                  <th className="py-3 px-4 text-right">Stok Akhir</th>
                  <th className="py-3 px-4">Keterangan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredMovements.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-slate-500">
                      Belum ada catatan mutasi stok yang sesuai.
                    </td>
                  </tr>
                ) : (
                  filteredMovements.map((mov) => (
                    <tr key={mov.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                        {formatDateTime(mov.createdAt)}
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] font-medium text-slate-700 whitespace-nowrap">
                        {mov.referenceId}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-semibold text-slate-900">{mov.productName}</p>
                        <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                          {mov.barcode}
                        </p>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`font-semibold ${
                            mov.type === 'PENJUALAN'
                              ? 'text-rose-700'
                              : mov.type === 'RESTOK' || mov.type === 'STOK_AWAL'
                              ? 'text-emerald-700'
                              : 'text-amber-700'
                          }`}
                        >
                          {movementLabel(mov.type)}
                        </span>
                      </td>
                      <td
                        className={`py-3 px-4 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                          mov.qtyDelta > 0
                            ? 'text-emerald-700'
                            : mov.qtyDelta < 0
                            ? 'text-rose-700'
                            : 'text-slate-600'
                        }`}
                      >
                        {mov.qtyDelta > 0 ? `+${mov.qtyDelta}` : mov.qtyDelta}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-800 tabular-nums whitespace-nowrap">
                        <span className="text-slate-400 mr-1">{mov.stockBefore} →</span>
                        <span className="font-semibold">{mov.stockAfter}</span>
                      </td>
                      <td className="py-3 px-4 text-slate-600 max-w-xs truncate">
                        {mov.notes}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 3: Category Valuation Breakdown */}
      {activeSubTab === 'valuation' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900">Ringkasan Valuasi Stok per Kategori</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">Kategori</th>
                  <th className="py-3 px-4 text-right">Jumlah SKU</th>
                  <th className="py-3 px-4 text-right">Total Unit</th>
                  <th className="py-3 px-4 text-right">Nilai Modal</th>
                  <th className="py-3 px-4 text-right">Nilai Jual</th>
                  <th className="py-3 px-4 text-right">Potensi Laba</th>
                  <th className="py-3 px-4 w-48">Porsi Nilai Jual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {categoryValuation.map((row) => {
                  const pct = Math.round((row.retailVal / maxCategoryRetailVal) * 100);
                  return (
                    <tr key={row.category} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-semibold text-slate-900">{row.category}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">{row.skuCount}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">
                        {formatNumber(row.units)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-600 tabular-nums">
                        {formatRupiah(row.costVal)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-slate-900 tabular-nums">
                        {formatRupiah(row.retailVal)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-emerald-700 tabular-nums">
                        {formatRupiah(row.potentialMargin)}
                      </td>
                      <td className="py-3 px-4">
                        <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-teal-600 rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
