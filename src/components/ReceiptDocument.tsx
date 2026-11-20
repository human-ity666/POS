import type { ReceiptData, ReceiptLayoutFormat } from '../types';
import { formatDateTime, formatRupiah } from '../utils/format';
import { ReceiptQrCode } from './ReceiptQrCode';

interface ReceiptDocumentProps {
  receipt: ReceiptData;
  format: ReceiptLayoutFormat;
  showLogo?: boolean;
  showQr?: boolean;
}

export function ReceiptDocument({
  receipt,
  format,
  showLogo = true,
  showQr = true,
}: ReceiptDocumentProps) {
  const { transaction: trx, snapshot, qrPayload } = receipt;
  const hasSplitPayments = (trx.payments?.length ?? 0) > 1;
  const isReprint = snapshot.printCount > 1;
  const copyTag = isReprint ? `SALINAN CETAK ULANG #${snapshot.printCount}` : 'STRUK ASLI';
  const displayLogo = showLogo && Boolean(snapshot.storeLogoUrl);

  if (format === 'A4') {
    return (
      <article
        className="print-area receipt-paper-a4 bg-white border border-slate-200 rounded-lg p-6 sm:p-8 text-slate-900 mx-auto"
        aria-label={`Struk A4 ${snapshot.receiptNumber}`}
      >
        {/* Top Store & Document Header */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-5 pb-5 border-b border-slate-300">
          <div className="flex items-start gap-4">
            {displayLogo && (
              <img
                src={snapshot.storeLogoUrl}
                alt={`Logo ${snapshot.storeName}`}
                className="w-16 h-16 object-contain rounded border border-slate-200 bg-white p-1 shrink-0"
              />
            )}
            <div>
              <h2 className="text-lg font-bold text-slate-900">{snapshot.storeName}</h2>
              {snapshot.storeAddress && (
                <p className="text-xs text-slate-600 mt-0.5">{snapshot.storeAddress}</p>
              )}
              {snapshot.storePhone && (
                <p className="text-xs text-slate-600">Telp: {snapshot.storePhone}</p>
              )}
              {snapshot.receiptHeaderNote && (
                <p className="text-xs text-slate-700 mt-1 italic">{snapshot.receiptHeaderNote}</p>
              )}
            </div>
          </div>

          <div className="sm:text-right space-y-1">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Bukti Pembayaran Resmi · {copyTag}
            </p>
            <p className="font-mono text-base font-bold text-slate-900 tabular-nums">
              {snapshot.receiptNumber}
            </p>
            <p className="font-mono text-xs text-slate-600 tabular-nums">
              {formatDateTime(trx.completedAt || trx.createdAt)}
            </p>
          </div>
        </div>

        {/* Metadata Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 py-4 border-b border-slate-200 text-xs">
          <div>
            <p className="text-slate-500">Pelanggan</p>
            <p className="font-semibold text-slate-900 mt-0.5">
              {trx.customerName || 'Pelanggan Umum'}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Kasir Bertugas</p>
            <p className="font-semibold text-slate-900 mt-0.5">{trx.cashierName}</p>
          </div>
          <div>
            <p className="text-slate-500">Metode Pembayaran</p>
            <p className="font-semibold text-slate-900 mt-0.5">{trx.paymentMethod}</p>
          </div>
        </div>

        {/* Items Table */}
        <div className="py-4 overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-300 text-[11px] font-semibold text-slate-600">
                <th className="py-2 pr-3">Nama Produk</th>
                <th className="py-2 px-2 text-right">Qty</th>
                <th className="py-2 px-2 text-right">Harga Satuan</th>
                <th className="py-2 px-2 text-right">Diskon Item</th>
                <th className="py-2 pl-2 text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 tabular-nums">
              {trx.items.map((item, idx) => (
                <tr key={`${item.productId}-${idx}`}>
                  <td className="py-2.5 pr-3">
                    <p className="font-semibold text-slate-900">{item.name}</p>
                    <p className="font-mono text-[11px] text-slate-500">
                      {item.sku ? `${item.sku} · ` : ''}
                      {item.barcode}
                      {item.priceOverride ? ' · Harga Khusus' : ''}
                    </p>
                    {(item.promotionDiscountAmount ?? 0) > 0 && (
                      <p className="text-[10px] text-teal-700">
                        {item.promotionName || 'Promo'} (-{formatRupiah(item.promotionDiscountAmount ?? 0)})
                      </p>
                    )}
                  </td>
                  <td className="py-2.5 px-2 text-right font-mono whitespace-nowrap">
                    {item.qty} {item.unit}
                  </td>
                  <td className="py-2.5 px-2 text-right font-mono whitespace-nowrap">
                    {formatRupiah(item.sellPrice)}
                  </td>
                  <td className="py-2.5 px-2 text-right font-mono text-rose-700 whitespace-nowrap">
                    {(item.lineDiscountAmount ?? 0) + (item.promotionDiscountAmount ?? 0) > 0
                      ? `-${formatRupiah(
                          (item.lineDiscountAmount ?? 0) + (item.promotionDiscountAmount ?? 0)
                        )}`
                      : '—'}
                  </td>
                  <td className="py-2.5 pl-2 text-right font-mono font-semibold text-slate-900 whitespace-nowrap">
                    {formatRupiah(item.subtotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Summary + QR Footer */}
        <div className="pt-4 border-t border-slate-300 grid grid-cols-1 sm:grid-cols-12 gap-6 items-start">
          <div className="sm:col-span-6 space-y-3 text-xs">
            {trx.payments && trx.payments.length > 0 && (
              <div className="space-y-1">
                <p className="font-semibold text-slate-700">Rincian Pembayaran</p>
                {trx.payments.map((p) => (
                  <div key={p.id} className="flex justify-between gap-2 text-slate-600 tabular-nums">
                    <span>
                      {p.paymentMethodName}
                      {p.referenceNumber ? ` (Ref: ${p.referenceNumber})` : ''}
                    </span>
                    <span className="font-mono text-slate-900">{formatRupiah(p.tenderedAmount)}</span>
                  </div>
                ))}
              </div>
            )}
            {trx.notes && (
              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded text-slate-700">
                Catatan: {trx.notes}
              </div>
            )}
            {showQr && (
              <div className="flex items-center gap-3 pt-1">
                <ReceiptQrCode value={qrPayload} size={84} />
                <div className="text-[11px] text-slate-600 space-y-0.5">
                  <p className="font-semibold text-slate-800">Struk Digital Terverifikasi</p>
                  <p>Pindai QR untuk melihat salinan struk digital resmi.</p>
                  <p className="font-mono text-[10px] text-slate-500">
                    Token: {snapshot.verificationToken.slice(0, 12)}
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="sm:col-span-6 space-y-1.5 text-xs tabular-nums">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal</span>
              <span className="font-mono">{formatRupiah(trx.subtotal)}</span>
            </div>
            {trx.lineDiscountTotal > 0 && (
              <div className="flex justify-between text-rose-700">
                <span>Diskon Item</span>
                <span className="font-mono">-{formatRupiah(trx.lineDiscountTotal)}</span>
              </div>
            )}
            {(trx.promotionDiscountAmount ?? 0) > 0 && (
              <div className="flex justify-between text-teal-700">
                <span>Diskon Promosi</span>
                <span className="font-mono">-{formatRupiah(trx.promotionDiscountAmount ?? 0)}</span>
              </div>
            )}
            {trx.transactionDiscountAmount > 0 && (
              <div className="flex justify-between text-rose-700">
                <span>Diskon Transaksi</span>
                <span className="font-mono">-{formatRupiah(trx.transactionDiscountAmount)}</span>
              </div>
            )}
            {(trx.loyaltyDiscountAmount ?? 0) > 0 && (
              <div className="flex justify-between text-teal-700">
                <span>Tukar Poin ({trx.loyaltyPointsRedeemed ?? 0} poin)</span>
                <span className="font-mono">-{formatRupiah(trx.loyaltyDiscountAmount ?? 0)}</span>
              </div>
            )}
            {trx.lineDiscountTotal === 0 &&
              trx.transactionDiscountAmount === 0 &&
              (trx.promotionDiscountAmount ?? 0) === 0 &&
              (trx.loyaltyDiscountAmount ?? 0) === 0 &&
              trx.discountAmount > 0 && (
                <div className="flex justify-between text-rose-700">
                  <span>Diskon</span>
                  <span className="font-mono">-{formatRupiah(trx.discountAmount)}</span>
                </div>
              )}
            {trx.taxAmount > 0 && (
              <div className="flex justify-between text-slate-600">
                <span>PPN ({snapshot.taxRate}%)</span>
                <span className="font-mono">{formatRupiah(trx.taxAmount)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold text-slate-900 pt-2 border-t border-slate-300">
              <span>GRAND TOTAL</span>
              <span className="font-mono">{formatRupiah(trx.total)}</span>
            </div>
            <div className="flex justify-between text-slate-700 pt-1">
              <span>Dibayar</span>
              <span className="font-mono">{formatRupiah(trx.cashReceived)}</span>
            </div>
            <div className="flex justify-between font-semibold text-slate-900">
              <span>Kembalian</span>
              <span className="font-mono">{formatRupiah(trx.changeAmount)}</span>
            </div>
            {((trx.loyaltyPointsEarned ?? 0) > 0 || (trx.loyaltyPointsRedeemed ?? 0) > 0) && (
              <div className="flex justify-between text-[11px] text-teal-800 pt-1 border-t border-dashed border-slate-200">
                <span>Poin Member</span>
                <span className="font-mono font-semibold">
                  {(trx.loyaltyPointsEarned ?? 0) > 0 ? `+${trx.loyaltyPointsEarned} didapat` : ''}
                  {(trx.loyaltyPointsEarned ?? 0) > 0 && (trx.loyaltyPointsRedeemed ?? 0) > 0
                    ? ' / '
                    : ''}
                  {(trx.loyaltyPointsRedeemed ?? 0) > 0
                    ? `-${trx.loyaltyPointsRedeemed} ditukar`
                    : ''}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 pt-3 border-t border-dashed border-slate-300 text-center text-xs text-slate-500">
          {snapshot.receiptFooter}
        </div>
      </article>
    );
  }

  // Thermal (58mm / 80mm) & Digital Card Layout
  const paperClass =
    format === '58mm'
      ? 'receipt-paper-58mm p-3 text-[11px]'
      : format === 'DIGITAL'
      ? 'receipt-paper-digital p-5 text-xs'
      : 'receipt-paper-80mm p-4 text-xs';

  return (
    <article
      className={`print-area ${paperClass} bg-white border border-slate-200 rounded-lg font-mono text-slate-900 mx-auto`}
      aria-label={`Struk ${format} ${snapshot.receiptNumber}`}
    >
      {/* Header */}
      <div className="text-center border-b border-dashed border-slate-300 pb-3 mb-3">
        {displayLogo && (
          <img
            src={snapshot.storeLogoUrl}
            alt={`Logo ${snapshot.storeName}`}
            className={`mx-auto mb-2 object-contain ${
              format === '58mm' ? 'max-h-10' : 'max-h-14'
            }`}
          />
        )}
        <p
          className={`font-sans font-bold text-slate-900 ${
            format === '58mm' ? 'text-xs' : 'text-sm'
          }`}
        >
          {snapshot.storeName}
        </p>
        {snapshot.storeAddress && (
          <p className="text-[10px] text-slate-600 mt-0.5 leading-snug">{snapshot.storeAddress}</p>
        )}
        {snapshot.storePhone && (
          <p className="text-[10px] text-slate-600">Telp: {snapshot.storePhone}</p>
        )}
        {snapshot.receiptHeaderNote && (
          <p className="font-sans text-[10px] text-slate-700 mt-1">{snapshot.receiptHeaderNote}</p>
        )}
        <p className="text-[10px] font-bold tracking-wider text-slate-500 mt-1.5">{copyTag}</p>
      </div>

      {/* Transaction Meta */}
      <div className="space-y-1 text-[10px] sm:text-[11px] border-b border-dashed border-slate-300 pb-2.5 mb-2.5">
        <div className="flex justify-between gap-2">
          <span className="text-slate-500">No. Struk</span>
          <span className="font-semibold tabular-nums text-right">{snapshot.receiptNumber}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-slate-500">Tanggal</span>
          <span className="tabular-nums text-right">
            {formatDateTime(trx.completedAt || trx.createdAt)}
          </span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-slate-500">Kasir</span>
          <span className="text-right">{trx.cashierName}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-slate-500">Pelanggan</span>
          <span className="text-right">{trx.customerName || 'Pelanggan Umum'}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-slate-500">Pembayaran</span>
          <span className="font-medium text-right">{trx.paymentMethod}</span>
        </div>
      </div>

      {/* Items */}
      <div className="space-y-2 border-b border-dashed border-slate-300 pb-2.5 mb-2.5">
        {trx.items.map((item, idx) => (
          <div key={`${item.productId}-${idx}`} className="space-y-0.5">
            <p className="font-sans font-semibold text-slate-900 leading-snug">{item.name}</p>
            <div className="flex justify-between gap-2 text-[10px] sm:text-[11px] text-slate-600 tabular-nums">
              <span>
                {item.qty} {item.unit} × {formatRupiah(item.sellPrice)}
                {item.priceOverride ? ' *' : ''}
              </span>
              <span className="font-semibold text-slate-900">{formatRupiah(item.subtotal)}</span>
            </div>
            {(item.lineDiscountAmount ?? 0) > 0 && (
              <div className="flex justify-between text-[10px] text-rose-700 tabular-nums">
                <span>Diskon item</span>
                <span>-{formatRupiah(item.lineDiscountAmount ?? 0)}</span>
              </div>
            )}
            {(item.promotionDiscountAmount ?? 0) > 0 && (
              <div className="flex justify-between text-[10px] text-teal-700 tabular-nums">
                <span>{item.promotionName || 'Promo'}</span>
                <span>-{formatRupiah(item.promotionDiscountAmount ?? 0)}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Totals */}
      <div className="space-y-1 text-[10px] sm:text-[11px] tabular-nums">
        <div className="flex justify-between">
          <span className="text-slate-600">Subtotal</span>
          <span>{formatRupiah(trx.subtotal)}</span>
        </div>
        {trx.lineDiscountTotal > 0 && (
          <div className="flex justify-between text-rose-700">
            <span>Diskon Item</span>
            <span>-{formatRupiah(trx.lineDiscountTotal)}</span>
          </div>
        )}
        {(trx.promotionDiscountAmount ?? 0) > 0 && (
          <div className="flex justify-between text-teal-700">
            <span>Diskon Promosi</span>
            <span>-{formatRupiah(trx.promotionDiscountAmount ?? 0)}</span>
          </div>
        )}
        {trx.transactionDiscountAmount > 0 && (
          <div className="flex justify-between text-rose-700">
            <span>Diskon Transaksi</span>
            <span>-{formatRupiah(trx.transactionDiscountAmount)}</span>
          </div>
        )}
        {(trx.loyaltyDiscountAmount ?? 0) > 0 && (
          <div className="flex justify-between text-teal-700">
            <span>Tukar Poin ({trx.loyaltyPointsRedeemed ?? 0})</span>
            <span>-{formatRupiah(trx.loyaltyDiscountAmount ?? 0)}</span>
          </div>
        )}
        {trx.lineDiscountTotal === 0 &&
          trx.transactionDiscountAmount === 0 &&
          (trx.promotionDiscountAmount ?? 0) === 0 &&
          (trx.loyaltyDiscountAmount ?? 0) === 0 &&
          trx.discountAmount > 0 && (
            <div className="flex justify-between text-rose-700">
              <span>Diskon</span>
              <span>-{formatRupiah(trx.discountAmount)}</span>
            </div>
          )}
        {trx.taxAmount > 0 && (
          <div className="flex justify-between">
            <span className="text-slate-600">PPN ({snapshot.taxRate}%)</span>
            <span>{formatRupiah(trx.taxAmount)}</span>
          </div>
        )}
        <div
          className={`flex justify-between font-bold text-slate-900 pt-1.5 border-t border-slate-200 ${
            format === '58mm' ? 'text-xs' : 'text-sm'
          }`}
        >
          <span>TOTAL</span>
          <span>{formatRupiah(trx.total)}</span>
        </div>

        {hasSplitPayments && trx.payments ? (
          <div className="pt-1.5 border-t border-dashed border-slate-200 space-y-0.5">
            {trx.payments.map((p) => (
              <div key={p.id} className="flex justify-between text-[10px]">
                <span className="text-slate-600">
                  {p.paymentMethodName}
                  {p.referenceNumber ? ` (${p.referenceNumber})` : ''}
                </span>
                <span>{formatRupiah(p.tenderedAmount)}</span>
              </div>
            ))}
          </div>
        ) : (
          trx.payments?.[0]?.referenceNumber && (
            <div className="flex justify-between text-[10px] text-slate-500 pt-1">
              <span>Ref. Pembayaran</span>
              <span>{trx.payments[0].referenceNumber}</span>
            </div>
          )
        )}

        <div className="flex justify-between pt-1">
          <span className="text-slate-600">Dibayar</span>
          <span>{formatRupiah(trx.cashReceived)}</span>
        </div>
        <div className="flex justify-between font-semibold">
          <span className="text-slate-600">Kembalian</span>
          <span>{formatRupiah(trx.changeAmount)}</span>
        </div>
        {((trx.loyaltyPointsEarned ?? 0) > 0 || (trx.loyaltyPointsRedeemed ?? 0) > 0) && (
          <div className="flex justify-between text-[10px] text-teal-800 pt-1 border-t border-dashed border-slate-200">
            <span>Poin Member</span>
            <span>
              {(trx.loyaltyPointsEarned ?? 0) > 0 ? `+${trx.loyaltyPointsEarned}` : ''}
              {(trx.loyaltyPointsEarned ?? 0) > 0 && (trx.loyaltyPointsRedeemed ?? 0) > 0
                ? ' / '
                : ''}
              {(trx.loyaltyPointsRedeemed ?? 0) > 0 ? `-${trx.loyaltyPointsRedeemed}` : ''}
            </span>
          </div>
        )}
      </div>

      {trx.notes && (
        <div className="mt-2.5 pt-2 border-t border-dashed border-slate-200 text-[10px] text-slate-600 font-sans">
          Catatan: {trx.notes}
        </div>
      )}

      {showQr && (
        <div className="mt-3 pt-3 border-t border-dashed border-slate-300 text-center space-y-1">
          <ReceiptQrCode value={qrPayload} size={format === '58mm' ? 76 : 96} />
          <p className="text-[9px] text-slate-500">
            Scan QR untuk struk digital · {snapshot.verificationToken.slice(0, 10)}
          </p>
        </div>
      )}

      <div className="mt-3 pt-2.5 border-t border-dashed border-slate-300 text-center text-[10px] text-slate-500 font-sans leading-relaxed">
        {snapshot.receiptFooter}
      </div>
    </article>
  );
}
