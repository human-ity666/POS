import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  ExternalLink,
  History,
  Printer,
  RefreshCw,
} from 'lucide-react';
import type { ReceiptData, ReceiptLayoutFormat, StoreData, StoreSettings } from '../types';
import { apiFetch } from '../utils/api';
import { formatDateTime } from '../utils/format';
import {
  AVAILABLE_PRINTER_ADAPTERS,
  getPrinterAdapter,
} from '../services/printerService';
import { ReceiptDocument } from './ReceiptDocument';

interface ReceiptDetailViewProps {
  transactionId: string;
  publicToken?: string;
  settings?: StoreSettings;
  onBack?: () => void;
  onStoreUpdate?: (store: StoreData) => void;
}

const FORMAT_OPTIONS: Array<{ id: ReceiptLayoutFormat; label: string }> = [
  { id: '58mm', label: 'Thermal 58mm' },
  { id: '80mm', label: 'Thermal 80mm' },
  { id: 'A4', label: 'Standar A4' },
  { id: 'DIGITAL', label: 'Struk Digital' },
];

export function ReceiptDetailView({
  transactionId,
  publicToken,
  settings,
  onBack,
  onStoreUpdate,
}: ReceiptDetailViewProps) {
  const isPublicMode = Boolean(publicToken);

  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [format, setFormat] = useState<ReceiptLayoutFormat>(
    settings?.receiptPaperWidth ?? '80mm'
  );
  const [driverId, setDriverId] = useState<string>('browser-dialog');
  const [printing, setPrinting] = useState(false);
  const [printerAlert, setPrinterAlert] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  const fetchReceipt = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isPublicMode && publicToken) {
        const res = await fetch(
          `/api/receipts/public/${encodeURIComponent(transactionId)}?token=${encodeURIComponent(
            publicToken
          )}`
        );
        const body = (await res.json()) as { receipt?: ReceiptData; error?: string };
        if (!res.ok || !body.receipt) {
          throw new Error(body.error || 'Gagal memuat struk digital.');
        }
        setReceipt(body.receipt);
      } else {
        const res = await apiFetch<{ receipt: ReceiptData }>(
          `/api/transactions/${encodeURIComponent(transactionId)}/receipt`
        );
        setReceipt(res.receipt);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat data struk.');
    } finally {
      setLoading(false);
    }
  }, [transactionId, isPublicMode, publicToken]);

  useEffect(() => {
    void fetchReceipt();
  }, [fetchReceipt]);

  const handlePrintOrReprint = async (chosenDriverId = driverId) => {
    if (!receipt) return;
    setPrinting(true);
    setPrinterAlert(null);

    try {
      const adapter = getPrinterAdapter(chosenDriverId);
      if (!adapter.isAvailable()) {
        setPrinterAlert({
          type: 'error',
          message: `Adapter "${adapter.name}" tidak tersedia di browser ini. Gunakan opsi Ekspor Struk Digital (HTML).`,
        });
        return;
      }

      // Record print/reprint on backend first when authenticated so copy number increments atomically
      let latestReceipt = receipt;
      if (!isPublicMode) {
        const res = await apiFetch<{ receipt: ReceiptData; store: StoreData }>(
          `/api/transactions/${encodeURIComponent(receipt.transaction.id)}/receipt/print`,
          {
            method: 'POST',
            body: JSON.stringify({
              layoutFormat: format,
              driverId: adapter.id,
            }),
          }
        );
        latestReceipt = res.receipt;
        setReceipt(res.receipt);
        onStoreUpdate?.(res.store);
      }

      const printResult = await adapter.executePrint(latestReceipt, format);
      setPrinterAlert({
        type: printResult.ok ? 'success' : 'error',
        message: printResult.message,
      });
    } catch (err) {
      setPrinterAlert({
        type: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Terjadi kesalahan saat memproses cetak struk.',
      });
    } finally {
      setPrinting(false);
    }
  };

  const handleCopyDigitalLink = async () => {
    if (!receipt) return;
    const fullUrl =
      typeof window !== 'undefined'
        ? `${window.location.origin}${receipt.digitalReceiptPath}`
        : receipt.qrPayload;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      setPrinterAlert({
        type: 'error',
        message: `Gagal menyalin otomatis. Salin tautan ini secara manual: ${fullUrl}`,
      });
    }
  };

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
        Memuat detail struk transaksi...
      </div>
    );
  }

  if (error || !receipt) {
    return (
      <div className="bg-white border border-rose-200 rounded-xl p-6 max-w-lg mx-auto text-center space-y-3">
        <AlertTriangle className="w-7 h-7 text-rose-600 mx-auto" />
        <p className="text-sm font-semibold text-rose-900">
          {error || 'Data struk tidak ditemukan.'}
        </p>
        <div className="flex items-center justify-center gap-2 pt-1">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Kembali
            </button>
          )}
          <button
            type="button"
            onClick={() => void fetchReceipt()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Coba Lagi
          </button>
        </div>
      </div>
    );
  }

  const showLogo = settings?.receiptShowLogo ?? true;
  const showQr = settings?.receiptShowQr ?? true;
  const isReprintNext = receipt.snapshot.printCount >= 1;
  const activeAdapter = getPrinterAdapter(driverId);

  return (
    <div className="space-y-4">
      {/* Control Toolbar (hidden on print) */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 no-print">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Kembali
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold text-slate-900 font-mono truncate">
                {receipt.snapshot.receiptNumber}
              </h2>
              <p className="text-[11px] text-slate-500 tabular-nums">
                {receipt.snapshot.printCount === 0
                  ? 'Belum pernah dicetak'
                  : `Sudah dicetak ${receipt.snapshot.printCount}× · Terakhir ${
                      receipt.snapshot.lastPrintedAt
                        ? formatDateTime(receipt.snapshot.lastPrintedAt)
                        : '—'
                    }`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!isPublicMode && (
              <>
                <button
                  type="button"
                  onClick={() => void handleCopyDigitalLink()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors"
                >
                  {copiedLink ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  {copiedLink ? 'Tautan Disalin' : 'Salin Link Digital'}
                </button>
                <a
                  href={receipt.digitalReceiptPath}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Buka Struk Digital
                </a>
              </>
            )}

            <button
              type="button"
              onClick={() => void handlePrintOrReprint('digital-html-export')}
              disabled={printing}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              Unduh HTML
            </button>

            <button
              type="button"
              onClick={() => void handlePrintOrReprint()}
              disabled={printing}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors disabled:opacity-50"
            >
              <Printer className="w-3.5 h-3.5" />
              {printing
                ? 'Memproses...'
                : isReprintNext && !isPublicMode
                ? `Cetak Ulang (Salinan #${receipt.snapshot.printCount + 1})`
                : 'Cetak Struk'}
            </button>
          </div>
        </div>

        {/* Format & Printer Adapter Bar */}
        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Pilih ukuran kertas struk">
            {FORMAT_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setFormat(opt.id)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                  format === opt.id
                    ? 'bg-teal-50 text-teal-800 border-teal-300'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label htmlFor="printer-driver-select" className="text-slate-500 font-medium">
              Metode Cetak:
            </label>
            <select
              id="printer-driver-select"
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
              className="text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              {AVAILABLE_PRINTER_ADAPTERS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="text-[11px] text-slate-500">
          {activeAdapter.description} Data nominal struk menggunakan arsip harga transaksi historis
          dan tidak dihitung ulang dari katalog saat ini.
        </p>

        {printerAlert && (
          <div
            className={`p-3 text-xs rounded-lg border ${
              printerAlert.type === 'error'
                ? 'bg-rose-50 border-rose-200 text-rose-800'
                : 'bg-emerald-50 border-emerald-200 text-emerald-800'
            }`}
          >
            {printerAlert.message}
          </div>
        )}
      </div>

      {/* Main Content: Print Preview + Print History */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div
          className={`${
            isPublicMode ? 'lg:col-span-12' : 'lg:col-span-8'
          } bg-slate-100/80 border border-slate-200 rounded-xl p-4 sm:p-6 overflow-x-auto print-scroll-container`}
        >
          <ReceiptDocument
            receipt={receipt}
            format={format}
            showLogo={showLogo}
            showQr={showQr}
          />
        </div>

        {!isPublicMode && (
          <aside className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-4 space-y-3 no-print">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-slate-500" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                Riwayat Cetak & Cetak Ulang
              </h3>
            </div>

            {receipt.printLogs.length === 0 ? (
              <p className="text-xs text-slate-500 py-3">
                Belum ada log pencetakan fisik untuk transaksi ini. Klik &ldquo;Cetak Struk&rdquo;
                untuk mencatat salinan resmi pertama.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 text-xs">
                {receipt.printLogs.map((log) => (
                  <div key={log.id} className="py-2.5 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">
                        Salinan #{log.copyNumber} ({log.printType === 'ORIGINAL' ? 'Asli' : 'Cetak Ulang'})
                      </span>
                      <span className="font-mono text-[11px] text-slate-600">
                        {log.layoutFormat}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Oleh {log.printedByName} · {formatDateTime(log.createdAt)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
