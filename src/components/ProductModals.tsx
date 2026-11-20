import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  Camera,
  ImagePlus,
  Plus,
  Printer,
  RefreshCw,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import {
  BARCODE_TYPES,
  type BarcodeType,
  type Brand,
  type Category,
  type ImageReferenceAngle,
  type Product,
  type ProductStatus,
  type StockMovementType,
  type StoreData,
  type TaxCategory,
  type UnitOfMeasure,
} from '../types';
import { apiFetch } from '../utils/api';
import {
  formatFileSize,
  formatRupiah,
  generateValidEAN13,
  playScannerSound,
  readFileAsDataUrl,
} from '../utils/format';
import type { ScanResultFeedback } from '../utils/barcodeScanner';
import type { RecognitionNewProductPrefill } from './AiRecognitionModal';
import { BarcodeSvg } from './BarcodeSvg';
import { CameraPhotoCaptureModal } from './CameraPhotoCaptureModal';
import { CameraScanner, type CameraScanEventMeta } from './CameraScanner';

interface DraftBarcode {
  key: string;
  barcode: string;
  barcodeType: BarcodeType;
  isPrimary: boolean;
}

interface QueuedImage {
  key: string;
  fileName: string;
  mimeType: string;
  dataBase64: string;
  fileSize: number;
  isPrimary: boolean;
  isAiReference: boolean;
  referenceAngle: ImageReferenceAngle;
}

export interface ProductSavePayload {
  id?: string;
  sku: string;
  barcodes: Array<{ barcode: string; barcodeType: BarcodeType; isPrimary: boolean }>;
  barcode: string;
  name: string;
  description: string;
  brandId: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  uomId: string | null;
  unit: string;
  variant: string;
  size: string;
  weight: number | null;
  volume: number | null;
  costPrice: number;
  sellPrice: number;
  specialPrice: number | null;
  taxCategory: TaxCategory;
  stock: number;
  minStock: number;
  status: ProductStatus;
}

interface ProductFormModalProps {
  open: boolean;
  editingProduct: Product | null;
  initialBarcode?: string;
  initialRecognitionPrefill?: RecognitionNewProductPrefill | null;
  categories: Category[];
  brands: Brand[];
  uoms: UnitOfMeasure[];
  existingProducts: Product[];
  onClose: () => void;
  onSubmit: (payload: ProductSavePayload) => Promise<Product>;
  onStoreUpdate: (store: StoreData) => void;
}

const ANGLE_OPTIONS: Array<{ value: ImageReferenceAngle; label: string }> = [
  { value: 'front', label: 'Tampak Depan' },
  { value: 'back', label: 'Tampak Belakang' },
  { value: 'side', label: 'Tampak Samping' },
  { value: 'top', label: 'Tampak Atas' },
  { value: 'packaging', label: 'Detail Kemasan' },
  { value: 'other', label: 'Lainnya' },
];

