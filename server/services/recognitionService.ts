import fs from 'node:fs';
import path from 'node:path';
import { getDb, getProductUploadsDir, getRecognitionUploadsDir } from '../db/database.ts';
import { recordAuditLog } from './auditService.ts';
import { queryEnrichedProducts } from './catalogService.ts';
import { ServiceError } from './errors.ts';
import {
  getRecognitionProvider,
  listRecognitionProviders,
} from './ai/providerRegistry.ts';
import {
  classifyConfidenceBand,
  normalizeOcrSignals,
  scoreProductCandidate,
  type RecognitionImageInput,
} from './ai/providerTypes.ts';
import type {
  ImageReferenceAngle,
  RecognitionBoundingBox,
  RecognitionCandidate,
  RecognitionConfidenceBand,
  RecognitionContext,
  RecognitionLogEntry,
  RecognitionOcrSignals,
  RecognitionOutcome,
  RecognitionResult,
  RecognitionSettings,
  ReferenceEmbeddingSyncSummary,
  UserSummary,
} from '../../src/types.ts';

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB decoded limit after client resize

const ALLOWED_IMAGE_MIME: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

const VALID_CONTEXTS: ReadonlySet<RecognitionContext> = new Set([
  'POS_CASHIER',
  'STOCK_OPNAME',
  'CATALOG_CHECK',
  'API',
]);

const VALID_ANGLES: ReadonlySet<ImageReferenceAngle> = new Set([
  'front',
  'back',
  'side',
  'top',
  'packaging',
  'other',
]);

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function detectMimeFromMagicBytes(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function extFromMime(mime: 'image/jpeg' | 'image/png' | 'image/webp'): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

function parseImagePayload(raw: {
  dataBase64?: unknown;
  mimeType?: unknown;
}): { buffer: Buffer; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' } {
  if (typeof raw.dataBase64 !== 'string' || !raw.dataBase64.trim()) {
    throw new ServiceError(400, 'Data gambar base64 wajib diisi.');
  }

  let base64Body = raw.dataBase64.trim();
  let declaredMime =
    typeof raw.mimeType === 'string' ? raw.mimeType.trim().toLowerCase() : 'image/jpeg';

  const dataUriMatch = base64Body.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUriMatch) {
    declaredMime = dataUriMatch[1].toLowerCase();
    base64Body = dataUriMatch[2];
  }

  const normalizedDeclared = ALLOWED_IMAGE_MIME[declaredMime];
  if (!normalizedDeclared) {
    throw new ServiceError(400, 'Format gambar tidak didukung. Gunakan JPG, PNG, atau WEBP.');
  }

  const buffer = Buffer.from(base64Body, 'base64');
  if (buffer.length === 0) {
    throw new ServiceError(400, 'Isi file gambar kosong atau tidak valid.');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new ServiceError(400, 'Ukuran gambar melebihi batas maksimal 6 MB.');
  }

  const magicMime = detectMimeFromMagicBytes(buffer);
  if (!magicMime) {
    throw new ServiceError(400, 'Isi file tidak valid atau bukan gambar JPG/PNG/WEBP yang sah.');
  }

  return { buffer, mimeType: magicMime };
}

