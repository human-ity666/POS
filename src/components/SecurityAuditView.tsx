import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, LogOut, RefreshCw, Search } from 'lucide-react';
import type { AuditLog, SessionInfo, UserSummary } from '../types';
import { apiFetch, ApiError } from '../utils/api';
import { downloadCSV, formatDateTime } from '../utils/format';

interface SecurityAuditViewProps {
  currentUser: UserSummary;
  auditLogs: AuditLog[];
  onRefreshAuditLogs: () => Promise<void>;
  onCurrentSessionRevoked: () => void;
}

export function SecurityAuditView({
  currentUser,
  auditLogs,
  onRefreshAuditLogs,
  onCurrentSessionRevoked,
}: SecurityAuditViewProps) {
  const canViewAudit = currentUser.permissions.includes('audit:view');
  const canRevokeOthers = currentUser.permissions.includes('sessions:revoke');

  const [tab, setTab] = useState<'sessions' | 'audit'>(canViewAudit ? 'audit' : 'sessions');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [auditSearch, setAuditSearch] = useState('');
  const [actionFilter, setActionFilter] = useState<string>('ALL');

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    setError(null);
    try {
      const res = await apiFetch<{ sessions: SessionInfo[] }>('/api/sessions');
      setSessions(res.sessions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal memuat daftar sesi.');
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleRevokeSession = async (session: SessionInfo) => {
    setError(null);
    try {
      await apiFetch<{ ok: boolean }>(`/api/sessions/${session.id}`, { method: 'DELETE' });
      if (session.isCurrent) {
        onCurrentSessionRevoked();
        return;
      }
      await loadSessions();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal memutus sesi.');
    }
  };

  const filteredAudit = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    return auditLogs.filter((log) => {
      if (actionFilter !== 'ALL' && !log.action.startsWith(actionFilter)) return false;
      if (!q) return true;
      return (
        log.summary.toLowerCase().includes(q) ||
        log.actor.toLowerCase().includes(q) ||
        log.action.toLowerCase().includes(q) ||
        log.entityId.toLowerCase().includes(q)
      );
    });
  }, [auditLogs, auditSearch, actionFilter]);

  const handleExportAuditCSV = () => {
    const today = new Date().toISOString().slice(0, 10);
    downloadCSV(
      `audit-log-${today}.csv`,
      ['Waktu', 'Aksi', 'Entitas', 'ID Entitas', 'Pelaku', 'Ringkasan'],
      filteredAudit.map((a) => [
        formatDateTime(a.createdAt),
        a.action,
        a.entityType,
        a.entityId,
        a.actor,
        a.summary,
      ])
    );
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-xl">
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {canViewAudit && (
            <button
              type="button"
              onClick={() => setTab('audit')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                tab === 'audit' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Audit Log ({auditLogs.length})
            </button>
          )}
          <button
            type="button"
            onClick={() => setTab('sessions')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              tab === 'sessions' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Manajemen Sesi ({sessions.filter((s) => !s.revokedAt).length} Aktif)
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => (tab === 'audit' ? onRefreshAuditLogs() : loadSessions())}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Muat Ulang
          </button>
          {tab === 'audit' && canViewAudit && (
            <button
              type="button"
              onClick={handleExportAuditCSV}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
            >
              <Download className="w-3.5 h-3.5" />
              Ekspor CSV
            </button>
          )}
        </div>
      </div>

      {tab === 'sessions' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">Pengguna & Role</th>
                  <th className="py-3 px-4">Waktu Login</th>
                  <th className="py-3 px-4">Aktivitas Terakhir</th>
                  <th className="py-3 px-4">Kedaluwarsa</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Kontrol Sesi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {loadingSessions ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-slate-500">
                      Memuat daftar sesi...
                    </td>
                  </tr>
                ) : sessions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-slate-500">
                      Tidak ada sesi tercatat.
                    </td>
                  </tr>
                ) : (
                  sessions.map((ses) => {
                    const isExpired = new Date(ses.expiresAt).getTime() <= Date.now();
                    const isActive = !ses.revokedAt && !isExpired;
                    const canRevoke =
                      !ses.revokedAt && (ses.userId === currentUser.id || canRevokeOthers);

                    return (
                      <tr key={ses.id} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4">
                          <p className="font-semibold text-slate-900">
                            {ses.fullName}
                            {ses.isCurrent ? ' (Sesi Ini)' : ''}
                          </p>
                          <p className="font-mono text-[11px] text-slate-500 mt-0.5">
                            @{ses.username} · {ses.roleNames.join(', ')}
                          </p>
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] text-slate-600 tabular-nums whitespace-nowrap">
                          {formatDateTime(ses.loginAt)}
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] text-slate-600 tabular-nums whitespace-nowrap">
                          {formatDateTime(ses.lastActivityAt)}
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] text-slate-600 tabular-nums whitespace-nowrap">
                          {formatDateTime(ses.expiresAt)}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span
                            className={`font-semibold ${
                              ses.revokedAt
                                ? 'text-rose-700'
                                : isExpired
                                ? 'text-amber-700'
                                : 'text-emerald-700'
                            }`}
                          >
                            {ses.revokedAt ? 'Dicabut' : isExpired ? 'Kedaluwarsa' : 'Aktif'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {canRevoke && isActive && (
                            <button
                              type="button"
                              onClick={() => handleRevokeSession(ses)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-md"
                            >
                              <LogOut className="w-3 h-3" />
                              Putuskan Sesi
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'audit' && canViewAudit && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
              {(
                [
                  { id: 'ALL', label: 'Semua' },
                  { id: 'LOGIN', label: 'Login' },
                  { id: 'USER', label: 'Pengguna' },
                  { id: 'ROLE', label: 'Role & Izin' },
                  { id: 'PIN', label: 'Otorisasi PIN' },
                  { id: 'PRODUCT', label: 'Produk & Katalog' },
                  { id: 'TRANSACTION', label: 'Transaksi' },
                  { id: 'STOCK', label: 'Stok' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setActionFilter(f.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    actionFilter === f.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
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
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                placeholder="Cari pelaku atau ringkasan..."
                className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4">Waktu</th>
                  <th className="py-3 px-4">Aksi</th>
                  <th className="py-3 px-4">Pelaku</th>
                  <th className="py-3 px-4">Ringkasan Aktivitas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredAudit.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-10 text-center text-slate-500">
                      Tidak ada log audit yang sesuai.
                    </td>
                  </tr>
                ) : (
                  filteredAudit.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-500 tabular-nums whitespace-nowrap">
                        {formatDateTime(log.createdAt)}
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] font-semibold whitespace-nowrap">
                        <span
                          className={
                            log.action.includes('FAILED') || log.action.includes('REVOKED')
                              ? 'text-rose-700'
                              : log.action.includes('PIN')
                              ? 'text-amber-700'
                              : 'text-slate-800'
                          }
                        >
                          {log.action}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-800 whitespace-nowrap">
                        {log.actor}
                      </td>
                      <td className="py-3 px-4 text-slate-600">{log.summary}</td>
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
