import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.ts';
import { recordAuditLog } from './auditService.ts';
import { consumePinApprovalToken } from './authService.ts';
import { getProductById, queryEnrichedProducts } from './catalogService.ts';
import { ServiceError } from './errors.ts';
import type {
  Product,
  StockAdjustmentDirection,
  StockAdjustmentRecord,
  StockBalanceItem,
  StockBalanceResponse,
  StockCardResponse,
  StockMovement,
  StockMovementType,
  StockOpnameDetail,
  StockOpnameItem,
  StockOpnameSession,
  StockOpnameStatus,
  StockReceivingRecord,
  StockStatusLevel,
  UserSummary,
} from '../../src/types.ts';

export function resolveStockStatus(stock: number, minStock: number): StockStatusLevel {
  if (stock < 0) return 'NEGATIVE';
  if (stock === 0) return 'OUT';
  if (stock <= minStock) return 'LOW';
  return 'SAFE';
}

export function isNegativeStockAllowed(db: DatabaseSync): boolean {
  const row = db
    .prepare('SELECT allow_negative_stock FROM store_settings WHERE id = 1')
    .get() as { allow_negative_stock?: number } | undefined;
  return row?.allow_negative_stock === 1;
}

function nextInventoryDocNumber(
  db: DatabaseSync,
  prefix: 'RCV' | 'ADJ' | 'OPN',
  tableName: 'stock_receivings' | 'stock_adjustments' | 'stock_opnames',
  columnName: 'reference_number' | 'opname_number'
): string {
  const nowIso = new Date().toISOString();
  const dateStamp = nowIso.slice(0, 10).replace(/-/g, '');
  const seqKey = `${prefix}-${dateStamp}`;

  const existingRow = db
    .prepare('SELECT last_number FROM document_sequences WHERE seq_key = ?')
    .get(seqKey) as { last_number: number } | undefined;

  let nextNum: number;
  if (!existingRow) {
    const existingCount = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM ${tableName} WHERE ${columnName} LIKE ?`)
        .get(`${seqKey}-%`) as { cnt: number }
    ).cnt;
    nextNum = existingCount + 1;
    db.prepare(
      'INSERT INTO document_sequences (seq_key, last_number, updated_at) VALUES (?, ?, ?)'
    ).run(seqKey, nextNum, nowIso);
  } else {
    const row = db
      .prepare(`
        UPDATE document_sequences
        SET last_number = last_number + 1, updated_at = ?
        WHERE seq_key = ?
        RETURNING last_number
      `)
      .get(nowIso, seqKey) as { last_number: number };
    nextNum = row.last_number;
  }

  while (true) {
    const candidate = `${seqKey}-${String(nextNum).padStart(4, '0')}`;
    const collision = db
      .prepare(`SELECT 1 FROM ${tableName} WHERE ${columnName} = ?`)
      .get(candidate);
    if (!collision) {
      return candidate;
    }
    nextNum++;
    db.prepare('UPDATE document_sequences SET last_number = ?, updated_at = ? WHERE seq_key = ?').run(
      nextNum,
      nowIso,
      seqKey
    );
  }
}

function resolveAuthorizerName(db: DatabaseSync, userId: string): string {
  const row = db
    .prepare('SELECT full_name FROM users WHERE id = ?')
    .get(userId) as { full_name: string } | undefined;
  return row?.full_name || 'Supervisor/Admin';
}

function assertPositiveInt(value: unknown, label: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ServiceError(400, `${label} harus berupa bilangan bulat minimal 1.`);
  }
  return num;
}

function assertNonNegativeInt(value: unknown, label: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
    throw new ServiceError(400, `${label} harus berupa bilangan bulat minimal 0.`);
  }
  return num;
}

function mapProductToBalanceItem(p: Product): StockBalanceItem {
  return {
    productId: p.id,
    sku: p.sku,
    barcode: p.barcode,
    name: p.name,
    category: p.category,
    brandName: p.brandName,
    unit: p.unit,
    costPrice: p.costPrice,
    sellPrice: p.sellPrice,
    currentStock: p.stock,
    minStock: p.minStock,
    stockStatus: resolveStockStatus(p.stock, p.minStock),
    productStatus: p.status,
    assetValue: p.costPrice * p.stock,
    retailValue: p.sellPrice * p.stock,
    updatedAt: p.updatedAt,
  };
}

// --- 1. Stock Balance & Low Stock ---
export function getStockBalanceList(params: {
  search?: string;
  stockStatus?: string;
  categoryId?: string;
  productStatus?: string;
  page?: number;
  pageSize?: number;
}): StockBalanceResponse {
  const db = getDb();
  const allowNegativeStock = isNegativeStockAllowed(db);
  const allProducts = queryEnrichedProducts();
  const allBalanceItems = allProducts.map(mapProductToBalanceItem);

  const summary = {
    totalSku: allBalanceItems.length,
    totalUnits: allBalanceItems.reduce((sum, i) => sum + i.currentStock, 0),
    safeCount: allBalanceItems.filter((i) => i.stockStatus === 'SAFE').length,
    lowCount: allBalanceItems.filter((i) => i.stockStatus === 'LOW').length,
    outCount: allBalanceItems.filter((i) => i.stockStatus === 'OUT').length,
    negativeCount: allBalanceItems.filter((i) => i.stockStatus === 'NEGATIVE').length,
    totalCostValue: allBalanceItems.reduce((sum, i) => sum + i.assetValue, 0),
    totalRetailValue: allBalanceItems.reduce((sum, i) => sum + i.retailValue, 0),
    allowNegativeStock,
  };

  let filtered = allBalanceItems;

  const q = (params.search ?? '').trim().toLowerCase();
  if (q) {
    const matchingIds = new Set(
      allProducts
        .filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.sku.toLowerCase().includes(q) ||
            p.barcode.toLowerCase().includes(q) ||
            p.brandName.toLowerCase().includes(q) ||
            p.category.toLowerCase().includes(q) ||
            p.barcodes.some((b) => b.barcode.toLowerCase().includes(q))
        )
        .map((p) => p.id)
    );
    filtered = filtered.filter((i) => matchingIds.has(i.productId));
  }

  if (params.categoryId && params.categoryId !== 'ALL') {
    const matchingCatIds = new Set(
      allProducts
        .filter((p) => p.categoryId === params.categoryId || p.category === params.categoryId)
        .map((p) => p.id)
    );
    filtered = filtered.filter((i) => matchingCatIds.has(i.productId));
  }

  if (params.productStatus === 'ACTIVE' || params.productStatus === 'INACTIVE') {
    filtered = filtered.filter((i) => i.productStatus === params.productStatus);
  }

  const st = (params.stockStatus ?? 'ALL').toUpperCase();
  if (st === 'LOW_OR_OUT') {
    filtered = filtered.filter((i) => i.stockStatus !== 'SAFE');
  } else if (st === 'SAFE' || st === 'LOW' || st === 'OUT' || st === 'NEGATIVE') {
    filtered = filtered.filter((i) => i.stockStatus === st);
  }

  // Sort critical stock alerts first when viewing alerts, otherwise keep updatedAt/name
  if (st === 'LOW_OR_OUT' || st === 'LOW' || st === 'OUT' || st === 'NEGATIVE') {
    filtered = [...filtered].sort(
      (a, b) => a.currentStock - a.minStock - (b.currentStock - b.minStock)
    );
  }

  const total = filtered.length;
  const pageSize = Math.min(200, Math.max(1, Number(params.pageSize || 50)));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(params.page || 1)));
  const start = (page - 1) * pageSize;

  return {
    items: filtered.slice(start, start + pageSize),
    summary,
    total,
    page,
    pageSize,
    totalPages,
  };
}

export function updateProductMinStock(
  productId: string,
  minStockRaw: unknown,
  actor: UserSummary
): { item: StockBalanceItem } {
  const minStock = assertNonNegativeInt(minStockRaw, 'Batas minimum stok');
  const db = getDb();
  const product = getProductById(productId);
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('UPDATE products SET min_stock = ?, updated_at = ? WHERE id = ?').run(
      minStock,
      nowIso,
      productId
    );
    recordAuditLog(db, {
      action: 'MIN_STOCK_UPDATED',
      entityType: 'stock',
      entityId: productId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Ubah minimum stok "${product.name}" (${product.sku}): ${product.minStock} → ${minStock} ${product.unit}`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return { item: mapProductToBalanceItem(getProductById(productId)) };
}

// --- 2. Stock Movements & Stock Card ---
interface RawMovementRow {
  id: string;
  product_id: string;
  sku: string;
  product_name: string;
  barcode: string;
  type: StockMovementType;
  qty_delta: number;
  stock_before: number;
  stock_after: number;
  unit_cost: number | null;
  reference_id: string;
  reason: string;
  notes: string;
  actor_user_id: string | null;
  actor_name: string;
  movement_date: string;
  created_at: string;
}

function mapMovementRow(r: RawMovementRow): StockMovement {
  return {
    id: r.id,
    productId: r.product_id,
    sku: r.sku || undefined,
    productName: r.product_name,
    barcode: r.barcode,
    type: r.type,
    qtyDelta: r.qty_delta,
    stockBefore: r.stock_before,
    stockAfter: r.stock_after,
    unitCost: r.unit_cost,
    referenceId: r.reference_id,
    reason: r.reason || undefined,
    notes: r.notes,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name || 'Sistem',
    movementDate: r.movement_date || r.created_at,
    createdAt: r.created_at,
  };
}

export function listStockMovements(params: {
  productId?: string;
  type?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}): StockMovement[] {
  const db = getDb();
  const limit = Math.min(1000, Math.max(1, Number(params.limit || 400)));
  const rows = db
    .prepare(`
      SELECT id, product_id, sku, product_name, barcode, type, qty_delta,
             stock_before, stock_after, unit_cost, reference_id, reason, notes,
             actor_user_id, actor_name, movement_date, created_at
      FROM stock_movements
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(limit) as unknown as RawMovementRow[];

  let list = rows.map(mapMovementRow);

  if (params.productId) {
    list = list.filter((m) => m.productId === params.productId);
  }
  if (params.type && params.type !== 'ALL') {
    list = list.filter((m) => m.type === params.type);
  }
  if (params.dateFrom) {
    list = list.filter((m) => (m.movementDate || m.createdAt).slice(0, 10) >= params.dateFrom!);
  }
  if (params.dateTo) {
    list = list.filter((m) => (m.movementDate || m.createdAt).slice(0, 10) <= params.dateTo!);
  }
  const q = (params.search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (m) =>
        m.productName.toLowerCase().includes(q) ||
        (m.sku && m.sku.toLowerCase().includes(q)) ||
        m.barcode.toLowerCase().includes(q) ||
        m.referenceId.toLowerCase().includes(q) ||
        (m.reason && m.reason.toLowerCase().includes(q)) ||
        m.notes.toLowerCase().includes(q) ||
        (m.actorName && m.actorName.toLowerCase().includes(q))
    );
  }

  return list;
}

export function getProductStockCard(
  productId: string,
  params?: { type?: string; dateFrom?: string; dateTo?: string }
): StockCardResponse {
  const product = getProductById(productId);
  const balanceItem = mapProductToBalanceItem(product);

  const movements = listStockMovements({
    productId,
    type: params?.type,
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    limit: 1000,
  });

  const totalIn = movements.reduce((s, m) => (m.qtyDelta > 0 ? s + m.qtyDelta : s), 0);
  const totalOut = movements.reduce((s, m) => (m.qtyDelta < 0 ? s + Math.abs(m.qtyDelta) : s), 0);

  return {
    product: balanceItem,
    summary: {
      totalIn,
      totalOut,
      netChange: totalIn - totalOut,
      movementCount: movements.length,
    },
    movements,
  };
}

// --- 3. Stock In (Receiving) ---
export function listStockReceivings(params: {
  search?: string;
  productId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}): StockReceivingRecord[] {
  const db = getDb();
  const limit = Math.min(500, Math.max(1, Number(params.limit || 200)));
  const rows = db
    .prepare(`
      SELECT r.id, r.reference_number, r.product_id, r.sku, r.product_name, r.barcode,
             COALESCE(p.unit, 'PCS') AS unit, r.qty, r.cost_price, r.previous_cost_price,
             r.update_product_cost, r.notes, r.received_at, r.movement_id,
             r.created_by_user_id, r.created_by_name, r.created_at
      FROM stock_receivings r
      LEFT JOIN products p ON p.id = r.product_id
      ORDER BY r.received_at DESC, r.created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
    id: string;
    reference_number: string;
    product_id: string;
    sku: string;
    product_name: string;
    barcode: string;
    unit: string;
    qty: number;
    cost_price: number;
    previous_cost_price: number;
    update_product_cost: number;
    notes: string;
    received_at: string;
    movement_id: string;
    created_by_user_id: string | null;
    created_by_name: string;
    created_at: string;
  }>;

  let list: StockReceivingRecord[] = rows.map((r) => ({
    id: r.id,
    referenceNumber: r.reference_number,
    productId: r.product_id,
    sku: r.sku,
    productName: r.product_name,
    barcode: r.barcode,
    unit: r.unit,
    qty: r.qty,
    costPrice: r.cost_price,
    previousCostPrice: r.previous_cost_price,
    updateProductCost: r.update_product_cost === 1,
    notes: r.notes,
    receivedAt: r.received_at,
    movementId: r.movement_id,
    createdByUserId: r.created_by_user_id,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  }));

  if (params.productId) {
    list = list.filter((r) => r.productId === params.productId);
  }
  if (params.dateFrom) {
    list = list.filter((r) => r.receivedAt.slice(0, 10) >= params.dateFrom!);
  }
  if (params.dateTo) {
    list = list.filter((r) => r.receivedAt.slice(0, 10) <= params.dateTo!);
  }
  const q = (params.search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (r) =>
        r.referenceNumber.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        r.sku.toLowerCase().includes(q) ||
        r.barcode.toLowerCase().includes(q) ||
        r.notes.toLowerCase().includes(q) ||
        r.createdByName.toLowerCase().includes(q)
    );
  }
  return list;
}

