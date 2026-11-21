import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.ts';
import { recordAuditLog } from './auditService.ts';
import { ServiceError } from './errors.ts';
import type {
  Customer,
  LoyaltyPointTransaction,
  LoyaltySettings,
  Transaction,
  UserSummary,
} from '../../src/types.ts';

interface CustomerDbRow {
  id: string;
  code: string;
  membership_number: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  is_active: number;
  loyalty_points: number;
  total_points_earned: number;
  total_points_redeemed: number;
  total_spending: number;
  transaction_count: number;
  last_purchase_date: string | null;
  created_at: string;
  updated_at: string;
}

function mapCustomerRow(r: CustomerDbRow): Customer {
  return {
    id: r.id,
    code: r.code,
    membershipNumber: r.membership_number || '',
    name: r.name,
    phone: r.phone,
    email: r.email,
    address: r.address,
    notes: r.notes,
    isActive: r.is_active === 1,
    loyaltyPoints: Number(r.loyalty_points ?? 0),
    totalPointsEarned: Number(r.total_points_earned ?? 0),
    totalPointsRedeemed: Number(r.total_points_redeemed ?? 0),
    totalSpending: Number(r.total_spending ?? 0),
    transactionCount: Number(r.transaction_count ?? 0),
    lastPurchaseDate: r.last_purchase_date ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CUSTOMER_AGGREGATE_QUERY = `
  SELECT
    c.id,
    c.code,
    c.membership_number,
    c.name,
    c.phone,
    c.email,
    c.address,
    c.notes,
    c.is_active,
    c.loyalty_points,
    c.total_points_earned,
    c.total_points_redeemed,
    COALESCE(agg.total_spending, 0) AS total_spending,
    COALESCE(agg.transaction_count, 0) AS transaction_count,
    agg.last_purchase_date AS last_purchase_date,
    c.created_at,
    c.updated_at
  FROM customers c
  LEFT JOIN (
    SELECT
      customer_id,
      SUM(CASE WHEN total > COALESCE(refunded_total, 0) THEN total - COALESCE(refunded_total, 0) ELSE 0 END) AS total_spending,
      COUNT(*) AS transaction_count,
      MAX(COALESCE(completed_at, created_at)) AS last_purchase_date
    FROM transactions
    WHERE status = 'COMPLETED' AND customer_id IS NOT NULL
    GROUP BY customer_id
  ) agg ON agg.customer_id = c.id
`;

export function listCustomersWithMetrics(params?: {
  search?: string;
  status?: string;
}): Customer[] {
  const db = getDb();
  const rows = db
    .prepare(`${CUSTOMER_AGGREGATE_QUERY} ORDER BY c.name ASC`)
    .all() as unknown as CustomerDbRow[];

  let list = rows.map(mapCustomerRow);

  const statusFilter = (params?.status ?? 'ALL').toUpperCase();
  if (statusFilter === 'ACTIVE') {
    list = list.filter((c) => c.isActive);
  } else if (statusFilter === 'INACTIVE') {
    list = list.filter((c) => !c.isActive);
  }

  const q = (params?.search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.membershipNumber.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q)
    );
  }

  return list;
}

export function getCustomerById(id: string): Customer {
  const db = getDb();
  const row = db
    .prepare(`${CUSTOMER_AGGREGATE_QUERY} WHERE c.id = ?`)
    .get(id) as CustomerDbRow | undefined;
  if (!row) {
    throw new ServiceError(404, 'Pelanggan tidak ditemukan.');
  }
  return mapCustomerRow(row);
}

export function listLoyaltyHistory(customerId: string, limit = 100): LoyaltyPointTransaction[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT id, customer_id, transaction_id, type, points_delta, points_before, points_after,
             reference_number, notes, actor_user_id, actor_name, created_at
      FROM loyalty_point_transactions
      WHERE customer_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(customerId, limit) as Array<{
    id: string;
    customer_id: string;
    transaction_id: string | null;
    type: 'EARN' | 'REDEEM' | 'ADJUST';
    points_delta: number;
    points_before: number;
    points_after: number;
    reference_number: string;
    notes: string;
    actor_user_id: string | null;
    actor_name: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    transactionId: r.transaction_id,
    type: r.type,
    pointsDelta: r.points_delta,
    pointsBefore: r.points_before,
    pointsAfter: r.points_after,
    referenceNumber: r.reference_number,
    notes: r.notes,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    createdAt: r.created_at,
  }));
}

