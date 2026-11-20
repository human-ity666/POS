import type {
  Product,
  RecognitionBoundingBox,
  RecognitionConfidenceBand,
  RecognitionOcrSignals,
  RecognitionProviderKind,
  RecognitionSettings,
  RecognitionSignalBreakdown,
} from '../../../src/types.ts';
import { ServiceError } from '../errors.ts';

export interface RecognitionImageInput {
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  width?: number | null;
  height?: number | null;
  hints?: {
    ocrText?: string;
    productCode?: string;
  };
}

export interface ProviderAnalysisOutput {
  ocr: RecognitionOcrSignals;
  detectedRegion: RecognitionBoundingBox | null;
  embedding: number[] | null;
  embeddingModel: string | null;
  analysisModel: string | null;
}

export interface ProviderRuntimeContext {
  settings: RecognitionSettings;
  timeoutMs: number;
}

export interface RecognitionProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: RecognitionProviderKind;
  readonly supportsOcr: boolean;
  readonly supportsEmbeddings: boolean;
  getStatus(settings?: RecognitionSettings): {
    available: boolean;
    reason?: string;
    modelName?: string;
  };
  analyzeImage(
    input: RecognitionImageInput,
    ctx: ProviderRuntimeContext
  ): Promise<ProviderAnalysisOutput>;
  embedReferenceImage?(
    input: Pick<RecognitionImageInput, 'buffer' | 'mimeType'>,
    ctx: ProviderRuntimeContext
  ): Promise<{ vector: number[]; modelName: string }>;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ServiceError(504, timeoutMessage, 'PROVIDER_TIMEOUT'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA <= 0 || normB <= 0) return 0;
  const raw = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Clamp to [0, 1] since retail image embedding similarity in negative space indicates unrelated pairs
  return Math.max(0, Math.min(1, raw));
}

export function normalizeOcrSignals(
  partial?: Partial<RecognitionOcrSignals> | null
): RecognitionOcrSignals {
  const cleanStr = (val: unknown, maxLen = 240): string =>
    typeof val === 'string' ? val.trim().slice(0, maxLen) : '';
  const keywordsRaw = Array.isArray(partial?.keywords)
    ? partial!.keywords
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.trim())
        .filter(Boolean)
    : [];

  return {
    productName: cleanStr(partial?.productName, 160),
    brand: cleanStr(partial?.brand, 80),
    variant: cleanStr(partial?.variant, 100),
    flavor: cleanStr(partial?.flavor, 100),
    weight: cleanStr(partial?.weight, 40),
    volume: cleanStr(partial?.volume, 40),
    size: cleanStr(partial?.size, 60),
    packagingType: cleanStr(partial?.packagingType, 60),
    productCode: cleanStr(partial?.productCode, 80),
    rawText: cleanStr(partial?.rawText, 1200),
    keywords: Array.from(new Set(keywordsRaw)).slice(0, 20),
  };
}

function tokenizeNormalized(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function tokenOverlapScore(queryTokens: string[], targetTokens: string[]): number {
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0;
  const targetSet = new Set(targetTokens);
  let matched = 0;
  for (const qt of queryTokens) {
    if (targetSet.has(qt)) {
      matched += 1;
      continue;
    }
    // Partial prefix/substring match for OCR typos (min length 4)
    if (qt.length >= 4 && targetTokens.some((tt) => tt.includes(qt) || qt.includes(tt))) {
      matched += 0.72;
    }
  }
  const precision = matched / queryTokens.length;
  const recall = matched / targetTokens.length;
  if (precision + recall === 0) return 0;
  return Math.min(1, (2 * precision * recall) / (precision + recall));
}

export interface ParsedMeasure {
  kind: 'weight' | 'volume';
  valueInBaseUnit: number; // grams for weight, ml for volume
}

export function parseMeasureString(raw: string): ParsedMeasure | null {
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(',', '.').trim();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(kg|kilogram|gr|gram|g|ltr|liter|l|ml|mililiter)\b/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2];
  if (unit === 'kg' || unit === 'kilogram') {
    return { kind: 'weight', valueInBaseUnit: amount * 1000 };
  }
  if (unit === 'gr' || unit === 'gram' || unit === 'g') {
    return { kind: 'weight', valueInBaseUnit: amount };
  }
  if (unit === 'l' || unit === 'ltr' || unit === 'liter') {
    return { kind: 'volume', valueInBaseUnit: amount * 1000 };
  }
  if (unit === 'ml' || unit === 'mililiter') {
    return { kind: 'volume', valueInBaseUnit: amount };
  }
  return null;
}

