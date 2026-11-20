import { GoogleGenAI, Type } from '@google/genai';
import { ServiceError } from '../errors.ts';
import {
  normalizeOcrSignals,
  withTimeout,
  type ProviderAnalysisOutput,
  type ProviderRuntimeContext,
  type RecognitionImageInput,
  type RecognitionProvider,
} from './providerTypes.ts';
import type { RecognitionBoundingBox } from '../../../src/types.ts';

const VISION_ANALYSIS_MODEL = 'gemini-4-hydrogen';
const EMBEDDING_MODEL = 'gemini-embedding-2';

function createGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function mapGeminiError(err: unknown): never {
  if (err instanceof ServiceError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (/403|PERMISSION_DENIED|API_KEY_INVALID|API key not valid/i.test(message)) {
    throw new ServiceError(
      503,
      'Akses Gemini Vision API ditolak atau API key server tidak valid.',
      'PROVIDER_UNAVAILABLE'
    );
  }
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(message)) {
    throw new ServiceError(
      503,
      'Kuota Gemini Vision API sementara terlampaui. Silakan coba lagi atau gunakan pemindai barcode.',
      'PROVIDER_RATE_LIMITED'
    );
  }
  if (/404|NOT_FOUND/i.test(message)) {
    throw new ServiceError(
      503,
      `Model Gemini (${VISION_ANALYSIS_MODEL} / ${EMBEDDING_MODEL}) tidak tersedia pada endpoint saat ini.`,
      'PROVIDER_UNAVAILABLE'
    );
  }
  throw new ServiceError(
    502,
    `Layanan Gemini Vision gagal memproses gambar: ${message}`,
    'PROVIDER_ERROR'
  );
}

const PACKAGING_OCR_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    detectedRegion: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        x: { type: Type.NUMBER },
        y: { type: Type.NUMBER },
        width: { type: Type.NUMBER },
        height: { type: Type.NUMBER },
        label: { type: Type.STRING },
        confidence: { type: Type.NUMBER },
      },
    },
    productName: { type: Type.STRING },
    brand: { type: Type.STRING },
    variant: { type: Type.STRING },
    flavor: { type: Type.STRING },
    weight: { type: Type.STRING },
    volume: { type: Type.STRING },
    size: { type: Type.STRING },
    packagingType: { type: Type.STRING },
    productCode: { type: Type.STRING },
    rawText: { type: Type.STRING },
    keywords: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: [
    'productName',
    'brand',
    'variant',
    'flavor',
    'weight',
    'volume',
    'size',
    'packagingType',
    'productCode',
    'rawText',
    'keywords',
  ],
};

function sanitizeBoundingBox(raw: unknown): RecognitionBoundingBox | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const x = Number(obj.x);
  const y = Number(obj.y);
  const width = Number(obj.width);
  const height = Number(obj.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return {
    x: clamp01(x),
    y: clamp01(y),
    width: clamp01(width),
    height: clamp01(height),
    label: typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : 'Produk Kemasan',
    confidence: Number.isFinite(Number(obj.confidence)) ? clamp01(Number(obj.confidence)) : 0.8,
  };
}

export class GeminiVisionRecognitionProvider implements RecognitionProvider {
  readonly id = 'gemini-vision';
  readonly label = 'Gemini Multimodal Vision & Embedding';
  readonly kind = 'vision-ai' as const;
  readonly supportsOcr = true;
  readonly supportsEmbeddings = true;

  getStatus() {
    const hasKey = Boolean(process.env.GEMINI_API_KEY?.trim());
    return {
      available: hasKey,
      reason: hasKey
        ? undefined
        : 'GEMINI_API_KEY belum tersedia di environment server.',
      modelName: `${VISION_ANALYSIS_MODEL} + ${EMBEDDING_MODEL}`,
    };
  }

