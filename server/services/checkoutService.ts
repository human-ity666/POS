import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.ts';
import {
  allocateProportionally,
  calculateExactDiscount,
  parseDecimalToScaledInt,
  roundHalfUpDiv,
  type DiscountMode,
} from '../utils/money.ts';
import { recordAuditLog } from './auditService.ts';
import { consumePinApprovalToken } from './authService.ts';
import { queryEnrichedProducts } from './catalogService.ts';
import { ServiceError } from './errors.ts';
import { captureReceiptSnapshotTx } from './receiptService.ts';
import type {
  Customer,
  PaymentMethodConfig,
  PaymentMethodType,
  PaymentStatus,
  PosCalculationPreview,
  TaxCategory,
  Transaction,
  TransactionItem,
  TransactionListResponse,
  TransactionPaymentRecord,
  TransactionStatus,
  UserSummary,
} from '../../src/types.ts';

const VALID_PAYMENT_TYPES: ReadonlySet<PaymentMethodType> = new Set([
  'CASH',
  'DEBIT',
  'CREDIT',
  'QRIS',
  'OTHER',
]);

// --- Customers ---
export function listCustomers(search?: string): Customer[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT id, code, name, phone, email, address, notes, is_active, created_at, updated_at
      FROM customers
      ORDER BY name ASC
    `)
    .all() as Array<{
    id: string;
    code: string;
    name: string;
    phone: string;
    email: string;
    address: string;
    notes: string;
    is_active: number;
    created_at: string;
    updated_at: string;
  }>;

  let list: Customer[] = rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    phone: r.phone,
    email: r.email,
    address: r.address,
    notes: r.notes,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  const q = (search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q)
    );
  }
  return list;
}

export function createCustomer(
  input: { name?: unknown; phone?: unknown; email?: unknown; address?: unknown; notes?: unknown },
  actor: UserSummary
): Customer {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length < 2) {
    throw new ServiceError(400, 'Nama pelanggan wajib diisi (minimal 2 karakter).');
  }
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const address = typeof input.address === 'string' ? input.address.trim() : '';
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';

  const db = getDb();
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM customers').get() as { cnt: number };
  let seq = countRow.cnt + 1;
  let code = '';
  while (true) {
    const cand = `CUST-${String(seq).padStart(4, '0')}`;
    if (!db.prepare('SELECT 1 FROM customers WHERE code = ?').get(cand)) {
      code = cand;
      break;
    }
    seq++;
  }

  const id = `cust-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO customers (id, code, name, phone, email, address, notes, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, code, name, phone, email, address, notes, nowIso, nowIso);

    recordAuditLog(db, {
      action: 'CUSTOMER_CREATED',
      entityType: 'customer',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Tambah pelanggan "${name}" (${code})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return listCustomers().find((c) => c.id === id)!;
}

// --- Configurable Payment Methods ---
export function listPaymentMethods(includeInactive = false): PaymentMethodConfig[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT id, code, name, type, requires_reference, is_system, is_active, sort_order, created_at
      FROM payment_methods
      ORDER BY sort_order ASC, name ASC
    `)
    .all() as Array<{
    id: string;
    code: string;
    name: string;
    type: PaymentMethodType;
    requires_reference: number;
    is_system: number;
    is_active: number;
    sort_order: number;
    created_at: string;
  }>;

  return rows
    .filter((r) => includeInactive || r.is_active === 1)
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      requiresReference: r.requires_reference === 1,
      isSystem: r.is_system === 1,
      isActive: r.is_active === 1,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
    }));
}

export function createPaymentMethod(
  input: { name?: unknown; code?: unknown; type?: unknown; requiresReference?: unknown },
  actor: UserSummary
): PaymentMethodConfig {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw new ServiceError(400, 'Nama metode pembayaran wajib diisi.');
  }
  const rawCode =
    typeof input.code === 'string' && input.code.trim()
      ? input.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '')
      : name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!rawCode) {
    throw new ServiceError(400, 'Kode metode pembayaran tidak valid.');
  }
  const rawType = typeof input.type === 'string' ? input.type.trim().toUpperCase() : 'OTHER';
  if (!VALID_PAYMENT_TYPES.has(rawType as PaymentMethodType)) {
    throw new ServiceError(400, 'Tipe pembayaran harus CASH, DEBIT, CREDIT, QRIS, atau OTHER.');
  }

  const db = getDb();
  const dup = db
    .prepare('SELECT id FROM payment_methods WHERE LOWER(name) = LOWER(?) OR LOWER(code) = LOWER(?)')
    .get(name, rawCode);
  if (dup) {
    throw new ServiceError(409, `Metode pembayaran "${name}" atau kode "${rawCode}" sudah ada.`);
  }

  const maxOrder = (
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM payment_methods').get() as { m: number }
  ).m;
  const id = `pm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const nowIso = new Date().toISOString();
  const requiresReference = Boolean(input.requiresReference);

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO payment_methods (id, code, name, type, requires_reference, is_system, is_active, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)
    `).run(id, rawCode, name, rawType, requiresReference ? 1 : 0, maxOrder + 1, nowIso);

    recordAuditLog(db, {
      action: 'PAYMENT_METHOD_CREATED',
      entityType: 'payment_method',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Tambah metode pembayaran "${name}" (${rawType})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return listPaymentMethods(true).find((p) => p.id === id)!;
}

export function setPaymentMethodStatus(
  id: string,
  isActive: boolean,
  actor: UserSummary
): PaymentMethodConfig {
  const db = getDb();
  const current = db
    .prepare('SELECT id, name, is_system FROM payment_methods WHERE id = ?')
    .get(id) as { id: string; name: string; is_system: number } | undefined;
  if (!current) {
    throw new ServiceError(404, 'Metode pembayaran tidak ditemukan.');
  }
  if (current.is_system === 1 && !isActive && current.id === 'pm-cash') {
    throw new ServiceError(400, 'Metode pembayaran Tunai bawaan tidak dapat dinonaktifkan.');
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('UPDATE payment_methods SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
    recordAuditLog(db, {
      action: 'PAYMENT_METHOD_UPDATED',
      entityType: 'payment_method',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `${isActive ? 'Aktifkan' : 'Nonaktifkan'} metode pembayaran "${current.name}"`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return listPaymentMethods(true).find((p) => p.id === id)!;
}

// --- Sequence Number Generator ---
function nextDocumentNumber(db: DatabaseSync, prefix: 'TRX' | 'HOLD'): string {
  const nowIso = new Date().toISOString();
  const dateStamp = nowIso.slice(0, 10).replace(/-/g, '');
  const seqKey = `${prefix}-${dateStamp}`;

  // Seed starting sequence if transactions already exist for today before migration 004
  const existingRow = db
    .prepare('SELECT last_number FROM document_sequences WHERE seq_key = ?')
    .get(seqKey) as { last_number: number } | undefined;

  let nextNum: number;
  if (!existingRow) {
    const existingCount = (
      db
        .prepare('SELECT COUNT(*) as cnt FROM transactions WHERE invoice_number LIKE ?')
        .get(`${seqKey}-%`) as { cnt: number }
    ).cnt;
    nextNum = existingCount + 1;
    db.prepare('INSERT INTO document_sequences (seq_key, last_number, updated_at) VALUES (?, ?, ?)').run(
      seqKey,
      nextNum,
      nowIso
    );
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
    const collision = db.prepare('SELECT 1 FROM transactions WHERE invoice_number = ?').get(candidate);
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

// --- Query Helpers ---
function mapTransactionRows(
  trxRows: Array<{
    id: string;
    invoice_number: string;
    status: TransactionStatus;
    payment_status: PaymentStatus;
    customer_id: string | null;
    customer_name: string;
    subtotal: number;
    line_discount_total: number;
    transaction_discount_type: DiscountMode;
    transaction_discount_value: number;
    transaction_discount_amount: number;
    discount_amount: number;
    apply_tax: number;
    tax_amount: number;
    total: number;
    cash_received: number;
    change_amount: number;
    payment_method: string;
    total_cost: number;
    gross_profit: number;
    notes: string;
    cashier_id: string | null;
    cashier_name: string;
    held_at: string | null;
    cancelled_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
  }>
): Transaction[] {
  if (trxRows.length === 0) return [];
  const db = getDb();

  const itemStmt = db.prepare(`
    SELECT product_id, sku, barcode, name, unit, qty,
           original_sell_price, sell_price, price_override, cost_price,
           line_discount_type, line_discount_value, line_discount_amount,
           tax_category, tax_amount, subtotal
    FROM transaction_items
    WHERE transaction_id = ?
    ORDER BY id ASC
  `);

  const payStmt = db.prepare(`
    SELECT id, payment_method_id, payment_method_name, payment_type,
           amount, tendered_amount, change_amount, reference_number, created_at
    FROM transaction_payments
    WHERE transaction_id = ?
    ORDER BY created_at ASC, id ASC
  `);

  return trxRows.map((t) => {
    const itemRows = itemStmt.all(t.id) as Array<{
      product_id: string;
      sku: string;
      barcode: string;
      name: string;
      unit: string;
      qty: number;
      original_sell_price: number;
      sell_price: number;
      price_override: number;
      cost_price: number;
      line_discount_type: DiscountMode;
      line_discount_value: number;
      line_discount_amount: number;
      tax_category: TaxCategory;
      tax_amount: number;
      subtotal: number;
    }>;

    const payRows = payStmt.all(t.id) as Array<{
      id: string;
      payment_method_id: string | null;
      payment_method_name: string;
      payment_type: PaymentMethodType;
      amount: number;
      tendered_amount: number;
      change_amount: number;
      reference_number: string;
      created_at: string;
    }>;

    const items: TransactionItem[] = itemRows.map((i) => ({
      productId: i.product_id,
      sku: i.sku || undefined,
      barcode: i.barcode,
      name: i.name,
      unit: i.unit,
      qty: i.qty,
      originalSellPrice: i.original_sell_price,
      sellPrice: i.sell_price,
      priceOverride: i.price_override === 1,
      costPrice: i.cost_price,
      lineDiscountType: i.line_discount_type,
      lineDiscountValue: i.line_discount_value,
      lineDiscountAmount: i.line_discount_amount,
      taxCategory: i.tax_category,
      taxAmount: i.tax_amount,
      subtotal: i.subtotal,
    }));

    const payments: TransactionPaymentRecord[] = payRows.map((p) => ({
      id: p.id,
      paymentMethodId: p.payment_method_id,
      paymentMethodName: p.payment_method_name,
      paymentType: p.payment_type,
      amount: p.amount,
      tenderedAmount: p.tendered_amount,
      changeAmount: p.change_amount,
      referenceNumber: p.reference_number,
      createdAt: p.created_at,
    }));

    return {
      id: t.id,
      invoiceNumber: t.invoice_number,
      status: t.status,
      paymentStatus: t.payment_status,
      customerId: t.customer_id,
      customerName: t.customer_name,
      items,
      payments,
      subtotal: t.subtotal,
      lineDiscountTotal: t.line_discount_total,
      transactionDiscountType: t.transaction_discount_type,
      transactionDiscountValue: t.transaction_discount_value,
      transactionDiscountAmount: t.transaction_discount_amount,
      discountAmount: t.discount_amount,
      applyTax: t.apply_tax === 1,
      taxAmount: t.tax_amount,
      total: t.total,
      cashReceived: t.cash_received,
      changeAmount: t.change_amount,
      paymentMethod: t.payment_method,
      totalCost: t.total_cost,
      grossProfit: t.gross_profit,
      notes: t.notes,
      cashierId: t.cashier_id,
      cashierName: t.cashier_name,
      heldAt: t.held_at,
      cancelledAt: t.cancelled_at,
      completedAt: t.completed_at,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    };
  });
}

const TRANSACTION_SELECT_COLS = `
  id, invoice_number, status, payment_status, customer_id, customer_name,
  subtotal, line_discount_total, transaction_discount_type, transaction_discount_value,
  transaction_discount_amount, discount_amount, apply_tax, tax_amount, total,
  cash_received, change_amount, payment_method, total_cost, gross_profit,
  notes, cashier_id, cashier_name, held_at, cancelled_at, completed_at,
  created_at, updated_at
`;

export function queryTransactions(limit = 200, includeAllStatuses = false): Transaction[] {
  const db = getDb();
  const whereClause = includeAllStatuses ? '' : "WHERE status != 'HELD' AND status != 'NEW'";
  const rows = db
    .prepare(`
      SELECT ${TRANSACTION_SELECT_COLS}
      FROM transactions
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as Parameters<typeof mapTransactionRows>[0];
  return mapTransactionRows(rows);
}

export function listHeldTransactions(): Transaction[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT ${TRANSACTION_SELECT_COLS}
      FROM transactions
      WHERE status = 'HELD'
      ORDER BY COALESCE(held_at, updated_at) DESC
    `)
    .all() as Parameters<typeof mapTransactionRows>[0];
  return mapTransactionRows(rows);
}

export function getTransactionById(id: string): Transaction {
  const db = getDb();
  const row = db
    .prepare(`SELECT ${TRANSACTION_SELECT_COLS} FROM transactions WHERE id = ? OR invoice_number = ?`)
    .get(id, id) as Parameters<typeof mapTransactionRows>[0][number] | undefined;
  if (!row) {
    throw new ServiceError(404, 'Transaksi tidak ditemukan.');
  }
  return mapTransactionRows([row])[0];
}

export interface TransactionQueryParams {
  search?: string;
  status?: string;
  paymentStatus?: string;
  paymentMethod?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export function listTransactionsPaginated(params: TransactionQueryParams): TransactionListResponse {
  let list = queryTransactions(1000, true);

  if (params.status && params.status !== 'ALL') {
    list = list.filter((t) => t.status === params.status);
  }
  if (params.paymentStatus && params.paymentStatus !== 'ALL') {
    list = list.filter((t) => t.paymentStatus === params.paymentStatus);
  }
  if (params.paymentMethod && params.paymentMethod !== 'ALL') {
    list = list.filter(
      (t) =>
        t.paymentMethod.toLowerCase().includes(params.paymentMethod!.toLowerCase()) ||
        (t.payments ?? []).some(
          (p) => p.paymentMethodName.toLowerCase() === params.paymentMethod!.toLowerCase()
        )
    );
  }
  if (params.dateFrom) {
    list = list.filter((t) => t.createdAt.slice(0, 10) >= params.dateFrom!);
  }
  if (params.dateTo) {
    list = list.filter((t) => t.createdAt.slice(0, 10) <= params.dateTo!);
  }
  const q = (params.search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (t) =>
        t.invoiceNumber.toLowerCase().includes(q) ||
        t.cashierName.toLowerCase().includes(q) ||
        t.customerName.toLowerCase().includes(q) ||
        t.notes.toLowerCase().includes(q) ||
        t.items.some(
          (i) => i.name.toLowerCase().includes(q) || (i.sku && i.sku.toLowerCase().includes(q))
        )
    );
  }

  const total = list.length;
  const pageSize = Math.min(100, Math.max(1, Number(params.pageSize || 25)));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(params.page || 1)));
  const start = (page - 1) * pageSize;

  return {
    transactions: list.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    totalPages,
  };
}

// --- Authoritative Cart Calculation Engine (Zero Float Math) ---
export interface CartLineInput {
  productId?: unknown;
  qty?: unknown;
  overrideUnitPrice?: unknown;
  lineDiscountType?: unknown;
  lineDiscountValue?: unknown;
}

export interface CartCalculationInput {
  items?: unknown;
  discountAmount?: unknown; // legacy flat transaction discount
  transactionDiscountType?: unknown;
  transactionDiscountValue?: unknown;
  applyTax?: unknown;
}

interface ResolvedCartCalculation {
  preview: PosCalculationPreview;
  totalCost: number;
  grossProfit: number;
  itemsWithCost: Array<
    PosCalculationPreview['items'][number] & {
      costPrice: number;
      lineCostTotal: number;
    }
  >;
}

export function calculateCartAuthoritative(
  input: CartCalculationInput,
  settings: { taxEnabled: boolean; taxRate: number },
  options: { checkStock: boolean } = { checkStock: true }
): ResolvedCartCalculation {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ServiceError(400, 'Keranjang belanja masih kosong.');
  }

  const allProducts = queryEnrichedProducts();
  const productMap = new Map(allProducts.map((p) => [p.id, p]));

  // Merge duplicate lines only when price/discount settings match; otherwise preserve distinct lines,
  // while still validating aggregate stock per productId!
  const aggregateQtyByProduct = new Map<string, number>();

  interface NormalizedLine {
    productId: string;
    sku: string;
    barcode: string;
    name: string;
    unit: string;
    qty: number;
    originalSellPrice: number;
    unitPrice: number;
    priceOverride: boolean;
    costPrice: number;
    lineGrossSubtotal: bigint;
    lineDiscountType: DiscountMode;
    lineDiscountValue: number;
    lineDiscountAmount: bigint;
    lineNetAfterDiscount: bigint;
    taxCategory: TaxCategory;
  }

  const normalizedLines: NormalizedLine[] = [];

  for (const raw of input.items) {
    if (!raw || typeof raw !== 'object') {
      throw new ServiceError(400, 'Format item keranjang tidak valid.');
    }
    const line = raw as CartLineInput;
    const productId = typeof line.productId === 'string' ? line.productId : '';
    if (!productId) {
      throw new ServiceError(400, 'ID produk pada item keranjang tidak valid.');
    }
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new ServiceError(400, `Jumlah item harus berupa bilangan bulat minimal 1.`);
    }

    const product = productMap.get(productId);
    if (!product) {
      throw new ServiceError(404, 'Salah satu produk di keranjang tidak ditemukan.');
    }
    if (product.status === 'INACTIVE') {
      throw new ServiceError(
        409,
        `Produk "${product.name}" berstatus nonaktif dan tidak dapat dijual.`
      );
    }

    const nextAggQty = (aggregateQtyByProduct.get(productId) ?? 0) + qty;
    aggregateQtyByProduct.set(productId, nextAggQty);
    if (options.checkStock && product.stock < nextAggQty) {
      throw new ServiceError(
        409,
        `Stok "${product.name}" tidak mencukupi (tersedia ${product.stock} ${product.unit}).`
      );
    }

    const catalogPrice =
      product.specialPrice !== null && product.specialPrice > 0
        ? product.specialPrice
        : product.sellPrice;

    let unitPrice = catalogPrice;
    let priceOverride = false;
    if (
      line.overrideUnitPrice !== undefined &&
      line.overrideUnitPrice !== null &&
      String(line.overrideUnitPrice).trim() !== ''
    ) {
      const overrideVal = Number(roundHalfUpDiv(parseDecimalToScaledInt(line.overrideUnitPrice, 0), 1n));
      if (!Number.isFinite(overrideVal) || overrideVal < 0) {
        throw new ServiceError(400, `Harga override untuk "${product.name}" tidak valid.`);
      }
      if (overrideVal !== catalogPrice) {
        unitPrice = overrideVal;
        priceOverride = true;
      }
    }

    const lineGross = BigInt(unitPrice) * BigInt(qty);
    const ldType: DiscountMode = line.lineDiscountType === 'PERCENT' ? 'PERCENT' : 'AMOUNT';
    let ldCalc: { amount: bigint; normalizedValue: number };
    try {
      ldCalc = calculateExactDiscount(lineGross, ldType, line.lineDiscountValue ?? 0);
    } catch (err) {
      throw new ServiceError(400, err instanceof Error ? err.message : 'Diskon item tidak valid.');
    }

    const lineNet = lineGross - ldCalc.amount;

    normalizedLines.push({
      productId: product.id,
      sku: product.sku,
      barcode: product.barcode,
      name: product.name,
      unit: product.unit,
      qty,
      originalSellPrice: catalogPrice,
      unitPrice,
      priceOverride,
      costPrice: product.costPrice,
      lineGrossSubtotal: lineGross,
      lineDiscountType: ldType,
      lineDiscountValue: ldCalc.normalizedValue,
      lineDiscountAmount: ldCalc.amount,
      lineNetAfterDiscount: lineNet,
      taxCategory: product.taxCategory,
    });
  }

  const subtotalBig = normalizedLines.reduce((acc, l) => acc + l.lineGrossSubtotal, 0n);
  const lineDiscountTotalBig = normalizedLines.reduce((acc, l) => acc + l.lineDiscountAmount, 0n);
  const netAfterLineDiscountsBig = subtotalBig - lineDiscountTotalBig;

  const txDiscType: DiscountMode =
    input.transactionDiscountType === 'PERCENT' ? 'PERCENT' : 'AMOUNT';
  const rawTxDiscVal =
    input.transactionDiscountValue !== undefined
      ? input.transactionDiscountValue
      : input.discountAmount ?? 0;

  let txDiscCalc: { amount: bigint; normalizedValue: number };
  try {
    txDiscCalc = calculateExactDiscount(netAfterLineDiscountsBig, txDiscType, rawTxDiscVal);
  } catch (err) {
    throw new ServiceError(400, err instanceof Error ? err.message : 'Diskon transaksi tidak valid.');
  }

  // Proportionally allocate transaction discount across lines using exact BigInt allocation
  const lineTxDiscountShares = allocateProportionally(
    txDiscCalc.amount,
    normalizedLines.map((l) => l.lineNetAfterDiscount)
  );

  const shouldApplyTax =
    typeof input.applyTax === 'boolean' ? input.applyTax : settings.taxEnabled;
  const standardTaxBps = parseDecimalToScaledInt(settings.taxRate, 2); // e.g., 11 -> 1100n bps

  let taxAmountBig = 0n;
  const itemsWithCost = normalizedLines.map((l, idx) => {
    const lineTaxable = l.lineNetAfterDiscount - lineTxDiscountShares[idx];
    let lineTaxBig = 0n;
    if (shouldApplyTax && lineTaxable > 0n && standardTaxBps > 0n) {
      const effectiveBps =
        l.taxCategory === 'EXEMPT'
          ? 0n
          : l.taxCategory === 'REDUCED'
          ? roundHalfUpDiv(standardTaxBps, 2n)
          : standardTaxBps;
      if (effectiveBps > 0n) {
        lineTaxBig = roundHalfUpDiv(lineTaxable * effectiveBps, 10000n);
      }
    }
    taxAmountBig += lineTaxBig;

    return {
      productId: l.productId,
      sku: l.sku,
      barcode: l.barcode,
      name: l.name,
      unit: l.unit,
      qty: l.qty,
      originalSellPrice: l.originalSellPrice,
      unitPrice: l.unitPrice,
      priceOverride: l.priceOverride,
      lineGrossSubtotal: Number(l.lineGrossSubtotal),
      lineDiscountType: l.lineDiscountType,
      lineDiscountValue: l.lineDiscountValue,
      lineDiscountAmount: Number(l.lineDiscountAmount),
      lineNetAfterDiscount: Number(l.lineNetAfterDiscount),
      lineTaxAmount: Number(lineTaxBig),
      taxCategory: l.taxCategory,
      costPrice: l.costPrice,
      lineCostTotal: l.costPrice * l.qty,
    };
  });

  const taxableAmountBig = netAfterLineDiscountsBig - txDiscCalc.amount;
  const grandTotalBig = taxableAmountBig + taxAmountBig;
  const totalCost = itemsWithCost.reduce((s, i) => s + i.lineCostTotal, 0);
  const grossProfit = Number(taxableAmountBig) - totalCost;
  const totalDiscountBig = lineDiscountTotalBig + txDiscCalc.amount;

  return {
    preview: {
      items: itemsWithCost.map(({ costPrice: _c, lineCostTotal: _lc, ...p }) => p),
      subtotal: Number(subtotalBig),
      lineDiscountTotal: Number(lineDiscountTotalBig),
      netAfterLineDiscounts: Number(netAfterLineDiscountsBig),
      transactionDiscountType: txDiscType,
      transactionDiscountValue: txDiscCalc.normalizedValue,
      transactionDiscountAmount: Number(txDiscCalc.amount),
      totalDiscount: Number(totalDiscountBig),
      taxableAmount: Number(taxableAmountBig),
      taxAmount: Number(taxAmountBig),
      grandTotal: Number(grandTotalBig),
      requiresDiscountApproval: totalDiscountBig > 0n,
      requiresPriceOverrideApproval: itemsWithCost.some((i) => i.priceOverride),
    },
    totalCost,
    grossProfit,
    itemsWithCost,
  };
}

// --- Hold / Resume / Cancel Workflow ---
export interface HoldTransactionInput extends CartCalculationInput {
  heldTransactionId?: unknown;
  customerId?: unknown;
  notes?: unknown;
}

export function holdTransaction(
  input: HoldTransactionInput,
  actor: UserSummary
): Transaction {
  const db = getDb();
  const settingsRow = db
    .prepare('SELECT tax_enabled, tax_rate FROM store_settings WHERE id = 1')
    .get() as { tax_enabled: number; tax_rate: number };
  const settings = { taxEnabled: settingsRow.tax_enabled === 1, taxRate: settingsRow.tax_rate };

  const calc = calculateCartAuthoritative(input, settings, { checkStock: true });
  const nowIso = new Date().toISOString();

  let customerId: string | null = null;
  let customerName = 'Pelanggan Umum';
  if (typeof input.customerId === 'string' && input.customerId.trim()) {
    const cust = db
      .prepare('SELECT id, name FROM customers WHERE id = ?')
      .get(input.customerId.trim()) as { id: string; name: string } | undefined;
    if (!cust) {
      throw new ServiceError(404, 'Pelanggan yang dipilih tidak ditemukan.');
    }
    customerId = cust.id;
    customerName = cust.name;
  }

  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  const shouldApplyTax =
    typeof input.applyTax === 'boolean' ? input.applyTax : settings.taxEnabled;

  const existingHoldId =
    typeof input.heldTransactionId === 'string' && input.heldTransactionId.trim()
      ? input.heldTransactionId.trim()
      : null;

  db.exec('BEGIN IMMEDIATE;');
  try {
    let trxId: string;
    let holdNumber: string;

    if (existingHoldId) {
      const existing = db
        .prepare('SELECT id, invoice_number, status FROM transactions WHERE id = ?')
        .get(existingHoldId) as { id: string; invoice_number: string; status: TransactionStatus } | undefined;
      if (!existing || (existing.status !== 'HELD' && existing.status !== 'IN_PROGRESS')) {
        throw new ServiceError(404, 'Transaksi yang ditahan tidak ditemukan atau sudah diproses.');
      }
      trxId = existing.id;
      holdNumber = existing.invoice_number;

      db.prepare(`
        UPDATE transactions
        SET status = 'HELD', payment_status = 'UNPAID',
            customer_id = ?, customer_name = ?,
            subtotal = ?, line_discount_total = ?,
            transaction_discount_type = ?, transaction_discount_value = ?, transaction_discount_amount = ?,
            discount_amount = ?, apply_tax = ?, tax_amount = ?, total = ?,
            total_cost = ?, gross_profit = ?, notes = ?,
            cashier_id = ?, cashier_name = ?, held_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        customerId,
        customerName,
        calc.preview.subtotal,
        calc.preview.lineDiscountTotal,
        calc.preview.transactionDiscountType,
        calc.preview.transactionDiscountValue,
        calc.preview.transactionDiscountAmount,
        calc.preview.totalDiscount,
        shouldApplyTax ? 1 : 0,
        calc.preview.taxAmount,
        calc.preview.grandTotal,
        calc.totalCost,
        calc.grossProfit,
        notes,
        actor.id,
        actor.fullName,
        nowIso,
        nowIso,
        trxId
      );
      db.prepare('DELETE FROM transaction_items WHERE transaction_id = ?').run(trxId);
    } else {
      trxId = `trx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      holdNumber = nextDocumentNumber(db, 'HOLD');

      db.prepare(`
        INSERT INTO transactions (
          id, invoice_number, status, payment_status, customer_id, customer_name,
          subtotal, line_discount_total, transaction_discount_type, transaction_discount_value,
          transaction_discount_amount, discount_amount, apply_tax, tax_amount, total,
          cash_received, change_amount, payment_method, total_cost, gross_profit,
          notes, idempotency_key, cashier_id, cashier_name,
          held_at, cancelled_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, 'HELD', 'UNPAID', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'Belum Bayar', ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)
      `).run(
        trxId,
        holdNumber,
        customerId,
        customerName,
        calc.preview.subtotal,
        calc.preview.lineDiscountTotal,
        calc.preview.transactionDiscountType,
        calc.preview.transactionDiscountValue,
        calc.preview.transactionDiscountAmount,
        calc.preview.totalDiscount,
        shouldApplyTax ? 1 : 0,
        calc.preview.taxAmount,
        calc.preview.grandTotal,
        calc.totalCost,
        calc.grossProfit,
        notes,
        actor.id,
        actor.fullName,
        nowIso,
        nowIso,
        nowIso
      );
    }

    const insertItem = db.prepare(`
      INSERT INTO transaction_items (
        id, transaction_id, product_id, sku, barcode, name, unit, qty,
        original_sell_price, sell_price, price_override, cost_price,
        line_discount_type, line_discount_value, line_discount_amount,
        tax_category, tax_amount, subtotal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    calc.itemsWithCost.forEach((item, idx) => {
      insertItem.run(
        `${trxId}-itm-${idx}`,
        trxId,
        item.productId,
        item.sku,
        item.barcode,
        item.name,
        item.unit,
        item.qty,
        item.originalSellPrice,
        item.unitPrice,
        item.priceOverride ? 1 : 0,
        item.costPrice,
        item.lineDiscountType,
        item.lineDiscountValue,
        item.lineDiscountAmount,
        item.taxCategory,
        item.lineTaxAmount,
        item.lineNetAfterDiscount
      );
    });

    recordAuditLog(db, {
      action: 'TRANSACTION_HELD',
      entityType: 'transaction',
      entityId: holdNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Tahan transaksi ${holdNumber} (${calc.itemsWithCost.length} baris, Rp ${calc.preview.grandTotal.toLocaleString('id-ID')})`,
    });

    db.exec('COMMIT;');
    return getTransactionById(trxId);
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

export function resumeHeldTransaction(id: string, actor: UserSummary): Transaction {
  const db = getDb();
  const current = getTransactionById(id);
  if (current.status !== 'HELD' && current.status !== 'IN_PROGRESS') {
    throw new ServiceError(409, `Transaksi berstatus "${current.status}" tidak dapat dilanjutkan.`);
  }
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE transactions
      SET status = 'IN_PROGRESS', updated_at = ?
      WHERE id = ?
    `).run(nowIso, current.id);

    recordAuditLog(db, {
      action: 'TRANSACTION_RESUMED',
      entityType: 'transaction',
      entityId: current.invoiceNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Lanjutkan transaksi ${current.invoiceNumber} ke keranjang kasir`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getTransactionById(current.id);
}

export function cancelTransaction(
  id: string,
  reason: string | undefined,
  actor: UserSummary
): Transaction {
  const db = getDb();
  const current = getTransactionById(id);
  if (current.status === 'COMPLETED') {
    throw new ServiceError(
      409,
      'Transaksi yang sudah selesai (COMPLETED) tidak dapat dibatalkan atau dihapus.'
    );
  }
  if (current.status === 'CANCELLED') {
    return current;
  }

  const nowIso = new Date().toISOString();
  const noteSuffix = reason && reason.trim() ? `Dibatalkan: ${reason.trim()}` : current.notes;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE transactions
      SET status = 'CANCELLED', payment_status = 'CANCELLED',
          notes = ?, cancelled_at = ?, updated_at = ?
      WHERE id = ?
    `).run(noteSuffix, nowIso, nowIso, current.id);

    recordAuditLog(db, {
      action: 'TRANSACTION_CANCELLED',
      entityType: 'transaction',
      entityId: current.invoiceNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Batalkan transaksi ${current.invoiceNumber}${reason ? ` (${reason})` : ''}`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getTransactionById(current.id);
}

// --- Full 14-Step Transactional Checkout with Idempotency & Multi-Payment ---
export interface PaymentLineInput {
  paymentMethodId?: unknown;
  paymentMethodName?: unknown;
  paymentType?: unknown;
  amount?: unknown;
  tenderedAmount?: unknown;
  referenceNumber?: unknown;
}

export interface CheckoutInput extends CartCalculationInput {
  heldTransactionId?: unknown;
  customerId?: unknown;
  notes?: unknown;
  paymentMethod?: unknown; // single payment method name (legacy + quick)
  cashReceived?: unknown;
  paymentReference?: unknown;
  payments?: unknown; // multiple / split payments
  cashierName?: unknown;
  idempotencyKey?: unknown;
  pinApprovalToken?: unknown;
  discountPinToken?: unknown;
  priceOverridePinToken?: unknown;
}

export function executeTransactionalCheckout(
  input: CheckoutInput,
  actor?: UserSummary
): {
  transaction: Transaction;
  idempotentReplay: boolean;
} {
  const db = getDb();

  // 0. Idempotency check BEFORE executing business logic
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
      ? input.idempotencyKey.trim().slice(0, 128)
      : null;

  if (idempotencyKey) {
    const existingIdem = db
      .prepare('SELECT id FROM transactions WHERE idempotency_key = ?')
      .get(idempotencyKey) as { id: string } | undefined;
    if (existingIdem) {
      return {
        transaction: getTransactionById(existingIdem.id),
        idempotentReplay: true,
      };
    }
  }

  // 1-6. Validate products, prices, discounts, stock rules, and compute exact totals
  const settingsRow = db
    .prepare('SELECT tax_enabled, tax_rate, cashier_name FROM store_settings WHERE id = 1')
    .get() as { tax_enabled: number; tax_rate: number; cashier_name: string };
  const settings = {
    taxEnabled: settingsRow.tax_enabled === 1,
    taxRate: settingsRow.tax_rate,
    cashierName: settingsRow.cashier_name,
  };

  const calc = calculateCartAuthoritative(input, settings, { checkStock: true });

  // Authorization checks (Discounts & Price Overrides)
  const canApproveDiscount = !actor || actor.permissions.includes('pos:discount_approve');
  const discountPin =
    typeof input.discountPinToken === 'string' && input.discountPinToken.trim()
      ? input.discountPinToken.trim()
      : typeof input.pinApprovalToken === 'string'
      ? input.pinApprovalToken.trim()
      : '';

  if (calc.preview.requiresDiscountApproval && !canApproveDiscount && !discountPin) {
    throw new ServiceError(
      403,
      'Pemberian diskon manual memerlukan otorisasi PIN Supervisor atau Admin.',
      'PIN_REQUIRED'
    );
  }

  const canOverridePrice = !actor || actor.permissions.includes('pos:price_override');
  const pricePin =
    typeof input.priceOverridePinToken === 'string' && input.priceOverridePinToken.trim()
      ? input.priceOverridePinToken.trim()
      : '';

  if (calc.preview.requiresPriceOverrideApproval && !canOverridePrice && !pricePin) {
    throw new ServiceError(
      403,
      'Perubahan harga jual (price override) memerlukan otorisasi PIN Supervisor atau Admin.',
      'PRICE_OVERRIDE_PIN_REQUIRED'
    );
  }

  // Customer validation
  let customerId: string | null = null;
  let customerName = 'Pelanggan Umum';
  if (typeof input.customerId === 'string' && input.customerId.trim()) {
    const cust = db
      .prepare('SELECT id, name FROM customers WHERE id = ?')
      .get(input.customerId.trim()) as { id: string; name: string } | undefined;
    if (!cust) {
      throw new ServiceError(404, 'Pelanggan yang dipilih tidak ditemukan.');
    }
    customerId = cust.id;
    customerName = cust.name;
  }

  // 7. Validate payment(s)
  const activePaymentMethods = listPaymentMethods(false);
  const grandTotal = calc.preview.grandTotal;
  const resolvedPayments: Array<{
    paymentMethodId: string | null;
    paymentMethodName: string;
    paymentType: PaymentMethodType;
    amount: number;
    tenderedAmount: number;
    changeAmount: number;
    referenceNumber: string;
  }> = [];

  if (Array.isArray(input.payments) && input.payments.length > 0) {
    let sumTendered = 0;
    let sumApplied = 0;
    let totalChange = 0;

    for (const rawPay of input.payments) {
      if (!rawPay || typeof rawPay !== 'object') {
        throw new ServiceError(400, 'Format baris pembayaran tidak valid.');
      }
      const p = rawPay as PaymentLineInput;
      const pmConfig = activePaymentMethods.find(
        (m) =>
          (typeof p.paymentMethodId === 'string' && m.id === p.paymentMethodId) ||
          (typeof p.paymentMethodName === 'string' &&
            m.name.toLowerCase() === p.paymentMethodName.trim().toLowerCase())
      );

      const methodName =
        pmConfig?.name ??
        (typeof p.paymentMethodName === 'string' && p.paymentMethodName.trim()
          ? p.paymentMethodName.trim()
          : '');
      if (!methodName) {
        throw new ServiceError(400, 'Metode pembayaran wajib dipilih.');
      }

      const methodType: PaymentMethodType =
        pmConfig?.type ??
        (typeof p.paymentType === 'string' &&
        VALID_PAYMENT_TYPES.has(p.paymentType as PaymentMethodType)
          ? (p.paymentType as PaymentMethodType)
          : 'OTHER');

      const amountNum = Number(roundHalfUpDiv(parseDecimalToScaledInt(p.amount ?? 0, 0), 1n));
      const tenderedNum =
        p.tenderedAmount !== undefined
          ? Number(roundHalfUpDiv(parseDecimalToScaledInt(p.tenderedAmount, 0), 1n))
          : amountNum;

      if (!Number.isFinite(amountNum) || amountNum < 0 || !Number.isFinite(tenderedNum) || tenderedNum < 0) {
        throw new ServiceError(400, 'Nominal pembayaran tidak valid.');
      }
      if (amountNum === 0 && grandTotal > 0) {
        throw new ServiceError(400, `Nominal untuk metode "${methodName}" harus lebih dari 0.`);
      }

      const refNum = typeof p.referenceNumber === 'string' ? p.referenceNumber.trim() : '';
      if (pmConfig?.requiresReference && !refNum && methodType !== 'CASH' && input.payments.length > 1) {
        throw new ServiceError(400, `Nomor referensi wajib diisi untuk ${methodName}.`);
      }

      const lineChange = methodType === 'CASH' ? Math.max(0, tenderedNum - amountNum) : 0;
      if (methodType !== 'CASH' && tenderedNum !== amountNum) {
        throw new ServiceError(
          400,
          `Pembayaran non-tunai (${methodName}) harus sesuai nominal tagihan tanpa kembalian.`
        );
      }
      if (methodType === 'CASH' && tenderedNum < amountNum) {
        throw new ServiceError(400, 'Uang tunai yang diterima kurang dari porsi pembayaran.');
      }

      sumApplied += amountNum;
      sumTendered += tenderedNum;
      totalChange += lineChange;

      resolvedPayments.push({
        paymentMethodId: pmConfig?.id ?? null,
        paymentMethodName: methodName,
        paymentType: methodType,
        amount: amountNum,
        tenderedAmount: tenderedNum,
        changeAmount: lineChange,
        referenceNumber: refNum,
      });
    }

    if (sumApplied < grandTotal) {
      throw new ServiceError(
        400,
        `Total pembayaran (Rp ${sumApplied.toLocaleString('id-ID')}) masih kurang dari total tagihan (Rp ${grandTotal.toLocaleString('id-ID')}).`
      );
    }
    if (sumApplied > grandTotal) {
      throw new ServiceError(
        400,
        `Alokasi total pembayaran (Rp ${sumApplied.toLocaleString('id-ID')}) melebihi tagihan (Rp ${grandTotal.toLocaleString('id-ID')}).`
      );
    }
    void sumTendered;
    void totalChange;
  } else {
    // Single payment mode (supports Tunai, QRIS, Kartu Debit, Kartu Kredit, custom)
    const rawMethod = typeof input.paymentMethod === 'string' ? input.paymentMethod.trim() : '';
    const pmConfig = activePaymentMethods.find(
      (m) =>
        m.name.toLowerCase() === rawMethod.toLowerCase() ||
        m.code.toLowerCase() === rawMethod.toLowerCase()
    );
    if (!pmConfig) {
      throw new ServiceError(400, 'Metode pembayaran tidak valid atau tidak aktif.');
    }

    const refNum =
      typeof input.paymentReference === 'string' ? input.paymentReference.trim() : '';

    if (pmConfig.type === 'CASH') {
      const cashVal = Number(
        roundHalfUpDiv(parseDecimalToScaledInt(input.cashReceived ?? 0, 0), 1n)
      );
      if (!Number.isFinite(cashVal) || cashVal < 0) {
        throw new ServiceError(400, 'Nominal uang tunai tidak valid.');
      }
      if (cashVal < grandTotal) {
        throw new ServiceError(400, 'Uang tunai yang diterima kurang dari total pembayaran.');
      }
      resolvedPayments.push({
        paymentMethodId: pmConfig.id,
        paymentMethodName: pmConfig.name,
        paymentType: pmConfig.type,
        amount: grandTotal,
        tenderedAmount: cashVal,
        changeAmount: cashVal - grandTotal,
        referenceNumber: refNum,
      });
    } else {
      resolvedPayments.push({
        paymentMethodId: pmConfig.id,
        paymentMethodName: pmConfig.name,
        paymentType: pmConfig.type,
        amount: grandTotal,
        tenderedAmount: grandTotal,
        changeAmount: 0,
        referenceNumber: refNum,
      });
    }
  }

  const totalCashTendered = resolvedPayments.reduce((s, p) => s + p.tenderedAmount, 0);
  const totalChangeAmount = resolvedPayments.reduce((s, p) => s + p.changeAmount, 0);
  const summaryPaymentMethod =
    resolvedPayments.length === 1
      ? resolvedPayments[0].paymentMethodName
      : resolvedPayments.map((p) => p.paymentMethodName).join(' + ');

  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  const shouldApplyTax =
    typeof input.applyTax === 'boolean' ? input.applyTax : settings.taxEnabled;
  const cashierName =
    actor?.fullName ||
    (typeof input.cashierName === 'string' && input.cashierName.trim()
      ? input.cashierName.trim()
      : settings.cashierName || 'Kasir Utama');
  const nowIso = new Date().toISOString();

  const heldId =
    typeof input.heldTransactionId === 'string' && input.heldTransactionId.trim()
      ? input.heldTransactionId.trim()
      : null;

  // 8-14. Execute atomic DB transaction
  db.exec('BEGIN IMMEDIATE;');
  try {
    if (calc.preview.requiresDiscountApproval && !canApproveDiscount && discountPin) {
      consumePinApprovalToken(db, discountPin, 'discount_approval');
    }
    if (calc.preview.requiresPriceOverrideApproval && !canOverridePrice && pricePin) {
      consumePinApprovalToken(db, pricePin, 'price_override');
    }

    const invoiceNumber = nextDocumentNumber(db, 'TRX');
    let trxId: string;

    if (heldId) {
      const existing = db
        .prepare('SELECT id, status FROM transactions WHERE id = ?')
        .get(heldId) as { id: string; status: TransactionStatus } | undefined;
      if (!existing || (existing.status !== 'HELD' && existing.status !== 'IN_PROGRESS')) {
        throw new ServiceError(409, 'Draft / Hold transaksi sudah tidak aktif untuk diselesaikan.');
      }
      trxId = existing.id;

      db.prepare(`
        UPDATE transactions
        SET invoice_number = ?, status = 'COMPLETED', payment_status = 'PAID',
            customer_id = ?, customer_name = ?,
            subtotal = ?, line_discount_total = ?,
            transaction_discount_type = ?, transaction_discount_value = ?, transaction_discount_amount = ?,
            discount_amount = ?, apply_tax = ?, tax_amount = ?, total = ?,
            cash_received = ?, change_amount = ?, payment_method = ?,
            total_cost = ?, gross_profit = ?, notes = ?, idempotency_key = ?,
            cashier_id = ?, cashier_name = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        invoiceNumber,
        customerId,
        customerName,
        calc.preview.subtotal,
        calc.preview.lineDiscountTotal,
        calc.preview.transactionDiscountType,
        calc.preview.transactionDiscountValue,
        calc.preview.transactionDiscountAmount,
        calc.preview.totalDiscount,
        shouldApplyTax ? 1 : 0,
        calc.preview.taxAmount,
        calc.preview.grandTotal,
        totalCashTendered,
        totalChangeAmount,
        summaryPaymentMethod,
        calc.totalCost,
        calc.grossProfit,
        notes,
        idempotencyKey,
        actor?.id ?? null,
        cashierName,
        nowIso,
        nowIso,
        trxId
      );
      db.prepare('DELETE FROM transaction_items WHERE transaction_id = ?').run(trxId);
      db.prepare('DELETE FROM transaction_payments WHERE transaction_id = ?').run(trxId);
    } else {
      trxId = `trx-${Date.now()}-${randomUUID().slice(0, 6)}`;
      db.prepare(`
        INSERT INTO transactions (
          id, invoice_number, status, payment_status, customer_id, customer_name,
          subtotal, line_discount_total, transaction_discount_type, transaction_discount_value,
          transaction_discount_amount, discount_amount, apply_tax, tax_amount, total,
          cash_received, change_amount, payment_method, total_cost, gross_profit,
          notes, idempotency_key, cashier_id, cashier_name,
          held_at, cancelled_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, 'COMPLETED', 'PAID', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
      `).run(
        trxId,
        invoiceNumber,
        customerId,
        customerName,
        calc.preview.subtotal,
        calc.preview.lineDiscountTotal,
        calc.preview.transactionDiscountType,
        calc.preview.transactionDiscountValue,
        calc.preview.transactionDiscountAmount,
        calc.preview.totalDiscount,
        shouldApplyTax ? 1 : 0,
        calc.preview.taxAmount,
        calc.preview.grandTotal,
        totalCashTendered,
        totalChangeAmount,
        summaryPaymentMethod,
        calc.totalCost,
        calc.grossProfit,
        notes,
        idempotencyKey,
        actor?.id ?? null,
        cashierName,
        nowIso,
        nowIso,
        nowIso
      );
    }

    const insertItem = db.prepare(`
      INSERT INTO transaction_items (
        id, transaction_id, product_id, sku, barcode, name, unit, qty,
        original_sell_price, sell_price, price_override, cost_price,
        line_discount_type, line_discount_value, line_discount_amount,
        tax_category, tax_amount, subtotal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const selectStockStmt = db.prepare('SELECT stock FROM products WHERE id = ?');
    const updateStockStmt = db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?');
    const insertMovStmt = db.prepare(`
      INSERT INTO stock_movements (
        id, product_id, product_name, barcode, type, qty_delta, stock_before, stock_after, reference_id, notes, created_at
      ) VALUES (?, ?, ?, ?, 'PENJUALAN', ?, ?, ?, ?, ?, ?)
    `);

    calc.itemsWithCost.forEach((item, idx) => {
      insertItem.run(
        `${trxId}-itm-${idx}`,
        trxId,
        item.productId,
        item.sku,
        item.barcode,
        item.name,
        item.unit,
        item.qty,
        item.originalSellPrice,
        item.unitPrice,
        item.priceOverride ? 1 : 0,
        item.costPrice,
        item.lineDiscountType,
        item.lineDiscountValue,
        item.lineDiscountAmount,
        item.taxCategory,
        item.lineTaxAmount,
        item.lineNetAfterDiscount
      );

      const stockRow = selectStockStmt.get(item.productId) as { stock: number } | undefined;
      if (!stockRow || stockRow.stock < item.qty) {
        throw new ServiceError(
          409,
          `Stok "${item.name}" berubah dan tidak mencukupi (tersedia ${stockRow?.stock ?? 0} ${item.unit}).`
        );
      }
      const stockBefore = stockRow.stock;
      const stockAfter = stockBefore - item.qty;
      updateStockStmt.run(stockAfter, nowIso, item.productId);
      insertMovStmt.run(
        `mov-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        item.productId,
        item.name,
        item.barcode,
        -item.qty,
        stockBefore,
        stockAfter,
        invoiceNumber,
        `Penjualan ${summaryPaymentMethod} (${item.qty} ${item.unit})`,
        nowIso
      );
    });

    const insertPayment = db.prepare(`
      INSERT INTO transaction_payments (
        id, transaction_id, payment_method_id, payment_method_name, payment_type,
        amount, tendered_amount, change_amount, reference_number, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    resolvedPayments.forEach((pay, idx) => {
      insertPayment.run(
        `${trxId}-pay-${idx}`,
        trxId,
        pay.paymentMethodId,
        pay.paymentMethodName,
        pay.paymentType,
        pay.amount,
        pay.tenderedAmount,
        pay.changeAmount,
        pay.referenceNumber,
        nowIso
      );
    });

    captureReceiptSnapshotTx(db, trxId, invoiceNumber, nowIso);

    recordAuditLog(db, {
      action: 'TRANSACTION_COMPLETED',
      entityType: 'transaction',
      entityId: invoiceNumber,
      actorUserId: actor?.id ?? null,
      actor: cashierName,
      summary: `Transaksi ${invoiceNumber} (${summaryPaymentMethod}) senilai Rp ${calc.preview.grandTotal.toLocaleString('id-ID')} · ${calc.itemsWithCost.length} baris`,
    });

    db.exec('COMMIT;');
    return {
      transaction: getTransactionById(trxId),
      idempotentReplay: false,
    };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}
