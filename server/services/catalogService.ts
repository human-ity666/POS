import fs from 'node:fs';
import path from 'node:path';
import { getDb, getProductUploadsDir } from '../db/database.ts';
import { recordAuditLog } from './auditService.ts';
import { ServiceError } from './errors.ts';
import type {
  BarcodeType,
  Brand,
  Category,
  CsvImportPreviewResult,
  CsvImportPreviewRow,
  ImageReferenceAngle,
  Product,
  ProductBarcode,
  ProductImage,
  ProductListResponse,
  ProductStatus,
  TaxCategory,
  UnitOfMeasure,
  UserSummary,
} from '../../src/types.ts';

const VALID_BARCODE_TYPES: ReadonlySet<BarcodeType> = new Set([
  'EAN-13',
  'EAN-8',
  'UPC-A',
  'UPC-E',
  'CODE-128',
  'CODE-39',
  'QR',
  'INTERNAL',
]);

const VALID_TAX_CATEGORIES: ReadonlySet<TaxCategory> = new Set([
  'STANDARD',
  'EXEMPT',
  'REDUCED',
]);

const VALID_REFERENCE_ANGLES: ReadonlySet<ImageReferenceAngle> = new Set([
  'front',
  'back',
  'side',
  'top',
  'packaging',
  'other',
]);

const ALLOWED_IMAGE_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB

