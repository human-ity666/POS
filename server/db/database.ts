import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildSeedData, type LegacyStoreData } from '../store.ts';
import { hashSecret } from '../utils/crypto.ts';
import type { Permission } from '../../src/types.ts';

let dbInstance: DatabaseSync | null = null;
let currentDbPath: string | null = null;

export function getDbFilePath(): string {
  if (process.env.POS_DB_FILE) {
    return path.resolve(process.env.POS_DB_FILE);
  }
  return path.resolve(process.cwd(), 'data', 'pos.db');
}

export function getProductUploadsDir(): string {
  if (process.env.POS_UPLOADS_DIR) {
    return path.resolve(process.env.POS_UPLOADS_DIR);
  }
  return path.resolve(process.cwd(), 'data', 'uploads', 'products');
}

export function getStoreUploadsDir(): string {
  if (process.env.POS_STORE_UPLOADS_DIR) {
    return path.resolve(process.env.POS_STORE_UPLOADS_DIR);
  }
  if (process.env.POS_UPLOADS_DIR) {
    return path.join(path.dirname(path.resolve(process.env.POS_UPLOADS_DIR)), 'store-uploads');
  }
  return path.resolve(process.cwd(), 'data', 'uploads', 'store');
}

export function getRecognitionUploadsDir(): string {
  if (process.env.POS_RECOGNITION_UPLOADS_DIR) {
    return path.resolve(process.env.POS_RECOGNITION_UPLOADS_DIR);
  }
  if (process.env.POS_UPLOADS_DIR) {
    return path.join(path.dirname(path.resolve(process.env.POS_UPLOADS_DIR)), 'recognition-uploads');
  }
  return path.resolve(process.cwd(), 'data', 'uploads', 'recognition');
}