  async embedReferenceImage(
    input: Pick<RecognitionImageInput, 'buffer' | 'mimeType'>,
    ctx: ProviderRuntimeContext
  ): Promise<{ vector: number[]; modelName: string }> {
    const ai = createGeminiClient();
    if (!ai) {
      throw new ServiceError(
        503,
        'Gemini Vision API tidak tersedia (GEMINI_API_KEY belum dikonfigurasi pada server).',
        'PROVIDER_UNAVAILABLE'
      );
    }

    const base64 = input.buffer.toString('base64');
    try {
      const response = await withTimeout(
        ai.models.embedContent({
          model: EMBEDDING_MODEL,
          contents: [
            {
              inlineData: {
                data: base64,
                mimeType: input.mimeType,
              },
            },
          ],
        }),
        ctx.timeoutMs,
        'Permintaan embedding gambar referensi ke Gemini melebihi batas waktu.'
      );

      const values = response.embeddings?.[0]?.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new ServiceError(502, 'Gemini tidak mengembalikan vektor embedding gambar.', 'PROVIDER_ERROR');
      }
      return { vector: values, modelName: EMBEDDING_MODEL };
    } catch (err) {
      mapGeminiError(err);
    }
  }

  async analyzeImage(
    input: RecognitionImageInput,
    ctx: ProviderRuntimeContext
  ): Promise<ProviderAnalysisOutput> {
    const ai = createGeminiClient();
    if (!ai) {
      throw new ServiceError(
        503,
        'Layanan AI Pengenalan Produk belum tersedia karena GEMINI_API_KEY belum dikonfigurasi pada server. Gunakan pemindai barcode atau pencarian manual.',
        'PROVIDER_UNAVAILABLE'
      );
    }

    const base64 = input.buffer.toString('base64');
    const prompt = [
      'Analisis foto kemasan produk ritel Indonesia ini untuk identifikasi kasir POS.',
      'Ekstrak seluruh teks OCR yang terbaca pada kemasan secara akurat, bukan menebak dari warna saja.',
      'Identifikasi:',
      '- detectedRegion: koordinat kotak produk utama dalam rasio 0..1 (x, y, width, height, label, confidence)',
      '- productName: nama produk utama pada label kemasan',
      '- brand: nama merek yang tertulis pada kemasan',
      '- variant: varian atau tipe kemasan (misal Goreng Spesial, Total 10, Refill)',
      '- flavor: rasa atau aroma jika tertera (misal Cokelat, Sapi Panggang, Jeruk Nipis)',
      '- weight: berat bersih jika tertera (misal 85g, 5kg)',
      '- volume: volume isi jika tertera (misal 600ml, 1L)',
      '- size: ukuran ringkas yang paling menonjol (misal 600ml atau 85g)',
      '- packagingType: jenis kemasan (botol, kotak, pouch, kaleng, bungkus, sachet, tube)',
      '- productCode: kode/angka barcode/SKU jika terlihat tertulis di kemasan',
      '- rawText: teks OCR penting yang terbaca di label kemasan',
      '- keywords: daftar kata kunci penting pada kemasan.',
      'Jika tidak ada produk yang jelas atau teks tidak terbaca, biarkan string kosong tanpa mengarang informasi.',
    ].join('\n');

    try {
      const [visionResult, embeddingResult] = await withTimeout(
        Promise.all([
          ai.models.generateContent({
            model: VISION_ANALYSIS_MODEL,
            contents: [
              {
                inlineData: {
                  data: base64,
                  mimeType: input.mimeType,
                },
              },
              prompt,
            ],
            config: {
              responseMimeType: 'application/json',
              responseSchema: PACKAGING_OCR_SCHEMA,
            },
          }),
          ai.models
            .embedContent({
              model: EMBEDDING_MODEL,
              contents: [
                {
                  inlineData: {
                    data: base64,
                    mimeType: input.mimeType,
                  },
                },
              ],
            })
            .catch(() => null),
        ]),
        ctx.timeoutMs,
        'Analisis gambar AI melebihi batas waktu. Coba ambil foto lebih dekat atau gunakan barcode.'
      );

      let parsed: Record<string, unknown> = {};
      if (visionResult.text) {
        try {
          parsed = JSON.parse(visionResult.text) as Record<string, unknown>;
        } catch {
          parsed = { rawText: visionResult.text };
        }
      }

      const ocr = normalizeOcrSignals({
        productName: typeof parsed.productName === 'string' ? parsed.productName : '',
        brand: typeof parsed.brand === 'string' ? parsed.brand : '',
        variant: typeof parsed.variant === 'string' ? parsed.variant : '',
        flavor: typeof parsed.flavor === 'string' ? parsed.flavor : '',
        weight: typeof parsed.weight === 'string' ? parsed.weight : '',
        volume: typeof parsed.volume === 'string' ? parsed.volume : '',
        size: typeof parsed.size === 'string' ? parsed.size : '',
        packagingType: typeof parsed.packagingType === 'string' ? parsed.packagingType : '',
        productCode: typeof parsed.productCode === 'string' ? parsed.productCode : '',
        rawText: typeof parsed.rawText === 'string' ? parsed.rawText : '',
        keywords: Array.isArray(parsed.keywords) ? (parsed.keywords as string[]) : [],
      });

      const vector = embeddingResult?.embeddings?.[0]?.values;
      return {
        ocr,
        detectedRegion: sanitizeBoundingBox(parsed.detectedRegion),
        embedding: Array.isArray(vector) && vector.length > 0 ? vector : null,
        embeddingModel: Array.isArray(vector) && vector.length > 0 ? EMBEDDING_MODEL : null,
        analysisModel: VISION_ANALYSIS_MODEL,
      };
    } catch (err) {
      mapGeminiError(err);
    }
  }
}
