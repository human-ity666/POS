import { ServiceError } from '../errors.ts';
import {
  normalizeOcrSignals,
  type ProviderAnalysisOutput,
  type ProviderRuntimeContext,
  type RecognitionImageInput,
  type RecognitionProvider,
} from './providerTypes.ts';

function getLocalSidecarUrl(): string {
  return process.env.POS_LOCAL_AI_URL?.trim() || '';
}

export class LocalInferenceProvider implements RecognitionProvider {
  readonly id = 'local-inference';
  readonly label = 'Local Inference Runtime (ONNX / Sidecar)';
  readonly kind = 'local-inference' as const;
  readonly supportsOcr = true;
  readonly supportsEmbeddings = true;

  getStatus() {
    const url = getLocalSidecarUrl();
    return {
      available: Boolean(url),
      reason: url
        ? undefined
        : 'Runtime inferensi lokal belum aktif (set POS_LOCAL_AI_URL untuk menghubungkan model lokal ONNX/TFLite/OCR).',
      modelName: url || undefined,
    };
  }

  async embedReferenceImage(
    input: Pick<RecognitionImageInput, 'buffer' | 'mimeType'>,
    ctx: ProviderRuntimeContext
  ): Promise<{ vector: number[]; modelName: string }> {
    const url = getLocalSidecarUrl();
    if (!url) {
      throw new ServiceError(
        503,
        'Runtime inferensi lokal belum aktif pada server (POS_LOCAL_AI_URL tidak diset).',
        'PROVIDER_UNAVAILABLE'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mimeType: input.mimeType,
          imageBase64: input.buffer.toString('base64'),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ServiceError(502, `Local inference sidecar returned HTTP ${res.status}.`, 'PROVIDER_ERROR');
      }
      const data = (await res.json()) as { embedding?: number[]; modelName?: string };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new ServiceError(502, 'Runtime lokal tidak mengembalikan vektor embedding.', 'PROVIDER_ERROR');
      }
      return {
        vector: data.embedding,
        modelName: data.modelName || 'local-embedding-onnx',
      };
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ServiceError(504, 'Runtime inferensi lokal melebihi batas waktu.', 'PROVIDER_TIMEOUT');
      }
      throw new ServiceError(
        503,
        `Runtime inferensi lokal tidak dapat diakses: ${err instanceof Error ? err.message : 'Connection error'}`,
        'PROVIDER_UNAVAILABLE'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async analyzeImage(
    input: RecognitionImageInput,
    ctx: ProviderRuntimeContext
  ): Promise<ProviderAnalysisOutput> {
    const url = getLocalSidecarUrl();
    if (!url) {
      throw new ServiceError(
        503,
        'Runtime inferensi lokal belum aktif pada server (POS_LOCAL_AI_URL tidak diset). Pilih Gemini Vision atau gunakan pemindai barcode.',
        'PROVIDER_UNAVAILABLE'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/identify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mimeType: input.mimeType,
          imageBase64: input.buffer.toString('base64'),
          width: input.width ?? null,
          height: input.height ?? null,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ServiceError(502, `Local inference sidecar returned HTTP ${res.status}.`, 'PROVIDER_ERROR');
      }
      const data = (await res.json()) as Partial<ProviderAnalysisOutput> & { modelName?: string };
      return {
        ocr: normalizeOcrSignals(data.ocr),
        detectedRegion: data.detectedRegion ?? null,
        embedding: Array.isArray(data.embedding) ? data.embedding : null,
        embeddingModel: data.embeddingModel || data.modelName || null,
        analysisModel: data.analysisModel || data.modelName || 'local-vision-onnx',
      };
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ServiceError(504, 'Runtime inferensi lokal melebihi batas waktu.', 'PROVIDER_TIMEOUT');
      }
      throw new ServiceError(
        503,
        `Gagal menjalankan inferensi lokal: ${err instanceof Error ? err.message : 'Connection error'}`,
        'PROVIDER_UNAVAILABLE'
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
