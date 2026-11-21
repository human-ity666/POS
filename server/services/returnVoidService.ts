import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.ts';
import { allocateProportionally, roundHalfUpDiv } from '../utils/money.ts';
import { recordAuditLog } from './auditService.ts';
import { consumePinApprovalToken } from './authService.ts';
import { getTransactionById } from './checkoutService.ts';
import { ServiceError } from './errors.ts';
import { computeShiftReconciliationTx } from './shiftService.ts';
import type {
  ReceiptSnapshot,
  RefundPaymentType,
  RefundRecord,
  RefundRecordStatus,
  ReturnCalculationPreview,
  ReturnDispositionFinal,
  ReturnEligibilityDetail,
  ReturnEligibleItemInfo,
  ReturnRecordStatus,
  ReturnStockDisposition,
  ReturnVoidSummaryStats,
  Transaction,
  TransactionReturn,
  TransactionReturnItem,
  TransactionStatus,
  TransactionVoidRecord,
  UserSummary,
} from '../../src/types.ts';

const VALID_DISPOSITIONS: ReadonlySet<ReturnStockDisposition> = new Set([
  'SELLABLE',
  'DAMAGED',
  'UNSELLABLE',
  'PENDING_INSPECTION',
]);

const VALID_FINAL_DISPOSITIONS: ReadonlySet<ReturnDispositionFinal> = new Set([
  'SELLABLE',
  'DAMAGED',
  'UNSELLABLE',
]);

const VALID_REFUND_PAYMENT_TYPES: ReadonlySet<RefundPaymentType> = new Set([
  'CASH',
  'DEBIT',
  'CREDIT',
  'QRIS',
  'TRANSFER',
  'OTHER',
]);

const VALID_REFUND_STATUSES: ReadonlySet<RefundRecordStatus> = new Set([
  'COMPLETED',
  'PENDING',
  'MANUAL_RECORDED',
  'FAILED',
]);

function nextReturnVoidDocNumber(
  db: DatabaseSync,
  prefix: 'RET' | 'VOD' | 'REF' | 'CM',
  tableName: 'transaction_returns' | 'transaction_voids' | 'refund_records' | 'cash_movements',
  columnName: 'return_number' | 'void_number' | 'refund_number' | 'movement_number'
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
  const row = db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId) as
    | { full_name: string }
    | undefined;
  return row?.full_name || 'Supervisor/Admin';
}

function resolveTransactionIdByIdentifier(db: DatabaseSync, identifier: string): string {
  const clean = identifier.trim();
  if (!clean) {
    throw new ServiceError(400, 'ID atau nomor struk transaksi wajib disertakan.');
  }

  const direct = db
    .prepare('SELECT id FROM transactions WHERE id = ? OR invoice_number = ? LIMIT 1')
    .get(clean, clean) as { id: string } | undefined;
  if (direct) return direct.id;

  const snap = db
    .prepare('SELECT transaction_id FROM receipt_snapshots WHERE receipt_number = ? LIMIT 1')
    .get(clean) as { transaction_id: string } | undefined;
  if (snap) return snap.transaction_id;

  throw new ServiceError(404, `Transaksi atau struk "${clean}" tidak ditemukan.`);
}

function inferRefundPaymentType(rawType: unknown, rawMethodName: string): RefundPaymentType {
  if (typeof rawType === 'string' && VALID_REFUND_PAYMENT_TYPES.has(rawType.trim().toUpperCase() as RefundPaymentType)) {
    return rawType.trim().toUpperCase() as RefundPaymentType;
  }
  const lower = rawMethodName.toLowerCase();
  if (lower.includes('tunai') || lower.includes('cash')) return 'CASH';
  if (lower.includes('debit')) return 'DEBIT';
  if (lower.includes('kredit') || lower.includes('credit')) return 'CREDIT';
  if (lower.includes('qris')) return 'QRIS';
  if (lower.includes('transfer') || lower.includes('bank')) return 'TRANSFER';
  return 'OTHER';
}

function resolveOpenShiftForCashRefund(
  db: DatabaseSync,
  requestedShiftId: unknown,
  actorUserId: string,
  trxShiftId: string | null
): { id: string; shift_number: string; opening_cash: number; actual_cash: number | null } | null {
  if (typeof requestedShiftId === 'string' && requestedShiftId.trim()) {
    const row = db
      .prepare('SELECT id, shift_number, status, opening_cash, actual_cash FROM cashier_shifts WHERE id = ?')
      .get(requestedShiftId.trim()) as
      | { id: string; shift_number: string; status: string; opening_cash: number; actual_cash: number | null }
      | undefined;
    if (!row) {
      throw new ServiceError(404, 'Shift kasir yang dipilih tidak ditemukan.');
    }
    if (row.status !== 'OPEN') {
      throw new ServiceError(409, 'Shift kasir yang dipilih sudah ditutup.');
    }
    return row;
  }

  const actorOpen = db
    .prepare(`
      SELECT id, shift_number, opening_cash, actual_cash
      FROM cashier_shifts
      WHERE cashier_user_id = ? AND status = 'OPEN'
      ORDER BY opened_at DESC
      LIMIT 1
    `)
    .get(actorUserId) as
    | { id: string; shift_number: string; opening_cash: number; actual_cash: number | null }
    | undefined;
  if (actorOpen) return actorOpen;

  if (trxShiftId) {
    const trxShift = db
      .prepare(`
        SELECT id, shift_number, opening_cash, actual_cash
        FROM cashier_shifts
        WHERE id = ? AND status = 'OPEN'
      `)
      .get(trxShiftId) as
      | { id: string; shift_number: string; opening_cash: number; actual_cash: number | null }
      | undefined;
    if (trxShift) return trxShift;
  }

  return null;
}

function refreshShiftCachedReconciliationTx(
  db: DatabaseSync,
  shiftId: string,
  nowIso: string
): void {
  const shiftRow = db
    .prepare('SELECT id, opening_cash, actual_cash FROM cashier_shifts WHERE id = ?')
    .get(shiftId) as { id: string; opening_cash: number; actual_cash: number | null } | undefined;
  if (!shiftRow) return;

  const { reconciliation } = computeShiftReconciliationTx(db, shiftRow);
  db.prepare(`
    UPDATE cashier_shifts
    SET cash_sales = ?, cash_received = ?, cash_change_given = ?,
        cash_refunds = ?, cash_in_total = ?, cash_out_total = ?,
        expense_total = ?, non_cash_sales = ?, total_sales = ?,
        transaction_count = ?, expected_cash = ?, updated_at = ?
    WHERE id = ?
  `).run(
    reconciliation.cashSales,
    reconciliation.cashReceived,
    reconciliation.cashChangeGiven,
    reconciliation.cashRefunds,
    reconciliation.cashInTotal,
    reconciliation.cashOutTotal,
    reconciliation.expenseTotal,
    reconciliation.nonCashSales,
    reconciliation.totalSales,
    reconciliation.transactionCount,
    reconciliation.expectedCash,
    nowIso,
    shiftId
  );
}

interface RawReturnItemRow {
  id: string;
  return_id: string;
  transaction_id: string;
  transaction_item_id: string;
  product_id: string;
  sku: string;
  barcode: string;
  product_name: string;
  unit: string;
  qty: number;
  original_qty: number;
  unit_price: number;
  line_refund_amount: number;
  tax_refund_amount: number;
  total_refund_amount: number;
  stock_disposition: ReturnStockDisposition;
  final_disposition: ReturnDispositionFinal | null;
  disposition_resolved_by_user_id: string | null;
  disposition_resolved_by_name: string | null;
  disposition_resolved_at: string | null;
  disposition_notes: string;
  stock_movement_id: string | null;
  created_at: string;
}

interface RawReturnRow {
  id: string;
  return_number: string;
  transaction_id: string;
  invoice_number: string;
  receipt_number: string;
  return_type: 'PARTIAL' | 'FULL';
  status: ReturnRecordStatus;
  reason: string;
  notes: string;
  subtotal_refunded: number;
  discount_adjusted: number;
  tax_refunded: number;
  total_refund_amount: number;
  loyalty_points_reversed: number;
  refund_method: string;
  refund_payment_type: RefundPaymentType;
  refund_reference: string;
  refund_status: RefundRecordStatus;
  cash_movement_id: string | null;
  shift_id: string | null;
  requested_by_user_id: string | null;
  requested_by_name: string;
  approved_by_user_id: string | null;
  approved_by_name: string;
  created_at: string;
  updated_at: string;
}

function mapReturnItemRow(r: RawReturnItemRow): TransactionReturnItem {
  return {
    id: r.id,
    returnId: r.return_id,
    transactionId: r.transaction_id,
    transactionItemId: r.transaction_item_id,
    productId: r.product_id,
    sku: r.sku,
    barcode: r.barcode,
    productName: r.product_name,
    unit: r.unit,
    qty: r.qty,
    originalQty: r.original_qty,
    unitPrice: r.unit_price,
    lineRefundAmount: r.line_refund_amount,
    taxRefundAmount: r.tax_refund_amount,
    totalRefundAmount: r.total_refund_amount,
    stockDisposition: r.stock_disposition,
    finalDisposition: r.final_disposition,
    dispositionResolvedByUserId: r.disposition_resolved_by_user_id,
    dispositionResolvedByName: r.disposition_resolved_by_name,
    dispositionResolvedAt: r.disposition_resolved_at,
    dispositionNotes: r.disposition_notes,
    stockMovementId: r.stock_movement_id,
    createdAt: r.created_at,
  };
}