function extractMeasuresFromProduct(product: Product): ParsedMeasure[] {
  const list: ParsedMeasure[] = [];
  if (product.weight && product.weight > 0) {
    list.push({ kind: 'weight', valueInBaseUnit: product.weight });
  }
  if (product.volume && product.volume > 0) {
    list.push({ kind: 'volume', valueInBaseUnit: product.volume });
  }
  for (const field of [product.size, product.name, product.variant]) {
    const parsed = parseMeasureString(field);
    if (parsed) list.push(parsed);
  }
  return list;
}

function extractMeasuresFromOcr(ocr: RecognitionOcrSignals): ParsedMeasure[] {
  const list: ParsedMeasure[] = [];
  for (const field of [ocr.weight, ocr.volume, ocr.size, ocr.productName, ocr.rawText]) {
    if (!field) continue;
    const parsed = parseMeasureString(field);
    if (parsed) list.push(parsed);
  }
  return list;
}

const PACKAGING_SYNONYMS: Record<string, string[]> = {
  bottle: ['botol', 'bottle', 'btl'],
  box: ['kotak', 'box', 'dus', 'karton', 'uht'],
  pouch: ['pouch', 'refill', 'isi ulang', 'pack'],
  pack: ['bungkus', 'pack', 'bks', 'sachet', 'bag', 'kemasan'],
  can: ['kaleng', 'can'],
  tube: ['tube', 'pasta'],
  jar: ['toples', 'jar'],
};

function normalizePackagingFamily(text: string): string[] {
  const lower = text.toLowerCase();
  const families: string[] = [];
  for (const [family, terms] of Object.entries(PACKAGING_SYNONYMS)) {
    if (terms.some((term) => lower.includes(term))) {
      families.push(family);
    }
  }
  return families;
}

export interface ProductRankingInput {
  product: Product;
  referenceEmbeddings: Array<{ imageId: string; imageUrl: string; isAiReference: boolean; vector: number[] }>;
  verifiedFeedbackTerms: string[];
  queryEmbedding: number[] | null;
  ocr: RecognitionOcrSignals;
  settings: RecognitionSettings;
}

export interface ProductRankingScore {
  confidence: number;
  confidenceBand: RecognitionConfidenceBand;
  matchedReferenceImageUrl: string | null;
  signals: RecognitionSignalBreakdown;
  matchReasons: string[];
}

export function classifyConfidenceBand(
  confidence: number,
  settings: RecognitionSettings
): RecognitionConfidenceBand {
  if (confidence >= settings.highConfidenceThreshold) return 'HIGH';
  if (confidence >= settings.mediumConfidenceThreshold) return 'MEDIUM';
  if (confidence >= settings.lowConfidenceThreshold) return 'LOW';
  return 'UNKNOWN';
}

