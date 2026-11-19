import fs from 'fs';
import path from 'path';
import type {
  AuditLog,
  StockMovement,
  StoreSettings,
  Transaction,
  TransactionItem,
} from '../src/types.ts';

export interface LegacyProduct {
  id: string;
  barcode: string;
  name: string;
  category: string;
  unit: string;
  costPrice: number;
  sellPrice: number;
  stock: number;
  minStock: number;
  updatedAt: string;
}

export interface LegacyStoreData {
  products: LegacyProduct[];
  transactions: Transaction[];
  stockMovements: StockMovement[];
  settings: StoreSettings;
  auditLogs: AuditLog[];
}

function getDataFilePath(): string {
  if (process.env.POS_DATA_FILE) {
    return path.resolve(process.env.POS_DATA_FILE);
  }
  return path.resolve(process.cwd(), 'data', 'pos-store.json');
}

export function buildSeedData(): LegacyStoreData {
  const now = Date.now();
  const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();

  const products: LegacyProduct[] = [
    {
      id: 'prd-01',
      barcode: '8998866200315',
      name: 'Indomie Goreng Spesial 85g',
      category: 'Sembako',
      unit: 'bungkus',
      costPrice: 2700,
      sellPrice: 3500,
      stock: 68,
      minStock: 20,
      updatedAt: minsAgo(180),
    },
    {
      id: 'prd-02',
      barcode: '8992761139018',
      name: 'Aqua Air Mineral 600ml',
      category: 'Minuman',
      unit: 'botol',
      costPrice: 2800,
      sellPrice: 4000,
      stock: 46,
      minStock: 15,
      updatedAt: minsAgo(160),
    },
    {
      id: 'prd-03',
      barcode: '8996001301180',
      name: 'Teh Botol Sosro Kotak 250ml',
      category: 'Minuman',
      unit: 'kotak',
      costPrice: 3100,
      sellPrice: 4500,
      stock: 11,
      minStock: 15,
      updatedAt: minsAgo(90),
    },
    {
      id: 'prd-04',
      barcode: '8991002101128',
      name: 'Kopi Kapal Api Special 165g',
      category: 'Minuman',
      unit: 'bungkus',
      costPrice: 13500,
      sellPrice: 16500,
      stock: 19,
      minStock: 8,
      updatedAt: minsAgo(140),
    },
    {
      id: 'prd-05',
      barcode: '8992753101207',
      name: 'Susu Ultra Milk Cokelat 250ml',
      category: 'Minuman',
      unit: 'kotak',
      costPrice: 5400,
      sellPrice: 7000,
      stock: 6,
      minStock: 12,
      updatedAt: minsAgo(45),
    },
    {
      id: 'prd-06',
      barcode: '8993175534824',
      name: 'Beras Premium Pandan Wangi 5kg',
      category: 'Sembako',
      unit: 'sak',
      costPrice: 67000,
      sellPrice: 76000,
      stock: 14,
      minStock: 5,
      updatedAt: minsAgo(200),
    },
    {
      id: 'prd-07',
      barcode: '8992775210116',
      name: 'Minyak Goreng Bimoli Pouch 1L',
      category: 'Sembako',
      unit: 'pouch',
      costPrice: 16500,
      sellPrice: 19500,
      stock: 4,
      minStock: 10,
      updatedAt: minsAgo(30),
    },
    {
      id: 'prd-08',
      barcode: '8992388111014',
      name: 'Chitato Sapi Panggang 68g',
      category: 'Makanan Ringan',
      unit: 'bungkus',
      costPrice: 9200,
      sellPrice: 12000,
      stock: 25,
      minStock: 10,
      updatedAt: minsAgo(120),
    },
    {
      id: 'prd-09',
      barcode: '8996001600269',
      name: 'Roma Biskuit Kelapa 300g',
      category: 'Makanan Ringan',
      unit: 'bungkus',
      costPrice: 8800,
      sellPrice: 11500,
      stock: 17,
      minStock: 8,
      updatedAt: minsAgo(110),
    },
    {
      id: 'prd-10',
      barcode: '8999999002466',
      name: 'Pepsodent Pasta Gigi Herbal 190g',
      category: 'Perawatan Diri',
      unit: 'tube',
      costPrice: 11500,
      sellPrice: 15000,
      stock: 22,
      minStock: 8,
      updatedAt: minsAgo(210),
    },
    {
      id: 'prd-11',
      barcode: '8999999513016',
      name: 'Lifebuoy Sabun Cair Total 450ml',
      category: 'Perawatan Diri',
      unit: 'pouch',
      costPrice: 19000,
      sellPrice: 24500,
      stock: 0,
      minStock: 6,
      updatedAt: minsAgo(25),
    },
    {
      id: 'prd-12',
      barcode: '8999999036614',
      name: 'Sunlight Jeruk Nipis Refill 650ml',
      category: 'Rumah Tangga',
      unit: 'pouch',
      costPrice: 12800,
      sellPrice: 16000,
      stock: 15,
      minStock: 6,
      updatedAt: minsAgo(150),
    },
  ];

  const trx1Items: TransactionItem[] = [
    {
      productId: 'prd-01',
      barcode: '8998866200315',
      name: 'Indomie Goreng Spesial 85g',
      unit: 'bungkus',
      qty: 4,
      sellPrice: 3500,
      costPrice: 2700,
      subtotal: 14000,
    },
    {
      productId: 'prd-02',
      barcode: '8992761139018',
      name: 'Aqua Air Mineral 600ml',
      unit: 'botol',
      qty: 2,
      sellPrice: 4000,
      costPrice: 2800,
      subtotal: 8000,
    },
    {
      productId: 'prd-07',
      barcode: '8992775210116',
      name: 'Minyak Goreng Bimoli Pouch 1L',
      unit: 'pouch',
      qty: 1,
      sellPrice: 19500,
      costPrice: 16500,
      subtotal: 19500,
    },
  ];

  const trx2Items: TransactionItem[] = [
    {
      productId: 'prd-05',
      barcode: '8992753101207',
      name: 'Susu Ultra Milk Cokelat 250ml',
      unit: 'kotak',
      qty: 3,
      sellPrice: 7000,
      costPrice: 5400,
      subtotal: 21000,
    },
    {
      productId: 'prd-08',
      barcode: '8992388111014',
      name: 'Chitato Sapi Panggang 68g',
      unit: 'bungkus',
      qty: 2,
      sellPrice: 12000,
      costPrice: 9200,
      subtotal: 24000,
    },
  ];

  const transactions: Transaction[] = [
    {
      id: 'trx-seed-02',
      invoiceNumber: 'TRX-20261118-002',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      customerId: null,
      customerName: 'Pelanggan Umum',
      items: trx2Items,
      subtotal: 45000,
      lineDiscountTotal: 0,
      transactionDiscountType: 'AMOUNT',
      transactionDiscountValue: 0,
      transactionDiscountAmount: 0,
      discountAmount: 0,
      applyTax: false,
      taxAmount: 0,
      total: 45000,
      cashReceived: 45000,
      changeAmount: 0,
      paymentMethod: 'QRIS',
      totalCost: 34600,
      grossProfit: 10400,
      notes: '',
      cashierName: 'Kasir Utama',
      createdAt: minsAgo(45),
    },
    {
      id: 'trx-seed-01',
      invoiceNumber: 'TRX-20261118-001',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      customerId: null,
      customerName: 'Pelanggan Umum',
      items: trx1Items,
      subtotal: 41500,
      lineDiscountTotal: 0,
      transactionDiscountType: 'AMOUNT',
      transactionDiscountValue: 0,
      transactionDiscountAmount: 0,
      discountAmount: 0,
      applyTax: false,
      taxAmount: 0,
      total: 41500,
      cashReceived: 50000,
      changeAmount: 8500,
      paymentMethod: 'Tunai',
      totalCost: 32900,
      grossProfit: 8600,
      notes: '',
      cashierName: 'Kasir Utama',
      createdAt: minsAgo(95),
    },
  ];

  const stockMovements: StockMovement[] = [
    {
      id: 'mov-seed-05',
      productId: 'prd-11',
      productName: 'Lifebuoy Sabun Cair Total 450ml',
      barcode: '8999999513016',
      type: 'PENJUALAN',
      qtyDelta: -2,
      stockBefore: 2,
      stockAfter: 0,
      referenceId: 'TRX-20261118-000',
      notes: 'Penjualan kasir — stok habis otomatis tercatat',
      createdAt: minsAgo(25),
    },
    {
      id: 'mov-seed-04',
      productId: 'prd-05',
      productName: 'Susu Ultra Milk Cokelat 250ml',
      barcode: '8992753101207',
      type: 'PENJUALAN',
      qtyDelta: -3,
      stockBefore: 9,
      stockAfter: 6,
      referenceId: 'TRX-20261118-002',
      notes: 'Penjualan via QRIS',
      createdAt: minsAgo(45),
    },
    {
      id: 'mov-seed-03',
      productId: 'prd-08',
      productName: 'Chitato Sapi Panggang 68g',
      barcode: '8992388111014',
      type: 'PENJUALAN',
      qtyDelta: -2,
      stockBefore: 27,
      stockAfter: 25,
      referenceId: 'TRX-20261118-002',
      notes: 'Penjualan via QRIS',
      createdAt: minsAgo(45),
    },
    {
      id: 'mov-seed-02',
      productId: 'prd-07',
      productName: 'Minyak Goreng Bimoli Pouch 1L',
      barcode: '8992775210116',
      type: 'PENJUALAN',
      qtyDelta: -1,
      stockBefore: 5,
      stockAfter: 4,
      referenceId: 'TRX-20261118-001',
      notes: 'Penjualan tunai kasir',
      createdAt: minsAgo(95),
    },
    {
      id: 'mov-seed-01',
      productId: 'prd-01',
      productName: 'Indomie Goreng Spesial 85g',
      barcode: '8998866200315',
      type: 'RESTOK',
      qtyDelta: 40,
      stockBefore: 28,
      stockAfter: 68,
      referenceId: 'PO-20261118-01',
      notes: 'Restok supplier mingguan',
      createdAt: minsAgo(180),
    },
  ];

  const settings: StoreSettings = {
    storeName: 'Toko Serba Ada KassaRitel',
    storeAddress: 'Jl. Jenderal Sudirman No. 48, Jakarta',
    storePhone: '021-5550-1928',
    receiptFooter:
      'Terima kasih telah berbelanja. Barang yang sudah dibeli tidak dapat ditukar kecuali ada perjanjian.',
    taxEnabled: false,
    taxRate: 11,
    cashierName: 'Kasir Utama',
  };

  const auditLogs: AuditLog[] = [
    {
      id: 'aud-seed-02',
      action: 'TRANSACTION_COMPLETED',
      entityType: 'transaction',
      entityId: 'TRX-20261118-002',
      actor: 'Kasir Utama',
      summary: 'Transaksi QRIS senilai Rp 45.000 (5 unit terjual)',
      createdAt: minsAgo(45),
    },
    {
      id: 'aud-seed-01',
      action: 'STOCK_ADJUSTED',
      entityType: 'stock',
      entityId: 'prd-01',
      actor: 'Kasir Utama',
      summary: 'RESTOK Indomie Goreng Spesial 85g (+40 bungkus)',
      createdAt: minsAgo(180),
    },
  ];

  return { products, transactions, stockMovements, settings, auditLogs };
}

