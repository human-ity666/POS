import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getDb, getStoreUploadsDir } from '../db/database.ts';
import { recordAuditLog } from './auditService.ts';
import { getTransactionById } from './checkoutService.ts';
import { ServiceError } from './errors.ts';
import { querySettings } from './posService.ts';
import type {
  ReceiptData,
  ReceiptLayoutFormat,
  ReceiptPrintLog,
  ReceiptSnapshot,
  StoreSettings,
  UserSummary,
} from '../../src/types.ts';

const VALID_LAYOUT_FORMATS: ReadonlySet<ReceiptLayoutFormat> = new Set([
  '58mm',
  '80mm',
  'A4',
  'DIGITAL',
]);

const ALLOWED_LOGO_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

function validateImageMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 12) return false;
  if (mimeType === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    );
  }
  if (mimeType === 'image/webp') {
    return (
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

interface SnapshotRow {
  transaction_id: string;
  receipt_number: string;
  verification_token: string;
  store_name: string;
  store_address: string;
  store_phone: string;
  store_logo_url: string;
  receipt_header_note: string;
  receipt_footer: string;
  tax_rate: number;
  print_count: number;
  last_printed_at: string | null;
  created_at: string;
}

function mapSnapshotRow(row: SnapshotRow): ReceiptSnapshot {
  return {
    transactionId: row.transaction_id,
    receiptNumber: row.receipt_number,
    verificationToken: row.verification_token,
    storeName: row.store_name,
    storeAddress: row.store_address,
    storePhone: row.store_phone,
    storeLogoUrl: row.store_logo_url,
    receiptHeaderNote: row.receipt_header_note,
    receiptFooter: row.receipt_footer,
    taxRate: Number(row.tax_rate ?? 0),
    printCount: Number(row.print_count ?? 0),
    lastPrintedAt: row.last_printed_at,
    createdAt: row.created_at,
  };
}

/**
 * Captures an immutable snapshot of store header/footer/logo/tax metadata at
 * checkout time so reprints NEVER reflect later edits to product prices or store settings.
 */
export function captureReceiptSnapshotTx(
  db: DatabaseSync,
  transactionId: string,
  receiptNumber: string,
  createdAtIso: string
): void {
  const settingsRow = db
    .prepare(`
      SELECT store_name, store_address, store_phone, store_logo_url,
             receipt_header_note, receipt_footer, tax_rate, receipt_show_logo
      FROM store_settings
      WHERE id = 1
    `)
    .get() as
    | {
        store_name: string;
        store_address: string;
        store_phone: string;
        store_logo_url: string;
        receipt_header_note: string;
        receipt_footer: string;
        tax_rate: number;
        receipt_show_logo: number;
      }
    | undefined;

  const verificationToken = randomBytes(12).toString('hex');
  const logoUrl =
    settingsRow && settingsRow.receipt_show_logo === 1 ? settingsRow.store_logo_url : '';

  db.prepare(`
    INSERT OR IGNORE INTO receipt_snapshots (
      transaction_id, receipt_number, verification_token,
      store_name, store_address, store_phone, store_logo_url,
      receipt_header_note, receipt_footer, tax_rate,
      print_count, last_printed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
  `).run(
    transactionId,
    receiptNumber,
    verificationToken,
    settingsRow?.store_name ?? 'KassaRitel',
    settingsRow?.store_address ?? '',
    settingsRow?.store_phone ?? '',
    logoUrl,
    settingsRow?.receipt_header_note ?? '',
    settingsRow?.receipt_footer ?? '',
    settingsRow?.tax_rate ?? 0,
    createdAtIso
  );
}

function getOrCreateSnapshot(db: DatabaseSync, transactionId: string, receiptNumber: string, createdAt: string): ReceiptSnapshot {
  const existing = db
    .prepare(`
      SELECT transaction_id, receipt_number, verification_token,
             store_name, store_address, store_phone, store_logo_url,
             receipt_header_note, receipt_footer, tax_rate,
             print_count, last_printed_at, created_at
      FROM receipt_snapshots
      WHERE transaction_id = ?
    `)
    .get(transactionId) as SnapshotRow | undefined;

  if (existing) {
    return mapSnapshotRow(existing);
  }

  captureReceiptSnapshotTx(db, transactionId, receiptNumber, createdAt);
  const created = db
    .prepare(`
      SELECT transaction_id, receipt_number, verification_token,
             store_name, store_address, store_phone, store_logo_url,
             receipt_header_note, receipt_footer, tax_rate,
             print_count, last_printed_at, created_at
      FROM receipt_snapshots
      WHERE transaction_id = ?
    `)
    .get(transactionId) as SnapshotRow | undefined;

  if (!created) {
    throw new ServiceError(500, 'Gagal membuat snapshot struk transaksi.');
  }

  return mapSnapshotRow(created);
}

function listPrintLogsForTransaction(db: DatabaseSync, transactionId: string): ReceiptPrintLog[] {
  const rows = db
    .prepare(`
      SELECT id, transaction_id, copy_number, print_type, layout_format,
             driver_id, printed_by_user_id, printed_by_name, created_at
      FROM receipt_print_logs
      WHERE transaction_id = ?
      ORDER BY copy_number DESC, created_at DESC
    `)
    .all(transactionId) as Array<{
    id: string;
    transaction_id: string;
    copy_number: number;
    print_type: 'ORIGINAL' | 'REPRINT';
    layout_format: ReceiptLayoutFormat;
    driver_id: string;
    printed_by_user_id: string | null;
    printed_by_name: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    transactionId: r.transaction_id,
    copyNumber: r.copy_number,
    printType: r.print_type,
    layoutFormat: r.layout_format,
    driverId: r.driver_id,
    printedByUserId: r.printed_by_user_id,
    printedByName: r.printed_by_name,
    createdAt: r.created_at,
  }));
}

