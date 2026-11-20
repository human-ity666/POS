import { ServiceError } from '../errors.ts';
import {
  normalizeOcrSignals,
  type ProviderAnalysisOutput,
  type ProviderRuntimeContext,
  type RecognitionImageInput,
  type RecognitionProvider,
} from './providerTypes.ts';
import type { RecognitionSettings } from '../../../src/types.ts';

function isValidHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export class RemoteInferenceProvider implements RecognitionProvider {
  readonly id = 'remote-inference';
  readonly label = 'Remote Vision Microservice (Custom HTTP)';
  readonly kind = 'remote-inference' as const;
  readonly supportsOcr = true;
  readonly supportsEmbeddings = true;

  getStatus(settings?: RecognitionSettings) {
    const endpoint = settings?.remoteEndpointUrl?.trim() || '';
    const valid = isValidHttpUrl(endpoint);
    return {
      available: valid,
      reason: valid
        ? undefined
        : 'URL endpoint inferensi remote belum dikonfigurasi pada Pengaturan AI.',
      modelName: valid ? endpoint : undefined,
    };
  }

  async embedReferenceImage(
    input: Pick<RecognitionImageInput, 'buffer' | 'mimeType'>,
    ctx: ProviderRuntimeContext
  ): Promise<{ vector: number[]; modelName: string }> {
    const endpoint = ctx.settings.remoteEndpointUrl?.trim();
    if (!endpoint || !isValidHttpUrl(endpoint)) {
      throw new ServiceError(
        503,
        'Endpoint inferensi remote belum dikonfigurasi dengan URL HTTP/HTTPS yang valid.',
        'PROVIDER_UNAVAILABLE'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: 'embed',
          mimeType: input.mimeType,
          imageBase64: input.buffer.toString('base64'),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ServiceError(502, `Remote inference endpoint returned HTTP ${res.status}.`, 'PROVIDER_ERROR');
      }
      const data = (await res.json()) as { embedding?: number[]; modelName?: string };
      if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
        throw new ServiceError(502, 'Remote inference endpoint tidak mengembalikan vektor embedding.', 'PROVIDER_ERROR');
      }
      return {
        vector: data.embedding,
        modelName: data.modelName || 'remote-embedding-v1',
      };
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ServiceError(504, 'Koneksi ke endpoint inferensi remote melebihi batas waktu.', 'PROVIDER_TIMEOUT');
      }
      throw new ServiceError(
        503,
        `Tidak dapat terhubung ke endpoint inferensi remote: ${err instanceof Error ? err.message : 'Network error'}`,
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
    const endpoint = ctx.settings.remoteEndpointUrl?.trim();
    if (!endpoint || !isValidHttpUrl(endpoint)) {
      throw new ServiceError(
        503,
        'Endpoint inferensi remote belum dikonfigurasi pada Pengaturan AI.',
        'PROVIDER_UNAVAILABLE'
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: 'identify',
          mimeType: input.mimeType,
          imageBase64: input.buffer.toString('base64'),
          width: input.width ?? null,
          height: input.height ?? null,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ServiceError(502, `Remote inference endpoint returned HTTP ${res.status}.`, 'PROVIDER_ERROR');
      }
      const data = (await res.json()) as Partial<ProviderAnalysisOutput> & { modelName?: string };
      return {
        ocr: normalizeOcrSignals(data.ocr),
        detectedRegion: data.detectedRegion ?? null,
        embedding: Array.isArray(data.embedding) ? data.embedding : null,
        embeddingModel: data.embeddingModel || data.modelName || null,
        analysisModel: data.analysisModel || data.modelName || 'remote-vision-v1',
      };
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ServiceError(504, 'Permintaan ke endpoint inferensi remote melebihi batas waktu.', 'PROVIDER_TIMEOUT');
      }
      throw new ServiceError(
        503,
        `Gagal menghubungi layanan inferensi remote: ${err instanceof Error ? err.message : 'Network error'}`,
        'PROVIDER_UNAVAILABLE'
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