const DEFAULT_PERMISSIONS: Permission[] = [
  // POS & Kasir
  { id: 'perm-pos-view', code: 'pos:view', module: 'POS & Kasir', action: 'view', label: 'Akses Terminal Kasir', description: 'Membuka layar kasir dan pemindai kamera' },
  { id: 'perm-pos-create', code: 'pos:create', module: 'POS & Kasir', action: 'create', label: 'Buat Transaksi Penjualan', description: 'Memproses pembayaran dan mencetak struk' },
  { id: 'perm-pos-discount', code: 'pos:discount_approve', module: 'POS & Kasir', action: 'approve', label: 'Setujui Diskon Manual', description: 'Memberikan diskon di kasir atau menyetujui via PIN' },
  { id: 'perm-pos-price', code: 'pos:price_override', module: 'POS & Kasir', action: 'execute', label: 'Ubah Harga Jual (Override)', description: 'Otorisasi perubahan harga jual khusus di kasir' },
  { id: 'perm-pos-hold', code: 'pos:hold', module: 'POS & Kasir', action: 'execute', label: 'Tahan Transaksi (Hold)', description: 'Menyimpan sementara keranjang kasir untuk pelanggan lain' },
  { id: 'perm-pos-resume', code: 'pos:resume', module: 'POS & Kasir', action: 'execute', label: 'Lanjutkan Transaksi Hold', description: 'Membuka kembali keranjang transaksi yang ditahan' },
  { id: 'perm-pos-cancel', code: 'pos:cancel', module: 'POS & Kasir', action: 'delete', label: 'Batalkan Draft / Hold Transaksi', description: 'Membatalkan transaksi yang ditahan atau sedang berjalan' },
  { id: 'perm-pos-void', code: 'pos:void', module: 'POS & Kasir', action: 'execute', label: 'Batalkan Transaksi (Void)', description: 'Otorisasi pembatalan struk penjualan' },
  { id: 'perm-pos-refund', code: 'pos:refund', module: 'POS & Kasir', action: 'execute', label: 'Proses Pengembalian (Refund)', description: 'Otorisasi retur barang dan refund dana' },

  // Produk & Katalog Master
  { id: 'perm-prd-view', code: 'products:view', module: 'Produk', action: 'view', label: 'Lihat Katalog Produk', description: 'Melihat daftar SKU, harga, gambar, dan barcode produk' },
  { id: 'perm-prd-create', code: 'products:create', module: 'Produk', action: 'create', label: 'Tambah Produk Baru', description: 'Mendaftarkan SKU, barcode, dan gambar produk baru' },
  { id: 'perm-prd-edit', code: 'products:edit', module: 'Produk', action: 'edit', label: 'Ubah Data Produk', description: 'Mengubah informasi produk, multi-barcode, harga, status, dan gambar' },
  { id: 'perm-prd-delete', code: 'products:delete', module: 'Produk', action: 'delete', label: 'Hapus Produk', description: 'Menghapus SKU produk dari katalog' },
  { id: 'perm-prd-import', code: 'products:import', module: 'Produk', action: 'execute', label: 'Impor & Ekspor Katalog CSV', description: 'Mengimpor produk massal via CSV dan mengekspor katalog' },
  { id: 'perm-cat-manage', code: 'catalog:manage', module: 'Produk', action: 'edit', label: 'Kelola Kategori, Merek & Satuan', description: 'Membuat dan mengubah kategori, subkategori, merek, dan satuan UOM' },

  // Stok & Laporan
  { id: 'perm-stk-view', code: 'stock:view', module: 'Stok & Laporan', action: 'view', label: 'Lihat Posisi & Mutasi Stok', description: 'Melihat stok barang dan laporan stok otomatis' },
  { id: 'perm-stk-adjust', code: 'stock:adjust', module: 'Stok & Laporan', action: 'execute', label: 'Restok & Stok Opname', description: 'Melakukan penambahan stok masuk atau penyesuaian opname fisik' },
  { id: 'perm-rpt-view', code: 'reports:view', module: 'Stok & Laporan', action: 'view', label: 'Lihat Laporan Valuasi & Laba', description: 'Mengakses laporan stok otomatis, nilai modal, dan ekspor CSV' },
  { id: 'perm-trx-view', code: 'transactions:view', module: 'Stok & Laporan', action: 'view', label: 'Lihat Riwayat Transaksi', description: 'Mengakses daftar invoice penjualan dan cetak ulang struk' },

  // Pengaturan & AI
  { id: 'perm-set-edit', code: 'settings:edit', module: 'Pengaturan', action: 'edit', label: 'Ubah Pengaturan Toko & PPN', description: 'Mengubah nama toko, alamat, catatan struk, dan tarif PPN' },
  { id: 'perm-rec-use', code: 'recognition:use', module: 'POS & Kasir', action: 'execute', label: 'Gunakan Pengenalan Produk AI', description: 'Mengambil foto kemasan produk dan mencocokkan dengan katalog menggunakan AI' },
  { id: 'perm-rec-manage', code: 'recognition:manage', module: 'Pengaturan', action: 'edit', label: 'Kelola Provider & Threshold AI', description: 'Mengatur provider AI, batas keyakinan pengenalan produk, dan sinkronisasi embedding gambar referensi' },

  // Pengguna
  { id: 'perm-usr-view', code: 'users:view', module: 'Pengguna', action: 'view', label: 'Lihat Daftar Pengguna', description: 'Melihat akun staf, status aktif, dan detail profil' },
  { id: 'perm-usr-create', code: 'users:create', module: 'Pengguna', action: 'create', label: 'Buat Akun Pengguna', description: 'Menambahkan akun kasir, supervisor, atau admin baru' },
  { id: 'perm-usr-edit', code: 'users:edit', module: 'Pengguna', action: 'edit', label: 'Ubah Pengguna & Reset Password', description: 'Mengubah profil, status aktif, role, password, dan PIN' },
  { id: 'perm-usr-delete', code: 'users:delete', module: 'Pengguna', action: 'delete', label: 'Nonaktifkan / Hapus Pengguna', description: 'Mengontrol penonaktifan akun pengguna' },

  // Role & Izin
  { id: 'perm-rol-view', code: 'roles:view', module: 'Role & Izin', action: 'view', label: 'Lihat Role & Matriks Izin', description: 'Melihat daftar role dan hak akses masing-masing modul' },
  { id: 'perm-rol-edit', code: 'roles:edit', module: 'Role & Izin', action: 'edit', label: 'Kelola Role & Hak Akses', description: 'Membuat role kustom dan mengubah izin per role' },

  // Pelanggan & Promosi (Phase 09)
  { id: 'perm-cst-view', code: 'customers:view', module: 'Pelanggan & Promosi', action: 'view', label: 'Lihat Daftar & Riwayat Pelanggan', description: 'Melihat profil pelanggan, poin loyalitas, dan riwayat belanja' },
  { id: 'perm-cst-create', code: 'customers:create', module: 'Pelanggan & Promosi', action: 'create', label: 'Daftarkan Pelanggan Baru', description: 'Menambahkan pelanggan / member baru dari manajemen pelanggan maupun kasir' },
  { id: 'perm-cst-edit', code: 'customers:edit', module: 'Pelanggan & Promosi', action: 'edit', label: 'Kelola Pelanggan & Poin Loyalitas', description: 'Mengubah data pelanggan, status aktif, dan melakukan penyesuaian poin manual' },
  { id: 'perm-prm-view', code: 'promotions:view', module: 'Pelanggan & Promosi', action: 'view', label: 'Lihat Daftar Promosi', description: 'Melihat promosi aktif, jadwal promo, dan memilih promo di kasir' },
  { id: 'perm-prm-manage', code: 'promotions:manage', module: 'Pelanggan & Promosi', action: 'edit', label: 'Kelola Promosi & Aturan Loyalitas', description: 'Membuat, mengubah, mengaktifkan promo, dan mengatur aturan poin/stacking' },

  // Audit & Sesi
  { id: 'perm-aud-view', code: 'audit:view', module: 'Audit & Sesi', action: 'view', label: 'Lihat Audit Log Sistem', description: 'Melihat jejak audit login, perubahan pengguna, dan otorisasi sensitif' },
  { id: 'perm-ses-view', code: 'sessions:view', module: 'Audit & Sesi', action: 'view', label: 'Lihat Semua Sesi Aktif', description: 'Memantau sesi login seluruh staf' },
  { id: 'perm-ses-revoke', code: 'sessions:revoke', module: 'Audit & Sesi', action: 'execute', label: 'Putuskan Sesi Pengguna', description: 'Mengakhiri sesi login aktif dari jarak jauh' },
];

