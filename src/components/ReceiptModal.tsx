import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Printer,
  X,
} from 'lucide-react';
import type {
  ReceiptData,
  ReceiptLayoutFormat,
  StoreData,
  StoreSettings,
  Transaction,
} from '../types';
import { apiFetch } from '../utils/api';
import { getPrinterAdapter } from '../services/printerService';
import { ReceiptDocument } from './ReceiptDocument';

interface ReceiptModalProps {
  transaction: Transaction | null;
  settings: StoreSettings;
  onClose: () => void;
  onOpenDetailPage?: (transactionId: string) => void;
  onStoreUpdate?: (store: StoreData) => void;
}

const FORMATS: Array<{ id: ReceiptLayoutFormat; label: string }> = [
  { id: '58mm', label: '58mm' },
  { id: '80mm', label: '80mm' },
  { id: 'A4', label: 'A4' },
  { id: 'DIGITAL', label: 'Digital' },
];

export function ReceiptModal({
  transaction,
  settings,
  onClose,
  onOpenDetailPage,
  onStoreUpdate,
}: ReceiptModalProps) {
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [format, setFormat] = useState<ReceiptLayoutFormat>(
    settings.receiptPaperWidth ?? '80mm'
  );
  const [printing, setPrinting] = useState(false);
  const [printMessage, setPrintMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    setFormat(settings.receiptPaperWidth ?? '80mm');
  }, [settings.receiptPaperWidth, transaction?.id]);

  useEffect(() => {
    if (!transaction) {
      setReceipt(null);
      setLoadError(null);
      setPrintMessage(null);
      return;
    }

    if (transaction.status !== 'COMPLETED') {
      setReceipt(null);
      setLoadError('Struk resmi hanya tersedia untuk transaksi berstatus COMPLETED.');
      return;
    }

    let active = true;
    setLoading(true);
    setLoadError(null);
    setPrintMessage(null);

    apiFetch<{ receipt: ReceiptData }>(
      `/api/transactions/${encodeURIComponent(transaction.id)}/receipt`
    )
      .then((res) => {
        if (active) setReceipt(res.receipt);
      })
      .catch((err) => {
        if (active) {
          setLoadError(
            err instanceof Error ? err.message : 'Gagal memuat arsip struk transaksi.'
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [transaction]);

  if (!transaction) return null;

  const handlePrint = async (driverId: 'browser-dialog' | 'digital-html-export') => {
    if (!receipt) return;
    setPrinting(true);
    setPrintMessage(null);
    try {
      const adapter = getPrinterAdapter(driverId);
      if (!adapter.isAvailable()) {
        setPrintMessage({
          type: 'error',
          text: 'Fitur cetak browser tidak tersedia di perangkat ini. Gunakan tombol Unduh HTML.',
        });
        return;
      }

      const res = await apiFetch<{ receipt: ReceiptData; store: StoreData }>(
        `/api/transactions/${encodeURIComponent(receipt.transaction.id)}/receipt/print`,
        {
          method: 'POST',
          body: JSON.stringify({
            layoutFormat: format,
            driverId,
          }),
        }
      );
      setReceipt(res.receipt);
      onStoreUpdate?.(res.store);

      const out = await adapter.executePrint(res.receipt, format);
      setPrintMessage({
        type: out.ok ? 'success' : 'error',
        text: out.message,
      });
    } catch (err) {
      setPrintMessage({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Gagal mencetak struk. Coba unduh salinan HTML.',
      });
    } finally {
      setPrinting(false);
    }
  };

  const isReprint = (receipt?.snapshot.printCount ?? 0) >= 1;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-3 sm:p-4 print-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Struk Pembayaran"
    >
      <div
        className={`bg-white border border-slate-200 rounded-xl w-full ${
          format === 'A4' ? 'max-w-4xl' : 'max-w-lg'
        } overflow-hidden shadow-xl print-modal-panel`}
      >
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-slate-200 no-print">
          <div className="flex items-center gap-2 min-w-0">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <h3 className="text-sm font-semibold text-slate-900 truncate">
              Struk Transaksi {transaction.invoiceNumber}
            </h3>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {onOpenDetailPage && transaction.status === 'COMPLETED' && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenDetailPage(transaction.id);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 rounded-md transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                Halaman Struk
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors"
              aria-label="Tutup struk"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Paper width selector + printer status */}
        <div className="px-4 sm:px-5 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 no-print">
          <div className="flex items-center gap-1">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFormat(f.id)}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-colors ${
                  format === f.id
                    ? 'bg-teal-700 text-white border-teal-700'
                    : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {receipt && (
            <span className="font-mono text-[11px] text-slate-500">
              {receipt.snapshot.printCount === 0
                ? 'Belum dicetak'
                : `Cetakan ke-${receipt.snapshot.printCount}`}
            </span>
          )}
        </div>

        {printMessage && (
          <div
            className={`mx-4 mt-3 p-2.5 text-xs rounded-lg border no-print ${
              printMessage.type === 'error'
                ? 'bg-rose-50 border-rose-200 text-rose-800'
                : 'bg-emerald-50 border-emerald-200 text-emerald-800'
            }`}
          >
            {printMessage.text}
          </div>
        )}

        <div className="p-4 sm:p-5 max-h-[66vh] overflow-y-auto bg-slate-100/70 print-scroll-container">
          {loading ? (
            <div className="py-12 text-center text-xs text-slate-500">
              Menyiapkan pratinjau struk...
            </div>
          ) : loadError ? (
            <div className="p-4 bg-white border border-rose-200 rounded-lg text-center text-xs text-rose-700 space-y-2">
              <AlertTriangle className="w-5 h-5 mx-auto text-rose-600" />
              <p>{loadError}</p>
            </div>
          ) : receipt ? (
            <ReceiptDocument
              receipt={receipt}
              format={format}
              showLogo={settings.receiptShowLogo ?? true}
              showQr={settings.receiptShowQr ?? true}
            />
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 py-3.5 border-t border-slate-200 bg-white no-print">
          <button
            type="button"
            disabled={!receipt || printing}
            onClick={() => void handlePrint('digital-html-export')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            Unduh HTML
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!receipt || printing}
              onClick={() => void handlePrint('browser-dialog')}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Printer className="w-3.5 h-3.5" />
              {printing
                ? 'Menyiapkan...'
                : isReprint
                ? `Cetak Ulang (#${(receipt?.snapshot.printCount ?? 0) + 1})`
                : 'Cetak Struk'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0"
            >
              Selesai
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