export function getReceiptData(
  transactionIdOrInvoice: string,
  options: { publicToken?: string; originUrl?: string } = {}
): ReceiptData {
  const transaction = getTransactionById(transactionIdOrInvoice);
  if (transaction.status !== 'COMPLETED') {
    throw new ServiceError(
      409,
      `Struk resmi hanya tersedia untuk transaksi selesai (status saat ini: ${transaction.status}).`
    );
  }

  const db = getDb();
  const snapshot = getOrCreateSnapshot(
    db,
    transaction.id,
    transaction.invoiceNumber,
    transaction.completedAt || transaction.createdAt
  );

  if (options.publicToken !== undefined) {
    const provided = options.publicToken.trim();
    const expected = snapshot.verificationToken;
    const valid =
      provided.length === expected.length &&
      provided.length > 0 &&
      timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));

    if (!valid) {
      throw new ServiceError(403, 'Token verifikasi struk digital tidak valid atau sudah kedaluwarsa.');
    }
  }

  const printLogs = listPrintLogsForTransaction(db, transaction.id);
  const digitalReceiptPath = `/?receipt=${encodeURIComponent(transaction.id)}&token=${encodeURIComponent(
    snapshot.verificationToken
  )}`;
  const cleanOrigin = options.originUrl ? options.originUrl.replace(/\/+$/, '') : '';
  const qrPayload = cleanOrigin ? `${cleanOrigin}${digitalReceiptPath}` : digitalReceiptPath;

  return {
    transaction,
    snapshot,
    printLogs,
    qrPayload,
    digitalReceiptPath,
  };
}

