import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.ts';
import { recordAuditLog } from './auditService.ts';
import { consumePinApprovalToken } from './authService.ts';
import { listShiftTransactions } from './checkoutService.ts';
import { ServiceError } from './errors.ts';
import type {
  CashDenominationCount,
  CashierShift,
  CashMovement,
  CashMovementType,
  PaymentMethodType,
  ShiftDetailReport,
  ShiftDiscrepancyStatus,
  ShiftListResponse,
  ShiftPaymentBreakdown,
  ShiftReconciliationSummary,
  ShiftSettings,
  ShiftStatus,
  UserSummary,
} from '../../src/types.ts';

const VALID_CASH_MOVEMENT_TYPES: ReadonlySet<CashMovementType> = new Set([
  'CASH_IN',
  'CASH_OUT',
  'EXPENSE',
  'CASH_REFUND',
]);

const VALID_IDR_DENOMINATIONS = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100];

interface DbShiftRow {
  id: string;
  shift_number: string;
  status: ShiftStatus;
  cashier_user_id: string;
  cashier_name: string;
  register_name: string;
  opening_cash: number;
  opening_notes: string;
  opened_at: string;
  closed_at: string | null;
  closed_by_user_id: string | null;
  closed_by_name: string | null;
  cash_sales: number;
  cash_received: number;
  cash_change_given: number;
  cash_refunds: number;
  cash_in_total: number;
  cash_out_total: number;
  expense_total: number;
  non_cash_sales: number;
  total_sales: number;
  transaction_count: number;
  expected_cash: number;
  actual_cash: number | null;
  difference: number | null;
  closing_notes: string;
  closing_denominations_json: string;
  discrepancy_status: ShiftDiscrepancyStatus;
  approved_by_user_id: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  approval_notes: string;
  created_at: string;
  updated_at: string;
}

function nextShiftDocumentNumber(db: DatabaseSync, prefix: 'SHF' | 'CM'): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const seqKey = `${prefix}-${y}${m}${d}`;
  const nowIso = now.toISOString();

  const existing = db
    .prepare('SELECT last_number FROM document_sequences WHERE seq_key = ?')
    .get(seqKey) as { last_number: number } | undefined;

  let nextNum = 1;
  if (!existing) {
    db.prepare('INSERT INTO document_sequences (seq_key, last_number, updated_at) VALUES (?, ?, ?)').run(
      seqKey,
      1,
      nowIso
    );
  } else {
    const updated = db
      .prepare(
        'UPDATE document_sequences SET last_number = last_number + 1, updated_at = ? WHERE seq_key = ? RETURNING last_number'
      )
      .get(nowIso, seqKey) as { last_number: number };
    nextNum = updated.last_number;
  }

  return `${seqKey}-${String(nextNum).padStart(4, '0')}`;
}

function parseNonNegativeInt(raw: unknown, label: string): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
    throw new ServiceError(400, `${label} harus berupa bilangan bulat non-negatif.`);
  }
  return num;
}

function parsePositiveInt(raw: unknown, label: string): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
    throw new ServiceError(400, `${label} harus berupa bilangan bulat lebih dari 0.`);
  }
  return num;
}

function parseDenominations(rawJson: string): CashDenominationCount[] {
  try {
    const parsed = JSON.parse(rawJson || '[]');
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (d): d is CashDenominationCount =>
          Boolean(d) &&
          typeof d === 'object' &&
          typeof d.denomination === 'number' &&
          typeof d.qty === 'number'
      );
    }
  } catch {
    // ignore malformed json
  }
  return [];
}

function normalizeClosingDenominations(raw: unknown): CashDenominationCount[] {
  if (!Array.isArray(raw)) return [];
  const normalized: CashDenominationCount[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as { denomination?: unknown; qty?: unknown; label?: unknown };
    const denomination = Number(obj.denomination);
    const qty = Number(obj.qty ?? 0);
    if (
      !Number.isInteger(denomination) ||
      denomination <= 0 ||
      !VALID_IDR_DENOMINATIONS.includes(denomination)
    ) {
      throw new ServiceError(400, `Pecahan kas Rp ${obj.denomination} tidak dikenali.`);
    }
    if (!Number.isInteger(qty) || qty < 0) {
      throw new ServiceError(400, `Jumlah lembar/koin untuk pecahan Rp ${denomination} tidak valid.`);
    }
    if (qty > 0) {
      normalized.push({
        denomination,
        label:
          typeof obj.label === 'string' && obj.label.trim()
            ? obj.label.trim()
            : `Rp ${denomination.toLocaleString('id-ID')}`,
        qty,
        subtotal: denomination * qty,
      });
    }
  }
  return normalized.sort((a, b) => b.denomination - a.denomination);
}

