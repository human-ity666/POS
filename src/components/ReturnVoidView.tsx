import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ClipboardList,
  Download,
  FileSearch,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Wallet,
} from 'lucide-react';
import type {
  PaymentMethodConfig,
  RefundRecord,
  ReturnEligibilityDetail,
  ReturnStockDisposition,
  ReturnVoidSummaryStats,
  StoreData,
  Transaction,
  TransactionReturn,
  TransactionReturnItem,
  TransactionVoidRecord,
  UserSummary,
} from '../types';
import { apiFetch } from '../utils/api';
import { downloadCSV, formatDateTime, formatRupiah } from '../utils/format';
import {
  InspectionResolveModal,
  RefundStatusUpdateModal,
  ReturnCreateModal,
  VoidTransactionModal,
} from './ReturnVoidModals';

interface ReturnVoidViewProps {
  currentUser: UserSummary;
  paymentMethods: PaymentMethodConfig[];
  initialTransactionId?: string | null;
  onClearInitialTransaction?: () => void;
  onStoreUpdate: (store: StoreData) => void;
  onViewReceipt: (trx: Transaction) => void;
  onRequestRefundPin: (opts: { title: string; description: string }) => Promise<string>;
  onRequestVoidPin: (opts: { title: string; description: string }) => Promise<string>;
}

interface SearchResultRow {
  transaction: Transaction;
  receiptNumber: string;
  canReturn: boolean;
  canVoid: boolean;
}

function dispositionBadgeLabel(item: TransactionReturnItem): { label: string; cls: string } {
  const active = item.finalDisposition ?? item.stockDisposition;
  switch (active) {
    case 'SELLABLE':
      return {
        label: item.finalDisposition ? 'QC: Layak Jual (Restok)' : 'Layak Jual (Restok)',
        cls: 'text-emerald-700',
      };
    case 'DAMAGED':
      return {
        label: item.finalDisposition ? 'QC: Barang Rusak' : 'Barang Rusak',
        cls: 'text-rose-700',
      };
    case 'UNSELLABLE':
      return {
        label: item.finalDisposition ? 'QC: Tidak Layak Jual' : 'Tidak Layak Jual',
        cls: 'text-slate-700',
      };
    case 'PENDING_INSPECTION':
      return { label: 'Menunggu Inspeksi QC', cls: 'text-amber-700' };
  }
}

