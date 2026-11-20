import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  Camera,
  CameraOff,
  CheckCircle2,
  ClipboardCheck,
  Download,
  Edit3,
  FileSpreadsheet,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type {
  Category,
  Product,
  StockAdjustmentDirection,
  StockAdjustmentRecord,
  StockBalanceResponse,
  StockMovement,
  StockMovementType,
  StockOpnameDetail,
  StockOpnameSession,
  StockOpnameStatus,
  StockReceivingRecord,
  StockStatusLevel,
  StoreData,
  StoreSettings,
  UserSummary,
} from '../types';
import { apiFetch, ApiError } from '../utils/api';
import {
  downloadCSV,
  formatDateTime,
  formatNumber,
  formatRupiah,
  playScannerSound,
} from '../utils/format';
import {
  validateAndNormalizeBarcode,
  type ScanResultFeedback,
} from '../utils/barcodeScanner';
import { CameraScanner, type CameraScanEventMeta } from './CameraScanner';
import { movementTypeLabel, stockStatusLabel } from './StockCardModal';

type StockSubTab = 'balance' | 'stock-in' | 'adjustments' | 'opname' | 'movements';

interface StockControlViewProps {
  products: Product[];
  categories: Category[];
  settings: StoreSettings;
  currentUser: UserSummary;
  onStoreUpdate: (store: StoreData) => void;
  onOpenStockCard: (productId: string) => void;
  onRequestPinToken: (opts: { title: string; description: string }) => Promise<string>;
}

const ADJUSTMENT_REASON_PRESETS = [
  'Barang Rusak / Kedaluwarsa',
  'Kehilangan / Selisih Gudang',
  'Hadiah / Sampel / Promosi',
  'Koreksi Input Administrasi',
  'Retur Supplier',
  'Lainnya',
] as const;

function opnameStatusLabel(status: StockOpnameStatus): { label: string; className: string } {
  switch (status) {
    case 'DRAFT':
      return { label: 'Draft Hitungan', className: 'text-slate-700 font-semibold' };
    case 'PENDING_REVIEW':
      return { label: 'Menunggu Review', className: 'text-amber-700 font-semibold' };
    case 'APPROVED':
      return { label: 'Disetujui (Siap Finalisasi)', className: 'text-teal-700 font-semibold' };
    case 'FINALIZED':
      return { label: 'Selesai & Stok Diperbarui', className: 'text-emerald-700 font-semibold' };
    case 'CANCELLED':
      return { label: 'Dibatalkan', className: 'text-rose-700 font-semibold' };
  }
}

