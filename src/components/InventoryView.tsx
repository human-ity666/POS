import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Barcode,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  Eye,
  FileSpreadsheet,
  Package,
  PackagePlus,
  Plus,
  Power,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type { Brand, Category, Product, StoreData, UnitOfMeasure } from '../types';
import { getStoredTokens } from '../utils/api';
import { formatRupiah } from '../utils/format';
import {
  BrandsManagerTab,
  CategoriesManagerTab,
  UomsManagerTab,
} from './CatalogTaxonomyTabs';
import { ProductDetailModal } from './ProductDetailModal';
import { ProductImportModal } from './ProductImportModal';

interface InventoryViewProps {
  products: Product[];
  categories: Category[];
  brands: Brand[];
  uoms: UnitOfMeasure[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canImport: boolean;
  canManageCatalog: boolean;
  canAdjustStock: boolean;
  onAddProduct: () => void;
  onEditProduct: (product: Product) => void;
  onToggleProductStatus: (product: Product) => Promise<void>;
  onDeleteProduct: (product: Product) => Promise<void>;
  onAdjustStock: (product: Product) => void;
  onShowBarcode: (product: Product) => void;
  onViewStockCard?: (product: Product) => void;
  onStoreUpdate: (store: StoreData) => void;
}

type CatalogSubTab = 'products' | 'categories' | 'brands' | 'uoms';
type SortField = 'updatedAt' | 'sku' | 'name' | 'costPrice' | 'sellPrice' | 'stock';

export function InventoryView({
  products,
  categories,
  brands,
  uoms,
  canCreate,
  canEdit,
  canDelete,
  canImport,
  canManageCatalog,
  canAdjustStock,
  onAddProduct,
  onEditProduct,
  onToggleProductStatus,
  onDeleteProduct,
  onAdjustStock,
  onShowBarcode,
  onViewStockCard,
  onStoreUpdate,
}: InventoryViewProps) {
  const [subTab, setSubTab] = useState<CatalogSubTab>('products');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [brandFilter, setBrandFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [stockFilter, setStockFilter] = useState<'semua' | 'aman' | 'menipis' | 'habis'>('semua');

  const [sortBy, setSortBy] = useState<SortField>('updatedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [detailProduct, setDetailProduct] = useState<Product | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const parentCategories = useMemo(
    () => categories.filter((c) => !c.parentId),
    [categories]
  );

  const filteredAndSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = products.filter((p) => {
      if (categoryFilter !== 'ALL' && p.categoryId !== categoryFilter && p.category !== categoryFilter) {
        return false;
      }
      if (brandFilter !== 'ALL' && p.brandId !== brandFilter) return false;
      if (statusFilter !== 'ALL' && p.status !== statusFilter) return false;
      if (stockFilter === 'habis' && p.stock > 0) return false;
      if (stockFilter === 'menipis' && (p.stock <= 0 || p.stock > p.minStock)) return false;
      if (stockFilter === 'aman' && p.stock <= p.minStock) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q) ||
        p.brandName.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.subcategoryName.toLowerCase().includes(q) ||
        p.barcodes.some((b) => b.barcode.toLowerCase().includes(q))
      );
    });

    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (sortBy) {
        case 'sku':
          return a.sku.localeCompare(b.sku, 'id') * dir;
        case 'name':
          return a.name.localeCompare(b.name, 'id') * dir;
        case 'costPrice':
          return (a.costPrice - b.costPrice) * dir;
        case 'sellPrice':
          return (a.sellPrice - b.sellPrice) * dir;
        case 'stock':
          return (a.stock - b.stock) * dir;
        case 'updatedAt':
        default:
          return a.updatedAt.localeCompare(b.updatedAt) * dir;
      }
    });
  }, [
    products,
    search,
    categoryFilter,
    brandFilter,
    statusFilter,
    stockFilter,
    sortBy,
    sortDir,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredAndSorted.length / pageSize));

  useEffect(() => {
    setPage(1);
  }, [search, categoryFilter, brandFilter, statusFilter, stockFilter, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const paginatedProducts = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredAndSorted.slice(start, start + pageSize);
  }, [filteredAndSorted, page, pageSize]);

  const toggleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('asc');
    }
  };

  const renderSortIcon = (field: SortField) => {
    if (sortBy !== field) return <ArrowUpDown className="w-3 h-3 text-slate-400" />;
    return sortDir === 'asc' ? (
      <ArrowUp className="w-3 h-3 text-teal-700" />
    ) : (
      <ArrowDown className="w-3 h-3 text-teal-700" />
    );
  };

  const handleExportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set('search', search.trim());
      if (categoryFilter !== 'ALL') qs.set('categoryId', categoryFilter);
      if (brandFilter !== 'ALL') qs.set('brandId', brandFilter);
      if (statusFilter !== 'ALL') qs.set('status', statusFilter);
      if (stockFilter !== 'semua') qs.set('stockStatus', stockFilter);
      qs.set('sortBy', sortBy);
      qs.set('sortDir', sortDir);

      const tokens = getStoredTokens();
      const headers: Record<string, string> = {};
      if (tokens?.accessToken) {
        headers.Authorization = `Bearer ${tokens.accessToken}`;
      }
      const res = await fetch(`/api/products/export/csv?${qs.toString()}`, {
        headers,
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error('Gagal mengekspor katalog produk.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute(
        'download',
        `katalog-produk-${new Date().toISOString().slice(0, 10)}.csv`
      );
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Gagal ekspor CSV.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Sub-navigation bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          {(
            [
              { id: 'products', label: `Produk (${products.length})` },
              { id: 'categories', label: `Kategori (${categories.length})` },
              { id: 'brands', label: `Merek (${brands.length})` },
              { id: 'uoms', label: `Satuan (${uoms.length})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSubTab(tab.id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                subTab === tab.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {subTab === 'products' && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={exporting}
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg whitespace-nowrap disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              {exporting ? 'Mengekspor...' : 'Ekspor CSV'}
            </button>

            {canImport && (
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5" />
                Impor CSV
              </button>
            )}

            {canCreate && (
              <button
                type="button"
                onClick={onAddProduct}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4" />
                Tambah Produk
              </button>
            )}
          </div>
        )}
      </div>

      {exportError && (
        <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
          {exportError}
        </div>
      )}

      {subTab === 'categories' && (
        <CategoriesManagerTab
          categories={categories}
          canManage={canManageCatalog}
          onStoreUpdate={onStoreUpdate}
        />
      )}

      {subTab === 'brands' && (
        <BrandsManagerTab
          brands={brands}
          canManage={canManageCatalog}
          onStoreUpdate={onStoreUpdate}
        />
      )}

      {subTab === 'uoms' && (
        <UomsManagerTab
          uoms={uoms}
          canManage={canManageCatalog}
          onStoreUpdate={onStoreUpdate}
        />
      )}

      {subTab === 'products' && (
        <>
          {/* Filters Toolbar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari SKU, nama produk, merek, atau barcode..."
                className="w-full text-xs pl-9 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label="Filter kategori"
              className="text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-600"
            >
              <option value="ALL">Semua Kategori</option>
              {parentCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <select
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              aria-label="Filter merek"
              className="text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-600"
            >
              <option value="ALL">Semua Merek</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'ALL' | 'ACTIVE' | 'INACTIVE')}
              aria-label="Filter status produk"
              className="text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-600"
            >
              <option value="ALL">Semua Status</option>
              <option value="ACTIVE">Aktif</option>
              <option value="INACTIVE">Nonaktif</option>
            </select>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  { id: 'semua', label: 'Semua' },
                  { id: 'aman', label: 'Aman' },
                  { id: 'menipis', label: 'Menipis' },
                  { id: 'habis', label: 'Habis' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setStockFilter(tab.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    stockFilter === tab.id
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Product Master Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => toggleSort('name')}
                        className="inline-flex items-center gap-1 hover:text-slate-900"
                      >
                        Produk {renderSortIcon('name')}
                      </button>
                    </th>
                    <th className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => toggleSort('sku')}
                        className="inline-flex items-center gap-1 hover:text-slate-900"
                      >
                        SKU & Barcode {renderSortIcon('sku')}
                      </button>
                    </th>
                    <th className="py-3 px-4">Merek & Kategori</th>
                    <th className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => toggleSort('costPrice')}
                        className="inline-flex items-center gap-1 hover:text-slate-900"
                      >
                        Modal {renderSortIcon('costPrice')}
                      </button>
                    </th>
                    <th className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => toggleSort('sellPrice')}
                        className="inline-flex items-center gap-1 hover:text-slate-900"
                      >
                        Harga Jual {renderSortIcon('sellPrice')}
                      </button>
                    </th>
                    <th className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => toggleSort('stock')}
                        className="inline-flex items-center gap-1 hover:text-slate-900"
                      >
                        Stok {renderSortIcon('stock')}
                      </button>
                    </th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {paginatedProducts.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-slate-500">
                        <PackagePlus className="w-7 h-7 text-slate-300 mx-auto mb-2" />
                        <p className="font-medium text-slate-700">
                          Belum ada produk yang sesuai filter
                        </p>
                      </td>
                    </tr>
                  ) : (
                    paginatedProducts.map((product) => {
                      const isOut = product.stock <= 0;
                      const isLow = product.stock > 0 && product.stock <= product.minStock;
                      const extraBarcodesCount = Math.max(0, product.barcodes.length - 1);
                      return (
                        <tr
                          key={product.id}
                          className={`hover:bg-slate-50/70 transition-colors ${
                            product.status === 'INACTIVE' ? 'opacity-65 bg-slate-50/40' : ''
                          }`}
                        >
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3 min-w-[200px]">
                              <div className="w-10 h-10 rounded-lg border border-slate-200 bg-slate-100 overflow-hidden flex items-center justify-center shrink-0">
                                {product.primaryImageUrl ? (
                                  <img
                                    src={product.primaryImageUrl}
                                    alt={product.name}
                                    referrerPolicy="no-referrer"
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <Package className="w-4 h-4 text-slate-400" />
                                )}
                              </div>
                              <div className="min-w-0">
                                <button
                                  type="button"
                                  onClick={() => setDetailProduct(product)}
                                  className="font-semibold text-slate-900 hover:text-teal-700 text-left line-clamp-1"
                                >
                                  {product.name}
                                </button>
                                <p className="text-[11px] text-slate-500 truncate mt-0.5">
                                  {[product.variant, product.size].filter(Boolean).join(' · ') ||
                                    'Standar'}
                                </p>
                              </div>
                            </div>
                          </td>

                          <td className="py-3 px-4 whitespace-nowrap">
                            <p className="font-mono font-semibold text-slate-800">{product.sku}</p>
                            <p className="font-mono text-[11px] text-slate-500 tabular-nums mt-0.5">
                              {product.barcode}
                              {extraBarcodesCount > 0 ? ` (+${extraBarcodesCount})` : ''}
                            </p>
                          </td>

                          <td className="py-3 px-4">
                            <p className="font-medium text-slate-800">{product.brandName}</p>
                            <p className="text-[11px] text-slate-500 mt-0.5">
                              {product.category}
                              {product.subcategoryName ? ` / ${product.subcategoryName}` : ''}
                            </p>
                          </td>

                          <td className="py-3 px-4 text-right font-mono text-slate-600 tabular-nums whitespace-nowrap">
                            {formatRupiah(product.costPrice)}
                          </td>

                          <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                            {product.specialPrice ? (
                              <div>
                                <p className="font-bold text-teal-800">
                                  {formatRupiah(product.specialPrice)}
                                </p>
                                <p className="text-[10px] text-slate-400 line-through">
                                  {formatRupiah(product.sellPrice)}
                                </p>
                              </div>
                            ) : (
                              <span className="font-semibold text-slate-900">
                                {formatRupiah(product.sellPrice)}
                              </span>
                            )}
                          </td>

                          <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                            <span
                              className={`font-semibold ${
                                isOut
                                  ? 'text-rose-700'
                                  : isLow
                                  ? 'text-amber-700'
                                  : 'text-slate-900'
                              }`}
                            >
                              {product.stock} {product.unit}
                            </span>
                            <p className="text-[10px] text-slate-400 mt-0.5">
                              Min {product.minStock}
                            </p>
                          </td>

                          <td className="py-3 px-4 whitespace-nowrap">
                            <span
                              className={`font-semibold ${
                                product.status === 'INACTIVE'
                                  ? 'text-slate-500'
                                  : isOut
                                  ? 'text-rose-700'
                                  : isLow
                                  ? 'text-amber-700'
                                  : 'text-emerald-700'
                              }`}
                            >
                              {product.status === 'INACTIVE'
                                ? 'Nonaktif'
                                : isOut
                                ? 'Aktif · Habis'
                                : isLow
                                ? 'Aktif · Menipis'
                                : 'Aktif'}
                            </span>
                          </td>

                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setDetailProduct(product)}
                                title="Lihat Detail Produk"
                                className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                                aria-label={`Detail ${product.name}`}
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                              {onViewStockCard && (
                                <button
                                  type="button"
                                  onClick={() => onViewStockCard(product)}
                                  title="Lihat Kartu Stok"
                                  className="p-1.5 text-teal-700 hover:text-teal-900 hover:bg-teal-50 rounded-md transition-colors"
                                  aria-label={`Kartu Stok ${product.name}`}
                                >
                                  <FileSpreadsheet className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {canAdjustStock && (
                                <button
                                  type="button"
                                  onClick={() => onAdjustStock(product)}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 rounded-md transition-colors"
                                >
                                  <ArrowUpDown className="w-3 h-3" />
                                  Restok
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => onShowBarcode(product)}
                                title="Lihat & Cetak Barcode"
                                className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                                aria-label={`Barcode ${product.name}`}
                              >
                                <Barcode className="w-4 h-4" />
                              </button>
                              {canEdit && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => onEditProduct(product)}
                                    title="Edit Produk"
                                    className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                                    aria-label={`Edit ${product.name}`}
                                  >
                                    <Edit3 className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => onToggleProductStatus(product)}
                                    title={
                                      product.status === 'ACTIVE'
                                        ? 'Nonaktifkan Produk'
                                        : 'Aktifkan Produk'
                                    }
                                    className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                                    aria-label={`Status ${product.name}`}
                                  >
                                    <Power className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                              {canDelete &&
                                (confirmDeleteId === product.id ? (
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      try {
                                        await onDeleteProduct(product);
                                      } finally {
                                        setConfirmDeleteId(null);
                                      }
                                    }}
                                    className="px-2 py-1 text-[11px] font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-md"
                                  >
                                    Hapus?
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(product.id)}
                                    title="Hapus Produk"
                                    className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
                                    aria-label={`Hapus ${product.name}`}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Bar */}
            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2 text-slate-600 tabular-nums">
                <span>
                  Menampilkan {filteredAndSorted.length === 0 ? 0 : (page - 1) * pageSize + 1}–
                  {Math.min(page * pageSize, filteredAndSorted.length)} dari{' '}
                  {filteredAndSorted.length} produk
                </span>
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  aria-label="Baris per halaman"
                  className="px-2 py-1 bg-white border border-slate-300 rounded-md text-xs"
                >
                  <option value={10}>10 / hal</option>
                  <option value={25}>25 / hal</option>
                  <option value={50}>50 / hal</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="p-1.5 border border-slate-300 bg-white rounded-md text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                  aria-label="Halaman sebelumnya"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="px-2 font-mono text-slate-700 tabular-nums">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="p-1.5 border border-slate-300 bg-white rounded-md text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                  aria-label="Halaman berikutnya"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <ProductDetailModal
        product={detailProduct}
        canEdit={canEdit}
        canAdjustStock={canAdjustStock}
        onClose={() => setDetailProduct(null)}
        onEdit={onEditProduct}
        onAdjustStock={onAdjustStock}
        onToggleStatus={onToggleProductStatus}
        onShowBarcode={onShowBarcode}
      />

      <ProductImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={onStoreUpdate}
      />
    </div>
  );
}