export function ProductFormModal({
  open,
  editingProduct,
  initialBarcode,
  initialRecognitionPrefill,
  categories,
  brands,
  uoms,
  existingProducts,
  onClose,
  onSubmit,
  onStoreUpdate,
}: ProductFormModalProps) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<ProductStatus>('ACTIVE');

  const [barcodes, setBarcodes] = useState<DraftBarcode[]>([]);
  const [newBarcodeVal, setNewBarcodeVal] = useState('');
  const [newBarcodeType, setNewBarcodeType] = useState<BarcodeType>('EAN-13');

  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [variant, setVariant] = useState('');
  const [size, setSize] = useState('');

  const [uomId, setUomId] = useState('');
  const [weight, setWeight] = useState('');
  const [volume, setVolume] = useState('');

  const [costPrice, setCostPrice] = useState('0');
  const [sellPrice, setSellPrice] = useState('0');
  const [specialPrice, setSpecialPrice] = useState('');
  const [taxCategory, setTaxCategory] = useState<TaxCategory>('STANDARD');

  const [stock, setStock] = useState('10');
  const [minStock, setMinStock] = useState('5');

  const [queuedImages, setQueuedImages] = useState<QueuedImage[]>([]);
  const [liveProduct, setLiveProduct] = useState<Product | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [barcodeScannerOpen, setBarcodeScannerOpen] = useState(false);
  const [barcodeSoundEnabled, setBarcodeSoundEnabled] = useState(true);
  const [barcodeScanStatus, setBarcodeScanStatus] = useState<ScanResultFeedback | null>(null);
  const [imageBusy, setImageBusy] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentCategories = useMemo(
    () => categories.filter((c) => !c.parentId && (c.isActive || c.id === categoryId)),
    [categories, categoryId]
  );

  const availableSubcategories = useMemo(
    () =>
      categories.filter(
        (c) => c.parentId === categoryId && (c.isActive || c.id === subcategoryId)
      ),
    [categories, categoryId, subcategoryId]
  );

  const activeBrands = useMemo(
    () => brands.filter((b) => b.isActive || b.id === brandId),
    [brands, brandId]
  );

  const activeUoms = useMemo(
    () => uoms.filter((u) => u.isActive || u.id === uomId),
    [uoms, uomId]
  );

  useEffect(() => {
    if (!open) {
      setBarcodeScannerOpen(false);
      return;
    }
    setError(null);
    setQueuedImages([]);
    setNewBarcodeVal('');
    setNewBarcodeType('EAN-13');
    setBarcodeScannerOpen(false);
    setBarcodeScanStatus(null);

    if (editingProduct) {
      setLiveProduct(editingProduct);
      setSku(editingProduct.sku);
      setName(editingProduct.name);
      setDescription(editingProduct.description || '');
      setStatus(editingProduct.status || 'ACTIVE');
      setBarcodes(
        editingProduct.barcodes.length > 0
          ? editingProduct.barcodes.map((b) => ({
              key: b.id,
              barcode: b.barcode,
              barcodeType: b.barcodeType,
              isPrimary: b.isPrimary,
            }))
          : [
              {
                key: 'primary-0',
                barcode: editingProduct.barcode,
                barcodeType: 'EAN-13',
                isPrimary: true,
              },
            ]
      );
      setCategoryId(editingProduct.categoryId || '');
      setSubcategoryId(editingProduct.subcategoryId || '');
      setBrandId(editingProduct.brandId || '');
      setVariant(editingProduct.variant || '');
      setSize(editingProduct.size || '');
      setUomId(editingProduct.uomId || '');
      setWeight(editingProduct.weight !== null ? String(editingProduct.weight) : '');
      setVolume(editingProduct.volume !== null ? String(editingProduct.volume) : '');
      setCostPrice(String(editingProduct.costPrice));
      setSellPrice(String(editingProduct.sellPrice));
      setSpecialPrice(
        editingProduct.specialPrice !== null ? String(editingProduct.specialPrice) : ''
      );
      setTaxCategory(editingProduct.taxCategory || 'STANDARD');
      setStock(String(editingProduct.stock));
      setMinStock(String(editingProduct.minStock));
    } else {
      setLiveProduct(null);
      const nextNum = existingProducts.length + 1;
      setSku(`SKU-${String(nextNum).padStart(4, '0')}`);

      const ocr = initialRecognitionPrefill?.ocrSignals;
      setName(ocr?.productName || '');
      setDescription(ocr?.rawText ? `OCR AI: ${ocr.rawText.slice(0, 180)}` : '');
      setStatus('ACTIVE');
      const preBarcode = ocr?.productCode || initialBarcode;
      setBarcodes([
        {
          key: 'new-bc-0',
          barcode: preBarcode || generateValidEAN13(),
          barcodeType: preBarcode && !/^\d{13}$/.test(preBarcode) ? 'CODE-128' : 'EAN-13',
          isPrimary: true,
        },
      ]);
      const defaultCat = categories.find((c) => !c.parentId && c.isActive);
      const matchedBrand = ocr?.brand
        ? brands.find(
            (b) =>
              b.isActive &&
              (b.name.toLowerCase().includes(ocr.brand.toLowerCase()) ||
                ocr.brand.toLowerCase().includes(b.name.toLowerCase()))
          )
        : undefined;
      const defaultBrand =
        matchedBrand || brands.find((b) => b.name.toLowerCase() === 'umum') || brands[0];
      const defaultUom = uoms.find((u) => u.code === 'PCS') || uoms[0];
      setCategoryId(defaultCat?.id || '');
      setSubcategoryId('');
      setBrandId(defaultBrand?.id || '');
      setVariant([ocr?.variant, ocr?.flavor].filter(Boolean).join(' ').trim());
      setSize(ocr?.size || ocr?.weight || ocr?.volume || '');
      setUomId(defaultUom?.id || '');

      const weightNum = ocr?.weight?.match(/(\d+(?:\.\d+)?)/)?.[1];
      const volumeNum = ocr?.volume?.match(/(\d+(?:\.\d+)?)/)?.[1];
      setWeight(weightNum || '');
      setVolume(volumeNum || '');
      setCostPrice('');
      setSellPrice('');
      setSpecialPrice('');
      setTaxCategory('STANDARD');
      setStock('10');
      setMinStock('5');

      if (initialRecognitionPrefill?.capturedImageDataUrl) {
        const dataUrl = initialRecognitionPrefill.capturedImageDataUrl;
        setQueuedImages([
          {
            key: `ai-prefill-${Date.now()}`,
            fileName: `ai-capture-${Date.now()}.jpg`,
            mimeType: 'image/jpeg',
            dataBase64: dataUrl,
            fileSize: Math.floor((dataUrl.length * 3) / 4),
            isPrimary: true,
            isAiReference: true,
            referenceAngle: 'front',
          },
        ]);
      }
    }
  }, [
    open,
    editingProduct,
    initialBarcode,
    initialRecognitionPrefill,
    categories,
    brands,
    uoms,
    existingProducts.length,
  ]);

  if (!open) return null;

  const generateAutoSku = () => {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    setSku(`SKU-${String(existingProducts.length + 1).padStart(4, '0')}-${suffix}`);
  };

  const handleAddExtraBarcode = () => {
    setError(null);
    const code = newBarcodeVal.trim();
    if (!code) {
      setError('Masukkan nilai barcode tambahan terlebih dahulu.');
      return;
    }
    if (barcodes.some((b) => b.barcode.toLowerCase() === code.toLowerCase())) {
      setError(`Barcode "${code}" sudah ada dalam daftar produk ini.`);
      return;
    }
    const conflictProduct = existingProducts.find(
      (p) =>
        p.id !== editingProduct?.id &&
        (p.barcode.toLowerCase() === code.toLowerCase() ||
          p.barcodes.some((b) => b.barcode.toLowerCase() === code.toLowerCase()))
    );
    if (conflictProduct) {
      setError(`Barcode "${code}" sudah digunakan oleh produk "${conflictProduct.name}".`);
      return;
    }
    setBarcodes((prev) => [
      ...prev,
      {
        key: `bc-${Date.now()}`,
        barcode: code,
        barcodeType: newBarcodeType,
        isPrimary: prev.length === 0,
      },
    ]);
    setNewBarcodeVal('');
  };

  const handleSetPrimaryBarcode = (key: string) => {
    setBarcodes((prev) => prev.map((b) => ({ ...b, isPrimary: b.key === key })));
  };

  const handleRemoveBarcode = (key: string) => {
    if (barcodes.length <= 1) {
      setError('Produk wajib memiliki minimal satu barcode.');
      return;
    }
    setBarcodes((prev) => {
      const next = prev.filter((b) => b.key !== key);
      if (!next.some((b) => b.isPrimary) && next[0]) {
        next[0] = { ...next[0], isPrimary: true };
      }
      return next;
    });
  };

  const handleUploadImagePayload = async (img: {
    fileName: string;
    mimeType: string;
    dataBase64: string;
    fileSize: number;
  }) => {
    setError(null);
    if (liveProduct) {
      setImageBusy(true);
      try {
        const res = await apiFetch<{ product: Product; store: StoreData }>(
          `/api/products/${liveProduct.id}/images`,
          {
            method: 'POST',
            body: JSON.stringify({
              fileName: img.fileName,
              mimeType: img.mimeType,
              dataBase64: img.dataBase64,
              isPrimary: (liveProduct.images?.length ?? 0) === 0,
              isAiReference: true,
              referenceAngle: 'front',
            }),
          }
        );
        setLiveProduct(res.product);
        onStoreUpdate(res.store);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Gagal mengunggah gambar produk.');
      } finally {
        setImageBusy(false);
      }
    } else {
      setQueuedImages((prev) => [
        ...prev,
        {
          key: `qimg-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          fileName: img.fileName,
          mimeType: img.mimeType,
          dataBase64: img.dataBase64,
          fileSize: img.fileSize,
          isPrimary: prev.length === 0,
          isAiReference: true,
          referenceAngle: 'front',
        },
      ]);
    }
  };

  const handleFileInput = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const file of files) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        setError(`Format "${file.name}" tidak didukung. Gunakan JPG, PNG, atau WEBP.`);
        continue;
      }
      if (file.size > 3 * 1024 * 1024) {
        setError(`Ukuran "${file.name}" melebihi batas maksimal 3 MB.`);
        continue;
      }
      const dataUrl = await readFileAsDataUrl(file);
      await handleUploadImagePayload({
        fileName: file.name,
        mimeType: file.type,
        dataBase64: dataUrl,
        fileSize: file.size,
      });
    }
  };

  const handleUpdateExistingImage = async (
    imageId: string,
    patch: { isPrimary?: boolean; isAiReference?: boolean; referenceAngle?: ImageReferenceAngle }
  ) => {
    if (!liveProduct) return;
    setImageBusy(true);
    try {
      const res = await apiFetch<{ product: Product; store: StoreData }>(
        `/api/products/${liveProduct.id}/images/${imageId}`,
        {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }
      );
      setLiveProduct(res.product);
      onStoreUpdate(res.store);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memperbarui gambar.');
    } finally {
      setImageBusy(false);
    }
  };

  const handleDeleteExistingImage = async (imageId: string) => {
    if (!liveProduct) return;
    setImageBusy(true);
    try {
      const res = await apiFetch<{ product: Product; store: StoreData }>(
        `/api/products/${liveProduct.id}/images/${imageId}`,
        { method: 'DELETE' }
      );
      setLiveProduct(res.product);
      onStoreUpdate(res.store);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus gambar.');
    } finally {
      setImageBusy(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !sku.trim()) {
      setError('SKU dan nama produk wajib diisi.');
      return;
    }
    if (barcodes.length === 0 || barcodes.some((b) => !b.barcode.trim())) {
      setError('Semua baris barcode harus terisi.');
      return;
    }

    const parsedCostPrice = Math.round(Number(costPrice || 0));
    const parsedSellPrice = Math.round(Number(sellPrice || 0));
    const parsedSpecialPrice = specialPrice.trim() ? Math.round(Number(specialPrice)) : null;

    if (!Number.isFinite(parsedCostPrice) || parsedCostPrice < 0) {
      setError('Harga beli/modal harus bernilai 0 atau lebih.');
      return;
    }
    if (!Number.isFinite(parsedSellPrice) || parsedSellPrice <= 0) {
      setError('Harga jual normal harus lebih besar dari Rp 0.');
      return;
    }
    if (parsedSellPrice < parsedCostPrice) {
      setError('Harga jual normal tidak boleh kurang dari harga beli/modal.');
      return;
    }
    if (
      parsedSpecialPrice !== null &&
      (!Number.isFinite(parsedSpecialPrice) || parsedSpecialPrice < 0)
    ) {
      setError('Harga khusus/promo tidak valid.');
      return;
    }
    if (
      parsedSpecialPrice !== null &&
      parsedSpecialPrice > 0 &&
      parsedSpecialPrice < parsedCostPrice
    ) {
      setError('Harga khusus/promo tidak boleh kurang dari harga beli/modal.');
      return;
    }

    const selectedUom = uoms.find((u) => u.id === uomId);
    const primaryBarcode = barcodes.find((b) => b.isPrimary)?.barcode ?? barcodes[0].barcode;

    setSubmitting(true);
    try {
      const saved = await onSubmit({
        id: editingProduct?.id,
        sku: sku.trim(),
        barcodes: barcodes.map((b) => ({
          barcode: b.barcode.trim(),
          barcodeType: b.barcodeType,
          isPrimary: b.isPrimary,
        })),
        barcode: primaryBarcode.trim(),
        name: name.trim(),
        description: description.trim(),
        brandId: brandId || null,
        categoryId: categoryId || null,
        subcategoryId: subcategoryId || null,
        uomId: uomId || null,
        unit: selectedUom?.code || 'PCS',
        variant: variant.trim(),
        size: size.trim(),
        weight: weight.trim() ? Number(weight) : null,
        volume: volume.trim() ? Number(volume) : null,
        costPrice: Number(costPrice || 0),
        sellPrice: Number(sellPrice || 0),
        specialPrice: specialPrice.trim() ? Number(specialPrice) : null,
        taxCategory,
        stock: Number(stock || 0),
        minStock: Number(minStock || 0),
        status,
      });

      // If creating a new product and images were queued, upload them right away
      if (!editingProduct && queuedImages.length > 0) {
        let latestStore: StoreData | null = null;
        for (const q of queuedImages) {
          const imgRes = await apiFetch<{ product: Product; store: StoreData }>(
            `/api/products/${saved.id}/images`,
            {
              method: 'POST',
              body: JSON.stringify({
                fileName: q.fileName,
                mimeType: q.mimeType,
                dataBase64: q.dataBase64,
                isPrimary: q.isPrimary,
                isAiReference: q.isAiReference,
                referenceAngle: q.referenceAngle,
              }),
            }
          );
          latestStore = imgRes.store;
        }
        if (latestStore) onStoreUpdate(latestStore);
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan data produk.');
    } finally {
      setSubmitting(false);
    }
  };

  const numCost = Number(costPrice || 0);
  const numSell = Number(sellPrice || 0);
  const numSpecial = specialPrice.trim() ? Number(specialPrice) : null;
  const effectivePrice = numSpecial && numSpecial > 0 ? numSpecial : numSell;
  const estMargin = effectivePrice - numCost;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label={editingProduct ? 'Edit Produk Master' : 'Tambah Produk Master'}
      >
        <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden shadow-xl">
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                {editingProduct ? `Edit Master Produk · ${editingProduct.sku}` : 'Tambah Produk Baru'}
              </h3>
              <p className="text-xs text-slate-500">
                Data master produk menjadi acuan kasir, pemindaian barcode, stok, dan referensi gambar.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              aria-label="Tutup modal produk"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-6">
            {error && (
              <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                {error}
              </div>
            )}

            {/* 1. Basic Information */}
            <section className="space-y-3">
              <h4 className="text-xs font-semibold text-slate-900 pb-2 border-b border-slate-200">
                1. Informasi Dasar
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className="sm:col-span-4">
                  <label className="block text-xs font-medium text-slate-700 mb-1">SKU *</label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={sku}
                      onChange={(e) => setSku(e.target.value)}
                      required
                      placeholder="SKU-0001"
                      className="flex-1 font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <button
                      type="button"
                      onClick={generateAutoSku}
                      title="Buat SKU otomatis"
                      className="px-2.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg shrink-0"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="sm:col-span-5">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nama Produk *
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    placeholder="Contoh: Teh Botol Sosro Kotak 250ml"
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div className="sm:col-span-3">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Status Produk
                  </label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as ProductStatus)}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    <option value="ACTIVE">Aktif (Dijual)</option>
                    <option value="INACTIVE">Nonaktif (Arsip)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Deskripsi</label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Deskripsi singkat produk, catatan kemasan, atau komposisi..."
                  className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </section>

            {/* 2. Identification & Barcode */}
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-200">
                <h4 className="text-xs font-semibold text-slate-900">
                  2. Identifikasi & Multi-Barcode ({barcodes.length})
                </h4>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setBarcodeScannerOpen((v) => !v)}
                    className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-md border transition-colors ${
                      barcodeScannerOpen
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-teal-50 text-teal-800 border-teal-200 hover:bg-teal-100'
                    }`}
                  >
                    <Camera className="w-3.5 h-3.5" />
                    {barcodeScannerOpen ? 'Tutup Pemindai' : 'Scan Barcode Kamera'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewBarcodeVal(generateValidEAN13())}
                    className="text-[11px] font-semibold text-teal-700 hover:text-teal-800"
                  >
                    Isi Barcode EAN-13 Acak
                  </button>
                </div>
              </div>

              {barcodeScannerOpen && (
                <CameraScanner
                  active={barcodeScannerOpen}
                  onToggle={() => setBarcodeScannerOpen(false)}
                  onScanBarcode={(code: string, meta?: CameraScanEventMeta) => {
                    const detectedFmt =
                      meta?.format && meta.format !== 'UNKNOWN' ? meta.format : 'EAN-13';
                    if (barcodes.length === 1 && !barcodes[0].barcode.trim()) {
                      setBarcodes([
                        {
                          ...barcodes[0],
                          barcode: code,
                          barcodeType: detectedFmt,
                        },
                      ]);
                    } else {
                      setNewBarcodeVal(code);
                      setNewBarcodeType(detectedFmt);
                    }
                    if (barcodeSoundEnabled) playScannerSound('success');
                    setBarcodeScanStatus({
                      barcode: code,
                      format: meta?.format,
                      engine: meta?.engine === 'manual' ? undefined : meta?.engine,
                      found: true,
                      message: 'Barcode diisikan ke kolom input produk.',
                      timestamp: Date.now(),
                    });
                  }}
                  soundEnabled={barcodeSoundEnabled}
                  onToggleSound={() => setBarcodeSoundEnabled((s) => !s)}
                  lastScanStatus={barcodeScanStatus}
                  context="barcode-field"
                  allowQrDefault={false}
                  title="Scan Barcode Kemasan Produk"
                />
              )}

              <div className="space-y-2">
                {barcodes.map((b, idx) => (
                  <div
                    key={b.key}
                    className="flex flex-wrap items-center gap-2 p-2.5 border border-slate-200 rounded-lg bg-slate-50/70"
                  >
                    <input
                      type="text"
                      value={b.barcode}
                      onChange={(e) =>
                        setBarcodes((prev) =>
                          prev.map((item) =>
                            item.key === b.key ? { ...item, barcode: e.target.value } : item
                          )
                        )
                      }
                      required
                      placeholder={`Barcode #${idx + 1}`}
                      className="flex-1 min-w-[160px] font-mono text-xs px-2.5 py-1.5 bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    <select
                      value={b.barcodeType}
                      onChange={(e) =>
                        setBarcodes((prev) =>
                          prev.map((item) =>
                            item.key === b.key
                              ? { ...item, barcodeType: e.target.value as BarcodeType }
                              : item
                          )
                        )
                      }
                      aria-label="Tipe barcode"
                      className="text-xs px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                    >
                      {BARCODE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => handleSetPrimaryBarcode(b.key)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-md transition-colors ${
                        b.isPrimary
                          ? 'bg-teal-700 text-white'
                          : 'bg-white border border-slate-300 text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <Star className="w-3 h-3" />
                      {b.isPrimary ? 'Utama' : 'Jadikan Utama'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setBarcodes((prev) =>
                          prev.map((item) =>
                            item.key === b.key
                              ? { ...item, barcode: generateValidEAN13(), barcodeType: 'EAN-13' }
                              : item
                          )
                        )
                      }
                      title="Generate EAN-13"
                      className="p-1.5 text-slate-600 hover:text-slate-900 bg-white border border-slate-300 rounded-md"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                    {barcodes.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveBarcode(b.key)}
                        className="p-1.5 text-slate-400 hover:text-rose-600 rounded-md"
                        aria-label="Hapus barcode"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Add secondary barcode row */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <input
                  type="text"
                  value={newBarcodeVal}
                  onChange={(e) => setNewBarcodeVal(e.target.value)}
                  placeholder="Tambah barcode alternatif / karton / multipack..."
                  className="flex-1 min-w-[200px] font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
                <select
                  value={newBarcodeType}
                  onChange={(e) => setNewBarcodeType(e.target.value as BarcodeType)}
                  className="text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  {BARCODE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleAddExtraBarcode}
                  className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Tambah Barcode
                </button>
              </div>
            </section>

            {/* 3. Category & Brand */}
            <section className="space-y-3">
              <h4 className="text-xs font-semibold text-slate-900 pb-2 border-b border-slate-200">
                3. Kategori, Merek & Varian
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Kategori Utama *
                  </label>
                  <select
                    value={categoryId}
                    onChange={(e) => {
                      setCategoryId(e.target.value);
                      setSubcategoryId('');
                    }}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    <option value="">-- Pilih Kategori --</option>
                    {parentCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Subkategori
                  </label>
                  <select
                    value={subcategoryId}
                    onChange={(e) => setSubcategoryId(e.target.value)}
                    disabled={availableSubcategories.length === 0}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white disabled:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    <option value="">-- Opsional --</option>
                    {availableSubcategories.map((sc) => (
                      <option key={sc.id} value={sc.id}>
                        {sc.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Merek</label>
                  <select
                    value={brandId}
                    onChange={(e) => setBrandId(e.target.value)}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    <option value="">-- Pilih Merek --</option>
                    {activeBrands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Varian / Rasa
                  </label>
                  <input
                    type="text"
                    value={variant}
                    onChange={(e) => setVariant(e.target.value)}
                    placeholder="Contoh: Goreng Spesial / Cokelat"
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Ukuran Kemasan (Size)
                  </label>
                  <input
                    type="text"
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                    placeholder="Contoh: 250ml / 85g / XL"
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>
            </section>

            {/* 4. Unit & Physical Dimensions */}
            <section className="space-y-3">
              <h4 className="text-xs font-semibold text-slate-900 pb-2 border-b border-slate-200">
                4. Satuan (Unit of Measure) & Dimensi
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Satuan (UOM) *
                  </label>
                  <select
                    value={uomId}
                    onChange={(e) => setUomId(e.target.value)}
                    required
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    {activeUoms.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.code} — {u.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Berat Bersih (gram)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                    placeholder="Contoh: 85"
                    className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Volume Bersih (ml)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={volume}
                    onChange={(e) => setVolume(e.target.value)}
                    placeholder="Contoh: 600"
                    className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>
            </section>

            {/* 5. Pricing */}
            <section className="space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-200">
                <h4 className="text-xs font-semibold text-slate-900">5. Harga & Pajak</h4>
                <span className="font-mono text-[11px] font-semibold text-emerald-700 tabular-nums">
                  Estimasi Margin: {formatRupiah(estMargin)}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Harga Modal (Rp) *
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={costPrice}
                    onChange={(e) => setCostPrice(e.target.value)}
                    required
                    className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Harga Jual Normal (Rp) *
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={sellPrice}
                    onChange={(e) => setSellPrice(e.target.value)}
                    required
                    className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Harga Khusus / Promo (Rp)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={specialPrice}
                    onChange={(e) => setSpecialPrice(e.target.value)}
                    placeholder="Kosongkan jika normal"
                    className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Kategori Pajak
                  </label>
                  <select
                    value={taxCategory}
                    onChange={(e) => setTaxCategory(e.target.value as TaxCategory)}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                  >
                    <option value="STANDARD">Standar (PPN Toko)</option>
                    <option value="REDUCED">Tarif Khusus (50%)</option>
                    <option value="EXEMPT">Bebas Pajak (0%)</option>
                  </select>
                </div>
              </div>
            </section>

            {/* 6. Inventory Settings */}
            <section className="space-y-3">
              <h4 className="text-xs font-semibold text-slate-900 pb-2 border-b border-slate-200">
                6. Pengaturan Inventori
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {!editingProduct ? (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Stok Awal *
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={stock}
                      onChange={(e) => setStock(e.target.value)}
                      required
                      className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">
                      Stok Saat Ini (diubah lewat Restok/Opname)
                    </label>
                    <input
                      type="text"
                      disabled
                      value={`${editingProduct.stock} ${editingProduct.unit}`}
                      className="w-full font-mono text-xs px-3 py-2 border border-slate-200 bg-slate-100 text-slate-500 rounded-lg tabular-nums"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Batas Minimum Stok (Alert Restok) *
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={minStock}
                    onChange={(e) => setMinStock(e.target.value)}
                    required
                    className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>
            </section>

            {/* 7. Product Images & AI Reference Preparation */}
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-200">
                <div>
                  <h4 className="text-xs font-semibold text-slate-900">
                    7. Gambar Produk & Struktur Referensi AI
                  </h4>
                  <p className="text-[11px] text-slate-500">
                    Format JPG, PNG, atau WEBP (maks 3 MB). Tandai sudut foto untuk dataset pengenalan produk AI di fase berikutnya.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer">
                    <ImagePlus className="w-3.5 h-3.5" />
                    <span>Unggah Gambar</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                      disabled={imageBusy}
                      onChange={handleFileInput}
                      className="hidden"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={imageBusy}
                    onClick={() => setCameraOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-lg disabled:opacity-50"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    Foto Kamera
                  </button>
                </div>
              </div>

              {/* Existing saved images (Edit mode) */}
              {liveProduct && (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {liveProduct.images.length === 0 ? (
                    <div className="sm:col-span-2 md:col-span-3 p-6 text-center border border-dashed border-slate-200 rounded-lg text-xs text-slate-500">
                      Belum ada foto terunggah untuk produk ini.
                    </div>
                  ) : (
                    liveProduct.images.map((img) => (
                      <div
                        key={img.id}
                        className={`border rounded-lg overflow-hidden bg-white ${
                          img.isPrimary ? 'border-teal-600' : 'border-slate-200'
                        }`}
                      >
                        <div className="aspect-[4/3] bg-slate-100 overflow-hidden">
                          <img
                            src={img.imageUrl}
                            alt={img.fileName}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                        </div>
                        <div className="p-2.5 space-y-2 text-[11px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-slate-800 truncate">
                              {img.fileName}
                            </span>
                            <span className="font-mono text-slate-400 shrink-0">
                              {formatFileSize(img.fileSize)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              disabled={imageBusy || img.isPrimary}
                              onClick={() =>
                                handleUpdateExistingImage(img.id, { isPrimary: true })
                              }
                              className={`px-2 py-1 rounded font-semibold ${
                                img.isPrimary
                                  ? 'bg-teal-700 text-white'
                                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                              }`}
                            >
                              {img.isPrimary ? 'Gambar Utama' : 'Jadikan Utama'}
                            </button>
                            <button
                              type="button"
                              disabled={imageBusy}
                              onClick={() => handleDeleteExistingImage(img.id)}
                              className="p-1 text-slate-400 hover:text-rose-600 rounded"
                              aria-label={`Hapus gambar ${img.fileName}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <div className="pt-1.5 border-t border-slate-100 flex items-center justify-between gap-2">
                            <label className="flex items-center gap-1.5 text-slate-600 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={img.isAiReference}
                                disabled={imageBusy}
                                onChange={(e) =>
                                  handleUpdateExistingImage(img.id, {
                                    isAiReference: e.target.checked,
                                  })
                                }
                                className="rounded border-slate-300 text-teal-700"
                              />
                              <span>Ref AI</span>
                            </label>
                            <select
                              value={img.referenceAngle}
                              disabled={imageBusy || !img.isAiReference}
                              onChange={(e) =>
                                handleUpdateExistingImage(img.id, {
                                  referenceAngle: e.target.value as ImageReferenceAngle,
                                })
                              }
                              className="text-[11px] px-1.5 py-0.5 border border-slate-200 rounded bg-white disabled:opacity-50"
                            >
                              {ANGLE_OPTIONS.map((a) => (
                                <option key={a.value} value={a.value}>
                                  {a.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          {img.isAiReference && (
                            <div className="text-[10px] font-mono text-slate-500 flex items-center justify-between">
                              <span>Embedding AI:</span>
                              <span
                                className={
                                  img.aiEmbeddingStatus === 'READY'
                                    ? 'text-emerald-700 font-semibold'
                                    : 'text-amber-700 font-semibold'
                                }
                              >
                                {img.aiEmbeddingStatus}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Queued images (Create mode) */}
              {!liveProduct && (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {queuedImages.length === 0 ? (
                    <div className="sm:col-span-2 md:col-span-3 p-6 text-center border border-dashed border-slate-200 rounded-lg text-xs text-slate-500">
                      Unggah atau ambil foto kamera untuk disimpan bersama produk baru ini.
                    </div>
                  ) : (
                    queuedImages.map((q) => (
                      <div
                        key={q.key}
                        className={`border rounded-lg overflow-hidden bg-white ${
                          q.isPrimary ? 'border-teal-600' : 'border-slate-200'
                        }`}
                      >
                        <div className="aspect-[4/3] bg-slate-100 overflow-hidden">
                          <img
                            src={q.dataBase64}
                            alt={q.fileName}
                            className="w-full h-full object-cover"
                          />
                        </div>
                        <div className="p-2.5 space-y-2 text-[11px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-slate-800 truncate">{q.fileName}</span>
                            <span className="font-mono text-slate-400 shrink-0">
                              {formatFileSize(q.fileSize)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                setQueuedImages((prev) =>
                                  prev.map((item) => ({
                                    ...item,
                                    isPrimary: item.key === q.key,
                                  }))
                                )
                              }
                              className={`px-2 py-1 rounded font-semibold ${
                                q.isPrimary
                                  ? 'bg-teal-700 text-white'
                                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                              }`}
                            >
                              {q.isPrimary ? 'Gambar Utama' : 'Jadikan Utama'}
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setQueuedImages((prev) => {
                                  const next = prev.filter((item) => item.key !== q.key);
                                  if (next[0] && !next.some((item) => item.isPrimary)) {
                                    next[0] = { ...next[0], isPrimary: true };
                                  }
                                  return next;
                                })
                              }
                              className="p-1 text-slate-400 hover:text-rose-600 rounded"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <div className="pt-1.5 border-t border-slate-100 flex items-center justify-between gap-2">
                            <label className="flex items-center gap-1.5 text-slate-600 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={q.isAiReference}
                                onChange={(e) =>
                                  setQueuedImages((prev) =>
                                    prev.map((item) =>
                                      item.key === q.key
                                        ? { ...item, isAiReference: e.target.checked }
                                        : item
                                    )
                                  )
                                }
                                className="rounded border-slate-300 text-teal-700"
                              />
                              <span>Ref AI</span>
                            </label>
                            <select
                              value={q.referenceAngle}
                              disabled={!q.isAiReference}
                              onChange={(e) =>
                                setQueuedImages((prev) =>
                                  prev.map((item) =>
                                    item.key === q.key
                                      ? {
                                          ...item,
                                          referenceAngle: e.target.value as ImageReferenceAngle,
                                        }
                                      : item
                                  )
                                )
                              }
                              className="text-[11px] px-1.5 py-0.5 border border-slate-200 rounded bg-white disabled:opacity-50"
                            >
                              {ANGLE_OPTIONS.map((a) => (
                                <option key={a.value} value={a.value}>
                                  {a.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </section>
          </form>

          <div className="flex items-center justify-end gap-2.5 px-6 py-4 border-t border-slate-200 bg-slate-50 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={submitting || imageBusy}
              onClick={(e) => {
                const form = e.currentTarget.closest('[role="dialog"]')?.querySelector('form');
                if (form) form.requestSubmit();
              }}
              className="px-5 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50"
            >
              {submitting
                ? 'Menyimpan...'
                : editingProduct
                ? 'Simpan Perubahan Produk'
                : 'Simpan Produk Baru'}
            </button>
          </div>
        </div>
      </div>

      <CameraPhotoCaptureModal
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={async (captured) => {
          const approxBytes = Math.round((captured.dataBase64.length * 3) / 4);
          await handleUploadImagePayload({
            ...captured,
            fileSize: approxBytes,
          });
        }}
      />
    </>
  );
}

interface StockAdjustModalProps {
  product: Product | null;
  onClose: () => void;
  onSubmit: (payload: {
    productId: string;
    type: StockMovementType;
    qty: number;
    notes: string;
  }) => Promise<void>;
}

export function StockAdjustModal({ product, onClose, onSubmit }: StockAdjustModalProps) {
  const [mode, setMode] = useState<'RESTOK' | 'OPNAME'>('RESTOK');
  const [qty, setQty] = useState('12');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!product) return;
    setMode('RESTOK');
    setQty(String(Math.max(10, product.minStock * 2 - product.stock)));
    setNotes('');
    setError(null);
  }, [product]);

  if (!product) return null;

  const numericQty = Math.max(0, Math.floor(Number(qty || 0)));
  const resultingStock = mode === 'RESTOK' ? product.stock + numericQty : numericQty;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === 'RESTOK' && numericQty <= 0) {
      setError('Jumlah restok harus lebih dari 0.');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        productId: product.id,
        type: mode,
        qty: numericQty,
        notes:
          notes.trim() ||
          (mode === 'RESTOK' ? 'Restok barang masuk supplier' : 'Penyesuaian stok opname'),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memperbarui stok.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Penyesuaian Stok"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Perbarui Stok Barang</h3>
            <p className="text-xs text-slate-500 mt-0.5">{product.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Tutup modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          )}

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => {
                setMode('RESTOK');
                setQty('12');
              }}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                mode === 'RESTOK' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Restok Masuk (+)
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('OPNAME');
                setQty(String(product.stock));
              }}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                mode === 'OPNAME' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Stok Opname (Fisik)
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
            <div>
              <span className="text-slate-500">Stok Tercatat</span>
              <p className="font-mono text-sm font-semibold text-slate-900 tabular-nums mt-0.5">
                {product.stock} {product.unit}
              </p>
            </div>
            <div>
              <span className="text-slate-500">Stok Setelah Simpan</span>
              <p className="font-mono text-sm font-semibold text-teal-700 tabular-nums mt-0.5">
                {resultingStock} {product.unit}
              </p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              {mode === 'RESTOK'
                ? `Jumlah Tambahan Masuk (${product.unit})`
                : `Total Stok Fisik Aktual (${product.unit})`}
            </label>
            <input
              type="number"
              min={mode === 'RESTOK' ? 1 : 0}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              required
              className="w-full font-mono text-sm px-3 py-2 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Catatan Mutasi (otomatis masuk laporan stok)
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                mode === 'RESTOK'
                  ? 'Contoh: Penerimaan PO dari distributor'
                  : 'Contoh: Hasil hitung fisik rak toko'
              }
              className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50"
            >
              {submitting ? 'Memproses...' : 'Simpan & Catat Mutasi'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface BarcodeLabelModalProps {
  product: Product | null;
  onClose: () => void;
}

export function BarcodeLabelModal({ product, onClose }: BarcodeLabelModalProps) {
  const [selectedCode, setSelectedCode] = useState<string>('');

  useEffect(() => {
    if (product) {
      setSelectedCode(product.barcode);
    }
  }, [product]);

  if (!product) return null;

  const activeCode = selectedCode || product.barcode;
  const displayPrice =
    product.specialPrice !== null && product.specialPrice > 0
      ? product.specialPrice
      : product.sellPrice;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Label Barcode Produk"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 no-print">
          <h3 className="text-sm font-semibold text-slate-900">Label Barcode Produk</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Tutup modal barcode"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 bg-slate-50 flex flex-col items-center space-y-3">
          {product.barcodes.length > 1 && (
            <div className="w-full no-print">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Pilih Barcode Produk
              </label>
              <select
                value={activeCode}
                onChange={(e) => setSelectedCode(e.target.value)}
                className="w-full font-mono text-xs px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg"
              >
                {product.barcodes.map((b) => (
                  <option key={b.id} value={b.barcode}>
                    {b.barcode} ({b.barcodeType}){b.isPrimary ? ' — Utama' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="print-area bg-white border border-slate-300 rounded-lg p-4 w-full max-w-[280px] text-center">
            <p className="text-[10px] font-mono text-slate-500">{product.sku}</p>
            <p className="text-xs font-semibold text-slate-900 truncate">{product.name}</p>
            <p className="font-mono text-sm font-bold text-teal-800 tabular-nums mt-0.5">
              {formatRupiah(displayPrice)} / {product.unit}
            </p>
            <div className="mt-2 flex justify-center">
              <BarcodeSvg value={activeCode} height={56} width={1.8} fontSize={13} />
            </div>
          </div>
          <p className="text-xs text-slate-500 text-center leading-relaxed no-print">
            Arahkan kamera pemindai ke barcode di atas atau cetak sebagai stiker rak toko.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-200 bg-white no-print">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Tutup
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800"
          >
            <Printer className="w-3.5 h-3.5" />
            Cetak Label
          </button>
        </div>
      </div>
    </div>
  );
}
