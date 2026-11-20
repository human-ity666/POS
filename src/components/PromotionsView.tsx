import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Calendar,
  CheckCircle2,
  Edit3,
  Eye,
  Layers,
  Percent,
  Plus,
  Search,
  Settings2,
  Tag,
  X,
  XCircle,
} from 'lucide-react';
import type {
  Category,
  LoyaltySettings,
  Product,
  Promotion,
  PromotionEffectiveStatus,
  PromotionScope,
  PromotionStatus,
  PromotionType,
  StoreData,
  StoreSettings,
} from '../types';
import { apiFetch } from '../utils/api';
import { formatDateTime, formatRupiah } from '../utils/format';

interface PromotionsViewProps {
  promotions: Promotion[];
  products: Product[];
  categories: Category[];
  loyaltySettings: LoyaltySettings;
  settings: StoreSettings;
  canManage: boolean;
  canEditSettings: boolean;
  onStoreUpdate: (store: StoreData) => void;
}

interface TargetSelection {
  targetType: 'PRODUCT' | 'CATEGORY';
  targetId: string;
  requiredQty: number;
}

interface PromoFormState {
  id?: string;
  code: string;
  name: string;
  description: string;
  scope: PromotionScope;
  promoType: PromotionType;
  discountValue: string;
  maxDiscountAmount: string;
  minPurchaseAmount: string;
  minQty: string;
  startDate: string;
  endDate: string;
  status: PromotionStatus;
  stackable: boolean;
  priority: string;
  buyQty: string;
  getQty: string;
  getDiscountPercent: string;
  getProductId: string;
  bundlePrice: string;
  targets: TargetSelection[];
}

function getTodayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDefaultEndIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

function createEmptyForm(): PromoFormState {
  return {
    code: '',
    name: '',
    description: '',
    scope: 'TRANSACTION',
    promoType: 'PERCENT',
    discountValue: '10',
    maxDiscountAmount: '',
    minPurchaseAmount: '0',
    minQty: '1',
    startDate: getTodayIso(),
    endDate: getDefaultEndIso(),
    status: 'ACTIVE',
    stackable: false,
    priority: '10',
    buyQty: '2',
    getQty: '1',
    getDiscountPercent: '100',
    getProductId: '',
    bundlePrice: '0',
    targets: [],
  };
}

const PROMO_TYPE_LABELS: Record<PromotionType, string> = {
  PERCENT: 'Diskon Persen (%)',
  FIXED_AMOUNT: 'Potongan Nominal (Rp)',
  SPECIAL_PRICE: 'Harga Spesial',
  BUY_X_GET_Y: 'Beli X Gratis Y',
  BUNDLE: 'Paket Bundle',
};

const SCOPE_LABELS: Record<PromotionScope, string> = {
  TRANSACTION: 'Transaksi',
  PRODUCT: 'Produk',
  CATEGORY: 'Kategori',
  BUNDLE: 'Bundle Produk',
};

const EFFECTIVE_STATUS_META: Record<
  PromotionEffectiveStatus,
  { label: string; textCls: string }
> = {
  ACTIVE: { label: 'Aktif', textCls: 'text-emerald-700' },
  SCHEDULED: { label: 'Terjadwal', textCls: 'text-sky-700' },
  EXPIRED: { label: 'Berakhir', textCls: 'text-slate-500' },
  INACTIVE: { label: 'Nonaktif', textCls: 'text-rose-700' },
};

function formatPromoBenefit(p: Promotion): string {
  switch (p.promoType) {
    case 'PERCENT':
      return `${p.discountValue}%${
        p.maxDiscountAmount ? ` (Maks ${formatRupiah(p.maxDiscountAmount)})` : ''
      }`;
    case 'FIXED_AMOUNT':
      return `Potong ${formatRupiah(p.discountValue)}`;
    case 'SPECIAL_PRICE':
      return `Harga Jadi ${formatRupiah(p.discountValue)}`;
    case 'BUY_X_GET_Y': {
      const b = p.ruleConfig.buyQty ?? 1;
      const g = p.ruleConfig.getQty ?? 1;
      const pct = p.ruleConfig.getDiscountPercent ?? 100;
      return `Beli ${b} Gratis ${g}${pct < 100 ? ` (Diskon ${pct}%)` : ''}`;
    }
    case 'BUNDLE':
      return `Harga Paket ${formatRupiah(p.ruleConfig.bundlePrice ?? p.discountValue)}`;
  }
}

