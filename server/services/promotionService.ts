import { getDb } from '../db/database.ts';
import { calculateExactDiscount, roundHalfUpDiv } from '../utils/money.ts';
import { recordAuditLog } from './auditService.ts';
import { ServiceError } from './errors.ts';
import type {
  AppliedPromotionSummary,
  Promotion,
  PromotionEffectiveStatus,
  PromotionEligibilityItem,
  PromotionRuleConfig,
  PromotionScope,
  PromotionStatus,
  PromotionTarget,
  PromotionType,
  UserSummary,
} from '../../src/types.ts';

const VALID_PROMO_TYPES: ReadonlySet<PromotionType> = new Set([
  'PERCENT',
  'FIXED_AMOUNT',
  'SPECIAL_PRICE',
  'BUY_X_GET_Y',
  'BUNDLE',
]);

const VALID_SCOPES: ReadonlySet<PromotionScope> = new Set([
  'PRODUCT',
  'TRANSACTION',
  'CATEGORY',
  'BUNDLE',
]);

interface PromoDbRow {
  id: string;
  code: string;
  name: string;
  description: string;
  promo_type: PromotionType;
  scope: PromotionScope;
  discount_value: number;
  max_discount_amount: number | null;
  min_purchase_amount: number;
  min_qty: number;
  start_date: string;
  end_date: string;
  status: PromotionStatus;
  stackable: number;
  priority: number;
  rule_json: string;
  usage_count: number;
  created_by_user_id: string | null;
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

export function computePromotionEffectiveStatus(
  status: PromotionStatus,
  startDate: string,
  endDate: string,
  todayStr: string = new Date().toISOString().slice(0, 10)
): PromotionEffectiveStatus {
  if (status === 'INACTIVE') return 'INACTIVE';
  const start = startDate.slice(0, 10);
  const end = endDate.slice(0, 10);
  if (todayStr < start) return 'SCHEDULED';
  if (todayStr > end) return 'EXPIRED';
  return 'ACTIVE';
}

function parseRuleJson(raw: string): PromotionRuleConfig {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object') {
      return parsed as PromotionRuleConfig;
    }
  } catch {
    // Ignore malformed JSON
  }
  return {};
}