function mapReturnRows(db: DatabaseSync, rows: RawReturnRow[]): TransactionReturn[] {
  if (rows.length === 0) return [];
  const itemStmt = db.prepare(`
    SELECT id, return_id, transaction_id, transaction_item_id, product_id, sku, barcode,
           product_name, unit, qty, original_qty, unit_price,
           line_refund_amount, tax_refund_amount, total_refund_amount,
           stock_disposition, final_disposition,
           disposition_resolved_by_user_id, disposition_resolved_by_name,
           disposition_resolved_at, disposition_notes, stock_movement_id, created_at
    FROM transaction_return_items
    WHERE return_id = ?
    ORDER BY rowid ASC
  `);

  return rows.map((r) => {
    const items = (itemStmt.all(r.id) as unknown as RawReturnItemRow[]).map(mapReturnItemRow);
    return {
      id: r.id,
      returnNumber: r.return_number,
      transactionId: r.transaction_id,
      invoiceNumber: r.invoice_number,
      receiptNumber: r.receipt_number,
      returnType: r.return_type,
      status: r.status,
      reason: r.reason,
      notes: r.notes,
      subtotalRefunded: r.subtotal_refunded,
      discountAdjusted: r.discount_adjusted,
      taxRefunded: r.tax_refunded,
      totalRefundAmount: r.total_refund_amount,
      loyaltyPointsReversed: r.loyalty_points_reversed,
      refundMethod: r.refund_method,
      refundPaymentType: r.refund_payment_type,
      refundReference: r.refund_reference,
      refundStatus: r.refund_status,
      cashMovementId: r.cash_movement_id,
      shiftId: r.shift_id,
      requestedByUserId: r.requested_by_user_id,
      requestedByName: r.requested_by_name,
      approvedByUserId: r.approved_by_user_id,
      approvedByName: r.approved_by_name,
      items,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

function mapVoidRow(r: {
  id: string;
  void_number: string;
  transaction_id: string;
  invoice_number: string;
  receipt_number: string;
  reason: string;
  notes: string;
  voided_total: number;
  refund_method: string;
  refund_payment_type: RefundPaymentType;
  refund_reference: string;
  refund_status: RefundRecordStatus;
  stock_restored_qty: number;
  loyalty_points_reversed: number;
  cash_movement_id: string | null;
  shift_id: string | null;
  requested_by_user_id: string | null;
  requested_by_name: string;
  approved_by_user_id: string | null;
  approved_by_name: string;
  created_at: string;
}): TransactionVoidRecord {
  return {
    id: r.id,
    voidNumber: r.void_number,
    transactionId: r.transaction_id,
    invoiceNumber: r.invoice_number,
    receiptNumber: r.receipt_number,
    reason: r.reason,
    notes: r.notes,
    voidedTotal: r.voided_total,
    refundMethod: r.refund_method,
    refundPaymentType: r.refund_payment_type,
    refundReference: r.refund_reference,
    refundStatus: r.refund_status,
    stockRestoredQty: r.stock_restored_qty,
    loyaltyPointsReversed: r.loyalty_points_reversed,
    cashMovementId: r.cash_movement_id,
    shiftId: r.shift_id,
    requestedByUserId: r.requested_by_user_id,
    requestedByName: r.requested_by_name,
    approvedByUserId: r.approved_by_user_id,
    approvedByName: r.approved_by_name,
    createdAt: r.created_at,
  };
}

function mapRefundRow(r: {
  id: string;
  refund_number: string;
  source_type: 'RETURN' | 'VOID';
  source_id: string;
  source_number: string;
  transaction_id: string;
  invoice_number: string;
  amount: number;
  refund_method: string;
  payment_type: RefundPaymentType;
  reference_number: string;
  status: RefundRecordStatus;
  notes: string;
  cash_movement_id: string | null;
  shift_id: string | null;
  actor_user_id: string | null;
  actor_name: string;
  created_at: string;
  updated_at: string;
}): RefundRecord {
  return {
    id: r.id,
    refundNumber: r.refund_number,
    sourceType: r.source_type,
    sourceId: r.source_id,
    sourceNumber: r.source_number,
    transactionId: r.transaction_id,
    invoiceNumber: r.invoice_number,
    amount: r.amount,
    refundMethod: r.refund_method,
    paymentType: r.payment_type,
    referenceNumber: r.reference_number,
    status: r.status,
    notes: r.notes,
    cashMovementId: r.cash_movement_id,
    shiftId: r.shift_id,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface ComputedItemReturnContext {
  transactionItemId: string;
  productId: string;
  sku: string;
  barcode: string;
  name: string;
  unit: string;
  originalQty: number;
  returnedQty: number;
  remainingQty: number;
  unitPrice: number;
  lineSubtotalPaidBig: bigint;
  lineTaxPaidBig: bigint;
  lineTotalPaidBig: bigint;
  alreadyLineRefundedBig: bigint;
  alreadyTaxRefundedBig: bigint;
  alreadyTotalRefundedBig: bigint;
  remainingLineRefundableBig: bigint;
  remainingTaxRefundableBig: bigint;
  remainingRefundableBig: bigint;
}

function buildReturnContextsForTransaction(
  db: DatabaseSync,
  trx: Transaction
): ComputedItemReturnContext[] {
  const itemRows = db
    .prepare(`
      SELECT id, product_id, sku, barcode, name, unit, qty, sell_price, tax_amount, subtotal,
             promotion_discount_amount
      FROM transaction_items
      WHERE transaction_id = ?
      ORDER BY id ASC
    `)
    .all(trx.id) as Array<{
    id: string;
    product_id: string;
    sku: string;
    barcode: string;
    name: string;
    unit: string;
    qty: number;
    sell_price: number;
    tax_amount: number;
    subtotal: number;
    promotion_discount_amount: number;
  }>;

  if (itemRows.length === 0) return [];

  const itemPromoSum = itemRows.reduce((s, r) => s + Number(r.promotion_discount_amount || 0), 0);
  const trxPromoTotal = Number(trx.promotionDiscountAmount || 0);
  const promoTxDisc = Math.max(0, trxPromoTotal - itemPromoSum);

  let totalTxDeductionBig =
    BigInt(trx.transactionDiscountAmount || 0) +
    BigInt(promoTxDisc) +
    BigInt(trx.loyaltyDiscountAmount || 0);

  // Guard legacy rows where only discount_amount was populated without granular columns
  const netLinesSum = itemRows.reduce((s, r) => s + BigInt(r.subtotal), 0n);
  const taxSum = itemRows.reduce((s, r) => s + BigInt(r.tax_amount || 0), 0n);
  const expectedNetMinusTx = netLinesSum - totalTxDeductionBig + taxSum;
  if (expectedNetMinusTx > BigInt(trx.total)) {
    totalTxDeductionBig += expectedNetMinusTx - BigInt(trx.total);
  }

  const lineTxShares = allocateProportionally(
    totalTxDeductionBig,
    itemRows.map((i) => BigInt(i.subtotal))
  );

  const priorRows = db
    .prepare(`
      SELECT transaction_item_id,
             COALESCE(SUM(qty), 0) AS returned_qty,
             COALESCE(SUM(line_refund_amount), 0) AS line_refunded,
             COALESCE(SUM(tax_refund_amount), 0) AS tax_refunded,
             COALESCE(SUM(total_refund_amount), 0) AS total_refunded
      FROM transaction_return_items
      WHERE transaction_id = ?
      GROUP BY transaction_item_id
    `)
    .all(trx.id) as Array<{
    transaction_item_id: string;
    returned_qty: number;
    line_refunded: number;
    tax_refunded: number;
    total_refunded: number;
  }>;

  const priorMap = new Map(priorRows.map((p) => [p.transaction_item_id, p]));

  return itemRows.map((item, idx) => {
    const share = lineTxShares[idx] ?? 0n;
    const rawLineSub = BigInt(item.subtotal) - share;
    const lineSubtotalPaidBig = rawLineSub > 0n ? rawLineSub : 0n;
    const lineTaxPaidBig = BigInt(item.tax_amount || 0);
    const lineTotalPaidBig = lineSubtotalPaidBig + lineTaxPaidBig;

    const prior = priorMap.get(item.id);
    const returnedQty = Number(prior?.returned_qty ?? 0);
    const remainingQty = Math.max(0, item.qty - returnedQty);
    const alreadyLineRefundedBig = BigInt(prior?.line_refunded ?? 0);
    const alreadyTaxRefundedBig = BigInt(prior?.tax_refunded ?? 0);
    const alreadyTotalRefundedBig = BigInt(prior?.total_refunded ?? 0);

    const remainingLineRefundableBig =
      lineSubtotalPaidBig > alreadyLineRefundedBig ? lineSubtotalPaidBig - alreadyLineRefundedBig : 0n;
    const remainingTaxRefundableBig =
      lineTaxPaidBig > alreadyTaxRefundedBig ? lineTaxPaidBig - alreadyTaxRefundedBig : 0n;
    const remainingRefundableBig =
      lineTotalPaidBig > alreadyTotalRefundedBig ? lineTotalPaidBig - alreadyTotalRefundedBig : 0n;

    return {
      transactionItemId: item.id,
      productId: item.product_id,
      sku: item.sku || '',
      barcode: item.barcode,
      name: item.name,
      unit: item.unit,
      originalQty: item.qty,
      returnedQty,
      remainingQty,
      unitPrice: item.sell_price,
      lineSubtotalPaidBig,
      lineTaxPaidBig,
      lineTotalPaidBig,
      alreadyLineRefundedBig,
      alreadyTaxRefundedBig,
      alreadyTotalRefundedBig,
      remainingLineRefundableBig,
      remainingTaxRefundableBig,
      remainingRefundableBig,
    };
  });
}

// --- Public Service Functions ---

export function searchOriginalTransactions(params: {
  search?: string;
  limit?: number;
}): Array<{
  transaction: Transaction;
  receiptNumber: string;
  canReturn: boolean;
  canVoid: boolean;
}> {
  const db = getDb();
  const limit = Math.min(100, Math.max(1, Number(params.limit || 40)));
  const q = (params.search ?? '').trim().toLowerCase();

  const rows = db
    .prepare(`
      SELECT t.id, COALESCE(rs.receipt_number, t.invoice_number) AS receipt_number
      FROM transactions t
      LEFT JOIN receipt_snapshots rs ON rs.transaction_id = t.id
      WHERE t.status IN ('COMPLETED', 'VOIDED')
      ORDER BY COALESCE(t.completed_at, t.created_at) DESC
      LIMIT 300
    `)
    .all() as Array<{ id: string; receipt_number: string }>;

  const results: Array<{
    transaction: Transaction;
    receiptNumber: string;
    canReturn: boolean;
    canVoid: boolean;
  }> = [];

  for (const r of rows) {
    const trx = getTransactionById(r.id);
    if (q) {
      const match =
        trx.invoiceNumber.toLowerCase().includes(q) ||
        r.receipt_number.toLowerCase().includes(q) ||
        trx.customerName.toLowerCase().includes(q) ||
        trx.cashierName.toLowerCase().includes(q) ||
        (trx.voidNumber && trx.voidNumber.toLowerCase().includes(q)) ||
        trx.items.some(
          (i) =>
            i.name.toLowerCase().includes(q) ||
            (i.sku && i.sku.toLowerCase().includes(q)) ||
            i.barcode.toLowerCase().includes(q)
        );
      if (!match) continue;
    }

    const canReturn =
      trx.status === 'COMPLETED' && (trx.returnStatus ?? 'NONE') !== 'FULL';
    const canVoid =
      trx.status === 'COMPLETED' && (trx.returnedTotal ?? 0) === 0;

    results.push({
      transaction: trx,
      receiptNumber: r.receipt_number,
      canReturn,
      canVoid,
    });

    if (results.length >= limit) break;
  }

  return results;
}

export function getReturnEligibility(transactionIdOrInvoice: string): ReturnEligibilityDetail {
  const db = getDb();
  const trxId = resolveTransactionIdByIdentifier(db, transactionIdOrInvoice);
  const trx = getTransactionById(trxId);

  const snapRow = db
    .prepare(`
      SELECT transaction_id, receipt_number, verification_token,
             store_name, store_address, store_phone, store_logo_url,
             receipt_header_note, receipt_footer, tax_rate,
             print_count, last_printed_at, created_at
      FROM receipt_snapshots
      WHERE transaction_id = ?
    `)
    .get(trx.id) as
    | {
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
    | undefined;

  const receiptSnapshot: ReceiptSnapshot | null = snapRow
    ? {
        transactionId: snapRow.transaction_id,
        receiptNumber: snapRow.receipt_number,
        verificationToken: snapRow.verification_token,
        storeName: snapRow.store_name,
        storeAddress: snapRow.store_address,
        storePhone: snapRow.store_phone,
        storeLogoUrl: snapRow.store_logo_url,
        receiptHeaderNote: snapRow.receipt_header_note,
        receiptFooter: snapRow.receipt_footer,
        taxRate: Number(snapRow.tax_rate ?? 0),
        printCount: Number(snapRow.print_count ?? 0),
        lastPrintedAt: snapRow.last_printed_at,
        createdAt: snapRow.created_at,
      }
    : null;

  const contexts = buildReturnContextsForTransaction(db, trx);
  const items: ReturnEligibleItemInfo[] = contexts.map((c) => ({
    transactionItemId: c.transactionItemId,
    productId: c.productId,
    sku: c.sku,
    barcode: c.barcode,
    name: c.name,
    unit: c.unit,
    originalQty: c.originalQty,
    returnedQty: c.returnedQty,
    remainingQty: c.remainingQty,
    unitPrice: c.unitPrice,
    lineSubtotalPaid: Number(c.lineSubtotalPaidBig),
    lineTaxPaid: Number(c.lineTaxPaidBig),
    lineTotalPaid: Number(c.lineTotalPaidBig),
    alreadyRefundedAmount: Number(c.alreadyTotalRefundedBig),
    remainingRefundableAmount: Number(c.remainingRefundableBig),
    effectiveUnitRefund:
      c.remainingQty > 0 ? Math.round(Number(c.remainingRefundableBig) / c.remainingQty) : 0,
  }));

  const returnRows = db
    .prepare('SELECT * FROM transaction_returns WHERE transaction_id = ? ORDER BY created_at DESC')
    .all(trx.id) as unknown as RawReturnRow[];
  const existingReturns = mapReturnRows(db, returnRows);

  const voidRaw = db
    .prepare('SELECT * FROM transaction_voids WHERE transaction_id = ? LIMIT 1')
    .get(trx.id) as Parameters<typeof mapVoidRow>[0] | undefined;
  const voidRecord = voidRaw ? mapVoidRow(voidRaw) : null;

  const totalRemainingQty = items.reduce((s, i) => s + i.remainingQty, 0);
  const remainingRefundableTotal = Math.max(
    0,
    trx.total - Number(trx.refundedTotal ?? 0)
  );

  let canReturn = true;
  let canReturnReason: string | undefined;
  if (trx.status === 'VOIDED') {
    canReturn = false;
    canReturnReason = 'Transaksi sudah di-void sehingga tidak dapat diretur.';
  } else if (trx.status !== 'COMPLETED') {
    canReturn = false;
    canReturnReason = `Hanya transaksi COMPLETED yang dapat diretur (status: ${trx.status}).`;
  } else if (totalRemainingQty <= 0) {
    canReturn = false;
    canReturnReason = 'Seluruh item pada transaksi ini sudah diretur penuh.';
  }

  let canVoid = true;
  let canVoidReason: string | undefined;
  if (trx.status === 'VOIDED') {
    canVoid = false;
    canVoidReason = 'Transaksi sudah berstatus VOIDED.';
  } else if (trx.status !== 'COMPLETED') {
    canVoid = false;
    canVoidReason = `Hanya transaksi COMPLETED yang dapat di-void (status: ${trx.status}).`;
  } else if (existingReturns.length > 0 || (trx.returnedTotal ?? 0) > 0) {
    canVoid = false;
    canVoidReason = 'Transaksi yang sudah memiliki riwayat retur tidak dapat di-void.';
  }

  return {
    transaction: trx,
    receiptNumber: receiptSnapshot?.receiptNumber ?? trx.invoiceNumber,
    receiptSnapshot,
    items,
    existingReturns,
    voidRecord,
    canReturn,
    canReturnReason,
    canVoid,
    canVoidReason,
    remainingRefundableTotal,
  };
}

export interface ReturnLineInput {
  transactionItemId?: unknown;
  productId?: unknown;
  qty?: unknown;
  stockDisposition?: unknown;
}

function computeReturnPreviewInternal(
  db: DatabaseSync,
  trx: Transaction,
  rawItems: unknown
): ReturnCalculationPreview {
  if (trx.status === 'VOIDED') {
    throw new ServiceError(409, 'Transaksi yang sudah di-void tidak dapat diretur.');
  }
  if (trx.status !== 'COMPLETED') {
    throw new ServiceError(409, `Hanya transaksi COMPLETED yang dapat diretur (status: ${trx.status}).`);
  }
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ServiceError(400, 'Pilih minimal satu item yang akan diretur.');
  }

  const contexts = buildReturnContextsForTransaction(db, trx);
  const byItemId = new Map(contexts.map((c) => [c.transactionItemId, c]));
  const byProductId = new Map<string, ComputedItemReturnContext[]>();
  for (const c of contexts) {
    const arr = byProductId.get(c.productId) ?? [];
    arr.push(c);
    byProductId.set(c.productId, arr);
  }

  const seenItemIds = new Set<string>();
  const previewItems: ReturnCalculationPreview['items'] = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') {
      throw new ServiceError(400, 'Format baris retur tidak valid.');
    }
    const line = raw as ReturnLineInput;

    let ctx: ComputedItemReturnContext | undefined;
    if (typeof line.transactionItemId === 'string' && line.transactionItemId.trim()) {
      ctx = byItemId.get(line.transactionItemId.trim());
    } else if (typeof line.productId === 'string' && line.productId.trim()) {
      const candidates = byProductId.get(line.productId.trim()) ?? [];
      ctx = candidates.find((c) => !seenItemIds.has(c.transactionItemId) && c.remainingQty > 0) ?? candidates[0];
    }

    if (!ctx) {
      throw new ServiceError(404, 'Salah satu item tidak ditemukan pada transaksi asli.');
    }
    if (seenItemIds.has(ctx.transactionItemId)) {
      throw new ServiceError(400, `Item "${ctx.name}" tercantum ganda dalam pengajuan retur.`);
    }
    seenItemIds.add(ctx.transactionItemId);

    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new ServiceError(400, `Jumlah retur "${ctx.name}" harus berupa bilangan bulat minimal 1.`);
    }
    if (qty > ctx.remainingQty) {
      throw new ServiceError(
        400,
        `Jumlah retur "${ctx.name}" (${qty} ${ctx.unit}) melebihi sisa yang dapat diretur (${ctx.remainingQty} ${ctx.unit} dari ${ctx.originalQty} ${ctx.unit}).`
      );
    }

    const rawDisp =
      typeof line.stockDisposition === 'string'
        ? line.stockDisposition.trim().toUpperCase()
        : 'SELLABLE';
    if (!VALID_DISPOSITIONS.has(rawDisp as ReturnStockDisposition)) {
      throw new ServiceError(
        400,
        'Kategori stok barang retur harus SELLABLE, DAMAGED, UNSELLABLE, atau PENDING_INSPECTION.'
      );
    }
    const stockDisposition = rawDisp as ReturnStockDisposition;

    let lineRefundBig: bigint;
    let taxRefundBig: bigint;
    let totalRefundBig: bigint;

    if (qty === ctx.remainingQty) {
      lineRefundBig = ctx.remainingLineRefundableBig;
      taxRefundBig = ctx.remainingTaxRefundableBig;
      totalRefundBig = ctx.remainingRefundableBig;
    } else {
      const calcLine = roundHalfUpDiv(ctx.lineSubtotalPaidBig * BigInt(qty), BigInt(ctx.originalQty));
      const calcTax = roundHalfUpDiv(ctx.lineTaxPaidBig * BigInt(qty), BigInt(ctx.originalQty));
      lineRefundBig =
        calcLine > ctx.remainingLineRefundableBig ? ctx.remainingLineRefundableBig : calcLine;
      taxRefundBig =
        calcTax > ctx.remainingTaxRefundableBig ? ctx.remainingTaxRefundableBig : calcTax;
      const sum = lineRefundBig + taxRefundBig;
      totalRefundBig = sum > ctx.remainingRefundableBig ? ctx.remainingRefundableBig : sum;
    }

    previewItems.push({
      transactionItemId: ctx.transactionItemId,
      productId: ctx.productId,
      name: ctx.name,
      unit: ctx.unit,
      qty,
      maxReturnableQty: ctx.remainingQty,
      unitPrice: ctx.unitPrice,
      lineRefundAmount: Number(lineRefundBig),
      taxRefundAmount: Number(taxRefundBig),
      totalRefundAmount: Number(totalRefundBig),
      stockDisposition,
    });
  }

  const subtotalRefunded = previewItems.reduce((s, i) => s + i.lineRefundAmount, 0);
  const taxRefunded = previewItems.reduce((s, i) => s + i.taxRefundAmount, 0);
  const computedTotalRefund = previewItems.reduce((s, i) => s + i.totalRefundAmount, 0);
  const maxRefundableRemaining = Math.max(0, trx.total - Number(trx.refundedTotal ?? 0));
  const totalRefundAmount = Math.min(computedTotalRefund, maxRefundableRemaining);

  const totalRemainingAfter = contexts.reduce((sum, c) => {
    const matched = previewItems.find((p) => p.transactionItemId === c.transactionItemId);
    return sum + (c.remainingQty - (matched?.qty ?? 0));
  }, 0);
  const isReturningFullOriginal =
    totalRemainingAfter === 0 &&
    contexts.every((c) => {
      const matched = previewItems.find((p) => p.transactionItemId === c.transactionItemId);
      return c.returnedQty === 0 && matched?.qty === c.originalQty;
    });

  let estimatedLoyaltyPointsReversed = 0;
  const originalEarned = Number(trx.loyaltyPointsEarned ?? 0);
  if (trx.customerId && originalEarned > 0 && trx.total > 0 && totalRefundAmount > 0) {
    const alreadyReversed = Number(
      (
        db
          .prepare(
            'SELECT COALESCE(SUM(loyalty_points_reversed), 0) AS total_rev FROM transaction_returns WHERE transaction_id = ?'
          )
          .get(trx.id) as { total_rev: number }
      ).total_rev
    );
    const targetCumulativeReversed = Number(
      roundHalfUpDiv(
        BigInt(originalEarned) * BigInt(Number(trx.refundedTotal ?? 0) + totalRefundAmount),
        BigInt(trx.total)
      )
    );
    estimatedLoyaltyPointsReversed = Math.max(
      0,
      Math.min(originalEarned - alreadyReversed, targetCumulativeReversed - alreadyReversed)
    );
  }

  return {
    transactionId: trx.id,
    invoiceNumber: trx.invoiceNumber,
    returnType: isReturningFullOriginal ? 'FULL' : 'PARTIAL',
    items: previewItems,
    subtotalRefunded,
    taxRefunded,
    totalRefundAmount,
    maxRefundableRemaining,
    estimatedLoyaltyPointsReversed,
  };
}

export function previewReturnCalculation(
  transactionIdOrInvoice: string,
  input: { items?: unknown }
): ReturnCalculationPreview {
  const db = getDb();
  const trxId = resolveTransactionIdByIdentifier(db, transactionIdOrInvoice);
  const trx = getTransactionById(trxId);
  return computeReturnPreviewInternal(db, trx, input.items);
}

export interface CreateReturnInput {
  items?: unknown;
  reason?: unknown;
  notes?: unknown;
  refundMethod?: unknown;
  refundPaymentType?: unknown;
  refundReference?: unknown;
  refundStatus?: unknown;
  refundAmount?: unknown;
  shiftId?: unknown;
  idempotencyKey?: unknown;
  pinApprovalToken?: unknown;
}

export function createReturnAndRefund(
  transactionIdOrInvoice: string,
  input: CreateReturnInput,
  actor: UserSummary
): {
  returnRecord: TransactionReturn;
  refundRecord: RefundRecord;
  transaction: Transaction;
  idempotentReplay: boolean;
} {
  const db = getDb();

  // Idempotency check BEFORE authorization & mutations
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
      ? input.idempotencyKey.trim().slice(0, 128)
      : null;

  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT id, transaction_id FROM transaction_returns WHERE idempotency_key = ?')
      .get(idempotencyKey) as { id: string; transaction_id: string } | undefined;
    if (existing) {
      const returnRecord = getReturnById(existing.id);
      const refundRow = db
        .prepare("SELECT * FROM refund_records WHERE source_type = 'RETURN' AND source_id = ? LIMIT 1")
        .get(existing.id) as Parameters<typeof mapRefundRow>[0];
      return {
        returnRecord,
        refundRecord: mapRefundRow(refundRow),
        transaction: getTransactionById(existing.transaction_id),
        idempotentReplay: true,
      };
    }
  }

  const hasPermission = actor.permissions.includes('pos:refund');
  const pinToken =
    typeof input.pinApprovalToken === 'string' ? input.pinApprovalToken.trim() : '';
  if (!hasPermission && !pinToken) {
    throw new ServiceError(
      403,
      'Proses retur dan pengembalian dana memerlukan izin pos:refund atau PIN Supervisor/Admin.',
      'PIN_REQUIRED'
    );
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length < 3) {
    throw new ServiceError(400, 'Alasan retur wajib diisi (minimal 3 karakter).');
  }
  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 500) : '';

  const trxId = resolveTransactionIdByIdentifier(db, transactionIdOrInvoice);
  const trx = getTransactionById(trxId);
  const preview = computeReturnPreviewInternal(db, trx, input.items);

  // Refund amount validation
  let finalRefundAmount = preview.totalRefundAmount;
  if (
    input.refundAmount !== undefined &&
    input.refundAmount !== null &&
    String(input.refundAmount).trim() !== ''
  ) {
    const requestedRefund = Number(input.refundAmount);
    if (!Number.isFinite(requestedRefund) || requestedRefund < 0 || !Number.isInteger(requestedRefund)) {
      throw new ServiceError(400, 'Nominal refund harus berupa bilangan bulat non-negatif.');
    }
    if (requestedRefund > preview.totalRefundAmount) {
      throw new ServiceError(
        400,
        `Nominal refund (Rp ${requestedRefund.toLocaleString('id-ID')}) melebihi batas nilai retur yang diizinkan (Rp ${preview.totalRefundAmount.toLocaleString('id-ID')}).`
      );
    }
    if (requestedRefund > preview.maxRefundableRemaining) {
      throw new ServiceError(
        400,
        `Nominal refund melebihi sisa nilai transaksi yang dapat dikembalikan (Rp ${preview.maxRefundableRemaining.toLocaleString('id-ID')}).`
      );
    }
    finalRefundAmount = requestedRefund;
  }

  const defaultMethod = trx.paymentMethod || 'Tunai';
  const refundMethod =
    typeof input.refundMethod === 'string' && input.refundMethod.trim()
      ? input.refundMethod.trim().slice(0, 80)
      : defaultMethod;
  const refundPaymentType = inferRefundPaymentType(input.refundPaymentType, refundMethod);
  const refundReference =
    typeof input.refundReference === 'string' ? input.refundReference.trim().slice(0, 80) : '';

  let refundStatus: RefundRecordStatus;
  if (refundPaymentType === 'CASH') {
    refundStatus = 'COMPLETED';
  } else if (
    typeof input.refundStatus === 'string' &&
    VALID_REFUND_STATUSES.has(input.refundStatus.trim().toUpperCase() as RefundRecordStatus)
  ) {
    refundStatus = input.refundStatus.trim().toUpperCase() as RefundRecordStatus;
  } else {
    refundStatus = 'MANUAL_RECORDED';
  }

  const snapRow = db
    .prepare('SELECT receipt_number FROM receipt_snapshots WHERE transaction_id = ?')
    .get(trx.id) as { receipt_number: string } | undefined;
  const receiptNumber = snapRow?.receipt_number ?? trx.invoiceNumber;

  const nowIso = new Date().toISOString();
  const returnId = `ret-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const refundId = `ref-${Date.now()}-${randomUUID().slice(0, 6)}`;

  db.exec('BEGIN IMMEDIATE;');
  try {
    let approvedByUserId = actor.id;
    let approvedByName = actor.fullName;
    if (!hasPermission && pinToken) {
      const consumed = consumePinApprovalToken(db, pinToken, 'refund');
      approvedByUserId = consumed.authorizerUserId;
      approvedByName = resolveAuthorizerName(db, consumed.authorizerUserId);
    }

    // Re-check inside lock to prevent concurrent duplicate returns exceeding qty
    const lockedTrx = getTransactionById(trx.id);
    const lockedPreview = computeReturnPreviewInternal(db, lockedTrx, input.items);
    if (finalRefundAmount > lockedPreview.maxRefundableRemaining) {
      throw new ServiceError(409, 'Sisa transaksi yang dapat direfund telah berubah.');
    }

    const returnNumber = nextReturnVoidDocNumber(
      db,
      'RET',
      'transaction_returns',
      'return_number'
    );
    const refundNumber = nextReturnVoidDocNumber(
      db,
      'REF',
      'refund_records',
      'refund_number'
    );

    const hasPendingInspection = lockedPreview.items.some(
      (i) => i.stockDisposition === 'PENDING_INSPECTION'
    );
    const returnStatusValue: ReturnRecordStatus = hasPendingInspection
      ? 'PENDING_INSPECTION'
      : 'COMPLETED';

    // Handle active shift cash refund movement if CASH
    let cashMovementId: string | null = null;
    let shiftId: string | null = null;
    if (refundPaymentType === 'CASH' && finalRefundAmount > 0) {
      const openShift = resolveOpenShiftForCashRefund(
        db,
        input.shiftId,
        actor.id,
        lockedTrx.shiftId ?? null
      );
      if (openShift) {
        shiftId = openShift.id;
        cashMovementId = `cm-${Date.now()}-${randomUUID().slice(0, 6)}`;
        const movNum = nextReturnVoidDocNumber(db, 'CM', 'cash_movements', 'movement_number');
        db.prepare(`
          INSERT INTO cash_movements (
            id, shift_id, movement_number, type, amount, reason, reference_number, notes,
            actor_user_id, actor_name, created_at
          ) VALUES (?, ?, ?, 'CASH_REFUND', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          cashMovementId,
          openShift.id,
          movNum,
          finalRefundAmount,
          `Refund Tunai Retur ${lockedTrx.invoiceNumber} (${returnNumber})`,
          returnNumber,
          reason,
          actor.id,
          actor.fullName,
          nowIso
        );
        refreshShiftCachedReconciliationTx(db, openShift.id, nowIso);
      }
    }

    // Proportional loyalty points reversal
    let loyaltyPointsReversed = 0;
    if (lockedTrx.customerId && lockedPreview.estimatedLoyaltyPointsReversed > 0) {
      const custRow = db
        .prepare('SELECT loyalty_points, total_points_earned FROM customers WHERE id = ?')
        .get(lockedTrx.customerId) as
        | { loyalty_points: number; total_points_earned: number }
        | undefined;
      if (custRow && custRow.loyalty_points > 0) {
        const deduct = Math.min(custRow.loyalty_points, lockedPreview.estimatedLoyaltyPointsReversed);
        if (deduct > 0) {
          const after = custRow.loyalty_points - deduct;
          loyaltyPointsReversed = deduct;
          db.prepare(`
            UPDATE customers
            SET loyalty_points = ?,
                total_points_earned = CASE WHEN total_points_earned >= ? THEN total_points_earned - ? ELSE 0 END,
                updated_at = ?
            WHERE id = ?
          `).run(after, deduct, deduct, nowIso, lockedTrx.customerId);

          db.prepare(`
            INSERT INTO loyalty_point_transactions (
              id, customer_id, transaction_id, type, points_delta, points_before, points_after,
              reference_number, notes, actor_user_id, actor_name, created_at
            ) VALUES (?, ?, ?, 'ADJUST', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            `lpt-ret-${Date.now()}-${randomUUID().slice(0, 5)}`,
            lockedTrx.customerId,
            lockedTrx.id,
            -deduct,
            custRow.loyalty_points,
            after,
            returnNumber,
            `Pengembalian poin atas retur ${returnNumber} (${lockedTrx.invoiceNumber})`,
            actor.id,
            actor.fullName,
            nowIso
          );
        }
      }
    }

    const discountAdjusted = Math.max(0, lockedPreview.subtotalRefunded + lockedPreview.taxRefunded - finalRefundAmount);

    db.prepare(`
      INSERT INTO transaction_returns (
        id, return_number, transaction_id, invoice_number, receipt_number,
        return_type, status, reason, notes,
        subtotal_refunded, discount_adjusted, tax_refunded, total_refund_amount,
        loyalty_points_reversed, refund_method, refund_payment_type, refund_reference, refund_status,
        cash_movement_id, shift_id, requested_by_user_id, requested_by_name,
        approved_by_user_id, approved_by_name, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      returnId,
      returnNumber,
      lockedTrx.id,
      lockedTrx.invoiceNumber,
      receiptNumber,
      lockedPreview.returnType,
      returnStatusValue,
      reason,
      notes,
      lockedPreview.subtotalRefunded,
      discountAdjusted,
      lockedPreview.taxRefunded,
      finalRefundAmount,
      loyaltyPointsReversed,
      refundMethod,
      refundPaymentType,
      refundReference,
      refundStatus,
      cashMovementId,
      shiftId,
      actor.id,
      actor.fullName,
      approvedByUserId,
      approvedByName,
      idempotencyKey,
      nowIso,
      nowIso
    );

    const contexts = buildReturnContextsForTransaction(db, lockedTrx);
    const contextById = new Map(contexts.map((c) => [c.transactionItemId, c]));
    const selectStockStmt = db.prepare('SELECT stock, cost_price FROM products WHERE id = ?');
    const updateStockStmt = db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?');
    const insertMovStmt = db.prepare(`
      INSERT INTO stock_movements (
        id, product_id, sku, product_name, barcode, type, qty_delta, stock_before, stock_after,
        unit_cost, reference_id, reason, notes, actor_user_id, actor_name, movement_date, created_at
      ) VALUES (?, ?, ?, ?, ?, 'RETURN_IN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRetItemStmt = db.prepare(`
      INSERT INTO transaction_return_items (
        id, return_id, transaction_id, transaction_item_id, product_id, sku, barcode,
        product_name, unit, qty, original_qty, unit_price,
        line_refund_amount, tax_refund_amount, total_refund_amount,
        stock_disposition, final_disposition,
        disposition_resolved_by_user_id, disposition_resolved_by_name,
        disposition_resolved_at, disposition_notes, stock_movement_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    lockedPreview.items.forEach((item, idx) => {
      const ctx = contextById.get(item.transactionItemId)!;
      let stockMovementId: string | null = null;
      let finalDisposition: ReturnDispositionFinal | null = null;
      let resolvedByUserId: string | null = null;
      let resolvedByName: string | null = null;
      let resolvedAt: string | null = null;

      if (item.stockDisposition === 'SELLABLE') {
        const prodRow = selectStockStmt.get(item.productId) as
          | { stock: number; cost_price: number }
          | undefined;
        if (!prodRow) {
          throw new ServiceError(404, `Produk "${item.name}" tidak ditemukan di katalog.`);
        }
        const stockBefore = prodRow.stock;
        const stockAfter = stockBefore + item.qty;
        stockMovementId = `mov-ret-${Date.now()}-${idx}-${randomUUID().slice(0, 5)}`;

        updateStockStmt.run(stockAfter, nowIso, item.productId);
        insertMovStmt.run(
          stockMovementId,
          item.productId,
          ctx.sku,
          item.name,
          ctx.barcode,
          item.qty,
          stockBefore,
          stockAfter,
          prodRow.cost_price,
          returnNumber,
          `Retur Barang (${reason})`,
          `Retur layak jual dari ${lockedTrx.invoiceNumber} (${item.qty} ${item.unit})`,
          actor.id,
          actor.fullName,
          nowIso,
          nowIso
        );
        finalDisposition = 'SELLABLE';
        resolvedByUserId = approvedByUserId;
        resolvedByName = approvedByName;
        resolvedAt = nowIso;
      } else if (item.stockDisposition === 'DAMAGED' || item.stockDisposition === 'UNSELLABLE') {
        finalDisposition = item.stockDisposition;
        resolvedByUserId = approvedByUserId;
        resolvedByName = approvedByName;
        resolvedAt = nowIso;
      }

      insertRetItemStmt.run(
        `${returnId}-itm-${idx}`,
        returnId,
        lockedTrx.id,
        item.transactionItemId,
        item.productId,
        ctx.sku,
        ctx.barcode,
        item.name,
        item.unit,
        item.qty,
        ctx.originalQty,
        item.unitPrice,
        item.lineRefundAmount,
        item.taxRefundAmount,
        item.totalRefundAmount,
        item.stockDisposition,
        finalDisposition,
        resolvedByUserId,
        resolvedByName,
        resolvedAt,
        notes,
        stockMovementId,
        nowIso
      );
    });

    // Update cumulative transaction return & refund totals
    const postContexts = buildReturnContextsForTransaction(db, lockedTrx);
    const allItemsReturned = postContexts.every((c) => c.remainingQty <= 0);
    const newReturnStatus = allItemsReturned ? 'FULL' : 'PARTIAL';
    const newReturnedTotal = Number(lockedTrx.returnedTotal ?? 0) + lockedPreview.totalRefundAmount;
    const newRefundedTotal = Number(lockedTrx.refundedTotal ?? 0) + finalRefundAmount;
    const newPaymentStatus =
      allItemsReturned || newRefundedTotal >= lockedTrx.total ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

    db.prepare(`
      UPDATE transactions
      SET return_status = ?, returned_total = ?, refunded_total = ?,
          payment_status = ?, updated_at = ?
      WHERE id = ?
    `).run(newReturnStatus, newReturnedTotal, newRefundedTotal, newPaymentStatus, nowIso, lockedTrx.id);

    db.prepare(`
      INSERT INTO refund_records (
        id, refund_number, source_type, source_id, source_number, transaction_id, invoice_number,
        amount, refund_method, payment_type, reference_number, status, notes,
        cash_movement_id, shift_id, actor_user_id, actor_name, created_at, updated_at
      ) VALUES (?, ?, 'RETURN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      refundId,
      refundNumber,
      returnId,
      returnNumber,
      lockedTrx.id,
      lockedTrx.invoiceNumber,
      finalRefundAmount,
      refundMethod,
      refundPaymentType,
      refundReference,
      refundStatus,
      notes || reason,
      cashMovementId,
      shiftId,
      actor.id,
      actor.fullName,
      nowIso,
      nowIso
    );

    const sellableRestockUnits = lockedPreview.items
      .filter((i) => i.stockDisposition === 'SELLABLE')
      .reduce((s, i) => s + i.qty, 0);

    recordAuditLog(db, {
      action: 'RETURN_CREATED',
      entityType: 'return',
      entityId: returnNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Retur ${returnNumber} untuk ${lockedTrx.invoiceNumber} (${lockedPreview.returnType}) senilai Rp ${finalRefundAmount.toLocaleString('id-ID')} via ${refundMethod} · Restok layak jual: ${sellableRestockUnits} unit · Alasan: ${reason} · Disetujui: ${approvedByName}`,
    });

    recordAuditLog(db, {
      action: 'REFUND_RECORDED',
      entityType: 'refund',
      entityId: refundNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Catat refund ${refundNumber} (RETUR ${returnNumber}): Rp ${finalRefundAmount.toLocaleString('id-ID')} via ${refundMethod} [${refundStatus}]${refundReference ? ` · Ref: ${refundReference}` : ''}`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const returnRecord = getReturnById(returnId);
  const refundRow = db
    .prepare('SELECT * FROM refund_records WHERE id = ?')
    .get(refundId) as Parameters<typeof mapRefundRow>[0];

  return {
    returnRecord,
    refundRecord: mapRefundRow(refundRow),
    transaction: getTransactionById(trx.id),
    idempotentReplay: false,
  };
}

export function resolveReturnItemDisposition(
  returnItemId: string,
  input: {
    disposition?: unknown;
    notes?: unknown;
    pinApprovalToken?: unknown;
  },
  actor: UserSummary
): { returnRecord: TransactionReturn; item: TransactionReturnItem } {
  const db = getDb();
  const hasPermission =
    actor.permissions.includes('pos:refund') || actor.permissions.includes('stock:adjust');
  const pinToken =
    typeof input.pinApprovalToken === 'string' ? input.pinApprovalToken.trim() : '';

  if (!hasPermission && !pinToken) {
    throw new ServiceError(
      403,
      'Penyelesaian inspeksi barang retur memerlukan izin pos:refund / stock:adjust atau PIN Supervisor.',
      'PIN_REQUIRED'
    );
  }

  const rawDisp =
    typeof input.disposition === 'string' ? input.disposition.trim().toUpperCase() : '';
  if (!VALID_FINAL_DISPOSITIONS.has(rawDisp as ReturnDispositionFinal)) {
    throw new ServiceError(
      400,
      'Hasil inspeksi barang retur harus SELLABLE, DAMAGED, atau UNSELLABLE.'
    );
  }
  const finalDisposition = rawDisp as ReturnDispositionFinal;
  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 400) : '';

  const itemRow = db
    .prepare('SELECT * FROM transaction_return_items WHERE id = ?')
    .get(returnItemId) as RawReturnItemRow | undefined;
  if (!itemRow) {
    throw new ServiceError(404, 'Item retur tidak ditemukan.');
  }
  if (itemRow.stock_disposition !== 'PENDING_INSPECTION' || itemRow.final_disposition !== null) {
    throw new ServiceError(
      409,
      `Inspeksi untuk item "${itemRow.product_name}" sudah diselesaikan sebelumnya.`
    );
  }

  const parentRet = db
    .prepare('SELECT * FROM transaction_returns WHERE id = ?')
    .get(itemRow.return_id) as RawReturnRow | undefined;
  if (!parentRet) {
    throw new ServiceError(404, 'Dokumen retur induk tidak ditemukan.');
  }

  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    let resolvedByUserId = actor.id;
    let resolvedByName = actor.fullName;
    if (!hasPermission && pinToken) {
      const consumed = consumePinApprovalToken(db, pinToken, 'refund');
      resolvedByUserId = consumed.authorizerUserId;
      resolvedByName = resolveAuthorizerName(db, consumed.authorizerUserId);
    }

    let stockMovementId: string | null = null;
    if (finalDisposition === 'SELLABLE') {
      const prodRow = db
        .prepare('SELECT stock, cost_price FROM products WHERE id = ?')
        .get(itemRow.product_id) as { stock: number; cost_price: number } | undefined;
      if (!prodRow) {
        throw new ServiceError(404, 'Produk tidak ditemukan di katalog.');
      }
      const stockBefore = prodRow.stock;
      const stockAfter = stockBefore + itemRow.qty;
      stockMovementId = `mov-insp-${Date.now()}-${randomUUID().slice(0, 5)}`;

      db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(
        stockAfter,
        nowIso,
        itemRow.product_id
      );

      db.prepare(`
        INSERT INTO stock_movements (
          id, product_id, sku, product_name, barcode, type, qty_delta, stock_before, stock_after,
          unit_cost, reference_id, reason, notes, actor_user_id, actor_name, movement_date, created_at
        ) VALUES (?, ?, ?, ?, ?, 'RETURN_IN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        stockMovementId,
        itemRow.product_id,
        itemRow.sku,
        itemRow.product_name,
        itemRow.barcode,
        itemRow.qty,
        stockBefore,
        stockAfter,
        prodRow.cost_price,
        parentRet.return_number,
        'Inspeksi Retur Layak Jual',
        notes || `Hasil inspeksi QC layak jual (${parentRet.invoice_number})`,
        actor.id,
        actor.fullName,
        nowIso,
        nowIso
      );
    }

    db.prepare(`
      UPDATE transaction_return_items
      SET final_disposition = ?,
          disposition_resolved_by_user_id = ?,
          disposition_resolved_by_name = ?,
          disposition_resolved_at = ?,
          disposition_notes = ?,
          stock_movement_id = COALESCE(?, stock_movement_id)
      WHERE id = ?
    `).run(
      finalDisposition,
      resolvedByUserId,
      resolvedByName,
      nowIso,
      notes,
      stockMovementId,
      returnItemId
    );

    const remainingPending = (
      db
        .prepare(`
          SELECT COUNT(*) as cnt
          FROM transaction_return_items
          WHERE return_id = ?
            AND stock_disposition = 'PENDING_INSPECTION'
            AND final_disposition IS NULL
        `)
        .get(parentRet.id) as { cnt: number }
    ).cnt;

    if (remainingPending === 0) {
      db.prepare(`
        UPDATE transaction_returns
        SET status = 'COMPLETED', updated_at = ?
        WHERE id = ?
      `).run(nowIso, parentRet.id);
    } else {
      db.prepare('UPDATE transaction_returns SET updated_at = ? WHERE id = ?').run(
        nowIso,
        parentRet.id
      );
    }

    recordAuditLog(db, {
      action: 'RETURN_INSPECTION_RESOLVED',
      entityType: 'return',
      entityId: parentRet.return_number,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Inspeksi QC "${itemRow.product_name}" (${itemRow.qty} ${itemRow.unit}) pada ${parentRet.return_number} ditetapkan: ${finalDisposition}${finalDisposition === 'SELLABLE' ? ' (Stok bertambah)' : ' (Tidak kembali ke stok jual)'}${notes ? ` · ${notes}` : ''}`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const returnRecord = getReturnById(parentRet.id);
  const resolvedItem = returnRecord.items.find((i) => i.id === returnItemId)!;
  return { returnRecord, item: resolvedItem };
}

export interface VoidTransactionInput {
  reason?: unknown;
  notes?: unknown;
  refundMethod?: unknown;
  refundPaymentType?: unknown;
  refundReference?: unknown;
  refundStatus?: unknown;
  shiftId?: unknown;
  pinApprovalToken?: unknown;
}

export function voidCompletedTransaction(
  transactionIdOrInvoice: string,
  input: VoidTransactionInput,
  actor: UserSummary
): {
  voidRecord: TransactionVoidRecord;
  refundRecord: RefundRecord;
  transaction: Transaction;
} {
  const db = getDb();
  const hasPermission = actor.permissions.includes('pos:void');
  const pinToken =
    typeof input.pinApprovalToken === 'string' ? input.pinApprovalToken.trim() : '';
  if (!hasPermission && !pinToken) {
    throw new ServiceError(
      403,
      'Pembatalan transaksi selesai (Void) memerlukan izin pos:void atau PIN Supervisor/Admin.',
      'PIN_REQUIRED'
    );
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length < 3) {
    throw new ServiceError(400, 'Alasan void transaksi wajib diisi (minimal 3 karakter).');
  }
  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 500) : '';

  const trxId = resolveTransactionIdByIdentifier(db, transactionIdOrInvoice);
  const initialTrx = getTransactionById(trxId);

  if (initialTrx.status === 'VOIDED') {
    throw new ServiceError(409, `Transaksi ${initialTrx.invoiceNumber} sudah pernah di-void.`);
  }
  if (initialTrx.status !== 'COMPLETED') {
    throw new ServiceError(
      409,
      `Hanya transaksi berstatus COMPLETED yang dapat di-void (status saat ini: ${initialTrx.status}).`
    );
  }

  const existingRetCount = (
    db
      .prepare('SELECT COUNT(*) as cnt FROM transaction_returns WHERE transaction_id = ?')
      .get(initialTrx.id) as { cnt: number }
  ).cnt;
  if (existingRetCount > 0 || (initialTrx.returnedTotal ?? 0) > 0) {
    throw new ServiceError(
      409,
      'Transaksi yang sudah memiliki riwayat retur tidak dapat di-void secara penuh.'
    );
  }

  const defaultMethod = initialTrx.paymentMethod || 'Tunai';
  const refundMethod =
    typeof input.refundMethod === 'string' && input.refundMethod.trim()
      ? input.refundMethod.trim().slice(0, 80)
      : defaultMethod;
  const fallbackPaymentType =
    initialTrx.payments && initialTrx.payments.length === 1
      ? initialTrx.payments[0].paymentType
      : undefined;
  const refundPaymentType = inferRefundPaymentType(
    input.refundPaymentType ?? fallbackPaymentType,
    refundMethod
  );
  const refundReference =
    typeof input.refundReference === 'string' ? input.refundReference.trim().slice(0, 80) : '';

  let refundStatus: RefundRecordStatus;
  if (refundPaymentType === 'CASH') {
    refundStatus = 'COMPLETED';
  } else if (
    typeof input.refundStatus === 'string' &&
    VALID_REFUND_STATUSES.has(input.refundStatus.trim().toUpperCase() as RefundRecordStatus)
  ) {
    refundStatus = input.refundStatus.trim().toUpperCase() as RefundRecordStatus;
  } else {
    refundStatus = 'MANUAL_RECORDED';
  }

  const snapRow = db
    .prepare('SELECT receipt_number FROM receipt_snapshots WHERE transaction_id = ?')
    .get(initialTrx.id) as { receipt_number: string } | undefined;
  const receiptNumber = snapRow?.receipt_number ?? initialTrx.invoiceNumber;

  const nowIso = new Date().toISOString();
  const voidId = `vod-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const refundId = `ref-${Date.now()}-${randomUUID().slice(0, 6)}`;

  db.exec('BEGIN IMMEDIATE;');
  try {
    let approvedByUserId = actor.id;
    let approvedByName = actor.fullName;
    if (!hasPermission && pinToken) {
      const consumed = consumePinApprovalToken(db, pinToken, 'void');
      approvedByUserId = consumed.authorizerUserId;
      approvedByName = resolveAuthorizerName(db, consumed.authorizerUserId);
    }

    const trx = getTransactionById(trxId);
    if (trx.status !== 'COMPLETED') {
      throw new ServiceError(409, `Transaksi ${trx.invoiceNumber} tidak lagi berstatus COMPLETED.`);
    }

    const voidNumber = nextReturnVoidDocNumber(
      db,
      'VOD',
      'transaction_voids',
      'void_number'
    );
    const refundNumber = nextReturnVoidDocNumber(
      db,
      'REF',
      'refund_records',
      'refund_number'
    );

    // 1. Mark transaction VOIDED (never delete!)
    db.prepare(`
      UPDATE transactions
      SET status = 'VOIDED',
          payment_status = 'REFUNDED',
          refunded_total = total,
          void_number = ?,
          void_reason = ?,
          voided_at = ?,
          voided_by_user_id = ?,
          voided_by_name = ?,
          void_approved_by_user_id = ?,
          void_approved_by_name = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      voidNumber,
      reason,
      nowIso,
      actor.id,
      actor.fullName,
      approvedByUserId,
      approvedByName,
      nowIso,
      trx.id
    );

    // 2. Restore sellable stock for every sold item
    let stockRestoredQty = 0;
    const selectStockStmt = db.prepare('SELECT stock, cost_price FROM products WHERE id = ?');
    const updateStockStmt = db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?');
    const insertMovStmt = db.prepare(`
      INSERT INTO stock_movements (
        id, product_id, sku, product_name, barcode, type, qty_delta, stock_before, stock_after,
        unit_cost, reference_id, reason, notes, actor_user_id, actor_name, movement_date, created_at
      ) VALUES (?, ?, ?, ?, ?, 'VOID_IN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    trx.items.forEach((item, idx) => {
      const prodRow = selectStockStmt.get(item.productId) as
        | { stock: number; cost_price: number }
        | undefined;
      if (!prodRow) {
        throw new ServiceError(404, `Produk "${item.name}" tidak ditemukan di katalog.`);
      }
      const stockBefore = prodRow.stock;
      const stockAfter = stockBefore + item.qty;
      stockRestoredQty += item.qty;

      updateStockStmt.run(stockAfter, nowIso, item.productId);
      insertMovStmt.run(
        `mov-vod-${Date.now()}-${idx}-${randomUUID().slice(0, 5)}`,
        item.productId,
        item.sku || '',
        item.name,
        item.barcode,
        item.qty,
        stockBefore,
        stockAfter,
        prodRow.cost_price,
        voidNumber,
        `Void Transaksi (${reason})`,
        `Pengembalian stok dari void ${trx.invoiceNumber} (${item.qty} ${item.unit})`,
        actor.id,
        actor.fullName,
        nowIso,
        nowIso
      );
    });

    // 3. Reverse loyalty points cleanly (earned revoked, redeemed restored)
    let loyaltyPointsReversed = 0;
    const earned = Number(trx.loyaltyPointsEarned ?? 0);
    const redeemed = Number(trx.loyaltyPointsRedeemed ?? 0);
    if (trx.customerId && (earned > 0 || redeemed > 0)) {
      const custRow = db
        .prepare('SELECT loyalty_points, total_points_earned, total_points_redeemed FROM customers WHERE id = ?')
        .get(trx.customerId) as
        | { loyalty_points: number; total_points_earned: number; total_points_redeemed: number }
        | undefined;
      if (custRow) {
        const pointsBefore = custRow.loyalty_points;
        const desiredNetDelta = redeemed - earned;
        const pointsAfter = Math.max(0, pointsBefore + desiredNetDelta);
        const actualDelta = pointsAfter - pointsBefore;
        loyaltyPointsReversed = Math.min(earned, Math.max(0, pointsBefore + redeemed - pointsAfter));

        db.prepare(`
          UPDATE customers
          SET loyalty_points = ?,
              total_points_earned = CASE WHEN total_points_earned >= ? THEN total_points_earned - ? ELSE 0 END,
              total_points_redeemed = CASE WHEN total_points_redeemed >= ? THEN total_points_redeemed - ? ELSE 0 END,
              updated_at = ?
          WHERE id = ?
        `).run(pointsAfter, earned, earned, redeemed, redeemed, nowIso, trx.customerId);

        if (actualDelta !== 0 || earned > 0 || redeemed > 0) {
          db.prepare(`
            INSERT INTO loyalty_point_transactions (
              id, customer_id, transaction_id, type, points_delta, points_before, points_after,
              reference_number, notes, actor_user_id, actor_name, created_at
            ) VALUES (?, ?, ?, 'ADJUST', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            `lpt-vod-${Date.now()}-${randomUUID().slice(0, 5)}`,
            trx.customerId,
            trx.id,
            actualDelta,
            pointsBefore,
            pointsAfter,
            voidNumber,
            `Pembalikan poin atas void ${trx.invoiceNumber} (-${earned} earn, +${redeemed} redeem)`,
            actor.id,
            actor.fullName,
            nowIso
          );
        }
      }
    }

    // 4. Shift cash reconciliation update without double-subtracting same-shift cash sales
    let cashMovementId: string | null = null;
    let linkedShiftId: string | null = trx.shiftId ?? null;

    if (trx.shiftId) {
      const originShiftRow = db
        .prepare('SELECT id, status FROM cashier_shifts WHERE id = ?')
        .get(trx.shiftId) as { id: string; status: string } | undefined;

      if (originShiftRow && originShiftRow.status === 'OPEN') {
        // Because trx.status is now VOIDED, computeShiftReconciliationTx already drops trx's cashSales.
        // Do NOT insert CASH_REFUND on the same open shift to prevent double subtraction.
        refreshShiftCachedReconciliationTx(db, originShiftRow.id, nowIso);
        linkedShiftId = originShiftRow.id;
      } else if (refundPaymentType === 'CASH' && trx.total > 0) {
        // Original shift was already CLOSED -> record cash payout on currently OPEN drawer shift
        const openShift = resolveOpenShiftForCashRefund(db, input.shiftId, actor.id, null);
        if (openShift) {
          linkedShiftId = openShift.id;
          cashMovementId = `cm-${Date.now()}-${randomUUID().slice(0, 6)}`;
          const movNum = nextReturnVoidDocNumber(db, 'CM', 'cash_movements', 'movement_number');
          db.prepare(`
            INSERT INTO cash_movements (
              id, shift_id, movement_number, type, amount, reason, reference_number, notes,
              actor_user_id, actor_name, created_at
            ) VALUES (?, ?, ?, 'CASH_REFUND', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            cashMovementId,
            openShift.id,
            movNum,
            trx.total,
            `Refund Tunai Void ${trx.invoiceNumber} (${voidNumber})`,
            voidNumber,
            reason,
            actor.id,
            actor.fullName,
            nowIso
          );
          refreshShiftCachedReconciliationTx(db, openShift.id, nowIso);
        }
      }
    } else if (refundPaymentType === 'CASH' && trx.total > 0) {
      const openShift = resolveOpenShiftForCashRefund(db, input.shiftId, actor.id, null);
      if (openShift) {
        linkedShiftId = openShift.id;
        cashMovementId = `cm-${Date.now()}-${randomUUID().slice(0, 6)}`;
        const movNum = nextReturnVoidDocNumber(db, 'CM', 'cash_movements', 'movement_number');
        db.prepare(`
          INSERT INTO cash_movements (
            id, shift_id, movement_number, type, amount, reason, reference_number, notes,
            actor_user_id, actor_name, created_at
          ) VALUES (?, ?, ?, 'CASH_REFUND', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          cashMovementId,
          openShift.id,
          movNum,
          trx.total,
          `Refund Tunai Void ${trx.invoiceNumber} (${voidNumber})`,
          voidNumber,
          reason,
          actor.id,
          actor.fullName,
          nowIso
        );
        refreshShiftCachedReconciliationTx(db, openShift.id, nowIso);
      }
    }

    // 5. Record void ledger & refund ledger
    db.prepare(`
      INSERT INTO transaction_voids (
        id, void_number, transaction_id, invoice_number, receipt_number,
        reason, notes, voided_total, refund_method, refund_payment_type,
        refund_reference, refund_status, stock_restored_qty, loyalty_points_reversed,
        cash_movement_id, shift_id, requested_by_user_id, requested_by_name,
        approved_by_user_id, approved_by_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      voidId,
      voidNumber,
      trx.id,
      trx.invoiceNumber,
      receiptNumber,
      reason,
      notes,
      trx.total,
      refundMethod,
      refundPaymentType,
      refundReference,
      refundStatus,
      stockRestoredQty,
      loyaltyPointsReversed,
      cashMovementId,
      linkedShiftId,
      actor.id,
      actor.fullName,
      approvedByUserId,
      approvedByName,
      nowIso
    );

    db.prepare(`
      INSERT INTO refund_records (
        id, refund_number, source_type, source_id, source_number, transaction_id, invoice_number,
        amount, refund_method, payment_type, reference_number, status, notes,
        cash_movement_id, shift_id, actor_user_id, actor_name, created_at, updated_at
      ) VALUES (?, ?, 'VOID', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      refundId,
      refundNumber,
      voidId,
      voidNumber,
      trx.id,
      trx.invoiceNumber,
      trx.total,
      refundMethod,
      refundPaymentType,
      refundReference,
      refundStatus,
      notes || reason,
      cashMovementId,
      linkedShiftId,
      actor.id,
      actor.fullName,
      nowIso,
      nowIso
    );

    recordAuditLog(db, {
      action: 'TRANSACTION_VOIDED',
      entityType: 'void',
      entityId: voidNumber,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Void transaksi ${trx.invoiceNumber} (${voidNumber}) senilai Rp ${trx.total.toLocaleString('id-ID')} · Stok dipulihkan ${stockRestoredQty} unit · Alasan: ${reason} · Disetujui: ${approvedByName}`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const voidRow = db
    .prepare('SELECT * FROM transaction_voids WHERE id = ?')
    .get(voidId) as Parameters<typeof mapVoidRow>[0];
  const refundRow = db
    .prepare('SELECT * FROM refund_records WHERE id = ?')
    .get(refundId) as Parameters<typeof mapRefundRow>[0];

  return {
    voidRecord: mapVoidRow(voidRow),
    refundRecord: mapRefundRow(refundRow),
    transaction: getTransactionById(trxId),
  };
}

export function listReturns(params: {
  search?: string;
  status?: string;
  disposition?: string;
  limit?: number;
}): TransactionReturn[] {
  const db = getDb();
  const limit = Math.min(500, Math.max(1, Number(params.limit || 200)));
  const rows = db
    .prepare('SELECT * FROM transaction_returns ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown as RawReturnRow[];

  let list = mapReturnRows(db, rows);

  if (params.status && params.status !== 'ALL') {
    list = list.filter((r) => r.status === params.status);
  }
  if (params.disposition && params.disposition !== 'ALL') {
    list = list.filter((r) =>
      r.items.some((i) => i.stockDisposition === params.disposition || i.finalDisposition === params.disposition)
    );
  }
  const q = (params.search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (r) =>
        r.returnNumber.toLowerCase().includes(q) ||
        r.invoiceNumber.toLowerCase().includes(q) ||
        r.receiptNumber.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q) ||
        r.requestedByName.toLowerCase().includes(q) ||
        r.approvedByName.toLowerCase().includes(q) ||
        r.items.some((i) => i.productName.toLowerCase().includes(q))
    );
  }

  return list;
}

export function getReturnById(idOrNumber: string): TransactionReturn {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM transaction_returns WHERE id = ? OR return_number = ? LIMIT 1')
    .get(idOrNumber, idOrNumber) as RawReturnRow | undefined;
  if (!row) {
    throw new ServiceError(404, 'Dokumen retur tidak ditemukan.');
  }
  return mapReturnRows(db, [row])[0];
}

export function listVoidHistory(params: {
  search?: string;
  limit?: number;
}): TransactionVoidRecord[] {
  const db = getDb();
  const limit = Math.min(500, Math.max(1, Number(params.limit || 200)));
  const rows = db
    .prepare('SELECT * FROM transaction_voids ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<Parameters<typeof mapVoidRow>[0]>;

  let list = rows.map(mapVoidRow);
  const q = (params.search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (v) =>
        v.voidNumber.toLowerCase().includes(q) ||
        v.invoiceNumber.toLowerCase().includes(q) ||
        v.receiptNumber.toLowerCase().includes(q) ||
        v.reason.toLowerCase().includes(q) ||
        v.requestedByName.toLowerCase().includes(q) ||
        v.approvedByName.toLowerCase().includes(q)
    );
  }
  return list;
}

export function listRefundRecords(params: {
  search?: string;
  status?: string;
  paymentType?: string;
  sourceType?: string;
  limit?: number;
}): RefundRecord[] {
  const db = getDb();
  const limit = Math.min(500, Math.max(1, Number(params.limit || 200)));
  const rows = db
    .prepare('SELECT * FROM refund_records ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<Parameters<typeof mapRefundRow>[0]>;

  let list = rows.map(mapRefundRow);
  if (params.status && params.status !== 'ALL') {
    list = list.filter((r) => r.status === params.status);
  }
  if (params.paymentType && params.paymentType !== 'ALL') {
    list = list.filter((r) => r.paymentType === params.paymentType);
  }
  if (params.sourceType && params.sourceType !== 'ALL') {
    list = list.filter((r) => r.sourceType === params.sourceType);
  }
  const q = (params.search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (r) =>
        r.refundNumber.toLowerCase().includes(q) ||
        r.sourceNumber.toLowerCase().includes(q) ||
        r.invoiceNumber.toLowerCase().includes(q) ||
        r.referenceNumber.toLowerCase().includes(q) ||
        r.refundMethod.toLowerCase().includes(q) ||
        r.actorName.toLowerCase().includes(q)
    );
  }
  return list;
}

export function updateRefundRecordStatus(
  refundId: string,
  input: {
    status?: unknown;
    referenceNumber?: unknown;
    notes?: unknown;
  },
  actor: UserSummary
): RefundRecord {
  const db = getDb();
  const current = db
    .prepare('SELECT * FROM refund_records WHERE id = ? OR refund_number = ? LIMIT 1')
    .get(refundId, refundId) as Parameters<typeof mapRefundRow>[0] | undefined;

  if (!current) {
    throw new ServiceError(404, 'Catatan refund tidak ditemukan.');
  }

  const rawStatus =
    typeof input.status === 'string' ? input.status.trim().toUpperCase() : '';
  if (!VALID_REFUND_STATUSES.has(rawStatus as RefundRecordStatus)) {
    throw new ServiceError(
      400,
      'Status refund harus COMPLETED, PENDING, MANUAL_RECORDED, atau FAILED.'
    );
  }
  const nextStatus = rawStatus as RefundRecordStatus;
  const referenceNumber =
    input.referenceNumber !== undefined
      ? String(input.referenceNumber ?? '').trim().slice(0, 80)
      : current.reference_number;
  const notes =
    input.notes !== undefined
      ? String(input.notes ?? '').trim().slice(0, 400)
      : current.notes;
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE refund_records
      SET status = ?, reference_number = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(nextStatus, referenceNumber, notes, nowIso, current.id);

    if (current.source_type === 'RETURN') {
      db.prepare(`
        UPDATE transaction_returns
        SET refund_status = ?, refund_reference = ?, updated_at = ?
        WHERE id = ?
      `).run(nextStatus, referenceNumber, nowIso, current.source_id);
    } else if (current.source_type === 'VOID') {
      db.prepare(`
        UPDATE transaction_voids
        SET refund_status = ?, refund_reference = ?
        WHERE id = ?
      `).run(nextStatus, referenceNumber, current.source_id);
    }

    recordAuditLog(db, {
      action: 'REFUND_STATUS_UPDATED',
      entityType: 'refund',
      entityId: current.refund_number,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Status refund ${current.refund_number} (${current.invoice_number}) diperbarui: ${current.status} → ${nextStatus}${referenceNumber ? ` · Ref: ${referenceNumber}` : ''}`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const updated = db
    .prepare('SELECT * FROM refund_records WHERE id = ?')
    .get(current.id) as Parameters<typeof mapRefundRow>[0];
  return mapRefundRow(updated);
}

export function getReturnVoidSummary(): ReturnVoidSummaryStats {
  const db = getDb();
  const totalReturns = (
    db.prepare('SELECT COUNT(*) as cnt FROM transaction_returns').get() as { cnt: number }
  ).cnt;
  const totalVoided = (
    db.prepare('SELECT COUNT(*) as cnt FROM transaction_voids').get() as { cnt: number }
  ).cnt;
  const refundAgg = db
    .prepare(`
      SELECT
        COALESCE(SUM(amount), 0) AS total_amount,
        COALESCE(SUM(CASE WHEN payment_type = 'CASH' THEN amount ELSE 0 END), 0) AS cash_total,
        COALESCE(SUM(CASE WHEN payment_type != 'CASH' THEN amount ELSE 0 END), 0) AS non_cash_total,
        COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending_count
      FROM refund_records
    `)
    .get() as {
    total_amount: number;
    cash_total: number;
    non_cash_total: number;
    pending_count: number;
  };
  const pendingInspectionCount = (
    db
      .prepare(`
        SELECT COUNT(*) as cnt
        FROM transaction_return_items
        WHERE stock_disposition = 'PENDING_INSPECTION' AND final_disposition IS NULL
      `)
      .get() as { cnt: number }
  ).cnt;

  return {
    totalReturns,
    totalVoided,
    totalRefundAmount: Number(refundAgg.total_amount ?? 0),
    cashRefundTotal: Number(refundAgg.cash_total ?? 0),
    nonCashRefundTotal: Number(refundAgg.non_cash_total ?? 0),
    pendingInspectionCount,
    pendingRefundCount: Number(refundAgg.pending_count ?? 0),
  };
}