function migrateStoreShape(parsed: Partial<LegacyStoreData>): LegacyStoreData | null {
  if (!parsed.products || !parsed.transactions || !parsed.stockMovements || !parsed.settings) {
    return null;
  }
  return {
    products: parsed.products,
    transactions: parsed.transactions,
    stockMovements: parsed.stockMovements,
    settings: parsed.settings,
    auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
  };
}

function ensureStoreFile(): LegacyStoreData {
  const dataFile = getDataFilePath();
  const dataDir = path.dirname(dataFile);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dataFile)) {
    const seed = buildSeedData();
    fs.writeFileSync(dataFile, JSON.stringify(seed, null, 2), 'utf-8');
    return seed;
  }
  const raw = fs.readFileSync(dataFile, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<LegacyStoreData>;
  const migrated = migrateStoreShape(parsed);
  if (!migrated) {
    throw new Error(`Struktur data store pada ${dataFile} tidak valid.`);
  }
  if (!Array.isArray(parsed.auditLogs)) {
    writeStore(migrated);
  }
  return migrated;
}

export function readStore(): LegacyStoreData {
  return ensureStoreFile();
}

export function writeStore(data: LegacyStoreData): void {
  const dataFile = getDataFilePath();
  const dataDir = path.dirname(dataFile);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const tmpFile = `${dataFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpFile, dataFile);
}