export function slugifyText(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

export function normalizeUnitCode(raw: string): string {
  const clean = raw.trim();
  const lower = clean.toLowerCase();
  if (lower === 'bungkus' || lower === 'pack' || lower === 'pouch' || lower === 'bks') return 'PACK';
  if (lower === 'botol' || lower === 'bottle' || lower === 'btl') return 'BOTTLE';
  if (lower === 'kotak' || lower === 'box' || lower === 'dus' || lower === 'karton') return 'BOX';
  if (lower === 'kg' || lower === 'kilogram' || lower === 'sak') return 'KG';
  if (lower === 'gram' || lower === 'gr' || lower === 'g') return 'GRAM';
  if (lower === 'liter' || lower === 'l' || lower === 'ltr') return 'LITER';
  if (lower === 'ml' || lower === 'mililiter') return 'ML';
  if (lower === 'pcs' || lower === 'buah' || lower === 'unit' || lower === 'tube') return 'PCS';
  return clean.toUpperCase() || 'PCS';
}

export function validateBarcodeValue(
  rawBarcode: string,
  barcodeType: BarcodeType = 'EAN-13'
): { barcode: string; barcodeType: BarcodeType } {
  const code = rawBarcode.trim();
  if (code.length < 3 || code.length > 64) {
    throw new ServiceError(400, 'Panjang kode barcode harus antara 3 hingga 64 karakter.');
  }
  if (/\s/.test(code) || !/^[A-Za-z0-9._:/-]+$/.test(code)) {
    throw new ServiceError(
      400,
      `Format barcode "${code}" tidak valid (tidak boleh mengandung spasi atau karakter khusus terlarang).`
    );
  }
  if (!VALID_BARCODE_TYPES.has(barcodeType)) {
    throw new ServiceError(400, `Tipe barcode "${barcodeType}" tidak didukung.`);
  }
  if (barcodeType === 'EAN-8' && !/^\d{8}$/.test(code)) {
    throw new ServiceError(400, `Barcode tipe EAN-8 harus terdiri dari tepat 8 digit angka.`);
  }
  if (barcodeType === 'UPC-A' && !/^\d{12}$/.test(code)) {
    throw new ServiceError(400, `Barcode tipe UPC-A harus terdiri dari tepat 12 digit angka.`);
  }
  if (barcodeType === 'EAN-13' && !/^\d{13}$/.test(code)) {
    // Allow fallback to CODE-128 only if caller didn't explicitly pick strict EAN-13; otherwise enforce digits
    throw new ServiceError(400, `Barcode tipe EAN-13 harus terdiri dari tepat 13 digit angka.`);
  }
  return { barcode: code, barcodeType };
}

export function inferBarcodeType(code: string, requested?: unknown): BarcodeType {
  if (typeof requested === 'string' && VALID_BARCODE_TYPES.has(requested as BarcodeType)) {
    return requested as BarcodeType;
  }
  const trimmed = code.trim();
  if (/^\d{13}$/.test(trimmed)) return 'EAN-13';
  if (/^\d{8}$/.test(trimmed)) return 'EAN-8';
  if (/^\d{12}$/.test(trimmed)) return 'UPC-A';
  return 'CODE-128';
}

export function generateNextSku(): string {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM products').get() as { cnt: number };
  let seq = row.cnt + 1;
  while (true) {
    const candidate = `SKU-${String(seq).padStart(4, '0')}`;
    const exists = db.prepare('SELECT 1 FROM products WHERE sku = ?').get(candidate);
    if (!exists) return candidate;
    seq++;
  }
}

export function queryEnrichedProducts(): Product[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT
        p.id,
        COALESCE(p.sku, p.id) AS sku,
        p.barcode,
        p.name,
        COALESCE(p.description, '') AS description,
        p.brand_id,
        COALESCE(b.name, 'Umum') AS brand_name,
        p.category_id,
        COALESCE(c.name, p.category) AS category_name,
        p.subcategory_id,
        COALESCE(sc.name, '') AS subcategory_name,
        p.uom_id,
        COALESCE(u.code, p.unit) AS uom_code,
        COALESCE(p.variant, '') AS variant,
        COALESCE(p.size, '') AS size,
        p.weight,
        p.volume,
        p.cost_price,
        p.sell_price,
        p.special_price,
        COALESCE(p.tax_category, 'STANDARD') AS tax_category,
        p.stock,
        p.min_stock,
        COALESCE(p.status, 'ACTIVE') AS status,
        p.primary_image_id,
        COALESCE(p.created_at, p.updated_at) AS created_at,
        p.updated_at
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN categories sc ON sc.id = p.subcategory_id
      LEFT JOIN units_of_measure u ON u.id = p.uom_id
      ORDER BY p.updated_at DESC, p.name ASC
    `)
    .all() as Array<{
    id: string;
    sku: string;
    barcode: string;
    name: string;
    description: string;
    brand_id: string | null;
    brand_name: string;
    category_id: string | null;
    category_name: string;
    subcategory_id: string | null;
    subcategory_name: string;
    uom_id: string | null;
    uom_code: string;
    variant: string;
    size: string;
    weight: number | null;
    volume: number | null;
    cost_price: number;
    sell_price: number;
    special_price: number | null;
    tax_category: TaxCategory;
    stock: number;
    min_stock: number;
    status: ProductStatus;
    primary_image_id: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const barcodeRows = db
    .prepare(`
      SELECT id, product_id, barcode, barcode_type, is_primary, created_at
      FROM product_barcodes
      ORDER BY is_primary DESC, created_at ASC
    `)
    .all() as Array<{
    id: string;
    product_id: string;
    barcode: string;
    barcode_type: BarcodeType;
    is_primary: number;
    created_at: string;
  }>;

  const imageRows = db
    .prepare(`
      SELECT id, product_id, file_name, mime_type, file_size, image_url, is_primary,
             is_ai_reference, reference_angle, ai_embedding_status, created_at
      FROM product_images
      ORDER BY is_primary DESC, created_at ASC
    `)
    .all() as Array<{
    id: string;
    product_id: string;
    file_name: string;
    mime_type: string;
    file_size: number;
    image_url: string;
    is_primary: number;
    is_ai_reference: number;
    reference_angle: ImageReferenceAngle;
    ai_embedding_status: 'PENDING' | 'READY' | 'NOT_APPLICABLE';
    created_at: string;
  }>;

  const barcodesByProduct = new Map<string, ProductBarcode[]>();
  for (const b of barcodeRows) {
    const list = barcodesByProduct.get(b.product_id) ?? [];
    list.push({
      id: b.id,
      productId: b.product_id,
      barcode: b.barcode,
      barcodeType: b.barcode_type,
      isPrimary: b.is_primary === 1,
      createdAt: b.created_at,
    });
    barcodesByProduct.set(b.product_id, list);
  }

  const imagesByProduct = new Map<string, ProductImage[]>();
  for (const img of imageRows) {
    const list = imagesByProduct.get(img.product_id) ?? [];
    list.push({
      id: img.id,
      productId: img.product_id,
      fileName: img.file_name,
      mimeType: img.mime_type,
      fileSize: img.file_size,
      imageUrl: img.image_url,
      isPrimary: img.is_primary === 1,
      isAiReference: img.is_ai_reference === 1,
      referenceAngle: img.reference_angle,
      aiEmbeddingStatus: img.ai_embedding_status,
      createdAt: img.created_at,
    });
    imagesByProduct.set(img.product_id, list);
  }

  return rows.map((r) => {
    const barcodes = barcodesByProduct.get(r.id) ?? [
      {
        id: `bc-fallback-${r.id}`,
        productId: r.id,
        barcode: r.barcode,
        barcodeType: inferBarcodeType(r.barcode),
        isPrimary: true,
        createdAt: r.created_at,
      },
    ];
    const images = imagesByProduct.get(r.id) ?? [];
    const primaryImage =
      images.find((i) => i.id === r.primary_image_id) ??
      images.find((i) => i.isPrimary) ??
      images[0] ??
      null;

    return {
      id: r.id,
      sku: r.sku,
      barcode: r.barcode,
      name: r.name,
      description: r.description,
      brandId: r.brand_id,
      brandName: r.brand_name,
      categoryId: r.category_id,
      category: r.category_name,
      subcategoryId: r.subcategory_id,
      subcategoryName: r.subcategory_name,
      uomId: r.uom_id,
      unit: r.uom_code,
      variant: r.variant,
      size: r.size,
      weight: r.weight,
      volume: r.volume,
      costPrice: r.cost_price,
      sellPrice: r.sell_price,
      specialPrice: r.special_price,
      taxCategory: r.tax_category,
      stock: r.stock,
      minStock: r.min_stock,
      status: r.status,
      primaryImageId: primaryImage?.id ?? r.primary_image_id ?? null,
      primaryImageUrl: primaryImage?.imageUrl ?? null,
      barcodes,
      images,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export function getProductById(id: string): Product {
  const found = queryEnrichedProducts().find((p) => p.id === id);
  if (!found) {
    throw new ServiceError(404, 'Produk tidak ditemukan.');
  }
  return found;
}

export function findProductByBarcode(code: string): Product {
  const trimmed = code.trim().toLowerCase();
  if (!trimmed) {
    throw new ServiceError(400, 'Kode barcode tidak boleh kosong.');
  }
  const products = queryEnrichedProducts();
  const match = products.find(
    (p) =>
      p.barcode.toLowerCase() === trimmed ||
      p.barcodes.some((b) => b.barcode.toLowerCase() === trimmed)
  );
  if (!match) {
    throw new ServiceError(404, `Produk dengan barcode "${code}" tidak ditemukan.`);
  }
  return match;
}

export interface ProductQueryParams {
  search?: string;
  categoryId?: string;
  subcategoryId?: string;
  brandId?: string;
  status?: string;
  stockStatus?: string;
  sortBy?: string;
  sortDir?: string;
  page?: number;
  pageSize?: number;
}

export function listProductsPaginated(params: ProductQueryParams): ProductListResponse {
  let items = queryEnrichedProducts();

  const search = (params.search ?? '').trim().toLowerCase();
  if (search) {
    items = items.filter(
      (p) =>
        p.name.toLowerCase().includes(search) ||
        p.sku.toLowerCase().includes(search) ||
        p.barcode.toLowerCase().includes(search) ||
        p.brandName.toLowerCase().includes(search) ||
        p.category.toLowerCase().includes(search) ||
        p.subcategoryName.toLowerCase().includes(search) ||
        p.barcodes.some((b) => b.barcode.toLowerCase().includes(search))
    );
  }

  if (params.categoryId && params.categoryId !== 'ALL') {
    items = items.filter(
      (p) => p.categoryId === params.categoryId || p.category === params.categoryId
    );
  }

  if (params.subcategoryId && params.subcategoryId !== 'ALL') {
    items = items.filter((p) => p.subcategoryId === params.subcategoryId);
  }

  if (params.brandId && params.brandId !== 'ALL') {
    items = items.filter((p) => p.brandId === params.brandId);
  }

  if (params.status === 'ACTIVE' || params.status === 'INACTIVE') {
    items = items.filter((p) => p.status === params.status);
  }

  if (params.stockStatus === 'habis') {
    items = items.filter((p) => p.stock <= 0);
  } else if (params.stockStatus === 'menipis') {
    items = items.filter((p) => p.stock > 0 && p.stock <= p.minStock);
  } else if (params.stockStatus === 'aman') {
    items = items.filter((p) => p.stock > p.minStock);
  }

  const sortDir = params.sortDir === 'asc' ? 1 : -1;
  const sortBy = params.sortBy || 'updatedAt';
  items.sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return a.name.localeCompare(b.name, 'id') * sortDir;
      case 'sku':
        return a.sku.localeCompare(b.sku, 'id') * sortDir;
      case 'costPrice':
        return (a.costPrice - b.costPrice) * sortDir;
      case 'sellPrice':
        return (a.sellPrice - b.sellPrice) * sortDir;
      case 'stock':
        return (a.stock - b.stock) * sortDir;
      case 'updatedAt':
      default:
        return a.updatedAt.localeCompare(b.updatedAt) * sortDir;
    }
  });

  const total = items.length;
  const pageSize = Math.min(100, Math.max(1, Number(params.pageSize || 25)));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(params.page || 1)));
  const start = (page - 1) * pageSize;
  const paged = items.slice(start, start + pageSize);

  return {
    products: paged,
    total,
    page,
    pageSize,
    totalPages,
  };
}

// --- Categories ---
export function listCategories(search?: string, statusFilter?: string): Category[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT
        c.id,
        c.name,
        c.slug,
        c.parent_id,
        p.name AS parent_name,
        c.description,
        c.is_active,
        c.created_at,
        c.updated_at,
        (
          SELECT COUNT(*) FROM products pr
          WHERE pr.category_id = c.id OR pr.subcategory_id = c.id
        ) AS product_count
      FROM categories c
      LEFT JOIN categories p ON p.id = c.parent_id
      ORDER BY COALESCE(p.name, c.name) ASC, c.parent_id IS NOT NULL ASC, c.name ASC
    `)
    .all() as Array<{
    id: string;
    name: string;
    slug: string;
    parent_id: string | null;
    parent_name: string | null;
    description: string;
    is_active: number;
    created_at: string;
    updated_at: string;
    product_count: number;
  }>;

  let list: Category[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    parentId: r.parent_id,
    parentName: r.parent_name,
    description: r.description,
    isActive: r.is_active === 1,
    productCount: r.product_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  if (statusFilter === 'active') {
    list = list.filter((c) => c.isActive);
  } else if (statusFilter === 'inactive') {
    list = list.filter((c) => !c.isActive);
  }

  const q = (search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        (c.parentName && c.parentName.toLowerCase().includes(q))
    );
  }
  return list;
}