export function scoreProductCandidate(input: ProductRankingInput): ProductRankingScore {
  const { product, referenceEmbeddings, verifiedFeedbackTerms, queryEmbedding, ocr, settings } = input;
  const reasons: string[] = [];

  // 1. Visual embedding similarity (never color-only)
  let imageSimilarity = 0;
  let matchedReferenceImageUrl: string | null = null;
  if (queryEmbedding && queryEmbedding.length > 0 && referenceEmbeddings.length > 0) {
    for (const ref of referenceEmbeddings) {
      if (ref.vector.length !== queryEmbedding.length) continue;
      const rawSim = cosineSimilarity(queryEmbedding, ref.vector);
      // Slight preference if the image is explicitly marked as an AI reference image
      const effectiveSim = ref.isAiReference ? rawSim : rawSim * 0.96;
      if (effectiveSim > imageSimilarity) {
        imageSimilarity = effectiveSim;
        matchedReferenceImageUrl = ref.imageUrl;
      }
    }
    if (imageSimilarity >= 0.72) {
      reasons.push(`Kemiripan visual referensi ${Math.round(imageSimilarity * 100)}%`);
    }
  }

  // 2. OCR text & barcode/SKU code similarity
  const ocrCompositeText = [
    ocr.productName,
    ocr.brand,
    ocr.variant,
    ocr.flavor,
    ocr.size,
    ocr.rawText,
    ...ocr.keywords,
  ]
    .filter(Boolean)
    .join(' ');
  const ocrTokens = Array.from(new Set(tokenizeNormalized(ocrCompositeText)));

  const productText = [
    product.name,
    product.brandName,
    product.variant,
    product.size,
    product.sku,
    product.category,
    product.subcategoryName,
  ]
    .filter(Boolean)
    .join(' ');
  const productTokens = Array.from(new Set(tokenizeNormalized(productText)));

  let ocrTextSimilarity = tokenOverlapScore(
    Array.from(new Set(tokenizeNormalized([ocr.productName, ocr.variant, ocr.flavor, ocr.rawText].join(' ')))),
    productTokens
  );

  // Exact product code / SKU / barcode detected in packaging OCR
  const normalizedCode = ocr.productCode.replace(/\s+/g, '').toLowerCase();
  if (normalizedCode.length >= 4) {
    const codeMatch =
      product.sku.toLowerCase() === normalizedCode ||
      product.barcode.toLowerCase() === normalizedCode ||
      product.barcodes.some((b) => b.barcode.toLowerCase() === normalizedCode);
    if (codeMatch) {
      ocrTextSimilarity = Math.max(ocrTextSimilarity, 0.98);
      reasons.push(`Kode produk/SKU terbaca: ${ocr.productCode}`);
    }
  }
  if (ocrTextSimilarity >= 0.5 && reasons.length < 3) {
    reasons.push(`Teks kemasan cocok (${Math.round(ocrTextSimilarity * 100)}%)`);
  }

  // 3. Brand match
  let brandMatch = 0;
  let brandConflict = false;
  const prodBrand = product.brandName.trim().toLowerCase();
  const ocrBrand = ocr.brand.trim().toLowerCase();
  if (prodBrand && prodBrand !== 'umum') {
    if (ocrBrand) {
      if (ocrBrand === prodBrand || ocrBrand.includes(prodBrand) || prodBrand.includes(ocrBrand)) {
        brandMatch = 1;
        reasons.push(`Merek cocok: ${product.brandName}`);
      } else {
        brandMatch = 0;
        brandConflict = true;
      }
    } else if (ocrCompositeText.toLowerCase().includes(prodBrand)) {
      brandMatch = 0.85;
      reasons.push(`Merek terdeteksi pada teks: ${product.brandName}`);
    }
  }

  // 4. Variant & flavor match
  let variantMatch = 0;
  let variantConflict = false;
  const prodVariantTokens = tokenizeNormalized(product.variant);
  const ocrVariantTokens = tokenizeNormalized([ocr.variant, ocr.flavor, ocr.productName].join(' '));
  if (prodVariantTokens.length > 0 && ocrVariantTokens.length > 0) {
    variantMatch = tokenOverlapScore(ocrVariantTokens, prodVariantTokens);
    if (variantMatch >= 0.6) {
      reasons.push(`Varian cocok: ${product.variant}`);
    } else if (ocr.variant && prodVariantTokens.length > 0 && variantMatch === 0) {
      variantConflict = true;
    }
  }

  // 5. Weight / volume / size match (normalized grams/ml)
  let measureMatch = 0;
  let measureConflict = false;
  const prodMeasures = extractMeasuresFromProduct(product);
  const ocrMeasures = extractMeasuresFromOcr(ocr);
  if (prodMeasures.length > 0 && ocrMeasures.length > 0) {
    let bestRatio = 0;
    for (const pm of prodMeasures) {
      for (const om of ocrMeasures) {
        if (pm.kind !== om.kind) continue;
        const diffRatio = Math.abs(pm.valueInBaseUnit - om.valueInBaseUnit) / Math.max(pm.valueInBaseUnit, om.valueInBaseUnit);
        if (diffRatio <= 0.03) {
          bestRatio = 1;
        } else if (diffRatio <= 0.12) {
          bestRatio = Math.max(bestRatio, 0.55);
        } else {
          measureConflict = true;
        }
      }
    }
    measureMatch = bestRatio;
    if (measureMatch >= 0.9) {
      reasons.push(`Ukuran/isi cocok (${product.size || `${product.weight ?? product.volume}`})`);
    }
  }

  // 6. Packaging type match
  let packagingMatch = 0;
  const prodPack = normalizePackagingFamily(`${product.unit} ${product.name} ${product.variant}`);
  const ocrPack = normalizePackagingFamily(`${ocr.packagingType} ${ocr.rawText}`);
  if (prodPack.length > 0 && ocrPack.length > 0) {
    if (prodPack.some((f) => ocrPack.includes(f))) {
      packagingMatch = 1;
    }
  }

  // 7. Verified feedback boost (only when current OCR has positive alignment too)
  let feedbackBoost = 0;
  if (verifiedFeedbackTerms.length > 0 && ocrTokens.length > 0) {
    const fbTokens = Array.from(new Set(tokenizeNormalized(verifiedFeedbackTerms.join(' '))));
    const fbOverlap = tokenOverlapScore(ocrTokens, fbTokens);
    if (fbOverlap >= 0.35) {
      feedbackBoost = Math.min(0.06, fbOverlap * 0.06);
    }
  }

  // Combine multi-signal weights (explicitly non-color-based)
  const hasEmbeddings = Boolean(queryEmbedding && queryEmbedding.length > 0 && referenceEmbeddings.length > 0);
  const hasOcrContent = ocrTokens.length > 0 || normalizedCode.length >= 4;

  let weighted = 0;
  if (hasEmbeddings && hasOcrContent) {
    weighted =
      imageSimilarity * 0.36 +
      ocrTextSimilarity * 0.28 +
      brandMatch * 0.14 +
      variantMatch * 0.1 +
      measureMatch * 0.08 +
      packagingMatch * 0.04 +
      feedbackBoost;
  } else if (hasEmbeddings) {
    // Visual embedding only (e.g., obscured label) - cap confidence conservatively so single visual signal doesn't overclaim
    weighted = imageSimilarity * 0.78 + feedbackBoost;
  } else if (hasOcrContent) {
    // Re-distribute weights across OCR + brand + variant + measure + packaging
    weighted =
      ocrTextSimilarity * 0.44 +
      brandMatch * 0.22 +
      variantMatch * 0.16 +
      measureMatch * 0.12 +
      packagingMatch * 0.06 +
      feedbackBoost;
  }

  // Conflict penalties: guard against wrong brand/variant/size sharing similar colors/templates
  if (brandConflict) weighted *= 0.65;
  if (variantConflict) weighted *= 0.82;
  if (measureConflict && measureMatch === 0) weighted *= 0.84;

  const confidence = Number(Math.max(0, Math.min(0.99, weighted)).toFixed(4));
  const confidenceBand = classifyConfidenceBand(confidence, settings);

  return {
    confidence,
    confidenceBand,
    matchedReferenceImageUrl,
    signals: {
      imageSimilarity: Number(imageSimilarity.toFixed(4)),
      ocrTextSimilarity: Number(ocrTextSimilarity.toFixed(4)),
      brandMatch: Number(brandMatch.toFixed(4)),
      variantMatch: Number(variantMatch.toFixed(4)),
      measureMatch: Number(measureMatch.toFixed(4)),
      packagingMatch: Number(packagingMatch.toFixed(4)),
      feedbackBoost: Number(feedbackBoost.toFixed(4)),
    },
    matchReasons: reasons,
  };
}