export interface RecordStockInInput {
  productId?: unknown;
  qty?: unknown;
  costPrice?: unknown;
  updateProductCost?: unknown;
  referenceNumber?: unknown;
  notes?: unknown;
  receivedAt?: unknown;
  pinApprovalToken?: unknown;
}

export function recordStockIn(
  input: RecordStockInInput,
  actor: UserSummary
): {
  receiving: StockReceivingRecord;
  movement: StockMovement;
  product: Product;
} {
  const productId = typeof input.productId === 'string' ? input.productId.trim() : '';
  if (!productId) {
    throw new ServiceError(400, 'Produk wajib dipilih untuk penerimaan barang masuk.');
  }

  const db = getDb();
  const hasPermission = actor.permissions.includes('stock:adjust');
  const pinToken = typeof input.pinApprovalToken === 'string' ? input.pinApprovalToken.trim() : '';
  if (!hasPermission && !pinToken) {
    throw new ServiceError(
      403,
      'Penerimaan barang masuk memerlukan izin stock:adjust atau otorisasi PIN Supervisor/Admin.',
      'PIN_REQUIRED'
    );
  }

  const qty = assertPositiveInt(input.qty, 'Jumlah barang masuk');
  const initialProduct = getProductById(productId);

  const costPriceRaw =
    input.costPrice !== undefined && String(input.costPrice).trim() !== ''
      ? Number(input.costPrice)
      : initialProduct.costPrice;
  if (!Number.isFinite(costPriceRaw) || costPriceRaw < 0) {
    throw new ServiceError(400, 'Harga modal barang masuk harus berupa angka minimal 0.');
  }
  const costPrice = Math.round(costPriceRaw);
  const updateProductCost = Boolean(input.updateProductCost);
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';

  const nowIso = new Date().toISOString();
  let receivedAt = nowIso;
  if (typeof input.receivedAt === 'string' && input.receivedAt.trim()) {
    const parsed = new Date(input.receivedAt.trim());
    if (Number.isNaN(parsed.getTime())) {
      throw new ServiceError(400, 'Format tanggal penerimaan tidak valid.');
    }
    receivedAt = input.receivedAt.trim().length <= 10 ? `${input.receivedAt.trim()}T${nowIso.slice(11)}` : parsed.toISOString();
  }

  const receivingId = `rcv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const movementId = `mov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  let referenceNumber = '';
  let movementRecord!: StockMovement;

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (!hasPermission && pinToken) {
      consumePinApprovalToken(db, pinToken, 'stock_adjustment');
    }

    const liveRow = db
      .prepare('SELECT stock, cost_price FROM products WHERE id = ?')
      .get(productId) as { stock: number; cost_price: number } | undefined;
    if (!liveRow) {
      throw new ServiceError(404, 'Produk tidak ditemukan.');
    }

    const stockBefore = liveRow.stock;
    const stockAfter = stockBefore + qty;
    const previousCostPrice = liveRow.cost_price;

    referenceNumber =
      typeof input.referenceNumber === 'string' && input.referenceNumber.trim()
        ? input.referenceNumber.trim().slice(0, 64)
        : nextInventoryDocNumber(db, 'RCV', 'stock_receivings', 'reference_number');

    db.prepare(`
      UPDATE products
      SET stock = ?,
          cost_price = CASE WHEN ? = 1 THEN ? ELSE cost_price END,
          updated_at = ?
      WHERE id = ?
    `).run(stockAfter, updateProductCost ? 1 : 0, costPrice, nowIso, productId);

    const movNotes = notes || `Penerimaan stok masuk (${referenceNumber})`;
    db.prepare(`
      INSERT INTO stock_movements (
        id, product_id, sku, product_name, barcode, type, qty_delta,
        stock_before, stock_after, unit_cost, reference_id, reason, notes,
        actor_user_id, actor_name, movement_date, created_at
      ) VALUES (?, ?, ?, ?, ?, 'STOCK_IN', ?, ?, ?, ?, ?, 'Barang Masuk', ?, ?, ?, ?, ?)
    `).run(
      movementId,
      initialProduct.id,
      initialProduct.sku,
      initialProduct.name,
      initialProduct.barcode,
      qty,
      stockBefore,
      stockAfter,
      costPrice,
      referenceNumber,
      movNotes,
      actor.id,
      actor.fullName,
      receivedAt,
      nowIso
    );

    db.prepare(`
      INSERT INTO stock_receivings (
        id, reference_number, product_id, sku, product_name, barcode, qty,
        cost_price, previous_cost_price, update_product_cost, notes, received_at,
        movement_id, created_by_user_id, created_by_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receivingId,
      referenceNumber,
      initialProduct.id,
      initialProduct.sku,
      initialProduct.name,
      initialProduct.barcode,
      qty,
      costPrice,
      previousCostPrice,
      updateProductCost ? 1 : 0,
      notes,
      receivedAt,
      movementId,
      actor.id,
      actor.fullName,
      nowIso
    );

    recordAuditLog(db, {
      action: 'STOCK_IN_RECORDED',
      entityType: 'stock',
      entityId: referenceNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Barang masuk "${initialProduct.name}" +${qty} ${initialProduct.unit} (modal Rp ${costPrice.toLocaleString('id-ID')}, stok ${stockBefore} → ${stockAfter})`,
    });

    movementRecord = {
      id: movementId,
      productId: initialProduct.id,
      sku: initialProduct.sku,
      productName: initialProduct.name,
      barcode: initialProduct.barcode,
      type: 'STOCK_IN',
      qtyDelta: qty,
      stockBefore,
      stockAfter,
      unitCost: costPrice,
      referenceId: referenceNumber,
      reason: 'Barang Masuk',
      notes: movNotes,
      actorUserId: actor.id,
      actorName: actor.fullName,
      movementDate: receivedAt,
      createdAt: nowIso,
    };

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const receiving = listStockReceivings({ limit: 50 }).find((r) => r.id === receivingId)!;
  return {
    receiving,
    movement: movementRecord,
    product: getProductById(productId),
  };
}