export function createCategory(
  input: { name?: unknown; parentId?: unknown; description?: unknown; isActive?: unknown },
  actor: UserSummary
): Category {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw new ServiceError(400, 'Nama kategori wajib diisi.');
  }
  const parentId =
    typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : null;
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const isActive = input.isActive !== undefined ? Boolean(input.isActive) : true;

  const db = getDb();
  if (parentId) {
    const parent = db.prepare('SELECT id, parent_id FROM categories WHERE id = ?').get(parentId) as
      | { id: string; parent_id: string | null }
      | undefined;
    if (!parent) {
      throw new ServiceError(404, 'Kategori induk tidak ditemukan.');
    }
  }

  const baseSlug = slugifyText(name);
  let slug = baseSlug;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(slug)) {
    slug = `${baseSlug}-${suffix++}`;
  }

  const duplicateName = db
    .prepare(
      'SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND COALESCE(parent_id, \'\') = COALESCE(?, \'\')'
    )
    .get(name, parentId);
  if (duplicateName) {
    throw new ServiceError(409, `Kategori "${name}" sudah ada pada level tersebut.`);
  }

  const nowIso = new Date().toISOString();
  const id = `cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO categories (id, name, slug, parent_id, description, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, slug, parentId, description, isActive ? 1 : 0, nowIso, nowIso);

    recordAuditLog(db, {
      action: 'CATEGORY_CREATED',
      entityType: 'category',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Tambah kategori "${name}"`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return listCategories().find((c) => c.id === id)!;
}

export function updateCategory(
  id: string,
  input: { name?: unknown; parentId?: unknown; description?: unknown; isActive?: unknown },
  actor: UserSummary
): Category {
  const db = getDb();
  const current = db
    .prepare('SELECT id, name, slug, parent_id, description, is_active FROM categories WHERE id = ?')
    .get(id) as
    | {
        id: string;
        name: string;
        slug: string;
        parent_id: string | null;
        description: string;
        is_active: number;
      }
    | undefined;
  if (!current) {
    throw new ServiceError(404, 'Kategori tidak ditemukan.');
  }

  const name = input.name !== undefined ? String(input.name).trim() : current.name;
  if (!name) {
    throw new ServiceError(400, 'Nama kategori wajib diisi.');
  }

  const parentId =
    input.parentId !== undefined
      ? typeof input.parentId === 'string' && input.parentId.trim()
        ? input.parentId.trim()
        : null
      : current.parent_id;

  if (parentId === id) {
    throw new ServiceError(400, 'Kategori tidak dapat menjadi induk bagi dirinya sendiri.');
  }

  if (parentId) {
    const parent = db.prepare('SELECT id, parent_id FROM categories WHERE id = ?').get(parentId) as
      | { id: string; parent_id: string | null }
      | undefined;
    if (!parent) {
      throw new ServiceError(404, 'Kategori induk tidak ditemukan.');
    }
    if (parent.parent_id === id) {
      throw new ServiceError(400, 'Terjadi referensi melingkar pada hierarki kategori.');
    }
  }

  const description =
    input.description !== undefined ? String(input.description).trim() : current.description;
  const isActive = input.isActive !== undefined ? Boolean(input.isActive) : current.is_active === 1;
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE categories
      SET name = ?, parent_id = ?, description = ?, is_active = ?, updated_at = ?
      WHERE id = ?
    `).run(name, parentId, description, isActive ? 1 : 0, nowIso, id);

    // Keep denormalized category name on products synced
    if (!parentId) {
      db.prepare('UPDATE products SET category = ? WHERE category_id = ?').run(name, id);
    }

    recordAuditLog(db, {
      action: 'CATEGORY_UPDATED',
      entityType: 'category',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Perbarui kategori "${name}" (${isActive ? 'Aktif' : 'Nonaktif'})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return listCategories().find((c) => c.id === id)!;
}

// --- Brands ---
export function listBrands(search?: string, statusFilter?: string): Brand[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT
        b.id,
        b.name,
        b.description,
        b.is_active,
        b.created_at,
        b.updated_at,
        (SELECT COUNT(*) FROM products pr WHERE pr.brand_id = b.id) AS product_count
      FROM brands b
      ORDER BY b.name ASC
    `)
    .all() as Array<{
    id: string;
    name: string;
    description: string;
    is_active: number;
    created_at: string;
    updated_at: string;
    product_count: number;
  }>;

  let list: Brand[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isActive: r.is_active === 1,
    productCount: r.product_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  if (statusFilter === 'active') list = list.filter((b) => b.isActive);
  if (statusFilter === 'inactive') list = list.filter((b) => !b.isActive);

  const q = (search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (b) => b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q)
    );
  }
  return list;
}