export function getShiftSettings(): ShiftSettings {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT require_open_shift_for_sales, allow_duplicate_open_shifts,
             require_supervisor_approval_on_discrepancy, discrepancy_tolerance_rp, updated_at
      FROM shift_settings
      WHERE id = 1
    `)
    .get() as
    | {
        require_open_shift_for_sales: number;
        allow_duplicate_open_shifts: number;
        require_supervisor_approval_on_discrepancy: number;
        discrepancy_tolerance_rp: number;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    return {
      requireOpenShiftForSales: true,
      allowDuplicateOpenShifts: false,
      requireSupervisorApprovalOnDiscrepancy: true,
      discrepancyToleranceRp: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    requireOpenShiftForSales: row.require_open_shift_for_sales === 1,
    allowDuplicateOpenShifts: row.allow_duplicate_open_shifts === 1,
    requireSupervisorApprovalOnDiscrepancy: row.require_supervisor_approval_on_discrepancy === 1,
    discrepancyToleranceRp: Number(row.discrepancy_tolerance_rp ?? 0),
    updatedAt: row.updated_at,
  };
}

export function updateShiftSettings(
  input: {
    requireOpenShiftForSales?: unknown;
    allowDuplicateOpenShifts?: unknown;
    requireSupervisorApprovalOnDiscrepancy?: unknown;
    discrepancyToleranceRp?: unknown;
  },
  actor: UserSummary
): ShiftSettings {
  const db = getDb();
  const current = getShiftSettings();

  const requireOpenShiftForSales =
    typeof input.requireOpenShiftForSales === 'boolean'
      ? input.requireOpenShiftForSales
      : current.requireOpenShiftForSales;
  const allowDuplicateOpenShifts =
    typeof input.allowDuplicateOpenShifts === 'boolean'
      ? input.allowDuplicateOpenShifts
      : current.allowDuplicateOpenShifts;
  const requireSupervisorApprovalOnDiscrepancy =
    typeof input.requireSupervisorApprovalOnDiscrepancy === 'boolean'
      ? input.requireSupervisorApprovalOnDiscrepancy
      : current.requireSupervisorApprovalOnDiscrepancy;
  const discrepancyToleranceRp =
    input.discrepancyToleranceRp !== undefined
      ? parseNonNegativeInt(input.discrepancyToleranceRp, 'Toleransi selisih kas')
      : current.discrepancyToleranceRp;

  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE shift_settings
    SET require_open_shift_for_sales = ?,
        allow_duplicate_open_shifts = ?,
        require_supervisor_approval_on_discrepancy = ?,
        discrepancy_tolerance_rp = ?,
        updated_at = ?
    WHERE id = 1
  `).run(
    requireOpenShiftForSales ? 1 : 0,
    allowDuplicateOpenShifts ? 1 : 0,
    requireSupervisorApprovalOnDiscrepancy ? 1 : 0,
    discrepancyToleranceRp,
    nowIso
  );

  recordAuditLog(db, {
    action: 'SHIFT_SETTINGS_UPDATED',
    entityType: 'shift',
    entityId: 'shift-settings-1',
    actorUserId: actor.id,
    actor: actor.fullName,
    summary: `Konfigurasi buka/tutup toko diperbarui (Wajib buka toko: ${requireOpenShiftForSales ? 'Ya' : 'Tidak'}, Izin multi-sesi: ${allowDuplicateOpenShifts ? 'Ya' : 'Tidak'}, Toleransi selisih: Rp ${discrepancyToleranceRp.toLocaleString('id-ID')})`,
  });

  return getShiftSettings();
}