// --- 4. Stock Adjustments ---
export function listStockAdjustments(params: {
  search?: string;
  productId?: string;
  direction?: string;
  limit?: number;
}): StockAdjustmentRecord[] {
  const db = getDb();
  const limit = Math.min(500, Math.max(1, Number(params.limit || 200)));
  const rows = db
    .prepare(`
      SELECT a.id, a.reference_number, a.product_id, a.sku, a.product_name, a.barcode,
             COALESCE(p.unit, 'PCS') AS unit, a.direction, a.qty, a.stock_before, a.stock_after,
             a.reason, a.notes, a.approval_status, a.requested_by_user_id, a.requested_by_name,
             a.approved_by_user_id, a.approved_by_name, a.movement_id, a.created_at
      FROM stock_adjustments a
      LEFT JOIN products p ON p.id = a.product_id
      ORDER BY a.created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
    id: string;
    reference_number: string;
    product_id: string;
    sku: string;
    product_name: string;
    barcode: string;
    unit: string;
    direction: StockAdjustmentDirection;
    qty: number;
    stock_before: number;
    stock_after: number;
    reason: string;
    notes: string;
    approval_status: 'APPROVED';
    requested_by_user_id: string | null;
    requested_by_name: string;
    approved_by_user_id: string | null;
    approved_by_name: string;
    movement_id: string;
    created_at: string;
  }>;

  let list: StockAdjustmentRecord[] = rows.map((r) => ({
    id: r.id,
    referenceNumber: r.reference_number,
    productId: r.product_id,
    sku: r.sku,
    productName: r.product_name,
    barcode: r.barcode,
    unit: r.unit,
    direction: r.direction,
    qty: r.qty,
    stockBefore: r.stock_before,
    stockAfter: r.stock_after,
    reason: r.reason,
    notes: r.notes,
    approvalStatus: r.approval_status,
    requestedByUserId: r.requested_by_user_id,
    requestedByName: r.requested_by_name,
    approvedByUserId: r.approved_by_user_id,
    approvedByName: r.approved_by_name,
    movementId: r.movement_id,
    createdAt: r.created_at,
  }));

  if (params.productId) {
    list = list.filter((a) => a.productId === params.productId);
  }
  if (params.direction === 'INCREASE' || params.direction === 'DECREASE') {
    list = list.filter((a) => a.direction === params.direction);
  }
  const q = (params.search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (a) =>
        a.referenceNumber.toLowerCase().includes(q) ||
        a.productName.toLowerCase().includes(q) ||
        a.sku.toLowerCase().includes(q) ||
        a.barcode.toLowerCase().includes(q) ||
        a.reason.toLowerCase().includes(q) ||
        a.notes.toLowerCase().includes(q) ||
        a.approvedByName.toLowerCase().includes(q)
    );
  }

  return list;
}

export interface CreateStockAdjustmentInput {
  productId?: unknown;
  direction?: unknown;
  qty?: unknown;
  reason?: unknown;
  notes?: unknown;
  referenceNumber?: unknown;
  pinApprovalToken?: unknown;
}

export function createStockAdjustment(
  input: CreateStockAdjustmentInput,
  actor: UserSummary
): {
  adjustment: StockAdjustmentRecord;
  movement: StockMovement;
  product: Product;
} {
  const productId = typeof input.productId === 'string' ? input.productId.trim() : '';
  if (!productId) {
    throw new ServiceError(400, 'Produk wajib dipilih untuk penyesuaian stok.');
  }

  const rawDir = typeof input.direction === 'string' ? input.direction.trim().toUpperCase() : '';
  if (rawDir !== 'INCREASE' && rawDir !== 'DECREASE') {
    throw new ServiceError(400, 'Arah penyesuaian harus INCREASE atau DECREASE.');
  }
  const direction = rawDir as StockAdjustmentDirection;

  const qty = assertPositiveInt(input.qty, 'Jumlah penyesuaian stok');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length < 3) {
    throw new ServiceError(400, 'Alasan penyesuaian stok wajib diisi (minimal 3 karakter).');
  }
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';

  const db = getDb();
  const hasPermission = actor.permissions.includes('stock:adjust');
  const pinToken = typeof input.pinApprovalToken === 'string' ? input.pinApprovalToken.trim() : '';
  if (!hasPermission && !pinToken) {
    throw new ServiceError(
      403,
      'Penyesuaian stok memerlukan izin stock:adjust atau otorisasi PIN Supervisor/Admin.',
      'PIN_REQUIRED'
    );
  }

  const initialProduct = getProductById(productId);
  const nowIso = new Date().toISOString();
  const adjustmentId = `adj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const movementId = `mov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  let movementRecord!: StockMovement;

  db.exec('BEGIN IMMEDIATE;');
  try {
    let approvedByUserId = actor.id;
    let approvedByName = actor.fullName;
    if (!hasPermission && pinToken) {
      const consumed = consumePinApprovalToken(db, pinToken, 'stock_adjustment');
      approvedByUserId = consumed.authorizerUserId;
      approvedByName = resolveAuthorizerName(db, consumed.authorizerUserId);
    }

    const liveRow = db
      .prepare('SELECT stock FROM products WHERE id = ?')
      .get(productId) as { stock: number } | undefined;
    if (!liveRow) {
      throw new ServiceError(404, 'Produk tidak ditemukan.');
    }

    const stockBefore = liveRow.stock;
    const qtyDelta = direction === 'INCREASE' ? qty : -qty;
    const stockAfter = stockBefore + qtyDelta;

    const allowNegative = isNegativeStockAllowed(db);
    if (stockAfter < 0 && !allowNegative) {
      throw new ServiceError(
        409,
        `Stok "${initialProduct.name}" tidak mencukupi untuk dikurangi ${qty} ${initialProduct.unit} (tersedia ${stockBefore}, stok negatif dinonaktifkan).`
      );
    }

    const referenceNumber =
      typeof input.referenceNumber === 'string' && input.referenceNumber.trim()
        ? input.referenceNumber.trim().slice(0, 64)
        : nextInventoryDocNumber(db, 'ADJ', 'stock_adjustments', 'reference_number');

    const movementType: StockMovementType =
      direction === 'INCREASE' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';

    db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(
      stockAfter,
      nowIso,
      productId
    );

    const movNotes = notes ? `${reason} · ${notes}` : reason;
    db.prepare(`
      INSERT INTO stock_movements (
        id, product_id, sku, product_name, barcode, type, qty_delta,
        stock_before, stock_after, unit_cost, reference_id, reason, notes,
        actor_user_id, actor_name, movement_date, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      movementId,
      initialProduct.id,
      initialProduct.sku,
      initialProduct.name,
      initialProduct.barcode,
      movementType,
      qtyDelta,
      stockBefore,
      stockAfter,
      initialProduct.costPrice,
      referenceNumber,
      reason,
      movNotes,
      actor.id,
      actor.fullName,
      nowIso,
      nowIso
    );

    db.prepare(`
      INSERT INTO stock_adjustments (
        id, reference_number, product_id, sku, product_name, barcode,
        direction, qty, stock_before, stock_after, reason, notes, approval_status,
        requested_by_user_id, requested_by_name, approved_by_user_id, approved_by_name,
        movement_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?, ?, ?)
    `).run(
      adjustmentId,
      referenceNumber,
      initialProduct.id,
      initialProduct.sku,
      initialProduct.name,
      initialProduct.barcode,
      direction,
      qty,
      stockBefore,
      stockAfter,
      reason,
      notes,
      actor.id,
      actor.fullName,
      approvedByUserId,
      approvedByName,
      movementId,
      nowIso
    );

    recordAuditLog(db, {
      action: 'STOCK_ADJUSTED',
      entityType: 'stock',
      entityId: referenceNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `${direction === 'INCREASE' ? 'Penambahan' : 'Pengurangan'} stok "${initialProduct.name}" (${qtyDelta > 0 ? `+${qtyDelta}` : qtyDelta} ${initialProduct.unit}): ${stockBefore} → ${stockAfter} · Alasan: ${reason} (Disetujui: ${approvedByName})`,
    });

    movementRecord = {
      id: movementId,
      productId: initialProduct.id,
      sku: initialProduct.sku,
      productName: initialProduct.name,
      barcode: initialProduct.barcode,
      type: movementType,
      qtyDelta,
      stockBefore,
      stockAfter,
      unitCost: initialProduct.costPrice,
      referenceId: referenceNumber,
      reason,
      notes: movNotes,
      actorUserId: actor.id,
      actorName: actor.fullName,
      movementDate: nowIso,
      createdAt: nowIso,
    };

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const adjustment = listStockAdjustments({ limit: 50 }).find((a) => a.id === adjustmentId)!;
  return {
    adjustment,
    movement: movementRecord,
    product: getProductById(productId),
  };
}

// --- 5. Stock Opname Workflow ---
function mapOpnameSessionRow(r: {
  id: string;
  opname_number: string;
  title: string;
  status: StockOpnameStatus;
  notes: string;
  total_items: number;
  counted_items: number;
  discrepancy_items: number;
  total_variance_qty: number;
  total_variance_value: number;
  created_by_user_id: string | null;
  created_by_name: string;
  approved_by_user_id: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  finalized_by_user_id: string | null;
  finalized_by_name: string | null;
  finalized_at: string | null;
  created_at: string;
  updated_at: string;
}): StockOpnameSession {
  return {
    id: r.id,
    opnameNumber: r.opname_number,
    title: r.title,
    status: r.status,
    notes: r.notes,
    totalItems: r.total_items,
    countedItems: r.counted_items,
    discrepancyItems: r.discrepancy_items,
    totalVarianceQty: r.total_variance_qty,
    totalVarianceValue: r.total_variance_value,
    createdByUserId: r.created_by_user_id,
    createdByName: r.created_by_name,
    approvedByUserId: r.approved_by_user_id,
    approvedByName: r.approved_by_name,
    approvedAt: r.approved_at,
    finalizedByUserId: r.finalized_by_user_id,
    finalizedByName: r.finalized_by_name,
    finalizedAt: r.finalized_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function recalculateOpnameSummaryTx(db: DatabaseSync, opnameId: string, nowIso: string): void {
  const agg = db
    .prepare(`
      SELECT
        COUNT(*) AS total_items,
        COALESCE(SUM(CASE WHEN is_counted = 1 THEN 1 ELSE 0 END), 0) AS counted_items,
        COALESCE(SUM(CASE WHEN is_counted = 1 AND variance != 0 THEN 1 ELSE 0 END), 0) AS discrepancy_items,
        COALESCE(SUM(CASE WHEN is_counted = 1 THEN variance ELSE 0 END), 0) AS total_variance_qty,
        COALESCE(SUM(CASE WHEN is_counted = 1 THEN variance_value ELSE 0 END), 0) AS total_variance_value
      FROM stock_opname_items
      WHERE opname_id = ?
    `)
    .get(opnameId) as {
    total_items: number;
    counted_items: number;
    discrepancy_items: number;
    total_variance_qty: number;
    total_variance_value: number;
  };

  db.prepare(`
    UPDATE stock_opnames
    SET total_items = ?, counted_items = ?, discrepancy_items = ?,
        total_variance_qty = ?, total_variance_value = ?, updated_at = ?
    WHERE id = ?
  `).run(
    agg.total_items,
    agg.counted_items,
    agg.discrepancy_items,
    agg.total_variance_qty,
    agg.total_variance_value,
    nowIso,
    opnameId
  );
}

export function listStockOpnames(status?: string): StockOpnameSession[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT id, opname_number, title, status, notes,
             total_items, counted_items, discrepancy_items, total_variance_qty, total_variance_value,
             created_by_user_id, created_by_name, approved_by_user_id, approved_by_name, approved_at,
             finalized_by_user_id, finalized_by_name, finalized_at, created_at, updated_at
      FROM stock_opnames
      ORDER BY created_at DESC
      LIMIT 200
    `)
    .all() as Array<Parameters<typeof mapOpnameSessionRow>[0]>;

  const mapped = rows.map(mapOpnameSessionRow);
  if (status && status !== 'ALL') {
    return mapped.filter((o) => o.status === status);
  }
  return mapped;
}

export function getStockOpnameDetail(opnameId: string): StockOpnameDetail {
  const db = getDb();
  const headerRow = db
    .prepare(`
      SELECT id, opname_number, title, status, notes,
             total_items, counted_items, discrepancy_items, total_variance_qty, total_variance_value,
             created_by_user_id, created_by_name, approved_by_user_id, approved_by_name, approved_at,
             finalized_by_user_id, finalized_by_name, finalized_at, created_at, updated_at
      FROM stock_opnames
      WHERE id = ? OR opname_number = ?
    `)
    .get(opnameId, opnameId) as Parameters<typeof mapOpnameSessionRow>[0] | undefined;

  if (!headerRow) {
    throw new ServiceError(404, 'Sesi stok opname tidak ditemukan.');
  }

  const itemRows = db
    .prepare(`
      SELECT id, opname_id, product_id, sku, barcode, product_name, unit, cost_price,
             system_stock, physical_stock, variance, variance_value, is_counted, notes,
             applied_movement_id, updated_at
      FROM stock_opname_items
      WHERE opname_id = ?
      ORDER BY product_name ASC
    `)
    .all(headerRow.id) as Array<{
    id: string;
    opname_id: string;
    product_id: string;
    sku: string;
    barcode: string;
    product_name: string;
    unit: string;
    cost_price: number;
    system_stock: number;
    physical_stock: number | null;
    variance: number;
    variance_value: number;
    is_counted: number;
    notes: string;
    applied_movement_id: string | null;
    updated_at: string;
  }>;

  const items: StockOpnameItem[] = itemRows.map((i) => ({
    id: i.id,
    opnameId: i.opname_id,
    productId: i.product_id,
    sku: i.sku,
    barcode: i.barcode,
    productName: i.product_name,
    unit: i.unit,
    costPrice: i.cost_price,
    systemStock: i.system_stock,
    physicalStock: i.physical_stock,
    variance: i.variance,
    varianceValue: i.variance_value,
    isCounted: i.is_counted === 1,
    notes: i.notes,
    appliedMovementId: i.applied_movement_id,
    updatedAt: i.updated_at,
  }));

  return {
    ...mapOpnameSessionRow(headerRow),
    items,
  };
}

export function createStockOpname(
  input: {
    title?: unknown;
    notes?: unknown;
    productIds?: unknown;
    includeInactive?: unknown;
  },
  actor: UserSummary
): StockOpnameDetail {
  const title =
    typeof input.title === 'string' && input.title.trim()
      ? input.title.trim()
      : `Stok Opname ${new Date().toLocaleDateString('id-ID')}`;
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';

  const allProducts = queryEnrichedProducts();
  const productMap = new Map(allProducts.map((p) => [p.id, p]));

  let selectedProducts: Product[];
  if (Array.isArray(input.productIds) && input.productIds.length > 0) {
    const uniqueIds = Array.from(
      new Set(
        input.productIds
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map((id) => id.trim())
      )
    );
    selectedProducts = uniqueIds.map((id) => {
      const p = productMap.get(id);
      if (!p) {
        throw new ServiceError(404, `Produk dengan ID "${id}" tidak ditemukan.`);
      }
      return p;
    });
  } else {
    const includeInactive = Boolean(input.includeInactive);
    selectedProducts = allProducts.filter((p) => includeInactive || p.status === 'ACTIVE');
  }

  if (selectedProducts.length === 0) {
    throw new ServiceError(400, 'Pilih minimal 1 produk untuk memulai stok opname.');
  }

  const db = getDb();
  const nowIso = new Date().toISOString();
  const opnameId = `opn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  db.exec('BEGIN IMMEDIATE;');
  try {
    const opnameNumber = nextInventoryDocNumber(db, 'OPN', 'stock_opnames', 'opname_number');

    db.prepare(`
      INSERT INTO stock_opnames (
        id, opname_number, title, status, notes,
        total_items, counted_items, discrepancy_items, total_variance_qty, total_variance_value,
        created_by_user_id, created_by_name, created_at, updated_at
      ) VALUES (?, ?, ?, 'DRAFT', ?, ?, 0, 0, 0, 0, ?, ?, ?, ?)
    `).run(
      opnameId,
      opnameNumber,
      title,
      notes,
      selectedProducts.length,
      actor.id,
      actor.fullName,
      nowIso,
      nowIso
    );

    const insertItem = db.prepare(`
      INSERT INTO stock_opname_items (
        id, opname_id, product_id, sku, barcode, product_name, unit, cost_price,
        system_stock, physical_stock, variance, variance_value, is_counted, notes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, '', ?)
    `);

    selectedProducts.forEach((p, idx) => {
      insertItem.run(
        `${opnameId}-itm-${idx}`,
        opnameId,
        p.id,
        p.sku,
        p.barcode,
        p.name,
        p.unit,
        p.costPrice,
        p.stock,
        nowIso
      );
    });

    recordAuditLog(db, {
      action: 'STOCK_OPNAME_CREATED',
      entityType: 'stock',
      entityId: opnameNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Buat sesi stok opname ${opnameNumber} "${title}" (${selectedProducts.length} SKU)`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getStockOpnameDetail(opnameId);
}

export function updateStockOpnameCounts(
  opnameId: string,
  input: {
    items?: unknown;
    addProductIds?: unknown;
    removeProductIds?: unknown;
    submitForReview?: unknown;
    notes?: unknown;
  },
  actor: UserSummary
): StockOpnameDetail {
  const db = getDb();
  const detail = getStockOpnameDetail(opnameId);
  if (detail.status !== 'DRAFT' && detail.status !== 'PENDING_REVIEW') {
    throw new ServiceError(
      409,
      `Sesi stok opname berstatus "${detail.status}" tidak dapat diubah lagi.`
    );
  }

  const nowIso = new Date().toISOString();
  const allProducts = queryEnrichedProducts();
  const productMap = new Map(allProducts.map((p) => [p.id, p]));

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (typeof input.notes === 'string') {
      db.prepare('UPDATE stock_opnames SET notes = ?, updated_at = ? WHERE id = ?').run(
        input.notes.trim(),
        nowIso,
        detail.id
      );
    }

    // Optional add products
    if (Array.isArray(input.addProductIds) && input.addProductIds.length > 0) {
      const existingProductIds = new Set(detail.items.map((i) => i.productId));
      const insertItem = db.prepare(`
        INSERT OR IGNORE INTO stock_opname_items (
          id, opname_id, product_id, sku, barcode, product_name, unit, cost_price,
          system_stock, physical_stock, variance, variance_value, is_counted, notes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, '', ?)
      `);
      for (const pid of input.addProductIds) {
        if (typeof pid !== 'string' || existingProductIds.has(pid)) continue;
        const p = productMap.get(pid);
        if (!p) throw new ServiceError(404, `Produk "${pid}" tidak ditemukan.`);
        insertItem.run(
          `${detail.id}-itm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          detail.id,
          p.id,
          p.sku,
          p.barcode,
          p.name,
          p.unit,
          p.costPrice,
          p.stock,
          nowIso
        );
      }
    }

    // Optional remove products
    if (Array.isArray(input.removeProductIds) && input.removeProductIds.length > 0) {
      const delStmt = db.prepare(
        'DELETE FROM stock_opname_items WHERE opname_id = ? AND product_id = ?'
      );
      for (const pid of input.removeProductIds) {
        if (typeof pid === 'string') {
          delStmt.run(detail.id, pid);
        }
      }
    }

    // Update counts
    if (Array.isArray(input.items)) {
      const lineSelectStmt = db.prepare(
        'SELECT id, product_id, system_stock, cost_price FROM stock_opname_items WHERE opname_id = ? AND product_id = ?'
      );
      const lineUpdateStmt = db.prepare(`
        UPDATE stock_opname_items
        SET physical_stock = ?, variance = ?, variance_value = ?, is_counted = ?, notes = ?, updated_at = ?
        WHERE id = ?
      `);

      for (const rawLine of input.items) {
        if (!rawLine || typeof rawLine !== 'object') {
          throw new ServiceError(400, 'Format baris hitungan opname tidak valid.');
        }
        const line = rawLine as {
          productId?: unknown;
          physicalStock?: unknown;
          notes?: unknown;
        };
        const productId = typeof line.productId === 'string' ? line.productId.trim() : '';
        if (!productId) {
          throw new ServiceError(400, 'productId wajib ada pada baris opname.');
        }
        const row = lineSelectStmt.get(detail.id, productId) as
          | { id: string; product_id: string; system_stock: number; cost_price: number }
          | undefined;
        if (!row) {
          throw new ServiceError(404, `Produk "${productId}" tidak terdaftar dalam sesi opname ini.`);
        }

        let physicalStock: number | null = null;
        if (
          line.physicalStock !== undefined &&
          line.physicalStock !== null &&
          String(line.physicalStock).trim() !== ''
        ) {
          physicalStock = assertNonNegativeInt(line.physicalStock, 'Stok fisik opname');
        }

        const isCounted = physicalStock !== null;
        const variance = isCounted ? physicalStock! - row.system_stock : 0;
        const varianceValue = isCounted ? variance * row.cost_price : 0;
        const itemNotes = typeof line.notes === 'string' ? line.notes.trim() : '';

        lineUpdateStmt.run(
          physicalStock,
          variance,
          varianceValue,
          isCounted ? 1 : 0,
          itemNotes,
          nowIso,
          row.id
        );
      }
    }

    recalculateOpnameSummaryTx(db, detail.id, nowIso);

    const remainingCount = (
      db
        .prepare('SELECT COUNT(*) as cnt FROM stock_opname_items WHERE opname_id = ?')
        .get(detail.id) as { cnt: number }
    ).cnt;
    if (remainingCount === 0) {
      throw new ServiceError(400, 'Sesi stok opname harus memiliki minimal 1 produk.');
    }

    if (input.submitForReview === true) {
      const counted = (
        db
          .prepare('SELECT counted_items FROM stock_opnames WHERE id = ?')
          .get(detail.id) as { counted_items: number }
      ).counted_items;
      if (counted === 0) {
        throw new ServiceError(
          400,
          'Masukkan minimal 1 hasil hitungan stok fisik sebelum mengirim untuk tinjauan.'
        );
      }
      db.prepare("UPDATE stock_opnames SET status = 'PENDING_REVIEW', updated_at = ? WHERE id = ?").run(
        nowIso,
        detail.id
      );
    }

    void actor;
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getStockOpnameDetail(detail.id);
}

export function approveStockOpname(
  opnameId: string,
  input: { pinApprovalToken?: unknown; notes?: unknown },
  actor: UserSummary
): StockOpnameDetail {
  const db = getDb();
  const detail = getStockOpnameDetail(opnameId);

  if (detail.status === 'FINALIZED' || detail.status === 'CANCELLED') {
    throw new ServiceError(
      409,
      `Sesi stok opname berstatus "${detail.status}" tidak dapat disetujui.`
    );
  }
  if (detail.countedItems === 0) {
    throw new ServiceError(
      400,
      'Belum ada produk yang dihitung fisiknya pada sesi opname ini.'
    );
  }

  const hasPermission = actor.permissions.includes('stock:adjust');
  const pinToken = typeof input.pinApprovalToken === 'string' ? input.pinApprovalToken.trim() : '';
  if (!hasPermission && !pinToken) {
    throw new ServiceError(
      403,
      'Persetujuan stok opname memerlukan izin stock:adjust atau otorisasi PIN Supervisor/Admin.',
      'PIN_REQUIRED'
    );
  }

  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    let approvedByUserId = actor.id;
    let approvedByName = actor.fullName;
    if (!hasPermission && pinToken) {
      const consumed = consumePinApprovalToken(db, pinToken, 'stock_adjustment');
      approvedByUserId = consumed.authorizerUserId;
      approvedByName = resolveAuthorizerName(db, consumed.authorizerUserId);
    }

    const nextNotes =
      typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : detail.notes;

    db.prepare(`
      UPDATE stock_opnames
      SET status = 'APPROVED',
          notes = ?,
          approved_by_user_id = ?,
          approved_by_name = ?,
          approved_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(nextNotes, approvedByUserId, approvedByName, nowIso, nowIso, detail.id);

    recordAuditLog(db, {
      action: 'STOCK_OPNAME_APPROVED',
      entityType: 'stock',
      entityId: detail.opnameNumber,
      actorUserId: approvedByUserId,
      actor: approvedByName,
      summary: `Setujui stok opname ${detail.opnameNumber} (${detail.countedItems}/${detail.totalItems} item dihitung, ${detail.discrepancyItems} selisih, net ${detail.totalVarianceQty >= 0 ? `+${detail.totalVarianceQty}` : detail.totalVarianceQty})`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getStockOpnameDetail(detail.id);
}

export function finalizeStockOpname(opnameId: string, actor: UserSummary): StockOpnameDetail {
  const db = getDb();
  const detail = getStockOpnameDetail(opnameId);

  if (detail.status === 'FINALIZED') {
    throw new ServiceError(409, `Stok opname ${detail.opnameNumber} sudah difinalisasi sebelumnya.`);
  }
  if (detail.status === 'CANCELLED') {
    throw new ServiceError(409, `Stok opname ${detail.opnameNumber} sudah dibatalkan.`);
  }
  if (detail.status !== 'APPROVED') {
    throw new ServiceError(
      409,
      'Stok opname harus disetujui (APPROVED) terlebih dahulu sebelum difinalisasi.'
    );
  }
  if (!actor.permissions.includes('stock:adjust')) {
    throw new ServiceError(
      403,
      'Akses ditolak: Anda tidak memiliki izin "stock:adjust" untuk memfinalisasi stok opname.'
    );
  }

  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    const allowNegative = isNegativeStockAllowed(db);
    const selectStockStmt = db.prepare('SELECT stock, cost_price FROM products WHERE id = ?');
    const updateStockStmt = db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?');
    const insertMovStmt = db.prepare(`
      INSERT INTO stock_movements (
        id, product_id, sku, product_name, barcode, type, qty_delta,
        stock_before, stock_after, unit_cost, reference_id, reason, notes,
        actor_user_id, actor_name, movement_date, created_at
      ) VALUES (?, ?, ?, ?, ?, 'OPNAME', ?, ?, ?, ?, ?, 'Stok Opname Fisik', ?, ?, ?, ?, ?)
    `);
    const updateItemStmt = db.prepare(`
      UPDATE stock_opname_items
      SET system_stock = ?, variance = ?, variance_value = ?, applied_movement_id = ?, updated_at = ?
      WHERE id = ?
    `);

    let appliedAdjustments = 0;

    detail.items.forEach((item, idx) => {
      if (!item.isCounted || item.physicalStock === null) return;

      const prodRow = selectStockStmt.get(item.productId) as
        | { stock: number; cost_price: number }
        | undefined;
      if (!prodRow) {
        throw new ServiceError(404, `Produk "${item.productName}" tidak ditemukan.`);
      }

      const stockBefore = prodRow.stock;
      const stockAfter = item.physicalStock;
      if (stockAfter < 0 && !allowNegative) {
        throw new ServiceError(
          409,
          `Hasil opname "${item.productName}" bernilai negatif dan pengaturan stok negatif dinonaktifkan.`
        );
      }

      const delta = stockAfter - stockBefore;
      const varianceValue = delta * prodRow.cost_price;

      let appliedMovementId: string | null = null;
      if (delta !== 0) {
        appliedMovementId = `mov-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`;
        updateStockStmt.run(stockAfter, nowIso, item.productId);
        const movNotes = item.notes
          ? `Opname ${detail.opnameNumber}: ${item.notes}`
          : `Penyesuaian fisik opname ${detail.opnameNumber}`;
        insertMovStmt.run(
          appliedMovementId,
          item.productId,
          item.sku,
          item.productName,
          item.barcode,
          delta,
          stockBefore,
          stockAfter,
          prodRow.cost_price,
          detail.opnameNumber,
          movNotes,
          actor.id,
          actor.fullName,
          nowIso,
          nowIso
        );
        appliedAdjustments++;
      }

      updateItemStmt.run(
        stockBefore,
        delta,
        varianceValue,
        appliedMovementId,
        nowIso,
        item.id
      );
    });

    recalculateOpnameSummaryTx(db, detail.id, nowIso);

    db.prepare(`
      UPDATE stock_opnames
      SET status = 'FINALIZED',
          finalized_by_user_id = ?,
          finalized_by_name = ?,
          finalized_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(actor.id, actor.fullName, nowIso, nowIso, detail.id);

    recordAuditLog(db, {
      action: 'STOCK_OPNAME_FINALIZED',
      entityType: 'stock',
      entityId: detail.opnameNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Finalisasi stok opname ${detail.opnameNumber}: ${appliedAdjustments} SKU disesuaikan ke stok fisik`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getStockOpnameDetail(detail.id);
}

export function cancelStockOpname(
  opnameId: string,
  reason: string | undefined,
  actor: UserSummary
): StockOpnameDetail {
  const db = getDb();
  const detail = getStockOpnameDetail(opnameId);

  if (detail.status === 'FINALIZED') {
    throw new ServiceError(409, 'Stok opname yang sudah difinalisasi tidak dapat dibatalkan.');
  }
  if (detail.status === 'CANCELLED') {
    return detail;
  }

  const nowIso = new Date().toISOString();
  const nextNotes = reason && reason.trim() ? `Dibatalkan: ${reason.trim()}` : detail.notes;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE stock_opnames
      SET status = 'CANCELLED', notes = ?, updated_at = ?
      WHERE id = ?
    `).run(nextNotes, nowIso, detail.id);

    recordAuditLog(db, {
      action: 'STOCK_OPNAME_CANCELLED',
      entityType: 'stock',
      entityId: detail.opnameNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Batalkan sesi stok opname ${detail.opnameNumber}${reason ? ` (${reason})` : ''}`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getStockOpnameDetail(detail.id);
}