export function createBrand(
  input: { name?: unknown; description?: unknown; isActive?: unknown },
  actor: UserSummary
): Brand {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw new ServiceError(400, 'Nama merek wajib diisi.');
  }
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const isActive = input.isActive !== undefined ? Boolean(input.isActive) : true;
  const db = getDb();

  const dup = db.prepare('SELECT id FROM brands WHERE LOWER(name) = LOWER(?)').get(name);
  if (dup) {
    throw new ServiceError(409, `Merek "${name}" sudah terdaftar.`);
  }

  const nowIso = new Date().toISOString();
  const id = `brd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO brands (id, name, description, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, description, isActive ? 1 : 0, nowIso, nowIso);

    recordAuditLog(db, {
      action: 'BRAND_CREATED',
      entityType: 'brand',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Tambah merek "${name}"`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return listBrands().find((b) => b.id === id)!;
}

export function updateBrand(
  id: string,
  input: { name?: unknown; description?: unknown; isActive?: unknown },
  actor: UserSummary
): Brand {
  const db = getDb();
  const current = db
    .prepare('SELECT id, name, description, is_active FROM brands WHERE id = ?')
    .get(id) as
    | { id: string; name: string; description: string; is_active: number }
    | undefined;
  if (!current) {
    throw new ServiceError(404, 'Merek tidak ditemukan.');
  }

  const name = input.name !== undefined ? String(input.name).trim() : current.name;
  if (!name) {
    throw new ServiceError(400, 'Nama merek wajib diisi.');
  }
  const dup = db
    .prepare('SELECT id FROM brands WHERE LOWER(name) = LOWER(?) AND id != ?')
    .get(name, id);
  if (dup) {
    throw new ServiceError(409, `Merek "${name}" sudah digunakan.`);
  }

  const description =
    input.description !== undefined ? String(input.description).trim() : current.description;
  const isActive = input.isActive !== undefined ? Boolean(input.isActive) : current.is_active === 1;
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE brands
      SET name = ?, description = ?, is_active = ?, updated_at = ?
      WHERE id = ?
    `).run(name, description, isActive ? 1 : 0, nowIso, id);

    recordAuditLog(db, {
      action: 'BRAND_UPDATED',
      entityType: 'brand',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Perbarui merek "${name}" (${isActive ? 'Aktif' : 'Nonaktif'})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return listBrands().find((b) => b.id === id)!;
}

// --- Units of Measure (UOM) ---
export function listUoms(search?: string): UnitOfMeasure[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT
        u.id,
        u.code,
        u.name,
        u.is_system,
        u.is_active,
        u.created_at,
        (SELECT COUNT(*) FROM products pr WHERE pr.uom_id = u.id) AS product_count
      FROM units_of_measure u
      ORDER BY u.is_system DESC, u.code ASC
    `)
    .all() as Array<{
    id: string;
    code: string;
    name: string;
    is_system: number;
    is_active: number;
    created_at: string;
    product_count: number;
  }>;

  let list: UnitOfMeasure[] = rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    isSystem: r.is_system === 1,
    isActive: r.is_active === 1,
    productCount: r.product_count,
    createdAt: r.created_at,
  }));

  const q = (search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (u) => u.code.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)
    );
  }
  return list;
}

export function createUom(
  input: { code?: unknown; name?: unknown; isActive?: unknown },
  actor: UserSummary
): UnitOfMeasure {
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!code || !name) {
    throw new ServiceError(400, 'Kode satuan dan nama satuan wajib diisi.');
  }
  if (!/^[A-Z0-9_-]{1,16}$/.test(code)) {
    throw new ServiceError(400, 'Kode satuan maksimal 16 karakter (huruf kapital/angka).');
  }

  const db = getDb();
  const dup = db.prepare('SELECT id FROM units_of_measure WHERE UPPER(code) = ?').get(code);
  if (dup) {
    throw new ServiceError(409, `Satuan "${code}" sudah terdaftar.`);
  }

  const nowIso = new Date().toISOString();
  const id = `uom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const isActive = input.isActive !== undefined ? Boolean(input.isActive) : true;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO units_of_measure (id, code, name, is_system, is_active, created_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(id, code, name, isActive ? 1 : 0, nowIso);

    recordAuditLog(db, {
      action: 'UOM_CREATED',
      entityType: 'uom',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Tambah satuan UOM "${code}" (${name})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return listUoms().find((u) => u.id === id)!;
}

export function updateUom(
  id: string,
  input: { code?: unknown; name?: unknown; isActive?: unknown },
  actor: UserSummary
): UnitOfMeasure {
  const db = getDb();
  const current = db
    .prepare('SELECT id, code, name, is_system, is_active FROM units_of_measure WHERE id = ?')
    .get(id) as
    | { id: string; code: string; name: string; is_system: number; is_active: number }
    | undefined;
  if (!current) {
    throw new ServiceError(404, 'Satuan tidak ditemukan.');
  }

  const code =
    input.code !== undefined ? String(input.code).trim().toUpperCase() : current.code;
  const name = input.name !== undefined ? String(input.name).trim() : current.name;
  if (!code || !name) {
    throw new ServiceError(400, 'Kode dan nama satuan wajib diisi.');
  }
  const dup = db
    .prepare('SELECT id FROM units_of_measure WHERE UPPER(code) = ? AND id != ?')
    .get(code, id);
  if (dup) {
    throw new ServiceError(409, `Kode satuan "${code}" sudah dipakai.`);
  }
  const isActive = input.isActive !== undefined ? Boolean(input.isActive) : current.is_active === 1;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('UPDATE units_of_measure SET code = ?, name = ?, is_active = ? WHERE id = ?').run(
      code,
      name,
      isActive ? 1 : 0,
      id
    );
    db.prepare('UPDATE products SET unit = ? WHERE uom_id = ?').run(code, id);

    recordAuditLog(db, {
      action: 'UOM_UPDATED',
      entityType: 'uom',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Perbarui satuan UOM "${code}" (${isActive ? 'Aktif' : 'Nonaktif'})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return listUoms().find((u) => u.id === id)!;
}

// --- Product Barcodes Sub-API ---
export function addBarcodeToProduct(
  productId: string,
  input: { barcode?: unknown; barcodeType?: unknown; isPrimary?: unknown },
  actor: UserSummary
): Product {
  const db = getDb();
  const product = getProductById(productId);
  const rawCode = typeof input.barcode === 'string' ? input.barcode.trim() : '';
  const bType = inferBarcodeType(rawCode, input.barcodeType);
  const validated = validateBarcodeValue(rawCode, bType);
  const isPrimary = Boolean(input.isPrimary);

  const dup = db
    .prepare('SELECT product_id FROM product_barcodes WHERE LOWER(barcode) = LOWER(?)')
    .get(validated.barcode) as { product_id: string } | undefined;
  if (dup) {
    throw new ServiceError(409, `Barcode "${validated.barcode}" sudah terdaftar pada produk lain.`);
  }

  const nowIso = new Date().toISOString();
  const bcId = `bc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (isPrimary) {
      db.prepare('UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?').run(productId);
      db.prepare('UPDATE products SET barcode = ?, updated_at = ? WHERE id = ?').run(
        validated.barcode,
        nowIso,
        productId
      );
    }

    db.prepare(`
      INSERT INTO product_barcodes (id, product_id, barcode, barcode_type, is_primary, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(bcId, productId, validated.barcode, validated.barcodeType, isPrimary ? 1 : 0, nowIso);

    recordAuditLog(db, {
      action: 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: productId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Tambah barcode ${validated.barcode} (${validated.barcodeType}) pada "${product.name}"`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getProductById(productId);
}

