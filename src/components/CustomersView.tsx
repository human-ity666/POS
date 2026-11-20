import { useMemo, useState, type FormEvent } from 'react';
import {
  Award,
  CheckCircle2,
  Edit3,
  Eye,
  Plus,
  ReceiptText,
  Search,
  UserCheck,
  UserPlus,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import type {
  Customer,
  CustomerDetailResponse,
  LoyaltySettings,
  StoreData,
  Transaction,
} from '../types';
import { apiFetch } from '../utils/api';
import { formatDateTime, formatRupiah } from '../utils/format';

interface CustomersViewProps {
  customers: Customer[];
  loyaltySettings: LoyaltySettings;
  canCreate: boolean;
  canEdit: boolean;
  onStoreUpdate: (store: StoreData) => void;
  onViewTransaction: (trx: Transaction) => void;
}

interface CustomerFormState {
  id?: string;
  name: string;
  membershipNumber: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  isActive: boolean;
}

const EMPTY_FORM: CustomerFormState = {
  name: '',
  membershipNumber: '',
  phone: '',
  email: '',
  address: '',
  notes: '',
  isActive: true,
};

export function CustomersView({
  customers,
  loyaltySettings,
  canCreate,
  canEdit,
  onStoreUpdate,
  onViewTransaction,
}: CustomersViewProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Create / Edit Modal
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<CustomerFormState>(EMPTY_FORM);
  const [savingForm, setSavingForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Customer Detail Modal
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailData, setDetailData] = useState<CustomerDetailResponse | null>(null);
  const [detailTab, setDetailTab] = useState<'transactions' | 'loyalty'>('transactions');
  const [detailError, setDetailError] = useState<string | null>(null);

  // Point Adjustment State inside Detail Modal
  const [pointDeltaInput, setPointDeltaInput] = useState('');
  const [pointReasonInput, setPointReasonInput] = useState('');
  const [adjustingPoints, setAdjustingPoints] = useState(false);

  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter((c) => {
      if (statusFilter === 'ACTIVE' && !c.isActive) return false;
      if (statusFilter === 'INACTIVE' && c.isActive) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.membershipNumber.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q)
      );
    });
  }, [customers, search, statusFilter]);

  const metrics = useMemo(() => {
    const activeCount = customers.filter((c) => c.isActive).length;
    const totalPoints = customers.reduce((s, c) => s + (c.loyaltyPoints ?? 0), 0);
    const totalSpending = customers.reduce((s, c) => s + (c.totalSpending ?? 0), 0);
    return {
      totalCustomers: customers.length,
      activeCount,
      totalPoints,
      totalSpending,
    };
  }, [customers]);

  const openCreateModal = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  };

  const openEditModal = (c: Customer) => {
    setForm({
      id: c.id,
      name: c.name,
      membershipNumber: c.membershipNumber,
      phone: c.phone,
      email: c.email,
      address: c.address,
      notes: c.notes,
      isActive: c.isActive,
    });
    setFormError(null);
    setFormOpen(true);
  };

  const openDetailModal = async (customerId: string) => {
    setDetailError(null);
    setDetailLoading(true);
    setDetailTab('transactions');
    setPointDeltaInput('');
    setPointReasonInput('');
    try {
      const res = await apiFetch<CustomerDetailResponse>(`/api/customers/${customerId}`);
      setDetailData(res);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal memuat detail pelanggan.',
      });
    } finally {
      setDetailLoading(false);
    }
  };

  const handleFormSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSavingForm(true);
    try {
      const isEdit = Boolean(form.id);
      const url = isEdit ? `/api/customers/${form.id}` : '/api/customers';
      const method = isEdit ? 'PUT' : 'POST';
      const res = await apiFetch<{ customer: Customer; store: StoreData }>(url, {
        method,
        body: JSON.stringify({
          name: form.name.trim(),
          membershipNumber: form.membershipNumber.trim() || undefined,
          phone: form.phone.trim(),
          email: form.email.trim(),
          address: form.address.trim(),
          notes: form.notes.trim(),
          isActive: form.isActive,
        }),
      });
      onStoreUpdate(res.store);
      setFormOpen(false);
      setBanner({
        type: 'success',
        text: isEdit
          ? `Data pelanggan "${res.customer.name}" berhasil diperbarui.`
          : `Pelanggan baru "${res.customer.name}" (${res.customer.membershipNumber}) ditambahkan.`,
      });
      if (detailData?.customer.id === res.customer.id) {
        await openDetailModal(res.customer.id);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Gagal menyimpan data pelanggan.');
    } finally {
      setSavingForm(false);
    }
  };

  const handleToggleStatus = async (c: Customer) => {
    setBanner(null);
    try {
      const res = await apiFetch<{ customer: Customer; store: StoreData }>(
        `/api/customers/${c.id}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({ isActive: !c.isActive }),
        }
      );
      onStoreUpdate(res.store);
      setBanner({
        type: 'success',
        text: `Status "${res.customer.name}" diubah menjadi ${res.customer.isActive ? 'Aktif' : 'Nonaktif'}.`,
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal mengubah status pelanggan.',
      });
    }
  };

  const handleAdjustPoints = async (e: FormEvent) => {
    e.preventDefault();
    if (!detailData) return;
    setDetailError(null);
    const delta = Math.trunc(Number(pointDeltaInput));
    if (!Number.isFinite(delta) || delta === 0) {
      setDetailError('Masukkan jumlah poin (+/-) yang valid dan tidak 0.');
      return;
    }
    setAdjustingPoints(true);
    try {
      const res = await apiFetch<{ customer: Customer; store: StoreData }>(
        `/api/customers/${detailData.customer.id}/loyalty/adjust`,
        {
          method: 'POST',
          body: JSON.stringify({
            pointsDelta: delta,
            notes: pointReasonInput.trim(),
          }),
        }
      );
      onStoreUpdate(res.store);
      setPointDeltaInput('');
      setPointReasonInput('');
      await openDetailModal(detailData.customer.id);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Gagal menyesuaikan poin loyalitas.');
    } finally {
      setAdjustingPoints(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* KPI Overview */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Total Pelanggan</span>
            <Users className="w-4 h-4 text-slate-400" />
          </div>
          <p className="font-mono text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {metrics.totalCustomers}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Transaksi tamu tetap didukung di kasir</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Member Aktif</span>
            <UserCheck className="w-4 h-4 text-emerald-600" />
          </div>
          <p className="font-mono text-2xl font-bold text-emerald-700 mt-1 tabular-nums">
            {metrics.activeCount}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Siap ditautkan saat checkout</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Poin Loyalitas Beredar</span>
            <Award className="w-4 h-4 text-teal-700" />
          </div>
          <p className="font-mono text-2xl font-bold text-teal-800 mt-1 tabular-nums">
            {metrics.totalPoints.toLocaleString('id-ID')}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            {loyaltySettings.enabled
              ? `1 poin / ${formatRupiah(loyaltySettings.pointsPerAmount)} · Nilai ${formatRupiah(loyaltySettings.pointValueRp)}`
              : 'Program poin sedang nonaktif'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Total Belanja Member</span>
            <ReceiptText className="w-4 h-4 text-slate-400" />
          </div>
          <p className="font-mono text-xl sm:text-2xl font-bold text-slate-900 mt-1 tabular-nums truncate">
            {formatRupiah(metrics.totalSpending)}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Akumulasi transaksi selesai</p>
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

      {/* Search, Filter & Action Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 flex-1">
            <div className="relative flex-1 min-w-[220px] max-w-md">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari nama, kode, no. member, telepon, email..."
                className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(['ALL', 'ACTIVE', 'INACTIVE'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                    statusFilter === st
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st === 'ALL' ? 'Semua' : st === 'ACTIVE' ? 'Aktif' : 'Nonaktif'}
                </button>
              ))}
            </div>
          </div>

          {canCreate && (
            <button
              type="button"
              onClick={openCreateModal}
              className="min-h-[40px] inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <UserPlus className="w-4 h-4" />
              Tambah Pelanggan
            </button>
          )}
        </div>

        {/* Customer Table */}
        <div className="overflow-x-auto border border-slate-200 rounded-xl">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                <th className="py-2.5 px-3">ID & No. Member</th>
                <th className="py-2.5 px-3">Nama & Kontak</th>
                <th className="py-2.5 px-3 text-right">Total Belanja</th>
                <th className="py-2.5 px-3 text-right">Poin Loyalitas</th>
                <th className="py-2.5 px-3">Pembelian Terakhir</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredCustomers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    Tidak ada pelanggan yang cocok dengan pencarian atau filter saat ini.
                  </td>
                </tr>
              ) : (
                filteredCustomers.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-2.5 px-3 align-top">
                      <p className="font-mono font-semibold text-slate-900">{c.membershipNumber || '—'}</p>
                      <p className="font-mono text-[11px] text-slate-500">{c.code}</p>
                    </td>
                    <td className="py-2.5 px-3 align-top">
                      <p className="font-semibold text-slate-900">{c.name}</p>
                      <p className="text-[11px] text-slate-500">
                        {c.phone || 'Tanpa telepon'}
                        {c.email ? ` · ${c.email}` : ''}
                      </p>
                    </td>
                    <td className="py-2.5 px-3 text-right align-top font-mono tabular-nums">
                      <p className="font-semibold text-slate-900">{formatRupiah(c.totalSpending)}</p>
                      <p className="text-[11px] text-slate-500">{c.transactionCount} transaksi</p>
                    </td>
                    <td className="py-2.5 px-3 text-right align-top font-mono tabular-nums">
                      <p className="font-bold text-teal-800">
                        {c.loyaltyPoints.toLocaleString('id-ID')} poin
                      </p>
                      <p className="text-[10px] text-slate-500">
                        +{c.totalPointsEarned.toLocaleString('id-ID')} / -{c.totalPointsRedeemed.toLocaleString('id-ID')}
                      </p>
                    </td>
                    <td className="py-2.5 px-3 align-top font-mono text-[11px] text-slate-600 tabular-nums">
                      {c.lastPurchaseDate ? formatDateTime(c.lastPurchaseDate) : 'Belum pernah'}
                    </td>
                    <td className="py-2.5 px-3 align-top">
                      <span
                        className={`font-semibold whitespace-nowrap ${
                          c.isActive ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      >
                        · {c.isActive ? 'Aktif' : 'Nonaktif'}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right align-top">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void openDetailModal(c.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100"
                        >
                          <Eye className="w-3 h-3" />
                          Detail
                        </button>
                        {canEdit && (
                          <>
                            <button
                              type="button"
                              onClick={() => openEditModal(c)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                            >
                              <Edit3 className="w-3 h-3" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleToggleStatus(c)}
                              className={`px-2 py-1.5 text-[11px] font-semibold rounded-md border ${
                                c.isActive
                                  ? 'text-rose-700 bg-white border-slate-300 hover:bg-rose-50'
                                  : 'text-emerald-700 bg-white border-slate-300 hover:bg-emerald-50'
                              }`}
                              title={c.isActive ? 'Nonaktifkan pelanggan' : 'Aktifkan pelanggan'}
                            >
                              {c.isActive ? (
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
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit Customer Modal */}
      {formOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={form.id ? 'Edit Pelanggan' : 'Tambah Pelanggan'}
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg overflow-hidden shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900">
                {form.id ? 'Edit Data Pelanggan' : 'Tambah Pelanggan Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="p-5 space-y-3.5">
              {formError && (
                <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nama Pelanggan *
                  </label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Contoh: Budi Santoso"
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    No. Keanggotaan (Opsional)
                  </label>
                  <input
                    type="text"
                    value={form.membershipNumber}
                    onChange={(e) => setForm({ ...form, membershipNumber: e.target.value.toUpperCase() })}
                    placeholder="Otomatis (MBR-XXXX)"
                    className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">No. Telepon</label>
                  <input
                    type="text"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="0812-xxxx-xxxx"
                    className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="nama@email.com"
                    className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Alamat (Opsional)
                </label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="Alamat pengiriman atau domisili"
                  className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Catatan</label>
                <textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Preferensi pelanggan, segmen grosir, dll."
                  className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                />
                Status Pelanggan Aktif
              </label>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingForm}
                  className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
                >
                  {savingForm ? 'Menyimpan...' : form.id ? 'Simpan Perubahan' : 'Simpan Pelanggan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Customer Detail Modal */}
      {(detailData || detailLoading) && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Detail Pelanggan"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl overflow-hidden shadow-xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {detailData ? detailData.customer.name : 'Memuat Detail Pelanggan...'}
                </h3>
                {detailData && (
                  <p className="font-mono text-xs text-slate-500 mt-0.5">
                    {detailData.customer.code} · Member {detailData.customer.membershipNumber}
                    {detailData.customer.phone ? ` · ${detailData.customer.phone}` : ''}
                    {detailData.customer.email ? ` · ${detailData.customer.email}` : ''}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setDetailData(null);
                  setDetailLoading(false);
                }}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {detailLoading && !detailData ? (
              <div className="p-10 text-center text-xs text-slate-500">
                Memuat profil, riwayat transaksi, dan mutasi poin...
              </div>
            ) : detailData ? (
              <div className="p-5 overflow-y-auto space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <p className="text-slate-500">Total Belanja</p>
                    <p className="font-mono text-base font-bold text-slate-900 mt-0.5 tabular-nums">
                      {formatRupiah(detailData.customer.totalSpending)}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {detailData.customer.transactionCount} transaksi selesai
                    </p>
                  </div>
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <p className="text-slate-500">Pembelian Terakhir</p>
                    <p className="font-mono text-xs font-semibold text-slate-900 mt-1 tabular-nums">
                      {detailData.customer.lastPurchaseDate
                        ? formatDateTime(detailData.customer.lastPurchaseDate)
                        : 'Belum ada transaksi'}
                    </p>
                  </div>
                  <div className="p-3 bg-teal-50 border border-teal-200 rounded-lg">
                    <p className="text-teal-800">Saldo Poin Loyalitas</p>
                    <p className="font-mono text-lg font-bold text-teal-900 mt-0.5 tabular-nums">
                      {detailData.customer.loyaltyPoints.toLocaleString('id-ID')} poin
                    </p>
                    <p className="text-[11px] text-teal-700">
                      Setara {formatRupiah(detailData.customer.loyaltyPoints * loyaltySettings.pointValueRp)}
                    </p>
                  </div>
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <p className="text-slate-500">Akumulasi Poin</p>
                    <p className="font-mono text-xs font-semibold text-slate-800 mt-1 tabular-nums">
                      Didapat: +{detailData.customer.totalPointsEarned.toLocaleString('id-ID')}
                    </p>
                    <p className="font-mono text-xs font-semibold text-rose-700 tabular-nums">
                      Ditukar: -{detailData.customer.totalPointsRedeemed.toLocaleString('id-ID')}
                    </p>
                  </div>
                </div>

                {(detailData.customer.address || detailData.customer.notes) && (
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1">
                    {detailData.customer.address && (
                      <p className="text-slate-700">
                        <span className="font-semibold">Alamat:</span> {detailData.customer.address}
                      </p>
                    )}
                    {detailData.customer.notes && (
                      <p className="text-slate-700">
                        <span className="font-semibold">Catatan:</span> {detailData.customer.notes}
                      </p>
                    )}
                  </div>
                )}

                {canEdit && (
                  <form
                    onSubmit={handleAdjustPoints}
                    className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl flex flex-col sm:flex-row sm:items-end gap-2.5"
                  >
                    <div className="w-full sm:w-40">
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Koreksi Poin (+/-)
                      </label>
                      <input
                        type="number"
                        value={pointDeltaInput}
                        onChange={(e) => setPointDeltaInput(e.target.value)}
                        placeholder="Contoh: 50 atau -10"
                        className="w-full font-mono text-xs px-2.5 py-2 bg-white border border-slate-300 rounded-lg tabular-nums"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Alasan Penyesuaian Poin
                      </label>
                      <input
                        type="text"
                        value={pointReasonInput}
                        onChange={(e) => setPointReasonInput(e.target.value)}
                        placeholder="Contoh: Bonus member ulang tahun / koreksi input"
                        className="w-full text-xs px-2.5 py-2 bg-white border border-slate-300 rounded-lg"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={adjustingPoints}
                      className="min-h-[36px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg disabled:opacity-50 whitespace-nowrap"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      {adjustingPoints ? 'Memproses...' : 'Sesuaikan Poin'}
                    </button>
                  </form>
                )}

                {detailError && (
                  <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                    {detailError}
                  </div>
                )}

                {/* History Tabs */}
                <div className="flex border-b border-slate-200 gap-5">
                  <button
                    type="button"
                    onClick={() => setDetailTab('transactions')}
                    className={`py-2 text-xs font-semibold border-b-2 transition-colors ${
                      detailTab === 'transactions'
                        ? 'border-teal-700 text-teal-800'
                        : 'border-transparent text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    Riwayat Transaksi ({detailData.transactions.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setDetailTab('loyalty')}
                    className={`py-2 text-xs font-semibold border-b-2 transition-colors ${
                      detailTab === 'loyalty'
                        ? 'border-teal-700 text-teal-800'
                        : 'border-transparent text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    Mutasi Poin Loyalitas ({detailData.loyaltyHistory.length})
                  </button>
                </div>

                {detailTab === 'transactions' ? (
                  <div className="overflow-x-auto border border-slate-200 rounded-xl">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                          <th className="py-2 px-3">No. Invoice</th>
                          <th className="py-2 px-3">Tanggal</th>
                          <th className="py-2 px-3">Status</th>
                          <th className="py-2 px-3">Pembayaran</th>
                          <th className="py-2 px-3 text-right">Total</th>
                          <th className="py-2 px-3 text-right">Poin</th>
                          <th className="py-2 px-3 text-right">Aksi</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 tabular-nums">
                        {detailData.transactions.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="py-8 text-center text-slate-500">
                              Pelanggan ini belum memiliki riwayat transaksi.
                            </td>
                          </tr>
                        ) : (
                          detailData.transactions.map((trx) => (
                            <tr key={trx.id} className="hover:bg-slate-50/70">
                              <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                                {trx.invoiceNumber}
                              </td>
                              <td className="py-2 px-3 font-mono text-[11px] text-slate-600">
                                {formatDateTime(trx.completedAt || trx.createdAt)}
                              </td>
                              <td className="py-2 px-3 font-semibold text-slate-700">{trx.status}</td>
                              <td className="py-2 px-3 text-slate-700">{trx.paymentMethod}</td>
                              <td className="py-2 px-3 text-right font-mono font-semibold text-slate-900">
                                {formatRupiah(trx.total)}
                              </td>
                              <td className="py-2 px-3 text-right font-mono text-[11px]">
                                {(trx.loyaltyPointsEarned ?? 0) > 0 && (
                                  <span className="text-emerald-700">+{trx.loyaltyPointsEarned}</span>
                                )}
                                {(trx.loyaltyPointsRedeemed ?? 0) > 0 && (
                                  <span className="text-rose-700 ml-1">
                                    -{trx.loyaltyPointsRedeemed}
                                  </span>
                                )}
                                {(trx.loyaltyPointsEarned ?? 0) === 0 &&
                                  (trx.loyaltyPointsRedeemed ?? 0) === 0 &&
                                  '—'}
                              </td>
                              <td className="py-2 px-3 text-right">
                                <button
                                  type="button"
                                  onClick={() => onViewTransaction(trx)}
                                  className="px-2.5 py-1 text-[11px] font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100"
                                >
                                  Buka
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-slate-200 rounded-xl">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                          <th className="py-2 px-3">Tanggal</th>
                          <th className="py-2 px-3">Tipe</th>
                          <th className="py-2 px-3 text-right">Perubahan</th>
                          <th className="py-2 px-3 text-right">Saldo</th>
                          <th className="py-2 px-3">Referensi & Keterangan</th>
                          <th className="py-2 px-3">Oleh</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 tabular-nums">
                        {detailData.loyaltyHistory.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="py-8 text-center text-slate-500">
                              Belum ada catatan mutasi poin loyalitas.
                            </td>
                          </tr>
                        ) : (
                          detailData.loyaltyHistory.map((h) => (
                            <tr key={h.id}>
                              <td className="py-2 px-3 font-mono text-[11px] text-slate-600">
                                {formatDateTime(h.createdAt)}
                              </td>
                              <td className="py-2 px-3 font-semibold text-slate-800">{h.type}</td>
                              <td
                                className={`py-2 px-3 text-right font-mono font-bold ${
                                  h.pointsDelta > 0 ? 'text-emerald-700' : 'text-rose-700'
                                }`}
                              >
                                {h.pointsDelta > 0 ? `+${h.pointsDelta}` : h.pointsDelta}
                              </td>
                              <td className="py-2 px-3 text-right font-mono text-slate-700">
                                {h.pointsBefore} → <strong>{h.pointsAfter}</strong>
                              </td>
                              <td className="py-2 px-3 text-slate-700">
                                <span className="font-mono text-[11px] text-slate-500 mr-1.5">
                                  {h.referenceNumber}
                                </span>
                                {h.notes}
                              </td>
                              <td className="py-2 px-3 text-slate-600">{h.actorName}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-200 bg-white">
              {detailData && canEdit && (
                <button
                  type="button"
                  onClick={() => openEditModal(detailData.customer)}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Edit Profil Pelanggan
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setDetailData(null);
                  setDetailLoading(false);
                }}
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
