import fs from 'node:fs';
import { getDb } from '../db/database.ts';
import { recordAuditLog, listAuditLogs } from './auditService.ts';
import { consumePinApprovalToken } from './authService.ts';
import {
  generateNextSku,
  getProductById,
  inferBarcodeType,
  listBrands,
  listCategories,
  listUoms,
  normalizeUnitCode,
  queryEnrichedProducts,
  slugifyText,
  validateBarcodeValue,
} from './catalogService.ts';
import {
  executeTransactionalCheckout,
  listCustomers,
  listHeldTransactions,
  listPaymentMethods,
  queryTransactions as queryPhase4Transactions,
  type CheckoutInput,
} from './checkoutService.ts';
import { ServiceError } from './errors.ts';
import type {
  BarcodeType,
  Product,
  ProductStatus,
  ReceiptPaperWidth,
  StockMovement,
  StockMovementType,
  StoreData,
  StoreSettings,
  TaxCategory,
  Transaction,
  UserSummary,
} from '../../src/types.ts';

const VALID_TAX_CATEGORIES: ReadonlySet<TaxCategory> = new Set([
  'STANDARD',
  'EXEMPT',
  'REDUCED',
]);

function assertFiniteNonNegative(value: unknown, fieldLabel: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new ServiceError(400, `${fieldLabel} harus berupa angka valid minimal 0.`);
  }
  return num;
}

// Transactions queried via checkoutService.queryTransactions

function queryStockMovements(limit = 300): StockMovement[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT id, product_id, product_name, barcode, type, qty_delta, stock_before, stock_after,
             reference_id, notes, created_at
      FROM stock_movements
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
    id: string;
    product_id: string;
    product_name: string;
    barcode: string;
    type: StockMovementType;
    qty_delta: number;
    stock_before: number;
    stock_after: number;
    reference_id: string;
    notes: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    productName: r.product_name,
    barcode: r.barcode,
    type: r.type,
    qtyDelta: r.qty_delta,
    stockBefore: r.stock_before,
    stockAfter: r.stock_after,
    referenceId: r.reference_id,
    notes: r.notes,
    createdAt: r.created_at,
  }));
}