export function StockControlView({
  products,
  categories,
  settings,
  currentUser,
  onStoreUpdate,
  onOpenStockCard,
  onRequestPinToken,
}: StockControlViewProps) {
  const [subTab, setSubTab] = useState<StockSubTab>('balance');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null
  );

  const canAdjustStock = currentUser.permissions.includes('stock:adjust');
  const canEditProduct = currentUser.permissions.includes('products:edit');
  const canEditMinStock = canAdjustStock || canEditProduct;

  const activeProducts = useMemo(
    () => products.filter((p) => p.status === 'ACTIVE').sort((a, b) => a.name.localeCompare(b.name, 'id')),
    [products]
  );
  const sortedAllProducts = useMemo(
    () => [...products].sort((a, b) => a.name.localeCompare(b.name, 'id')),
    [products]
  );

  // --- Tab 1: Stock Balance State ---
  const [balanceData, setBalanceData] = useState<StockBalanceResponse | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceSearch, setBalanceSearch] = useState('');
  const [balanceStatusFilter, setBalanceStatusFilter] = useState<
    'ALL' | 'LOW_OR_OUT' | StockStatusLevel
  >('ALL');
  const [balanceCategoryFilter, setBalanceCategoryFilter] = useState('ALL');
  const [editingMinId, setEditingMinId] = useState<string | null>(null);
  const [editingMinValue, setEditingMinValue] = useState('');
  const [savingMinId, setSavingMinId] = useState<string | null>(null);

  const loadBalance = useCallback(async () => {
    setBalanceLoading(true);
    try {
      const qs = new URLSearchParams();
      if (balanceSearch.trim()) qs.set('search', balanceSearch.trim());
      if (balanceStatusFilter !== 'ALL') qs.set('stockStatus', balanceStatusFilter);
      if (balanceCategoryFilter !== 'ALL') qs.set('categoryId', balanceCategoryFilter);
      qs.set('pageSize', '200');
      const res = await apiFetch<StockBalanceResponse>(
        `/api/inventory/stock-balance?${qs.toString()}`
      );
      setBalanceData(res);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal memuat saldo stok.',
      });
    } finally {
      setBalanceLoading(false);
    }
  }, [balanceSearch, balanceStatusFilter, balanceCategoryFilter]);

  useEffect(() => {
    void loadBalance();
  }, [loadBalance, products]);

  // --- Tab 2: Stock In State ---
  const [stockInBarcodeQuery, setStockInBarcodeQuery] = useState('');
  const [stockInProductId, setStockInProductId] = useState('');
  const [stockInQty, setStockInQty] = useState('10');
  const [stockInCostPrice, setStockInCostPrice] = useState('');
  const [stockInUpdateCost, setStockInUpdateCost] = useState(false);
  const [stockInReference, setStockInReference] = useState('');
  const [stockInDate, setStockInDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [stockInNotes, setStockInNotes] = useState('');
  const [stockInSubmitting, setStockInSubmitting] = useState(false);
  const [stockInCameraOpen, setStockInCameraOpen] = useState(false);
  const [stockInSoundEnabled, setStockInSoundEnabled] = useState(true);
  const [stockInScanStatus, setStockInScanStatus] = useState<ScanResultFeedback | null>(null);

  const [receivings, setReceivings] = useState<StockReceivingRecord[]>([]);
  const [receivingsLoading, setReceivingsLoading] = useState(false);
  const [receivingSearch, setReceivingSearch] = useState('');

  const selectedStockInProduct = useMemo(
    () => sortedAllProducts.find((p) => p.id === stockInProductId) ?? null,
    [sortedAllProducts, stockInProductId]
  );

  useEffect(() => {
    if (!stockInProductId && activeProducts[0]) {
      setStockInProductId(activeProducts[0].id);
      setStockInCostPrice(String(activeProducts[0].costPrice));
    }
  }, [activeProducts, stockInProductId]);

  const loadReceivings = useCallback(async () => {
    setReceivingsLoading(true);
    try {
      const qs = new URLSearchParams();
      if (receivingSearch.trim()) qs.set('search', receivingSearch.trim());
      const res = await apiFetch<{ receivings: StockReceivingRecord[] }>(
        `/api/inventory/stock-in${qs.toString() ? `?${qs.toString()}` : ''}`
      );
      setReceivings(res.receivings);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal memuat riwayat barang masuk.',
      });
    } finally {
      setReceivingsLoading(false);
    }
  }, [receivingSearch]);

  useEffect(() => {
    if (subTab === 'stock-in') {
      void loadReceivings();
    }
  }, [subTab, loadReceivings]);

  // --- Tab 3: Stock Adjustments State ---
  const [adjProductId, setAdjProductId] = useState('');
  const [adjDirection, setAdjDirection] = useState<StockAdjustmentDirection>('DECREASE');
  const [adjQty, setAdjQty] = useState('1');
  const [adjReasonPreset, setAdjReasonPreset] = useState<string>(ADJUSTMENT_REASON_PRESETS[0]);
  const [adjCustomReason, setAdjCustomReason] = useState('');
  const [adjReference, setAdjReference] = useState('');
  const [adjNotes, setAdjNotes] = useState('');
  const [adjSubmitting, setAdjSubmitting] = useState(false);

  const [adjustments, setAdjustments] = useState<StockAdjustmentRecord[]>([]);
  const [adjustmentsLoading, setAdjustmentsLoading] = useState(false);
  const [adjSearch, setAdjSearch] = useState('');
  const [adjDirFilter, setAdjDirFilter] = useState<'ALL' | StockAdjustmentDirection>('ALL');

  const selectedAdjProduct = useMemo(
    () => sortedAllProducts.find((p) => p.id === adjProductId) ?? null,
    [sortedAllProducts, adjProductId]
  );

  useEffect(() => {
    if (!adjProductId && activeProducts[0]) {
      setAdjProductId(activeProducts[0].id);
    }
  }, [activeProducts, adjProductId]);

  const loadAdjustments = useCallback(async () => {
    setAdjustmentsLoading(true);
    try {
      const qs = new URLSearchParams();
      if (adjSearch.trim()) qs.set('search', adjSearch.trim());
      if (adjDirFilter !== 'ALL') qs.set('direction', adjDirFilter);
      const res = await apiFetch<{ adjustments: StockAdjustmentRecord[] }>(
        `/api/inventory/adjustments${qs.toString() ? `?${qs.toString()}` : ''}`
      );
      setAdjustments(res.adjustments);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal memuat riwayat penyesuaian stok.',
      });
    } finally {
      setAdjustmentsLoading(false);
    }
  }, [adjSearch, adjDirFilter]);

  useEffect(() => {
    if (subTab === 'adjustments') {
      void loadAdjustments();
    }
  }, [subTab, loadAdjustments]);

  // --- Tab 4: Stock Opname State ---
  const [opnames, setOpnames] = useState<StockOpnameSession[]>([]);
  const [opnamesLoading, setOpnamesLoading] = useState(false);
  const [activeOpname, setActiveOpname] = useState<StockOpnameDetail | null>(null);
  const [opnameDetailLoading, setOpnameDetailLoading] = useState(false);

  const [createOpnameOpen, setCreateOpnameOpen] = useState(false);
  const [newOpnameTitle, setNewOpnameTitle] = useState('');
  const [newOpnameNotes, setNewOpnameNotes] = useState('');
  const [newOpnameScope, setNewOpnameScope] = useState<'ALL_ACTIVE' | 'SELECTED'>('ALL_ACTIVE');
  const [newOpnameSearch, setNewOpnameSearch] = useState('');
  const [selectedOpnameProductIds, setSelectedOpnameProductIds] = useState<string[]>([]);
  const [opnameBusy, setOpnameBusy] = useState(false);

  const [opnameCountsDraft, setOpnameCountsDraft] = useState<
    Record<string, { physicalStock: string; notes: string }>
  >({});
  const [opnameItemFilter, setOpnameItemFilter] = useState<'ALL' | 'DISCREPANCY' | 'UNCOUNTED'>(
    'ALL'
  );
  const [opnameItemSearch, setOpnameItemSearch] = useState('');
  const [confirmFinalizeId, setConfirmFinalizeId] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const hydrateOpnameDraft = (detail: StockOpnameDetail) => {
    const next: Record<string, { physicalStock: string; notes: string }> = {};
    detail.items.forEach((item) => {
      next[item.productId] = {
        physicalStock: item.physicalStock === null ? '' : String(item.physicalStock),
        notes: item.notes || '',
      };
    });
    setOpnameCountsDraft(next);
  };

  const loadOpnames = useCallback(async (selectId?: string) => {
    setOpnamesLoading(true);
    try {
      const res = await apiFetch<{ opnames: StockOpnameSession[] }>('/api/inventory/opnames');
      setOpnames(res.opnames);
      const targetId = selectId || res.opnames[0]?.id;
      if (targetId) {
        setOpnameDetailLoading(true);
        const detailRes = await apiFetch<{ opname: StockOpnameDetail }>(
          `/api/inventory/opnames/${targetId}`
        );
        setActiveOpname(detailRes.opname);
        hydrateOpnameDraft(detailRes.opname);
      } else {
        setActiveOpname(null);
      }
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal memuat daftar stok opname.',
      });
    } finally {
      setOpnamesLoading(false);
      setOpnameDetailLoading(false);
    }
  }, []);

  const selectOpnameSession = async (id: string) => {
    setOpnameDetailLoading(true);
    setConfirmFinalizeId(null);
    setConfirmCancelId(null);
    try {
      const detailRes = await apiFetch<{ opname: StockOpnameDetail }>(
        `/api/inventory/opnames/${id}`
      );
      setActiveOpname(detailRes.opname);
      hydrateOpnameDraft(detailRes.opname);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal memuat detail opname.',
      });
    } finally {
      setOpnameDetailLoading(false);
    }
  };

  useEffect(() => {
    if (subTab === 'opname') {
      void loadOpnames(activeOpname?.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab]);

  // --- Tab 5: Movements Ledger State ---
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [movementsLoading, setMovementsLoading] = useState(false);
  const [movSearch, setMovSearch] = useState('');
  const [movTypeFilter, setMovTypeFilter] = useState<'ALL' | StockMovementType>('ALL');
  const [movDateFrom, setMovDateFrom] = useState('');
  const [movDateTo, setMovDateTo] = useState('');

  const loadMovements = useCallback(async () => {
    setMovementsLoading(true);
    try {
      const qs = new URLSearchParams();
      if (movTypeFilter !== 'ALL') qs.set('type', movTypeFilter);
      if (movSearch.trim()) qs.set('search', movSearch.trim());
      if (movDateFrom) qs.set('dateFrom', movDateFrom);
      if (movDateTo) qs.set('dateTo', movDateTo);
      const res = await apiFetch<{ movements: StockMovement[] }>(
        `/api/inventory/movements${qs.toString() ? `?${qs.toString()}` : ''}`
      );
      setMovements(res.movements);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal memuat riwayat mutasi stok.',
      });
    } finally {
      setMovementsLoading(false);
    }
  }, [movTypeFilter, movSearch, movDateFrom, movDateTo]);

  useEffect(() => {
    if (subTab === 'movements') {
      void loadMovements();
    }
  }, [subTab, loadMovements]);

  // --- Handlers ---
  const handleSaveMinStock = async (productId: string) => {
    const parsed = Number(editingMinValue);
    if (!Number.isInteger(parsed) || parsed < 0) {
      setFeedback({
        type: 'error',
        message: 'Batas minimum stok harus berupa bilangan bulat minimal 0.',
      });
      return;
    }
    setSavingMinId(productId);
    setFeedback(null);
    try {
      const res = await apiFetch<{ store: StoreData }>(
        `/api/inventory/products/${productId}/min-stock`,
        {
          method: 'PATCH',
          body: JSON.stringify({ minStock: parsed }),
        }
      );
      onStoreUpdate(res.store);
      setEditingMinId(null);
      setFeedback({ type: 'success', message: 'Batas minimum stok berhasil diperbarui.' });
      await loadBalance();
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal memperbarui minimum stok.',
      });
    } finally {
      setSavingMinId(null);
    }
  };

  const handlePrefillStockIn = (productId: string) => {
    const prod = sortedAllProducts.find((p) => p.id === productId);
    setStockInProductId(productId);
    if (prod) setStockInCostPrice(String(prod.costPrice));
    setSubTab('stock-in');
  };

  const handlePrefillAdjustment = (productId: string) => {
    setAdjProductId(productId);
    setSubTab('adjustments');
  };

  const handleStockInProductSelect = (productId: string) => {
    setStockInProductId(productId);
    const prod = sortedAllProducts.find((p) => p.id === productId);
    if (prod) setStockInCostPrice(String(prod.costPrice));
  };

  const handleStockInBarcodeLookup = async (
    overrideCode?: string,
    scanMeta?: CameraScanEventMeta
  ) => {
    const raw = (overrideCode ?? stockInBarcodeQuery).trim();
    if (!raw) return;

    const validated = validateAndNormalizeBarcode(raw, scanMeta?.format, { allowQr: true });
    if (!validated.valid) {
      if (overrideCode && stockInSoundEnabled) playScannerSound('error');
      setStockInScanStatus({
        barcode: raw,
        format: validated.detectedType,
        found: false,
        validationError: true,
        message: validated.reason || 'Format barcode tidak valid.',
        timestamp: Date.now(),
      });
      setFeedback({
        type: 'error',
        message: validated.reason || 'Format barcode tidak valid.',
      });
      return;
    }

    const code = validated.code.toLowerCase();
    let match = sortedAllProducts.find(
      (p) =>
        p.sku.toLowerCase() === code ||
        p.barcode.toLowerCase() === code ||
        p.barcodes.some((b) => b.barcode.toLowerCase() === code)
    );

    if (!match) {
      try {
        const remote = await apiFetch<{ product: Product }>(
          `/api/products/barcode/${encodeURIComponent(validated.code)}`
        );
        if (remote?.product) {
          match = remote.product;
        }
      } catch {
        // handled as unknown below
      }
    }

    if (!match) {
      if (overrideCode && stockInSoundEnabled) playScannerSound('error');
      setStockInScanStatus({
        barcode: validated.code,
        format: scanMeta?.format ?? validated.detectedType,
        engine: scanMeta?.engine === 'manual' ? undefined : scanMeta?.engine,
        found: false,
        unknownBarcode: true,
        message: 'Barcode / SKU tidak ditemukan di database produk.',
        timestamp: Date.now(),
      });
      setFeedback({
        type: 'error',
        message: `Barcode atau SKU "${validated.code}" tidak ditemukan.`,
      });
      return;
    }

    if (overrideCode && stockInSoundEnabled) playScannerSound('success');
    handleStockInProductSelect(match.id);
    setStockInBarcodeQuery('');
    setStockInScanStatus({
      barcode: match.barcode,
      format: scanMeta?.format ?? validated.detectedType,
      engine: scanMeta?.engine === 'manual' ? undefined : scanMeta?.engine,
      productName: match.name,
      productSku: match.sku,
      productStock: match.stock,
      productUnit: match.unit,
      found: true,
      message: `${match.sku} · Stok saat ini ${match.stock} ${match.unit} · Dipilih ke form barang masuk`,
      timestamp: Date.now(),
    });
    setFeedback({
      type: 'success',
      message: `Produk "${match.name}" (${match.sku}) dipilih untuk pencatatan barang masuk.`,
    });
  };

  const submitStockIn = async (pinApprovalToken?: string) => {
    if (!stockInProductId) {
      setFeedback({ type: 'error', message: 'Pilih produk terlebih dahulu.' });
      return;
    }
    const qtyNum = Number(stockInQty);
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
      setFeedback({ type: 'error', message: 'Jumlah masuk harus bilangan bulat minimal 1.' });
      return;
    }
    setStockInSubmitting(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        receiving: StockReceivingRecord;
        store: StoreData;
      }>('/api/inventory/stock-in', {
        method: 'POST',
        body: JSON.stringify({
          productId: stockInProductId,
          qty: qtyNum,
          costPrice: stockInCostPrice.trim() !== '' ? Number(stockInCostPrice) : undefined,
          updateProductCost: stockInUpdateCost,
          referenceNumber: stockInReference.trim() || undefined,
          receivedAt: stockInDate || undefined,
          notes: stockInNotes.trim(),
          ...(pinApprovalToken ? { pinApprovalToken } : {}),
        }),
      });
      onStoreUpdate(res.store);
      setStockInReference('');
      setStockInNotes('');
      setFeedback({
        type: 'success',
        message: `Barang masuk ${res.receiving.referenceNumber} tercatat: ${res.receiving.productName} (+${res.receiving.qty} ${res.receiving.unit}).`,
      });
      await Promise.all([loadReceivings(), loadBalance()]);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PIN_REQUIRED' && !pinApprovalToken) {
        try {
          const token = await onRequestPinToken({
            title: 'Otorisasi Penerimaan Barang Masuk',
            description:
              'Akun Anda memerlukan otorisasi PIN Supervisor atau Admin untuk mencatat barang masuk.',
          });
          await submitStockIn(token);
          return;
        } catch (pinErr) {
          setFeedback({
            type: 'error',
            message: pinErr instanceof Error ? pinErr.message : 'Otorisasi PIN dibatalkan.',
          });
          return;
        }
      }
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal menyimpan penerimaan barang masuk.',
      });
    } finally {
      setStockInSubmitting(false);
    }
  };

  const handleStockInSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await submitStockIn();
  };

  const submitAdjustment = async (pinApprovalToken?: string) => {
    if (!adjProductId) {
      setFeedback({ type: 'error', message: 'Pilih produk terlebih dahulu.' });
      return;
    }
    const qtyNum = Number(adjQty);
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
      setFeedback({ type: 'error', message: 'Jumlah penyesuaian harus bilangan bulat minimal 1.' });
      return;
    }
    const finalReason =
      adjReasonPreset === 'Lainnya' ? adjCustomReason.trim() : adjReasonPreset;
    if (finalReason.length < 3) {
      setFeedback({ type: 'error', message: 'Alasan penyesuaian wajib diisi (min. 3 karakter).' });
      return;
    }

    setAdjSubmitting(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        adjustment: StockAdjustmentRecord;
        store: StoreData;
      }>('/api/inventory/adjustments', {
        method: 'POST',
        body: JSON.stringify({
          productId: adjProductId,
          direction: adjDirection,
          qty: qtyNum,
          reason: finalReason,
          notes: adjNotes.trim(),
          referenceNumber: adjReference.trim() || undefined,
          ...(pinApprovalToken ? { pinApprovalToken } : {}),
        }),
      });
      onStoreUpdate(res.store);
      setAdjReference('');
      setAdjNotes('');
      setAdjCustomReason('');
      setFeedback({
        type: 'success',
        message: `Penyesuaian ${res.adjustment.referenceNumber} tersimpan (${res.adjustment.stockBefore} → ${res.adjustment.stockAfter} ${res.adjustment.unit}).`,
      });
      await Promise.all([loadAdjustments(), loadBalance()]);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PIN_REQUIRED' && !pinApprovalToken) {
        try {
          const token = await onRequestPinToken({
            title: 'Otorisasi Penyesuaian Stok',
            description:
              'Penyesuaian stok memerlukan persetujuan PIN Supervisor atau Admin sebelum saldo berubah.',
          });
          await submitAdjustment(token);
          return;
        } catch (pinErr) {
          setFeedback({
            type: 'error',
            message: pinErr instanceof Error ? pinErr.message : 'Otorisasi PIN dibatalkan.',
          });
          return;
        }
      }
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal menyimpan penyesuaian stok.',
      });
    } finally {
      setAdjSubmitting(false);
    }
  };

  const handleAdjustmentSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await submitAdjustment();
  };

  // --- Opname Handlers ---
  const handleCreateOpname = async (e: FormEvent) => {
    e.preventDefault();
    if (newOpnameScope === 'SELECTED' && selectedOpnameProductIds.length === 0) {
      setFeedback({
        type: 'error',
        message: 'Pilih minimal 1 produk atau gunakan opsi Semua Produk Aktif.',
      });
      return;
    }
    setOpnameBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ opname: StockOpnameDetail }>('/api/inventory/opnames', {
        method: 'POST',
        body: JSON.stringify({
          title: newOpnameTitle.trim() || undefined,
          notes: newOpnameNotes.trim(),
          productIds: newOpnameScope === 'SELECTED' ? selectedOpnameProductIds : undefined,
        }),
      });
      setCreateOpnameOpen(false);
      setNewOpnameTitle('');
      setNewOpnameNotes('');
      setSelectedOpnameProductIds([]);
      setFeedback({
        type: 'success',
        message: `Sesi opname ${res.opname.opnameNumber} dibuat dengan ${res.opname.totalItems} SKU.`,
      });
      await loadOpnames(res.opname.id);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal membuat sesi stok opname.',
      });
    } finally {
      setOpnameBusy(false);
    }
  };

  const handleSaveOpnameCounts = async (submitForReview: boolean) => {
    if (!activeOpname) return;
    setOpnameBusy(true);
    setFeedback(null);
    try {
      const itemsPayload = activeOpname.items.map((item) => {
        const draft = opnameCountsDraft[item.productId];
        const rawPhys = draft?.physicalStock?.trim() ?? '';
        return {
          productId: item.productId,
          physicalStock: rawPhys === '' ? null : Number(rawPhys),
          notes: draft?.notes ?? '',
        };
      });
      const res = await apiFetch<{ opname: StockOpnameDetail }>(
        `/api/inventory/opnames/${activeOpname.id}/counts`,
        {
          method: 'PUT',
          body: JSON.stringify({
            items: itemsPayload,
            submitForReview,
          }),
        }
      );
      setActiveOpname(res.opname);
      hydrateOpnameDraft(res.opname);
      setOpnames((prev) =>
        prev.map((s) => (s.id === res.opname.id ? { ...s, ...res.opname } : s))
      );
      setFeedback({
        type: 'success',
        message: submitForReview
          ? `Hitungan fisik ${res.opname.opnameNumber} diajukan untuk review & persetujuan.`
          : `Hitungan fisik ${res.opname.opnameNumber} tersimpan (${res.opname.countedItems}/${res.opname.totalItems} SKU terhitung).`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal menyimpan hitungan stok opname.',
      });
    } finally {
      setOpnameBusy(false);
    }
  };

  const handleApproveOpname = async (pinApprovalToken?: string) => {
    if (!activeOpname) return;
    setOpnameBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ opname: StockOpnameDetail }>(
        `/api/inventory/opnames/${activeOpname.id}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(pinApprovalToken ? { pinApprovalToken } : {}),
          }),
        }
      );
      setActiveOpname(res.opname);
      setOpnames((prev) =>
        prev.map((s) => (s.id === res.opname.id ? { ...s, ...res.opname } : s))
      );
      setFeedback({
        type: 'success',
        message: `Sesi opname ${res.opname.opnameNumber} disetujui. Klik Finalisasi untuk memperbarui saldo stok sistem.`,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PIN_REQUIRED' && !pinApprovalToken) {
        try {
          const token = await onRequestPinToken({
            title: 'Otorisasi Persetujuan Stok Opname',
            description:
              'Persetujuan hasil selisih stok opname memerlukan PIN Supervisor atau Admin.',
          });
          await handleApproveOpname(token);
          return;
        } catch (pinErr) {
          setFeedback({
            type: 'error',
            message: pinErr instanceof Error ? pinErr.message : 'Otorisasi PIN dibatalkan.',
          });
          return;
        }
      }
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal menyetujui sesi opname.',
      });
    } finally {
      setOpnameBusy(false);
    }
  };

  const handleFinalizeOpname = async () => {
    if (!activeOpname) return;
    setOpnameBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ opname: StockOpnameDetail; store: StoreData }>(
        `/api/inventory/opnames/${activeOpname.id}/finalize`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      setActiveOpname(res.opname);
      hydrateOpnameDraft(res.opname);
      onStoreUpdate(res.store);
      setConfirmFinalizeId(null);
      setOpnames((prev) =>
        prev.map((s) => (s.id === res.opname.id ? { ...s, ...res.opname } : s))
      );
      setFeedback({
        type: 'success',
        message: `Stok opname ${res.opname.opnameNumber} selesai difinalisasi dan saldo stok diperbarui.`,
      });
      await loadBalance();
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal memfinalisasi stok opname.',
      });
    } finally {
      setOpnameBusy(false);
    }
  };

  const handleCancelOpname = async () => {
    if (!activeOpname) return;
    setOpnameBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ opname: StockOpnameDetail }>(
        `/api/inventory/opnames/${activeOpname.id}/cancel`,
        { method: 'POST', body: JSON.stringify({ reason: 'Dibatalkan oleh operator' }) }
      );
      setActiveOpname(res.opname);
      setConfirmCancelId(null);
      setOpnames((prev) =>
        prev.map((s) => (s.id === res.opname.id ? { ...s, ...res.opname } : s))
      );
      setFeedback({
        type: 'success',
        message: `Sesi opname ${res.opname.opnameNumber} dibatalkan.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Gagal membatalkan sesi opname.',
      });
    } finally {
      setOpnameBusy(false);
    }
  };

  const handleFillAllSystemStocks = () => {
    if (!activeOpname) return;
    setOpnameCountsDraft((prev) => {
      const next = { ...prev };
      activeOpname.items.forEach((item) => {
        const current = next[item.productId];
        if (!current || current.physicalStock.trim() === '') {
          next[item.productId] = {
            physicalStock: String(item.systemStock),
            notes: current?.notes ?? '',
          };
        }
      });
      return next;
    });
  };

  const filteredOpnameItems = useMemo(() => {
    if (!activeOpname) return [];
    const q = opnameItemSearch.trim().toLowerCase();
    return activeOpname.items.filter((item) => {
      const draftVal = opnameCountsDraft[item.productId]?.physicalStock?.trim() ?? '';
      const isCounted = draftVal !== '';
      const physNum = isCounted ? Number(draftVal) : null;
      const variance = physNum !== null && !Number.isNaN(physNum) ? physNum - item.systemStock : 0;

      if (opnameItemFilter === 'UNCOUNTED' && isCounted) return false;
      if (opnameItemFilter === 'DISCREPANCY' && (!isCounted || variance === 0)) return false;

      if (!q) return true;
      return (
        item.productName.toLowerCase().includes(q) ||
        item.sku.toLowerCase().includes(q) ||
        item.barcode.toLowerCase().includes(q)
      );
    });
  }, [activeOpname, opnameCountsDraft, opnameItemFilter, opnameItemSearch]);

  const opnameSelectionProducts = useMemo(() => {
    const q = newOpnameSearch.trim().toLowerCase();
    return activeProducts.filter((p) => {
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q)
      );
    });
  }, [activeProducts, newOpnameSearch]);

  const handleExportBalanceCsv = () => {
    if (!balanceData) return;
    const today = new Date().toISOString().slice(0, 10);
    downloadCSV(
      `saldo-stok-${today}.csv`,
      [
        'SKU',
        'Barcode',
        'Nama Produk',
        'Kategori',
        'Merek',
        'Satuan',
        'Stok Saat Ini',
        'Minimum Stok',
        'Status Stok',
        'Status Produk',
        'Harga Modal',
        'Nilai Aset Modal',
      ],
      balanceData.items.map((i) => [
        i.sku,
        i.barcode,
        i.name,
        i.category,
        i.brandName,
        i.unit,
        i.currentStock,
        i.minStock,
        stockStatusLabel(i.stockStatus).label,
        i.productStatus,
        i.costPrice,
        i.assetValue,
      ])
    );
  };

  const handleExportMovementsCsv = () => {
    const today = new Date().toISOString().slice(0, 10);
    downloadCSV(
      `mutasi-stok-${today}.csv`,
      [
        'ID Mutasi',
        'Waktu',
        'Referensi',
        'SKU',
        'Barcode',
        'Produk',
        'Jenis Mutasi',
        'Perubahan',
        'Stok Awal',
        'Stok Akhir',
        'Petugas',
        'Alasan',
        'Catatan',
      ],
      movements.map((m) => [
        m.id,
        formatDateTime(m.movementDate || m.createdAt),
        m.referenceId,
        m.sku || '-',
        m.barcode,
        m.productName,
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

  const parentCategories = useMemo(
    () => categories.filter((c) => !c.parentId),
    [categories]
  );

  const summary = balanceData?.summary;
  const criticalCount = (summary?.outCount ?? 0) + (summary?.negativeCount ?? 0);

  const adjQtyNum = Number(adjQty || 0);
  const adjPreviewAfter =
    selectedAdjProduct && Number.isFinite(adjQtyNum) && adjQtyNum > 0
      ? selectedAdjProduct.stock + (adjDirection === 'INCREASE' ? adjQtyNum : -adjQtyNum)
      : selectedAdjProduct?.stock ?? 0;

  return (
    <div className="space-y-5">
      {/* 4-Column KPI Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Total Posisi Persediaan</p>
          <p className="font-mono text-xl font-bold text-slate-900 tabular-nums mt-1">
            {formatNumber(summary?.totalUnits ?? 0)} unit
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {formatNumber(summary?.totalSku ?? products.length)} SKU ·{' '}
            {formatNumber(summary?.safeCount ?? 0)} aman
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Peringatan Stok Menipis</p>
          <p
            className={`font-mono text-xl font-bold tabular-nums mt-1 ${
              (summary?.lowCount ?? 0) > 0 ? 'text-amber-700' : 'text-emerald-700'
            }`}
          >
            {formatNumber(summary?.lowCount ?? 0)} SKU
          </p>
          <p className="text-xs text-slate-500 mt-1">Stok di bawah atau sama dengan batas min</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Stok Habis / Saldo Minus</p>
          <p
            className={`font-mono text-xl font-bold tabular-nums mt-1 ${
              criticalCount > 0 ? 'text-rose-700' : 'text-emerald-700'
            }`}
          >
            {formatNumber(criticalCount)} SKU
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            {formatNumber(summary?.outCount ?? 0)} habis ·{' '}
            {formatNumber(summary?.negativeCount ?? 0)} negatif
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Nilai Aset Stok (Modal)</p>
          <p className="font-mono text-xl font-bold text-teal-800 tabular-nums mt-1">
            {formatRupiah(summary?.totalCostValue ?? 0)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            Nilai jual {formatRupiah(summary?.totalRetailValue ?? 0)}
          </p>
        </div>
      </div>

      {/* Navigation Tabs + Policy Indicator */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          {(
            [
              { id: 'balance', label: 'Saldo & Alert Stok' },
              { id: 'stock-in', label: 'Barang Masuk' },
              { id: 'adjustments', label: 'Penyesuaian Stok' },
              { id: 'opname', label: 'Stok Opname' },
              { id: 'movements', label: 'Mutasi Stok' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setSubTab(t.id);
                setFeedback(null);
                if (t.id !== 'stock-in') {
                  setStockInCameraOpen(false);
                }
              }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subTab === t.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="text-xs text-slate-500 whitespace-nowrap">
          <span>Kebijakan Stok Negatif:</span>{' '}
          <span
            className={
              settings.allowNegativeStock
                ? 'font-semibold text-amber-700'
                : 'font-semibold text-slate-700'
            }
          >
            {settings.allowNegativeStock ? 'Diizinkan (Oversell)' : 'Ditolak (Strict)'}
          </span>
        </div>
      </div>

      {/* Inline Feedback Banner */}
      {feedback && (
        <div
          className={`flex items-center justify-between gap-3 px-4 py-3 text-xs font-medium rounded-xl border ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <span className="flex items-center gap-2">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            )}
            {feedback.message}
          </span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-xs font-semibold underline shrink-0"
          >
            Tutup
          </button>
        </div>
      )}

      {/* TAB 1: STOCK BALANCE */}
      {subTab === 'balance' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={balanceSearch}
                onChange={(e) => setBalanceSearch(e.target.value)}
                placeholder="Cari produk, SKU, barcode, atau merek..."
                className="w-full text-xs pl-9 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <select
              value={balanceCategoryFilter}
              onChange={(e) => setBalanceCategoryFilter(e.target.value)}
              aria-label="Filter kategori saldo stok"
              className="text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-600"
            >
              <option value="ALL">Semua Kategori</option>
              {parentCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
              {(
                [
                  { id: 'ALL', label: 'Semua' },
                  { id: 'LOW_OR_OUT', label: 'Perlu Restok' },
                  { id: 'LOW', label: 'Menipis' },
                  { id: 'OUT', label: 'Habis' },
                  { id: 'NEGATIVE', label: 'Negatif' },
                  { id: 'SAFE', label: 'Aman' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setBalanceStatusFilter(f.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    balanceStatusFilter === f.id
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleExportBalanceCsv}
              disabled={!balanceData || balanceData.items.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              Ekspor CSV
            </button>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4">Produk</th>
                    <th className="py-3 px-4">SKU & Barcode</th>
                    <th className="py-3 px-4 text-right">Stok Saat Ini</th>
                    <th className="py-3 px-4 text-right">Minimum Stok</th>
                    <th className="py-3 px-4">Status Stok</th>
                    <th className="py-3 px-4 text-right">Nilai Modal</th>
                    <th className="py-3 px-4 text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {balanceLoading && !balanceData ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        Memuat saldo stok produk...
                      </td>
                    </tr>
                  ) : !balanceData || balanceData.items.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        Tidak ada produk yang cocok dengan filter saldo stok.
                      </td>
                    </tr>
                  ) : (
                    balanceData.items.map((item) => {
                      const st = stockStatusLabel(item.stockStatus);
                      const isEditingMin = editingMinId === item.productId;
                      return (
                        <tr
                          key={item.productId}
                          className={`hover:bg-slate-50/70 ${
                            item.productStatus === 'INACTIVE' ? 'opacity-65 bg-slate-50/40' : ''
                          }`}
                        >
                          <td className="py-3 px-4">
                            <p className="font-semibold text-slate-900">{item.name}</p>
                            <p className="text-[11px] text-slate-500 mt-0.5">
                              {item.brandName || 'Umum'} · {item.category}
                              {item.productStatus === 'INACTIVE' ? ' · Nonaktif' : ''}
                            </p>
                          </td>
                          <td className="py-3 px-4 whitespace-nowrap">
                            <p className="font-mono font-semibold text-slate-800">{item.sku}</p>
                            <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                              {item.barcode}
                            </p>
                          </td>
                          <td
                            className={`py-3 px-4 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                              item.stockStatus === 'NEGATIVE' || item.stockStatus === 'OUT'
                                ? 'text-rose-700'
                                : item.stockStatus === 'LOW'
                                ? 'text-amber-700'
                                : 'text-slate-900'
                            }`}
                          >
                            {formatNumber(item.currentStock)} {item.unit}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                            {isEditingMin ? (
                              <div className="inline-flex items-center gap-1 justify-end">
                                <input
                                  type="number"
                                  min={0}
                                  value={editingMinValue}
                                  onChange={(e) => setEditingMinValue(e.target.value)}
                                  className="w-16 px-2 py-1 text-right text-xs font-mono border border-teal-500 rounded-md"
                                  aria-label={`Batas minimum ${item.name}`}
                                />
                                <button
                                  type="button"
                                  disabled={savingMinId === item.productId}
                                  onClick={() => void handleSaveMinStock(item.productId)}
                                  className="px-2 py-1 text-[11px] font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                                >
                                  Simpan
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingMinId(null)}
                                  className="p-1 text-slate-500 hover:text-slate-900"
                                  aria-label="Batal ubah minimum"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <div className="inline-flex items-center gap-1.5">
                                <span className="text-slate-700">
                                  {formatNumber(item.minStock)} {item.unit}
                                </span>
                                {canEditMinStock && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingMinId(item.productId);
                                      setEditingMinValue(String(item.minStock));
                                    }}
                                    title="Ubah batas minimum stok"
                                    className="p-1 text-slate-400 hover:text-teal-700 rounded"
                                    aria-label={`Ubah minimum ${item.name}`}
                                  >
                                    <Edit3 className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 whitespace-nowrap">
                            <span className={st.className}>{st.label}</span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-700 tabular-nums whitespace-nowrap">
                            {formatRupiah(item.assetValue)}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handlePrefillStockIn(item.productId)}
                                className="px-2.5 py-1 text-[11px] font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-md whitespace-nowrap"
                              >
                                + Masuk
                              </button>
                              <button
                                type="button"
                                onClick={() => handlePrefillAdjustment(item.productId)}
                                className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md whitespace-nowrap"
                              >
                                Sesuaikan
                              </button>
                              <button
                                type="button"
                                onClick={() => onOpenStockCard(item.productId)}
                                className="px-2.5 py-1 text-[11px] font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 rounded-md whitespace-nowrap"
                              >
                                Kartu Stok
                              </button>
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
      )}

      {/* TAB 2: STOCK IN (RECEIVING) */}
      {subTab === 'stock-in' && (
        <div className="space-y-4">
          {stockInCameraOpen && (
            <CameraScanner
              active={stockInCameraOpen}
              onToggle={() => setStockInCameraOpen(false)}
              onScanBarcode={(code, meta) => void handleStockInBarcodeLookup(code, meta)}
              soundEnabled={stockInSoundEnabled}
              onToggleSound={() => setStockInSoundEnabled((s) => !s)}
              lastScanStatus={stockInScanStatus}
              sampleProducts={activeProducts}
              context="inventory"
              allowQrDefault={false}
              title="Pemindai Kamera · Penerimaan Barang Masuk"
            />
          )}

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
          <form
            onSubmit={handleStockInSubmit}
            className="xl:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Catat Penerimaan Barang Masuk
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Menambah stok secara atomik beserta catatan harga beli, referensi surat jalan, dan mutasi stok.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Scan / Cari Barcode atau SKU Cepat
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={stockInBarcodeQuery}
                  onChange={(e) => setStockInBarcodeQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleStockInBarcodeLookup();
                    }
                  }}
                  placeholder="Ketik / scan barcode lalu Enter..."
                  className="flex-1 min-w-0 text-xs font-mono px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
                <button
                  type="button"
                  onClick={() => void handleStockInBarcodeLookup()}
                  className="px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap shrink-0"
                >
                  Pilih
                </button>
                <button
                  type="button"
                  onClick={() => setStockInCameraOpen((v) => !v)}
                  title={stockInCameraOpen ? 'Tutup kamera pemindai' : 'Scan barcode dengan kamera'}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 transition-colors ${
                    stockInCameraOpen
                      ? 'bg-slate-900 text-white'
                      : 'bg-teal-700 text-white hover:bg-teal-800'
                  }`}
                >
                  {stockInCameraOpen ? (
                    <CameraOff className="w-3.5 h-3.5" />
                  ) : (
                    <Camera className="w-3.5 h-3.5" />
                  )}
                  <span className="hidden sm:inline">{stockInCameraOpen ? 'Tutup' : 'Kamera'}</span>
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Produk</label>
              <select
                value={stockInProductId}
                onChange={(e) => handleStockInProductSelect(e.target.value)}
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                {sortedAllProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} · {p.name} (Stok: {p.stock} {p.unit})
                  </option>
                ))}
              </select>
              {selectedStockInProduct && (
                <p className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
                  Stok saat ini: {selectedStockInProduct.stock} {selectedStockInProduct.unit} · Modal master:{' '}
                  {formatRupiah(selectedStockInProduct.costPrice)}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Jumlah Masuk
                </label>
                <input
                  type="number"
                  min={1}
                  required
                  value={stockInQty}
                  onChange={(e) => setStockInQty(e.target.value)}
                  className="w-full text-xs font-mono px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Harga Modal / Unit (Rp)
                </label>
                <input
                  type="number"
                  min={0}
                  value={stockInCostPrice}
                  onChange={(e) => setStockInCostPrice(e.target.value)}
                  className="w-full text-xs font-mono px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>

            <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={stockInUpdateCost}
                onChange={(e) => setStockInUpdateCost(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
              />
              <span>Perbarui harga modal pada master produk sesuai nominal penerimaan ini</span>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  No. Referensi / SJ
                </label>
                <input
                  type="text"
                  value={stockInReference}
                  onChange={(e) => setStockInReference(e.target.value)}
                  placeholder="Otomatis RCV-..."
                  className="w-full text-xs font-mono px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Tanggal Terima
                </label>
                <input
                  type="date"
                  value={stockInDate}
                  onChange={(e) => setStockInDate(e.target.value)}
                  className="w-full text-xs font-mono px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Catatan / Supplier</label>
              <textarea
                rows={2}
                value={stockInNotes}
                onChange={(e) => setStockInNotes(e.target.value)}
                placeholder="Nama supplier, nomor faktur, atau keterangan kondisi barang..."
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <button
              type="submit"
              disabled={stockInSubmitting || sortedAllProducts.length === 0}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors disabled:opacity-50"
            >
              <ArrowUpCircle className="w-4 h-4" />
              {stockInSubmitting
                ? 'Menyimpan...'
                : canAdjustStock
                ? 'Simpan Barang Masuk'
                : 'Simpan dengan PIN Supervisor'}
            </button>
          </form>

          <div className="xl:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Riwayat Barang Masuk</h3>
                <p className="text-xs text-slate-500">
                  Jejak penerimaan stok beserta petugas pencatat dan referensi faktur.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative w-56">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={receivingSearch}
                    onChange={(e) => setReceivingSearch(e.target.value)}
                    placeholder="Cari referensi atau produk..."
                    className="w-full text-xs pl-8 pr-3 py-1.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void loadReceivings()}
                  className="p-1.5 text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg"
                  aria-label="Segarkan riwayat barang masuk"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${receivingsLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4">Tanggal</th>
                    <th className="py-3 px-4">Referensi</th>
                    <th className="py-3 px-4">Produk & SKU</th>
                    <th className="py-3 px-4 text-right">Qty Masuk</th>
                    <th className="py-3 px-4 text-right">Harga Modal</th>
                    <th className="py-3 px-4">Petugas</th>
                    <th className="py-3 px-4">Catatan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {receivings.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        Belum ada riwayat penerimaan barang masuk.
                      </td>
                    </tr>
                  ) : (
                    receivings.map((rcv) => (
                      <tr key={rcv.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                          {formatDateTime(rcv.receivedAt)}
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                          {rcv.referenceNumber}
                        </td>
                        <td className="py-3 px-4">
                          <button
                            type="button"
                            onClick={() => onOpenStockCard(rcv.productId)}
                            className="font-semibold text-slate-900 hover:text-teal-700 text-left"
                          >
                            {rcv.productName}
                          </button>
                          <p className="font-mono text-[11px] text-slate-500">{rcv.sku}</p>
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-emerald-700 tabular-nums whitespace-nowrap">
                          +{formatNumber(rcv.qty)} {rcv.unit}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-slate-700 tabular-nums whitespace-nowrap">
                          {formatRupiah(rcv.costPrice)}
                          {rcv.updateProductCost && (
                            <span className="block text-[10px] text-teal-700">Modal diupdate</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-700 whitespace-nowrap">
                          {rcv.createdByName}
                        </td>
                        <td className="py-3 px-4 text-slate-600 max-w-xs truncate">
                          {rcv.notes || '-'}
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
      )}

      {/* TAB 3: STOCK ADJUSTMENTS */}
      {subTab === 'adjustments' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
          <form
            onSubmit={handleAdjustmentSubmit}
            className="xl:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Buat Penyesuaian Stok</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Penambahan atau pengurangan stok di luar transaksi penjualan dengan alasan wajib.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Produk</label>
              <select
                value={adjProductId}
                onChange={(e) => setAdjProductId(e.target.value)}
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                {sortedAllProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} · {p.name} (Stok: {p.stock} {p.unit})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Arah Penyesuaian
              </label>
              <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setAdjDirection('INCREASE')}
                  className={`inline-flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-md transition-colors ${
                    adjDirection === 'INCREASE'
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <ArrowUpCircle className="w-3.5 h-3.5" />
                  Tambah (+)
                </button>
                <button
                  type="button"
                  onClick={() => setAdjDirection('DECREASE')}
                  className={`inline-flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-md transition-colors ${
                    adjDirection === 'DECREASE'
                      ? 'bg-white text-rose-700 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <ArrowDownCircle className="w-3.5 h-3.5" />
                  Kurangi (-)
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Jumlah</label>
                <input
                  type="number"
                  min={1}
                  required
                  value={adjQty}
                  onChange={(e) => setAdjQty(e.target.value)}
                  className="w-full text-xs font-mono px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Estimasi Saldo Akhir
                </label>
                <div
                  className={`px-3 py-2 text-xs font-mono font-bold border rounded-lg tabular-nums ${
                    adjPreviewAfter < 0
                      ? 'bg-rose-50 border-rose-200 text-rose-700'
                      : 'bg-slate-50 border-slate-200 text-slate-900'
                  }`}
                >
                  {selectedAdjProduct
                    ? `${selectedAdjProduct.stock} → ${adjPreviewAfter} ${selectedAdjProduct.unit}`
                    : '-'}
                </div>
              </div>
            </div>

            {adjPreviewAfter < 0 && !settings.allowNegativeStock && (
              <div className="p-2.5 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                Saldo akhir menjadi negatif ({adjPreviewAfter}). Kebijakan stok negatif sedang
                dinonaktifkan.
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Alasan Penyesuaian
              </label>
              <select
                value={adjReasonPreset}
                onChange={(e) => setAdjReasonPreset(e.target.value)}
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                {ADJUSTMENT_REASON_PRESETS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              {adjReasonPreset === 'Lainnya' && (
                <input
                  type="text"
                  required
                  value={adjCustomReason}
                  onChange={(e) => setAdjCustomReason(e.target.value)}
                  placeholder="Tulis alasan penyesuaian stok..."
                  className="mt-2 w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                No. Referensi (Opsional)
              </label>
              <input
                type="text"
                value={adjReference}
                onChange={(e) => setAdjReference(e.target.value)}
                placeholder="Otomatis ADJ-..."
                className="w-full text-xs font-mono px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Catatan Tambahan
              </label>
              <textarea
                rows={2}
                value={adjNotes}
                onChange={(e) => setAdjNotes(e.target.value)}
                placeholder="Detail kejadian atau keterangan verifikasi..."
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <button
              type="submit"
              disabled={adjSubmitting || sortedAllProducts.length === 0}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50"
            >
              <SlidersHorizontal className="w-4 h-4" />
              {adjSubmitting
                ? 'Memproses...'
                : canAdjustStock
                ? 'Simpan Penyesuaian Stok'
                : 'Ajukan & Verifikasi PIN Supervisor'}
            </button>
          </form>

          <div className="xl:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Riwayat Penyesuaian Stok</h3>
                <p className="text-xs text-slate-500">
                  Mencatat pemohon, penyetuju (atau otorisasi PIN), dan saldo sebelum/sesudah.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={adjDirFilter}
                  onChange={(e) =>
                    setAdjDirFilter(e.target.value as 'ALL' | StockAdjustmentDirection)
                  }
                  aria-label="Filter arah penyesuaian"
                  className="text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="ALL">Semua Arah</option>
                  <option value="INCREASE">Penambahan (+)</option>
                  <option value="DECREASE">Pengurangan (-)</option>
                </select>
                <div className="relative w-52">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={adjSearch}
                    onChange={(e) => setAdjSearch(e.target.value)}
                    placeholder="Cari produk atau alasan..."
                    className="w-full text-xs pl-8 pr-3 py-1.5 border border-slate-300 rounded-lg"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void loadAdjustments()}
                  className="p-1.5 text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg"
                  aria-label="Segarkan penyesuaian"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${adjustmentsLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                    <th className="py-3 px-4">Waktu</th>
                    <th className="py-3 px-4">Referensi</th>
                    <th className="py-3 px-4">Produk</th>
                    <th className="py-3 px-4 text-right">Perubahan</th>
                    <th className="py-3 px-4 text-right">Awal → Akhir</th>
                    <th className="py-3 px-4">Alasan</th>
                    <th className="py-3 px-4">Disetujui Oleh</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {adjustments.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-500">
                        Belum ada catatan penyesuaian stok.
                      </td>
                    </tr>
                  ) : (
                    adjustments.map((adj) => (
                      <tr key={adj.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                          {formatDateTime(adj.createdAt)}
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                          {adj.referenceNumber}
                        </td>
                        <td className="py-3 px-4">
                          <button
                            type="button"
                            onClick={() => onOpenStockCard(adj.productId)}
                            className="font-semibold text-slate-900 hover:text-teal-700 text-left"
                          >
                            {adj.productName}
                          </button>
                          <p className="font-mono text-[11px] text-slate-500">{adj.sku}</p>
                        </td>
                        <td
                          className={`py-3 px-4 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                            adj.direction === 'INCREASE' ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {adj.direction === 'INCREASE' ? `+${adj.qty}` : `-${adj.qty}`} {adj.unit}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                          <span className="text-slate-400 mr-1">{adj.stockBefore} →</span>
                          <span className="font-semibold text-slate-900">{adj.stockAfter}</span>
                        </td>
                        <td className="py-3 px-4 text-slate-700 max-w-xs">
                          <p className="font-medium truncate">{adj.reason}</p>
                          {adj.notes && (
                            <p className="text-[11px] text-slate-500 truncate">{adj.notes}</p>
                          )}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <p className="font-medium text-slate-800">{adj.approvedByName}</p>
                          {adj.requestedByName !== adj.approvedByName && (
                            <p className="text-[11px] text-slate-500">
                              Pemohon: {adj.requestedByName}
                            </p>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: STOCK OPNAME WORKFLOW */}
      {subTab === 'opname' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Manajemen Stok Opname (Stock Count)
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Alur kerja terstruktur: Buat Sesi → Hitung Stok Fisik → Review Selisih → Persetujuan → Finalisasi.
              </p>
            </div>
            {canAdjustStock && (
              <button
                type="button"
                onClick={() => setCreateOpnameOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4" />
                {createOpnameOpen ? 'Tutup Form Sesi' : 'Buat Sesi Opname'}
              </button>
            )}
          </div>

          {createOpnameOpen && canAdjustStock && (
            <form
              onSubmit={handleCreateOpname}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Judul / Nama Sesi Opname
                  </label>
                  <input
                    type="text"
                    value={newOpnameTitle}
                    onChange={(e) => setNewOpnameTitle(e.target.value)}
                    placeholder={`Contoh: Opname Bulanan ${new Date().toLocaleDateString('id-ID')}`}
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Cakupan Produk
                  </label>
                  <div className="flex items-center gap-2 p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setNewOpnameScope('ALL_ACTIVE')}
                      className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                        newOpnameScope === 'ALL_ACTIVE'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      Semua Produk Aktif ({activeProducts.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewOpnameScope('SELECTED')}
                      className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                        newOpnameScope === 'SELECTED'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      Pilih Produk ({selectedOpnameProductIds.length})
                    </button>
                  </div>
                </div>
              </div>

              {newOpnameScope === 'SELECTED' && (
                <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <input
                      type="text"
                      value={newOpnameSearch}
                      onChange={(e) => setNewOpnameSearch(e.target.value)}
                      placeholder="Filter produk yang ingin dihitung..."
                      className="text-xs px-3 py-1.5 border border-slate-300 rounded-lg w-64"
                    />
                    <div className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedOpnameProductIds(opnameSelectionProducts.map((p) => p.id))
                        }
                        className="text-teal-700 font-semibold hover:underline"
                      >
                        Pilih Semua Tampil
                      </button>
                      <span className="text-slate-300">·</span>
                      <button
                        type="button"
                        onClick={() => setSelectedOpnameProductIds([])}
                        className="text-slate-600 hover:underline"
                      >
                        Kosongkan
                      </button>
                    </div>
                  </div>
                  <div className="max-h-48 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-lg">
                    {opnameSelectionProducts.map((p) => {
                      const checked = selectedOpnameProductIds.includes(p.id);
                      return (
                        <label
                          key={p.id}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-slate-50 cursor-pointer"
                        >
                          <span className="flex items-center gap-2.5 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setSelectedOpnameProductIds((prev) =>
                                  checked ? prev.filter((id) => id !== p.id) : [...prev, p.id]
                                )
                              }
                            />
                            <span className="font-mono text-slate-500">{p.sku}</span>
                            <span className="font-medium text-slate-900 truncate">{p.name}</span>
                          </span>
                          <span className="font-mono text-slate-600 tabular-nums shrink-0">
                            Sistem: {p.stock} {p.unit}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Catatan Sesi (Opsional)
                </label>
                <input
                  type="text"
                  value={newOpnameNotes}
                  onChange={(e) => setNewOpnameNotes(e.target.value)}
                  placeholder="Contoh: Area rak depan & gudang belakang..."
                  className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCreateOpnameOpen(false)}
                  className="px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={opnameBusy}
                  className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
                >
                  {opnameBusy ? 'Membuat...' : 'Mulai Sesi Opname'}
                </button>
              </div>
            </form>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
            {/* Session List */}
            <div className="xl:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <h4 className="text-xs font-semibold text-slate-900">
                  Daftar Sesi Opname ({opnames.length})
                </h4>
                <button
                  type="button"
                  onClick={() => void loadOpnames(activeOpname?.id)}
                  className="p-1 text-slate-500 hover:text-slate-900 rounded"
                  aria-label="Segarkan sesi opname"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${opnamesLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <div className="divide-y divide-slate-100 max-h-[560px] overflow-y-auto">
                {opnames.length === 0 ? (
                  <div className="py-10 px-4 text-center text-xs text-slate-500">
                    <ClipboardCheck className="w-7 h-7 text-slate-300 mx-auto mb-2" />
                    Belum ada sesi stok opname.
                  </div>
                ) : (
                  opnames.map((session) => {
                    const st = opnameStatusLabel(session.status);
                    const isSelected = activeOpname?.id === session.id;
                    return (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => void selectOpnameSession(session.id)}
                        className={`w-full text-left p-3.5 transition-colors ${
                          isSelected ? 'bg-teal-50/70' : 'hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-bold text-slate-900">
                            {session.opnameNumber}
                          </span>
                          <span className={`text-[11px] ${st.className}`}>{st.label}</span>
                        </div>
                        <p className="text-xs font-semibold text-slate-800 mt-1 truncate">
                          {session.title}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
                          {session.countedItems}/{session.totalItems} dihitung ·{' '}
                          {session.discrepancyItems} selisih
                        </p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          {formatDateTime(session.createdAt)} · {session.createdByName}
                        </p>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Active Session Workspace */}
            <div className="xl:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
              {opnameDetailLoading && !activeOpname ? (
                <div className="py-16 text-center text-xs text-slate-500">
                  Memuat detail sesi opname...
                </div>
              ) : !activeOpname ? (
                <div className="py-16 px-4 text-center text-xs text-slate-500">
                  Pilih sesi stok opname di panel kiri atau buat sesi baru untuk mulai menghitung stok fisik.
                </div>
              ) : (
                <>
                  <div className="p-4 border-b border-slate-200 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-mono font-bold text-slate-900">
                            {activeOpname.opnameNumber}
                          </span>
                          <span className="text-slate-300">·</span>
                          <span className={opnameStatusLabel(activeOpname.status).className}>
                            {opnameStatusLabel(activeOpname.status).label}
                          </span>
                        </div>
                        <h4 className="text-base font-semibold text-slate-900 mt-0.5">
                          {activeOpname.title}
                        </h4>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Dibuat: {activeOpname.createdByName} ({formatDateTime(activeOpname.createdAt)})
                          {activeOpname.approvedByName
                            ? ` · Disetujui: ${activeOpname.approvedByName}`
                            : ''}
                          {activeOpname.finalizedByName
                            ? ` · Difinalisasi: ${activeOpname.finalizedByName}`
                            : ''}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {(activeOpname.status === 'DRAFT' ||
                          activeOpname.status === 'PENDING_REVIEW') &&
                          canAdjustStock && (
                            <>
                              <button
                                type="button"
                                disabled={opnameBusy}
                                onClick={() => void handleSaveOpnameCounts(false)}
                                className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg whitespace-nowrap"
                              >
                                Simpan Hitungan
                              </button>
                              {activeOpname.status === 'DRAFT' && (
                                <button
                                  type="button"
                                  disabled={opnameBusy}
                                  onClick={() => void handleSaveOpnameCounts(true)}
                                  className="px-3 py-1.5 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-lg whitespace-nowrap"
                                >
                                  Ajukan Review
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={opnameBusy}
                                onClick={() => void handleApproveOpname()}
                                className="px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
                              >
                                Setujui Penyesuaian
                              </button>
                              <button
                                type="button"
                                disabled={opnameBusy}
                                onClick={() => setConfirmCancelId(activeOpname.id)}
                                className="px-3 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg whitespace-nowrap"
                              >
                                Batalkan
                              </button>
                            </>
                          )}

                        {(activeOpname.status === 'DRAFT' ||
                          activeOpname.status === 'PENDING_REVIEW') &&
                          !canAdjustStock &&
                          activeOpname.countedItems > 0 && (
                            <button
                              type="button"
                              disabled={opnameBusy}
                              onClick={() => void handleApproveOpname()}
                              className="px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
                            >
                              Setujui via PIN Supervisor
                            </button>
                          )}

                        {activeOpname.status === 'APPROVED' && canAdjustStock && (
                          <button
                            type="button"
                            disabled={opnameBusy}
                            onClick={() => setConfirmFinalizeId(activeOpname.id)}
                            className="px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg whitespace-nowrap"
                          >
                            Finalisasi & Perbarui Stok
                          </button>
                        )}
                      </div>
                    </div>

                    {confirmFinalizeId === activeOpname.id && (
                      <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-emerald-900 font-medium">
                          Finalisasi akan memperbarui saldo stok sistem sesuai hitungan fisik dan
                          mencatat mutasi OPNAME. Lanjutkan?
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setConfirmFinalizeId(null)}
                            className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded"
                          >
                            Batal
                          </button>
                          <button
                            type="button"
                            disabled={opnameBusy}
                            onClick={() => void handleFinalizeOpname()}
                            className="px-3 py-1 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded"
                          >
                            Ya, Finalisasi Sekarang
                          </button>
                        </div>
                      </div>
                    )}

                    {confirmCancelId === activeOpname.id && (
                      <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-rose-900 font-medium">
                          Batalkan sesi opname {activeOpname.opnameNumber}? Saldo stok tidak akan
                          berubah.
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setConfirmCancelId(null)}
                            className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded"
                          >
                            Tidak
                          </button>
                          <button
                            type="button"
                            disabled={opnameBusy}
                            onClick={() => void handleCancelOpname()}
                            className="px-3 py-1 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded"
                          >
                            Ya, Batalkan Sesi
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Summary Metrics Row */}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 pt-1 text-xs">
                      <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                        <p className="text-[11px] text-slate-500">Total SKU</p>
                        <p className="font-mono font-bold text-slate-900 tabular-nums">
                          {activeOpname.totalItems}
                        </p>
                      </div>
                      <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                        <p className="text-[11px] text-slate-500">Sudah Dihitung</p>
                        <p className="font-mono font-bold text-slate-900 tabular-nums">
                          {activeOpname.countedItems}
                        </p>
                      </div>
                      <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                        <p className="text-[11px] text-slate-500">Item Selisih</p>
                        <p
                          className={`font-mono font-bold tabular-nums ${
                            activeOpname.discrepancyItems > 0 ? 'text-amber-700' : 'text-emerald-700'
                          }`}
                        >
                          {activeOpname.discrepancyItems}
                        </p>
                      </div>
                      <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                        <p className="text-[11px] text-slate-500">Selisih Qty Bersih</p>
                        <p className="font-mono font-bold text-slate-900 tabular-nums">
                          {activeOpname.totalVarianceQty > 0
                            ? `+${activeOpname.totalVarianceQty}`
                            : activeOpname.totalVarianceQty}
                        </p>
                      </div>
                      <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                        <p className="text-[11px] text-slate-500">Dampak Modal</p>
                        <p className="font-mono font-bold text-slate-900 tabular-nums">
                          {formatRupiah(activeOpname.totalVarianceValue)}
                        </p>
                      </div>
                    </div>

                    {/* Filter items inside opname */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                        {(
                          [
                            { id: 'ALL', label: 'Semua Item' },
                            { id: 'DISCREPANCY', label: 'Ada Selisih' },
                            { id: 'UNCOUNTED', label: 'Belum Dihitung' },
                          ] as const
                        ).map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            onClick={() => setOpnameItemFilter(f.id)}
                            className={`px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                              opnameItemFilter === f.id
                                ? 'bg-white text-slate-900 shadow-sm'
                                : 'text-slate-600'
                            }`}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={opnameItemSearch}
                          onChange={(e) => setOpnameItemSearch(e.target.value)}
                          placeholder="Cari item opname..."
                          className="text-xs px-3 py-1.5 border border-slate-300 rounded-lg w-48"
                        />
                        {(activeOpname.status === 'DRAFT' ||
                          activeOpname.status === 'PENDING_REVIEW') &&
                          canAdjustStock && (
                            <button
                              type="button"
                              onClick={handleFillAllSystemStocks}
                              className="px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap"
                            >
                              Isi Kosong = Stok Sistem
                            </button>
                          )}
                      </div>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                          <th className="py-2.5 px-3.5">Produk & SKU</th>
                          <th className="py-2.5 px-3.5 text-right">Stok Sistem</th>
                          <th className="py-2.5 px-3.5 text-right">Stok Fisik</th>
                          <th className="py-2.5 px-3.5 text-right">Selisih</th>
                          <th className="py-2.5 px-3.5 text-right">Dampak Modal</th>
                          <th className="py-2.5 px-3.5">Catatan</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {filteredOpnameItems.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="py-10 text-center text-slate-500">
                              Tidak ada item opname sesuai filter.
                            </td>
                          </tr>
                        ) : (
                          filteredOpnameItems.map((item) => {
                            const editable =
                              (activeOpname.status === 'DRAFT' ||
                                activeOpname.status === 'PENDING_REVIEW') &&
                              canAdjustStock;
                            const draft = opnameCountsDraft[item.productId] ?? {
                              physicalStock:
                                item.physicalStock === null ? '' : String(item.physicalStock),
                              notes: item.notes,
                            };
                            const hasCount = draft.physicalStock.trim() !== '';
                            const physNum = hasCount ? Number(draft.physicalStock) : null;
                            const variance =
                              physNum !== null && Number.isFinite(physNum)
                                ? physNum - item.systemStock
                                : 0;
                            const impact = variance * item.costPrice;

                            return (
                              <tr key={item.id} className="hover:bg-slate-50/70">
                                <td className="py-2.5 px-3.5">
                                  <p className="font-semibold text-slate-900">{item.productName}</p>
                                  <p className="font-mono text-[11px] text-slate-500">
                                    {item.sku} · {item.barcode}
                                  </p>
                                </td>
                                <td className="py-2.5 px-3.5 text-right font-mono tabular-nums whitespace-nowrap">
                                  {item.systemStock} {item.unit}
                                </td>
                                <td className="py-2.5 px-3.5 text-right whitespace-nowrap">
                                  {editable ? (
                                    <input
                                      type="number"
                                      min={0}
                                      value={draft.physicalStock}
                                      onChange={(e) =>
                                        setOpnameCountsDraft((prev) => ({
                                          ...prev,
                                          [item.productId]: {
                                            ...draft,
                                            physicalStock: e.target.value,
                                          },
                                        }))
                                      }
                                      placeholder="-"
                                      className="w-20 px-2 py-1 text-right text-xs font-mono border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
                                      aria-label={`Stok fisik ${item.productName}`}
                                    />
                                  ) : (
                                    <span className="font-mono font-semibold tabular-nums">
                                      {item.physicalStock === null ? '-' : item.physicalStock}
                                    </span>
                                  )}
                                </td>
                                <td
                                  className={`py-2.5 px-3.5 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                                    !hasCount
                                      ? 'text-slate-400'
                                      : variance > 0
                                      ? 'text-emerald-700'
                                      : variance < 0
                                      ? 'text-rose-700'
                                      : 'text-slate-600'
                                  }`}
                                >
                                  {!hasCount ? '-' : variance > 0 ? `+${variance}` : variance}
                                </td>
                                <td className="py-2.5 px-3.5 text-right font-mono text-slate-700 tabular-nums whitespace-nowrap">
                                  {!hasCount ? '-' : formatRupiah(impact)}
                                </td>
                                <td className="py-2.5 px-3.5">
                                  {editable ? (
                                    <input
                                      type="text"
                                      value={draft.notes}
                                      onChange={(e) =>
                                        setOpnameCountsDraft((prev) => ({
                                          ...prev,
                                          [item.productId]: {
                                            ...draft,
                                            notes: e.target.value,
                                          },
                                        }))
                                      }
                                      placeholder="Catatan..."
                                      className="w-full min-w-[120px] px-2 py-1 text-xs border border-slate-200 rounded-md"
                                    />
                                  ) : (
                                    <span className="text-slate-600">{item.notes || '-'}</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: STOCK MOVEMENT LEDGER */}
      {subTab === 'movements' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-60">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={movSearch}
                  onChange={(e) => setMovSearch(e.target.value)}
                  placeholder="Cari produk, SKU, ref, petugas..."
                  className="w-full text-xs pl-8 pr-3 py-1.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <select
                value={movTypeFilter}
                onChange={(e) => setMovTypeFilter(e.target.value as 'ALL' | StockMovementType)}
                aria-label="Filter jenis mutasi"
                className="text-xs px-3 py-1.5 border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">Semua Jenis Mutasi</option>
                <option value="PENJUALAN">Penjualan Kasir</option>
                <option value="STOCK_IN">Barang Masuk</option>
                <option value="ADJUSTMENT_IN">Penyesuaian (+)</option>
                <option value="ADJUSTMENT_OUT">Penyesuaian (-)</option>
                <option value="OPNAME">Stok Opname</option>
                <option value="RESTOK">Restok Cepat</option>
                <option value="STOK_AWAL">Stok Awal</option>
              </select>

              <input
                type="date"
                value={movDateFrom}
                onChange={(e) => setMovDateFrom(e.target.value)}
                aria-label="Dari tanggal mutasi"
                className="font-mono text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
              />
              <input
                type="date"
                value={movDateTo}
                onChange={(e) => setMovDateTo(e.target.value)}
                aria-label="Sampai tanggal mutasi"
                className="font-mono text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadMovements()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${movementsLoading ? 'animate-spin' : ''}`} />
                Segarkan
              </button>
              <button
                type="button"
                onClick={handleExportMovementsCsv}
                disabled={movements.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                Ekspor CSV
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">Waktu</th>
                  <th className="py-3 px-4">Referensi</th>
                  <th className="py-3 px-4">Produk & SKU</th>
                  <th className="py-3 px-4">Jenis</th>
                  <th className="py-3 px-4 text-right">Perubahan</th>
                  <th className="py-3 px-4 text-right">Awal → Akhir</th>
                  <th className="py-3 px-4">Petugas</th>
                  <th className="py-3 px-4">Keterangan</th>
                  <th className="py-3 px-4 text-right">Kartu</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {movements.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-slate-500">
                      <FileSpreadsheet className="w-7 h-7 text-slate-300 mx-auto mb-1.5" />
                      Belum ada riwayat mutasi stok untuk filter ini.
                    </td>
                  </tr>
                ) : (
                  movements.map((mov) => (
                    <tr key={mov.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                        {formatDateTime(mov.movementDate || mov.createdAt)}
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                        {mov.referenceId}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-semibold text-slate-900">{mov.productName}</p>
                        <p className="font-mono text-[11px] text-slate-500">
                          {mov.sku || mov.barcode}
                        </p>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
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
                      <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                        <span className="text-slate-400 mr-1">{mov.stockBefore} →</span>
                        <span
                          className={`font-semibold ${
                            mov.stockAfter < 0 ? 'text-rose-700' : 'text-slate-900'
                          }`}
                        >
                          {mov.stockAfter}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-700 whitespace-nowrap">
                        {mov.actorName || 'Sistem'}
                      </td>
                      <td className="py-3 px-4 text-slate-600 max-w-xs truncate">
                        {mov.notes || mov.reason || '-'}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onOpenStockCard(mov.productId)}
                          className="text-xs font-semibold text-teal-700 hover:text-teal-800 hover:underline whitespace-nowrap"
                        >
                          Kartu Stok
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