export function getCustomerDetail(
  id: string,
  fetchCustomerTransactions: (customerId: string) => Transaction[]
): {
  customer: Customer;
  transactions: Transaction[];
  loyaltyHistory: LoyaltyPointTransaction[];
} {
  const customer = getCustomerById(id);
  const transactions = fetchCustomerTransactions(id);
  const loyaltyHistory = listLoyaltyHistory(id, 150);
  return { customer, transactions, loyaltyHistory };
}

function validateCustomerFields(input: {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  address?: unknown;
  notes?: unknown;
  membershipNumber?: unknown;
}) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length < 2) {
    throw new ServiceError(400, 'Nama pelanggan wajib diisi (minimal 2 karakter).');
  }

  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  if (phone && !/^[0-9+\-\s()]{6,25}$/.test(phone)) {
    throw new ServiceError(400, 'Format nomor telepon tidak valid.');
  }

  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ServiceError(400, 'Format alamat email tidak valid.');
  }

  const address = typeof input.address === 'string' ? input.address.trim() : '';
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  const membershipNumber =
    typeof input.membershipNumber === 'string' ? input.membershipNumber.trim().toUpperCase() : '';

  if (membershipNumber && !/^[A-Z0-9_-]{3,40}$/.test(membershipNumber)) {
    throw new ServiceError(
      400,
      'Nomor keanggotaan hanya boleh huruf, angka, tanda hubung (-), atau garis bawah (_), 3–40 karakter.'
    );
  }

  return { name, phone, email, address, notes, membershipNumber };
}

function generateNextCustomerCode(db: DatabaseSync): string {
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM customers').get() as { cnt: number };
  let seq = countRow.cnt + 1;
  while (true) {
    const cand = `CUST-${String(seq).padStart(4, '0')}`;
    if (!db.prepare('SELECT 1 FROM customers WHERE code = ?').get(cand)) {
      return cand;
    }
    seq++;
  }
}

function generateNextMembershipNumber(db: DatabaseSync): string {
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM customers').get() as { cnt: number };
  let seq = countRow.cnt + 1;
  while (true) {
    const cand = `MBR-${String(seq).padStart(4, '0')}`;
    if (!db.prepare('SELECT 1 FROM customers WHERE membership_number = ?').get(cand)) {
      return cand;
    }
    seq++;
  }
}