export function querySettings(): StoreSettings {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT store_name, store_address, store_phone, receipt_footer, tax_enabled, tax_rate, cashier_name,
             store_logo_url, receipt_paper_width, receipt_show_logo, receipt_show_qr, receipt_header_note
      FROM store_settings
      WHERE id = 1
    `)
    .get() as
    | {
        store_name: string;
        store_address: string;
        store_phone: string;
        receipt_footer: string;
        tax_enabled: number;
        tax_rate: number;
        cashier_name: string;
        store_logo_url: string;
        receipt_paper_width: ReceiptPaperWidth;
        receipt_show_logo: number;
        receipt_show_qr: number;
        receipt_header_note: string;
      }
    | undefined;

  if (!row) {
    throw new ServiceError(500, 'Pengaturan toko belum terinisialisasi.');
  }

  return {
    storeName: row.store_name,
    storeAddress: row.store_address,
    storePhone: row.store_phone,
    receiptFooter: row.receipt_footer,
    taxEnabled: row.tax_enabled === 1,
    taxRate: row.tax_rate,
    cashierName: row.cashier_name,
    storeLogoUrl: row.store_logo_url || '',
    receiptPaperWidth:
      row.receipt_paper_width === '58mm' ||
      row.receipt_paper_width === '80mm' ||
      row.receipt_paper_width === 'A4'
        ? row.receipt_paper_width
        : '80mm',
    receiptShowLogo: row.receipt_show_logo === 1,
    receiptShowQr: row.receipt_show_qr === 1,
    receiptHeaderNote: row.receipt_header_note || '',
  };
}

export function getBootstrapData(viewer?: UserSummary): StoreData {
  const db = getDb();
  const canViewProducts =
    !viewer ||
    viewer.permissions.includes('products:view') ||
    viewer.permissions.includes('pos:view') ||
    viewer.permissions.includes('catalog:manage');
  const canViewPos = !viewer || viewer.permissions.includes('pos:view');
  const canViewTransactions =
    !viewer ||
    viewer.permissions.includes('transactions:view') ||
    viewer.permissions.includes('reports:view');
  const canViewStock =
    !viewer || viewer.permissions.includes('stock:view') || viewer.permissions.includes('reports:view');
  const canViewAudit = !viewer || viewer.permissions.includes('audit:view');

  return {
    products: canViewProducts ? queryEnrichedProducts() : [],
    categories: canViewProducts ? listCategories() : [],
    brands: canViewProducts ? listBrands() : [],
    uoms: canViewProducts ? listUoms() : [],
    customers: canViewPos || canViewTransactions ? listCustomers() : [],
    paymentMethods: canViewPos || canViewTransactions ? listPaymentMethods(true) : [],
    transactions: canViewTransactions ? queryPhase4Transactions(200, true) : [],
    heldTransactions: canViewPos ? listHeldTransactions() : [],
    stockMovements: canViewStock ? queryStockMovements() : [],
    settings: querySettings(),
    auditLogs: canViewAudit ? listAuditLogs(db) : [],
  };
}

export function getAuditLogs(): ReturnType<typeof listAuditLogs> {
  return listAuditLogs(getDb());
}

export interface ProductBarcodeInput {
  barcode?: unknown;
  barcodeType?: unknown;
  isPrimary?: unknown;
}

export interface CreateProductInput {
  sku?: unknown;
  barcode?: unknown;
  barcodeType?: unknown;
  barcodes?: unknown;
  name?: unknown;
  description?: unknown;
  brandId?: unknown;
  brandName?: unknown;
  categoryId?: unknown;
  category?: unknown;
  subcategoryId?: unknown;
  uomId?: unknown;
  unit?: unknown;
  variant?: unknown;
  size?: unknown;
  weight?: unknown;
  volume?: unknown;
  costPrice?: unknown;
  sellPrice?: unknown;
  specialPrice?: unknown;
  taxCategory?: unknown;
  stock?: unknown;
  minStock?: unknown;
  status?: unknown;
}

function resolveProductBarcodesInput(
  input: CreateProductInput,
  fallbackBarcode?: string,
  fallbackBarcodes?: Array<{ barcode: string; barcodeType: BarcodeType; isPrimary: boolean }>
): Array<{ barcode: string; barcodeType: BarcodeType; isPrimary: boolean }> {
  const list: Array<{ barcode: string; barcodeType: BarcodeType; isPrimary: boolean }> = [];

  if (Array.isArray(input.barcodes) && input.barcodes.length > 0) {
    for (const entry of input.barcodes) {
      if (!entry || typeof entry !== 'object') {
        throw new ServiceError(400, 'Format item barcode tidak valid.');
      }
      const raw = entry as ProductBarcodeInput;
      const code = typeof raw.barcode === 'string' ? raw.barcode.trim() : '';
      if (!code) continue;
      const inferredType = inferBarcodeType(code, raw.barcodeType);
      const validated = validateBarcodeValue(code, inferredType);
      list.push({
        barcode: validated.barcode,
        barcodeType: validated.barcodeType,
        isPrimary: Boolean(raw.isPrimary),
      });
    }
  } else if (input.barcode !== undefined) {
    const code = typeof input.barcode === 'string' ? input.barcode.trim() : '';
    if (!code) {
      throw new ServiceError(400, 'Kode barcode wajib diisi.');
    }
    const inferredType = inferBarcodeType(code, input.barcodeType);
    const validated = validateBarcodeValue(code, inferredType);
    list.push({
      barcode: validated.barcode,
      barcodeType: validated.barcodeType,
      isPrimary: true,
    });
  } else if (fallbackBarcodes && fallbackBarcodes.length > 0) {
    list.push(...fallbackBarcodes);
  } else if (fallbackBarcode) {
    list.push({
      barcode: fallbackBarcode,
      barcodeType: inferBarcodeType(fallbackBarcode),
      isPrimary: true,
    });
  }

  if (list.length === 0) {
    throw new ServiceError(400, 'Produk wajib memiliki minimal satu kode barcode.');
  }

  // Ensure exactly one primary barcode
  const primaryIdx = list.findIndex((b) => b.isPrimary);
  const effectivePrimaryIdx = primaryIdx >= 0 ? primaryIdx : 0;
  const normalized = list.map((b, idx) => ({
    ...b,
    isPrimary: idx === effectivePrimaryIdx,
  }));

  // Check duplicates within submitted list
  const seen = new Set<string>();
  for (const b of normalized) {
    const key = b.barcode.toLowerCase();
    if (seen.has(key)) {
      throw new ServiceError(400, `Barcode "${b.barcode}" tercantum ganda pada produk ini.`);
    }
    seen.add(key);
  }

  return normalized;
}

function resolveCatalogRelations(
  input: CreateProductInput,
  fallback?: Product
): {
  brandId: string | null;
  categoryId: string;
  categoryName: string;
  subcategoryId: string | null;
  uomId: string;
  unitCode: string;
} {
  const db = getDb();
  const nowIso = new Date().toISOString();

  // Category resolution
  let categoryId = fallback?.categoryId ?? null;
  let categoryName = fallback?.category ?? 'Lainnya';

  if (typeof input.categoryId === 'string' && input.categoryId.trim()) {
    const row = db
      .prepare('SELECT id, name, parent_id FROM categories WHERE id = ?')
      .get(input.categoryId.trim()) as
      | { id: string; name: string; parent_id: string | null }
      | undefined;
    if (!row) {
      throw new ServiceError(404, 'Kategori yang dipilih tidak ditemukan.');
    }
    categoryId = row.id;
    categoryName = row.name;
  } else if (typeof input.category === 'string' && input.category.trim()) {
    const reqName = input.category.trim();
    const row = db
      .prepare("SELECT id, name FROM categories WHERE LOWER(name) = LOWER(?) AND parent_id IS NULL")
      .get(reqName) as { id: string; name: string } | undefined;
    if (row) {
      categoryId = row.id;
      categoryName = row.name;
    } else {
      const newCatId = `cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      let slug = slugifyText(reqName);
      while (db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(slug)) {
        slug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;
      }
      db.prepare(`
        INSERT INTO categories (id, name, slug, parent_id, description, is_active, created_at, updated_at)
        VALUES (?, ?, ?, NULL, '', 1, ?, ?)
      `).run(newCatId, reqName, slug, nowIso, nowIso);
      categoryId = newCatId;
      categoryName = reqName;
    }
  } else if (!categoryId) {
    const defaultCat = db
      .prepare("SELECT id, name FROM categories WHERE LOWER(name) = 'lainnya' LIMIT 1")
      .get() as { id: string; name: string } | undefined;
    if (defaultCat) {
      categoryId = defaultCat.id;
      categoryName = defaultCat.name;
    } else {
      const newCatId = 'cat-lainnya';
      db.prepare(`
        INSERT OR IGNORE INTO categories (id, name, slug, parent_id, description, is_active, created_at, updated_at)
        VALUES ('cat-lainnya', 'Lainnya', 'lainnya', NULL, '', 1, ?, ?)
      `).run(nowIso, nowIso);
      categoryId = newCatId;
      categoryName = 'Lainnya';
    }
  }

  // Subcategory resolution
  let subcategoryId: string | null = fallback?.subcategoryId ?? null;
  if (input.subcategoryId !== undefined) {
    if (typeof input.subcategoryId === 'string' && input.subcategoryId.trim()) {
      const sub = db
        .prepare('SELECT id, parent_id FROM categories WHERE id = ?')
        .get(input.subcategoryId.trim()) as { id: string; parent_id: string | null } | undefined;
      if (!sub) {
        throw new ServiceError(404, 'Subkategori yang dipilih tidak ditemukan.');
      }
      if (sub.parent_id && sub.parent_id !== categoryId) {
        throw new ServiceError(400, 'Subkategori tidak termasuk dalam kategori induk yang dipilih.');
      }
      subcategoryId = sub.id;
    } else {
      subcategoryId = null;
    }
  }

  // Brand resolution
  let brandId: string | null = fallback?.brandId ?? null;
  if (input.brandId !== undefined) {
    if (typeof input.brandId === 'string' && input.brandId.trim()) {
      const br = db
        .prepare('SELECT id FROM brands WHERE id = ?')
        .get(input.brandId.trim()) as { id: string } | undefined;
      if (!br) {
        throw new ServiceError(404, 'Merek yang dipilih tidak ditemukan.');
      }
      brandId = br.id;
    } else {
      brandId = null;
    }
  } else if (typeof input.brandName === 'string' && input.brandName.trim()) {
    const bName = input.brandName.trim();
    const existingBrand = db
      .prepare('SELECT id FROM brands WHERE LOWER(name) = LOWER(?)')
      .get(bName) as { id: string } | undefined;
    if (existingBrand) {
      brandId = existingBrand.id;
    } else {
      const newBrandId = `brd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      db.prepare(`
        INSERT INTO brands (id, name, description, is_active, created_at, updated_at)
        VALUES (?, ?, '', 1, ?, ?)
      `).run(newBrandId, bName, nowIso, nowIso);
      brandId = newBrandId;
    }
  } else if (!brandId) {
    const umum = db.prepare("SELECT id FROM brands WHERE LOWER(name) = 'umum' LIMIT 1").get() as
      | { id: string }
      | undefined;
    brandId = umum?.id ?? null;
  }

  // UOM resolution
  let uomId = fallback?.uomId ?? null;
  let unitCode = fallback?.unit ?? 'PCS';

  if (typeof input.uomId === 'string' && input.uomId.trim()) {
    const uRow = db
      .prepare('SELECT id, code FROM units_of_measure WHERE id = ?')
      .get(input.uomId.trim()) as { id: string; code: string } | undefined;
    if (!uRow) {
      throw new ServiceError(404, 'Satuan (UOM) yang dipilih tidak ditemukan.');
    }
    uomId = uRow.id;
    unitCode = uRow.code;
  } else if (typeof input.unit === 'string' && input.unit.trim()) {
    const normalized = normalizeUnitCode(input.unit);
    const uRow = db
      .prepare('SELECT id, code FROM units_of_measure WHERE UPPER(code) = ?')
      .get(normalized) as { id: string; code: string } | undefined;
    if (uRow) {
      uomId = uRow.id;
      unitCode = uRow.code;
    } else {
      const newUomId = `uom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      db.prepare(`
        INSERT INTO units_of_measure (id, code, name, is_system, is_active, created_at)
        VALUES (?, ?, ?, 0, 1, ?)
      `).run(newUomId, normalized, normalized, nowIso);
      uomId = newUomId;
      unitCode = normalized;
    }
  } else if (!uomId) {
    const pcs = db.prepare("SELECT id, code FROM units_of_measure WHERE code = 'PCS' LIMIT 1").get() as
      | { id: string; code: string }
      | undefined;
    if (pcs) {
      uomId = pcs.id;
      unitCode = pcs.code;
    } else {
      uomId = 'uom-pcs';
      unitCode = 'PCS';
    }
  }

  return {
    brandId,
    categoryId,
    categoryName,
    subcategoryId,
    uomId,
    unitCode,
  };
}