export function setPrimaryBarcode(
  productId: string,
  barcodeId: string,
  actor: UserSummary
): Product {
  const db = getDb();
  const product = getProductById(productId);
  const target = db
    .prepare('SELECT id, barcode FROM product_barcodes WHERE id = ? AND product_id = ?')
    .get(barcodeId, productId) as { id: string; barcode: string } | undefined;
  if (!target) {
    throw new ServiceError(404, 'Barcode tidak ditemukan pada produk ini.');
  }
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?').run(productId);
    db.prepare('UPDATE product_barcodes SET is_primary = 1 WHERE id = ?').run(barcodeId);
    db.prepare('UPDATE products SET barcode = ?, updated_at = ? WHERE id = ?').run(
      target.barcode,
      nowIso,
      productId
    );
    recordAuditLog(db, {
      action: 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: productId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Jadikan ${target.barcode} sebagai barcode utama "${product.name}"`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getProductById(productId);
}

export function removeBarcodeFromProduct(
  productId: string,
  barcodeId: string,
  actor: UserSummary
): Product {
  const db = getDb();
  const product = getProductById(productId);
  const all = db
    .prepare('SELECT id, barcode, is_primary FROM product_barcodes WHERE product_id = ?')
    .all(productId) as Array<{ id: string; barcode: string; is_primary: number }>;

  if (all.length <= 1) {
    throw new ServiceError(400, 'Produk wajib memiliki minimal satu barcode aktif.');
  }
  const target = all.find((b) => b.id === barcodeId);
  if (!target) {
    throw new ServiceError(404, 'Barcode tidak ditemukan pada produk ini.');
  }

  const nowIso = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('DELETE FROM product_barcodes WHERE id = ?').run(barcodeId);
    if (target.is_primary === 1) {
      const replacement = all.find((b) => b.id !== barcodeId)!;
      db.prepare('UPDATE product_barcodes SET is_primary = 1 WHERE id = ?').run(replacement.id);
      db.prepare('UPDATE products SET barcode = ?, updated_at = ? WHERE id = ?').run(
        replacement.barcode,
        nowIso,
        productId
      );
    }
    recordAuditLog(db, {
      action: 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: productId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Hapus barcode ${target.barcode} dari "${product.name}"`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getProductById(productId);
}

// --- Product Images Sub-API ---
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

export function uploadProductImage(
  productId: string,
  input: {
    fileName?: unknown;
    mimeType?: unknown;
    dataBase64?: unknown;
    isPrimary?: unknown;
    isAiReference?: unknown;
    referenceAngle?: unknown;
  },
  actor: UserSummary
): Product {
  const db = getDb();
  const product = getProductById(productId);

  const rawData = typeof input.dataBase64 === 'string' ? input.dataBase64.trim() : '';
  if (!rawData) {
    throw new ServiceError(400, 'Data gambar tidak boleh kosong.');
  }

  let mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : '';
  let base64Payload = rawData;

  const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(rawData);
  if (dataUrlMatch) {
    mimeType = mimeType || dataUrlMatch[1].toLowerCase();
    base64Payload = dataUrlMatch[2];
  }

  const ext = ALLOWED_IMAGE_MIME_TYPES[mimeType];
  if (!ext) {
    throw new ServiceError(
      400,
      'Format gambar harus JPG, PNG, atau WEBP.'
    );
  }

  const buffer = Buffer.from(base64Payload, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new ServiceError(400, 'Ukuran gambar tidak valid atau melebihi batas maksimal 3 MB.');
  }
  if (!validateImageMagicBytes(buffer, mimeType)) {
    throw new ServiceError(400, 'Isi file gambar tidak sesuai dengan format JPG/PNG/WEBP yang valid.');
  }

  const rawFileName =
    typeof input.fileName === 'string' && input.fileName.trim()
      ? path.basename(input.fileName.trim())
      : `product-${Date.now()}.${ext}`;

  const referenceAngle: ImageReferenceAngle =
    typeof input.referenceAngle === 'string' &&
    VALID_REFERENCE_ANGLES.has(input.referenceAngle as ImageReferenceAngle)
      ? (input.referenceAngle as ImageReferenceAngle)
      : 'front';

  const isAiReference = Boolean(input.isAiReference);
  const existingImagesCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM product_images WHERE product_id = ?').get(productId) as {
      cnt: number;
    }
  ).cnt;
  const isPrimary = input.isPrimary !== undefined ? Boolean(input.isPrimary) : existingImagesCount === 0;

  const imageId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const diskFileName = `${imageId}.${ext}`;
  const uploadsDir = getProductUploadsDir();
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  const diskPath = path.join(uploadsDir, diskFileName);
  const imageUrl = `/api/uploads/products/${diskFileName}`;
  const nowIso = new Date().toISOString();

  fs.writeFileSync(diskPath, buffer);

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (isPrimary) {
      db.prepare('UPDATE product_images SET is_primary = 0 WHERE product_id = ?').run(productId);
    }

    db.prepare(`
      INSERT INTO product_images (
        id, product_id, file_name, mime_type, file_size, image_url, storage_path,
        is_primary, is_ai_reference, reference_angle, ai_embedding_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      imageId,
      productId,
      rawFileName,
      mimeType,
      buffer.length,
      imageUrl,
      diskPath,
      isPrimary ? 1 : 0,
      isAiReference ? 1 : 0,
      referenceAngle,
      isAiReference ? 'PENDING' : 'NOT_APPLICABLE',
      nowIso
    );

    if (isPrimary || existingImagesCount === 0) {
      db.prepare('UPDATE products SET primary_image_id = ?, updated_at = ? WHERE id = ?').run(
        imageId,
        nowIso,
        productId
      );
    }

    recordAuditLog(db, {
      action: 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: productId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Unggah gambar "${rawFileName}" untuk "${product.name}"${isAiReference ? ` (Referensi AI: ${referenceAngle})` : ''}`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
    throw err;
  }

  return getProductById(productId);
}