export function computeShiftReconciliationTx(
  db: DatabaseSync,
  shiftRow: Pick<DbShiftRow, 'id' | 'opening_cash' | 'actual_cash'>
): {
  reconciliation: ShiftReconciliationSummary;
  paymentBreakdown: ShiftPaymentBreakdown[];
} {
  const txCountRow = db
    .prepare(`
      SELECT COUNT(*) as cnt, COALESCE(SUM(total), 0) as total_sales
      FROM transactions
      WHERE shift_id = ? AND status = 'COMPLETED'
    `)
    .get(shiftRow.id) as { cnt: number; total_sales: number };

  const payRows = db
    .prepare(`
      SELECT tp.payment_method_name,
             tp.payment_type,
             COUNT(DISTINCT t.id) as trx_count,
             COALESCE(SUM(tp.amount), 0) as total_amount,
             COALESCE(SUM(tp.tendered_amount), 0) as total_tendered,
             COALESCE(SUM(tp.change_amount), 0) as total_change
      FROM transaction_payments tp
      INNER JOIN transactions t ON t.id = tp.transaction_id
      WHERE t.shift_id = ? AND t.status = 'COMPLETED'
      GROUP BY tp.payment_method_name, tp.payment_type
      ORDER BY total_amount DESC, tp.payment_method_name ASC
    `)
    .all(shiftRow.id) as Array<{
    payment_method_name: string;
    payment_type: PaymentMethodType;
    trx_count: number;
    total_amount: number;
    total_tendered: number;
    total_change: number;
  }>;

  let cashSalesBig = 0n;
  let cashReceivedBig = 0n;
  let cashChangeBig = 0n;
  let nonCashSalesBig = 0n;

  const paymentBreakdown: ShiftPaymentBreakdown[] = payRows.map((r) => {
    const amtBig = BigInt(Math.round(Number(r.total_amount || 0)));
    const tenderedBig = BigInt(Math.round(Number(r.total_tendered || 0)));
    const changeBig = BigInt(Math.round(Number(r.total_change || 0)));
    if (r.payment_type === 'CASH') {
      cashSalesBig += amtBig;
      cashReceivedBig += tenderedBig;
      cashChangeBig += changeBig;
    } else {
      nonCashSalesBig += amtBig;
    }
    return {
      paymentMethodName: r.payment_method_name,
      paymentType: r.payment_type,
      transactionCount: Number(r.trx_count || 0),
      amount: Number(amtBig),
      tenderedAmount: Number(tenderedBig),
      changeAmount: Number(changeBig),
    };
  });

  const movRows = db
    .prepare(`
      SELECT type, COALESCE(SUM(amount), 0) as total_amount
      FROM cash_movements
      WHERE shift_id = ?
      GROUP BY type
    `)
    .all(shiftRow.id) as Array<{ type: CashMovementType; total_amount: number }>;

  let cashInBig = 0n;
  let cashOutBig = 0n;
  let expenseBig = 0n;
  let cashRefundsBig = 0n;

  for (const m of movRows) {
    const val = BigInt(Math.round(Number(m.total_amount || 0)));
    if (m.type === 'CASH_IN') cashInBig += val;
    else if (m.type === 'CASH_OUT') cashOutBig += val;
    else if (m.type === 'EXPENSE') expenseBig += val;
    else if (m.type === 'CASH_REFUND') cashRefundsBig += val;
  }

  const openingBig = BigInt(Math.round(Number(shiftRow.opening_cash || 0)));
  const cashOutCombinedBig = cashOutBig + expenseBig;
  const expectedCashBig =
    openingBig + cashSalesBig + cashInBig - cashOutCombinedBig - cashRefundsBig;

  const actualCash = shiftRow.actual_cash !== null && shiftRow.actual_cash !== undefined
    ? Number(shiftRow.actual_cash)
    : null;
  const difference =
    actualCash !== null ? Number(BigInt(actualCash) - expectedCashBig) : null;

  return {
    reconciliation: {
      openingCash: Number(openingBig),
      cashSales: Number(cashSalesBig),
      cashReceived: Number(cashReceivedBig),
      cashChangeGiven: Number(cashChangeBig),
      cashRefunds: Number(cashRefundsBig),
      cashInTotal: Number(cashInBig),
      cashOutTotal: Number(cashOutBig),
      expenseTotal: Number(expenseBig),
      cashOutCombined: Number(cashOutCombinedBig),
      nonCashSales: Number(nonCashSalesBig),
      totalSales: Number(txCountRow.total_sales || 0),
      transactionCount: Number(txCountRow.cnt || 0),
      expectedCash: Number(expectedCashBig),
      actualCash,
      difference,
    },
    paymentBreakdown,
  };
}

