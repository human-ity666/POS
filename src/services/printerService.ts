import type { ReceiptData, ReceiptLayoutFormat } from '../types';
import { formatDateTime, formatRupiah } from '../utils/format';

export interface PrinterPrintResult {
  ok: boolean;
  driverId: string;
  driverName: string;
  message: string;
}

export interface ReceiptPrintAdapter {
  id: string;
  name: string;
  description: string;
  isHardwareDirect: boolean;
  isAvailable: () => boolean;
  executePrint: (receipt: ReceiptData, format: ReceiptLayoutFormat) => Promise<PrinterPrintResult>;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildStandaloneReceiptHtml(
  receipt: ReceiptData,
  format: ReceiptLayoutFormat,
  qrDataUrl?: string | null
): string {
  const { transaction: trx, snapshot } = receipt;
  const maxWidth =
    format === '58mm' ? '58mm' : format === '80mm' ? '80mm' : format === 'A4' ? '190mm' : '440px';
  const copyLabel =
    snapshot.printCount > 1 ? `SALINAN #${snapshot.printCount}` : 'STRUK ASLI';

  const itemsHtml = trx.items
    .map(
      (item) => `
      <tr>
        <td style="padding:4px 0;vertical-align:top;">
          <div style="font-weight:600;">${escapeHtml(item.name)}</div>
          <div style="font-size:11px;color:#475569;">${item.qty} ${escapeHtml(item.unit)} × ${escapeHtml(
        formatRupiah(item.sellPrice)
      )}${item.priceOverride ? ' *' : ''}</div>
          ${
            (item.lineDiscountAmount ?? 0) > 0
              ? `<div style="font-size:10px;color:#be123c;">Diskon item: -${escapeHtml(
                  formatRupiah(item.lineDiscountAmount ?? 0)
                )}</div>`
              : ''
          }
        </td>
        <td style="padding:4px 0;text-align:right;vertical-align:top;font-family:monospace;font-weight:600;">
          ${escapeHtml(formatRupiah(item.subtotal))}
        </td>
      </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Struk ${escapeHtml(snapshot.receiptNumber)} — ${escapeHtml(snapshot.storeName)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 16px; background: #f8fafc; color: #0f172a; }
    .sheet { max-width: ${maxWidth}; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .row { display: flex; justify-content: space-between; font-size: 12px; margin: 3px 0; }
    .divider { border-top: 1px dashed #cbd5e1; margin: 10px 0; }
    @media print { body { background: #fff; padding: 0; } .sheet { border: none; border-radius: 0; padding: 2mm; } }
  </style>
</head>
<body>
  <div class="sheet">
    <div style="text-align:center;">
      ${
        snapshot.storeLogoUrl
          ? `<img src="${escapeHtml(snapshot.storeLogoUrl)}" alt="Logo Toko" style="max-height:48px;margin:0 auto 6px;display:block;object-fit:contain;" />`
          : ''
      }
      <div style="font-size:15px;font-weight:700;">${escapeHtml(snapshot.storeName)}</div>
      ${
        snapshot.storeAddress
          ? `<div style="font-size:11px;color:#475569;margin-top:2px;">${escapeHtml(snapshot.storeAddress)}</div>`
          : ''
      }
      ${
        snapshot.storePhone
          ? `<div style="font-size:11px;color:#475569;">Telp: ${escapeHtml(snapshot.storePhone)}</div>`
          : ''
      }
      ${
        snapshot.receiptHeaderNote
          ? `<div style="font-size:11px;color:#334155;margin-top:4px;">${escapeHtml(snapshot.receiptHeaderNote)}</div>`
          : ''
      }
      <div class="mono" style="font-size:10px;color:#475569;margin-top:6px;">${copyLabel}</div>
    </div>
    <div class="divider"></div>
    <div class="row"><span>No. Struk</span><span class="mono" style="font-weight:700;">${escapeHtml(snapshot.receiptNumber)}</span></div>
    <div class="row"><span>Waktu</span><span class="mono">${escapeHtml(formatDateTime(trx.completedAt || trx.createdAt))}</span></div>
    <div class="row"><span>Kasir</span><span>${escapeHtml(trx.cashierName)}</span></div>
    <div class="row"><span>Pelanggan</span><span>${escapeHtml(trx.customerName || 'Pelanggan Umum')}</span></div>
    <div class="row"><span>Pembayaran</span><span>${escapeHtml(trx.paymentMethod)}</span></div>
    <div class="divider"></div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">${itemsHtml}</table>
    <div class="divider"></div>
    <div class="row"><span>Subtotal</span><span class="mono">${escapeHtml(formatRupiah(trx.subtotal))}</span></div>
    ${
      trx.lineDiscountTotal > 0
        ? `<div class="row" style="color:#be123c;"><span>Diskon Item</span><span class="mono">-${escapeHtml(
            formatRupiah(trx.lineDiscountTotal)
          )}</span></div>`
        : ''
    }
    ${
      trx.transactionDiscountAmount > 0
        ? `<div class="row" style="color:#be123c;"><span>Diskon Transaksi</span><span class="mono">-${escapeHtml(
            formatRupiah(trx.transactionDiscountAmount)
          )}</span></div>`
        : trx.discountAmount > 0
        ? `<div class="row" style="color:#be123c;"><span>Diskon</span><span class="mono">-${escapeHtml(
            formatRupiah(trx.discountAmount)
          )}</span></div>`
        : ''
    }
    ${
      trx.taxAmount > 0
        ? `<div class="row"><span>PPN (${snapshot.taxRate}%)</span><span class="mono">${escapeHtml(
            formatRupiah(trx.taxAmount)
          )}</span></div>`
        : ''
    }
    <div class="row" style="font-size:14px;font-weight:700;padding-top:6px;border-top:1px solid #e2e8f0;">
      <span>TOTAL</span>
      <span class="mono">${escapeHtml(formatRupiah(trx.total))}</span>
    </div>
    <div class="row"><span>Dibayar</span><span class="mono">${escapeHtml(formatRupiah(trx.cashReceived))}</span></div>
    <div class="row" style="font-weight:600;"><span>Kembalian</span><span class="mono">${escapeHtml(formatRupiah(trx.changeAmount))}</span></div>
    ${
      trx.notes
        ? `<div style="margin-top:8px;font-size:11px;color:#475569;">Catatan: ${escapeHtml(trx.notes)}</div>`
        : ''
    }
    ${
      qrDataUrl
        ? `<div style="text-align:center;margin-top:12px;">
            <img src="${qrDataUrl}" alt="QR Verifikasi Struk" style="width:96px;height:96px;margin:0 auto;display:block;" />
            <div class="mono" style="font-size:10px;color:#64748b;margin-top:4px;">Verifikasi Digital: ${escapeHtml(
              snapshot.verificationToken.slice(0, 10)
            )}</div>
          </div>`
        : ''
    }
    <div class="divider"></div>
    <div style="text-align:center;font-size:11px;color:#475569;line-height:1.4;">${escapeHtml(
      snapshot.receiptFooter
    )}</div>
  </div>
</body>
</html>`;
}

/**
 * Browser Print Dialog Adapter.
 * Explicitly declares isHardwareDirect = false so the UI never makes false claims
 * about direct ESC/POS thermal USB/Serial/Bluetooth hardware communication.
 */
export const browserPrintAdapter: ReceiptPrintAdapter = {
  id: 'browser-dialog',
  name: 'Dialog Cetak Browser / OS',
  description:
    'Menggunakan dialog cetak sistem (window.print) dengan CSS khusus 58mm, 80mm, atau A4. Cocok untuk driver printer thermal OS maupun printer kantor A4.',
  isHardwareDirect: false,
  isAvailable: () => typeof window !== 'undefined' && typeof window.print === 'function',
  executePrint: async (_receipt, format) => {
    if (typeof window === 'undefined' || typeof window.print !== 'function') {
      return {
        ok: false,
        driverId: 'browser-dialog',
        driverName: 'Dialog Cetak Browser / OS',
        message:
          'Fungsi cetak browser (window.print) tidak tersedia pada perangkat atau lingkungan ini. Gunakan unduh struk digital HTML sebagai alternatif.',
      };
    }

    try {
      // Allow React DOM flush of selected paper width class before triggering OS print dialog
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 60));
      });
      window.print();
      return {
        ok: true,
        driverId: 'browser-dialog',
        driverName: 'Dialog Cetak Browser / OS',
        message: `Dialog cetak dibuka untuk format ${format}.`,
      };
    } catch (err) {
      return {
        ok: false,
        driverId: 'browser-dialog',
        driverName: 'Dialog Cetak Browser / OS',
        message:
          err instanceof Error
            ? `Printer / dialog cetak diblokir atau gagal dibuka: ${err.message}. Silakan unduh struk digital HTML.`
            : 'Dialog cetak gagal dibuka oleh browser. Silakan unduh struk digital HTML.',
      };
    }
  },
};