export function updateProductImageMetadata(
  productId: string,
  imageId: string,
  input: { isPrimary?: unknown; isAiReference?: unknown; referenceAngle?: unknown },
  actor: UserSummary
): Product {
  const db = getDb();
  const product = getProductById(productId);
  const current = db
    .prepare(
      'SELECT id, file_name, is_primary, is_ai_reference, reference_angle FROM product_images WHERE id = ? AND product_id = ?'
    )
    .get(imageId, productId) as
    | {
        id: string;
        file_name: string;
        is_primary: number;
        is_ai_reference: number;
        reference_angle: ImageReferenceAngle;
      }
    | undefined;
  if (!current) {
    throw new ServiceError(404, 'Gambar produk tidak ditemukan.');
  }

  const isPrimary = input.isPrimary !== undefined ? Boolean(input.isPrimary) : current.is_primary === 1;
  const isAiReference =
    input.isAiReference !== undefined ? Boolean(input.isAiReference) : current.is_ai_reference === 1;
  const referenceAngle: ImageReferenceAngle =
    typeof input.referenceAngle === 'string' &&
    VALID_REFERENCE_ANGLES.has(input.referenceAngle as ImageReferenceAngle)
      ? (input.referenceAngle as ImageReferenceAngle)
      : current.reference_angle;
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (isPrimary) {
      db.prepare('UPDATE product_images SET is_primary = 0 WHERE product_id = ?').run(productId);
      db.prepare('UPDATE products SET primary_image_id = ?, updated_at = ? WHERE id = ?').run(
        imageId,
        nowIso,
        productId
      );
    }

    const hasEmbedding = Boolean(
      db.prepare('SELECT 1 FROM product_image_embeddings WHERE image_id = ?').get(imageId)
    );
    if (!isAiReference && !isPrimary) {
      db.prepare('DELETE FROM product_image_embeddings WHERE image_id = ?').run(imageId);
    }

    const nextEmbeddingStatus = isAiReference
      ? hasEmbedding
        ? 'READY'
        : 'PENDING'
      : 'NOT_APPLICABLE';

    db.prepare(`
      UPDATE product_images
      SET is_primary = ?, is_ai_reference = ?, reference_angle = ?,
          ai_embedding_status = ?
      WHERE id = ?
    `).run(
      isPrimary ? 1 : 0,
      isAiReference ? 1 : 0,
      referenceAngle,
      nextEmbeddingStatus,
      imageId
    );

    recordAuditLog(db, {
      action: 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: productId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Perbarui pengaturan gambar "${current.file_name}" pada "${product.name}"`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getProductById(productId);
}

export function deleteProductImage(
  productId: string,
  imageId: string,
  actor: UserSummary
): Product {
  const db = getDb();
  const product = getProductById(productId);
  const current = db
    .prepare('SELECT id, file_name, storage_path, is_primary FROM product_images WHERE id = ? AND product_id = ?')
    .get(imageId, productId) as
    | { id: string; file_name: string; storage_path: string; is_primary: number }
    | undefined;
  if (!current) {
    throw new ServiceError(404, 'Gambar produk tidak ditemukan.');
  }

  const nowIso = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('DELETE FROM product_images WHERE id = ?').run(imageId);
    const remaining = db
      .prepare('SELECT id FROM product_images WHERE product_id = ? ORDER BY created_at ASC')
      .all(productId) as Array<{ id: string }>;

    if (current.is_primary === 1) {
      const nextPrimaryId = remaining[0]?.id ?? null;
      if (nextPrimaryId) {
        db.prepare('UPDATE product_images SET is_primary = 1 WHERE id = ?').run(nextPrimaryId);
      }
      db.prepare('UPDATE products SET primary_image_id = ?, updated_at = ? WHERE id = ?').run(
        nextPrimaryId,
        nowIso,
        productId
      );
    }

    recordAuditLog(db, {
      action: 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: productId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Hapus gambar "${current.file_name}" dari "${product.name}"`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  if (current.storage_path && fs.existsSync(current.storage_path)) {
    try {
      fs.unlinkSync(current.storage_path);
    } catch {
      // Ignore unlink failure on non-critical file cleanup
    }
  }

  return getProductById(productId);
}

export function resolveUploadedProductImagePath(requestedName: string): string {
  const safeName = path.basename(requestedName);
  if (!safeName || safeName !== requestedName || !/^[A-Za-z0-9._-]+$/.test(safeName)) {
    throw new ServiceError(400, 'Nama file gambar tidak valid.');
  }
  const fullPath = path.join(getProductUploadsDir(), safeName);
  if (!fs.existsSync(fullPath)) {
    throw new ServiceError(404, 'File gambar tidak ditemukan.');
  }
  return fullPath;
}

// --- CSV Import & Export ---
export interface RawCsvImportRow {
  sku?: unknown;
  barcode?: unknown;
  barcodeType?: unknown;
  name?: unknown;
  category?: unknown;
  subcategory?: unknown;
  brand?: unknown;
  unit?: unknown;
  costPrice?: unknown;
  sellPrice?: unknown;
  specialPrice?: unknown;
  stock?: unknown;
  minStock?: unknown;
  variant?: unknown;
  size?: unknown;
  weight?: unknown;
  volume?: unknown;
  taxCategory?: unknown;
  status?: unknown;
  description?: unknown;
}

function parseOptionalNumber(val: unknown): number | null {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  const num = Number(String(val).replace(/[^\d.-]/g, ''));
  return Number.isFinite(num) ? num : NaN;
}

export function previewProductCsvImport(rawRows: RawCsvImportRow[]): CsvImportPreviewResult {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new ServiceError(400, 'Data baris CSV kosong.');
  }
  if (rawRows.length > 500) {
    throw new ServiceError(400, 'Maksimal 500 baris produk per proses impor CSV.');
  }

  const db = getDb();
  const existingSkus = new Set(
    (db.prepare('SELECT sku FROM products WHERE sku IS NOT NULL').all() as Array<{ sku: string }>).map(
      (r) => r.sku.toLowerCase()
    )
  );
  const existingBarcodes = new Set(
    (db.prepare('SELECT barcode FROM product_barcodes').all() as Array<{ barcode: string }>).map((r) =>
      r.barcode.toLowerCase()
    )
  );

  const seenSkusInCsv = new Set<string>();
  const seenBarcodesInCsv = new Set<string>();

  const rows: CsvImportPreviewRow[] = rawRows.map((raw, idx) => {
    const errors: string[] = [];
    const name = typeof raw.name === 'string' ? raw.name.trim() : String(raw.name ?? '').trim();
    const rawSku = typeof raw.sku === 'string' ? raw.sku.trim() : String(raw.sku ?? '').trim();
    const rawBarcode =
      typeof raw.barcode === 'string' ? raw.barcode.trim() : String(raw.barcode ?? '').trim();
    const barcodeType = inferBarcodeType(rawBarcode, raw.barcodeType);
    const category =
      typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'Lainnya';
    const subcategory =
      typeof raw.subcategory === 'string' ? raw.subcategory.trim() : '';
    const brand =
      typeof raw.brand === 'string' && raw.brand.trim() ? raw.brand.trim() : 'Umum';
    const unit = normalizeUnitCode(
      typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit : 'PCS'
    );
    const variant = typeof raw.variant === 'string' ? raw.variant.trim() : '';
    const size = typeof raw.size === 'string' ? raw.size.trim() : '';
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';

    const costPrice = parseOptionalNumber(raw.costPrice) ?? 0;
    const sellPrice = parseOptionalNumber(raw.sellPrice) ?? 0;
    const specialPriceRaw = parseOptionalNumber(raw.specialPrice);
    const stock = parseOptionalNumber(raw.stock) ?? 0;
    const minStock = parseOptionalNumber(raw.minStock) ?? 5;
    const weight = parseOptionalNumber(raw.weight);
    const volume = parseOptionalNumber(raw.volume);

    const rawTax = typeof raw.taxCategory === 'string' ? raw.taxCategory.trim().toUpperCase() : 'STANDARD';
    const taxCategory: TaxCategory = VALID_TAX_CATEGORIES.has(rawTax as TaxCategory)
      ? (rawTax as TaxCategory)
      : 'STANDARD';

    const rawStatus = typeof raw.status === 'string' ? raw.status.trim().toUpperCase() : 'ACTIVE';
    const status: ProductStatus = rawStatus === 'INACTIVE' || rawStatus === 'NONAKTIF' ? 'INACTIVE' : 'ACTIVE';

    if (!name) errors.push('Nama produk wajib diisi');
    if (!rawBarcode) {
      errors.push('Barcode wajib diisi');
    } else {
      try {
        validateBarcodeValue(rawBarcode, barcodeType);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'Format barcode tidak valid');
      }
      const lowerCode = rawBarcode.toLowerCase();
      if (existingBarcodes.has(lowerCode)) {
        errors.push(`Barcode ${rawBarcode} sudah terdaftar di database`);
      } else if (seenBarcodesInCsv.has(lowerCode)) {
        errors.push(`Barcode ${rawBarcode} duplikat di dalam file CSV`);
      } else {
        seenBarcodesInCsv.add(lowerCode);
      }
    }

    if (rawSku) {
      const lowerSku = rawSku.toLowerCase();
      if (existingSkus.has(lowerSku)) {
        errors.push(`SKU ${rawSku} sudah terdaftar di database`);
      } else if (seenSkusInCsv.has(lowerSku)) {
        errors.push(`SKU ${rawSku} duplikat di dalam file CSV`);
      } else {
        seenSkusInCsv.add(lowerSku);
      }
    }

    if (Number.isNaN(costPrice) || costPrice < 0) errors.push('Harga modal tidak valid');
    if (Number.isNaN(sellPrice) || sellPrice <= 0) errors.push('Harga jual harus > 0');
    if (specialPriceRaw !== null && (Number.isNaN(specialPriceRaw) || specialPriceRaw < 0)) {
      errors.push('Harga spesial tidak valid');
    }
    if (Number.isNaN(stock) || stock < 0) errors.push('Stok awal tidak valid');
    if (Number.isNaN(minStock) || minStock < 0) errors.push('Minimum stok tidak valid');
    if (weight !== null && (Number.isNaN(weight) || weight < 0)) errors.push('Berat tidak valid');
    if (volume !== null && (Number.isNaN(volume) || volume < 0)) errors.push('Volume tidak valid');

    return {
      rowNumber: idx + 1,
      sku: rawSku,
      barcode: rawBarcode,
      barcodeType,
      name,
      category,
      subcategory,
      brand,
      unit,
      costPrice: Number.isNaN(costPrice) ? 0 : Math.round(costPrice),
      sellPrice: Number.isNaN(sellPrice) ? 0 : Math.round(sellPrice),
      specialPrice:
        specialPriceRaw !== null && !Number.isNaN(specialPriceRaw) && specialPriceRaw > 0
          ? Math.round(specialPriceRaw)
          : null,
      stock: Number.isNaN(stock) ? 0 : Math.floor(stock),
      minStock: Number.isNaN(minStock) ? 5 : Math.floor(minStock),
      variant,
      size,
      weight: weight !== null && !Number.isNaN(weight) ? weight : null,
      volume: volume !== null && !Number.isNaN(volume) ? volume : null,
      taxCategory,
      status,
      description,
      valid: errors.length === 0,
      errors,
    };
  });

  const validCount = rows.filter((r) => r.valid).length;
  return {
    totalRows: rows.length,
    validCount,
    errorCount: rows.length - validCount,
    rows,
  };
}

