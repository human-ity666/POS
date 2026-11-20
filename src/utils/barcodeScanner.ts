import type { IScannerControls } from '@zxing/browser';
import type { BarcodeFormat } from '@zxing/library';
import type { BarcodeType } from '../types';

export type ScannerEngineType = 'native' | 'zxing';
export type ScannerPermissionState = 'prompt' | 'granted' | 'denied' | 'unavailable' | 'unknown';
export type ScannerContextMode = 'pos' | 'inventory' | 'barcode-field';

export interface ScanResultFeedback {
  barcode: string;
  format?: BarcodeType | 'UNKNOWN';
  engine?: ScannerEngineType;
  productName?: string;
  productSku?: string;
  productPrice?: number;
  productStock?: number;
  productUnit?: string;
  found: boolean;
  unknownBarcode?: boolean;
  validationError?: boolean;
  message: string;
  timestamp: number;
}

export interface DetectedBarcodeItem {
  rawValue: string;
  format?: string;
  boundingBox?: DOMRectReadOnly;
  cornerPoints?: Array<{ x: number; y: number }>;
}

export interface BarcodeDetectorInstance {
  detect(image: ImageBitmapSource): Promise<DetectedBarcodeItem[]>;
}

export interface BarcodeDetectorStatic {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorStatic;
  }
}

export const RETAIL_1D_FORMATS: BarcodeType[] = [
  'EAN-13',
  'EAN-8',
  'UPC-A',
  'UPC-E',
  'CODE-128',
  'CODE-39',
];

const NATIVE_TO_BARCODE_TYPE: Record<string, BarcodeType> = {
  ean_13: 'EAN-13',
  ean_8: 'EAN-8',
  upc_a: 'UPC-A',
  upc_e: 'UPC-E',
  code_128: 'CODE-128',
  code_39: 'CODE-39',
  qr_code: 'QR',
};

const BARCODE_TYPE_TO_NATIVE: Partial<Record<BarcodeType, string>> = {
  'EAN-13': 'ean_13',
  'EAN-8': 'ean_8',
  'UPC-A': 'upc_a',
  'UPC-E': 'upc_e',
  'CODE-128': 'code_128',
  'CODE-39': 'code_39',
  QR: 'qr_code',
};

export function mapNativeFormatToBarcodeType(format?: string): BarcodeType | 'UNKNOWN' {
  if (!format) return 'UNKNOWN';
  const normalized = format.trim().toLowerCase();
  return NATIVE_TO_BARCODE_TYPE[normalized] ?? 'UNKNOWN';
}

export function mapZxingFormatToBarcodeType(format?: BarcodeFormat | number): BarcodeType | 'UNKNOWN' {
  switch (format) {
    case 7: // BarcodeFormat.EAN_13
      return 'EAN-13';
    case 6: // BarcodeFormat.EAN_8
      return 'EAN-8';
    case 14: // BarcodeFormat.UPC_A
      return 'UPC-A';
    case 15: // BarcodeFormat.UPC_E
      return 'UPC-E';
    case 4: // BarcodeFormat.CODE_128
      return 'CODE-128';
    case 2: // BarcodeFormat.CODE_39
      return 'CODE-39';
    case 11: // BarcodeFormat.QR_CODE
      return 'QR';
    default:
      return 'UNKNOWN';
  }
}

