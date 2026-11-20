import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { CreditCard, ImagePlus, Plus, Receipt, Store, Trash2, X } from 'lucide-react';
import type {
  PaymentMethodConfig,
  PaymentMethodType,
  ReceiptPaperWidth,
  StoreData,
  StoreSettings,
} from '../types';
import { apiFetch } from '../utils/api';

interface SettingsModalProps {
  open: boolean;
  settings: StoreSettings;
  onClose: () => void;
  onSave: (next: StoreSettings) => Promise<void>;
  onStoreUpdate?: (store: StoreData) => void;
}

const TYPE_LABELS: Record<PaymentMethodType, string> = {
  CASH: 'Tunai',
  DEBIT: 'Kartu Debit',
  CREDIT: 'Kartu Kredit',
  QRIS: 'QRIS',
  OTHER: 'Lainnya',
};

export function SettingsModal({
  open,
  settings,
  onClose,
  onSave,
  onStoreUpdate,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'store' | 'receipt' | 'payments'>('store');
  const [form, setForm] = useState<StoreSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodConfig[]>([]);
  const [loadingMethods, setLoadingMethods] = useState(false);
  const [newMethodName, setNewMethodName] = useState('');
  const [newMethodType, setNewMethodType] = useState<PaymentMethodType>('OTHER');
  const [newRequiresRef, setNewRequiresRef] = useState(true);
  const [creatingMethod, setCreatingMethod] = useState(false);
  const [methodError, setMethodError] = useState<string | null>(null);

  const loadPaymentMethods = async () => {
    setLoadingMethods(true);
    setMethodError(null);
    try {
      const res = await apiFetch<{ paymentMethods: PaymentMethodConfig[] }>(
        '/api/payment-methods?includeInactive=true'
      );
      setPaymentMethods(res.paymentMethods);
    } catch (err) {
      setMethodError(
        err instanceof Error ? err.message : 'Gagal memuat daftar metode pembayaran.'
      );
    } finally {
      setLoadingMethods(false);
    }
  };

  useEffect(() => {
    if (open) {
      setForm({
        ...settings,
        receiptPaperWidth: settings.receiptPaperWidth ?? '80mm',
        receiptShowLogo: settings.receiptShowLogo ?? true,
        receiptShowQr: settings.receiptShowQr ?? true,
        receiptHeaderNote: settings.receiptHeaderNote ?? '',
        storeLogoUrl: settings.storeLogoUrl ?? '',
        allowNegativeStock: settings.allowNegativeStock ?? false,
      });
      setError(null);
      setMethodError(null);
      setActiveTab('store');
      void loadPaymentMethods();
    }
  }, [open, settings]);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSave(form);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan pengaturan toko.');
    } finally {
      setSaving(false);
    }
  };

  const handleLogoFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Logo toko harus berformat PNG, JPG, atau WEBP.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Ukuran file logo maksimal 2 MB.');
      return;
    }

    setError(null);
    setUploadingLogo(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
        reader.readAsDataURL(file);
      });

      const res = await apiFetch<{
        settings: StoreSettings;
        logoUrl: string;
        store: StoreData;
      }>('/api/settings/logo', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          dataBase64: dataUrl,
        }),
      });
      setForm((prev) => ({ ...prev, storeLogoUrl: res.logoUrl }));
      onStoreUpdate?.(res.store);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengunggah logo toko.');
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleDeleteLogo = async () => {
    setError(null);
    setUploadingLogo(true);
    try {
      const res = await apiFetch<{ settings: StoreSettings; store: StoreData }>(
        '/api/settings/logo',
        { method: 'DELETE' }
      );
      setForm((prev) => ({ ...prev, storeLogoUrl: '' }));
      onStoreUpdate?.(res.store);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus logo toko.');
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleCreateMethod = async (e: FormEvent) => {
    e.preventDefault();
    if (!newMethodName.trim()) return;
    setMethodError(null);
    setCreatingMethod(true);
    try {
      const res = await apiFetch<{
        paymentMethod: PaymentMethodConfig;
        store: StoreData;
      }>('/api/payment-methods', {
        method: 'POST',
        body: JSON.stringify({
          name: newMethodName.trim(),
          type: newMethodType,
          requiresReference: newRequiresRef,
        }),
      });
      setNewMethodName('');
      await loadPaymentMethods();
      onStoreUpdate?.(res.store);
    } catch (err) {
      setMethodError(
        err instanceof Error ? err.message : 'Gagal menambahkan metode pembayaran.'
      );
    } finally {
      setCreatingMethod(false);
    }
  };

  const handleToggleMethod = async (pm: PaymentMethodConfig) => {
    setMethodError(null);
    try {
      const res = await apiFetch<{
        paymentMethod: PaymentMethodConfig;
        store: StoreData;
      }>(`/api/payment-methods/${pm.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !pm.isActive }),
      });
      await loadPaymentMethods();
      onStoreUpdate?.(res.store);
    } catch (err) {
      setMethodError(
        err instanceof Error ? err.message : 'Gagal mengubah status metode pembayaran.'
      );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Pengaturan Toko"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h3 className="text-base font-semibold text-slate-900">Pengaturan Toko & Struk</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Tutup pengaturan"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex border-b border-slate-200 bg-slate-50 px-5 gap-4 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('store')}
            className={`inline-flex items-center gap-1.5 py-2.5 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
              activeTab === 'store'
                ? 'border-teal-700 text-teal-800'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            <Store className="w-3.5 h-3.5" />
            Profil & Pajak
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('receipt')}
            className={`inline-flex items-center gap-1.5 py-2.5 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
              activeTab === 'receipt'
                ? 'border-teal-700 text-teal-800'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            <Receipt className="w-3.5 h-3.5" />
            Struk & Logo
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('payments')}
            className={`inline-flex items-center gap-1.5 py-2.5 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
              activeTab === 'payments'
                ? 'border-teal-700 text-teal-800'
                : 'border-transparent text-slate-500 hover:text-slate-900'
            }`}
          >
            <CreditCard className="w-3.5 h-3.5" />
            Metode Pembayaran
          </button>
        </div>

        {activeTab === 'store' && (
          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            {error && (
              <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                {error}
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Nama Toko</label>
              <input
                type="text"
                value={form.storeName}
                onChange={(e) => setForm({ ...form, storeName: e.target.value })}
                required
                className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Alamat Toko</label>
              <input
                type="text"
                value={form.storeAddress}
                onChange={(e) => setForm({ ...form, storeAddress: e.target.value })}
                className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Telepon</label>
                <input
                  type="text"
                  value={form.storePhone}
                  onChange={(e) => setForm({ ...form, storePhone: e.target.value })}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Nama Kasir Default
                </label>
                <input
                  type="text"
                  value={form.cashierName}
                  onChange={(e) => setForm({ ...form, cashierName: e.target.value })}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 items-end">
              <label className="flex items-center gap-2 px-3 py-2 border border-slate-300 rounded-lg cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.taxEnabled}
                  onChange={(e) => setForm({ ...form, taxEnabled: e.target.checked })}
                  className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                />
                <span className="text-xs font-medium text-slate-700">Aktifkan PPN Otomatis</span>
              </label>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Tarif PPN (%)
                </label>
                <input
                  type="number"
                  min="0"
                  max="30"
                  step="0.5"
                  value={form.taxRate}
                  onChange={(e) => setForm({ ...form, taxRate: Number(e.target.value || 0) })}
                  className="w-full font-mono text-sm px-3 py-2 border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>

            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.allowNegativeStock ?? false}
                  onChange={(e) => setForm({ ...form, allowNegativeStock: e.target.checked })}
                  className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                />
                <div>
                  <span className="block text-xs font-semibold text-slate-800">
                    Izinkan Stok Negatif (Oversell / Saldo Minus)
                  </span>
                  <span className="block text-[11px] text-slate-500 mt-0.5">
                    Jika nonaktif, kasir dan penyesuaian pengurangan stok akan ditolak saat stok
                    tersedia tidak mencukupi.
                  </span>
                </div>
              </label>
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
                disabled={saving}
                className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50"
              >
                {saving ? 'Menyimpan...' : 'Simpan Pengaturan'}
              </button>
            </div>
          </form>
        )}

        {activeTab === 'receipt' && (
          <form onSubmit={handleSubmit} className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
            {error && (
              <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                {error}
              </div>
            )}

            {/* Store Logo Upload */}
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5">
              <p className="text-xs font-semibold text-slate-800">Logo Toko untuk Struk</p>
              <div className="flex items-center gap-3">
                <div className="w-16 h-16 rounded-lg border border-slate-200 bg-white flex items-center justify-center overflow-hidden shrink-0">
                  {form.storeLogoUrl ? (
                    <img
                      src={form.storeLogoUrl}
                      alt="Logo Toko"
                      className="w-full h-full object-contain p-1"
                    />
                  ) : (
                    <Store className="w-6 h-6 text-slate-300" />
                  )}
                </div>
                <div className="flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={logoInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleLogoFileChange}
                      className="hidden"
                    />
                    <button
                      type="button"
                      disabled={uploadingLogo}
                      onClick={() => logoInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg disabled:opacity-50"
                    >
                      <ImagePlus className="w-3.5 h-3.5" />
                      {uploadingLogo ? 'Mengunggah...' : 'Unggah Logo'}
                    </button>
                    {form.storeLogoUrl && (
                      <button
                        type="button"
                        disabled={uploadingLogo}
                        onClick={() => void handleDeleteLogo()}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 hover:bg-rose-100 rounded-lg disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Hapus
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500">
                    PNG, JPG, atau WEBP maksimal 2 MB. Logo yang tersimpan dibekukan per transaksi
                    saat checkout.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Lebar Kertas Struk Default
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['58mm', '80mm', 'A4'] as ReceiptPaperWidth[]).map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setForm({ ...form, receiptPaperWidth: w })}
                    className={`py-2 px-3 text-xs font-semibold rounded-lg border transition-colors ${
                      form.receiptPaperWidth === w
                        ? 'bg-teal-50 text-teal-800 border-teal-400'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {w === 'A4' ? 'Standar A4' : `Thermal ${w}`}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <label className="flex items-center gap-2 px-3 py-2 border border-slate-300 rounded-lg cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.receiptShowLogo ?? true}
                  onChange={(e) => setForm({ ...form, receiptShowLogo: e.target.checked })}
                  className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                />
                <span className="text-xs font-medium text-slate-700">Tampilkan Logo di Struk</span>
              </label>
              <label className="flex items-center gap-2 px-3 py-2 border border-slate-300 rounded-lg cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.receiptShowQr ?? true}
                  onChange={(e) => setForm({ ...form, receiptShowQr: e.target.checked })}
                  className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                />
                <span className="text-xs font-medium text-slate-700">
                  Tampilkan QR Struk Digital
                </span>
              </label>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Catatan Header Struk (Opsional)
              </label>
              <input
                type="text"
                value={form.receiptHeaderNote ?? ''}
                onChange={(e) => setForm({ ...form, receiptHeaderNote: e.target.value })}
                placeholder="Contoh: Cabang Pusat · Buka 08.00 - 21.00"
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Catatan Bawah Struk
              </label>
              <textarea
                rows={2}
                value={form.receiptFooter}
                onChange={(e) => setForm({ ...form, receiptFooter: e.target.value })}
                className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
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
                disabled={saving}
                className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50"
              >
                {saving ? 'Menyimpan...' : 'Simpan Pengaturan Struk'}
              </button>
            </div>
          </form>
        )}

        {activeTab === 'payments' && (
          <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
            {methodError && (
              <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                {methodError}
              </div>
            )}

            <form
              onSubmit={handleCreateMethod}
              className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-3"
            >
              <p className="text-xs font-semibold text-slate-800">Tambah Metode Pembayaran Baru</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <input
                  type="text"
                  value={newMethodName}
                  onChange={(e) => setNewMethodName(e.target.value)}
                  placeholder="Contoh: OVO / GoPay / BCA"
                  required
                  className="w-full text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
                <select
                  value={newMethodType}
                  onChange={(e) => setNewMethodType(e.target.value as PaymentMethodType)}
                  className="w-full text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  <option value="OTHER">Lainnya / E-Wallet / Transfer</option>
                  <option value="DEBIT">Kartu Debit</option>
                  <option value="CREDIT">Kartu Kredit</option>
                  <option value="QRIS">QRIS</option>
                  <option value="CASH">Tunai</option>
                </select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newRequiresRef}
                    onChange={(e) => setNewRequiresRef(e.target.checked)}
                    className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                  />
                  Catat nomor referensi
                </label>
                <button
                  type="submit"
                  disabled={creatingMethod || !newMethodName.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {creatingMethod ? 'Menambah...' : 'Tambah Metode'}
                </button>
              </div>
            </form>

            <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
              {loadingMethods ? (
                <div className="py-6 text-center text-xs text-slate-500">
                  Memuat metode pembayaran...
                </div>
              ) : (
                paymentMethods.map((pm) => (
                  <div
                    key={pm.id}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-900">{pm.name}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {TYPE_LABELS[pm.type]} ·{' '}
                        {pm.requiresReference ? 'Dengan Referensi' : 'Tanpa Referensi'}
                        {pm.isSystem ? ' · Bawaan' : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={pm.id === 'pm-cash'}
                      onClick={() => handleToggleMethod(pm)}
                      className={`px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-colors whitespace-nowrap ${
                        pm.isActive
                          ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                          : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200'
                      } disabled:opacity-50`}
                    >
                      {pm.isActive ? 'Aktif' : 'Nonaktif'}
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Tutup
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