export function createCustomerProfile(
  input: {
    name?: unknown;
    phone?: unknown;
    email?: unknown;
    address?: unknown;
    notes?: unknown;
    membershipNumber?: unknown;
    isActive?: unknown;
  },
  actor: UserSummary
): Customer {
  const fields = validateCustomerFields(input);
  const db = getDb();

  const membershipNumber = fields.membershipNumber || generateNextMembershipNumber(db);
  const dupMember = db
    .prepare('SELECT id, name FROM customers WHERE LOWER(membership_number) = LOWER(?)')
    .get(membershipNumber) as { id: string; name: string } | undefined;
  if (dupMember) {
    throw new ServiceError(
      409,
      `Nomor keanggotaan "${membershipNumber}" sudah digunakan oleh ${dupMember.name}.`
    );
  }

  const code = generateNextCustomerCode(db);
  const id = `cust-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const nowIso = new Date().toISOString();
  const isActive = input.isActive === false ? 0 : 1;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO customers (
        id, code, membership_number, name, phone, email, address, notes,
        is_active, loyalty_points, total_points_earned, total_points_redeemed,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
    `).run(
      id,
      code,
      membershipNumber,
      fields.name,
      fields.phone,
      fields.email,
      fields.address,
      fields.notes,
      isActive,
      nowIso,
      nowIso
    );

    recordAuditLog(db, {
      action: 'CUSTOMER_CREATED',
      entityType: 'customer',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Tambah pelanggan "${fields.name}" (${code} · ${membershipNumber})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getCustomerById(id);
}

export function updateCustomerProfile(
  id: string,
  input: {
    name?: unknown;
    phone?: unknown;
    email?: unknown;
    address?: unknown;
    notes?: unknown;
    membershipNumber?: unknown;
    isActive?: unknown;
  },
  actor: UserSummary
): Customer {
  const current = getCustomerById(id);
  const fields = validateCustomerFields({
    name: input.name !== undefined ? input.name : current.name,
    phone: input.phone !== undefined ? input.phone : current.phone,
    email: input.email !== undefined ? input.email : current.email,
    address: input.address !== undefined ? input.address : current.address,
    notes: input.notes !== undefined ? input.notes : current.notes,
    membershipNumber:
      input.membershipNumber !== undefined ? input.membershipNumber : current.membershipNumber,
  });

  const db = getDb();
  const membershipNumber = fields.membershipNumber || current.membershipNumber || generateNextMembershipNumber(db);

  const dupMember = db
    .prepare(
      'SELECT id, name FROM customers WHERE LOWER(membership_number) = LOWER(?) AND id != ?'
    )
    .get(membershipNumber, id) as { id: string; name: string } | undefined;
  if (dupMember) {
    throw new ServiceError(
      409,
      `Nomor keanggotaan "${membershipNumber}" sudah digunakan oleh ${dupMember.name}.`
    );
  }

  const isActive =
    typeof input.isActive === 'boolean' ? (input.isActive ? 1 : 0) : current.isActive ? 1 : 0;
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE customers
      SET membership_number = ?, name = ?, phone = ?, email = ?, address = ?, notes = ?,
          is_active = ?, updated_at = ?
      WHERE id = ?
    `).run(
      membershipNumber,
      fields.name,
      fields.phone,
      fields.email,
      fields.address,
      fields.notes,
      isActive,
      nowIso,
      id
    );

    recordAuditLog(db, {
      action: 'CUSTOMER_UPDATED',
      entityType: 'customer',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Perbarui data pelanggan "${fields.name}" (${current.code} · ${membershipNumber})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getCustomerById(id);
}

export function setCustomerStatus(id: string, isActive: boolean, actor: UserSummary): Customer {
  const current = getCustomerById(id);
  const db = getDb();
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('UPDATE customers SET is_active = ?, updated_at = ? WHERE id = ?').run(
      isActive ? 1 : 0,
      nowIso,
      id
    );
    recordAuditLog(db, {
      action: 'CUSTOMER_STATUS_CHANGED',
      entityType: 'customer',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `${isActive ? 'Aktifkan' : 'Nonaktifkan'} pelanggan "${current.name}" (${current.code})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getCustomerById(id);
}

export function getLoyaltySettings(): LoyaltySettings {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT enabled, points_per_amount, point_value_rp, min_redeem_points, max_redeem_percent, disable_earn_on_redeem, updated_at
      FROM loyalty_settings
      WHERE id = 1
    `)
    .get() as
    | {
        enabled: number;
        points_per_amount: number;
        point_value_rp: number;
        min_redeem_points: number;
        max_redeem_percent: number;
        disable_earn_on_redeem?: number;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    return {
      enabled: true,
      pointsPerAmount: 10000,
      pointValueRp: 100,
      minRedeemPoints: 10,
      maxRedeemPercent: 50,
      disableEarnOnRedeem: false,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    enabled: row.enabled === 1,
    pointsPerAmount: row.points_per_amount,
    pointValueRp: row.point_value_rp,
    minRedeemPoints: row.min_redeem_points,
    maxRedeemPercent: row.max_redeem_percent,
    disableEarnOnRedeem: Number(row.disable_earn_on_redeem ?? 0) === 1,
    updatedAt: row.updated_at,
  };
}

export function updateLoyaltySettings(
  input: Partial<LoyaltySettings>,
  actor: UserSummary
): LoyaltySettings {
  const current = getLoyaltySettings();

  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : current.enabled;
  const disableEarnOnRedeem =
    input.disableEarnOnRedeem !== undefined
      ? Boolean(input.disableEarnOnRedeem)
      : current.disableEarnOnRedeem;
  const pointsPerAmount =
    input.pointsPerAmount !== undefined
      ? Math.round(Number(input.pointsPerAmount))
      : current.pointsPerAmount;
  if (!Number.isFinite(pointsPerAmount) || pointsPerAmount < 100) {
    throw new ServiceError(400, 'Nominal belanja per 1 poin minimal Rp 100.');
  }

  const pointValueRp =
    input.pointValueRp !== undefined ? Math.round(Number(input.pointValueRp)) : current.pointValueRp;
  if (!Number.isFinite(pointValueRp) || pointValueRp < 0) {
    throw new ServiceError(400, 'Nilai tukar per 1 poin harus bernilai minimal Rp 0.');
  }

  const minRedeemPoints =
    input.minRedeemPoints !== undefined
      ? Math.round(Number(input.minRedeemPoints))
      : current.minRedeemPoints;
  if (!Number.isFinite(minRedeemPoints) || minRedeemPoints < 0) {
    throw new ServiceError(400, 'Minimum penukaran poin harus minimal 0.');
  }

  const maxRedeemPercent =
    input.maxRedeemPercent !== undefined
      ? Math.round(Number(input.maxRedeemPercent))
      : current.maxRedeemPercent;
  if (!Number.isFinite(maxRedeemPercent) || maxRedeemPercent < 0 || maxRedeemPercent > 100) {
    throw new ServiceError(400, 'Batas persentase tukar poin harus antara 0% hingga 100%.');
  }

  const db = getDb();
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO loyalty_settings (
        id, enabled, points_per_amount, point_value_rp, min_redeem_points, max_redeem_percent, disable_earn_on_redeem, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        points_per_amount = excluded.points_per_amount,
        point_value_rp = excluded.point_value_rp,
        min_redeem_points = excluded.min_redeem_points,
        max_redeem_percent = excluded.max_redeem_percent,
        disable_earn_on_redeem = excluded.disable_earn_on_redeem,
        updated_at = excluded.updated_at
    `).run(
      enabled ? 1 : 0,
      pointsPerAmount,
      pointValueRp,
      minRedeemPoints,
      maxRedeemPercent,
      disableEarnOnRedeem ? 1 : 0,
      nowIso
    );

    recordAuditLog(db, {
      action: 'LOYALTY_SETTINGS_UPDATED',
      entityType: 'loyalty',
      entityId: 'loyalty-settings',
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Perbarui aturan poin loyalitas (${enabled ? 'Aktif' : 'Nonaktif'}, 1 poin / Rp ${pointsPerAmount.toLocaleString('id-ID')}, nilai Rp ${pointValueRp}, blokir poin saat redeem: ${disableEarnOnRedeem ? 'ON' : 'OFF'})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getLoyaltySettings();
}

export function adjustCustomerLoyaltyPoints(
  customerId: string,
  input: { pointsDelta?: unknown; notes?: unknown },
  actor: UserSummary
): { customer: Customer; entry: LoyaltyPointTransaction } {
  const delta = Math.trunc(Number(input.pointsDelta));
  if (!Number.isFinite(delta) || delta === 0) {
    throw new ServiceError(400, 'Perubahan poin tidak boleh 0 dan harus berupa bilangan bulat.');
  }
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (!notes) {
    throw new ServiceError(400, 'Alasan penyesuaian poin wajib diisi.');
  }

  const customer = getCustomerById(customerId);
  const pointsBefore = customer.loyaltyPoints;
  const pointsAfter = pointsBefore + delta;
  if (pointsAfter < 0) {
    throw new ServiceError(
      400,
      `Saldo poin tidak mencukupi untuk pengurangan ${Math.abs(delta)} poin (tersedia ${pointsBefore} poin).`
    );
  }

  const db = getDb();
  const nowIso = new Date().toISOString();
  const entryId = `lpt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const refNum = `ADJ-PTS-${nowIso.slice(0, 10).replace(/-/g, '')}`;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE customers
      SET loyalty_points = ?,
          total_points_earned = total_points_earned + ?,
          total_points_redeemed = total_points_redeemed + ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      pointsAfter,
      delta > 0 ? delta : 0,
      delta < 0 ? Math.abs(delta) : 0,
      nowIso,
      customerId
    );

    db.prepare(`
      INSERT INTO loyalty_point_transactions (
        id, customer_id, transaction_id, type, points_delta, points_before, points_after,
        reference_number, notes, actor_user_id, actor_name, created_at
      ) VALUES (?, ?, NULL, 'ADJUST', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entryId,
      customerId,
      delta,
      pointsBefore,
      pointsAfter,
      refNum,
      notes,
      actor.id,
      actor.fullName,
      nowIso
    );

    recordAuditLog(db, {
      action: 'LOYALTY_POINTS_ADJUSTED',
      entityType: 'loyalty',
      entityId: customerId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Penyesuaian poin "${customer.name}" (${delta > 0 ? `+${delta}` : delta} poin → ${pointsAfter}): ${notes}`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const entry = listLoyaltyHistory(customerId, 5).find((e) => e.id === entryId)!;
  return { customer: getCustomerById(customerId), entry };
}

export function applyLoyaltyForCompletedTransactionTx(
  db: DatabaseSync,
  params: {
    customerId: string;
    transactionId: string;
    invoiceNumber: string;
    pointsRedeemed: number;
    pointsEarned: number;
    actorUserId: string | null;
    actorName: string;
    nowIso: string;
  }
): void {
  const row = db
    .prepare('SELECT loyalty_points FROM customers WHERE id = ?')
    .get(params.customerId) as { loyalty_points: number } | undefined;
  if (!row) {
    throw new ServiceError(404, 'Pelanggan tidak ditemukan saat memproses poin loyalitas.');
  }

  let runningBalance = row.loyalty_points;

  if (params.pointsRedeemed > 0) {
    if (runningBalance < params.pointsRedeemed) {
      throw new ServiceError(
        409,
        `Saldo poin pelanggan tidak mencukupi (tersedia ${runningBalance} poin, diminta ${params.pointsRedeemed} poin).`
      );
    }
    const afterRedeem = runningBalance - params.pointsRedeemed;
    db.prepare(`
      INSERT INTO loyalty_point_transactions (
        id, customer_id, transaction_id, type, points_delta, points_before, points_after,
        reference_number, notes, actor_user_id, actor_name, created_at
      ) VALUES (?, ?, ?, 'REDEEM', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `lpt-red-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      params.customerId,
      params.transactionId,
      -params.pointsRedeemed,
      runningBalance,
      afterRedeem,
      params.invoiceNumber,
      `Penukaran ${params.pointsRedeemed} poin pada transaksi ${params.invoiceNumber}`,
      params.actorUserId,
      params.actorName,
      params.nowIso
    );
    runningBalance = afterRedeem;
  }

  if (params.pointsEarned > 0) {
    const afterEarn = runningBalance + params.pointsEarned;
    db.prepare(`
      INSERT INTO loyalty_point_transactions (
        id, customer_id, transaction_id, type, points_delta, points_before, points_after,
        reference_number, notes, actor_user_id, actor_name, created_at
      ) VALUES (?, ?, ?, 'EARN', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `lpt-ern-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      params.customerId,
      params.transactionId,
      params.pointsEarned,
      runningBalance,
      afterEarn,
      params.invoiceNumber,
      `Poin belanja dari transaksi ${params.invoiceNumber}`,
      params.actorUserId,
      params.actorName,
      params.nowIso
    );
    runningBalance = afterEarn;
  }

  db.prepare(`
    UPDATE customers
    SET loyalty_points = ?,
        total_points_earned = total_points_earned + ?,
        total_points_redeemed = total_points_redeemed + ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    runningBalance,
    params.pointsEarned,
    params.pointsRedeemed,
    params.nowIso,
    params.customerId
  );
}