export function computeGs1CheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  // GS1 Mod-10: multiply by 3 and 1 alternating from right to left
  for (let i = 0; i < digitsWithoutCheck.length; i++) {
    const digit = Number(digitsWithoutCheck[digitsWithoutCheck.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function expandUpcEToUpcA(upce: string): string | null {
  if (!/^\d{8}$/.test(upce)) return null;
  const numberSystem = upce[0];
  if (numberSystem !== '0' && numberSystem !== '1') return null;

  const d1 = upce[1];
  const d2 = upce[2];
  const d3 = upce[3];
  const d4 = upce[4];
  const d5 = upce[5];
  const d6 = upce[6];
  const check = upce[7];

  let manufacturer = '';
  let item = '';

  if (d6 === '0' || d6 === '1' || d6 === '2') {
    manufacturer = `${d1}${d2}${d6}00`;
    item = `00${d3}${d4}${d5}`;
  } else if (d6 === '3') {
    manufacturer = `${d1}${d2}${d3}00`;
    item = `000${d4}${d5}`;
  } else if (d6 === '4') {
    manufacturer = `${d1}${d2}${d3}${d4}0`;
    item = `0000${d5}`;
  } else {
    manufacturer = `${d1}${d2}${d3}${d4}${d5}`;
    item = `0000${d6}`;
  }

  return `${numberSystem}${manufacturer}${item}${check}`;
}

export function verifyGs1CheckDigit(
  code: string,
  format: 'EAN-13' | 'EAN-8' | 'UPC-A' | 'UPC-E'
): boolean {
  if (format === 'EAN-13') {
    if (!/^\d{13}$/.test(code)) return false;
    return computeGs1CheckDigit(code.slice(0, 12)) === Number(code[12]);
  }
  if (format === 'EAN-8') {
    if (!/^\d{8}$/.test(code)) return false;
    return computeGs1CheckDigit(code.slice(0, 7)) === Number(code[7]);
  }
  if (format === 'UPC-A') {
    if (!/^\d{12}$/.test(code)) return false;
    return computeGs1CheckDigit(code.slice(0, 11)) === Number(code[11]);
  }
  if (format === 'UPC-E') {
    const expanded = expandUpcEToUpcA(code);
    if (!expanded) return false;
    return computeGs1CheckDigit(expanded.slice(0, 11)) === Number(expanded[11]);
  }
  return false;
}

export interface BarcodeValidationResult {
  valid: boolean;
  code: string;
  detectedType: BarcodeType | 'UNKNOWN';
  checkDigitValid: boolean | null;
  reason?: string;
}

export function validateAndNormalizeBarcode(
  rawCode: string,
  formatHint?: BarcodeType | string,
  options: { allowQr?: boolean; strictCheckDigit?: boolean } = {}
): BarcodeValidationResult {
  const allowQr = Boolean(options.allowQr);
  const strictCheckDigit = Boolean(options.strictCheckDigit);
  const code = rawCode.replace(/[\r\n\t\u0000-\u001F\u007F]/g, '').trim();

  if (!code) {
    return {
      valid: false,
      code: '',
      detectedType: 'UNKNOWN',
      checkDigitValid: null,
      reason: 'Kode barcode kosong.',
    };
  }

  if (code.length < 3 || code.length > 128) {
    return {
      valid: false,
      code,
      detectedType: 'UNKNOWN',
      checkDigitValid: null,
      reason: 'Panjang barcode tidak valid (minimal 3 karakter).',
    };
  }

  let detectedType: BarcodeType | 'UNKNOWN' = 'UNKNOWN';
  if (formatHint) {
    const upperHint = String(formatHint).trim().toUpperCase();
    if (
      upperHint === 'EAN-13' ||
      upperHint === 'EAN-8' ||
      upperHint === 'UPC-A' ||
      upperHint === 'UPC-E' ||
      upperHint === 'CODE-128' ||
      upperHint === 'CODE-39' ||
      upperHint === 'QR' ||
      upperHint === 'INTERNAL'
    ) {
      detectedType = upperHint;
    } else {
      detectedType = mapNativeFormatToBarcodeType(String(formatHint));
    }
  }

  if (detectedType === 'UNKNOWN') {
    if (/^\d{13}$/.test(code)) detectedType = 'EAN-13';
    else if (/^\d{12}$/.test(code)) detectedType = 'UPC-A';
    else if (/^\d{8}$/.test(code)) {
      detectedType = verifyGs1CheckDigit(code, 'UPC-E') && !verifyGs1CheckDigit(code, 'EAN-8')
        ? 'UPC-E'
        : 'EAN-8';
    } else if (/^https?:\/\//i.test(code) || code.includes('{')) {
      detectedType = 'QR';
    } else if (/^[A-Za-z0-9._:/-]+$/.test(code)) {
      detectedType = 'CODE-128';
    }
  }

  if (detectedType === 'QR' && !allowQr) {
    return {
      valid: false,
      code,
      detectedType: 'QR',
      checkDigitValid: null,
      reason:
        'QR Code terdeteksi, namun mode pemindai sedang dikunci ke barcode ritel 1D. Aktifkan mode +QR bila relevan.',
    };
  }

  if (detectedType !== 'QR' && /\s/.test(code)) {
    return {
      valid: false,
      code,
      detectedType,
      checkDigitValid: null,
      reason: 'Format barcode 1D tidak boleh mengandung spasi.',
    };
  }

  if (detectedType === 'EAN-13') {
    if (!/^\d{13}$/.test(code)) {
      return {
        valid: false,
        code,
        detectedType,
        checkDigitValid: false,
        reason: 'EAN-13 harus terdiri dari tepat 13 digit angka.',
      };
    }
    const cdValid = verifyGs1CheckDigit(code, 'EAN-13');
    if (strictCheckDigit && !cdValid) {
      return {
        valid: false,
        code,
        detectedType,
        checkDigitValid: false,
        reason: `Digit pemeriksa (check digit) EAN-13 "${code}" tidak valid.`,
      };
    }
    return { valid: true, code, detectedType, checkDigitValid: cdValid };
  }

  if (detectedType === 'EAN-8') {
    if (!/^\d{8}$/.test(code)) {
      return {
        valid: false,
        code,
        detectedType,
        checkDigitValid: false,
        reason: 'EAN-8 harus terdiri dari tepat 8 digit angka.',
      };
    }
    const cdValid = verifyGs1CheckDigit(code, 'EAN-8');
    if (strictCheckDigit && !cdValid) {
      return {
        valid: false,
        code,
        detectedType,
        checkDigitValid: false,
        reason: `Check digit EAN-8 "${code}" tidak valid.`,
      };
    }
    return { valid: true, code, detectedType, checkDigitValid: cdValid };
  }

  if (detectedType === 'UPC-A') {
    if (!/^\d{12}$/.test(code)) {
      return {
        valid: false,
        code,
        detectedType,
        checkDigitValid: false,
        reason: 'UPC-A harus terdiri dari tepat 12 digit angka.',
      };
    }
    const cdValid = verifyGs1CheckDigit(code, 'UPC-A');
    if (strictCheckDigit && !cdValid) {
      return {
        valid: false,
        code,
        detectedType,
        checkDigitValid: false,
        reason: `Check digit UPC-A "${code}" tidak valid.`,
      };
    }
    return { valid: true, code, detectedType, checkDigitValid: cdValid };
  }

  if (detectedType === 'UPC-E') {
    if (!/^\d{8}$/.test(code)) {
      return {
        valid: false,
        code,
        detectedType,
        checkDigitValid: false,
        reason: 'UPC-E harus terdiri dari tepat 8 digit angka.',
      };
    }
    const cdValid = verifyGs1CheckDigit(code, 'UPC-E');
    if (strictCheckDigit && !cdValid) {
      return {
        valid: false,
        code,
        detectedType,
        checkDigitValid: false,
        reason: `Check digit UPC-E "${code}" tidak valid.`,
      };
    }
    return { valid: true, code, detectedType, checkDigitValid: cdValid };
  }

  if (detectedType === 'CODE-39' && !/^[A-Z0-9\-. $/+%]+$/i.test(code)) {
    return {
      valid: false,
      code,
      detectedType,
      checkDigitValid: null,
      reason: 'Karakter tidak valid untuk format Code 39.',
    };
  }

  if (detectedType !== 'QR' && !/^[A-Za-z0-9._:/-]+$/.test(code)) {
    return {
      valid: false,
      code,
      detectedType,
      checkDigitValid: null,
      reason: 'Barcode mengandung karakter yang tidak didukung.',
    };
  }

  return {
    valid: true,
    code,
    detectedType,
    checkDigitValid: null,
  };
}

/**
 * Duplicate-scan cooldown + in-flight lookup guard to prevent repeated frame bursts.
 */
export class DuplicateScanGuard {
  private readonly cooldownMs: number;
  private lastCode = '';
  private lastAcceptedAt = 0;
  private inFlightCode: string | null = null;

  constructor(cooldownMs = 1500) {
    this.cooldownMs = Math.max(250, cooldownMs);
  }

  shouldAccept(rawCode: string, now = Date.now()): boolean {
    const code = rawCode.trim();
    if (!code) return false;
    if (this.inFlightCode !== null) return false;
    if (code === this.lastCode && now - this.lastAcceptedAt < this.cooldownMs) {
      return false;
    }
    this.lastCode = code;
    this.lastAcceptedAt = now;
    return true;
  }

  markInFlight(code: string): void {
    this.inFlightCode = code.trim();
  }

  clearInFlight(): void {
    this.inFlightCode = null;
  }

  reset(specificCode?: string): void {
    if (!specificCode || specificCode.trim() === this.lastCode) {
      this.lastCode = '';
      this.lastAcceptedAt = 0;
    }
    this.inFlightCode = null;
  }

  getRemainingCooldownMs(rawCode: string, now = Date.now()): number {
    const code = rawCode.trim();
    if (!code || code !== this.lastCode) return 0;
    const elapsed = now - this.lastAcceptedAt;
    return elapsed < this.cooldownMs ? this.cooldownMs - elapsed : 0;
  }
}

export function isRearCameraLabel(label: string): boolean {
  return /back|rear|environment|belakang|world|traseira|achter/i.test(label);
}

export async function queryCameraPermissionState(): Promise<ScannerPermissionState> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'unavailable';
  }
  if (!navigator.permissions?.query) {
    return 'unknown';
  }
  try {
    const status = await navigator.permissions.query({
      name: 'camera' as PermissionName,
    });
    if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') {
      return status.state;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface ScannerEngineCapabilities {
  hasCameraApi: boolean;
  nativeSupported: boolean;
  nativeFormats: string[];
  preferredEngine: ScannerEngineType;
}

export async function detectScannerCapabilities(
  requestedFormats: BarcodeType[] = RETAIL_1D_FORMATS
): Promise<ScannerEngineCapabilities> {
  const hasCameraApi =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');

  if (typeof window === 'undefined' || !window.BarcodeDetector) {
    return {
      hasCameraApi,
      nativeSupported: false,
      nativeFormats: [],
      preferredEngine: 'zxing',
    };
  }

  try {
    let supportedNative: string[] = [];
    if (typeof window.BarcodeDetector.getSupportedFormats === 'function') {
      supportedNative = await window.BarcodeDetector.getSupportedFormats();
    } else {
      supportedNative = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];
    }

    const neededNative = requestedFormats
      .map((f) => BARCODE_TYPE_TO_NATIVE[f])
      .filter((x): x is string => Boolean(x));

    const coversRequested =
      neededNative.length > 0 && neededNative.every((fmt) => supportedNative.includes(fmt));

    return {
      hasCameraApi,
      nativeSupported: coversRequested,
      nativeFormats: supportedNative,
      preferredEngine: coversRequested ? 'native' : 'zxing',
    };
  } catch {
    return {
      hasCameraApi,
      nativeSupported: false,
      nativeFormats: [],
      preferredEngine: 'zxing',
    };
  }
}

export function stopMediaStream(videoEl: HTMLVideoElement | null, stream?: MediaStream | null): void {
  const activeStream =
    stream ?? (videoEl && videoEl.srcObject ? (videoEl.srcObject as MediaStream) : null);
  if (activeStream) {
    activeStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // ignore stop failures
      }
    });
  }
  if (videoEl) {
    try {
      videoEl.pause();
    } catch {
      // ignore pause errors
    }
    videoEl.srcObject = null;
  }
}