function hydratePromotions(rows: PromoDbRow[]): Promotion[] {
  if (rows.length === 0) return [];
  const db = getDb();
  const targetStmt = db.prepare(`
    SELECT pt.id, pt.promotion_id, pt.target_type, pt.target_id, pt.required_qty,
           CASE
             WHEN pt.target_type = 'PRODUCT' THEN p.name
             WHEN pt.target_type = 'CATEGORY' THEN c.name
             ELSE pt.target_id
           END AS target_name
    FROM promotion_targets pt
    LEFT JOIN products p ON pt.target_type = 'PRODUCT' AND p.id = pt.target_id
    LEFT JOIN categories c ON pt.target_type = 'CATEGORY' AND c.id = pt.target_id
    WHERE pt.promotion_id = ?
    ORDER BY pt.id ASC
  `);

  const todayStr = new Date().toISOString().slice(0, 10);

  return rows.map((r) => {
    const tRows = targetStmt.all(r.id) as Array<{
      id: string;
      promotion_id: string;
      target_type: 'PRODUCT' | 'CATEGORY';
      target_id: string;
      required_qty: number;
      target_name: string | null;
    }>;

    const targets: PromotionTarget[] = tRows.map((t) => ({
      id: t.id,
      promotionId: t.promotion_id,
      targetType: t.target_type,
      targetId: t.target_id,
      targetName: t.target_name ?? t.target_id,
      requiredQty: t.required_qty,
    }));

    return {
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      promoType: r.promo_type,
      scope: r.scope,
      discountValue: Number(r.discount_value),
      maxDiscountAmount: r.max_discount_amount,
      minPurchaseAmount: Number(r.min_purchase_amount),
      minQty: Number(r.min_qty),
      startDate: r.start_date,
      endDate: r.end_date,
      status: r.status,
      effectiveStatus: computePromotionEffectiveStatus(
        r.status,
        r.start_date,
        r.end_date,
        todayStr
      ),
      stackable: r.stackable === 1,
      priority: Number(r.priority),
      ruleConfig: parseRuleJson(r.rule_json),
      targets,
      usageCount: Number(r.usage_count),
      createdByUserId: r.created_by_user_id,
      createdByName: r.created_by_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export function listPromotions(filters?: {
  search?: string;
  status?: string;
  scope?: string;
  activeOnly?: boolean;
}): Promotion[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT id, code, name, description, promo_type, scope, discount_value,
             max_discount_amount, min_purchase_amount, min_qty, start_date, end_date,
             status, stackable, priority, rule_json, usage_count,
             created_by_user_id, created_by_name, created_at, updated_at
      FROM promotions
      ORDER BY priority ASC, created_at DESC
    `)
    .all() as unknown as PromoDbRow[];

  let list = hydratePromotions(rows);

  if (filters?.activeOnly) {
    list = list.filter((p) => p.effectiveStatus === 'ACTIVE');
  } else if (filters?.status && filters.status !== 'ALL') {
    const st = filters.status.toUpperCase();
    list = list.filter((p) => p.effectiveStatus === st || p.status === st);
  }

  if (filters?.scope && filters.scope !== 'ALL') {
    const sc = filters.scope.toUpperCase();
    list = list.filter((p) => p.scope === sc);
  }

  const q = (filters?.search ?? '').trim().toLowerCase();
  if (q) {
    list = list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q)
    );
  }

  return list;
}

export function getPromotionById(id: string): Promotion {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT id, code, name, description, promo_type, scope, discount_value,
             max_discount_amount, min_purchase_amount, min_qty, start_date, end_date,
             status, stackable, priority, rule_json, usage_count,
             created_by_user_id, created_by_name, created_at, updated_at
      FROM promotions
      WHERE id = ? OR LOWER(code) = LOWER(?)
    `)
    .get(id, id) as PromoDbRow | undefined;

  if (!row) {
    throw new ServiceError(404, 'Promosi tidak ditemukan.');
  }

  return hydratePromotions([row])[0];
}

export interface SavePromotionInput {
  code?: unknown;
  name?: unknown;
  description?: unknown;
  promoType?: unknown;
  scope?: unknown;
  discountValue?: unknown;
  maxDiscountAmount?: unknown;
  minPurchaseAmount?: unknown;
  minQty?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  status?: unknown;
  stackable?: unknown;
  priority?: unknown;
  ruleConfig?: unknown;
  targets?: unknown;
}

function normalizeIsoDate(raw: unknown, label: string): string {
  const str = typeof raw === 'string' ? raw.trim().slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    throw new ServiceError(400, `${label} harus menggunakan format tanggal YYYY-MM-DD.`);
  }
  const parsed = new Date(`${str}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== str) {
    throw new ServiceError(400, `${label} bukan tanggal kalender yang valid.`);
  }
  return str;
}

function validateAndNormalizePromotionInput(
  input: SavePromotionInput,
  fallback?: Promotion
) {
  const name =
    input.name !== undefined ? String(input.name).trim() : fallback?.name ?? '';
  if (!name || name.length < 3) {
    throw new ServiceError(400, 'Nama promosi wajib diisi (minimal 3 karakter).');
  }

  const rawCode =
    input.code !== undefined
      ? String(input.code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '')
      : fallback?.code ?? '';
  const code =
    rawCode || `PROMO-${Date.now().toString().slice(-6)}`;
  if (code.length < 3 || code.length > 40) {
    throw new ServiceError(400, 'Kode promosi harus 3–40 karakter (huruf, angka, -, _).');
  }

  const promoType = (
    input.promoType !== undefined
      ? String(input.promoType).trim().toUpperCase()
      : fallback?.promoType ?? 'PERCENT'
  ) as PromotionType;
  if (!VALID_PROMO_TYPES.has(promoType)) {
    throw new ServiceError(400, 'Jenis promosi tidak valid.');
  }

  const scope = (
    input.scope !== undefined
      ? String(input.scope).trim().toUpperCase()
      : fallback?.scope ?? 'TRANSACTION'
  ) as PromotionScope;
  if (!VALID_SCOPES.has(scope)) {
    throw new ServiceError(400, 'Cakupan promosi tidak valid.');
  }

  const startDate = normalizeIsoDate(
    input.startDate !== undefined ? input.startDate : fallback?.startDate,
    'Tanggal mulai promo'
  );
  const endDate = normalizeIsoDate(
    input.endDate !== undefined ? input.endDate : fallback?.endDate,
    'Tanggal berakhir promo'
  );
  if (endDate < startDate) {
    throw new ServiceError(400, 'Tanggal berakhir promo tidak boleh lebih awal dari tanggal mulai.');
  }

  const discountValue =
    input.discountValue !== undefined
      ? Number(input.discountValue)
      : fallback?.discountValue ?? 0;
  if (!Number.isFinite(discountValue) || discountValue < 0) {
    throw new ServiceError(400, 'Nilai diskon/harga promo tidak valid.');
  }

  if (promoType === 'PERCENT' && (discountValue <= 0 || discountValue > 100)) {
    throw new ServiceError(400, 'Persentase diskon promo harus antara 0.01% hingga 100%.');
  }
  if (promoType === 'FIXED_AMOUNT' && discountValue <= 0) {
    throw new ServiceError(400, 'Nominal potongan promo harus lebih dari Rp 0.');
  }
  if (promoType === 'SPECIAL_PRICE' && (scope === 'TRANSACTION' || discountValue <= 0)) {
    throw new ServiceError(
      400,
      'Promo harga spesial hanya berlaku untuk produk/kategori dengan nominal lebih dari Rp 0.'
    );
  }

  const maxDiscountRaw =
    input.maxDiscountAmount !== undefined
      ? input.maxDiscountAmount
      : fallback?.maxDiscountAmount ?? null;
  let maxDiscountAmount: number | null = null;
  if (maxDiscountRaw !== null && maxDiscountRaw !== undefined && String(maxDiscountRaw).trim() !== '') {
    const parsedMax = Math.round(Number(maxDiscountRaw));
    if (!Number.isFinite(parsedMax) || parsedMax <= 0) {
      throw new ServiceError(400, 'Batas maksimal diskon promo harus lebih dari Rp 0.');
    }
    maxDiscountAmount = parsedMax;
  }

  const minPurchaseAmount = Math.round(
    Number(
      input.minPurchaseAmount !== undefined
        ? input.minPurchaseAmount
        : fallback?.minPurchaseAmount ?? 0
    )
  );
  if (!Number.isFinite(minPurchaseAmount) || minPurchaseAmount < 0) {
    throw new ServiceError(400, 'Minimum pembelian tidak boleh negatif.');
  }

  const minQty = Math.floor(
    Number(input.minQty !== undefined ? input.minQty : fallback?.minQty ?? 1)
  );
  if (!Number.isFinite(minQty) || minQty < 1) {
    throw new ServiceError(400, 'Minimum jumlah beli (qty) minimal 1.');
  }

  const status: PromotionStatus =
    (input.status !== undefined ? input.status : fallback?.status) === 'INACTIVE'
      ? 'INACTIVE'
      : 'ACTIVE';

  const stackable =
    input.stackable !== undefined ? Boolean(input.stackable) : fallback?.stackable ?? false;

  const priority = Math.round(
    Number(input.priority !== undefined ? input.priority : fallback?.priority ?? 10)
  );
  if (!Number.isFinite(priority) || priority < 1 || priority > 999) {
    throw new ServiceError(400, 'Prioritas promo harus antara 1 hingga 999.');
  }

  const description =
    input.description !== undefined
      ? String(input.description).trim()
      : fallback?.description ?? '';

  // Validate extensible ruleConfig
  const rawRule =
    input.ruleConfig !== undefined && input.ruleConfig && typeof input.ruleConfig === 'object'
      ? (input.ruleConfig as PromotionRuleConfig)
      : fallback?.ruleConfig ?? {};
  const ruleConfig: PromotionRuleConfig = {};

  if (promoType === 'BUY_X_GET_Y') {
    const buyQty = Math.floor(Number(rawRule.buyQty ?? 1));
    const getQty = Math.floor(Number(rawRule.getQty ?? 1));
    const getDiscountPercent = Number(rawRule.getDiscountPercent ?? 100);
    if (!Number.isFinite(buyQty) || buyQty < 1 || !Number.isFinite(getQty) || getQty < 1) {
      throw new ServiceError(400, 'Aturan Beli X Gratis Y membutuhkan jumlah Beli >= 1 dan Gratis >= 1.');
    }
    if (!Number.isFinite(getDiscountPercent) || getDiscountPercent <= 0 || getDiscountPercent > 100) {
      throw new ServiceError(400, 'Persentase diskon item gratis harus antara 1% hingga 100%.');
    }
    ruleConfig.buyQty = buyQty;
    ruleConfig.getQty = getQty;
    ruleConfig.getDiscountPercent = getDiscountPercent;
    if (typeof rawRule.getProductId === 'string' && rawRule.getProductId.trim()) {
      ruleConfig.getProductId = rawRule.getProductId.trim();
    }
  } else if (promoType === 'BUNDLE') {
    const bundlePrice = Math.round(Number(rawRule.bundlePrice ?? discountValue));
    if (!Number.isFinite(bundlePrice) || bundlePrice < 0) {
      throw new ServiceError(400, 'Harga paket bundle tidak valid.');
    }
    ruleConfig.bundlePrice = bundlePrice;
  }

  // Validate normalized targets
  const db = getDb();
  const rawTargets =
    input.targets !== undefined
      ? input.targets
      : fallback?.targets.map((t) => ({
          targetType: t.targetType,
          targetId: t.targetId,
          requiredQty: t.requiredQty,
        })) ?? [];

  const normalizedTargets: Array<{
    targetType: 'PRODUCT' | 'CATEGORY';
    targetId: string;
    requiredQty: number;
  }> = [];

  if (Array.isArray(rawTargets)) {
    for (const rawT of rawTargets) {
      if (!rawT || typeof rawT !== 'object') continue;
      const t = rawT as { targetType?: unknown; targetId?: unknown; requiredQty?: unknown };
      const targetType = t.targetType === 'CATEGORY' ? 'CATEGORY' : 'PRODUCT';
      const targetId = typeof t.targetId === 'string' ? t.targetId.trim() : '';
      if (!targetId) continue;
      const requiredQty = Math.max(1, Math.floor(Number(t.requiredQty ?? 1)));

      if (targetType === 'PRODUCT') {
        if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(targetId)) {
          throw new ServiceError(404, `Produk target promosi (${targetId}) tidak ditemukan.`);
        }
      } else {
        if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(targetId)) {
          throw new ServiceError(404, `Kategori target promosi (${targetId}) tidak ditemukan.`);
        }
      }
      if (!normalizedTargets.some((x) => x.targetType === targetType && x.targetId === targetId)) {
        normalizedTargets.push({ targetType, targetId, requiredQty });
      }
    }
  }

  if (scope !== 'TRANSACTION' && normalizedTargets.length === 0) {
    throw new ServiceError(
      400,
      `Promosi dengan cakupan ${scope} wajib memiliki minimal 1 target produk atau kategori.`
    );
  }

  return {
    code,
    name,
    description,
    promoType,
    scope,
    discountValue,
    maxDiscountAmount,
    minPurchaseAmount,
    minQty,
    startDate,
    endDate,
    status,
    stackable,
    priority,
    ruleConfig,
    targets: normalizedTargets,
  };
}

export function createPromotion(input: SavePromotionInput, actor: UserSummary): Promotion {
  const data = validateAndNormalizePromotionInput(input);
  const db = getDb();

  const dup = db
    .prepare('SELECT id, name FROM promotions WHERE LOWER(code) = LOWER(?)')
    .get(data.code) as { id: string; name: string } | undefined;
  if (dup) {
    throw new ServiceError(409, `Kode promosi "${data.code}" sudah digunakan oleh "${dup.name}".`);
  }

  const id = `promo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO promotions (
        id, code, name, description, promo_type, scope, discount_value,
        max_discount_amount, min_purchase_amount, min_qty, start_date, end_date,
        status, stackable, priority, rule_json, usage_count,
        created_by_user_id, created_by_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      id,
      data.code,
      data.name,
      data.description,
      data.promoType,
      data.scope,
      data.discountValue,
      data.maxDiscountAmount,
      data.minPurchaseAmount,
      data.minQty,
      data.startDate,
      data.endDate,
      data.status,
      data.stackable ? 1 : 0,
      data.priority,
      JSON.stringify(data.ruleConfig),
      actor.id,
      actor.fullName,
      nowIso,
      nowIso
    );

    const insertTarget = db.prepare(`
      INSERT INTO promotion_targets (id, promotion_id, target_type, target_id, required_qty)
      VALUES (?, ?, ?, ?, ?)
    `);
    data.targets.forEach((t, idx) => {
      insertTarget.run(
        `ptgt-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
        id,
        t.targetType,
        t.targetId,
        t.requiredQty
      );
    });

    recordAuditLog(db, {
      action: 'PROMOTION_CREATED',
      entityType: 'promotion',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Buat promosi "${data.name}" (${data.code} · ${data.promoType} · ${data.scope})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getPromotionById(id);
}

export function updatePromotion(
  id: string,
  input: SavePromotionInput,
  actor: UserSummary
): Promotion {
  const current = getPromotionById(id);
  const data = validateAndNormalizePromotionInput(input, current);
  const db = getDb();

  const dup = db
    .prepare('SELECT id, name FROM promotions WHERE LOWER(code) = LOWER(?) AND id != ?')
    .get(data.code, id) as { id: string; name: string } | undefined;
  if (dup) {
    throw new ServiceError(409, `Kode promosi "${data.code}" sudah digunakan oleh "${dup.name}".`);
  }

  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE promotions
      SET code = ?, name = ?, description = ?, promo_type = ?, scope = ?,
          discount_value = ?, max_discount_amount = ?, min_purchase_amount = ?,
          min_qty = ?, start_date = ?, end_date = ?, status = ?,
          stackable = ?, priority = ?, rule_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      data.code,
      data.name,
      data.description,
      data.promoType,
      data.scope,
      data.discountValue,
      data.maxDiscountAmount,
      data.minPurchaseAmount,
      data.minQty,
      data.startDate,
      data.endDate,
      data.status,
      data.stackable ? 1 : 0,
      data.priority,
      JSON.stringify(data.ruleConfig),
      nowIso,
      id
    );

    db.prepare('DELETE FROM promotion_targets WHERE promotion_id = ?').run(id);
    const insertTarget = db.prepare(`
      INSERT INTO promotion_targets (id, promotion_id, target_type, target_id, required_qty)
      VALUES (?, ?, ?, ?, ?)
    `);
    data.targets.forEach((t, idx) => {
      insertTarget.run(
        `ptgt-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
        id,
        t.targetType,
        t.targetId,
        t.requiredQty
      );
    });

    recordAuditLog(db, {
      action: 'PROMOTION_UPDATED',
      entityType: 'promotion',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Perbarui promosi "${data.name}" (${data.code})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getPromotionById(id);
}

export function setPromotionStatus(
  id: string,
  status: PromotionStatus,
  actor: UserSummary
): Promotion {
  if (status !== 'ACTIVE' && status !== 'INACTIVE') {
    throw new ServiceError(400, 'Status promosi harus ACTIVE atau INACTIVE.');
  }
  const current = getPromotionById(id);
  const db = getDb();
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('UPDATE promotions SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      nowIso,
      id
    );
    recordAuditLog(db, {
      action: 'PROMOTION_STATUS_CHANGED',
      entityType: 'promotion',
      entityId: id,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `${status === 'ACTIVE' ? 'Aktifkan' : 'Nonaktifkan'} promosi "${current.name}" (${current.code})`,
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getPromotionById(id);
}

// --- Authoritative Promotion Evaluation Engine (BigInt Exact Math) ---

export interface EvaluableCartLine {
  productId: string;
  categoryId: string | null;
  subcategoryId: string | null;
  qty: number;
  unitPrice: number;
  lineGrossSubtotal: bigint;
  manualLineDiscountAmount: bigint;
}

export interface PromotionEvaluationResult {
  linePromotions: Map<
    string,
    {
      promotionId: string;
      promotionName: string;
      discountAmount: bigint;
    }
  >;
  promotionLineDiscountTotal: bigint;
  promotionTransactionDiscountAmount: bigint;
  totalPromotionDiscount: bigint;
  appliedPromotions: AppliedPromotionSummary[];
  eligiblePromotions: PromotionEligibilityItem[];
}

function doesLineMatchPromotion(line: EvaluableCartLine, promo: Promotion): boolean {
  if (promo.scope === 'TRANSACTION') return true;
  return promo.targets.some((t) => {
    if (t.targetType === 'PRODUCT') return t.targetId === line.productId;
    if (t.targetType === 'CATEGORY') {
      return t.targetId === line.categoryId || t.targetId === line.subcategoryId;
    }
    return false;
  });
}

function evaluateSinglePromotion(
  promo: Promotion,
  lines: EvaluableCartLine[],
  cartBaseSubtotal: bigint,
  todayStr: string
): {
  eligible: boolean;
  reason?: string;
  lineDiscounts: Map<string, bigint>;
  transactionDiscount: bigint;
  estimatedDiscount: bigint;
} {
  const empty = (reason: string) => ({
    eligible: false,
    reason,
    lineDiscounts: new Map<string, bigint>(),
    transactionDiscount: 0n,
    estimatedDiscount: 0n,
  });

  if (promo.status !== 'ACTIVE') {
    return empty('Promosi berstatus nonaktif.');
  }
  const eff = computePromotionEffectiveStatus(
    promo.status,
    promo.startDate,
    promo.endDate,
    todayStr
  );
  if (eff === 'SCHEDULED') {
    return empty(`Promo belum dimulai (mulai ${promo.startDate}).`);
  }
  if (eff === 'EXPIRED') {
    return empty(`Masa berlaku promo telah berakhir pada ${promo.endDate}.`);
  }

  const totalCartQty = lines.reduce((s, l) => s + l.qty, 0);
  if (Number(cartBaseSubtotal) < promo.minPurchaseAmount) {
    const shortage = promo.minPurchaseAmount - Number(cartBaseSubtotal);
    return empty(
      `Minimum belanja Rp ${promo.minPurchaseAmount.toLocaleString('id-ID')} (kurang Rp ${shortage.toLocaleString('id-ID')}).`
    );
  }

  // BUNDLE extensible handler
  if (promo.promoType === 'BUNDLE' || promo.scope === 'BUNDLE') {
    if (promo.targets.length === 0) {
      return empty('Target paket bundle belum dikonfigurasi.');
    }
    let maxBundles = Number.POSITIVE_INFINITY;
    let regularBundleSum = 0;
    for (const target of promo.targets) {
      const line = lines.find((l) => l.productId === target.targetId);
      const qtyInCart = line?.qty ?? 0;
      const count = Math.floor(qtyInCart / target.requiredQty);
      if (count < maxBundles) maxBundles = count;
      if (line) {
        regularBundleSum += line.unitPrice * target.requiredQty;
      }
    }
    if (!Number.isFinite(maxBundles) || maxBundles < 1) {
      return empty('Produk paket bundle belum lengkap di keranjang.');
    }
    const bundlePrice = Math.round(promo.ruleConfig.bundlePrice ?? promo.discountValue);
    const savingPerBundle = Math.max(0, regularBundleSum - bundlePrice);
    if (savingPerBundle <= 0) {
      return empty('Harga normal item sudah lebih hemat dari harga bundle.');
    }
    const totalSaving = BigInt(savingPerBundle) * BigInt(maxBundles);
    return {
      eligible: true,
      lineDiscounts: new Map(),
      transactionDiscount: totalSaving,
      estimatedDiscount: totalSaving,
    };
  }

  // TRANSACTION scope
  if (promo.scope === 'TRANSACTION') {
    if (totalCartQty < promo.minQty) {
      return empty(`Minimum ${promo.minQty} unit barang di keranjang.`);
    }
    const baseAfterManualLine = lines.reduce(
      (acc, l) => acc + (l.lineGrossSubtotal - l.manualLineDiscountAmount),
      0n
    );
    let disc = 0n;
    if (promo.promoType === 'PERCENT') {
      disc = calculateExactDiscount(baseAfterManualLine, 'PERCENT', promo.discountValue).amount;
      if (promo.maxDiscountAmount !== null && disc > BigInt(promo.maxDiscountAmount)) {
        disc = BigInt(promo.maxDiscountAmount);
      }
    } else if (promo.promoType === 'FIXED_AMOUNT') {
      disc = calculateExactDiscount(baseAfterManualLine, 'AMOUNT', promo.discountValue).amount;
    }
    return {
      eligible: disc > 0n,
      reason: disc > 0n ? undefined : 'Tidak ada nominal yang dapat didiskon.',
      lineDiscounts: new Map(),
      transactionDiscount: disc,
      estimatedDiscount: disc,
    };
  }

  // PRODUCT / CATEGORY scope
  const matchingLines = lines.filter((l) => doesLineMatchPromotion(l, promo));
  if (matchingLines.length === 0) {
    return empty('Belum ada produk yang sesuai target promosi di keranjang.');
  }

  const matchingQty = matchingLines.reduce((s, l) => s + l.qty, 0);
  if (matchingQty < promo.minQty) {
    return empty(`Minimum beli ${promo.minQty} unit produk promo (saat ini ${matchingQty}).`);
  }

  const lineDiscounts = new Map<string, bigint>();
  let totalLineSaving = 0n;

  if (promo.promoType === 'BUY_X_GET_Y') {
    const buyQty = Math.max(1, promo.ruleConfig.buyQty ?? 1);
    const getQty = Math.max(1, promo.ruleConfig.getQty ?? 1);
    const getDiscPct = promo.ruleConfig.getDiscountPercent ?? 100;
    const sets = Math.floor(matchingQty / (buyQty + getQty));
    if (sets < 1) {
      return empty(`Butuh minimal ${buyQty + getQty} unit untuk Beli ${buyQty} Gratis ${getQty}.`);
    }
    let remainingFreeUnits = sets * getQty;
    const candidateLines = promo.ruleConfig.getProductId
      ? lines.filter((l) => l.productId === promo.ruleConfig.getProductId)
      : matchingLines;

    for (const line of candidateLines) {
      if (remainingFreeUnits <= 0) break;
      const freeUnitsHere = Math.min(line.qty, remainingFreeUnits);
      const freeBase = BigInt(line.unitPrice) * BigInt(freeUnitsHere);
      const disc = calculateExactDiscount(freeBase, 'PERCENT', getDiscPct).amount;
      const availableNet = line.lineGrossSubtotal - line.manualLineDiscountAmount;
      const clamped = disc > availableNet ? availableNet : disc;
      if (clamped > 0n) {
        lineDiscounts.set(line.productId, (lineDiscounts.get(line.productId) ?? 0n) + clamped);
        totalLineSaving += clamped;
      }
      remainingFreeUnits -= freeUnitsHere;
    }
  } else {
    for (const line of matchingLines) {
      const availableNet = line.lineGrossSubtotal - line.manualLineDiscountAmount;
      if (availableNet <= 0n) continue;

      let disc = 0n;
      if (promo.promoType === 'PERCENT') {
        disc = calculateExactDiscount(availableNet, 'PERCENT', promo.discountValue).amount;
      } else if (promo.promoType === 'FIXED_AMOUNT') {
        const perUnitTotal = BigInt(Math.round(promo.discountValue)) * BigInt(line.qty);
        disc = perUnitTotal > availableNet ? availableNet : perUnitTotal;
      } else if (promo.promoType === 'SPECIAL_PRICE') {
        const promoUnit = Math.round(promo.discountValue);
        if (promoUnit < line.unitPrice) {
          const diff = BigInt(line.unitPrice - promoUnit) * BigInt(line.qty);
          disc = diff > availableNet ? availableNet : diff;
        }
      }

      if (disc > 0n) {
        lineDiscounts.set(line.productId, disc);
        totalLineSaving += disc;
      }
    }

    if (promo.maxDiscountAmount !== null && totalLineSaving > BigInt(promo.maxDiscountAmount)) {
      // Clamp aggregate line discounts down to maxDiscountAmount proportionally
      const cap = BigInt(promo.maxDiscountAmount);
      let remainingCap = cap;
      const entries = Array.from(lineDiscounts.entries());
      lineDiscounts.clear();
      for (let i = 0; i < entries.length; i++) {
        const [pid, amt] = entries[i];
        const share =
          i === entries.length - 1
            ? remainingCap
            : roundHalfUpDiv(amt * cap, totalLineSaving);
        const bounded = share > remainingCap ? remainingCap : share;
        if (bounded > 0n) {
          lineDiscounts.set(pid, bounded);
          remainingCap -= bounded;
        }
      }
      totalLineSaving = cap;
    }
  }

  if (totalLineSaving <= 0n) {
    return empty('Harga item sudah lebih hemat atau tidak ada selisih promo.');
  }

  return {
    eligible: true,
    lineDiscounts,
    transactionDiscount: 0n,
    estimatedDiscount: totalLineSaving,
  };
}

export function evaluatePromotionsForCart(params: {
  lines: EvaluableCartLine[];
  selectedPromotionIds: string[];
  allowPromoStacking: boolean;
  allowManualWithPromo: boolean;
  hasManualDiscount: boolean;
  strictSelection: boolean;
}): PromotionEvaluationResult {
  const allPromos = listPromotions();
  const todayStr = new Date().toISOString().slice(0, 10);
  const cartBaseSubtotal = params.lines.reduce((s, l) => s + l.lineGrossSubtotal, 0n);

  const selectedIds = Array.from(
    new Set(params.selectedPromotionIds.map((id) => id.trim()).filter(Boolean))
  );

  if (selectedIds.length > 0 && params.hasManualDiscount && !params.allowManualWithPromo) {
    throw new ServiceError(
      400,
      'Diskon manual tidak dapat digabungkan dengan promosi sesuai aturan stacking toko.',
      'MANUAL_WITH_PROMO_NOT_ALLOWED'
    );
  }

  if (selectedIds.length > 1 && !params.allowPromoStacking) {
    throw new ServiceError(
      400,
      'Penggabungan lebih dari satu promosi tidak diizinkan oleh kebijakan toko.',
      'PROMO_STACKING_NOT_ALLOWED'
    );
  }

  const promoById = new Map(allPromos.map((p) => [p.id, p]));
  const selectedPromos: Promotion[] = [];
  for (const id of selectedIds) {
    const found = promoById.get(id);
    if (!found) {
      throw new ServiceError(404, `Promosi (${id}) tidak ditemukan.`);
    }
    selectedPromos.push(found);
  }

  if (selectedPromos.length > 1) {
    const nonStackable = selectedPromos.find((p) => !p.stackable);
    if (nonStackable) {
      throw new ServiceError(
        400,
        `Promosi "${nonStackable.name}" tidak dapat digabungkan dengan promosi lain.`,
        'PROMO_NOT_STACKABLE'
      );
    }
  }

  // Evaluate eligibility of all non-inactive promos for cashier selection visibility
  const eligiblePromotions: PromotionEligibilityItem[] = allPromos
    .filter((p) => p.status === 'ACTIVE' || selectedIds.includes(p.id))
    .map((p) => {
      const ev = evaluateSinglePromotion(p, params.lines, cartBaseSubtotal, todayStr);
      return {
        promotion: p,
        eligible: ev.eligible,
        estimatedDiscount: Number(ev.estimatedDiscount),
        reason: ev.reason,
      };
    });

  // Sort selected promotions by priority ASC
  selectedPromos.sort((a, b) => a.priority - b.priority);

  const linePromotions = new Map<
    string,
    { promotionId: string; promotionName: string; discountAmount: bigint }
  >();
  let promotionLineDiscountTotal = 0n;
  let promotionTransactionDiscountAmount = 0n;
  const appliedPromotions: AppliedPromotionSummary[] = [];

  // Apply line-level promotions first, then transaction/bundle promotions on remaining net
  const lineLevelSelected = selectedPromos.filter(
    (p) => p.scope === 'PRODUCT' || p.scope === 'CATEGORY'
  );
  const txLevelSelected = selectedPromos.filter(
    (p) => p.scope === 'TRANSACTION' || p.scope === 'BUNDLE'
  );

  for (const promo of lineLevelSelected) {
    const ev = evaluateSinglePromotion(promo, params.lines, cartBaseSubtotal, todayStr);
    if (!ev.eligible) {
      if (params.strictSelection) {
        throw new ServiceError(400, `Promosi "${promo.name}" tidak memenuhi syarat: ${ev.reason}`);
      }
      continue;
    }

    let promoAppliedTotal = 0n;
    for (const [productId, discAmt] of ev.lineDiscounts.entries()) {
      if (linePromotions.has(productId)) {
        // Prevent conflicting duplicate product promo unless stackable;
        // enforce max 1 product-level promo per line item for clarity & margin safety
        if (params.strictSelection) {
          throw new ServiceError(
            400,
            `Produk yang sama tidak dapat menerima lebih dari satu promo produk sekaligus ("${promo.name}").`
          );
        }
        continue;
      }
      linePromotions.set(productId, {
        promotionId: promo.id,
        promotionName: promo.name,
        discountAmount: discAmt,
      });
      promoAppliedTotal += discAmt;
    }

    if (promoAppliedTotal > 0n) {
      promotionLineDiscountTotal += promoAppliedTotal;
      appliedPromotions.push({
        id: promo.id,
        code: promo.code,
        name: promo.name,
        promoType: promo.promoType,
        scope: promo.scope,
        discountAmount: Number(promoAppliedTotal),
      });
    }
  }

  // Remaining cart net after manual line discounts & line promotions
  const adjustedLinesForTx = params.lines.map((l) => {
    const linePromoDisc = linePromotions.get(l.productId)?.discountAmount ?? 0n;
    return {
      ...l,
      manualLineDiscountAmount: l.manualLineDiscountAmount + linePromoDisc,
    };
  });

  let remainingTxNet = adjustedLinesForTx.reduce(
    (acc, l) => acc + (l.lineGrossSubtotal - l.manualLineDiscountAmount),
    0n
  );

  for (const promo of txLevelSelected) {
    const ev = evaluateSinglePromotion(promo, adjustedLinesForTx, cartBaseSubtotal, todayStr);
    if (!ev.eligible) {
      if (params.strictSelection) {
        throw new ServiceError(400, `Promosi "${promo.name}" tidak memenuhi syarat: ${ev.reason}`);
      }
      continue;
    }
    const clampedDisc =
      ev.transactionDiscount > remainingTxNet ? remainingTxNet : ev.transactionDiscount;
    if (clampedDisc > 0n) {
      promotionTransactionDiscountAmount += clampedDisc;
      remainingTxNet -= clampedDisc;
      appliedPromotions.push({
        id: promo.id,
        code: promo.code,
        name: promo.name,
        promoType: promo.promoType,
        scope: promo.scope,
        discountAmount: Number(clampedDisc),
      });
    }
  }

  return {
    linePromotions,
    promotionLineDiscountTotal,
    promotionTransactionDiscountAmount,
    totalPromotionDiscount: promotionLineDiscountTotal + promotionTransactionDiscountAmount,
    appliedPromotions,
    eligiblePromotions,
  };
}