function parseOptionalDimension(val: unknown, label: string): number | null {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) {
    throw new ServiceError(400, `${label} harus berupa angka valid minimal 0.`);
  }
  return num;
}

export function createProduct(
  input: CreateProductInput,
  actor?: UserSummary
): { product: Product; store: StoreData } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw new ServiceError(400, 'Nama produk wajib diisi.');
  }

  const barcodes = resolveProductBarcodesInput(input);
  const primaryBarcode = barcodes.find((b) => b.isPrimary)!.barcode;

  const skuInput = typeof input.sku === 'string' ? input.sku.trim() : '';
  const sku = skuInput || generateNextSku();
  if (sku.length < 2 || sku.length > 64 || /\s/.test(sku)) {
    throw new ServiceError(400, 'SKU harus 2–64 karakter tanpa spasi.');
  }

  const costPrice = Math.round(assertFiniteNonNegative(input.costPrice ?? 0, 'Harga modal'));
  const sellPrice = Math.round(assertFiniteNonNegative(input.sellPrice, 'Harga jual'));
  if (sellPrice <= 0) {
    throw new ServiceError(400, 'Harga jual harus lebih besar dari Rp 0.');
  }

  const specialPriceRaw = parseOptionalDimension(input.specialPrice, 'Harga khusus');
  const specialPrice = specialPriceRaw !== null && specialPriceRaw > 0 ? Math.round(specialPriceRaw) : null;

  const initialStock = Math.floor(assertFiniteNonNegative(input.stock ?? 0, 'Stok awal'));
  const minStock = Math.floor(assertFiniteNonNegative(input.minStock ?? 5, 'Batas minimum stok'));

  const weight = parseOptionalDimension(input.weight, 'Berat');
  const volume = parseOptionalDimension(input.volume, 'Volume');

  const rawTax =
    typeof input.taxCategory === 'string' ? input.taxCategory.trim().toUpperCase() : 'STANDARD';
  const taxCategory: TaxCategory = VALID_TAX_CATEGORIES.has(rawTax as TaxCategory)
    ? (rawTax as TaxCategory)
    : (() => {
        throw new ServiceError(400, 'Kategori pajak tidak valid (gunakan STANDARD, EXEMPT, atau REDUCED).');
      })();

  const status: ProductStatus =
    input.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';

  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const variant = typeof input.variant === 'string' ? input.variant.trim() : '';
  const size = typeof input.size === 'string' ? input.size.trim() : '';

  const db = getDb();

  // Duplicate SKU check
  const dupSku = db
    .prepare('SELECT id, name FROM products WHERE LOWER(sku) = LOWER(?)')
    .get(sku) as { id: string; name: string } | undefined;
  if (dupSku) {
    throw new ServiceError(409, `SKU "${sku}" sudah digunakan oleh "${dupSku.name}".`);
  }

  // Duplicate barcode check across product_barcodes
  const checkBarcodeStmt = db.prepare(
    'SELECT product_id, barcode FROM product_barcodes WHERE LOWER(barcode) = LOWER(?)'
  );
  for (const b of barcodes) {
    const dupBc = checkBarcodeStmt.get(b.barcode) as
      | { product_id: string; barcode: string }
      | undefined;
    if (dupBc) {
      throw new ServiceError(409, `Barcode ${b.barcode} sudah terdaftar pada produk lain.`);
    }
  }

  const nowIso = new Date().toISOString();
  const productId = `prd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  db.exec('BEGIN IMMEDIATE;');
  try {
    const rel = resolveCatalogRelations(input);

    db.prepare(`
      INSERT INTO products (
        id, sku, barcode, name, description, brand_id, category_id, subcategory_id,
        category, uom_id, unit, variant, size, weight, volume,
        cost_price, sell_price, special_price, tax_category, stock, min_stock,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      productId,
      sku,
      primaryBarcode,
      name,
      description,
      rel.brandId,
      rel.categoryId,
      rel.subcategoryId,
      rel.categoryName,
      rel.uomId,
      rel.unitCode,
      variant,
      size,
      weight,
      volume,
      costPrice,
      sellPrice,
      specialPrice,
      taxCategory,
      initialStock,
      minStock,
      status,
      nowIso,
      nowIso
    );

    const insertBarcodeStmt = db.prepare(`
      INSERT INTO product_barcodes (id, product_id, barcode, barcode_type, is_primary, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    barcodes.forEach((b, idx) => {
      insertBarcodeStmt.run(
        `bc-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        productId,
        b.barcode,
        b.barcodeType,
        b.isPrimary ? 1 : 0,
        nowIso
      );
    });

    if (initialStock > 0) {
      db.prepare(`
        INSERT INTO stock_movements (
          id, product_id, product_name, barcode, type, qty_delta, stock_before, stock_after, reference_id, notes, created_at
        ) VALUES (?, ?, ?, ?, 'STOK_AWAL', ?, 0, ?, 'INIT-SKU', 'Stok awal pendaftaran produk baru', ?)
      `).run(
        `mov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        productId,
        name,
        primaryBarcode,
        initialStock,
        initialStock,
        nowIso
      );
    }

    recordAuditLog(db, {
      action: 'PRODUCT_CREATED',
      entityType: 'product',
      entityId: productId,
      actorUserId: actor?.id ?? null,
      actor: actor?.fullName || querySettings().cashierName,
      summary: `Tambah produk "${name}" (${sku} · ${primaryBarcode}), stok awal ${initialStock} ${rel.unitCode}`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return { product: getProductById(productId), store: getBootstrapData(actor) };
}

export function updateProduct(
  id: string,
  input: CreateProductInput,
  actor?: UserSummary
): { product: Product; store: StoreData } {
  const db = getDb();
  const current = getProductById(id);

  const name = input.name !== undefined ? String(input.name).trim() : current.name;
  if (!name) {
    throw new ServiceError(400, 'Nama produk wajib diisi.');
  }

  const sku =
    input.sku !== undefined && String(input.sku).trim()
      ? String(input.sku).trim()
      : current.sku;
  if (sku.length < 2 || sku.length > 64 || /\s/.test(sku)) {
    throw new ServiceError(400, 'SKU harus 2–64 karakter tanpa spasi.');
  }

  const dupSku = db
    .prepare('SELECT id, name FROM products WHERE LOWER(sku) = LOWER(?) AND id != ?')
    .get(sku, id) as { id: string; name: string } | undefined;
  if (dupSku) {
    throw new ServiceError(409, `SKU "${sku}" sudah digunakan oleh "${dupSku.name}".`);
  }

  const barcodes = resolveProductBarcodesInput(
    input,
    current.barcode,
    current.barcodes.map((b) => ({
      barcode: b.barcode,
      barcodeType: b.barcodeType,
      isPrimary: b.isPrimary,
    }))
  );
  const primaryBarcode = barcodes.find((b) => b.isPrimary)!.barcode;

  // Duplicate barcode check excluding current product
  const dupBcStmt = db.prepare(
    'SELECT product_id FROM product_barcodes WHERE LOWER(barcode) = LOWER(?) AND product_id != ?'
  );
  for (const b of barcodes) {
    const dup = dupBcStmt.get(b.barcode, id) as { product_id: string } | undefined;
    if (dup) {
      throw new ServiceError(409, `Barcode ${b.barcode} sudah dipakai oleh produk lain.`);
    }
  }

  const costPrice =
    input.costPrice !== undefined
      ? Math.round(assertFiniteNonNegative(input.costPrice, 'Harga modal'))
      : current.costPrice;
  const sellPrice =
    input.sellPrice !== undefined
      ? Math.round(assertFiniteNonNegative(input.sellPrice, 'Harga jual'))
      : current.sellPrice;
  if (sellPrice <= 0) {
    throw new ServiceError(400, 'Harga jual harus lebih besar dari Rp 0.');
  }

  const specialPrice =
    input.specialPrice !== undefined
      ? (() => {
          const val = parseOptionalDimension(input.specialPrice, 'Harga khusus');
          return val !== null && val > 0 ? Math.round(val) : null;
        })()
      : current.specialPrice;

  const minStock =
    input.minStock !== undefined
      ? Math.floor(assertFiniteNonNegative(input.minStock, 'Batas minimum stok'))
      : current.minStock;

  const weight =
    input.weight !== undefined ? parseOptionalDimension(input.weight, 'Berat') : current.weight;
  const volume =
    input.volume !== undefined ? parseOptionalDimension(input.volume, 'Volume') : current.volume;

  const taxCategory: TaxCategory =
    input.taxCategory !== undefined
      ? (() => {
          const rawTax = String(input.taxCategory).trim().toUpperCase();
          if (!VALID_TAX_CATEGORIES.has(rawTax as TaxCategory)) {
            throw new ServiceError(400, 'Kategori pajak tidak valid.');
          }
          return rawTax as TaxCategory;
        })()
      : current.taxCategory;

  const status: ProductStatus =
    input.status !== undefined
      ? input.status === 'INACTIVE'
        ? 'INACTIVE'
        : 'ACTIVE'
      : current.status;

  const description =
    input.description !== undefined ? String(input.description).trim() : current.description;
  const variant = input.variant !== undefined ? String(input.variant).trim() : current.variant;
  const size = input.size !== undefined ? String(input.size).trim() : current.size;
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    const rel = resolveCatalogRelations(input, current);

    db.prepare(`
      UPDATE products
      SET sku = ?, barcode = ?, name = ?, description = ?,
          brand_id = ?, category_id = ?, subcategory_id = ?, category = ?,
          uom_id = ?, unit = ?, variant = ?, size = ?, weight = ?, volume = ?,
          cost_price = ?, sell_price = ?, special_price = ?, tax_category = ?,
          min_stock = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      sku,
      primaryBarcode,
      name,
      description,
      rel.brandId,
      rel.categoryId,
      rel.subcategoryId,
      rel.categoryName,
      rel.uomId,
      rel.unitCode,
      variant,
      size,
      weight,
      volume,
      costPrice,
      sellPrice,
      specialPrice,
      taxCategory,
      minStock,
      status,
      nowIso,
      id
    );

    if (input.barcodes !== undefined || input.barcode !== undefined) {
      db.prepare('DELETE FROM product_barcodes WHERE product_id = ?').run(id);
      const insertBarcodeStmt = db.prepare(`
        INSERT INTO product_barcodes (id, product_id, barcode, barcode_type, is_primary, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      barcodes.forEach((b, idx) => {
        insertBarcodeStmt.run(
          `bc-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
          id,
          b.barcode,
          b.barcodeType,
          b.isPrimary ? 1 : 0,
          nowIso
        );
      });
    }

    recordAuditLog(db, {
      action: 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: id,
      actorUserId: actor?.id ?? null,
      actor: actor?.fullName || querySettings().cashierName,
      summary: `Perbarui produk "${name}" (${sku} · ${primaryBarcode})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return { product: getProductById(id), store: getBootstrapData(actor) };
}

export function setProductStatus(
  id: string,
  status: ProductStatus,
  actor?: UserSummary
): { product: Product; store: StoreData } {
  const db = getDb();
  const current = getProductById(id);
  if (status !== 'ACTIVE' && status !== 'INACTIVE') {
    throw new ServiceError(400, 'Status produk harus ACTIVE atau INACTIVE.');
  }
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      nowIso,
      id
    );
    recordAuditLog(db, {
      action: 'PRODUCT_STATUS_CHANGED',
      entityType: 'product',
      entityId: id,
      actorUserId: actor?.id ?? null,
      actor: actor?.fullName || querySettings().cashierName,
      summary: `${status === 'ACTIVE' ? 'Aktifkan' : 'Nonaktifkan'} produk "${current.name}" (${current.sku})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return { product: getProductById(id), store: getBootstrapData(actor) };
}

export function deleteProduct(id: string, actor?: UserSummary): { store: StoreData } {
  const db = getDb();
  const target = getProductById(id);
  const imagePaths = db
    .prepare('SELECT storage_path FROM product_images WHERE product_id = ?')
    .all(id) as Array<{ storage_path: string }>;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    recordAuditLog(db, {
      action: 'PRODUCT_DELETED',
      entityType: 'product',
      entityId: id,
      actorUserId: actor?.id ?? null,
      actor: actor?.fullName || querySettings().cashierName,
      summary: `Hapus produk "${target.name}" (${target.sku} · ${target.barcode})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  for (const img of imagePaths) {
    if (img.storage_path && fs.existsSync(img.storage_path)) {
      try {
        fs.unlinkSync(img.storage_path);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  return { store: getBootstrapData(actor) };
}

export interface AdjustStockInput {
  productId?: unknown;
  type?: unknown;
  qty?: unknown;
  notes?: unknown;
  pinApprovalToken?: unknown;
}

export function adjustStock(
  input: AdjustStockInput,
  actor?: UserSummary
): {
  product: Product;
  movement: StockMovement;
  store: StoreData;
} {
  const productId = typeof input.productId === 'string' ? input.productId : '';
  if (!productId) {
    throw new ServiceError(400, 'ID produk wajib disertakan.');
  }

  const db = getDb();
  const hasPermission = !actor || actor.permissions.includes('stock:adjust');
  const pinToken = typeof input.pinApprovalToken === 'string' ? input.pinApprovalToken.trim() : '';

  if (!hasPermission && !pinToken) {
    throw new ServiceError(
      403,
      'Penyesuaian stok memerlukan izin stock:adjust atau otorisasi PIN Supervisor/Admin.',
      'PIN_REQUIRED'
    );
  }

  const product = getProductById(productId);
  const stockBefore = product.stock;
  let stockAfter = stockBefore;
  let qtyDelta = 0;
  let adjustmentType: StockMovementType;

  if (input.type === 'RESTOK') {
    adjustmentType = 'RESTOK';
    const rawQty = Math.floor(assertFiniteNonNegative(input.qty, 'Jumlah restok'));
    if (rawQty <= 0) {
      throw new ServiceError(400, 'Jumlah restok harus minimal 1.');
    }
    stockAfter = stockBefore + rawQty;
    qtyDelta = rawQty;
  } else if (input.type === 'OPNAME') {
    adjustmentType = 'OPNAME';
    const targetStock = Math.floor(assertFiniteNonNegative(input.qty, 'Stok fisik opname'));
    stockAfter = targetStock;
    qtyDelta = targetStock - stockBefore;
  } else {
    throw new ServiceError(400, 'Jenis penyesuaian stok tidak valid (gunakan RESTOK atau OPNAME).');
  }

  const nowIso = new Date().toISOString();
  const dateStamp = nowIso.slice(0, 10).replace(/-/g, '');
  const notesText = typeof input.notes === 'string' ? input.notes.trim() : '';
  const movement: StockMovement = {
    id: `mov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    productId: product.id,
    productName: product.name,
    barcode: product.barcode,
    type: adjustmentType,
    qtyDelta,
    stockBefore,
    stockAfter,
    referenceId: adjustmentType === 'RESTOK' ? `RST-${dateStamp}` : `OPN-${dateStamp}`,
    notes:
      notesText ||
      (adjustmentType === 'RESTOK' ? 'Penambahan stok masuk' : 'Penyesuaian stok opname'),
    createdAt: nowIso,
  };

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (!hasPermission && pinToken) {
      consumePinApprovalToken(db, pinToken, 'stock_adjustment');
    }

    db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(
      stockAfter,
      nowIso,
      product.id
    );

    db.prepare(`
      INSERT INTO stock_movements (
        id, product_id, product_name, barcode, type, qty_delta, stock_before, stock_after, reference_id, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      movement.id,
      movement.productId,
      movement.productName,
      movement.barcode,
      movement.type,
      movement.qtyDelta,
      movement.stockBefore,
      movement.stockAfter,
      movement.referenceId,
      movement.notes,
      movement.createdAt
    );

    recordAuditLog(db, {
      action: 'STOCK_ADJUSTED',
      entityType: 'stock',
      entityId: product.id,
      actorUserId: actor?.id ?? null,
      actor: actor?.fullName || querySettings().cashierName,
      summary: `${adjustmentType} "${product.name}": ${stockBefore} → ${stockAfter} ${product.unit}`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return {
    product: getProductById(product.id),
    movement,
    store: getBootstrapData(actor),
  };
}

export function processTransaction(
  input: CheckoutInput,
  actor?: UserSummary
): {
  transaction: Transaction;
  idempotentReplay: boolean;
  store: StoreData;
} {
  const { transaction, idempotentReplay } = executeTransactionalCheckout(input, actor);
  return {
    transaction,
    idempotentReplay,
    store: getBootstrapData(actor),
  };
}

export function updateSettings(
  input: Partial<StoreSettings>,
  actor?: UserSummary
): {
  settings: StoreSettings;
  store: StoreData;
} {
  const db = getDb();
  const current = querySettings();
  const storeName =
    input.storeName !== undefined ? String(input.storeName).trim() : current.storeName;
  if (!storeName) {
    throw new ServiceError(400, 'Nama toko tidak boleh kosong.');
  }

  let taxRate = current.taxRate;
  if (input.taxRate !== undefined) {
    const parsedRate = Number(input.taxRate);
    if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 30) {
      throw new ServiceError(400, 'Tarif PPN harus antara 0% hingga 30%.');
    }
    taxRate = parsedRate;
  }

  let receiptPaperWidth: ReceiptPaperWidth = current.receiptPaperWidth ?? '80mm';
  if (input.receiptPaperWidth !== undefined) {
    const rawW = String(input.receiptPaperWidth).trim();
    if (rawW !== '58mm' && rawW !== '80mm' && rawW !== 'A4') {
      throw new ServiceError(400, 'Lebar kertas struk harus 58mm, 80mm, atau A4.');
    }
    receiptPaperWidth = rawW;
  }

  const nextSettings: StoreSettings = {
    storeName,
    storeAddress:
      input.storeAddress !== undefined ? String(input.storeAddress).trim() : current.storeAddress,
    storePhone:
      input.storePhone !== undefined ? String(input.storePhone).trim() : current.storePhone,
    receiptFooter:
      input.receiptFooter !== undefined
        ? String(input.receiptFooter).trim()
        : current.receiptFooter,
    taxEnabled: input.taxEnabled !== undefined ? Boolean(input.taxEnabled) : current.taxEnabled,
    taxRate,
    cashierName:
      input.cashierName !== undefined && String(input.cashierName).trim()
        ? String(input.cashierName).trim()
        : current.cashierName,
    storeLogoUrl: current.storeLogoUrl ?? '',
    receiptPaperWidth,
    receiptShowLogo:
      input.receiptShowLogo !== undefined
        ? Boolean(input.receiptShowLogo)
        : (current.receiptShowLogo ?? true),
    receiptShowQr:
      input.receiptShowQr !== undefined
        ? Boolean(input.receiptShowQr)
        : (current.receiptShowQr ?? true),
    receiptHeaderNote:
      input.receiptHeaderNote !== undefined
        ? String(input.receiptHeaderNote).trim()
        : (current.receiptHeaderNote ?? ''),
  };

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE store_settings
      SET store_name = ?, store_address = ?, store_phone = ?, receipt_footer = ?,
          tax_enabled = ?, tax_rate = ?, cashier_name = ?,
          receipt_paper_width = ?, receipt_show_logo = ?, receipt_show_qr = ?, receipt_header_note = ?
      WHERE id = 1
    `).run(
      nextSettings.storeName,
      nextSettings.storeAddress,
      nextSettings.storePhone,
      nextSettings.receiptFooter,
      nextSettings.taxEnabled ? 1 : 0,
      nextSettings.taxRate,
      nextSettings.cashierName,
      nextSettings.receiptPaperWidth ?? '80mm',
      nextSettings.receiptShowLogo ? 1 : 0,
      nextSettings.receiptShowQr ? 1 : 0,
      nextSettings.receiptHeaderNote ?? ''
    );

    recordAuditLog(db, {
      action: 'SETTINGS_UPDATED',
      entityType: 'settings',
      entityId: 'store-settings',
      actorUserId: actor?.id ?? null,
      actor: actor?.fullName || nextSettings.cashierName,
      summary: `Pembaruan pengaturan toko "${nextSettings.storeName}" (PPN ${nextSettings.taxRate}%, Struk ${nextSettings.receiptPaperWidth})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return { settings: nextSettings, store: getBootstrapData(actor) };
}