export interface CameraDecodeSession {
  engine: ScannerEngineType;
  devices: MediaDeviceInfo[];
  activeDeviceId: string;
  torchSupported: boolean;
  setTorch: (enabled: boolean) => Promise<boolean>;
  stop: () => void;
}

export async function startCameraDecodeSession(params: {
  videoEl: HTMLVideoElement;
  preferredDeviceId?: string;
  allowQr: boolean;
  onDetected: (result: { code: string; format: BarcodeType | 'UNKNOWN'; engine: ScannerEngineType }) => void;
  onRuntimeError?: (message: string) => void;
}): Promise<CameraDecodeSession> {
  const { videoEl, preferredDeviceId, allowQr, onDetected, onRuntimeError } = params;

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Browser ini tidak mendukung akses kamera (MediaDevices API).');
  }

  const requestedFormats: BarcodeType[] = allowQr
    ? [...RETAIL_1D_FORMATS, 'QR']
    : [...RETAIL_1D_FORMATS];

  // Acquire MediaStream first using facingMode: 'environment' on mobile when no explicit deviceId
  let stream: MediaStream;
  const baseConstraints: MediaStreamConstraints = preferredDeviceId
    ? {
        audio: false,
        video: {
          deviceId: { exact: preferredDeviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      }
    : {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      };

  try {
    stream = await navigator.mediaDevices.getUserMedia(baseConstraints);
  } catch (err) {
    const errName = err instanceof Error ? err.name : '';
    if (errName === 'OverconstrainedError' || errName === 'ConstraintNotSatisfiedError') {
      // Fallback to generic rear or default camera if resolution/exact device constraint fails
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
    } else {
      throw err;
    }
  }

  // Enumerate cameras AFTER stream grant so iOS/Android expose real device labels
  let devices: MediaDeviceInfo[] = [];
  try {
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    devices = allDevices.filter((d) => d.kind === 'videoinput');
  } catch {
    devices = [];
  }

  const videoTrack = stream.getVideoTracks()[0];
  const trackSettings = videoTrack?.getSettings?.();
  const activeDeviceId = trackSettings?.deviceId ?? preferredDeviceId ?? devices[0]?.deviceId ?? '';

  let torchSupported = false;
  if (videoTrack && typeof videoTrack.getCapabilities === 'function') {
    try {
      const caps = videoTrack.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
      torchSupported = Boolean(caps.torch);
    } catch {
      torchSupported = false;
    }
  }

  const setTorch = async (enabled: boolean): Promise<boolean> => {
    if (!videoTrack || !torchSupported) return false;
    try {
      await videoTrack.applyConstraints({
        advanced: [{ torch: enabled } as MediaTrackConstraintSet],
      });
      return true;
    } catch {
      return false;
    }
  };

  // Detect whether hardware-accelerated native BarcodeDetector is available for these formats
  const capabilities = await detectScannerCapabilities(requestedFormats);

  let stopped = false;
  let rafId: number | null = null;
  let zxingControls: IScannerControls | null = null;

  const stopAll = () => {
    if (stopped) return;
    stopped = true;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (zxingControls) {
      try {
        zxingControls.stop();
      } catch {
        // ignore
      }
      zxingControls = null;
    }
    stopMediaStream(videoEl, stream);
  };

  // Helper to start ZXing continuous decode on the live stream (lazy-loaded fallback)
  const startZxingOnStream = async () => {
    const [{ BrowserMultiFormatReader }, { BarcodeFormat: ZxingFormat, DecodeHintType }] =
      await Promise.all([import('@zxing/browser'), import('@zxing/library')]);

    const hints = new Map();
    const zxingFormats = [
      ZxingFormat.EAN_13,
      ZxingFormat.EAN_8,
      ZxingFormat.UPC_A,
      ZxingFormat.UPC_E,
      ZxingFormat.CODE_128,
      ZxingFormat.CODE_39,
    ];
    if (allowQr) {
      zxingFormats.push(ZxingFormat.QR_CODE);
    }
    hints.set(DecodeHintType.POSSIBLE_FORMATS, zxingFormats);
    hints.set(DecodeHintType.TRY_HARDER, true);

    const reader = new BrowserMultiFormatReader(hints, {
      delayBetweenScanAttempts: 120,
      delayBetweenScanSuccess: 300,
    });

    zxingControls = await reader.decodeFromStream(stream, videoEl, (result) => {
      if (stopped || !result) return;
      const raw = result.getText().trim();
      if (!raw) return;
      const fmt = mapZxingFormatToBarcodeType(result.getBarcodeFormat());
      onDetected({ code: raw, format: fmt, engine: 'zxing' });
    });
  };

  if (capabilities.preferredEngine === 'native' && window.BarcodeDetector) {
    try {
      const nativeFormats = requestedFormats
        .map((f) => BARCODE_TYPE_TO_NATIVE[f])
        .filter((f): f is string => Boolean(f));
      const detector = new window.BarcodeDetector({ formats: nativeFormats });

      videoEl.srcObject = stream;
      videoEl.setAttribute('playsinline', 'true');
      videoEl.muted = true;
      await videoEl.play();

      let lastDetectTs = 0;
      let detecting = false;

      const tick = (now: number) => {
        if (stopped) return;
        rafId = requestAnimationFrame(tick);

        if (detecting || now - lastDetectTs < 110) return;
        if (videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || videoEl.videoWidth === 0) {
          return;
        }

        lastDetectTs = now;
        detecting = true;
        detector
          .detect(videoEl)
          .then((barcodes) => {
            if (stopped || !barcodes || barcodes.length === 0) return;
            const first = barcodes[0];
            if (!first?.rawValue) return;
            const fmt = mapNativeFormatToBarcodeType(first.format);
            onDetected({
              code: first.rawValue.trim(),
              format: fmt,
              engine: 'native',
            });
          })
          .catch(() => {
            // If native detector throws mid-stream, report subtly once and keep loop safe
          })
          .finally(() => {
            detecting = false;
          });
      };

      rafId = requestAnimationFrame(tick);

      return {
        engine: 'native',
        devices,
        activeDeviceId,
        torchSupported,
        setTorch,
        stop: stopAll,
      };
    } catch (nativeErr) {
      // Fallback cleanly to ZXing if native BarcodeDetector instantiation/play fails
      onRuntimeError?.(
        nativeErr instanceof Error
          ? `Engine native dialihkan ke ZXing: ${nativeErr.message}`
          : 'Engine native dialihkan ke ZXing.'
      );
    }
  }

  try {
    await startZxingOnStream();
    return {
      engine: 'zxing',
      devices,
      activeDeviceId,
      torchSupported,
      setTorch,
      stop: stopAll,
    };
  } catch (err) {
    stopAll();
    throw err;
  }
}