const ROLE_PERMISSION_MAP: Record<string, string[]> = {
  'role-admin': DEFAULT_PERMISSIONS.map((p) => p.code),
  'role-supervisor': [
    'pos:view',
    'pos:create',
    'pos:discount_approve',
    'pos:price_override',
    'pos:hold',
    'pos:resume',
    'pos:cancel',
    'pos:void',
    'pos:refund',
    'recognition:use',
    'recognition:manage',
    'products:view',
    'products:create',
    'products:edit',
    'products:import',
    'catalog:manage',
    'stock:view',
    'stock:adjust',
    'reports:view',
    'transactions:view',
    'customers:view',
    'customers:create',
    'customers:edit',
    'promotions:view',
    'promotions:manage',
    'users:view',
    'audit:view',
    'sessions:view',
  ],
  'role-cashier': [
    'pos:view',
    'pos:create',
    'pos:hold',
    'pos:resume',
    'recognition:use',
    'products:view',
    'transactions:view',
    'customers:view',
    'customers:create',
    'promotions:view',
  ],
};

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationsDir = path.resolve(process.cwd(), 'server', 'db', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedStmt = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const insertMigStmt = db.prepare(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
  );

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    for (const file of files) {
      const alreadyApplied = appliedStmt.get(file);
      if (alreadyApplied) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.exec(sql);
        insertMigStmt.run(file, new Date().toISOString());
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

function seedPosDataIfEmpty(db: DatabaseSync): void {
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM products').get() as { cnt: number };
  if (countRow.cnt > 0) return;

  // Migrate existing Phase 1 JSON file if present, otherwise use seed data
  let sourceData: LegacyStoreData;
  const legacyJsonPath = process.env.POS_DATA_FILE
    ? path.resolve(process.env.POS_DATA_FILE)
    : path.resolve(process.cwd(), 'data', 'pos-store.json');

  if (fs.existsSync(legacyJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf-8')) as Partial<LegacyStoreData>;
      if (parsed.products && parsed.transactions && parsed.stockMovements && parsed.settings) {
        sourceData = {
          products: parsed.products,
          transactions: parsed.transactions,
          stockMovements: parsed.stockMovements,
          settings: parsed.settings,
          auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
        };
      } else {
        sourceData = buildSeedData();
      }
    } catch {
      sourceData = buildSeedData();
    }
  } else {
    sourceData = buildSeedData();
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    const insertProduct = db.prepare(`
      INSERT INTO products (id, barcode, name, category, unit, cost_price, sell_price, stock, min_stock, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of sourceData.products) {
      insertProduct.run(
        p.id,
        p.barcode,
        p.name,
        p.category,
        p.unit,
        p.costPrice,
        p.sellPrice,
        p.stock,
        p.minStock,
        p.updatedAt
      );
    }

    const insertTrx = db.prepare(`
      INSERT INTO transactions (
        id, invoice_number, status, payment_status, customer_id, customer_name,
        subtotal, line_discount_total, transaction_discount_type, transaction_discount_value,
        transaction_discount_amount, discount_amount, apply_tax, tax_amount, total,
        cash_received, change_amount, payment_method, total_cost, gross_profit,
        notes, cashier_id, cashier_name, completed_at, created_at, updated_at
      ) VALUES (?, ?, 'COMPLETED', 'PAID', NULL, 'Pelanggan Umum', ?, 0, 'AMOUNT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)
    `);
    const insertTrxItem = db.prepare(`
      INSERT INTO transaction_items (
        id, transaction_id, product_id, barcode, name, unit, qty,
        original_sell_price, sell_price, cost_price, subtotal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTrxPay = db.prepare(`
      INSERT INTO transaction_payments (
        id, transaction_id, payment_method_id, payment_method_name, payment_type,
        amount, tendered_amount, change_amount, reference_number, created_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '', ?)
    `);
    for (const trx of sourceData.transactions) {
      insertTrx.run(
        trx.id,
        trx.invoiceNumber,
        trx.subtotal,
        trx.discountAmount,
        trx.discountAmount,
        trx.discountAmount,
        trx.taxAmount > 0 ? 1 : 0,
        trx.taxAmount,
        trx.total,
        trx.cashReceived,
        trx.changeAmount,
        trx.paymentMethod,
        trx.totalCost,
        trx.grossProfit,
        trx.cashierId ?? null,
        trx.cashierName,
        trx.createdAt,
        trx.createdAt,
        trx.createdAt
      );
      trx.items.forEach((item, idx) => {
        insertTrxItem.run(
          `${trx.id}-itm-${idx}`,
          trx.id,
          item.productId,
          item.barcode,
          item.name,
          item.unit,
          item.qty,
          item.sellPrice,
          item.sellPrice,
          item.costPrice,
          item.subtotal
        );
      });
      const payType =
        trx.paymentMethod === 'QRIS'
          ? 'QRIS'
          : trx.paymentMethod === 'Kartu Debit'
          ? 'DEBIT'
          : 'CASH';
      insertTrxPay.run(
        `${trx.id}-pay-0`,
        trx.id,
        trx.paymentMethod,
        payType,
        trx.total,
        trx.cashReceived,
        trx.changeAmount,
        trx.createdAt
      );
    }

    const insertMov = db.prepare(`
      INSERT INTO stock_movements (
        id, product_id, product_name, barcode, type, qty_delta, stock_before, stock_after, reference_id, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const m of sourceData.stockMovements) {
      insertMov.run(
        m.id,
        m.productId,
        m.productName,
        m.barcode,
        m.type,
        m.qtyDelta,
        m.stockBefore,
        m.stockAfter,
        m.referenceId,
        m.notes,
        m.createdAt
      );
    }

    db.prepare(`
      INSERT OR REPLACE INTO store_settings (
        id, store_name, store_address, store_phone, receipt_footer, tax_enabled, tax_rate, cashier_name
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sourceData.settings.storeName,
      sourceData.settings.storeAddress,
      sourceData.settings.storePhone,
      sourceData.settings.receiptFooter,
      sourceData.settings.taxEnabled ? 1 : 0,
      sourceData.settings.taxRate,
      sourceData.settings.cashierName
    );

    const insertAudit = db.prepare(`
      INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_user_id, actor, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of sourceData.auditLogs) {
      insertAudit.run(
        a.id,
        a.action,
        a.entityType,
        a.entityId,
        a.actorUserId ?? null,
        a.actor,
        a.summary,
        a.createdAt
      );
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function normalizeUnitToCode(rawUnit: string): string {
  const lower = rawUnit.trim().toLowerCase();
  if (lower === 'bungkus' || lower === 'pack' || lower === 'pouch' || lower === 'bks') return 'PACK';
  if (lower === 'botol' || lower === 'bottle' || lower === 'btl') return 'BOTTLE';
  if (lower === 'kotak' || lower === 'box' || lower === 'dus' || lower === 'karton') return 'BOX';
  if (lower === 'kg' || lower === 'kilogram' || lower === 'sak') return 'KG';
  if (lower === 'gram' || lower === 'gr' || lower === 'g') return 'GRAM';
  if (lower === 'liter' || lower === 'l' || lower === 'ltr') return 'LITER';
  if (lower === 'ml' || lower === 'mililiter') return 'ML';
  if (lower === 'pcs' || lower === 'buah' || lower === 'unit' || lower === 'tube') return 'PCS';
  return rawUnit.trim().toUpperCase() || 'PCS';
}

function seedCatalogMasterIfEmpty(db: DatabaseSync): void {
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    // 1. Seed standard Units of Measure (required 8 units)
    const standardUoms: Array<{ id: string; code: string; name: string }> = [
      { id: 'uom-pcs', code: 'PCS', name: 'Pieces / Satuan (PCS)' },
      { id: 'uom-pack', code: 'PACK', name: 'Pack / Bungkus (PACK)' },
      { id: 'uom-box', code: 'BOX', name: 'Box / Kotak (BOX)' },
      { id: 'uom-bottle', code: 'BOTTLE', name: 'Botol (BOTTLE)' },
      { id: 'uom-kg', code: 'KG', name: 'Kilogram (KG)' },
      { id: 'uom-gram', code: 'GRAM', name: 'Gram (GRAM)' },
      { id: 'uom-liter', code: 'LITER', name: 'Liter (LITER)' },
      { id: 'uom-ml', code: 'ML', name: 'Mililiter (ML)' },
    ];
    const insertUom = db.prepare(`
      INSERT OR IGNORE INTO units_of_measure (id, code, name, is_system, is_active, created_at)
      VALUES (?, ?, ?, 1, 1, ?)
    `);
    for (const u of standardUoms) {
      insertUom.run(u.id, u.code, u.name, nowIso);
    }

    // 2. Seed Parent Categories & Subcategories
    const catCount = db.prepare('SELECT COUNT(*) as cnt FROM categories').get() as { cnt: number };
    if (catCount.cnt === 0) {
      const insertCat = db.prepare(`
        INSERT INTO categories (id, name, slug, parent_id, description, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `);
      const parents = [
        { id: 'cat-sembako', name: 'Sembako', slug: 'sembako', desc: 'Kebutuhan pokok harian rumah tangga' },
        { id: 'cat-minuman', name: 'Minuman', slug: 'minuman', desc: 'Air mineral, teh, kopi, dan susu kemasan' },
        { id: 'cat-snack', name: 'Makanan Ringan', slug: 'makanan-ringan', desc: 'Camilan, keripik, dan biskuit' },
        { id: 'cat-perawatan', name: 'Perawatan Diri', slug: 'perawatan-diri', desc: 'Kebersihan tubuh, rambut, dan gigi' },
        { id: 'cat-rt', name: 'Rumah Tangga', slug: 'rumah-tangga', desc: 'Pembersih dapur dan perlengkapan rumah' },
        { id: 'cat-lainnya', name: 'Lainnya', slug: 'lainnya', desc: 'Produk ritel kategori umum lainnya' },
      ];
      for (const c of parents) {
        insertCat.run(c.id, c.name, c.slug, null, c.desc, nowIso, nowIso);
      }

      const subcategories = [
        { id: 'cat-mie', name: 'Mie Instan', slug: 'mie-instan', parentId: 'cat-sembako', desc: 'Mie goreng dan mie kuah kemasan' },
        { id: 'cat-beras-minyak', name: 'Beras & Minyak', slug: 'beras-minyak', parentId: 'cat-sembako', desc: 'Beras kemasan dan minyak goreng' },
        { id: 'cat-air-mineral', name: 'Air Mineral', slug: 'air-mineral', parentId: 'cat-minuman', desc: 'Air mineral botol dan galon' },
        { id: 'cat-teh-kopi', name: 'Teh & Kopi', slug: 'teh-kopi', parentId: 'cat-minuman', desc: 'Teh siap minum dan kopi bubuk' },
        { id: 'cat-susu', name: 'Susu & UHT', slug: 'susu-uht', parentId: 'cat-minuman', desc: 'Susu cair UHT dan olahan' },
        { id: 'cat-keripik', name: 'Keripik & Snack', slug: 'keripik-snack', parentId: 'cat-snack', desc: 'Snack kentang dan camilan gurih' },
        { id: 'cat-biskuit', name: 'Biskuit & Kue', slug: 'biskuit-kue', parentId: 'cat-snack', desc: 'Biskuit manis dan crackers' },
        { id: 'cat-mandi-gigi', name: 'Sabun & Pasta Gigi', slug: 'sabun-pasta-gigi', parentId: 'cat-perawatan', desc: 'Perawatan gigi dan sabun mandi' },
        { id: 'cat-dapur', name: 'Pembersih Dapur', slug: 'pembersih-dapur', parentId: 'cat-rt', desc: 'Sabun cuci piring dan pembersih permukaan' },
      ];
      for (const s of subcategories) {
        insertCat.run(s.id, s.name, s.slug, s.parentId, s.desc, nowIso, nowIso);
      }
    }

    // 3. Seed Brands
    const brandCount = db.prepare('SELECT COUNT(*) as cnt FROM brands').get() as { cnt: number };
    if (brandCount.cnt === 0) {
      const insertBrand = db.prepare(`
        INSERT INTO brands (id, name, description, is_active, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `);
      const seedBrands = [
        { id: 'brd-indofood', name: 'Indofood', desc: 'Produk makanan instan dan bumbu' },
        { id: 'brd-aqua', name: 'Aqua', desc: 'Air mineral dalam kemasan' },
        { id: 'brd-sosro', name: 'Sosro', desc: 'Minuman teh siap saji' },
        { id: 'brd-kapalapi', name: 'Kapal Api', desc: 'Kopi bubuk dan kopi instan' },
        { id: 'brd-ultramilk', name: 'Ultra Milk', desc: 'Susu UHT dan minuman sehat' },
        { id: 'brd-pandanwangi', name: 'Pandan Wangi', desc: 'Beras pilihan berkualitas' },
        { id: 'brd-bimoli', name: 'Bimoli', desc: 'Minyak goreng sawit' },
        { id: 'brd-chitato', name: 'Chitato', desc: 'Keripik kentang aneka rasa' },
        { id: 'brd-roma', name: 'Roma', desc: 'Biskuit keluarga dan camilan' },
        { id: 'brd-pepsodent', name: 'Pepsodent', desc: 'Perawatan kesehatan gigi dan mulut' },
        { id: 'brd-lifebuoy', name: 'Lifebuoy', desc: 'Sabun antibakteri keluarga' },
        { id: 'brd-sunlight', name: 'Sunlight', desc: 'Cairan pencuci piring konsentrat' },
        { id: 'brd-umum', name: 'Umum', desc: 'Merek lokal atau tanpa merek spesifik' },
      ];
      for (const b of seedBrands) {
        insertBrand.run(b.id, b.name, b.desc, nowIso, nowIso);
      }
    }

    // 4. Backfill existing products with SKU, normalized FKs, specs, and product_barcodes
    const existingProducts = db
      .prepare('SELECT id, sku, barcode, name, category, unit, brand_id, category_id, uom_id, created_at, updated_at FROM products ORDER BY id ASC')
      .all() as Array<{
      id: string;
      sku: string | null;
      barcode: string;
      name: string;
      category: string;
      unit: string;
      brand_id: string | null;
      category_id: string | null;
      uom_id: string | null;
      created_at: string | null;
      updated_at: string;
    }>;

    const allCats = db
      .prepare('SELECT id, name, parent_id FROM categories')
      .all() as Array<{ id: string; name: string; parent_id: string | null }>;
    const allBrands = db
      .prepare('SELECT id, name FROM brands')
      .all() as Array<{ id: string; name: string }>;
    const allUoms = db
      .prepare('SELECT id, code FROM units_of_measure')
      .all() as Array<{ id: string; code: string }>;

    const catByName = new Map(allCats.filter((c) => !c.parent_id).map((c) => [c.name.toLowerCase(), c.id]));
    const brandByName = new Map(allBrands.map((b) => [b.name.toLowerCase(), b.id]));
    const uomByCode = new Map(allUoms.map((u) => [u.code.toUpperCase(), u.id]));

    const seedSpecs: Record<
      string,
      { brandId: string; subCatId: string; variant: string; size: string; weight: number | null; volume: number | null }
    > = {
      'prd-01': { brandId: 'brd-indofood', subCatId: 'cat-mie', variant: 'Goreng Spesial', size: '85g', weight: 85, volume: null },
      'prd-02': { brandId: 'brd-aqua', subCatId: 'cat-air-mineral', variant: 'Original', size: '600ml', weight: null, volume: 600 },
      'prd-03': { brandId: 'brd-sosro', subCatId: 'cat-teh-kopi', variant: 'Original Kotak', size: '250ml', weight: null, volume: 250 },
      'prd-04': { brandId: 'brd-kapalapi', subCatId: 'cat-teh-kopi', variant: 'Special Mix Bubuk', size: '165g', weight: 165, volume: null },
      'prd-05': { brandId: 'brd-ultramilk', subCatId: 'cat-susu', variant: 'Cokelat', size: '250ml', weight: null, volume: 250 },
      'prd-06': { brandId: 'brd-pandanwangi', subCatId: 'cat-beras-minyak', variant: 'Premium', size: '5kg', weight: 5000, volume: null },
      'prd-07': { brandId: 'brd-bimoli', subCatId: 'cat-beras-minyak', variant: 'Klasik Pouch', size: '1L', weight: null, volume: 1000 },
      'prd-08': { brandId: 'brd-chitato', subCatId: 'cat-keripik', variant: 'Sapi Panggang', size: '68g', weight: 68, volume: null },
      'prd-09': { brandId: 'brd-roma', subCatId: 'cat-biskuit', variant: 'Kelapa', size: '300g', weight: 300, volume: null },
      'prd-10': { brandId: 'brd-pepsodent', subCatId: 'cat-mandi-gigi', variant: 'Herbal', size: '190g', weight: 190, volume: null },
      'prd-11': { brandId: 'brd-lifebuoy', subCatId: 'cat-mandi-gigi', variant: 'Total 10 Refill', size: '450ml', weight: null, volume: 450 },
      'prd-12': { brandId: 'brd-sunlight', subCatId: 'cat-dapur', variant: 'Jeruk Nipis Refill', size: '650ml', weight: null, volume: 650 },
    };

    const updateProd = db.prepare(`
      UPDATE products
      SET sku = COALESCE(sku, ?),
          brand_id = COALESCE(brand_id, ?),
          category_id = COALESCE(category_id, ?),
          subcategory_id = COALESCE(subcategory_id, ?),
          uom_id = COALESCE(uom_id, ?),
          unit = ?,
          variant = CASE WHEN variant = '' THEN ? ELSE variant END,
          size = CASE WHEN size = '' THEN ? ELSE size END,
          weight = COALESCE(weight, ?),
          volume = COALESCE(volume, ?),
          created_at = COALESCE(created_at, ?)
      WHERE id = ?
    `);

    const insertBarcode = db.prepare(`
      INSERT OR IGNORE INTO product_barcodes (id, product_id, barcode, barcode_type, is_primary, created_at)
      VALUES (?, ?, ?, 'EAN-13', 1, ?)
    `);

    existingProducts.forEach((p, idx) => {
      const generatedSku = `SKU-${String(idx + 1).padStart(4, '0')}`;
      const normCode = normalizeUnitToCode(p.unit);
      let uomId = uomByCode.get(normCode);
      if (!uomId) {
        uomId = `uom-${slugify(normCode)}`;
        db.prepare(
          'INSERT OR IGNORE INTO units_of_measure (id, code, name, is_system, is_active, created_at) VALUES (?, ?, ?, 0, 1, ?)'
        ).run(uomId, normCode, normCode, nowIso);
        uomByCode.set(normCode, uomId);
      }

      let catId = catByName.get(p.category.toLowerCase());
      if (!catId) {
        catId = `cat-${slugify(p.category)}`;
        db.prepare(
          'INSERT OR IGNORE INTO categories (id, name, slug, parent_id, description, is_active, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 1, ?, ?)'
        ).run(catId, p.category, slugify(p.category), '', nowIso, nowIso);
        catByName.set(p.category.toLowerCase(), catId);
      }

      const spec = seedSpecs[p.id];
      const matchedBrand =
        spec?.brandId ||
        allBrands.find((b) => p.name.toLowerCase().includes(b.name.toLowerCase()))?.id ||
        brandByName.get('umum') ||
        'brd-umum';

      updateProd.run(
        p.sku || generatedSku,
        matchedBrand,
        catId,
        spec?.subCatId ?? null,
        uomId,
        normCode,
        spec?.variant ?? '',
        spec?.size ?? '',
        spec?.weight ?? null,
        spec?.volume ?? null,
        p.created_at || p.updated_at || nowIso,
        p.id
      );

      insertBarcode.run(
        `bc-${p.id}-1`,
        p.id,
        p.barcode,
        p.created_at || p.updated_at || nowIso
      );
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function seedRbacIfEmpty(db: DatabaseSync): void {
  const nowIso = new Date().toISOString();

  // Upsert canonical permissions so new permissions are always available
  const upsertPerm = db.prepare(`
    INSERT INTO permissions (id, code, module, action, label, description)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      module = excluded.module,
      action = excluded.action,
      label = excluded.label,
      description = excluded.description
  `);
  for (const p of DEFAULT_PERMISSIONS) {
    upsertPerm.run(p.id, p.code, p.module, p.action, p.label, p.description);
  }

  const permIdByCode = new Map(DEFAULT_PERMISSIONS.map((p) => [p.code, p.id]));
  const insertRolePerm = db.prepare(
    'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)'
  );

  const roleCount = db.prepare('SELECT COUNT(*) as cnt FROM roles').get() as { cnt: number };
  if (roleCount.cnt === 0) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const insertRole = db.prepare(`
        INSERT INTO roles (id, name, description, is_system, created_at)
        VALUES (?, ?, ?, 1, ?)
      `);
      insertRole.run(
        'role-admin',
        'Admin',
        'Akses penuh ke seluruh modul kasir, stok, pengguna, role, audit, dan pengaturan toko.',
        nowIso
      );
      insertRole.run(
        'role-supervisor',
        'Supervisor',
        'Mengawasi operasional kasir, menyetujui diskon & penyesuaian stok via PIN, serta melihat laporan.',
        nowIso
      );
      insertRole.run(
        'role-cashier',
        'Cashier',
        'Melakukan pemindaian barang, checkout kasir, cetak struk, dan melihat riwayat transaksi.',
        nowIso
      );

      for (const [roleId, codes] of Object.entries(ROLE_PERMISSION_MAP)) {
        for (const code of codes) {
          const permId = permIdByCode.get(code);
          if (permId) insertRolePerm.run(roleId, permId);
        }
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  } else {
    // Ensure system roles automatically receive new phase permissions on upgrade
    for (const code of DEFAULT_PERMISSIONS.map((p) => p.code)) {
      const permId = permIdByCode.get(code);
      if (permId) insertRolePerm.run('role-admin', permId);
    }
    for (const code of [
      'products:import',
      'catalog:manage',
      'pos:hold',
      'pos:resume',
      'pos:cancel',
      'recognition:use',
      'recognition:manage',
      'customers:view',
      'customers:create',
      'customers:edit',
      'promotions:view',
      'promotions:manage',
    ]) {
      const permId = permIdByCode.get(code);
      if (permId) insertRolePerm.run('role-supervisor', permId);
    }
    for (const code of [
      'pos:hold',
      'pos:resume',
      'recognition:use',
      'customers:view',
      'customers:create',
      'promotions:view',
    ]) {
      const permId = permIdByCode.get(code);
      if (permId) insertRolePerm.run('role-cashier', permId);
    }
  }

  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (userCount.cnt === 0) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const insertUser = db.prepare(`
        INSERT INTO users (id, username, email, full_name, password_hash, pin_hash, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      const assignRole = db.prepare(
        'INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, ?, ?)'
      );

      insertUser.run(
        'usr-admin',
        'admin',
        'admin@kassaritel.id',
        'Budi Santoso (Admin)',
        hashSecret('Admin123!'),
        hashSecret('123456'),
        nowIso,
        nowIso
      );
      assignRole.run('usr-admin', 'role-admin', nowIso);

      insertUser.run(
        'usr-supervisor',
        'supervisor',
        'supervisor@kassaritel.id',
        'Siti Rahayu (Supervisor)',
        hashSecret('Super123!'),
        hashSecret('654321'),
        nowIso,
        nowIso
      );
      assignRole.run('usr-supervisor', 'role-supervisor', nowIso);

      insertUser.run(
        'usr-kasir',
        'kasir',
        'kasir@kassaritel.id',
        'Andi Wijaya (Kasir)',
        hashSecret('Kasir123!'),
        null,
        nowIso,
        nowIso
      );
      assignRole.run('usr-kasir', 'role-cashier', nowIso);

      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }
}

function seedPosCoreMasterIfEmpty(db: DatabaseSync): void {
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    const pmCount = db.prepare('SELECT COUNT(*) as cnt FROM payment_methods').get() as { cnt: number };
    if (pmCount.cnt === 0) {
      const insertPm = db.prepare(`
        INSERT INTO payment_methods (id, code, name, type, requires_reference, is_system, is_active, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      insertPm.run('pm-cash', 'CASH', 'Tunai', 'CASH', 0, 1, 1, nowIso);
      insertPm.run('pm-debit', 'DEBIT', 'Kartu Debit', 'DEBIT', 1, 1, 2, nowIso);
      insertPm.run('pm-credit', 'CREDIT', 'Kartu Kredit', 'CREDIT', 1, 1, 3, nowIso);
      insertPm.run('pm-qris', 'QRIS', 'QRIS', 'QRIS', 0, 1, 4, nowIso);
      insertPm.run('pm-transfer', 'TRANSFER', 'Transfer Bank', 'OTHER', 1, 0, 5, nowIso);
    }

    const custCount = db.prepare('SELECT COUNT(*) as cnt FROM customers').get() as { cnt: number };
    if (custCount.cnt === 0) {
      const insertCust = db.prepare(`
        INSERT INTO customers (
          id, code, membership_number, name, phone, email, address, notes,
          is_active, loyalty_points, total_points_earned, total_points_redeemed,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?)
      `);
      insertCust.run('cust-001', 'CUST-0001', 'MBR-0001', 'Dewi Lestari', '081234567890', 'dewi@pelanggan.id', 'Jl. Melati No. 14', 'Pelanggan tetap', 45, 45, nowIso, nowIso);
      insertCust.run('cust-002', 'CUST-0002', 'MBR-0002', 'Hendra Wijaya', '081398765432', 'hendra@pelanggan.id', 'Jl. Anggrek No. 8', 'Belanja grosir mingguan', 120, 120, nowIso, nowIso);
      insertCust.run('cust-003', 'CUST-0003', 'MBR-0003', 'Sari Puspita', '085611223344', '', 'Perumahan Griya Asri B2', '', 15, 15, nowIso, nowIso);
    }

    const promoCount = db.prepare('SELECT COUNT(*) as cnt FROM promotions').get() as { cnt: number };
    if (promoCount.cnt === 0) {
      const startIso = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      const endIso = new Date(Date.now() + 180 * 86400_000).toISOString().slice(0, 10);

      const insertPromo = db.prepare(`
        INSERT INTO promotions (
          id, code, name, description, promo_type, scope, discount_value,
          max_discount_amount, min_purchase_amount, min_qty, start_date, end_date,
          status, stackable, priority, rule_json, usage_count,
          created_by_user_id, created_by_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, 0, 'usr-admin', 'Sistem', ?, ?)
      `);
      const insertTarget = db.prepare(`
        INSERT INTO promotion_targets (id, promotion_id, target_type, target_id, required_qty)
        VALUES (?, ?, ?, ?, ?)
      `);

      insertPromo.run(
        'promo-hemat10',
        'HEMAT10',
        'Diskon Belanja Hemat 10%',
        'Potongan 10% (maks. Rp 25.000) untuk total belanja minimal Rp 100.000.',
        'PERCENT',
        'TRANSACTION',
        10,
        25000,
        100000,
        1,
        startIso,
        endIso,
        1,
        20,
        '{}',
        nowIso,
        nowIso
      );

      insertPromo.run(
        'promo-grosir-mie',
        'MIE5SPESIAL',
        'Harga Spesial Indomie (Min. 5)',
        'Harga spesial Rp 2.800 per bungkus untuk pembelian minimal 5 pcs Indomie Goreng.',
        'SPECIAL_PRICE',
        'PRODUCT',
        2800,
        null,
        0,
        5,
        startIso,
        endIso,
        1,
        10,
        '{}',
        nowIso,
        nowIso
      );
      if (db.prepare('SELECT 1 FROM products WHERE id = ?').get('prd-01')) {
        insertTarget.run('ptgt-mie-1', 'promo-grosir-mie', 'PRODUCT', 'prd-01', 1);
      }

      insertPromo.run(
        'promo-minuman-segarkan',
        'MINUMAN1K',
        'Potongan Rp 1.000 Kategori Minuman',
        'Potongan tetap Rp 1.000 untuk kategori Minuman dengan pembelian minimal 2 item.',
        'FIXED_AMOUNT',
        'CATEGORY',
        1000,
        null,
        0,
        2,
        startIso,
        endIso,
        1,
        15,
        '{}',
        nowIso,
        nowIso
      );
      if (db.prepare('SELECT 1 FROM categories WHERE id = ?').get('cat-minuman')) {
        insertTarget.run('ptgt-min-1', 'promo-minuman-segarkan', 'CATEGORY', 'cat-minuman', 1);
      }
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

export function getDb(): DatabaseSync {
  const targetPath = getDbFilePath();
  if (dbInstance && currentDbPath === targetPath) {
    return dbInstance;
  }

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const uploadsDir = getProductUploadsDir();
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const storeUploadsDir = getStoreUploadsDir();
  if (!fs.existsSync(storeUploadsDir)) {
    fs.mkdirSync(storeUploadsDir, { recursive: true });
  }

  const recognitionUploadsDir = getRecognitionUploadsDir();
  if (!fs.existsSync(recognitionUploadsDir)) {
    fs.mkdirSync(recognitionUploadsDir, { recursive: true });
  }

  const db = new DatabaseSync(targetPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  runMigrations(db);
  seedPosDataIfEmpty(db);
  seedCatalogMasterIfEmpty(db);
  seedPosCoreMasterIfEmpty(db);
  seedRbacIfEmpty(db);

  dbInstance = db;
  currentDbPath = targetPath;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    currentDbPath = null;
  }
}