export function getRecognitionSettings(): RecognitionSettings {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT active_provider_id, auto_add_high_confidence, high_confidence_threshold,
             medium_confidence_threshold, low_confidence_threshold, remote_endpoint_url,
             request_timeout_ms, updated_at
      FROM recognition_settings
      WHERE id = 1
    `)
    .get() as
    | {
        active_provider_id: string;
        auto_add_high_confidence: number;
        high_confidence_threshold: number;
        medium_confidence_threshold: number;
        low_confidence_threshold: number;
        remote_endpoint_url: string;
        request_timeout_ms: number;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    return {
      activeProviderId: 'gemini-vision',
      autoAddHighConfidence: false,
      highConfidenceThreshold: 0.85,
      mediumConfidenceThreshold: 0.55,
      lowConfidenceThreshold: 0.35,
      remoteEndpointUrl: '',
      requestTimeoutMs: 15000,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    activeProviderId: row.active_provider_id,
    autoAddHighConfidence: row.auto_add_high_confidence === 1,
    highConfidenceThreshold: row.high_confidence_threshold,
    mediumConfidenceThreshold: row.medium_confidence_threshold,
    lowConfidenceThreshold: row.low_confidence_threshold,
    remoteEndpointUrl: row.remote_endpoint_url,
    requestTimeoutMs: row.request_timeout_ms,
    updatedAt: row.updated_at,
  };
}

export function updateRecognitionSettings(
  input: {
    activeProviderId?: unknown;
    autoAddHighConfidence?: unknown;
    highConfidenceThreshold?: unknown;
    mediumConfidenceThreshold?: unknown;
    lowConfidenceThreshold?: unknown;
    remoteEndpointUrl?: unknown;
    requestTimeoutMs?: unknown;
  },
  actor: UserSummary
): RecognitionSettings {
  const current = getRecognitionSettings();

  const activeProviderId =
    typeof input.activeProviderId === 'string' && input.activeProviderId.trim()
      ? input.activeProviderId.trim()
      : current.activeProviderId;

  // Verify provider exists in registry
  getRecognitionProvider(activeProviderId);

  const autoAddHighConfidence =
    typeof input.autoAddHighConfidence === 'boolean'
      ? input.autoAddHighConfidence
      : current.autoAddHighConfidence;

  const high =
    input.highConfidenceThreshold !== undefined
      ? Number(input.highConfidenceThreshold)
      : current.highConfidenceThreshold;
  const medium =
    input.mediumConfidenceThreshold !== undefined
      ? Number(input.mediumConfidenceThreshold)
      : current.mediumConfidenceThreshold;
  const low =
    input.lowConfidenceThreshold !== undefined
      ? Number(input.lowConfidenceThreshold)
      : current.lowConfidenceThreshold;

  if (!Number.isFinite(high) || !Number.isFinite(medium) || !Number.isFinite(low)) {
    throw new ServiceError(400, 'Threshold keyakinan AI harus berupa angka valid.');
  }
  if (low <= 0 || low >= medium || medium >= high || high > 1) {
    throw new ServiceError(
      400,
      'Aturan threshold harus memenuhi: 0 < Rendah < Sedang < Tinggi <= 1.'
    );
  }

  const remoteEndpointUrl =
    typeof input.remoteEndpointUrl === 'string'
      ? input.remoteEndpointUrl.trim()
      : current.remoteEndpointUrl;
  if (remoteEndpointUrl) {
    try {
      const parsed = new URL(remoteEndpointUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Protocol invalid');
      }
    } catch {
      throw new ServiceError(400, 'URL endpoint inferensi remote harus diawali http:// atau https://.');
    }
  }

  const requestTimeoutMs =
    input.requestTimeoutMs !== undefined
      ? Math.round(Number(input.requestTimeoutMs))
      : current.requestTimeoutMs;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 3000 || requestTimeoutMs > 60000) {
    throw new ServiceError(400, 'Batas waktu inferensi (timeout) harus antara 3000 ms dan 60000 ms.');
  }

  const nowIso = new Date().toISOString();
  const db = getDb();
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE recognition_settings
      SET active_provider_id = ?,
          auto_add_high_confidence = ?,
          high_confidence_threshold = ?,
          medium_confidence_threshold = ?,
          low_confidence_threshold = ?,
          remote_endpoint_url = ?,
          request_timeout_ms = ?,
          updated_at = ?
      WHERE id = 1
    `).run(
      activeProviderId,
      autoAddHighConfidence ? 1 : 0,
      Number(high.toFixed(2)),
      Number(medium.toFixed(2)),
      Number(low.toFixed(2)),
      remoteEndpointUrl,
      requestTimeoutMs,
      nowIso
    );

    recordAuditLog(db, {
      action: 'RECOGNITION_SETTINGS_UPDATED',
      entityType: 'recognition',
      entityId: 'recognition-settings',
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Perbarui konfigurasi AI Recognition (provider: ${activeProviderId}, high >= ${Math.round(high * 100)}%, auto-add: ${autoAddHighConfidence ? 'aktif' : 'nonaktif'})`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getRecognitionSettings();
}

export function getRecognitionProviderStatuses() {
  const settings = getRecognitionSettings();
  return {
    settings,
    providers: listRecognitionProviders(settings),
  };
}

export function resolveCapturedRecognitionImagePath(requestedName: string): string {
  const safeName = path.basename(requestedName);
  if (!safeName || safeName !== requestedName || !/^[A-Za-z0-9._-]+$/.test(safeName)) {
    throw new ServiceError(400, 'Nama file gambar tangkapan tidak valid.');
  }
  const fullPath = path.join(getRecognitionUploadsDir(), safeName);
  if (!fs.existsSync(fullPath)) {
    throw new ServiceError(404, 'File gambar tangkapan AI tidak ditemukan.');
  }
  return fullPath;
}

export async function syncReferenceImageEmbeddings(
  options: {
    productId?: string;
    providerId?: string;
    force?: boolean;
    limit?: number;
  },
  actor?: UserSummary | null
): Promise<ReferenceEmbeddingSyncSummary> {
  const db = getDb();
  const settings = getRecognitionSettings();
  const targetProviderId = options.providerId?.trim() || settings.activeProviderId;
  const provider = getRecognitionProvider(targetProviderId);
  const status = provider.getStatus(settings);

  if (!provider.supportsEmbeddings || !provider.embedReferenceImage) {
    throw new ServiceError(
      400,
      `Provider "${provider.label}" tidak mendukung pembuatan embedding gambar referensi.`
    );
  }
  if (!status.available) {
    throw new ServiceError(
      503,
      status.reason || `Provider "${provider.label}" sedang tidak tersedia.`,
      'PROVIDER_UNAVAILABLE'
    );
  }

  const refRows = db
    .prepare(`
      SELECT pi.id, pi.product_id, pi.mime_type, pi.storage_path, pi.is_ai_reference, pi.is_primary,
             pie.vector_json AS existing_vector, pie.provider_id AS existing_provider
      FROM product_images pi
      INNER JOIN products p ON p.id = pi.product_id
      LEFT JOIN product_image_embeddings pie
        ON pie.image_id = pi.id AND pie.provider_id = ?
      WHERE p.status = 'ACTIVE'
        AND (pi.is_ai_reference = 1 OR pi.is_primary = 1)
        ${options.productId ? 'AND pi.product_id = ?' : ''}
      ORDER BY pi.is_ai_reference DESC, pi.is_primary DESC, pi.created_at DESC
    `)
    .all(...(options.productId ? [targetProviderId, options.productId] : [targetProviderId])) as Array<{
    id: string;
    product_id: string;
    mime_type: string;
    storage_path: string;
    is_ai_reference: number;
    is_primary: number;
    existing_vector: string | null;
    existing_provider: string | null;
  }>;

  const toProcess = refRows
    .filter((row) => options.force || !row.existing_vector)
    .slice(0, options.limit && options.limit > 0 ? options.limit : 100);

  let processed = 0;
  let readyCount = refRows.filter((row) => Boolean(row.existing_vector) && !options.force).length;
  const errors: Array<{ imageId: string; productId: string; message: string }> = [];

  const upsertStmt = db.prepare(`
    INSERT INTO product_image_embeddings (image_id, product_id, provider_id, model_name, dimensions, vector_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(image_id) DO UPDATE SET
      provider_id = excluded.provider_id,
      model_name = excluded.model_name,
      dimensions = excluded.dimensions,
      vector_json = excluded.vector_json,
      updated_at = excluded.updated_at
  `);
  const markReadyStmt = db.prepare(
    "UPDATE product_images SET ai_embedding_status = 'READY' WHERE id = ?"
  );

  for (const row of toProcess) {
    if (!row.storage_path || !fs.existsSync(row.storage_path)) {
      errors.push({
        imageId: row.id,
        productId: row.product_id,
        message: 'File gambar referensi tidak ditemukan di penyimpanan.',
      });
      continue;
    }

    try {
      const buf = fs.readFileSync(row.storage_path);
      const mimeType = ALLOWED_IMAGE_MIME[row.mime_type.toLowerCase()] ?? 'image/jpeg';
      const { vector, modelName } = await provider.embedReferenceImage(
        { buffer: buf, mimeType },
        { settings, timeoutMs: settings.requestTimeoutMs }
      );
      const nowIso = new Date().toISOString();
      upsertStmt.run(
        row.id,
        row.product_id,
        targetProviderId,
        modelName,
        vector.length,
        JSON.stringify(vector),
        nowIso
      );
      markReadyStmt.run(row.id);
      processed += 1;
      readyCount += 1;
    } catch (err) {
      errors.push({
        imageId: row.id,
        productId: row.product_id,
        message: err instanceof Error ? err.message : 'Gagal membuat embedding referensi.',
      });
    }
  }

  if (actor && processed > 0) {
    recordAuditLog(db, {
      action: 'RECOGNITION_INDEX_SYNCED',
      entityType: 'recognition',
      entityId: targetProviderId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary: `Sinkronisasi ${processed} embedding gambar referensi AI (provider: ${targetProviderId})`,
    });
  }

  return {
    providerId: targetProviderId,
    totalReferenceImages: refRows.length,
    processed,
    readyCount,
    failedCount: errors.length,
    errors,
  };
}

export async function identifyProductFromImage(
  raw: {
    dataBase64?: unknown;
    mimeType?: unknown;
    width?: unknown;
    height?: unknown;
    context?: unknown;
    providerId?: unknown;
    hints?: { ocrText?: unknown; productCode?: unknown };
  },
  actor: UserSummary
): Promise<RecognitionResult> {
  const startedAt = Date.now();
  const db = getDb();
  const settings = getRecognitionSettings();
  const targetProviderId =
    typeof raw.providerId === 'string' && raw.providerId.trim()
      ? raw.providerId.trim()
      : settings.activeProviderId;

  const context: RecognitionContext =
    typeof raw.context === 'string' && VALID_CONTEXTS.has(raw.context as RecognitionContext)
      ? (raw.context as RecognitionContext)
      : 'POS_CASHIER';

  // Step 1-2: Validate & persist preprocessed capture
  const { buffer, mimeType } = parseImagePayload(raw);
  const imageWidth = Number.isFinite(Number(raw.width)) ? Math.round(Number(raw.width)) : null;
  const imageHeight = Number.isFinite(Number(raw.height)) ? Math.round(Number(raw.height)) : null;

  const logId = nextId('rec');
  const uploadsDir = getRecognitionUploadsDir();
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  const capturedFileName = `${logId}.${extFromMime(mimeType)}`;
  const capturedPath = path.join(uploadsDir, capturedFileName);
  fs.writeFileSync(capturedPath, buffer);
  const capturedUrl = `/api/uploads/recognition/${capturedFileName}`;

  const insertErrorLog = (providerId: string, errorMessage: string) => {
    const nowIso = new Date().toISOString();
    const latency = Date.now() - startedAt;
    db.prepare(`
      INSERT INTO recognition_logs (
        id, user_id, user_name, provider_id, context, captured_image_url, captured_image_path,
        image_width, image_height, detected_region_json, ocr_json, candidates_json,
        top_product_id, top_confidence, confidence_band, selected_product_id,
        outcome, is_verified_feedback, notes, latency_ms, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'null', '{}', '[]', NULL, 0, 'UNKNOWN', NULL, 'ERROR', 0, '', ?, ?, ?, ?)
    `).run(
      logId,
      actor.id,
      actor.fullName,
      providerId,
      context,
      capturedUrl,
      capturedPath,
      imageWidth,
      imageHeight,
      latency,
      errorMessage,
      nowIso,
      nowIso
    );
  };

  let provider;
  try {
    provider = getRecognitionProvider(targetProviderId);
  } catch (err) {
    insertErrorLog(targetProviderId, err instanceof Error ? err.message : 'Unknown provider');
    throw err;
  }

  const providerStatus = provider.getStatus(settings);
  if (!providerStatus.available) {
    const msg =
      providerStatus.reason ||
      `Provider AI "${provider.label}" tidak tersedia. Gunakan pemindai barcode atau pencarian manual.`;
    insertErrorLog(provider.id, msg);
    throw new ServiceError(503, msg, 'PROVIDER_UNAVAILABLE');
  }

  // Step 3-6: Run product region detection + OCR extraction + visual embedding via pluggable provider
  const imageInput: RecognitionImageInput = {
    buffer,
    mimeType,
    width: imageWidth,
    height: imageHeight,
    hints: {
      ocrText: typeof raw.hints?.ocrText === 'string' ? raw.hints.ocrText : undefined,
      productCode: typeof raw.hints?.productCode === 'string' ? raw.hints.productCode : undefined,
    },
  };

  let analysis;
  try {
    analysis = await provider.analyzeImage(imageInput, {
      settings,
      timeoutMs: settings.requestTimeoutMs,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Inferensi AI gagal.';
    insertErrorLog(provider.id, errMsg);
    throw err;
  }

  // Step 7a: Opportunistically embed missing reference images (bounded batch) when provider supports embeddings
  if (analysis.embedding && provider.supportsEmbeddings && provider.embedReferenceImage) {
    await syncReferenceImageEmbeddings(
      { providerId: provider.id, limit: 8 },
      null
    ).catch(() => null);
  }

  // Step 7b-8: Load active product catalog + cached reference embeddings + verified feedback terms
  const activeProducts = queryEnrichedProducts().filter((p) => p.status === 'ACTIVE');
  const embeddingRows = db
    .prepare(`
      SELECT pie.image_id, pie.product_id, pie.vector_json, pi.is_ai_reference, pi.image_url
      FROM product_image_embeddings pie
      INNER JOIN product_images pi ON pi.id = pie.image_id
      WHERE pie.provider_id = ?
    `)
    .all(provider.id) as Array<{
    image_id: string;
    product_id: string;
    vector_json: string;
    is_ai_reference: number;
    image_url: string;
  }>;

  const embeddingsByProduct = new Map<
    string,
    Array<{ imageId: string; imageUrl: string; isAiReference: boolean; vector: number[] }>
  >();
  for (const row of embeddingRows) {
    try {
      const vec = JSON.parse(row.vector_json) as number[];
      if (!Array.isArray(vec) || vec.length === 0) continue;
      const list = embeddingsByProduct.get(row.product_id) ?? [];
      list.push({
        imageId: row.image_id,
        imageUrl: row.image_url,
        isAiReference: row.is_ai_reference === 1,
        vector: vec,
      });
      embeddingsByProduct.set(row.product_id, list);
    } catch {
      // Skip corrupted embedding vector
    }
  }

  const verifiedFeedbackRows = db
    .prepare(`
      SELECT selected_product_id, ocr_json
      FROM recognition_logs
      WHERE is_verified_feedback = 1
        AND selected_product_id IS NOT NULL
        AND outcome IN ('CONFIRMED', 'CORRECTED')
      ORDER BY created_at DESC
      LIMIT 300
    `)
    .all() as Array<{ selected_product_id: string; ocr_json: string }>;

  const feedbackTermsByProduct = new Map<string, string[]>();
  for (const fb of verifiedFeedbackRows) {
    try {
      const parsedOcr = JSON.parse(fb.ocr_json) as Partial<RecognitionOcrSignals>;
      const terms = [
        parsedOcr.productName,
        parsedOcr.brand,
        parsedOcr.variant,
        parsedOcr.size,
      ]
        .filter((s): s is string => typeof s === 'string' && Boolean(s.trim()));
      if (terms.length > 0) {
        const current = feedbackTermsByProduct.get(fb.selected_product_id) ?? [];
        feedbackTermsByProduct.set(fb.selected_product_id, [...current, ...terms]);
      }
    } catch {
      // ignore invalid JSON
    }
  }

  // Step 9-11: Score & rank candidates via multi-signal matching
  const scoredCandidates: RecognitionCandidate[] = activeProducts
    .map((product) => {
      const score = scoreProductCandidate({
        product,
        referenceEmbeddings: embeddingsByProduct.get(product.id) ?? [],
        verifiedFeedbackTerms: feedbackTermsByProduct.get(product.id) ?? [],
        queryEmbedding: analysis.embedding,
        ocr: analysis.ocr,
        settings,
      });

      return {
        productId: product.id,
        sku: product.sku,
        barcode: product.barcode,
        name: product.name,
        brandName: product.brandName,
        category: product.category,
        variant: product.variant,
        size: product.size,
        sellPrice: product.sellPrice,
        specialPrice: product.specialPrice,
        stock: product.stock,
        unit: product.unit,
        primaryImageUrl: product.primaryImageUrl,
        matchedReferenceImageUrl: score.matchedReferenceImageUrl,
        confidence: score.confidence,
        confidenceBand: score.confidenceBand,
        matchReasons: score.matchReasons,
        signals: score.signals,
      };
    })
    .filter((c) => c.confidence >= 0.08)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  const bestMatch = scoredCandidates[0] ?? null;
  const topConfidence = bestMatch ? bestMatch.confidence : 0;
  const confidenceBand: RecognitionConfidenceBand = bestMatch
    ? classifyConfidenceBand(topConfidence, settings)
    : 'UNKNOWN';

  // Auto-add ONLY when explicitly enabled AND high confidence AND stock > 0
  const autoAddEligible = Boolean(
    settings.autoAddHighConfidence &&
      confidenceBand === 'HIGH' &&
      bestMatch &&
      bestMatch.stock > 0
  );

  const latencyMs = Date.now() - startedAt;
  const nowIso = new Date().toISOString();

  // Step 13: Persist recognition log for cashier verification & feedback tracking
  db.prepare(`
    INSERT INTO recognition_logs (
      id, user_id, user_name, provider_id, context, captured_image_url, captured_image_path,
      image_width, image_height, detected_region_json, ocr_json, candidates_json,
      top_product_id, top_confidence, confidence_band, selected_product_id,
      outcome, is_verified_feedback, notes, latency_ms, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'PENDING', 0, '', ?, NULL, ?, ?)
  `).run(
    logId,
    actor.id,
    actor.fullName,
    provider.id,
    context,
    capturedUrl,
    capturedPath,
    imageWidth,
    imageHeight,
    JSON.stringify(analysis.detectedRegion),
    JSON.stringify(analysis.ocr),
    JSON.stringify(scoredCandidates),
    bestMatch ? bestMatch.productId : null,
    topConfidence,
    confidenceBand,
    latencyMs,
    nowIso,
    nowIso
  );

  return {
    logId,
    providerId: provider.id,
    providerLabel: provider.label,
    capturedImageUrl: capturedUrl,
    imageWidth,
    imageHeight,
    detectedRegion: analysis.detectedRegion,
    ocrSignals: analysis.ocr,
    candidates: scoredCandidates,
    bestMatch,
    confidenceBand,
    autoAddEligible,
    latencyMs,
    settingsSnapshot: settings,
    createdAt: nowIso,
  };
}

export function recordRecognitionFeedback(
  logId: string,
  input: {
    outcome?: unknown;
    selectedProductId?: unknown;
    notes?: unknown;
    promoteAsReferenceImage?: unknown;
    referenceAngle?: unknown;
  },
  actor: UserSummary
): RecognitionLogEntry {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT id, user_id, user_name, provider_id, context, captured_image_url, captured_image_path,
             image_width, image_height, detected_region_json, ocr_json, candidates_json,
             top_product_id, top_confidence, confidence_band, selected_product_id,
             outcome, is_verified_feedback, notes, latency_ms, error_message, created_at, updated_at
      FROM recognition_logs
      WHERE id = ?
    `)
    .get(logId) as
    | {
        id: string;
        user_id: string | null;
        user_name: string;
        provider_id: string;
        context: RecognitionContext;
        captured_image_url: string | null;
        captured_image_path: string | null;
        image_width: number | null;
        image_height: number | null;
        detected_region_json: string;
        ocr_json: string;
        candidates_json: string;
        top_product_id: string | null;
        top_confidence: number;
        confidence_band: RecognitionConfidenceBand;
        selected_product_id: string | null;
        outcome: RecognitionOutcome;
        is_verified_feedback: number;
        notes: string;
        latency_ms: number;
        error_message: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    throw new ServiceError(404, 'Riwayat pengenalan AI tidak ditemukan.');
  }

  const outcomeRaw = typeof input.outcome === 'string' ? input.outcome.trim().toUpperCase() : '';
  const allowedOutcomes: ReadonlySet<RecognitionOutcome> = new Set([
    'CONFIRMED',
    'CORRECTED',
    'REGISTERED_NEW',
    'REJECTED',
  ]);
  if (!allowedOutcomes.has(outcomeRaw as RecognitionOutcome)) {
    throw new ServiceError(
      400,
      'Outcome umpan balik harus berupa CONFIRMED, CORRECTED, REGISTERED_NEW, atau REJECTED.'
    );
  }
  const outcome = outcomeRaw as RecognitionOutcome;

  let selectedProductId =
    typeof input.selectedProductId === 'string' && input.selectedProductId.trim()
      ? input.selectedProductId.trim()
      : null;

  if (outcome === 'CONFIRMED' && !selectedProductId) {
    selectedProductId = row.top_product_id;
  }

  let selectedProductName: string | null = null;
  if (outcome !== 'REJECTED') {
    if (!selectedProductId) {
      throw new ServiceError(400, 'selectedProductId wajib diisi untuk konfirmasi atau koreksi produk.');
    }
    const prod = db
      .prepare('SELECT id, name FROM products WHERE id = ?')
      .get(selectedProductId) as { id: string; name: string } | undefined;
    if (!prod) {
      throw new ServiceError(404, 'Produk terpilih untuk umpan balik pengenalan AI tidak ditemukan.');
    }
    selectedProductName = prod.name;
  }

  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 300) : '';
  const isVerifiedFeedback = outcome === 'CONFIRMED' || outcome === 'CORRECTED' || outcome === 'REGISTERED_NEW';
  const nowIso = new Date().toISOString();

  // Promote captured snapshot into product_images (is_ai_reference = 1) ONLY when explicitly requested & verified
  const shouldPromote =
    Boolean(input.promoteAsReferenceImage) &&
    isVerifiedFeedback &&
    Boolean(selectedProductId) &&
    Boolean(row.captured_image_path) &&
    fs.existsSync(row.captured_image_path!) &&
    (actor.permissions.includes('products:edit') || actor.permissions.includes('products:create'));

  const angle: ImageReferenceAngle =
    typeof input.referenceAngle === 'string' && VALID_ANGLES.has(input.referenceAngle as ImageReferenceAngle)
      ? (input.referenceAngle as ImageReferenceAngle)
      : 'front';

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      UPDATE recognition_logs
      SET selected_product_id = ?,
          outcome = ?,
          is_verified_feedback = ?,
          notes = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      selectedProductId,
      outcome,
      isVerifiedFeedback ? 1 : 0,
      notes,
      nowIso,
      logId
    );

    if (shouldPromote && selectedProductId && row.captured_image_path) {
      const prodDir = getProductUploadsDir();
      if (!fs.existsSync(prodDir)) {
        fs.mkdirSync(prodDir, { recursive: true });
      }
      const ext = path.extname(row.captured_image_path) || '.jpg';
      const newImageId = nextId('img');
      const newFileName = `${newImageId}${ext}`;
      const targetPath = path.join(prodDir, newFileName);
      const imageUrl = `/api/uploads/products/${newFileName}`;
      fs.copyFileSync(row.captured_image_path, targetPath);
      const fileStats = fs.statSync(targetPath);

      const existingCount = db
        .prepare('SELECT COUNT(*) as cnt FROM product_images WHERE product_id = ?')
        .get(selectedProductId) as { cnt: number };

      const isPrimary = existingCount.cnt === 0 ? 1 : 0;
      db.prepare(`
        INSERT INTO product_images (
          id, product_id, file_name, mime_type, file_size, image_url, storage_path,
          is_primary, is_ai_reference, reference_angle, ai_embedding_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'PENDING', ?)
      `).run(
        newImageId,
        selectedProductId,
        newFileName,
        ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
        fileStats.size,
        imageUrl,
        targetPath,
        isPrimary,
        angle,
        nowIso
      );

      if (isPrimary === 1) {
        db.prepare('UPDATE products SET primary_image_id = ?, updated_at = ? WHERE id = ?').run(
          newImageId,
          nowIso,
          selectedProductId
        );
      }
    }

    recordAuditLog(db, {
      action: 'RECOGNITION_FEEDBACK_RECORDED',
      entityType: 'recognition',
      entityId: logId,
      actorUserId: actor.id,
      actor: actor.fullName,
      summary:
        outcome === 'REJECTED'
          ? `Tandai hasil pengenalan AI ${logId} tidak cocok`
          : `Verifikasi hasil pengenalan AI (${outcome}) -> "${selectedProductName}"`,
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getRecognitionLogById(logId)!;
}

export function getRecognitionLogById(logId: string): RecognitionLogEntry | null {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT l.id, l.user_id, l.user_name, l.provider_id, l.context, l.captured_image_url,
             l.image_width, l.image_height, l.detected_region_json, l.ocr_json, l.candidates_json,
             l.top_product_id, tp.name AS top_product_name, l.top_confidence, l.confidence_band,
             l.selected_product_id, sp.name AS selected_product_name,
             l.outcome, l.is_verified_feedback, l.notes, l.latency_ms, l.error_message,
             l.created_at, l.updated_at
      FROM recognition_logs l
      LEFT JOIN products tp ON tp.id = l.top_product_id
      LEFT JOIN products sp ON sp.id = l.selected_product_id
      WHERE l.id = ?
    `)
    .get(logId) as
    | {
        id: string;
        user_id: string | null;
        user_name: string;
        provider_id: string;
        context: RecognitionContext;
        captured_image_url: string | null;
        image_width: number | null;
        image_height: number | null;
        detected_region_json: string;
        ocr_json: string;
        candidates_json: string;
        top_product_id: string | null;
        top_product_name: string | null;
        top_confidence: number;
        confidence_band: RecognitionConfidenceBand;
        selected_product_id: string | null;
        selected_product_name: string | null;
        outcome: RecognitionOutcome;
        is_verified_feedback: number;
        notes: string;
        latency_ms: number;
        error_message: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) return null;
  return mapRecognitionLogRow(row);
}

function mapRecognitionLogRow(row: {
  id: string;
  user_id: string | null;
  user_name: string;
  provider_id: string;
  context: RecognitionContext;
  captured_image_url: string | null;
  image_width: number | null;
  image_height: number | null;
  detected_region_json: string;
  ocr_json: string;
  candidates_json: string;
  top_product_id: string | null;
  top_product_name: string | null;
  top_confidence: number;
  confidence_band: RecognitionConfidenceBand;
  selected_product_id: string | null;
  selected_product_name: string | null;
  outcome: RecognitionOutcome;
  is_verified_feedback: number;
  notes: string;
  latency_ms: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}): RecognitionLogEntry {
  let detectedRegion: RecognitionBoundingBox | null = null;
  let ocrSignals = normalizeOcrSignals();
  let candidates: RecognitionCandidate[] = [];
  try {
    detectedRegion = JSON.parse(row.detected_region_json) as RecognitionBoundingBox | null;
  } catch {
    detectedRegion = null;
  }
  try {
    ocrSignals = normalizeOcrSignals(JSON.parse(row.ocr_json) as Partial<RecognitionOcrSignals>);
  } catch {
    ocrSignals = normalizeOcrSignals();
  }
  try {
    const parsed = JSON.parse(row.candidates_json);
    candidates = Array.isArray(parsed) ? (parsed as RecognitionCandidate[]) : [];
  } catch {
    candidates = [];
  }

  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    providerId: row.provider_id,
    context: row.context,
    capturedImageUrl: row.captured_image_url,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    detectedRegion,
    ocrSignals,
    candidates,
    topProductId: row.top_product_id,
    topProductName: row.top_product_name,
    topConfidence: row.top_confidence,
    confidenceBand: row.confidence_band,
    selectedProductId: row.selected_product_id,
    selectedProductName: row.selected_product_name,
    outcome: row.outcome,
    isVerifiedFeedback: row.is_verified_feedback === 1,
    notes: row.notes,
    latencyMs: row.latency_ms,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listRecognitionLogs(options?: {
  outcome?: string;
  limit?: number;
}): RecognitionLogEntry[] {
  const db = getDb();
  const limit = Math.min(200, Math.max(1, Number(options?.limit ?? 50)));
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (options?.outcome && options.outcome !== 'ALL') {
    where.push('l.outcome = ?');
    params.push(options.outcome);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);

  const rows = db
    .prepare(`
      SELECT l.id, l.user_id, l.user_name, l.provider_id, l.context, l.captured_image_url,
             l.image_width, l.image_height, l.detected_region_json, l.ocr_json, l.candidates_json,
             l.top_product_id, tp.name AS top_product_name, l.top_confidence, l.confidence_band,
             l.selected_product_id, sp.name AS selected_product_name,
             l.outcome, l.is_verified_feedback, l.notes, l.latency_ms, l.error_message,
             l.created_at, l.updated_at
      FROM recognition_logs l
      LEFT JOIN products tp ON tp.id = l.top_product_id
      LEFT JOIN products sp ON sp.id = l.selected_product_id
      ${whereSql}
      ORDER BY l.created_at DESC
      LIMIT ?
    `)
    .all(...params) as Array<Parameters<typeof mapRecognitionLogRow>[0]>;

  return rows.map(mapRecognitionLogRow);
}
