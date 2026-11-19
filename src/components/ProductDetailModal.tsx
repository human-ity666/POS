import { useState } from 'react';
import { ArrowUpDown, Barcode, Edit3, Package, Power, Printer, X } from 'lucide-react';
import type { Product } from '../types';
import { formatDateTime, formatFileSize, formatRupiah } from '../utils/format';
import { BarcodeSvg } from './BarcodeSvg';

interface ProductDetailModalProps {
  product: Product | null;
  canEdit: boolean;
  canAdjustStock: boolean;
  onClose: () => void;
  onEdit: (product: Product) => void;
  onAdjustStock: (product: Product) => void;
  onToggleStatus: (product: Product) => Promise<void>;
  onShowBarcode: (product: Product) => void;
}

const ANGLE_LABEL: Record<string, string> = {
  front: 'Depan',
  back: 'Belakang',
  side: 'Samping',
  top: 'Atas',
  packaging: 'Kemasan',
  other: 'Lainnya',
};

const TAX_LABEL: Record<string, string> = {
  STANDARD: 'Pajak Standar (PPN)',
  EXEMPT: 'Bebas Pajak (0%)',
  REDUCED: 'Tarif Pajak Khusus (50%)',
};

export function ProductDetailModal({
  product,
  canEdit,
  canAdjustStock,
  onClose,
  onEdit,
  onAdjustStock,
  onToggleStatus,
  onShowBarcode,
}: ProductDetailModalProps) {
  const [selectedImageIdx, setSelectedImageIdx] = useState(0);
  const [imgFailedMap, setImgFailedMap] = useState<Record<string, boolean>>({});
  const [toggling, setToggling] = useState(false);

  if (!product) return null;

  const images = product.images ?? [];
  const activeImage = images[selectedImageIdx] ?? images[0] ?? null;
  const activeImageFailed = activeImage ? Boolean(imgFailedMap[activeImage.id]) : false;

  const effectiveSell =
    product.specialPrice !== null && product.specialPrice > 0
      ? product.specialPrice
      : product.sellPrice;
  const marginValue = effectiveSell - product.costPrice;
  const marginPct =
    product.costPrice > 0 ? Math.round((marginValue / product.costPrice) * 100) : 100;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Detail Produk ${product.name}`}
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="font-mono font-semibold text-slate-700">{product.sku}</span>
              <span aria-hidden="true">·</span>
              <span>{product.brandName}</span>
              <span aria-hidden="true">·</span>
              <span
                className={`font-semibold ${
                  product.status === 'ACTIVE' ? 'text-emerald-700' : 'text-rose-700'
                }`}
              >
                {product.status === 'ACTIVE' ? 'Aktif' : 'Nonaktif'}
              </span>
            </div>
            <h3 className="text-lg font-semibold text-slate-900 truncate mt-0.5">{product.name}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 shrink-0"
            aria-label="Tutup detail produk"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left column: Images + Primary Barcode */}
          <div className="lg:col-span-5 space-y-4">
            <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50">
              <div className="aspect-[4/3] w-full flex items-center justify-center bg-slate-100 overflow-hidden">
                {activeImage && !activeImageFailed ? (
                  <img
                    src={activeImage.imageUrl}
                    alt={`${product.name} — ${activeImage.fileName}`}
                    referrerPolicy="no-referrer"
                    onError={() =>
                      setImgFailedMap((prev) => ({ ...prev, [activeImage.id]: true }))
                    }
                    className="w-full h-full object-contain bg-white"
                  />
                ) : (
                  <div className="text-center p-6 text-slate-400">
                    <Package className="w-10 h-10 mx-auto mb-2 text-slate-300" />
                    <p className="text-xs font-medium text-slate-500">Belum ada foto produk</p>
                  </div>
                )}
              </div>

              {activeImage && (
                <div className="px-3 py-2 border-t border-slate-200 bg-white flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
                  <span className="truncate max-w-[180px]">{activeImage.fileName}</span>
                  <span className="font-mono tabular-nums">
                    {formatFileSize(activeImage.fileSize)}
                    {activeImage.isPrimary ? ' · Utama' : ''}
                    {activeImage.isAiReference
                      ? ` · Referensi AI (${ANGLE_LABEL[activeImage.referenceAngle] || activeImage.referenceAngle})`
                      : ''}
                  </span>
                </div>
              )}
            </div>

            {images.length > 1 && (
              <div className="grid grid-cols-5 gap-2">
                {images.map((img, idx) => (
                  <button
                    key={img.id}
                    type="button"
                    onClick={() => setSelectedImageIdx(idx)}
                    className={`aspect-square rounded-lg border overflow-hidden bg-white ${
                      idx === selectedImageIdx
                        ? 'border-teal-700 ring-2 ring-teal-600/20'
                        : 'border-slate-200 hover:border-slate-400'
                    }`}
                  >
                    <img
                      src={img.imageUrl}
                      alt={img.fileName}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}

            {/* Barcodes Card */}
            <div className="border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                  <Barcode className="w-4 h-4 text-slate-500" />
                  Barcode Terdaftar ({product.barcodes.length})
                </h4>
                <button
                  type="button"
                  onClick={() => onShowBarcode(product)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700 hover:text-teal-800"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Cetak Label
                </button>
              </div>

              <div className="flex justify-center py-2 bg-slate-50 border border-slate-200 rounded-lg">
                <BarcodeSvg value={product.barcode} height={48} width={1.6} fontSize={12} />
              </div>

              <div className="divide-y divide-slate-100 text-xs">
                {product.barcodes.map((bc) => (
                  <div key={bc.id} className="py-1.5 flex items-center justify-between gap-2">
                    <span className="font-mono font-medium text-slate-900 tabular-nums">
                      {bc.barcode}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {bc.barcodeType}
                      {bc.isPrimary ? ' · Utama' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right column: Master attributes */}
          <div className="lg:col-span-7 space-y-5">
            {product.description && (
              <div>
                <h4 className="text-xs font-semibold text-slate-500 mb-1">Deskripsi Produk</h4>
                <p className="text-sm text-slate-700 leading-relaxed">{product.description}</p>
              </div>
            )}

            {/* Pricing Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 border border-slate-200 rounded-lg">
                <p className="text-[11px] text-slate-500">Harga Modal</p>
                <p className="font-mono text-sm font-semibold text-slate-900 tabular-nums mt-0.5">
                  {formatRupiah(product.costPrice)}
                </p>
              </div>
              <div className="p-3 border border-slate-200 rounded-lg">
                <p className="text-[11px] text-slate-500">Harga Jual</p>
                <p className="font-mono text-sm font-bold text-slate-900 tabular-nums mt-0.5">
                  {formatRupiah(product.sellPrice)}
                </p>
              </div>
              <div className="p-3 border border-slate-200 rounded-lg">
                <p className="text-[11px] text-slate-500">Harga Khusus</p>
                <p className="font-mono text-sm font-bold text-teal-800 tabular-nums mt-0.5">
                  {product.specialPrice ? formatRupiah(product.specialPrice) : '-'}
                </p>
              </div>
              <div className="p-3 border border-slate-200 rounded-lg">
                <p className="text-[11px] text-slate-500">Margin Kotor</p>
                <p className="font-mono text-sm font-semibold text-emerald-700 tabular-nums mt-0.5">
                  {formatRupiah(marginValue)} ({marginPct}%)
                </p>
              </div>
            </div>

            {/* Structured Specification Table */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
                Spesifikasi & Pengaturan Master
              </div>
              <dl className="divide-y divide-slate-100 text-xs">
                <div className="grid grid-cols-3 px-4 py-2.5">
                  <dt className="text-slate-500">ID Sistem / SKU</dt>
                  <dd className="col-span-2 font-mono text-slate-900">
                    {product.id} · {product.sku}
                  </dd>
                </div>
                <div className="grid grid-cols-3 px-4 py-2.5">
                  <dt className="text-slate-500">Kategori & Subkategori</dt>
                  <dd className="col-span-2 font-medium text-slate-900">
                    {product.category}
                    {product.subcategoryName ? ` / ${product.subcategoryName}` : ''}
                  </dd>
                </div>
                <div className="grid grid-cols-3 px-4 py-2.5">
                  <dt className="text-slate-500">Merek</dt>
                  <dd className="col-span-2 font-medium text-slate-900">{product.brandName}</dd>
                </div>
                <div className="grid grid-cols-3 px-4 py-2.5">
                  <dt className="text-slate-500">Varian & Ukuran</dt>
                  <dd className="col-span-2 text-slate-900">
                    {[product.variant, product.size].filter(Boolean).join(' · ') || '-'}
                  </dd>
                </div>
                <div className="grid grid-cols-3 px-4 py-2.5">
                  <dt className="text-slate-500">Satuan / Berat / Volume</dt>
                  <dd className="col-span-2 font-mono text-slate-900 tabular-nums">
                    {product.unit}
                    {product.weight !== null ? ` · ${product.weight} g` : ''}
                    {product.volume !== null ? ` · ${product.volume} ml` : ''}
                  </dd>
                </div>
                <div className="grid grid-cols-3 px-4 py-2.5">
                  <dt className="text-slate-500">Kategori Pajak</dt>
                  <dd className="col-span-2 text-slate-900">
                    {TAX_LABEL[product.taxCategory] ?? product.taxCategory}
                  </dd>
                </div>
                <div className="grid grid-cols-3 px-4 py-2.5">
                  <dt className="text-slate-500">Stok & Minimum</dt>
                  <dd className="col-span-2 font-mono font-semibold text-slate-900 tabular-nums">
                    {product.stock} {product.unit} (Minimum alert: {product.minStock} {product.unit})
                  </dd>
                </div>
                <div className="grid grid-cols-3 px-4 py-2.5">
                  <dt className="text-slate-500">Dibuat / Diperbarui</dt>
                  <dd className="col-span-2 font-mono text-slate-600 tabular-nums">
                    {formatDateTime(product.createdAt)} · {formatDateTime(product.updatedAt)}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            {canAdjustStock && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onAdjustStock(product);
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-lg"
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
                Restok / Opname
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                disabled={toggling}
                onClick={async () => {
                  setToggling(true);
                  try {
                    await onToggleStatus(product);
                    onClose();
                  } finally {
                    setToggling(false);
                  }
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg disabled:opacity-50"
              >
                <Power className="w-3.5 h-3.5" />
                {product.status === 'ACTIVE' ? 'Nonaktifkan Produk' : 'Aktifkan Produk'}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Tutup
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onEdit(product);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
              >
                <Edit3 className="w-3.5 h-3.5" />
                Edit Produk
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