export function recordReceiptPrint(
  transactionIdOrInvoice: string,
  input: { layoutFormat?: unknown; driverId?: unknown },
  actor: UserSummary,
  originUrl?: string
): { receipt: ReceiptData; printLog: ReceiptPrintLog } {
  const transaction = getTransactionById(transactionIdOrInvoice);
  if (transaction.status !== 'COMPLETED') {
    throw new ServiceError(
      409,
      'Hanya transaksi yang sudah selesai (COMPLETED) yang dapat dicetak atau dicetak ulang.'
    );
  }

  const rawLayout =
    typeof input.layoutFormat === 'string' ? input.layoutFormat.trim() : '80mm';
  if (!VALID_LAYOUT_FORMATS.has(rawLayout as ReceiptLayoutFormat)) {
    throw new ServiceError(400, 'Format layout struk harus 58mm, 80mm, A4, atau DIGITAL.');
  }
  const layoutFormat = rawLayout as ReceiptLayoutFormat;

  const driverId =
    typeof input.driverId === 'string' && input.driverId.trim()
      ? input.driverId.trim().slice(0, 64)
      : 'browser-dialog';

  const db = getDb();
  const nowIso = new Date().toISOString();
  const logId = `rlog-${Date.now()}-${randomUUID().slice(0, 6)}`;

  let copyNumber = 1;
  let printType: 'ORIGINAL' | 'REPRINT' = 'ORIGINAL';

  db.exec('BEGIN IMMEDIATE;');
  try {
    getOrCreateSnapshot(
      db,
      transaction.id,
      transaction.invoiceNumber,
      transaction.completedAt || transaction.createdAt
    );

    const updated = db
      .prepare(`
        UPDATE receipt_snapshots
        SET print_count = print_count + 1,
            last_printed_at = ?
        WHERE transaction_id = ?
        RETURNING print_count
      `)
      .get(nowIso, transaction.id) as { print_count: number };

    copyNumber = updated.print_count;
    printType = copyNumber === 1 ? 'ORIGINAL' : 'REPRINT';

    db.prepare(`
      INSERT INTO receipt_print_logs (
        id, transaction_id, copy_number, print_type, layout_format,
        driver_id, printed_by_user_id, printed_by_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      logId,
      transaction.id,
      copyNumber,
      printType,
      layoutFormat,
      driverId,
      actor.id,
      actor.fullName,
      nowIso
    );

    recordAuditLog(db, {
      action: printType === 'ORIGINAL' ? 'RECEIPT_PRINTED' : 'RECEIPT_REPRINTED',
      entityType: 'receipt',
      entityId: transaction.invoiceNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary:
        printType === 'ORIGINAL'
          ? `Cetak struk asli ${transaction.invoiceNumber} (format ${layoutFormat}, driver ${driverId})`
          : `Cetak ulang struk ${transaction.invoiceNumber} — Salinan #${copyNumber} (format ${layoutFormat}, driver ${driverId})`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const receipt = getReceiptData(transaction.id, { originUrl });
  const printLog = receipt.printLogs.find((l) => l.id === logId) ?? receipt.printLogs[0];
  return { receipt, printLog };
}

// --- Store Logo Upload & Serving ---
export function uploadStoreLogo(
  input: { fileName?: unknown; mimeType?: unknown; dataBase64?: unknown },
  actor: UserSummary
): { settings: StoreSettings; logoUrl: string } {
  const rawData = typeof input.dataBase64 === 'string' ? input.dataBase64.trim() : '';
  if (!rawData) {
    throw new ServiceError(400, 'File logo toko tidak boleh kosong.');
  }

  let mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : '';
  let base64Payload = rawData;
  const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(rawData);
  if (dataUrlMatch) {
    mimeType = mimeType || dataUrlMatch[1].toLowerCase();
    base64Payload = dataUrlMatch[2];
  }

  const ext = ALLOWED_LOGO_MIME_TYPES[mimeType];
  if (!ext) {
    throw new ServiceError(400, 'Logo toko harus berformat PNG, JPG, atau WEBP.');
  }

  const buffer = Buffer.from(base64Payload, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_LOGO_BYTES) {
    throw new ServiceError(400, 'Ukuran logo toko tidak valid atau melebihi batas maksimal 2 MB.');
  }
  if (!validateImageMagicBytes(buffer, mimeType)) {
    throw new ServiceError(400, 'Isi file logo tidak sesuai dengan format PNG/JPG/WEBP yang valid.');
  }

  const storeDir = getStoreUploadsDir();
  if (!fs.existsSync(storeDir)) {
    fs.mkdirSync(storeDir, { recursive: true });
  }

  const diskFileName = `store-logo-${Date.now()}-${randomUUID().slice(0, 6)}.${ext}`;
  const diskPath = path.join(storeDir, diskFileName);
  const logoUrl = `/api/uploads/store/${diskFileName}`;

  const db = getDb();
  const prevRow = db
    .prepare('SELECT store_logo_url FROM store_settings WHERE id = 1')
    .get() as { store_logo_url: string } | undefined;

  fs.writeFileSync(diskPath, buffer);

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('UPDATE store_settings SET store_logo_url = ? WHERE id = 1').run(logoUrl);
    recordAuditLog(db, {
      action: 'STORE_LOGO_UPDATED',
      entityType: 'settings',
      entityId: 'store-settings',
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Unggah logo toko baru (${diskFileName})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
    throw err;
  }

  // Cleanup old logo file if stored locally
  if (prevRow?.store_logo_url?.startsWith('/api/uploads/store/')) {
    const oldName = path.basename(prevRow.store_logo_url);
    const oldPath = path.join(storeDir, oldName);
    if (oldName !== diskFileName && fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  return { settings: querySettings(), logoUrl };
}

export function deleteStoreLogo(actor: UserSummary): { settings: StoreSettings } {
  const db = getDb();
  const prevRow = db
    .prepare('SELECT store_logo_url FROM store_settings WHERE id = 1')
    .get() as { store_logo_url: string } | undefined;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare("UPDATE store_settings SET store_logo_url = '' WHERE id = 1").run();
    recordAuditLog(db, {
      action: 'STORE_LOGO_UPDATED',
      entityType: 'settings',
      entityId: 'store-settings',
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: 'Hapus logo toko dari struk',
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  if (prevRow?.store_logo_url?.startsWith('/api/uploads/store/')) {
    const oldPath = path.join(getStoreUploadsDir(), path.basename(prevRow.store_logo_url));
    if (fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  return { settings: querySettings() };
}

export function resolveStoreLogoPath(requestedName: string): string {
  const safeName = path.basename(requestedName);
  if (!safeName || safeName !== requestedName || !/^[A-Za-z0-9._-]+$/.test(safeName)) {
    throw new ServiceError(400, 'Nama file logo tidak valid.');
  }
  const fullPath = path.join(getStoreUploadsDir(), safeName);
  if (!fs.existsSync(fullPath)) {
    throw new ServiceError(404, 'File logo toko tidak ditemukan.');
  }
  return fullPath;
}