function mapShiftRow(db: DatabaseSync, row: DbShiftRow): CashierShift {
  if (row.status === 'OPEN') {
    const { reconciliation } = computeShiftReconciliationTx(db, row);
    return {
      id: row.id,
      shiftNumber: row.shift_number,
      status: row.status,
      cashierUserId: row.cashier_user_id,
      cashierName: row.cashier_name,
      openedByUserId: row.cashier_user_id,
      openedByName: row.cashier_name,
      registerName: row.register_name,
      openingCash: reconciliation.openingCash,
      openingNotes: row.opening_notes,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      closedByUserId: row.closed_by_user_id,
      closedByName: row.closed_by_name,
      cashSales: reconciliation.cashSales,
      cashReceived: reconciliation.cashReceived,
      cashChangeGiven: reconciliation.cashChangeGiven,
      cashRefunds: reconciliation.cashRefunds,
      cashInTotal: reconciliation.cashInTotal,
      cashOutTotal: reconciliation.cashOutTotal,
      expenseTotal: reconciliation.expenseTotal,
      nonCashSales: reconciliation.nonCashSales,
      totalSales: reconciliation.totalSales,
      transactionCount: reconciliation.transactionCount,
      expectedCash: reconciliation.expectedCash,
      actualCash: null,
      difference: null,
      closingNotes: row.closing_notes,
      closingDenominations: parseDenominations(row.closing_denominations_json),
      discrepancyStatus: row.discrepancy_status,
      approvedByUserId: row.approved_by_user_id,
      approvedByName: row.approved_by_name,
      approvedAt: row.approved_at,
      approvalNotes: row.approval_notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return {
    id: row.id,
    shiftNumber: row.shift_number,
    status: row.status,
    cashierUserId: row.cashier_user_id,
    cashierName: row.cashier_name,
    openedByUserId: row.cashier_user_id,
    openedByName: row.cashier_name,
    registerName: row.register_name,
    openingCash: row.opening_cash,
    openingNotes: row.opening_notes,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    closedByUserId: row.closed_by_user_id,
    closedByName: row.closed_by_name,
    cashSales: row.cash_sales,
    cashReceived: row.cash_received,
    cashChangeGiven: row.cash_change_given,
    cashRefunds: row.cash_refunds,
    cashInTotal: row.cash_in_total,
    cashOutTotal: row.cash_out_total,
    expenseTotal: row.expense_total,
    nonCashSales: row.non_cash_sales,
    totalSales: row.total_sales,
    transactionCount: row.transaction_count,
    expectedCash: row.expected_cash,
    actualCash: row.actual_cash,
    difference: row.difference,
    closingNotes: row.closing_notes,
    closingDenominations: parseDenominations(row.closing_denominations_json),
    discrepancyStatus: row.discrepancy_status,
    approvedByUserId: row.approved_by_user_id,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at,
    approvalNotes: row.approval_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function canViewStoreSessions(actor: UserSummary): boolean {
  return (
    actor.permissions.includes('shifts:view') ||
    actor.permissions.includes('shifts:open') ||
    actor.permissions.includes('shifts:close') ||
    actor.permissions.includes('shifts:cash_movement') ||
    actor.permissions.includes('shifts:approve') ||
    actor.permissions.includes('shifts:manage') ||
    actor.permissions.includes('reports:view') ||
    actor.permissions.includes('pos:view')
  );
}

export function getActiveShiftForUser(_userId?: string): CashierShift | null {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT * FROM cashier_shifts
      WHERE status = 'OPEN'
      ORDER BY opened_at DESC, rowid DESC
      LIMIT 1
    `)
    .get() as DbShiftRow | undefined;

  return row ? mapShiftRow(db, row) : null;
}

export function openShift(
  input: {
    openingCash?: unknown;
    registerName?: unknown;
    openingNotes?: unknown;
  },
  actor: UserSummary
): CashierShift {
  const db = getDb();
  const settings = getShiftSettings();
  const openingCash = parseNonNegativeInt(input.openingCash ?? 0, 'Modal awal kas (Opening Cash)');
  const registerName =
    typeof input.registerName === 'string' && input.registerName.trim()
      ? input.registerName.trim().slice(0, 60)
      : 'Kasir Utama';
  const openingNotes =
    typeof input.openingNotes === 'string' ? input.openingNotes.trim().slice(0, 400) : '';

  const nowIso = new Date().toISOString();
  const shiftId = `shf-${Date.now()}-${randomUUID().slice(0, 6)}`;

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (!settings.allowDuplicateOpenShifts) {
      const existingOpen = db
        .prepare(`
          SELECT id, shift_number, cashier_name
          FROM cashier_shifts
          WHERE status = 'OPEN'
          ORDER BY opened_at DESC
          LIMIT 1
        `)
        .get() as { id: string; shift_number: string; cashier_name: string } | undefined;
      if (existingOpen) {
        throw new ServiceError(
          409,
          `Toko sudah dibuka oleh "${existingOpen.cashier_name}" (${existingOpen.shift_number}). User lain tidak perlu membuka toko lagi sebelum Tutup Toko.`,
          'SHIFT_ALREADY_OPEN'
        );
      }
    }

    const shiftNumber = nextShiftDocumentNumber(db, 'SHF');
    db.prepare(`
      INSERT INTO cashier_shifts (
        id, shift_number, status, cashier_user_id, cashier_name, register_name,
        opening_cash, opening_notes, opened_at, expected_cash,
        discrepancy_status, created_at, updated_at
      ) VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, 'NONE', ?, ?)
    `).run(
      shiftId,
      shiftNumber,
      actor.id,
      actor.fullName,
      registerName,
      openingCash,
      openingNotes,
      nowIso,
      openingCash,
      nowIso,
      nowIso
    );

    recordAuditLog(db, {
      action: 'SHIFT_OPENED',
      entityType: 'shift',
      entityId: shiftId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Buka toko ${shiftNumber} (${registerName}) oleh ${actor.fullName} dengan modal awal Rp ${openingCash.toLocaleString('id-ID')}`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const created = db.prepare('SELECT * FROM cashier_shifts WHERE id = ?').get(shiftId) as unknown as DbShiftRow;
  return mapShiftRow(db, created);
}

export function listCashMovementsByShift(shiftId: string): CashMovement[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT id, shift_id, movement_number, type, amount, reason, reference_number, notes,
             actor_user_id, actor_name, created_at
      FROM cash_movements
      WHERE shift_id = ?
      ORDER BY created_at DESC, rowid DESC
    `)
    .all(shiftId) as Array<{
    id: string;
    shift_id: string;
    movement_number: string;
    type: CashMovementType;
    amount: number;
    reason: string;
    reference_number: string;
    notes: string;
    actor_user_id: string | null;
    actor_name: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    shiftId: r.shift_id,
    movementNumber: r.movement_number,
    type: r.type,
    amount: r.amount,
    reason: r.reason,
    referenceNumber: r.reference_number,
    notes: r.notes,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    createdAt: r.created_at,
  }));
}

export function recordCashMovement(
  shiftId: string,
  input: {
    type?: unknown;
    amount?: unknown;
    reason?: unknown;
    referenceNumber?: unknown;
    notes?: unknown;
  },
  actor: UserSummary
): { movement: CashMovement; shift: CashierShift } {
  const db = getDb();
  const type = String(input.type ?? '').trim().toUpperCase() as CashMovementType;
  if (!VALID_CASH_MOVEMENT_TYPES.has(type)) {
    throw new ServiceError(
      400,
      'Jenis mutasi kas tidak valid. Gunakan CASH_IN, CASH_OUT, EXPENSE, atau CASH_REFUND.'
    );
  }

  const amount = parsePositiveInt(input.amount, 'Nominal mutasi kas');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) {
    throw new ServiceError(400, 'Alasan / keterangan mutasi kas wajib diisi.');
  }
  const referenceInput =
    typeof input.referenceNumber === 'string' ? input.referenceNumber.trim().slice(0, 64) : '';
  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 400) : '';

  const shiftRow = db
    .prepare('SELECT * FROM cashier_shifts WHERE id = ?')
    .get(shiftId) as DbShiftRow | undefined;

  if (!shiftRow) {
    throw new ServiceError(404, 'Sesi buka toko tidak ditemukan.');
  }
  if (shiftRow.status !== 'OPEN') {
    throw new ServiceError(409, 'Mutasi kas hanya dapat dicatat saat toko masih berstatus BUKA (OPEN).');
  }

  const movId = `cm-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    const movNumber = nextShiftDocumentNumber(db, 'CM');
    const finalRef = referenceInput || movNumber;

    db.prepare(`
      INSERT INTO cash_movements (
        id, shift_id, movement_number, type, amount, reason, reference_number, notes,
        actor_user_id, actor_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      movId,
      shiftId,
      movNumber,
      type,
      amount,
      reason,
      finalRef,
      notes,
      actor.id,
      actor.fullName,
      nowIso
    );

    const { reconciliation } = computeShiftReconciliationTx(db, shiftRow);
    db.prepare(`
      UPDATE cashier_shifts
      SET cash_in_total = ?, cash_out_total = ?, expense_total = ?, cash_refunds = ?, expected_cash = ?, updated_at = ?
      WHERE id = ?
    `).run(
      reconciliation.cashInTotal,
      reconciliation.cashOutTotal,
      reconciliation.expenseTotal,
      reconciliation.cashRefunds,
      reconciliation.expectedCash,
      nowIso,
      shiftId
    );

    const typeLabel =
      type === 'CASH_IN'
        ? 'Kas Masuk'
        : type === 'CASH_OUT'
        ? 'Kas Keluar'
        : type === 'EXPENSE'
        ? 'Pengeluaran Laci'
        : 'Refund Tunai';

    recordAuditLog(db, {
      action: 'CASH_MOVEMENT_RECORDED',
      entityType: 'cash_movement',
      entityId: movId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `${typeLabel} ${movNumber} pada shift ${shiftRow.shift_number}: Rp ${amount.toLocaleString('id-ID')} (${reason})`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const updatedShift = db.prepare('SELECT * FROM cashier_shifts WHERE id = ?').get(shiftId) as unknown as DbShiftRow;
  const createdMovement = listCashMovementsByShift(shiftId).find((m) => m.id === movId)!;
  return {
    movement: createdMovement,
    shift: mapShiftRow(db, updatedShift),
  };
}

export function closeShift(
  shiftId: string,
  input: {
    actualCash?: unknown;
    closingNotes?: unknown;
    denominations?: unknown;
    confirmed?: unknown;
    supervisorPinToken?: unknown;
  },
  actor: UserSummary
): ShiftDetailReport {
  const db = getDb();
  if (input.confirmed !== true) {
    throw new ServiceError(400, 'Harap centang konfirmasi tutup kasir sebelum menutup shift.');
  }

  const denominations = normalizeClosingDenominations(input.denominations);
  const actualCash =
    input.actualCash !== undefined && input.actualCash !== null && input.actualCash !== ''
      ? parseNonNegativeInt(input.actualCash, 'Total kas fisik aktual')
      : denominations.length > 0
      ? denominations.reduce((sum, d) => sum + d.subtotal, 0)
      : (() => {
          throw new ServiceError(400, 'Nominal kas fisik aktual wajib diisi.');
        })();

  const closingNotes =
    typeof input.closingNotes === 'string' ? input.closingNotes.trim().slice(0, 500) : '';
  const supervisorPinToken =
    typeof input.supervisorPinToken === 'string' ? input.supervisorPinToken.trim() : '';

  const settings = getShiftSettings();
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    const shiftRow = db
      .prepare('SELECT * FROM cashier_shifts WHERE id = ?')
      .get(shiftId) as DbShiftRow | undefined;

    if (!shiftRow) {
      throw new ServiceError(404, 'Sesi buka toko tidak ditemukan.');
    }
    if (shiftRow.status !== 'OPEN') {
      throw new ServiceError(409, 'Toko sudah ditutup oleh petugas lain sebelumnya.');
    }

    const { reconciliation } = computeShiftReconciliationTx(db, {
      id: shiftRow.id,
      opening_cash: shiftRow.opening_cash,
      actual_cash: actualCash,
    });

    const difference = Number(reconciliation.difference ?? 0);
    const absDiff = Math.abs(difference);

    let discrepancyStatus: ShiftDiscrepancyStatus = 'MATCHED';
    let approvedByUserId: string | null = null;
    let approvedByName: string | null = null;
    let approvedAt: string | null = null;
    let approvalNotes = '';

    if (absDiff > settings.discrepancyToleranceRp && settings.requireSupervisorApprovalOnDiscrepancy) {
      if (actor.permissions.includes('shifts:approve')) {
        discrepancyStatus = 'APPROVED';
        approvedByUserId = actor.id;
        approvedByName = actor.fullName;
        approvedAt = nowIso;
        approvalNotes = 'Disetujui otomatis oleh Supervisor/Admin saat tutup shift';
      } else if (supervisorPinToken) {
        const { authorizerUserId } = consumePinApprovalToken(
          db,
          supervisorPinToken,
          'shift_discrepancy'
        );
        const authorizerRow = db
          .prepare('SELECT full_name FROM users WHERE id = ?')
          .get(authorizerUserId) as { full_name: string } | undefined;
        discrepancyStatus = 'APPROVED';
        approvedByUserId = authorizerUserId;
        approvedByName = authorizerRow?.full_name ?? 'Supervisor';
        approvedAt = nowIso;
        approvalNotes = 'Disetujui via PIN Supervisor saat tutup shift';
      } else {
        discrepancyStatus = 'PENDING_APPROVAL';
      }
    }

    db.prepare(`
      UPDATE cashier_shifts
      SET status = 'CLOSED',
          closed_at = ?,
          closed_by_user_id = ?,
          closed_by_name = ?,
          cash_sales = ?,
          cash_received = ?,
          cash_change_given = ?,
          cash_refunds = ?,
          cash_in_total = ?,
          cash_out_total = ?,
          expense_total = ?,
          non_cash_sales = ?,
          total_sales = ?,
          transaction_count = ?,
          expected_cash = ?,
          actual_cash = ?,
          difference = ?,
          closing_notes = ?,
          closing_denominations_json = ?,
          discrepancy_status = ?,
          approved_by_user_id = ?,
          approved_by_name = ?,
          approved_at = ?,
          approval_notes = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      nowIso,
      actor.id,
      actor.fullName,
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
      actualCash,
      difference,
      closingNotes,
      JSON.stringify(denominations),
      discrepancyStatus,
      approvedByUserId,
      approvedByName,
      approvedAt,
      approvalNotes,
      nowIso,
      shiftId
    );

    const diffLabel =
      difference === 0
        ? 'Pas (Rp 0)'
        : difference > 0
        ? `Lebih +Rp ${difference.toLocaleString('id-ID')}`
        : `Kurang -Rp ${Math.abs(difference).toLocaleString('id-ID')}`;

    recordAuditLog(db, {
      action: 'SHIFT_CLOSED',
      entityType: 'shift',
      entityId: shiftId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Tutup toko ${shiftRow.shift_number} oleh ${actor.fullName} (dibuka oleh ${shiftRow.cashier_name}): Kas seharusnya Rp ${reconciliation.expectedCash.toLocaleString('id-ID')}, Kas aktual Rp ${actualCash.toLocaleString('id-ID')}, Selisih ${diffLabel} [${discrepancyStatus}]`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getShiftReport(shiftId, actor);
}

export function approveShiftDiscrepancy(
  shiftId: string,
  input: { approvalNotes?: unknown },
  actor: UserSummary
): ShiftDetailReport {
  const db = getDb();
  const approvalNotes =
    typeof input.approvalNotes === 'string' && input.approvalNotes.trim()
      ? input.approvalNotes.trim().slice(0, 400)
      : 'Disetujui oleh Supervisor/Admin';
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    const shiftRow = db
      .prepare('SELECT * FROM cashier_shifts WHERE id = ?')
      .get(shiftId) as DbShiftRow | undefined;

    if (!shiftRow) {
      throw new ServiceError(404, 'Shift kasir tidak ditemukan.');
    }
    if (shiftRow.status !== 'CLOSED') {
      throw new ServiceError(409, 'Shift masih berstatus OPEN dan belum ditutup.');
    }
    if (shiftRow.discrepancy_status !== 'PENDING_APPROVAL') {
      throw new ServiceError(409, 'Shift ini tidak sedang menunggu persetujuan selisih kas.');
    }

    db.prepare(`
      UPDATE cashier_shifts
      SET discrepancy_status = 'APPROVED',
          approved_by_user_id = ?,
          approved_by_name = ?,
          approved_at = ?,
          approval_notes = ?,
          updated_at = ?
      WHERE id = ?
    `).run(actor.id, actor.fullName, nowIso, approvalNotes, nowIso, shiftId);

    const diff = Number(shiftRow.difference ?? 0);
    recordAuditLog(db, {
      action: 'SHIFT_DISCREPANCY_APPROVED',
      entityType: 'shift',
      entityId: shiftId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Selisih kas shift ${shiftRow.shift_number} (${diff >= 0 ? '+' : '-'}Rp ${Math.abs(diff).toLocaleString('id-ID')}) disetujui oleh ${actor.fullName} (${approvalNotes})`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getShiftReport(shiftId, actor);
}

export function listShifts(
  params: {
    search?: string;
    status?: string;
    discrepancyStatus?: string;
    cashierUserId?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    pageSize?: number;
  },
  actor: UserSummary
): ShiftListResponse {
  const db = getDb();
  if (!canViewStoreSessions(actor)) {
    throw new ServiceError(403, 'Anda tidak memiliki izin melihat riwayat buka/tutup toko.');
  }

  const rows = db
    .prepare('SELECT * FROM cashier_shifts ORDER BY opened_at DESC, rowid DESC LIMIT 500')
    .all() as unknown as DbShiftRow[];

  let mapped = rows.map((r) => mapShiftRow(db, r));

  if (params.status && params.status !== 'ALL') {
    mapped = mapped.filter((s) => s.status === params.status);
  }
  if (params.discrepancyStatus && params.discrepancyStatus !== 'ALL') {
    mapped = mapped.filter((s) => s.discrepancyStatus === params.discrepancyStatus);
  }
  if (params.cashierUserId) {
    mapped = mapped.filter(
      (s) => s.cashierUserId === params.cashierUserId || s.closedByUserId === params.cashierUserId
    );
  }
  if (params.dateFrom) {
    mapped = mapped.filter((s) => s.openedAt.slice(0, 10) >= params.dateFrom!);
  }
  if (params.dateTo) {
    mapped = mapped.filter((s) => s.openedAt.slice(0, 10) <= params.dateTo!);
  }
  const q = (params.search ?? '').trim().toLowerCase();
  if (q) {
    mapped = mapped.filter(
      (s) =>
        s.shiftNumber.toLowerCase().includes(q) ||
        s.cashierName.toLowerCase().includes(q) ||
        (s.closedByName ?? '').toLowerCase().includes(q) ||
        s.registerName.toLowerCase().includes(q) ||
        s.openingNotes.toLowerCase().includes(q) ||
        s.closingNotes.toLowerCase().includes(q)
    );
  }

  const total = mapped.length;
  const pageSize = Math.min(100, Math.max(1, Number(params.pageSize || 25)));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(params.page || 1)));
  const start = (page - 1) * pageSize;

  return {
    shifts: mapped.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    totalPages,
  };
}

export function getShiftReport(shiftId: string, actor: UserSummary): ShiftDetailReport {
  const db = getDb();
  if (!canViewStoreSessions(actor)) {
    throw new ServiceError(403, 'Anda tidak memiliki izin melihat laporan operasional toko.');
  }
  const row = db
    .prepare('SELECT * FROM cashier_shifts WHERE id = ? OR shift_number = ?')
    .get(shiftId, shiftId) as DbShiftRow | undefined;

  if (!row) {
    throw new ServiceError(404, 'Sesi buka/tutup toko tidak ditemukan.');
  }

  const shift = mapShiftRow(db, row);
  const { reconciliation, paymentBreakdown } = computeShiftReconciliationTx(db, row);
  const cashMovements = listCashMovementsByShift(row.id);
  const transactions = listShiftTransactions(row.id);
  const settings = getShiftSettings();

  return {
    shift,
    reconciliation,
    paymentBreakdown,
    cashMovements,
    transactions,
    settings,
  };
}