/**
 * Digital HTML Receipt Export Adapter (fallback & paperless sharing).
 */
export const digitalExportAdapter: ReceiptPrintAdapter = {
  id: 'digital-html-export',
  name: 'Ekspor Struk Digital (HTML)',
  description:
    'Menyimpan file struk digital mandiri (.html) untuk dibagikan ke pelanggan atau dicetak ulang di perangkat lain tanpa koneksi ke printer lokal.',
  isHardwareDirect: false,
  isAvailable: () => typeof window !== 'undefined' && typeof Blob !== 'undefined',
  executePrint: async (receipt, format) => {
    try {
      const html = buildStandaloneReceiptHtml(receipt, format);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `struk-${receipt.snapshot.receiptNumber}-${format}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return {
        ok: true,
        driverId: 'digital-html-export',
        driverName: 'Ekspor Struk Digital (HTML)',
        message: `File struk digital ${receipt.snapshot.receiptNumber} (${format}) berhasil diunduh.`,
      };
    } catch (err) {
      return {
        ok: false,
        driverId: 'digital-html-export',
        driverName: 'Ekspor Struk Digital (HTML)',
        message:
          err instanceof Error
            ? `Gagal mengekspor struk digital: ${err.message}`
            : 'Gagal mengekspor struk digital.',
      };
    }
  },
};

export const AVAILABLE_PRINTER_ADAPTERS: ReceiptPrintAdapter[] = [
  browserPrintAdapter,
  digitalExportAdapter,
];

export function getPrinterAdapter(driverId?: string): ReceiptPrintAdapter {
  return (
    AVAILABLE_PRINTER_ADAPTERS.find((a) => a.id === driverId) ?? browserPrintAdapter
  );
}
