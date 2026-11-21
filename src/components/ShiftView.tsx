import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Clock,
  Download,
  FileText,
  Lock,
  PlayCircle,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import type {
  CashierShift,
  CashMovementType,
  ShiftDetailReport,
  ShiftListResponse,
  ShiftSettings,
  StoreData,
  StoreSettings,
  UserSummary,
} from '../types';
import { apiFetch } from '../utils/api';
import { downloadCSV, formatDateTime, formatRupiah } from '../utils/format';
import {
  ApproveDiscrepancyModal,
  CASH_MOVEMENT_LABELS,
  CashMovementModal,
  CloseShiftModal,
  getDiscrepancyLabel,
  OpenShiftModal,
  ShiftReportModal,
} from './ShiftModals';

interface ShiftViewProps {
  currentUser: UserSummary;
  currentShift: CashierShift | null;
  shiftSettings: ShiftSettings;
  storeSettings: StoreSettings;
  onStoreUpdate: (store: StoreData) => void;
  onRequestSupervisorPin: (opts: { title: string; description: string }) => Promise<string>;
}

export function ShiftView({
  currentUser,
  currentShift,
  shiftSettings,
  storeSettings,
  onStoreUpdate,
  onRequestSupervisorPin,
}: ShiftViewProps) {
  const canOpenStore = currentUser.permissions.includes('shifts:open');
  const canCloseStore = currentUser.permissions.includes('shifts:close');
  const canCashMovement = currentUser.permissions.includes('shifts:cash_movement');
  const canApproveDiscrepancy = currentUser.permissions.includes('shifts:approve');
  const canManageConfig =
    currentUser.permissions.includes('shifts:manage') ||
    currentUser.permissions.includes('settings:edit');

  const [subTab, setSubTab] = useState<'active' | 'history' | 'settings'>('active');
  const [activeReport, setActiveReport] = useState<ShiftDetailReport | null>(null);
  const [historyData, setHistoryData] = useState<ShiftListResponse | null>(null);
  const [loadingActive, setLoadingActive] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');
  const [discrepancyFilter, setDiscrepancyFilter] = useState<
    'ALL' | 'PENDING_APPROVAL' | 'MATCHED' | 'APPROVED'
  >('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Modals
  const [openModalVisible, setOpenModalVisible] = useState(false);
  const [cashModalState, setCashModalState] = useState<{
    open: boolean;
    type: CashMovementType;
  }>({ open: false, type: 'CASH_IN' });
  const [closeModalVisible, setCloseModalVisible] = useState(false);
  const [inspectReport, setInspectReport] = useState<ShiftDetailReport | null>(null);
  const [approvingShift, setApprovingShift] = useState<CashierShift | null>(null);

  // Settings form
  const [cfgForm, setCfgForm] = useState({
    requireOpenShiftForSales: shiftSettings.requireOpenShiftForSales,
    allowDuplicateOpenShifts: shiftSettings.allowDuplicateOpenShifts,
    requireSupervisorApprovalOnDiscrepancy: shiftSettings.requireSupervisorApprovalOnDiscrepancy,
    discrepancyToleranceRp: String(shiftSettings.discrepancyToleranceRp),
  });
  const [savingCfg, setSavingCfg] = useState(false);

  useEffect(() => {
    setCfgForm({
      requireOpenShiftForSales: shiftSettings.requireOpenShiftForSales,
      allowDuplicateOpenShifts: shiftSettings.allowDuplicateOpenShifts,
      requireSupervisorApprovalOnDiscrepancy: shiftSettings.requireSupervisorApprovalOnDiscrepancy,
      discrepancyToleranceRp: String(shiftSettings.discrepancyToleranceRp),
    });
  }, [shiftSettings]);

  const loadActiveShiftDetail = useCallback(async () => {
    if (!currentShift) {
      setActiveReport(null);
      return;
    }
    setLoadingActive(true);
    try {
      const res = await apiFetch<{ report: ShiftDetailReport }>(`/api/shifts/${currentShift.id}`);
      setActiveReport(res.report);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal memuat detail shift aktif.',
      });
    } finally {
      setLoadingActive(false);
    }
  }, [currentShift]);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (discrepancyFilter !== 'ALL') params.set('discrepancyStatus', discrepancyFilter);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      params.set('pageSize', '50');
      const res = await apiFetch<ShiftListResponse>(`/api/shifts?${params.toString()}`);
      setHistoryData(res);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal memuat riwayat shift.',
      });
    } finally {
      setLoadingHistory(false);
    }
  }, [search, statusFilter, discrepancyFilter, dateFrom, dateTo]);

  useEffect(() => {
    loadActiveShiftDetail();
  }, [loadActiveShiftDetail]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleViewShiftReport = async (shiftId: string) => {
    try {
      const res = await apiFetch<{ report: ShiftDetailReport }>(`/api/shifts/${shiftId}`);
      setInspectReport(res.report);
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal memuat laporan shift.',
      });
    }
  };

  const handleSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    setBanner(null);
    const tol = Number(cfgForm.discrepancyToleranceRp || 0);
    if (!Number.isInteger(tol) || tol < 0) {
      setBanner({ type: 'error', text: 'Toleransi selisih kas harus bilangan bulat minimal 0.' });
      return;
    }
    setSavingCfg(true);
    try {
      const res = await apiFetch<{ shiftSettings: ShiftSettings; store: StoreData }>(
        '/api/shifts/settings',
        {
          method: 'PUT',
          body: JSON.stringify({
            requireOpenShiftForSales: cfgForm.requireOpenShiftForSales,
            allowDuplicateOpenShifts: cfgForm.allowDuplicateOpenShifts,
            requireSupervisorApprovalOnDiscrepancy: cfgForm.requireSupervisorApprovalOnDiscrepancy,
            discrepancyToleranceRp: tol,
          }),
        }
      );
      onStoreUpdate(res.store);
      setBanner({ type: 'success', text: 'Konfigurasi kebijakan buka/tutup toko & kas berhasil disimpan.' });
    } catch (err) {
      setBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menyimpan konfigurasi toko.',
      });
    } finally {
      setSavingCfg(false);
    }
  };

  const handleExportHistoryCsv = () => {
    const rows = historyData?.shifts ?? [];
    const today = new Date().toISOString().slice(0, 10);
    downloadCSV(
      `riwayat-buka-tutup-toko-${today}.csv`,
      [
        'No Sesi Toko',
        'Status',
        'Dibuka Oleh',
        'Ditutup Oleh',
        'Kassa',
        'Waktu Buka',
        'Waktu Tutup',
        'Modal Awal',
        'Penjualan Tunai',
        'Penjualan Non-Tunai',
        'Kas Masuk',
        'Kas Keluar',
        'Pengeluaran',
        'Refund Tunai',
        'Kas Seharusnya',
        'Kas Aktual',
        'Selisih',
        'Status Selisih',
      ],
      rows.map((s) => [
        s.shiftNumber,
        s.status,
        s.openedByName || s.cashierName,
        s.closedByName || '-',
        s.registerName,
        formatDateTime(s.openedAt),
        s.closedAt ? formatDateTime(s.closedAt) : '-',
        s.openingCash,
        s.cashSales,
        s.nonCashSales,
        s.cashInTotal,
        s.cashOutTotal,
        s.expenseTotal,
        s.cashRefunds,
        s.expectedCash,
        s.actualCash ?? '',
        s.difference ?? '',
        getDiscrepancyLabel(s),
      ])
    );
  };

  const pendingApprovalsCount =
    historyData?.shifts.filter((s) => s.discrepancyStatus === 'PENDING_APPROVAL').length ?? 0;

  return (
    <div className="space-y-4">
      {banner && (
        <div
          className={`p-3 rounded-xl border text-xs font-medium flex items-center justify-between gap-2 ${
            banner.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-[11px] font-semibold underline"
          >
            Tutup
          </button>
        </div>
      )}

      {/* Workspace Navigation Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          <button
            type="button"
            onClick={() => setSubTab('active')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              subTab === 'active' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Toko Aktif &amp; Mutasi Kas
          </button>
          <button
            type="button"
            onClick={() => setSubTab('history')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              subTab === 'history' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Riwayat &amp; Laporan Toko
            {pendingApprovalsCount > 0 ? ` (${pendingApprovalsCount} Perlu Review)` : ''}
          </button>
          {canManageConfig && (
            <button
              type="button"
              onClick={() => setSubTab('settings')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                subTab === 'settings' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Konfigurasi Toko
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!currentShift && (
            <button
              type="button"
              disabled={!canOpenStore}
              onClick={() => setOpenModalVisible(true)}
              title={!canOpenStore ? 'Akun Anda tidak memiliki hak akses Buka Toko.' : undefined}
              className="min-h-[40px] inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg whitespace-nowrap"
            >
              <PlayCircle className="w-4 h-4 shrink-0" />
              Buka Toko
            </button>
          )}
          {currentShift && canCashMovement && (
            <>
              <button
                type="button"
                onClick={() => setCashModalState({ open: true, type: 'CASH_IN' })}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-lg whitespace-nowrap"
              >
                <ArrowDownLeft className="w-3.5 h-3.5 shrink-0" />
                Kas Masuk
              </button>
              <button
                type="button"
                onClick={() => setCashModalState({ open: true, type: 'CASH_OUT' })}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-amber-900 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-lg whitespace-nowrap"
              >
                <ArrowUpRight className="w-3.5 h-3.5 shrink-0" />
                Kas Keluar / Biaya
              </button>
            </>
          )}
          {currentShift && (
            <button
              type="button"
              disabled={!canCloseStore}
              onClick={() => setCloseModalVisible(true)}
              title={!canCloseStore ? 'Akun Anda tidak memiliki hak akses Tutup Toko.' : undefined}
              className="min-h-[40px] inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg whitespace-nowrap"
            >
              <Lock className="w-3.5 h-3.5 shrink-0" />
              Tutup Toko
            </button>
          )}
        </div>
      </div>

      {/* TAB 1: ACTIVE STORE SESSION */}
      {subTab === 'active' && (
        <>
          {!currentShift ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
              <div className="w-11 h-11 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center mx-auto">
                <Clock className="w-5 h-5" />
              </div>
              <div className="max-w-md mx-auto space-y-1">
                <h3 className="text-sm font-semibold text-slate-900">Toko Belum Dibuka</h3>
                <p className="text-xs text-slate-500">
                  Satu kali Buka Toko berlaku untuk seluruh kasir dan pengguna yang bertugas. Catat
                  modal awal laci sebelum memulai transaksi hari ini.
                </p>
              </div>
              <button
                type="button"
                disabled={!canOpenStore}
                onClick={() => setOpenModalVisible(true)}
                title={!canOpenStore ? 'Akun Anda tidak memiliki hak akses Buka Toko.' : undefined}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg"
              >
                <PlayCircle className="w-4 h-4" />
                Buka Toko Sekarang
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* KPI Strip */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 tabular-nums">
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <span className="text-xs text-slate-500 block">Status Toko Buka</span>
                  <span className="font-mono text-sm font-bold text-slate-900 block mt-1">
                    {currentShift.shiftNumber}
                  </span>
                  <span className="text-[11px] text-slate-600 block mt-0.5">
                    Dibuka oleh: <strong>{currentShift.openedByName || currentShift.cashierName}</strong>
                  </span>
                  <span className="text-[11px] text-slate-500 block">
                    {currentShift.registerName} · {formatDateTime(currentShift.openedAt)}
                  </span>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <span className="text-xs text-slate-500 block">Modal Awal Laci</span>
                  <span className="font-mono text-base font-bold text-slate-900 block mt-1">
                    {formatRupiah(currentShift.openingCash)}
                  </span>
                  <span className="text-[11px] text-slate-500 block mt-0.5">
                    Penjualan Tunai: +{formatRupiah(activeReport?.reconciliation.cashSales ?? currentShift.cashSales)}
                  </span>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <span className="text-xs text-slate-500 block">Mutasi Kas Bersih</span>
                  <span className="font-mono text-base font-bold text-slate-900 block mt-1">
                    +{formatRupiah(activeReport?.reconciliation.cashInTotal ?? currentShift.cashInTotal)}{' '}
                    / -
                    {formatRupiah(
                      (activeReport?.reconciliation.cashOutCombined ??
                        currentShift.cashOutTotal + currentShift.expenseTotal) +
                        (activeReport?.reconciliation.cashRefunds ?? currentShift.cashRefunds)
                    )}
                  </span>
                  <span className="text-[11px] text-slate-500 block mt-0.5">
                    Total Omzet: {formatRupiah(activeReport?.reconciliation.totalSales ?? currentShift.totalSales)} ({activeReport?.reconciliation.transactionCount ?? currentShift.transactionCount} trx)
                  </span>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <span className="text-xs text-slate-500 block">Estimasi Kas di Laci</span>
                  <span className="font-mono text-lg font-bold text-teal-800 block mt-1">
                    {formatRupiah(activeReport?.reconciliation.expectedCash ?? currentShift.expectedCash)}
                  </span>
                  <span className="text-[11px] text-slate-500 block mt-0.5">
                    Non-Tunai: {formatRupiah(activeReport?.reconciliation.nonCashSales ?? currentShift.nonCashSales)}
                  </span>
                </div>
              </div>

              {/* Payment Breakdown & Cash Movements */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-900">Ringkasan Pembayaran</h3>
                    <button
                      type="button"
                      onClick={loadActiveShiftDetail}
                      disabled={loadingActive}
                      className="text-xs font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${loadingActive ? 'animate-spin' : ''}`} />
                      Segarkan
                    </button>
                  </div>
                  <div className="p-4 space-y-2.5 text-xs tabular-nums">
                    {!activeReport || activeReport.paymentBreakdown.length === 0 ? (
                      <p className="text-slate-500 py-4 text-center">
                        Belum ada transaksi selesai pada shift ini.
                      </p>
                    ) : (
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 text-[11px] text-slate-500">
                            <th className="py-1.5">Metode</th>
                            <th className="py-1.5 text-right">Trx</th>
                            <th className="py-1.5 text-right">Nominal</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {activeReport.paymentBreakdown.map((pb) => (
                            <tr key={`${pb.paymentMethodName}-${pb.paymentType}`}>
                              <td className="py-2 font-medium text-slate-800">
                                {pb.paymentMethodName}
                              </td>
                              <td className="py-2 text-right font-mono text-slate-600">
                                {pb.transactionCount}
                              </td>
                              <td className="py-2 text-right font-mono font-semibold text-slate-900">
                                {formatRupiah(pb.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div className="pt-2 border-t border-slate-100 flex justify-between items-center">
                      <button
                        type="button"
                        onClick={() => handleViewShiftReport(currentShift.id)}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-800 hover:underline"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        Lihat Laporan Lengkap Toko
                      </button>
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">
                      Mutasi Kas Toko ({activeReport?.cashMovements.length ?? 0})
                    </h3>
                    {canCashMovement && (
                      <button
                        type="button"
                        onClick={() => setCashModalState({ open: true, type: 'EXPENSE' })}
                        className="text-xs font-semibold text-teal-800 hover:underline"
                      >
                        + Catat Mutasi Kas
                      </button>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                          <th className="py-2.5 px-3">Waktu</th>
                          <th className="py-2.5 px-3">Jenis</th>
                          <th className="py-2.5 px-3">Alasan &amp; Referensi</th>
                          <th className="py-2.5 px-3">Petugas</th>
                          <th className="py-2.5 px-3 text-right">Nominal</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 tabular-nums">
                        {!activeReport || activeReport.cashMovements.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-8 text-center text-slate-500">
                              Belum ada kas masuk/keluar manual pada shift ini.
                            </td>
                          </tr>
                        ) : (
                          activeReport.cashMovements.map((mov) => (
                            <tr key={mov.id} className="hover:bg-slate-50/70">
                              <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                                {formatDateTime(mov.createdAt)}
                              </td>
                              <td className="py-2.5 px-3 font-semibold whitespace-nowrap">
                                <span
                                  className={
                                    mov.type === 'CASH_IN' ? 'text-emerald-700' : 'text-rose-700'
                                  }
                                >
                                  {CASH_MOVEMENT_LABELS[mov.type]}
                                </span>
                              </td>
                              <td className="py-2.5 px-3">
                                <p className="font-medium text-slate-800">{mov.reason}</p>
                                <p className="font-mono text-[10px] text-slate-500">
                                  {mov.movementNumber}
                                  {mov.referenceNumber && mov.referenceNumber !== mov.movementNumber
                                    ? ` · Ref: ${mov.referenceNumber}`
                                    : ''}
                                </p>
                              </td>
                              <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                                {mov.actorName}
                              </td>
                              <td
                                className={`py-2.5 px-3 text-right font-mono font-semibold whitespace-nowrap ${
                                  mov.type === 'CASH_IN' ? 'text-emerald-700' : 'text-rose-700'
                                }`}
                              >
                                {mov.type === 'CASH_IN' ? '+' : '-'}
                                {formatRupiah(mov.amount)}
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
        </>
      )}

      {/* TAB 2: SHIFT HISTORY & REPORTS */}
      {subTab === 'history' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-60">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Cari no. sesi, pembuka, penutup..."
                  className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'ALL' | 'OPEN' | 'CLOSED')}
                className="text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white"
                aria-label="Filter status toko"
              >
                <option value="ALL">Semua Status</option>
                <option value="OPEN">Toko Buka (OPEN)</option>
                <option value="CLOSED">Toko Tutup (CLOSED)</option>
              </select>

              <select
                value={discrepancyFilter}
                onChange={(e) =>
                  setDiscrepancyFilter(
                    e.target.value as 'ALL' | 'PENDING_APPROVAL' | 'MATCHED' | 'APPROVED'
                  )
                }
                className="text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white"
                aria-label="Filter status selisih shift"
              >
                <option value="ALL">Semua Rekonsiliasi</option>
                <option value="PENDING_APPROVAL">Menunggu Persetujuan Supervisor</option>
                <option value="MATCHED">Sesuai (Pas)</option>
                <option value="APPROVED">Selisih Disetujui</option>
              </select>

              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                aria-label="Tanggal mulai"
                className="text-xs font-mono px-2.5 py-2 border border-slate-300 rounded-lg"
              />
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                aria-label="Tanggal selesai"
                className="text-xs font-mono px-2.5 py-2 border border-slate-300 rounded-lg"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={loadHistory}
                className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingHistory ? 'animate-spin' : ''}`} />
                Muat Ulang
              </button>
              <button
                type="button"
                onClick={handleExportHistoryCsv}
                className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
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
                  <th className="py-3 px-4">No. Sesi &amp; Kassa</th>
                  <th className="py-3 px-4">Dibuka &amp; Ditutup Oleh</th>
                  <th className="py-3 px-4 text-right">Modal Awal</th>
                  <th className="py-3 px-4 text-right">Omzet (Trx)</th>
                  <th className="py-3 px-4 text-right">Kas Seharusnya</th>
                  <th className="py-3 px-4 text-right">Kas Aktual</th>
                  <th className="py-3 px-4 text-right">Selisih</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {loadingHistory ? (
                  <tr>
                    <td colSpan={9} className="py-10 text-center text-slate-500">
                      Memuat riwayat buka/tutup toko...
                    </td>
                  </tr>
                ) : !historyData || historyData.shifts.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-10 text-center text-slate-500">
                      Belum ada riwayat buka/tutup toko yang sesuai filter.
                    </td>
                  </tr>
                ) : (
                  historyData.shifts.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4">
                        <p className="font-mono font-bold text-slate-900">{s.shiftNumber}</p>
                        <p className="text-[11px] text-slate-500">{s.registerName}</p>
                      </td>
                      <td className="py-3 px-4 text-[11px] text-slate-600 whitespace-nowrap">
                        <p>
                          Buka: <strong className="text-slate-900">{s.openedByName || s.cashierName}</strong>{' '}
                          <span className="font-mono text-slate-500">({formatDateTime(s.openedAt)})</span>
                        </p>
                        <p className="mt-0.5">
                          Tutup:{' '}
                          {s.closedAt ? (
                            <>
                              <strong className="text-slate-900">{s.closedByName || '-'}</strong>{' '}
                              <span className="font-mono text-slate-500">({formatDateTime(s.closedAt)})</span>
                            </>
                          ) : (
                            <span className="text-teal-700 font-semibold">Masih Buka</span>
                          )}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-700 whitespace-nowrap">
                        {formatRupiah(s.openingCash)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono whitespace-nowrap">
                        <span className="font-semibold text-slate-900 block">
                          {formatRupiah(s.totalSales)}
                        </span>
                        <span className="text-[10px] text-slate-500">
                          {s.transactionCount} trx
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-medium text-slate-900 whitespace-nowrap">
                        {formatRupiah(s.expectedCash)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-slate-900 whitespace-nowrap">
                        {s.actualCash !== null ? formatRupiah(s.actualCash) : '-'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold whitespace-nowrap">
                        {s.difference === null ? (
                          <span className="text-slate-400">-</span>
                        ) : s.difference === 0 ? (
                          <span className="text-emerald-700">Rp 0</span>
                        ) : s.difference > 0 ? (
                          <span className="text-amber-700">+{formatRupiah(s.difference)}</span>
                        ) : (
                          <span className="text-rose-700">
                            -{formatRupiah(Math.abs(s.difference))}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`font-semibold ${
                            s.status === 'OPEN'
                              ? 'text-teal-700'
                              : s.discrepancyStatus === 'PENDING_APPROVAL'
                              ? 'text-amber-700'
                              : 'text-slate-700'
                          }`}
                        >
                          {getDiscrepancyLabel(s)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {canApproveDiscrepancy && s.discrepancyStatus === 'PENDING_APPROVAL' && (
                            <button
                              type="button"
                              onClick={() => setApprovingShift(s)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-amber-900 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-md"
                            >
                              <ShieldCheck className="w-3 h-3" />
                              Setujui
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleViewShiftReport(s.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                          >
                            <FileText className="w-3 h-3" />
                            Laporan
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: SHIFT CONFIGURATION (ADMIN) */}
      {subTab === 'settings' && canManageConfig && (
        <form
          onSubmit={handleSaveSettings}
          className="bg-white border border-slate-200 rounded-xl p-5 max-w-2xl space-y-4 text-xs"
        >
          <div className="flex items-center gap-2 pb-2 border-b border-slate-200">
            <Settings2 className="w-4 h-4 text-teal-700" />
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Konfigurasi Kebijakan Buka/Tutup Toko &amp; Kontrol Kas
              </h3>
              <p className="text-slate-500">
                Pengaturan operasional pembukaan toko, duplikasi sesi aktif, dan persetujuan selisih
                tutup toko.
              </p>
            </div>
          </div>

          <label className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={cfgForm.requireOpenShiftForSales}
              onChange={(e) =>
                setCfgForm({ ...cfgForm, requireOpenShiftForSales: e.target.checked })
              }
              className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
            <div>
              <span className="font-semibold text-slate-800 block">
                Wajibkan Buka Toko Sebelum Transaksi Penjualan
              </span>
              <span className="text-slate-500">
                Jika aktif, toko harus berstatus BUKA sebelum kasir atau user mana pun memproses
                checkout atau menahan transaksi.
              </span>
            </div>
          </label>

          <label className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={cfgForm.allowDuplicateOpenShifts}
              onChange={(e) =>
                setCfgForm({ ...cfgForm, allowDuplicateOpenShifts: e.target.checked })
              }
              className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
            <div>
              <span className="font-semibold text-slate-800 block">
                Izinkan Multi-Sesi Buka Toko Bersamaan
              </span>
              <span className="text-slate-500">
                Nonaktifkan (disarankan) agar cukup satu user yang membuka toko untuk seluruh
                pengguna hingga toko ditutup.
              </span>
            </div>
          </label>

          <label className="flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={cfgForm.requireSupervisorApprovalOnDiscrepancy}
              onChange={(e) =>
                setCfgForm({
                  ...cfgForm,
                  requireSupervisorApprovalOnDiscrepancy: e.target.checked,
                })
              }
              className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
            <div>
              <span className="font-semibold text-slate-800 block">
                Wajibkan Persetujuan Supervisor Saat Terdapat Selisih Kas
              </span>
              <span className="text-slate-500">
                Selisih melebihi toleransi yang ditutup oleh Kasir akan memerlukan PIN Supervisor
                saat tutup shift atau status Menunggu Persetujuan Supervisor.
              </span>
            </div>
          </label>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">
              Toleransi Selisih Kas (Rp)
            </label>
            <input
              type="number"
              min={0}
              step={1}
              value={cfgForm.discrepancyToleranceRp}
              onChange={(e) =>
                setCfgForm({ ...cfgForm, discrepancyToleranceRp: e.target.value })
              }
              className="w-56 font-mono px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Selisih di bawah atau sama dengan nominal ini otomatis berstatus Sesuai (Pas).
            </p>
          </div>

          <div className="pt-2 border-t border-slate-200 flex justify-end">
            <button
              type="submit"
              disabled={savingCfg}
              className="min-h-[40px] px-4 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
            >
              {savingCfg ? 'Menyimpan...' : 'Simpan Konfigurasi Toko'}
            </button>
          </div>
        </form>
      )}

      {/* Modals */}
      <OpenShiftModal
        open={openModalVisible}
        onClose={() => setOpenModalVisible(false)}
        onSuccess={(opened, nextStore) => {
          onStoreUpdate(nextStore as StoreData);
          setBanner({
            type: 'success',
            text: `Toko dibuka (${opened.shiftNumber}) oleh ${opened.openedByName || opened.cashierName} dengan modal awal ${formatRupiah(opened.openingCash)}.`,
          });
        }}
      />

      <CashMovementModal
        open={cashModalState.open}
        shift={currentShift}
        initialType={cashModalState.type}
        onClose={() => setCashModalState((prev) => ({ ...prev, open: false }))}
        onSuccess={(_updatedShift, nextStore) => {
          onStoreUpdate(nextStore as StoreData);
          loadActiveShiftDetail();
          loadHistory();
          setBanner({
            type: 'success',
            text: 'Mutasi kas toko berhasil dicatat ke buku kas.',
          });
        }}
      />

      <CloseShiftModal
        open={closeModalVisible}
        shift={currentShift}
        shiftSettings={shiftSettings}
        canApproveDiscrepancy={canApproveDiscrepancy}
        onRequestSupervisorPin={onRequestSupervisorPin}
        onClose={() => setCloseModalVisible(false)}
        onClosed={(closedReport, nextStore) => {
          onStoreUpdate(nextStore as StoreData);
          setInspectReport(closedReport);
          loadHistory();
          setBanner({
            type: 'success',
            text: `Toko ${closedReport.shift.shiftNumber} berhasil ditutup oleh ${closedReport.shift.closedByName || currentUser.fullName} (${getDiscrepancyLabel(closedReport.shift)}).`,
          });
        }}
      />

      <ApproveDiscrepancyModal
        open={Boolean(approvingShift)}
        shift={approvingShift}
        onClose={() => setApprovingShift(null)}
        onApproved={(approvedReport, nextStore) => {
          onStoreUpdate(nextStore as StoreData);
          if (inspectReport?.shift.id === approvedReport.shift.id) {
            setInspectReport(approvedReport);
          }
          loadHistory();
          setBanner({
            type: 'success',
            text: `Selisih kas toko ${approvedReport.shift.shiftNumber} telah disetujui.`,
          });
        }}
      />

      <ShiftReportModal
        report={inspectReport}
        storeSettings={storeSettings}
        canApproveDiscrepancy={canApproveDiscrepancy}
        onClose={() => setInspectReport(null)}
        onOpenApprove={(shiftToApprove) => setApprovingShift(shiftToApprove)}
      />
    </div>
  );
}