export function ReturnVoidView({
  currentUser,
  paymentMethods,
  initialTransactionId,
  onClearInitialTransaction,
  onStoreUpdate,
  onViewReceipt,
  onRequestRefundPin,
  onRequestVoidPin,
}: ReturnVoidViewProps) {
  const [subTab, setSubTab] = useState<'lookup' | 'returns' | 'refunds' | 'voids'>('lookup');
  const [summary, setSummary] = useState<ReturnVoidSummaryStats>({
    totalReturns: 0,
    totalVoided: 0,
    totalRefundAmount: 0,
    cashRefundTotal: 0,
    nonCashRefundTotal: 0,
    pendingInspectionCount: 0,
    pendingRefundCount: 0,
  });

  // Lookup state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedEligibility, setSelectedEligibility] = useState<ReturnEligibilityDetail | null>(
    null
  );
  const [loadingDetail, setLoadingDetail] = useState(false);

  // History lists
  const [returnsList, setReturnsList] = useState<TransactionReturn[]>([]);
  const [returnSearch, setReturnSearch] = useState('');
  const [returnStatusFilter, setReturnStatusFilter] = useState('ALL');
  const [returnDispFilter, setReturnDispFilter] = useState<'ALL' | ReturnStockDisposition>('ALL');

  const [refundsList, setRefundsList] = useState<RefundRecord[]>([]);
  const [refundSearch, setRefundSearch] = useState('');
  const [refundStatusFilter, setRefundStatusFilter] = useState('ALL');
  const [refundTypeFilter, setRefundTypeFilter] = useState('ALL');
  const [refundSourceFilter, setRefundSourceFilter] = useState('ALL');

  const [voidsList, setVoidsList] = useState<TransactionVoidRecord[]>([]);
  const [voidSearch, setVoidSearch] = useState('');

  // Feedback & Modals
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [returnModalOpen, setReturnModalOpen] = useState(false);
  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [inspectingItem, setInspectingItem] = useState<TransactionReturnItem | null>(null);
  const [updatingRefund, setUpdatingRefund] = useState<RefundRecord | null>(null);

  const canProcessReturn = currentUser.permissions.includes('pos:refund');
  const canProcessVoid = currentUser.permissions.includes('pos:void');
  const canResolveInspection =
    canProcessReturn || currentUser.permissions.includes('stock:adjust');
  const canManageRefundStatus = canProcessReturn;

  const loadSummary = useCallback(async () => {
    try {
      const res = await apiFetch<{ summary: ReturnVoidSummaryStats }>('/api/returns-voids/summary');
      setSummary(res.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat ringkasan retur & void.');
    }
  }, []);

  const loadSearch = useCallback(async (q: string) => {
    setSearching(true);
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set('search', q.trim());
      qs.set('limit', '40');
      const res = await apiFetch<{ results: SearchResultRow[] }>(
        `/api/returns-voids/search?${qs.toString()}`
      );
      setSearchResults(res.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mencari transaksi asli.');
    } finally {
      setSearching(false);
    }
  }, []);

  const loadEligibility = useCallback(async (trxId: string) => {
    setLoadingDetail(true);
    setError(null);
    try {
      const res = await apiFetch<{ eligibility: ReturnEligibilityDetail }>(
        `/api/transactions/${encodeURIComponent(trxId)}/return-eligibility`
      );
      setSelectedEligibility(res.eligibility);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat kelayakan retur transaksi.');
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const loadReturns = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (returnSearch.trim()) qs.set('search', returnSearch.trim());
      if (returnStatusFilter !== 'ALL') qs.set('status', returnStatusFilter);
      if (returnDispFilter !== 'ALL') qs.set('disposition', returnDispFilter);
      const res = await apiFetch<{ returns: TransactionReturn[] }>(
        `/api/returns?${qs.toString()}`
      );
      setReturnsList(res.returns);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat daftar retur.');
    }
  }, [returnSearch, returnStatusFilter, returnDispFilter]);

  const loadRefunds = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (refundSearch.trim()) qs.set('search', refundSearch.trim());
      if (refundStatusFilter !== 'ALL') qs.set('status', refundStatusFilter);
      if (refundTypeFilter !== 'ALL') qs.set('paymentType', refundTypeFilter);
      if (refundSourceFilter !== 'ALL') qs.set('sourceType', refundSourceFilter);
      const res = await apiFetch<{ refunds: RefundRecord[] }>(`/api/refunds?${qs.toString()}`);
      setRefundsList(res.refunds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat riwayat refund.');
    }
  }, [refundSearch, refundStatusFilter, refundTypeFilter, refundSourceFilter]);

  const loadVoids = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (voidSearch.trim()) qs.set('search', voidSearch.trim());
      const res = await apiFetch<{ voids: TransactionVoidRecord[] }>(
        `/api/voids?${qs.toString()}`
      );
      setVoidsList(res.voids);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat riwayat void.');
    }
  }, [voidSearch]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadSummary(), loadSearch(searchQuery), loadReturns(), loadRefunds(), loadVoids()]);
    if (selectedEligibility?.transaction.id) {
      await loadEligibility(selectedEligibility.transaction.id);
    }
  }, [
    loadSummary,
    loadSearch,
    searchQuery,
    loadReturns,
    loadRefunds,
    loadVoids,
    selectedEligibility?.transaction.id,
    loadEligibility,
  ]);

  useEffect(() => {
    void loadSummary();
    void loadSearch('');
  }, [loadSummary, loadSearch]);

  useEffect(() => {
    if (subTab === 'returns') void loadReturns();
    if (subTab === 'refunds') void loadRefunds();
    if (subTab === 'voids') void loadVoids();
  }, [subTab, loadReturns, loadRefunds, loadVoids]);

  useEffect(() => {
    if (initialTransactionId) {
      setSubTab('lookup');
      void loadEligibility(initialTransactionId);
      onClearInitialTransaction?.();
    }
  }, [initialTransactionId, loadEligibility, onClearInitialTransaction]);

  const handleExportRefundsCsv = () => {
    const today = new Date().toISOString().slice(0, 10);
    downloadCSV(
      `riwayat-refund-${today}.csv`,
      ['No. Refund', 'Sumber', 'No. Dokumen', 'Invoice', 'Metode', 'Tipe', 'Nominal', 'Referensi', 'Status', 'Petugas', 'Waktu'],
      refundsList.map((r) => [
        r.refundNumber,
        r.sourceType,
        r.sourceNumber,
        r.invoiceNumber,
        r.refundMethod,
        r.paymentType,
        r.amount,
        r.referenceNumber || '-',
        r.status,
        r.actorName,
        formatDateTime(r.createdAt),
      ])
    );
  };

  return (
    <div className="space-y-5">
      {error && (
        <div className="p-3.5 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-xl flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-rose-700 font-semibold hover:underline"
          >
            Tutup
          </button>
        </div>
      )}

      {notice && (
        <div className="p-3.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            {notice}
          </span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-emerald-700 font-semibold hover:underline"
          >
            Tutup
          </button>
        </div>
      )}

      {(!canProcessReturn || !canProcessVoid) && (
        <div className="p-3.5 text-xs font-medium text-amber-900 bg-amber-50 border border-amber-200 rounded-xl">
          Mode Lihat Saja: Tombol aksi{' '}
          {!canProcessReturn && !canProcessVoid
            ? 'Retur, QC, & Void'
            : !canProcessReturn
            ? 'Retur & Refund'
            : 'Void Transaksi'}{' '}
          dinonaktifkan karena akun Anda tidak memiliki izin pada Role &amp; Hak Akses.
        </div>
      )}

      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Total Dokumen Retur</p>
          <p className="font-mono text-xl font-bold text-slate-900 tabular-nums mt-1">
            {summary.totalReturns}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Retur parsial & penuh tercatat
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Total Nilai Refund</p>
          <p className="font-mono text-xl font-bold text-teal-800 tabular-nums mt-1">
            {formatRupiah(summary.totalRefundAmount)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            Tunai {formatRupiah(summary.cashRefundTotal)} · Non-tunai{' '}
            {formatRupiah(summary.nonCashRefundTotal)}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Menunggu Inspeksi QC</p>
          <p
            className={`font-mono text-xl font-bold tabular-nums mt-1 ${
              summary.pendingInspectionCount > 0 ? 'text-amber-700' : 'text-emerald-700'
            }`}
          >
            {summary.pendingInspectionCount} Item
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {summary.pendingRefundCount} refund status pending
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Transaksi Di-Void</p>
          <p className="font-mono text-xl font-bold text-rose-700 tabular-nums mt-1">
            {summary.totalVoided}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Arsip struk historis tetap terjaga
          </p>
        </div>
      </div>

      {/* Sub-navigation */}
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          <button
            type="button"
            onClick={() => setSubTab('lookup')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              subTab === 'lookup' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            <FileSearch className="w-3.5 h-3.5" />
            Cari & Proses Retur / Void
          </button>
          <button
            type="button"
            onClick={() => setSubTab('returns')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              subTab === 'returns' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Riwayat Retur & QC ({summary.totalReturns})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('refunds')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              subTab === 'refunds' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            <Wallet className="w-3.5 h-3.5" />
            Buku Refund
          </button>
          <button
            type="button"
            onClick={() => setSubTab('voids')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              subTab === 'voids' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            Riwayat Void ({summary.totalVoided})
          </button>
        </div>

        <button
          type="button"
          onClick={() => void refreshAll()}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Segarkan
        </button>
      </div>

      {/* TAB 1: LOOKUP & PROCESS */}
      {subTab === 'lookup' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Left Search Column */}
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 space-y-2.5">
              <p className="text-xs font-semibold text-slate-900">
                Cari Struk Asli / Nomor Transaksi
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadSearch(searchQuery);
                }}
                className="flex items-center gap-2"
              >
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="No. Invoice, No. Struk, Pelanggan, Produk..."
                    className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <button
                  type="submit"
                  disabled={searching}
                  className="px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg shrink-0"
                >
                  {searching ? '...' : 'Cari'}
                </button>
              </form>
            </div>

            <div className="divide-y divide-slate-100 max-h-[540px] overflow-y-auto">
              {searchResults.length === 0 ? (
                <div className="py-10 px-4 text-center text-xs text-slate-500">
                  Tidak ditemukan transaksi selesai atau di-void yang cocok.
                </div>
              ) : (
                searchResults.map((row) => {
                  const isSelected = selectedEligibility?.transaction.id === row.transaction.id;
                  return (
                    <button
                      key={row.transaction.id}
                      type="button"
                      onClick={() => void loadEligibility(row.transaction.id)}
                      className={`w-full text-left p-3.5 transition-colors flex items-start justify-between gap-3 ${
                        isSelected ? 'bg-teal-50/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-bold text-slate-900 truncate">
                          {row.transaction.invoiceNumber}
                        </p>
                        <p className="font-mono text-[11px] text-slate-500 truncate">
                          Struk: {row.receiptNumber}
                        </p>
                        <p className="text-[11px] text-slate-600 mt-1 truncate">
                          {row.transaction.customerName} · Kasir: {row.transaction.cashierName}
                        </p>
                        <p className="font-mono text-[10px] text-slate-400 mt-0.5 tabular-nums">
                          {formatDateTime(
                            row.transaction.completedAt || row.transaction.createdAt
                          )}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-mono text-xs font-bold text-slate-900 tabular-nums">
                          {formatRupiah(row.transaction.total)}
                        </p>
                        <p
                          className={`text-[10px] font-bold mt-1 ${
                            row.transaction.status === 'VOIDED'
                              ? 'text-rose-700'
                              : row.transaction.returnStatus === 'FULL'
                              ? 'text-amber-700'
                              : row.transaction.returnStatus === 'PARTIAL'
                              ? 'text-sky-700'
                              : 'text-emerald-700'
                          }`}
                        >
                          {row.transaction.status === 'VOIDED'
                            ? 'DI-VOID'
                            : row.transaction.returnStatus === 'FULL'
                            ? 'RETUR PENUH'
                            : row.transaction.returnStatus === 'PARTIAL'
                            ? 'RETUR SEBAGIAN'
                            : 'SELESAI'}
                        </p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Inspection & Action Column */}
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
            {loadingDetail ? (
              <div className="py-16 text-center text-xs text-slate-500">
                Memuat detail transaksi & kelayakan retur...
              </div>
            ) : !selectedEligibility ? (
              <div className="py-16 px-6 text-center space-y-2">
                <ClipboardList className="w-8 h-8 text-slate-300 mx-auto" />
                <p className="text-sm font-semibold text-slate-800">
                  Pilih Transaksi dari Daftar Sebelah Kiri
                </p>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  Cari berdasarkan nomor invoice, nomor struk, nama pelanggan, atau nama produk
                  untuk melihat rincian historis, memproses retur sebagian/penuh, atau melakukan void
                  transaksi.
                </p>
              </div>
            ) : (
              <div className="p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-200">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-mono text-base font-bold text-slate-900">
                        {selectedEligibility.transaction.invoiceNumber}
                      </h3>
                      <span
                        className={`text-xs font-bold ${
                          selectedEligibility.transaction.status === 'VOIDED'
                            ? 'text-rose-700'
                            : 'text-emerald-700'
                        }`}
                      >
                        · {selectedEligibility.transaction.status}
                      </span>
                    </div>
                    <p className="font-mono text-[11px] text-slate-500 mt-0.5 tabular-nums">
                      No. Struk: {selectedEligibility.receiptNumber} ·{' '}
                      {formatDateTime(
                        selectedEligibility.transaction.completedAt ||
                          selectedEligibility.transaction.createdAt
                      )}
                    </p>
                    <p className="text-xs text-slate-600 mt-1">
                      Pelanggan: <span className="font-medium">{selectedEligibility.transaction.customerName}</span> ·
                      Kasir: <span className="font-medium">{selectedEligibility.transaction.cashierName}</span> ·
                      Bayar: <span className="font-medium">{selectedEligibility.transaction.paymentMethod}</span>
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onViewReceipt(selectedEligibility.transaction)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      Lihat Struk
                    </button>
                    <button
                      type="button"
                      disabled={!canProcessReturn || !selectedEligibility.canReturn}
                      onClick={() => setReturnModalOpen(true)}
                      title={
                        !canProcessReturn
                          ? 'Akun Anda tidak memiliki hak akses Proses Retur & Refund (pos:refund).'
                          : selectedEligibility.canReturnReason
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Proses Retur
                    </button>
                    <button
                      type="button"
                      disabled={!canProcessVoid || !selectedEligibility.canVoid}
                      onClick={() => setVoidModalOpen(true)}
                      title={
                        !canProcessVoid
                          ? 'Akun Anda tidak memiliki hak akses Void Transaksi (pos:void).'
                          : selectedEligibility.canVoidReason
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-rose-700 hover:bg-rose-800 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ShieldAlert className="w-3.5 h-3.5" />
                      Void Transaksi
                    </button>
                  </div>
                </div>

                {/* Status warnings */}
                {selectedEligibility.voidRecord && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-900 space-y-0.5">
                    <p className="font-semibold">
                      Transaksi Ini Sudah Di-Void ({selectedEligibility.voidRecord.voidNumber})
                    </p>
                    <p className="text-rose-800">
                      Alasan: {selectedEligibility.voidRecord.reason} · Disetujui oleh:{' '}
                      {selectedEligibility.voidRecord.approvedByName} pada{' '}
                      {formatDateTime(selectedEligibility.voidRecord.createdAt)}
                    </p>
                  </div>
                )}

                {!selectedEligibility.canVoid &&
                  selectedEligibility.canVoidReason &&
                  !selectedEligibility.voidRecord && (
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
                      {selectedEligibility.canVoidReason}
                    </div>
                  )}

                {/* KPI Mini Row */}
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <p className="text-slate-500">Total Asli</p>
                    <p className="font-mono font-bold text-slate-900 mt-0.5 tabular-nums">
                      {formatRupiah(selectedEligibility.transaction.total)}
                    </p>
                  </div>
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <p className="text-slate-500">Sudah Di-Refund</p>
                    <p className="font-mono font-bold text-rose-700 mt-0.5 tabular-nums">
                      {formatRupiah(selectedEligibility.transaction.refundedTotal ?? 0)}
                    </p>
                  </div>
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <p className="text-slate-500">Sisa Dapat Di-Refund</p>
                    <p className="font-mono font-bold text-teal-800 mt-0.5 tabular-nums">
                      {formatRupiah(selectedEligibility.remainingRefundableTotal)}
                    </p>
                  </div>
                </div>

                {/* Frozen Historical Items */}
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                    <p className="text-xs font-semibold text-slate-800">
                      Rincian Item Historis & Sisa Kuota Retur
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                          <th className="py-2 px-3">Produk</th>
                          <th className="py-2 px-3 text-right">Harga Beli Pelanggan</th>
                          <th className="py-2 px-3 text-right">Qty Beli</th>
                          <th className="py-2 px-3 text-right">Diretur</th>
                          <th className="py-2 px-3 text-right">Sisa</th>
                          <th className="py-2 px-3 text-right">Nilai Sisa</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 tabular-nums">
                        {selectedEligibility.items.map((item) => (
                          <tr key={item.transactionItemId}>
                            <td className="py-2 px-3">
                              <p className="font-semibold text-slate-900">{item.name}</p>
                              <p className="font-mono text-[10px] text-slate-500">
                                {item.sku ? `${item.sku} · ` : ''}
                                {item.barcode}
                              </p>
                            </td>
                            <td className="py-2 px-3 text-right font-mono">
                              {formatRupiah(item.unitPrice)}
                            </td>
                            <td className="py-2 px-3 text-right font-mono">{item.originalQty}</td>
                            <td className="py-2 px-3 text-right font-mono text-rose-700">
                              {item.returnedQty}
                            </td>
                            <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                              {item.remainingQty}
                            </td>
                            <td className="py-2 px-3 text-right font-mono font-semibold">
                              {formatRupiah(item.remainingRefundableAmount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Existing returns on this transaction */}
                {selectedEligibility.existingReturns.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-slate-800">
                      Riwayat Retur untuk Transaksi Ini
                    </p>
                    <div className="space-y-2">
                      {selectedEligibility.existingReturns.map((ret) => (
                        <div
                          key={ret.id}
                          className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono font-bold text-slate-900">
                              {ret.returnNumber} · {ret.returnType}
                            </span>
                            <span className="font-mono font-bold text-teal-800 tabular-nums">
                              Refund {formatRupiah(ret.totalRefundAmount)} ({ret.refundStatus})
                            </span>
                          </div>
                          <p className="text-slate-600">
                            Alasan: {ret.reason} · Diproses: {ret.requestedByName} · Disetujui:{' '}
                            {ret.approvedByName}
                          </p>
                          <div className="space-y-1 pt-1 border-t border-slate-200">
                            {ret.items.map((ri) => {
                              const disp = dispositionBadgeLabel(ri);
                              return (
                                <div
                                  key={ri.id}
                                  className="flex flex-wrap items-center justify-between gap-2 text-[11px]"
                                >
                                  <span>
                                    {ri.productName} ({ri.qty} {ri.unit}) ·{' '}
                                    <span className={`font-semibold ${disp.cls}`}>{disp.label}</span>
                                  </span>
                                  {ri.stockDisposition === 'PENDING_INSPECTION' &&
                                    !ri.finalDisposition && (
                                      <button
                                        type="button"
                                        disabled={!canResolveInspection}
                                        title={
                                          !canResolveInspection
                                            ? 'Akun Anda tidak memiliki hak akses menyelesaikan inspeksi QC.'
                                            : undefined
                                        }
                                        onClick={() => setInspectingItem(ri)}
                                        className="px-2 py-0.5 text-[11px] font-semibold text-amber-800 bg-amber-100 hover:bg-amber-200 disabled:opacity-40 disabled:cursor-not-allowed rounded"
                                      >
                                        Selesaikan Inspeksi QC
                                      </button>
                                    )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: RETURNS & QC INSPECTION */}
      {subTab === 'returns' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={returnSearch}
                onChange={(e) => setReturnSearch(e.target.value)}
                placeholder="Cari no. retur, invoice, produk..."
                className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={returnStatusFilter}
                onChange={(e) => setReturnStatusFilter(e.target.value)}
                className="text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">Semua Status Retur</option>
                <option value="COMPLETED">Selesai (COMPLETED)</option>
                <option value="PENDING_INSPECTION">Menunggu Inspeksi QC</option>
              </select>
              <select
                value={returnDispFilter}
                onChange={(e) =>
                  setReturnDispFilter(e.target.value as 'ALL' | ReturnStockDisposition)
                }
                className="text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">Semua Disposisi Stok</option>
                <option value="SELLABLE">Layak Jual (SELLABLE)</option>
                <option value="DAMAGED">Rusak (DAMAGED)</option>
                <option value="UNSELLABLE">Tidak Layak Jual</option>
                <option value="PENDING_INSPECTION">Menunggu Inspeksi QC</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">No. Retur & Invoice</th>
                  <th className="py-3 px-4">Waktu</th>
                  <th className="py-3 px-4">Item & Disposisi Stok</th>
                  <th className="py-3 px-4">Alasan & Approval</th>
                  <th className="py-3 px-4 text-right">Total Refund</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {returnsList.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-slate-500">
                      Belum ada catatan retur barang yang sesuai filter.
                    </td>
                  </tr>
                ) : (
                  returnsList.map((ret) => (
                    <tr key={ret.id} className="hover:bg-slate-50/70 align-top">
                      <td className="py-3 px-4 whitespace-nowrap">
                        <p className="font-mono font-bold text-slate-900">{ret.returnNumber}</p>
                        <p className="font-mono text-[11px] text-slate-500">{ret.invoiceNumber}</p>
                        <p
                          className={`text-[11px] font-bold mt-0.5 ${
                            ret.status === 'PENDING_INSPECTION'
                              ? 'text-amber-700'
                              : 'text-emerald-700'
                          }`}
                        >
                          {ret.status === 'PENDING_INSPECTION' ? 'MENUNGGU QC' : 'SELESAI'} ·{' '}
                          {ret.returnType}
                        </p>
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                        {formatDateTime(ret.createdAt)}
                      </td>
                      <td className="py-3 px-4 space-y-1.5 min-w-[260px]">
                        {ret.items.map((item) => {
                          const disp = dispositionBadgeLabel(item);
                          return (
                            <div key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <span className="font-semibold text-slate-900">
                                  {item.productName}
                                </span>{' '}
                                <span className="font-mono text-slate-600">
                                  ({item.qty} {item.unit})
                                </span>
                                <span className={`block text-[11px] font-semibold ${disp.cls}`}>
                                  {disp.label}
                                  {item.dispositionResolvedByName
                                    ? ` · QC oleh ${item.dispositionResolvedByName}`
                                    : ''}
                                </span>
                              </div>
                              {item.stockDisposition === 'PENDING_INSPECTION' &&
                                !item.finalDisposition && (
                                  <button
                                    type="button"
                                    disabled={!canResolveInspection}
                                    title={
                                      !canResolveInspection
                                        ? 'Akun Anda tidak memiliki hak akses memutuskan inspeksi QC.'
                                        : undefined
                                    }
                                    onClick={() => setInspectingItem(item)}
                                    className="px-2.5 py-1 text-[11px] font-semibold text-amber-800 bg-amber-100 hover:bg-amber-200 disabled:opacity-40 disabled:cursor-not-allowed rounded-md whitespace-nowrap"
                                  >
                                    Putuskan QC
                                  </button>
                                )}
                            </div>
                          );
                        })}
                      </td>
                      <td className="py-3 px-4">
                        <p className="text-slate-800">{ret.reason}</p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Kasir: {ret.requestedByName} · Approval: {ret.approvedByName}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <p className="font-mono font-bold text-teal-800 tabular-nums">
                          {formatRupiah(ret.totalRefundAmount)}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {ret.refundMethod} · {ret.refundStatus}
                        </p>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: REFUND LEDGER */}
      {subTab === 'refunds' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={refundSearch}
                onChange={(e) => setRefundSearch(e.target.value)}
                placeholder="Cari no. refund, invoice, referensi..."
                className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={refundSourceFilter}
                onChange={(e) => setRefundSourceFilter(e.target.value)}
                className="text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">Semua Sumber</option>
                <option value="RETURN">Retur Barang</option>
                <option value="VOID">Void Transaksi</option>
              </select>
              <select
                value={refundTypeFilter}
                onChange={(e) => setRefundTypeFilter(e.target.value)}
                className="text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">Semua Tipe Pembayaran</option>
                <option value="CASH">Tunai (CASH)</option>
                <option value="TRANSFER">Transfer</option>
                <option value="QRIS">QRIS</option>
                <option value="DEBIT">Debit</option>
                <option value="CREDIT">Kredit</option>
                <option value="OTHER">Lainnya</option>
              </select>
              <select
                value={refundStatusFilter}
                onChange={(e) => setRefundStatusFilter(e.target.value)}
                className="text-xs px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="ALL">Semua Status</option>
                <option value="COMPLETED">COMPLETED</option>
                <option value="MANUAL_RECORDED">MANUAL_RECORDED</option>
                <option value="PENDING">PENDING</option>
                <option value="FAILED">FAILED</option>
              </select>
              <button
                type="button"
                onClick={handleExportRefundsCsv}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
              >
                <Download className="w-3.5 h-3.5" />
                Ekspor CSV
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">No. Refund & Dokumen</th>
                  <th className="py-3 px-4">Waktu</th>
                  <th className="py-3 px-4">Metode & Referensi</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Nominal</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {refundsList.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-500">
                      Belum ada catatan pengembalian dana sesuai filter.
                    </td>
                  </tr>
                ) : (
                  refundsList.map((ref) => (
                    <tr key={ref.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 whitespace-nowrap">
                        <p className="font-mono font-bold text-slate-900">{ref.refundNumber}</p>
                        <p className="font-mono text-[11px] text-slate-500">
                          {ref.sourceType} {ref.sourceNumber} · {ref.invoiceNumber}
                        </p>
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                        {formatDateTime(ref.createdAt)}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-semibold text-slate-900">
                          {ref.refundMethod} ({ref.paymentType})
                        </p>
                        <p className="font-mono text-[11px] text-slate-500">
                          {ref.referenceNumber ? `Ref: ${ref.referenceNumber}` : 'Tanpa referensi'} ·{' '}
                          {ref.actorName}
                        </p>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`font-mono font-bold text-[11px] ${
                            ref.status === 'COMPLETED'
                              ? 'text-emerald-700'
                              : ref.status === 'PENDING'
                              ? 'text-amber-700'
                              : ref.status === 'FAILED'
                              ? 'text-rose-700'
                              : 'text-sky-700'
                          }`}
                        >
                          {ref.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-slate-900 tabular-nums whitespace-nowrap">
                        {formatRupiah(ref.amount)}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          disabled={!canManageRefundStatus}
                          title={
                            !canManageRefundStatus
                              ? 'Akun Anda tidak memiliki hak akses memperbarui status refund (pos:refund).'
                              : undefined
                          }
                          onClick={() => setUpdatingRefund(ref)}
                          className="px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed rounded-md"
                        >
                          Perbarui Status
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

      {/* TAB 4: VOID HISTORY */}
      {subTab === 'voids' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={voidSearch}
                onChange={(e) => setVoidSearch(e.target.value)}
                placeholder="Cari no. void, invoice, struk, alasan..."
                className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">No. Void & Transaksi</th>
                  <th className="py-3 px-4">Waktu Void</th>
                  <th className="py-3 px-4">Alasan & Pemulihan</th>
                  <th className="py-3 px-4">Approval</th>
                  <th className="py-3 px-4 text-right">Nilai Di-Void</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {voidsList.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-slate-500">
                      Belum ada riwayat void transaksi.
                    </td>
                  </tr>
                ) : (
                  voidsList.map((v) => (
                    <tr key={v.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 whitespace-nowrap">
                        <p className="font-mono font-bold text-rose-700">{v.voidNumber}</p>
                        <p className="font-mono text-[11px] text-slate-600">
                          {v.invoiceNumber} · Struk {v.receiptNumber}
                        </p>
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                        {formatDateTime(v.createdAt)}
                      </td>
                      <td className="py-3 px-4">
                        <p className="text-slate-900 font-medium">{v.reason}</p>
                        <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                          Stok kembali: +{v.stockRestoredQty} unit
                          {v.loyaltyPointsReversed > 0
                            ? ` · Poin dibalik: -${v.loyaltyPointsReversed}`
                            : ''}
                        </p>
                      </td>
                      <td className="py-3 px-4">
                        <p className="text-slate-800">{v.approvedByName}</p>
                        <p className="text-[11px] text-slate-500">Diminta: {v.requestedByName}</p>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <p className="font-mono font-bold text-rose-700 tabular-nums">
                          {formatRupiah(v.voidedTotal)}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {v.refundMethod} · {v.refundStatus}
                        </p>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modals */}
      <ReturnCreateModal
        open={returnModalOpen}
        eligibility={selectedEligibility}
        paymentMethods={paymentMethods}
        onClose={() => setReturnModalOpen(false)}
        onRequestRefundPin={onRequestRefundPin}
        onSuccess={(res) => {
          setReturnModalOpen(false);
          if (res.store) onStoreUpdate(res.store);
          setNotice(
            `Retur ${res.returnRecord.returnNumber} tersimpan. Refund ${formatRupiah(
              res.returnRecord.totalRefundAmount
            )} (${res.refundRecord.refundNumber}) tercatat.`
          );
          void refreshAll();
        }}
      />

      <VoidTransactionModal
        open={voidModalOpen}
        eligibility={selectedEligibility}
        paymentMethods={paymentMethods}
        onClose={() => setVoidModalOpen(false)}
        onRequestVoidPin={onRequestVoidPin}
        onSuccess={(res) => {
          setVoidModalOpen(false);
          if (res.store) onStoreUpdate(res.store);
          setNotice(
            `Transaksi ${res.voidRecord.invoiceNumber} berhasil di-void (${res.voidRecord.voidNumber}). Stok kembali +${res.voidRecord.stockRestoredQty} unit.`
          );
          void refreshAll();
        }}
      />

      <InspectionResolveModal
        item={inspectingItem}
        onClose={() => setInspectingItem(null)}
        onRequestRefundPin={onRequestRefundPin}
        onSuccess={(res) => {
          setInspectingItem(null);
          if (res.store) onStoreUpdate(res.store);
          setNotice(
            `Inspeksi QC "${res.item.productName}" ditetapkan: ${res.item.finalDisposition}.`
          );
          void refreshAll();
        }}
      />

      <RefundStatusUpdateModal
        refund={updatingRefund}
        onClose={() => setUpdatingRefund(null)}
        onSuccess={(res) => {
          setUpdatingRefund(null);
          if (res.store) onStoreUpdate(res.store);
          setNotice(
            `Status refund ${res.refundRecord.refundNumber} diperbarui menjadi ${res.refundRecord.status}.`
          );
          void refreshAll();
        }}
      />
    </div>
  );
}
