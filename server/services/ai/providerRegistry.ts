import type {
  RecognitionProviderStatus,
  RecognitionSettings,
} from '../../../src/types.ts';
import { ServiceError } from '../errors.ts';
import { GeminiVisionRecognitionProvider } from './geminiProvider.ts';
import { LocalInferenceProvider } from './localInferenceProvider.ts';
import type { RecognitionProvider } from './providerTypes.ts';
import { RemoteInferenceProvider } from './remoteInferenceProvider.ts';

const registry = new Map<string, RecognitionProvider>();

function ensureDefaultsRegistered(): void {
  if (registry.size > 0) return;
  const defaults: RecognitionProvider[] = [
    new GeminiVisionRecognitionProvider(),
    new LocalInferenceProvider(),
    new RemoteInferenceProvider(),
  ];
  for (const provider of defaults) {
    registry.set(provider.id, provider);
  }
}

export function registerRecognitionProvider(provider: RecognitionProvider): void {
  ensureDefaultsRegistered();
  registry.set(provider.id, provider);
}

export function unregisterRecognitionProvider(providerId: string): void {
  ensureDefaultsRegistered();
  registry.delete(providerId);
}

export function getRecognitionProvider(providerId: string): RecognitionProvider {
  ensureDefaultsRegistered();
  const provider = registry.get(providerId);
  if (!provider) {
    throw new ServiceError(
      400,
      `Provider pengenalan AI "${providerId}" tidak terdaftar.`,
      'UNKNOWN_PROVIDER'
    );
  }
  return provider;
}

export function listRecognitionProviders(
  settings?: RecognitionSettings
): RecognitionProviderStatus[] {
  ensureDefaultsRegistered();
  return Array.from(registry.values()).map((provider) => {
    const status = provider.getStatus(settings);
    return {
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      available: status.available,
      supportsOcr: provider.supportsOcr,
      supportsEmbeddings: provider.supportsEmbeddings,
      reason: status.reason,
      modelName: status.modelName,
    };
  });
}