export function PromotionsView({
  promotions,
  products,
  categories,
  loyaltySettings,
  settings,
  canManage,
  canEditSettings,
  onStoreUpdate,
}: PromotionsViewProps) {
  const [subTab, setSubTab] = useState<'list' | 'policy'>('list');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | PromotionEffectiveStatus>('ALL');
  const [scopeFilter, setScopeFilter] = useState<'ALL' | PromotionScope>('ALL');
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Form modal
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<PromoFormState>(() => createEmptyForm());
  const [targetSearch, setTargetSearch] = useState('');
  const [savingForm, setSavingForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Detail modal
  const [detailPromo, setDetailPromo] = useState<Promotion | null>(null);

  // Loyalty & Policy state
  const [loyaltyForm, setLoyaltyForm] = useState({
    enabled: loyaltySettings.enabled,
    pointsPerAmount: String(loyaltySettings.pointsPerAmount),
    pointValueRp: String(loyaltySettings.pointValueRp),
    minRedeemPoints: String(loyaltySettings.minRedeemPoints),
    maxRedeemPercent: String(loyaltySettings.maxRedeemPercent),
  });
  const [savingLoyalty, setSavingLoyalty] = useState(false);

  const [policyForm, setPolicyForm] = useState({
    allowPromoStacking: settings.allowPromoStacking ?? true,
    allowManualWithPromo: settings.allowManualWithPromo ?? false,
    maxCashierDiscountPercent: String(settings.maxCashierDiscountPercent ?? 25),
    maxAuthorizedDiscountPercent: String(settings.maxAuthorizedDiscountPercent ?? 100),
  });
  const [savingPolicy, setSavingPolicy] = useState(false);

  useEffect(() => {
    setLoyaltyForm({
      enabled: loyaltySettings.enabled,
      pointsPerAmount: String(loyaltySettings.pointsPerAmount),
      pointValueRp: String(loyaltySettings.pointValueRp),
      minRedeemPoints: String(loyaltySettings.minRedeemPoints),
      maxRedeemPercent: String(loyaltySettings.maxRedeemPercent),
    });
  }, [loyaltySettings]);

  useEffect(() => {
    setPolicyForm({
      allowPromoStacking: settings.allowPromoStacking ?? true,
      allowManualWithPromo: settings.allowManualWithPromo ?? false,
      maxCashierDiscountPercent: String(settings.maxCashierDiscountPercent ?? 25),
      maxAuthorizedDiscountPercent: String(settings.maxAuthorizedDiscountPercent ?? 100),
    });
  }, [settings]);

  const metrics = useMemo(() => {
    const activeCount = promotions.filter((p) => p.effectiveStatus === 'ACTIVE').length;
    const scheduledCount = promotions.filter((p) => p.effectiveStatus === 'SCHEDULED').length;
    const totalUsage = promotions.reduce((s, p) => s + p.usageCount, 0);
    return { activeCount, scheduledCount, totalUsage };
  }, [promotions]);

  const filteredPromotions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return promotions.filter((p) => {
      if (statusFilter !== 'ALL' && p.effectiveStatus !== statusFilter) return false;
      if (scopeFilter !== 'ALL' && p.scope !== scopeFilter) return false;
      if (!q) return true;
      return (
        p.code.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q)
      );
    });
  }, [promotions, search, statusFilter, scopeFilter]);

  const activeProductsList = useMemo(
    () =>
      products
        .filter((p) => p.status !== 'INACTIVE')
        .sort((a, b) => a.name.localeCompare(b.name, 'id')),
    [products]
  );

  const filteredTargetProducts = useMemo(() => {
    const q = targetSearch.trim().toLowerCase();
    if (!q) return activeProductsList;
    return activeProductsList.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q)
    );
  }, [activeProductsList, targetSearch]);

  const activeCategoriesList = useMemo(
    () =>
      categories
        .filter((c) => c.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, 'id')),
    [categories]
  );

  const openCreateModal = () => {
    setForm(createEmptyForm());
    setTargetSearch('');
    setFormError(null);
    setFormOpen(true);
  };

  const openEditModal = (p: Promotion) => {
    setForm({
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      scope: p.scope,
      promoType: p.promoType,
      discountValue: String(p.discountValue),
      maxDiscountAmount: p.maxDiscountAmount !== null ? String(p.maxDiscountAmount) : '',
      minPurchaseAmount: String(p.minPurchaseAmount),
      minQty: String(p.minQty),
      startDate: p.startDate.slice(0, 10),
      endDate: p.endDate.slice(0, 10),
      status: p.status,
      stackable: p.stackable,
      priority: String(p.priority),
      buyQty: String(p.ruleConfig.buyQty ?? 2),
      getQty: String(p.ruleConfig.getQty ?? 1),
      getDiscountPercent: String(p.ruleConfig.getDiscountPercent ?? 100),
      getProductId: p.ruleConfig.getProductId ?? '',
      bundlePrice: String(p.ruleConfig.bundlePrice ?? p.discountValue),
      targets: p.targets.map((t) => ({
        targetType: t.targetType,
        targetId: t.targetId,
        requiredQty: t.requiredQty,
      })),
    });
    setTargetSearch('');
    setFormError(null);
    setFormOpen(true);
  };

  const handleScopeChange = (nextScope: PromotionScope) => {
    setForm((prev) => {
      let nextType = prev.promoType;
      if (nextScope === 'BUNDLE') {
        nextType = 'BUNDLE';
      } else if (nextScope === 'TRANSACTION' && (nextType === 'SPECIAL_PRICE' || nextType === 'BUY_X_GET_Y' || nextType === 'BUNDLE')) {
        nextType = 'PERCENT';
      } else if ((nextScope === 'PRODUCT' || nextScope === 'CATEGORY') && nextType === 'BUNDLE') {
        nextType = 'PERCENT';
      }
      const nextTargets =
        nextScope === 'TRANSACTION'
          ? []
          : nextScope === 'CATEGORY'
          ? prev.targets.filter((t) => t.targetType === 'CATEGORY')
          : prev.targets.filter((t) => t.targetType === 'PRODUCT');

      return {
        ...prev,
        scope: nextScope,
        promoType: nextType,
        targets: nextTargets,
      };
    });
  };

  const toggleTarget = (targetType: 'PRODUCT' | 'CATEGORY', targetId: string) => {
    setForm((prev) => {
      const exists = prev.targets.some(
        (t) => t.targetType === targetType && t.targetId === targetId
      );
      if (exists) {
        return {
          ...prev,
          targets: prev.targets.filter(
            (t) => !(t.targetType === targetType && t.targetId === targetId)
          ),
        };
      }
      return {
        ...prev,
        targets: [...prev.targets, { targetType, targetId, requiredQty: 1 }],
      };
    });
  };

  const updateTargetQty = (targetId: string, qty: number) => {
    setForm((prev) => ({
      ...prev,
      targets: prev.targets.map((t) =>
        t.targetId === targetId ? { ...t, requiredQty: Math.max(1, Math.floor(qty || 1)) } : t
      ),
    }));
  };

  const handleFormSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (form.endDate < form.startDate) {
      setFormError('Tanggal berakhir tidak boleh lebih awal dari tanggal mulai.');
      return;
    }
    if (form.scope !== 'TRANSACTION' && form.targets.length === 0) {
      setFormError('Pilih minimal 1 target produk atau kategori untuk cakupan ini.');
      return;
    }

    setSavingForm(true);
    try {
      const ruleConfig: Record<string, unknown> = {};
      if (form.promoType === 'BUY_X_GET_Y') {
        ruleConfig.buyQty = Math.max(1, Math.floor(Number(form.buyQty || 1)));
        ruleConfig.getQty = Math.max(1, Math.floor(Number(form.getQty || 1)));
        ruleConfig.getDiscountPercent = Number(form.getDiscountPercent || 100);
        if (form.getProductId) {
          ruleConfig.getProductId = form.getProductId;
        }
      } else if (form.promoType === 'BUNDLE') {
        ruleConfig.bundlePrice = Math.max(0, Math.round(Number(form.bundlePrice || form.discountValue || 0)));
      }

      const payload = {
        code: form.code.trim().toUpperCase() || undefined,
        name: form.name.trim(),
        description: form.description.trim(),
        scope: form.scope,
        promoType: form.promoType,
        discountValue:
          form.promoType === 'BUNDLE'
            ? Math.max(0, Math.round(Number(form.bundlePrice || form.discountValue || 0)))
            : form.promoType === 'BUY_X_GET_Y'
            ? 0
            : Number(form.discountValue || 0),
        maxDiscountAmount: form.maxDiscountAmount.trim()
          ? Math.round(Number(form.maxDiscountAmount))
          : null,
        minPurchaseAmount: Math.max(0, Math.round(Number(form.minPurchaseAmount || 0))),
        minQty: Math.max(1, Math.floor(Number(form.minQty || 1))),
        startDate: form.startDate,
        endDate: form.endDate,
        status: form.status,
        stackable: form.stackable,
        priority: Math.max(1, Math.min(999, Math.round(Number(form.priority || 10)))),
        ruleConfig,
        targets: form.targets,
      };

      const isEdit = Boolean(form.id);
      const res = await apiFetch<{ promotion: Promotion; store: StoreData }>(
        isEdit ? `/api/promotions/${form.id}` : '/api/promotions',
        {
          method: isEdit ? 'PUT' : 'POST',
          body: JSON.stringify(payload),
        }
      );
      onStoreUpdate(res.store);
      setFormOpen(false);
      if (detailPromo?.id === res.promotion.id) {
        setDetailPromo(res.promotion);
      }
      setBanner({
        type: 'success',
        text: isEdit
          ? `Promosi "${res.promotion.name}" (${res.promotion.code}) berhasil diperbarui.`
          : `Promosi baru "${res.promotion.name}" (${res.promotion.code}) berhasil dibuat.`,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Gagal menyimpan promosi.');
    } finally {
      setSavingForm(false);
    }
  };

  const handleToggleStatus = async (p: Promotion) => {
    setBanner(null);
    const nextStatus: PromotionStatus = p.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      const res = await apiFetch<{ promotion: Promotion; store: StoreData }>(
        `/api/promotions/${p.id}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: nextStatus }),
        }
      );
      onStoreUpdate(res.store);
      if (detailPromo?.id === res.promotion.id) {
        setDetailPromo(res.promotion);
      }
      setBanner({
        type: 'success',
        text: `Promosi "${res.promotion.name}" kini ${
          res.promotion.status === 'ACTIVE' ? 'diaktifkan' : 'dinonaktifkan'
        }.`,
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal mengubah status promosi.',
      });
    }
  };

  const handleSaveLoyalty = async (e: FormEvent) => {
    e.preventDefault();
    setBanner(null);
    setSavingLoyalty(true);
    try {
      const res = await apiFetch<{ loyaltySettings: LoyaltySettings; store: StoreData }>(
        '/api/loyalty/settings',
        {
          method: 'PUT',
          body: JSON.stringify({
            enabled: loyaltyForm.enabled,
            pointsPerAmount: Math.round(Number(loyaltyForm.pointsPerAmount || 10000)),
            pointValueRp: Math.round(Number(loyaltyForm.pointValueRp || 100)),
            minRedeemPoints: Math.round(Number(loyaltyForm.minRedeemPoints || 0)),
            maxRedeemPercent: Number(loyaltyForm.maxRedeemPercent || 50),
          }),
        }
      );
      onStoreUpdate(res.store);
      setBanner({
        type: 'success',
        text: 'Aturan poin loyalitas member berhasil disimpan.',
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menyimpan aturan poin loyalitas.',
      });
    } finally {
      setSavingLoyalty(false);
    }
  };

  const handleSavePolicy = async (e: FormEvent) => {
    e.preventDefault();
    setBanner(null);
    setSavingPolicy(true);
    try {
      const res = await apiFetch<{ settings: StoreSettings; store: StoreData }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...settings,
          allowPromoStacking: policyForm.allowPromoStacking,
          allowManualWithPromo: policyForm.allowManualWithPromo,
          maxCashierDiscountPercent: Number(policyForm.maxCashierDiscountPercent || 25),
          maxAuthorizedDiscountPercent: Number(policyForm.maxAuthorizedDiscountPercent || 100),
        }),
      });
      onStoreUpdate(res.store);
      setBanner({
        type: 'success',
        text: 'Kebijakan penggabungan promo dan batas diskon toko diperbarui.',
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menyimpan kebijakan diskon toko.',
      });
    } finally {
      setSavingPolicy(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Top KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Promosi Aktif</span>
            <Tag className="w-4 h-4 text-emerald-600" />
          </div>
          <p className="font-mono text-2xl font-bold text-emerald-700 mt-1 tabular-nums">
            {metrics.activeCount}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Berlaku otomatis/terpilih di kasir</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Terjadwal</span>
            <Calendar className="w-4 h-4 text-sky-600" />
          </div>
          <p className="font-mono text-2xl font-bold text-sky-700 mt-1 tabular-nums">
            {metrics.scheduledCount}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Menunggu tanggal mulai aktif</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Total Pemakaian</span>
            <Percent className="w-4 h-4 text-slate-400" />
          </div>
          <p className="font-mono text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {metrics.totalUsage.toLocaleString('id-ID')}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Transaksi selesai dengan promo</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Program Loyalitas</span>
            <Layers className="w-4 h-4 text-teal-700" />
          </div>
          <p
            className={`text-lg font-bold mt-1 ${
              loyaltySettings.enabled ? 'text-teal-800' : 'text-slate-500'
            }`}
          >
            {loyaltySettings.enabled ? 'Aktif' : 'Nonaktif'}
          </p>
          <p className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
            1 poin / {formatRupiah(loyaltySettings.pointsPerAmount)}
          </p>
        </div>
      </div>

      {/* Sub-Tabs */}
      <div className="flex items-center justify-between border-b border-slate-200 gap-4">
        <div className="flex gap-5">
          <button
            type="button"
            onClick={() => setSubTab('list')}
            className={`py-2.5 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
              subTab === 'list'
                ? 'border-teal-700 text-teal-800'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            Daftar Promosi ({promotions.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('policy')}
            className={`py-2.5 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap inline-flex items-center gap-1.5 ${
              subTab === 'policy'
                ? 'border-teal-700 text-teal-800'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            <Settings2 className="w-3.5 h-3.5" />
            Aturan Loyalitas & Kebijakan Diskon
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border text-xs font-medium ${
            banner.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="font-semibold underline underline-offset-2 shrink-0"
          >
            Tutup
          </button>
        </div>
      )}

      {subTab === 'list' ? (
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5 flex-1">
              <div className="relative flex-1 min-w-[200px] max-w-sm">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Cari kode atau nama promosi..."
                  className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as 'ALL' | PromotionEffectiveStatus)
                }
                aria-label="Filter status promosi"
                className="text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">Semua Status</option>
                <option value="ACTIVE">Aktif Berlaku</option>
                <option value="SCHEDULED">Terjadwal</option>
                <option value="EXPIRED">Berakhir</option>
                <option value="INACTIVE">Nonaktif</option>
              </select>

              <select
                value={scopeFilter}
                onChange={(e) => setScopeFilter(e.target.value as 'ALL' | PromotionScope)}
                aria-label="Filter cakupan promosi"
                className="text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">Semua Cakupan</option>
                <option value="TRANSACTION">Transaksi</option>
                <option value="PRODUCT">Produk</option>
                <option value="CATEGORY">Kategori</option>
                <option value="BUNDLE">Bundle</option>
              </select>
            </div>

            {canManage && (
              <button
                type="button"
                onClick={openCreateModal}
                className="min-h-[40px] inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4" />
                Buat Promosi
              </button>
            )}
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                  <th className="py-2.5 px-3">Kode & Nama Promo</th>
                  <th className="py-2.5 px-3">Tipe & Manfaat</th>
                  <th className="py-2.5 px-3">Cakupan</th>
                  <th className="py-2.5 px-3">Periode & Syarat</th>
                  <th className="py-2.5 px-3 text-right">Dipakai</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredPromotions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-slate-500">
                      Tidak ada promosi yang cocok dengan filter saat ini.
                    </td>
                  </tr>
                ) : (
                  filteredPromotions.map((p) => {
                    const effMeta = EFFECTIVE_STATUS_META[p.effectiveStatus];
                    return (
                      <tr key={p.id} className="hover:bg-slate-50/70 transition-colors">
                        <td className="py-2.5 px-3 align-top">
                          <p className="font-mono font-bold text-slate-900">{p.code}</p>
                          <p className="font-semibold text-slate-800">{p.name}</p>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            Prioritas {p.priority} · {p.stackable ? 'Bisa Digabung' : 'Tunggal'}
                          </p>
                        </td>
                        <td className="py-2.5 px-3 align-top">
                          <p className="font-semibold text-teal-800">{formatPromoBenefit(p)}</p>
                          <p className="text-[11px] text-slate-500">{PROMO_TYPE_LABELS[p.promoType]}</p>
                        </td>
                        <td className="py-2.5 px-3 align-top">
                          <p className="font-medium text-slate-800">{SCOPE_LABELS[p.scope]}</p>
                          <p className="text-[11px] text-slate-500">
                            {p.scope === 'TRANSACTION'
                              ? 'Seluruh keranjang'
                              : p.targets.length > 0
                              ? `${p.targets.length} target (${p.targets[0].targetName ?? p.targets[0].targetId})`
                              : '0 target'}
                          </p>
                        </td>
                        <td className="py-2.5 px-3 align-top font-mono text-[11px] tabular-nums">
                          <p className="text-slate-800">
                            {p.startDate} s.d. {p.endDate}
                          </p>
                          <p className="font-sans text-slate-500 mt-0.5">
                            {p.minPurchaseAmount > 0
                              ? `Min ${formatRupiah(p.minPurchaseAmount)}`
                              : 'Tanpa min belanja'}
                            {p.minQty > 1 ? ` · Min ${p.minQty} unit` : ''}
                          </p>
                        </td>
                        <td className="py-2.5 px-3 text-right align-top font-mono font-semibold text-slate-800 tabular-nums">
                          {p.usageCount}x
                        </td>
                        <td className="py-2.5 px-3 align-top">
                          <span className={`font-semibold whitespace-nowrap ${effMeta.textCls}`}>
                            · {effMeta.label}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right align-top">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setDetailPromo(p)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100"
                            >
                              <Eye className="w-3 h-3" />
                              Detail
                            </button>
                            {canManage && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => openEditModal(p)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                                >
                                  <Edit3 className="w-3 h-3" />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleToggleStatus(p)}
                                  className={`px-2 py-1.5 text-[11px] font-semibold rounded-md border ${
                                    p.status === 'ACTIVE'
                                      ? 'text-rose-700 bg-white border-slate-300 hover:bg-rose-50'
                                      : 'text-emerald-700 bg-white border-slate-300 hover:bg-emerald-50'
                                  }`}
                                  title={
                                    p.status === 'ACTIVE'
                                      ? 'Nonaktifkan promosi'
                                      : 'Aktifkan promosi'
                                  }
                                >
                                  {p.status === 'ACTIVE' ? (
                                    <XCircle className="w-3.5 h-3.5" />
                                  ) : (
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </>
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
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Loyalty Rules Card */}
          <form
            onSubmit={handleSaveLoyalty}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Konfigurasi Poin Loyalitas Member
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Berlaku otomatis untuk pelanggan member terdaftar saat transaksi selesai.
              </p>
            </div>

            <label className="flex items-center gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                disabled={!canManage && !canEditSettings}
                checked={loyaltyForm.enabled}
                onChange={(e) => setLoyaltyForm({ ...loyaltyForm, enabled: e.target.checked })}
                className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
              />
              <span className="text-xs font-semibold text-slate-800">
                Aktifkan Pengumpulan & Penukaran Poin Loyalitas
              </span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Belanja per 1 Poin (Rp)
                </label>
                <input
                  type="number"
                  min={1000}
                  step={500}
                  disabled={!canManage && !canEditSettings}
                  value={loyaltyForm.pointsPerAmount}
                  onChange={(e) =>
                    setLoyaltyForm({ ...loyaltyForm, pointsPerAmount: e.target.value })
                  }
                  className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Nilai Tukar 1 Poin (Rp)
                </label>
                <input
                  type="number"
                  min={1}
                  disabled={!canManage && !canEditSettings}
                  value={loyaltyForm.pointValueRp}
                  onChange={(e) =>
                    setLoyaltyForm({ ...loyaltyForm, pointValueRp: e.target.value })
                  }
                  className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Minimal Poin untuk Penukaran
                </label>
                <input
                  type="number"
                  min={0}
                  disabled={!canManage && !canEditSettings}
                  value={loyaltyForm.minRedeemPoints}
                  onChange={(e) =>
                    setLoyaltyForm({ ...loyaltyForm, minRedeemPoints: e.target.value })
                  }
                  className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Maksimal Potongan Poin (%)
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  disabled={!canManage && !canEditSettings}
                  value={loyaltyForm.maxRedeemPercent}
                  onChange={(e) =>
                    setLoyaltyForm({ ...loyaltyForm, maxRedeemPercent: e.target.value })
                  }
                  className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                />
              </div>
            </div>

            {(canManage || canEditSettings) && (
              <div className="pt-2 border-t border-slate-200 flex justify-end">
                <button
                  type="submit"
                  disabled={savingLoyalty}
                  className="min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
                >
                  {savingLoyalty ? 'Menyimpan...' : 'Simpan Aturan Loyalitas'}
                </button>
              </div>
            )}
          </form>

          {/* Stacking & Discount Limit Policy Card */}
          <form
            onSubmit={handleSavePolicy}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Kebijakan Stacking Promo & Batas Diskon
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Ditegakkan oleh mesin kalkulasi backend saat pratinjau maupun checkout.
              </p>
            </div>

            <div className="space-y-2.5">
              <label className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!canEditSettings}
                  checked={policyForm.allowPromoStacking}
                  onChange={(e) =>
                    setPolicyForm({ ...policyForm, allowPromoStacking: e.target.checked })
                  }
                  className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                />
                <div className="text-xs">
                  <span className="font-semibold text-slate-800 block">
                    Izinkan Penggabungan Multi-Promosi (Stacking)
                  </span>
                  <span className="text-slate-500">
                    Jika nonaktif, kasir hanya dapat memilih 1 promosi per transaksi.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!canEditSettings}
                  checked={policyForm.allowManualWithPromo}
                  onChange={(e) =>
                    setPolicyForm({ ...policyForm, allowManualWithPromo: e.target.checked })
                  }
                  className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                />
                <div className="text-xs">
                  <span className="font-semibold text-slate-800 block">
                    Izinkan Diskon Manual Bersamaan dengan Promosi
                  </span>
                  <span className="text-slate-500">
                    Jika nonaktif, pengisian diskon manual akan menolak penggabungan promo aktif.
                  </span>
                </div>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Referensi Batas Diskon Kasir (%)
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  disabled={!canEditSettings}
                  value={policyForm.maxCashierDiscountPercent}
                  onChange={(e) =>
                    setPolicyForm({
                      ...policyForm,
                      maxCashierDiscountPercent: e.target.value,
                    })
                  }
                  className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Batas Maksimal Diskon Terotorisasi (%)
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  disabled={!canEditSettings}
                  value={policyForm.maxAuthorizedDiscountPercent}
                  onChange={(e) =>
                    setPolicyForm({
                      ...policyForm,
                      maxAuthorizedDiscountPercent: e.target.value,
                    })
                  }
                  className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                />
              </div>
            </div>

            {canEditSettings ? (
              <div className="pt-2 border-t border-slate-200 flex justify-end">
                <button
                  type="submit"
                  disabled={savingPolicy}
                  className="min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg disabled:opacity-50"
                >
                  {savingPolicy ? 'Menyimpan...' : 'Simpan Kebijakan Diskon'}
                </button>
              </div>
            ) : (
              <p className="text-[11px] text-amber-700">
                Membutuhkan izin pengaturan toko (<span className="font-mono">settings:edit</span>)
                untuk mengubah kebijakan stacking & batas diskon global.
              </p>
            )}
          </form>
        </div>
      )}

      {/* Create / Edit Promotion Modal */}
      {formOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={form.id ? 'Edit Promosi' : 'Buat Promosi Baru'}
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl overflow-hidden shadow-xl flex flex-col max-h-[92vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900">
                {form.id ? `Edit Promosi · ${form.code}` : 'Buat Promosi Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="p-5 overflow-y-auto space-y-4 text-xs">
              {formError && (
                <div className="p-3 font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Kode Promo</label>
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                    placeholder="Contoh: HEMAT10 (otomatis jika kosong)"
                    className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-medium text-slate-700 mb-1">Nama Promosi *</label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Contoh: Diskon Akhir Pekan 10%"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Deskripsi Singkat</label>
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Keterangan singkat syarat dan ketentuan promo"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Cakupan Promo</label>
                  <select
                    value={form.scope}
                    onChange={(e) => handleScopeChange(e.target.value as PromotionScope)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="TRANSACTION">Seluruh Transaksi</option>
                    <option value="PRODUCT">Produk Tertentu</option>
                    <option value="CATEGORY">Kategori Tertentu</option>
                    <option value="BUNDLE">Paket Bundle Produk</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">Jenis Promosi</label>
                  <select
                    value={form.promoType}
                    onChange={(e) =>
                      setForm({ ...form, promoType: e.target.value as PromotionType })
                    }
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    {form.scope === 'BUNDLE' ? (
                      <option value="BUNDLE">Paket Bundle (Harga Paket)</option>
                    ) : form.scope === 'TRANSACTION' ? (
                      <>
                        <option value="PERCENT">Diskon Persentase (%)</option>
                        <option value="FIXED_AMOUNT">Potongan Nominal (Rp)</option>
                      </>
                    ) : (
                      <>
                        <option value="PERCENT">Diskon Persentase (%)</option>
                        <option value="FIXED_AMOUNT">Potongan Nominal per Unit (Rp)</option>
                        <option value="SPECIAL_PRICE">Harga Spesial per Unit (Rp)</option>
                        <option value="BUY_X_GET_Y">Beli X Gratis Y</option>
                      </>
                    )}
                  </select>
                </div>

                {form.promoType !== 'BUY_X_GET_Y' && (
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      {form.promoType === 'PERCENT'
                        ? 'Persentase Diskon (%)'
                        : form.promoType === 'SPECIAL_PRICE'
                        ? 'Harga Spesial (Rp)'
                        : form.promoType === 'BUNDLE'
                        ? 'Harga Paket Bundle (Rp)'
                        : 'Nominal Potongan (Rp)'}
                    </label>
                    <input
                      type="number"
                      min={form.promoType === 'PERCENT' ? 1 : 0}
                      max={form.promoType === 'PERCENT' ? 100 : undefined}
                      step="any"
                      required
                      value={form.promoType === 'BUNDLE' ? form.bundlePrice : form.discountValue}
                      onChange={(e) =>
                        form.promoType === 'BUNDLE'
                          ? setForm({
                              ...form,
                              bundlePrice: e.target.value,
                              discountValue: e.target.value,
                            })
                          : setForm({ ...form, discountValue: e.target.value })
                      }
                      className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                    />
                  </div>
                )}
              </div>

              {form.promoType === 'BUY_X_GET_Y' && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Beli (Qty)</label>
                    <input
                      type="number"
                      min={1}
                      value={form.buyQty}
                      onChange={(e) => setForm({ ...form, buyQty: e.target.value })}
                      className="w-full font-mono px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Gratis (Qty)</label>
                    <input
                      type="number"
                      min={1}
                      value={form.getQty}
                      onChange={(e) => setForm({ ...form, getQty: e.target.value })}
                      className="w-full font-mono px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Diskon Gratis (%)</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={form.getDiscountPercent}
                      onChange={(e) => setForm({ ...form, getDiscountPercent: e.target.value })}
                      className="w-full font-mono px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Produk Hadiah</label>
                    <select
                      value={form.getProductId}
                      onChange={(e) => setForm({ ...form, getProductId: e.target.value })}
                      className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                    >
                      <option value="">Sama dengan item target</option>
                      {activeProductsList.map((pr) => (
                        <option key={pr.id} value={pr.id}>
                          {pr.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Maks Diskon (Rp, Opsional)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={form.maxDiscountAmount}
                    onChange={(e) => setForm({ ...form, maxDiscountAmount: e.target.value })}
                    placeholder="Tanpa batas"
                    className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Min Pembelian (Rp)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={form.minPurchaseAmount}
                    onChange={(e) => setForm({ ...form, minPurchaseAmount: e.target.value })}
                    className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Min Qty Beli</label>
                  <input
                    type="number"
                    min={1}
                    value={form.minQty}
                    onChange={(e) => setForm({ ...form, minQty: e.target.value })}
                    className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Prioritas (1-999)</label>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: e.target.value })}
                    className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Tanggal Mulai *</label>
                  <input
                    type="date"
                    required
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                    className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Tanggal Berakhir *</label>
                  <input
                    type="date"
                    required
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Status Awal</label>
                  <select
                    value={form.status}
                    onChange={(e) =>
                      setForm({ ...form, status: e.target.value as PromotionStatus })
                    }
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="ACTIVE">Aktif</option>
                    <option value="INACTIVE">Nonaktif</option>
                  </select>
                </div>
              </div>

              <label className="flex items-center gap-2 font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.stackable}
                  onChange={(e) => setForm({ ...form, stackable: e.target.checked })}
                  className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                />
                Promosi dapat digabung dengan promosi lain (Stackable)
              </label>

              {/* Target Picker */}
              {(form.scope === 'PRODUCT' || form.scope === 'BUNDLE') && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-800">
                      Pilih Produk Target ({form.targets.length} dipilih)
                    </span>
                    <input
                      type="text"
                      value={targetSearch}
                      onChange={(e) => setTargetSearch(e.target.value)}
                      placeholder="Filter produk..."
                      className="w-56 px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                    />
                  </div>
                  <div className="max-h-44 overflow-y-auto bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {filteredTargetProducts.map((pr) => {
                      const picked = form.targets.find(
                        (t) => t.targetType === 'PRODUCT' && t.targetId === pr.id
                      );
                      return (
                        <div
                          key={pr.id}
                          className="px-3 py-2 flex items-center justify-between gap-2"
                        >
                          <label className="flex items-center gap-2 cursor-pointer min-w-0 flex-1">
                            <input
                              type="checkbox"
                              checked={Boolean(picked)}
                              onChange={() => toggleTarget('PRODUCT', pr.id)}
                              className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                            />
                            <span className="truncate font-medium text-slate-800">{pr.name}</span>
                            <span className="font-mono text-[11px] text-slate-500 shrink-0">
                              {formatRupiah(pr.sellPrice)}
                            </span>
                          </label>
                          {picked && form.scope === 'BUNDLE' && (
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="text-[11px] text-slate-500">Qty:</span>
                              <input
                                type="number"
                                min={1}
                                value={picked.requiredQty}
                                onChange={(e) =>
                                  updateTargetQty(pr.id, parseInt(e.target.value, 10))
                                }
                                className="w-14 font-mono text-center px-1.5 py-1 border border-slate-300 rounded"
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {form.scope === 'CATEGORY' && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <span className="block font-semibold text-slate-800">
                    Pilih Kategori Target ({form.targets.length} dipilih)
                  </span>
                  <div className="max-h-40 overflow-y-auto bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {activeCategoriesList.map((cat) => {
                      const checked = form.targets.some(
                        (t) => t.targetType === 'CATEGORY' && t.targetId === cat.id
                      );
                      return (
                        <label
                          key={cat.id}
                          className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-slate-50"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleTarget('CATEGORY', cat.id)}
                            className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                          />
                          <span className="font-medium text-slate-800">
                            {cat.parentName ? `${cat.parentName} › ${cat.name}` : cat.name}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="px-4 py-2 font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingForm}
                  className="px-4 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
                >
                  {savingForm ? 'Menyimpan...' : form.id ? 'Simpan Perubahan' : 'Buat Promosi'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Promotion Detail Modal */}
      {detailPromo && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Detail Promosi"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl overflow-hidden shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-slate-900">
                    {detailPromo.code}
                  </span>
                  <span
                    className={`text-xs font-semibold ${
                      EFFECTIVE_STATUS_META[detailPromo.effectiveStatus].textCls
                    }`}
                  >
                    · {EFFECTIVE_STATUS_META[detailPromo.effectiveStatus].label}
                  </span>
                </div>
                <p className="text-xs text-slate-600 mt-0.5">{detailPromo.name}</p>
              </div>
              <button
                type="button"
                onClick={() => setDetailPromo(null)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              {detailPromo.description && (
                <p className="text-slate-600">{detailPromo.description}</p>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <p className="text-slate-500">Manfaat Promosi</p>
                  <p className="font-semibold text-teal-800 mt-0.5">
                    {formatPromoBenefit(detailPromo)}
                  </p>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <p className="text-slate-500">Cakupan & Tipe</p>
                  <p className="font-semibold text-slate-900 mt-0.5">
                    {SCOPE_LABELS[detailPromo.scope]} · {PROMO_TYPE_LABELS[detailPromo.promoType]}
                  </p>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg font-mono tabular-nums">
                  <p className="font-sans text-slate-500">Periode Berlaku</p>
                  <p className="font-semibold text-slate-900 mt-0.5">
                    {detailPromo.startDate} – {detailPromo.endDate}
                  </p>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg font-mono tabular-nums">
                  <p className="font-sans text-slate-500">Pemakaian & Prioritas</p>
                  <p className="font-semibold text-slate-900 mt-0.5">
                    {detailPromo.usageCount}x · Prioritas {detailPromo.priority}
                  </p>
                </div>
              </div>

              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
                <p className="font-semibold text-slate-800">Aturan & Syarat</p>
                <p className="text-slate-600">
                  Min Pembelian:{' '}
                  <span className="font-mono font-semibold">
                    {formatRupiah(detailPromo.minPurchaseAmount)}
                  </span>{' '}
                  · Min Qty: <span className="font-mono font-semibold">{detailPromo.minQty}</span>{' '}
                  · Stacking:{' '}
                  <span className="font-semibold">
                    {detailPromo.stackable ? 'Bisa Digabung' : 'Tidak Bisa Digabung'}
                  </span>
                </p>
                <p className="text-slate-500">
                  Dibuat oleh {detailPromo.createdByName} pada{' '}
                  {formatDateTime(detailPromo.createdAt)}
                </p>
              </div>

              {detailPromo.targets.length > 0 && (
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="bg-slate-50 px-3 py-2 font-semibold text-slate-700 border-b border-slate-200">
                    Target Promosi ({detailPromo.targets.length})
                  </div>
                  <div className="divide-y divide-slate-100 max-h-40 overflow-y-auto">
                    {detailPromo.targets.map((t) => (
                      <div
                        key={t.id}
                        className="px-3 py-2 flex items-center justify-between gap-2"
                      >
                        <span className="font-medium text-slate-800">
                          {t.targetName ?? t.targetId}
                        </span>
                        <span className="font-mono text-[11px] text-slate-500">
                          {t.targetType} · Qty min {t.requiredQty}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-200 bg-slate-50">
              {canManage && (
                <button
                  type="button"
                  onClick={() => {
                    const target = detailPromo;
                    setDetailPromo(null);
                    openEditModal(target);
                  }}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Edit Promosi
                </button>
              )}
              <button
                type="button"
                onClick={() => setDetailPromo(null)}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