export function commitProductCsvImport(
  rawRows: RawCsvImportRow[],
  actor: UserSummary
): {
  importedCount: number;
  skippedCount: number;
  preview: CsvImportPreviewResult;
} {
  const preview = previewProductCsvImport(rawRows);
  const validRows = preview.rows.filter((r) => r.valid);
  if (validRows.length === 0) {
    throw new ServiceError(400, 'Tidak ada baris produk yang valid untuk diimpor.');
  }

  const db = getDb();
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    let skuSeq = (db.prepare('SELECT COUNT(*) as cnt FROM products').get() as { cnt: number }).cnt + 1;

    const findCatStmt = db.prepare(
      "SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND COALESCE(parent_id, '') = COALESCE(?, '')"
    );
    const insertCatStmt = db.prepare(`
      INSERT INTO categories (id, name, slug, parent_id, description, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 1, ?, ?)
    `);
    const findBrandStmt = db.prepare('SELECT id FROM brands WHERE LOWER(name) = LOWER(?)');
    const insertBrandStmt = db.prepare(`
      INSERT INTO brands (id, name, description, is_active, created_at, updated_at)
      VALUES (?, ?, '', 1, ?, ?)
    `);
    const findUomStmt = db.prepare('SELECT id, code FROM units_of_measure WHERE UPPER(code) = ?');
    const insertUomStmt = db.prepare(`
      INSERT INTO units_of_measure (id, code, name, is_system, is_active, created_at)
      VALUES (?, ?, ?, 0, 1, ?)
    `);

    const insertProdStmt = db.prepare(`
      INSERT INTO products (
        id, sku, barcode, name, description, brand_id, category_id, subcategory_id,
        category, uom_id, unit, variant, size, weight, volume,
        cost_price, sell_price, special_price, tax_category, stock, min_stock,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBarcodeStmt = db.prepare(`
      INSERT INTO product_barcodes (id, product_id, barcode, barcode_type, is_primary, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `);
    const insertMovStmt = db.prepare(`
      INSERT INTO stock_movements (
        id, product_id, sku, product_name, barcode, type, qty_delta, stock_before, stock_after,
        unit_cost, reference_id, reason, notes, actor_user_id, actor_name, movement_date, created_at
      ) VALUES (?, ?, ?, ?, ?, 'STOK_AWAL', ?, 0, ?, ?, 'IMPORT-CSV', 'Stok Awal Impor', 'Stok awal dari impor CSV katalog', ?, ?, ?, ?)
    `);

    for (const row of validRows) {
      let sku = row.sku;
      if (!sku) {
        while (true) {
          const cand = `SKU-${String(skuSeq++).padStart(4, '0')}`;
          if (!db.prepare('SELECT 1 FROM products WHERE sku = ?').get(cand)) {
            sku = cand;
            break;
          }
        }
      }

      let catRow = findCatStmt.get(row.category, null) as { id: string } | undefined;
      if (!catRow) {
        const newCatId = `cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        let slug = slugifyText(row.category);
        while (db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(slug)) {
          slug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;
        }
        insertCatStmt.run(newCatId, row.category, slug, null, nowIso, nowIso);
        catRow = { id: newCatId };
      }

      let subCatId: string | null = null;
      if (row.subcategory) {
        let subRow = findCatStmt.get(row.subcategory, catRow.id) as { id: string } | undefined;
        if (!subRow) {
          const newSubId = `cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          let slug = slugifyText(`${row.category}-${row.subcategory}`);
          while (db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(slug)) {
            slug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;
          }
          insertCatStmt.run(newSubId, row.subcategory, slug, catRow.id, nowIso, nowIso);
          subRow = { id: newSubId };
        }
        subCatId = subRow.id;
      }

      let brandRow = findBrandStmt.get(row.brand) as { id: string } | undefined;
      if (!brandRow) {
        const newBrandId = `brd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        insertBrandStmt.run(newBrandId, row.brand, nowIso, nowIso);
        brandRow = { id: newBrandId };
      }

      let uomRow = findUomStmt.get(row.unit) as { id: string; code: string } | undefined;
      if (!uomRow) {
        const newUomId = `uom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        insertUomStmt.run(newUomId, row.unit, row.unit, nowIso);
        uomRow = { id: newUomId, code: row.unit };
      }

      const productId = `prd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      insertProdStmt.run(
        productId,
        sku,
        row.barcode,
        row.name,
        row.description,
        brandRow.id,
        catRow.id,
        subCatId,
        row.category,
        uomRow.id,
        uomRow.code,
        row.variant,
        row.size,
        row.weight,
        row.volume,
        row.costPrice,
        row.sellPrice,
        row.specialPrice,
        row.taxCategory,
        row.stock,
        row.minStock,
        row.status,
        nowIso,
        nowIso
      );

      insertBarcodeStmt.run(
        `bc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        productId,
        row.barcode,
        row.barcodeType,
        nowIso
      );

      if (row.stock > 0) {
        insertMovStmt.run(
          `mov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          productId,
          sku,
          row.name,
          row.barcode,
          row.stock,
          row.stock,
          row.costPrice,
          actor.id,
          actor.fullName,
          nowIso,
          nowIso
        );
      }
    }

    recordAuditLog(db, {
      action: 'PRODUCTS_IMPORTED',
      entityType: 'product',
      entityId: 'csv-import',
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Impor CSV katalog: ${validRows.length} produk berhasil diimpor, ${preview.errorCount} baris dilewati`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return {
    importedCount: validRows.length,
    skippedCount: preview.errorCount,
    preview,
  };
}

export function exportProductsToCsv(params: ProductQueryParams, actor: UserSummary): string {
  const result = listProductsPaginated({ ...params, page: 1, pageSize: 10000 });
  const db = getDb();
  recordAuditLog(db, {
    action: 'PRODUCTS_EXPORTED',
    entityType: 'product',
    entityId: 'csv-export',
    actorUserId: actor.id,
    actor: actor.fullName,
    summary: `Ekspor CSV katalog produk (${result.products.length} SKU)`,
  });

  const escapeCell = (val: string | number | null | undefined): string => {
    const str = val === null || val === undefined ? '' : String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headers = [
    'SKU',
    'Barcode Utama',
    'Barcode Lainnya',
    'Nama Produk',
    'Deskripsi',
    'Merek',
    'Kategori',
    'Subkategori',
    'Varian',
    'Ukuran',
    'Berat (g)',
    'Volume (ml)',
    'Satuan',
    'Harga Modal',
    'Harga Jual',
    'Harga Khusus',
    'Kategori Pajak',
    'Stok',
    'Minimum Stok',
    'Status',
    'Tanggal Dibuat',
    'Terakhir Diperbarui',
  ];

  const lines = [
    headers.map(escapeCell).join(','),
    ...result.products.map((p) => {
      const secondaryBarcodes = p.barcodes
        .filter((b) => !b.isPrimary)
        .map((b) => b.barcode)
        .join('; ');
      return [
        p.sku,
        p.barcode,
        secondaryBarcodes,
        p.name,
        p.description,
        p.brandName,
        p.category,
        p.subcategoryName,
        p.variant,
        p.size,
        p.weight,
        p.volume,
        p.unit,
        p.costPrice,
        p.sellPrice,
        p.specialPrice,
        p.taxCategory,
        p.stock,
        p.minStock,
        p.status,
        p.createdAt,
        p.updatedAt,
      ]
        .map(escapeCell)
        .join(',');
    }),
  ];

  return '\uFEFF' + lines.join('\n');
}
