import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Camera,
  CameraOff,
  CheckCircle2,
  Flashlight,
  Keyboard,
  Play,
  QrCode,
  RefreshCw,
  RotateCcw,
  Square,
  SwitchCamera,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { BarcodeType, Product } from '../types';
import { formatRupiah } from '../utils/format';
import {
  detectScannerCapabilities,
  DuplicateScanGuard,
  queryCameraPermissionState,
  startCameraDecodeSession,
  validateAndNormalizeBarcode,
  type CameraDecodeSession,
  type ScannerContextMode,
  type ScannerEngineType,
  type ScannerPermissionState,
  type ScanResultFeedback,
} from '../utils/barcodeScanner';

export interface CameraScanEventMeta {
  format: BarcodeType | 'UNKNOWN';
  engine: ScannerEngineType | 'manual';
  checkDigitValid: boolean | null;
}

interface CameraScannerProps {
  active: boolean;
  onToggle: () => void;
  onScanBarcode: (barcode: string, meta?: CameraScanEventMeta) => void | Promise<void>;
  soundEnabled: boolean;
  onToggleSound: () => void;
  lastScanStatus: ScanResultFeedback | null;
  sampleProducts?: Product[];
  onRegisterMissingBarcode?: (barcode: string) => void;
  context?: ScannerContextMode;
  allowQrDefault?: boolean;
  cooldownMs?: number;
  title?: string;
}

export function CameraScanner({
  active,
  onToggle,
  onScanBarcode,
  soundEnabled,
  onToggleSound,
  lastScanStatus,
  sampleProducts = [],
  onRegisterMissingBarcode,
  context = 'pos',
  allowQrDefault = false,
  cooldownMs = 1500,
  title = 'Pemindai Barcode Kamera',
}: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<CameraDecodeSession | null>(null);
  const guardRef = useRef<DuplicateScanGuard>(new DuplicateScanGuard(cooldownMs));
  const onScanRef = useRef(onScanBarcode);
  onScanRef.current = onScanBarcode;

  const [cameraRunning, setCameraRunning] = useState(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [activeEngine, setActiveEngine] = useState<ScannerEngineType>('zxing');
  const [nativeCapable, setNativeCapable] = useState(false);
  const [permissionState, setPermissionState] = useState<ScannerPermissionState>('unknown');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [runtimeHint, setRuntimeHint] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [allowQr, setAllowQr] = useState(allowQrDefault);
  const [flashTone, setFlashTone] = useState<'none' | 'success' | 'error'>('none');
  const [manualCode, setManualCode] = useState('');
  const [validationNotice, setValidationNotice] = useState<string | null>(null);

  useEffect(() => {
    guardRef.current = new DuplicateScanGuard(cooldownMs);
  }, [cooldownMs]);

  useEffect(() => {
    setAllowQr(allowQrDefault);
  }, [allowQrDefault]);

  // Brief visual flash when lastScanStatus updates
  useEffect(() => {
    if (!lastScanStatus) return;
    setFlashTone(lastScanStatus.found ? 'success' : 'error');
    if (!lastScanStatus.found && lastScanStatus.unknownBarcode) {
      setManualCode(lastScanStatus.barcode);
    }
    const timer = window.setTimeout(() => setFlashTone('none'), 520);
    return () => window.clearTimeout(timer);
  }, [lastScanStatus]);

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      try {
        sessionRef.current.stop();
      } catch {
        // ignore stop errors
      }
      sessionRef.current = null;
    }
    setTorchOn(false);
    setTorchSupported(false);
    setIsInitializing(false);
  }, []);

  const startSession = useCallback(
    async (preferredDeviceId?: string) => {
      if (!videoRef.current) return;
      stopSession();
      setIsInitializing(true);
      setCameraError(null);
      setRuntimeHint(null);
      setValidationNotice(null);

      try {
        const [perm, caps] = await Promise.all([
          queryCameraPermissionState(),
          detectScannerCapabilities(
            allowQr
              ? ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'CODE-128', 'CODE-39', 'QR']
              : ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'CODE-128', 'CODE-39']
          ),
        ]);
        setPermissionState(perm);
        setNativeCapable(caps.nativeSupported);

        if (!caps.hasCameraApi) {
          setPermissionState('unavailable');
          setCameraError(
            'Browser atau perangkat ini tidak mendukung akses kamera. Gunakan input barcode manual di samping atau scanner USB (F2).'
          );
          return;
        }

        const session = await startCameraDecodeSession({
          videoEl: videoRef.current,
          preferredDeviceId: preferredDeviceId || undefined,
          allowQr,
          onRuntimeError: (msg) => setRuntimeHint(msg),
          onDetected: ({ code, format, engine }) => {
            const validation = validateAndNormalizeBarcode(code, format, { allowQr });
            if (!validation.valid) {
              // Debounce repeated invalid/QR notifications too so the banner doesn't flicker
              if (!guardRef.current.shouldAccept(`__invalid__:${code}`)) return;
              setValidationNotice(validation.reason || 'Format barcode tidak valid.');
              setFlashTone('error');
              window.setTimeout(() => setFlashTone('none'), 450);
              return;
            }

            if (!guardRef.current.shouldAccept(validation.code)) {
              return;
            }

            setValidationNotice(null);
            guardRef.current.markInFlight(validation.code);
            if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
              try {
                navigator.vibrate(45);
              } catch {
                // ignore vibrate denial
              }
            }

            Promise.resolve(
              onScanRef.current(validation.code, {
                format: validation.detectedType,
                engine,
                checkDigitValid: validation.checkDigitValid,
              })
            ).finally(() => {
              guardRef.current.clearInFlight();
            });
          },
        });

        sessionRef.current = session;
        setPermissionState('granted');
        setActiveEngine(session.engine);
        setDevices(session.devices);
        if (session.activeDeviceId) {
          setSelectedDeviceId(session.activeDeviceId);
        }
        setTorchSupported(session.torchSupported);
      } catch (err) {
        const errName = err instanceof Error ? err.name : '';
        const message = err instanceof Error ? err.message : 'Gagal memulai kamera pemindai.';

        if (
          errName === 'NotAllowedError' ||
          errName === 'PermissionDeniedError' ||
          /Permission|NotAllowed|denied/i.test(message)
        ) {
          setPermissionState('denied');
          setCameraError(
            'Izin kamera ditolak oleh browser/perangkat. Klik ikon kamera/kunci di address bar untuk mengizinkan, lalu coba lagi.'
          );
        } else if (
          errName === 'NotFoundError' ||
          errName === 'DevicesNotFoundError' ||
          /NotFound|DevicesNotFound|Requested device not found/i.test(message)
        ) {
          setPermissionState('unavailable');
          setCameraError(
            'Perangkat kamera tidak terdeteksi. POS tetap berjalan normal menggunakan scanner USB atau input manual.'
          );
        } else if (errName === 'NotReadableError' || errName === 'TrackStartError') {
          setCameraError(
            'Kamera sedang dipakai oleh aplikasi lain. Tutup aplikasi kamera lain lalu klik Coba Lagi.'
          );
        } else {
          setCameraError(message);
        }
      } finally {
        setIsInitializing(false);
      }
    },
    [allowQr, stopSession]
  );

  // When scanner opens, ensure cameraRunning resets to true and release when closed
  useEffect(() => {
    if (active) {
      setCameraRunning(true);
    } else {
      stopSession();
    }
  }, [active, stopSession]);

  // Start/stop camera hardware whenever active + cameraRunning + selected device/format changes
  useEffect(() => {
    if (!active || !cameraRunning) {
      stopSession();
      return;
    }

    void startSession(selectedDeviceId || undefined);
    return () => {
      stopSession();
    };
  }, [active, cameraRunning, selectedDeviceId, allowQr, startSession, stopSession]);

  // Automatically release camera hardware when browser tab becomes hidden or page unloads
  useEffect(() => {
    if (!active) return;

    const handleVisibility = () => {
      if (document.hidden && sessionRef.current) {
        stopSession();
        setCameraRunning(false);
      }
    };
    const handlePageHide = () => {
      stopSession();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [active, stopSession]);

  const handleToggleTorch = async () => {
    if (!sessionRef.current || !torchSupported) return;
    const nextState = !torchOn;
    const ok = await sessionRef.current.setTorch(nextState);
    if (ok) setTorchOn(nextState);
  };

  const handleFlipCamera = () => {
    if (devices.length < 2) return;
    const currentIndex = devices.findIndex((d) => d.deviceId === selectedDeviceId);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % devices.length : 0;
    setSelectedDeviceId(devices[nextIndex].deviceId);
  };

  const handleResetScanLock = () => {
    guardRef.current.reset();
    setValidationNotice(null);
  };

  const handleManualSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const raw = manualCode.trim();
    if (!raw) return;
    const validation = validateAndNormalizeBarcode(raw, undefined, { allowQr: true });
    if (!validation.valid) {
      setValidationNotice(validation.reason || 'Format barcode tidak valid.');
      return;
    }
    setValidationNotice(null);
    guardRef.current.reset();
    await onScanRef.current(validation.code, {
      format: validation.detectedType,
      engine: 'manual',
      checkDigitValid: validation.checkDigitValid,
    });
    if (context === 'pos') {
      setManualCode('');
    }
  };

  if (!active) return null;

  const contextHelperText =
    context === 'inventory'
      ? 'Arahkan barcode barang ke kamera untuk memilih produk pada formulir penerimaan / kontrol stok.'
      : context === 'barcode-field'
      ? 'Arahkan barcode kemasan ke kamera untuk mengisi kode barcode produk secara otomatis.'
      : 'Arahkan barcode produk ke garis merah untuk langsung menambahkan item ke keranjang kasir.';

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-3 border-b border-slate-200 bg-slate-50/70">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-teal-700 shrink-0" />
            <h3 className="text-sm font-semibold text-slate-900 truncate">{title}</h3>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5 truncate">
            {allowQr
              ? 'Format: EAN-13 · EAN-8 · UPC-A · UPC-E · Code 128 · QR'
              : 'Format Ritel 1D: EAN-13 · EAN-8 · UPC-A · UPC-E · Code 128'}
            {cameraRunning && !cameraError && (
              <>
                {' · '}
                {activeEngine === 'native' || nativeCapable
                  ? 'Engine: Native Hardware'
                  : 'Engine: ZXing'}
              </>
            )}
          </p>
        </div>

        {/* Touch-friendly Action Controls (>= 44px height) */}
        <div className="flex flex-wrap items-center gap-1.5">
          {devices.length > 1 && (
            <>
              <select
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                aria-label="Pilih kamera"
                className="min-h-[44px] max-w-[175px] text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg px-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
              >
                {devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Kamera ${i + 1}`}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={handleFlipCamera}
                title="Ganti kamera depan/belakang"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-1.5 px-2.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap"
              >
                <SwitchCamera className="w-4 h-4" />
                <span className="hidden sm:inline">Putar</span>
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => setAllowQr((v) => !v)}
            title={
              allowQr
                ? 'Matikan QR Code agar fokus hanya barcode ritel 1D'
                : 'Aktifkan dukungan QR Code'
            }
            className={`min-h-[44px] inline-flex items-center gap-1.5 px-2.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
              allowQr
                ? 'bg-teal-50 text-teal-800 border-teal-300'
                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
            }`}
          >
            <QrCode className="w-4 h-4" />
            <span>{allowQr ? '1D + QR' : '1D Saja'}</span>
          </button>

          {torchSupported && cameraRunning && (
            <button
              type="button"
              onClick={handleToggleTorch}
              aria-pressed={torchOn}
              className={`min-h-[44px] inline-flex items-center gap-1.5 px-2.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                torchOn
                  ? 'bg-amber-50 text-amber-800 border-amber-300'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Flashlight className="w-4 h-4" />
              <span>Lampu</span>
            </button>
          )}

          <button
            type="button"
            onClick={onToggleSound}
            title={soundEnabled ? 'Matikan suara beep' : 'Aktifkan suara beep'}
            className="min-h-[44px] inline-flex items-center gap-1.5 px-2.5 text-xs font-medium bg-white text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap"
          >
            {soundEnabled ? (
              <Volume2 className="w-4 h-4 text-teal-700" />
            ) : (
              <VolumeX className="w-4 h-4 text-slate-400" />
            )}
            <span className="hidden sm:inline">{soundEnabled ? 'Beep' : 'Senyap'}</span>
          </button>

          <button
            type="button"
            onClick={() => setCameraRunning((prev) => !prev)}
            className={`min-h-[44px] inline-flex items-center gap-1.5 px-3 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap ${
              cameraRunning
                ? 'bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-100'
                : 'bg-teal-700 text-white border-teal-700 hover:bg-teal-800'
            }`}
          >
            {cameraRunning ? (
              <>
                <Square className="w-3.5 h-3.5" />
                <span>Hentikan</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>Mulai Kamera</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              stopSession();
              onToggle();
            }}
            aria-label="Tutup panel pemindai kamera"
            className="min-h-[44px] inline-flex items-center gap-1.5 px-3 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap"
          >
            <X className="w-4 h-4" />
            <span className="hidden sm:inline">Tutup</span>
          </button>
        </div>
      </div>

      {/* Main Responsive Split Grid: Portrait & Landscape Friendly */}
      <div className="grid grid-cols-1 md:grid-cols-12">
        {/* Live Camera Viewport */}
        <div className="md:col-span-7 relative bg-slate-950 min-h-[240px] sm:min-h-[270px] flex items-center justify-center overflow-hidden">
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className="w-full h-[240px] sm:h-[280px] object-cover"
          />

          {/* Targeting Reticle & Flash Feedback Overlay */}
          {cameraRunning && !cameraError && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className={`w-64 sm:w-72 h-32 sm:h-36 border-2 rounded-lg relative transition-colors duration-200 shadow-[0_0_0_9999px_rgba(15,23,42,0.42)] ${
                  flashTone === 'success'
                    ? 'border-emerald-400 bg-emerald-400/10'
                    : flashTone === 'error'
                    ? 'border-rose-400 bg-rose-400/10'
                    : 'border-teal-400/90'
                }`}
              >
                {/* Corner Brackets */}
                <span className="absolute -top-0.5 -left-0.5 w-4 h-4 border-t-4 border-l-4 border-white rounded-tl" />
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 border-t-4 border-r-4 border-white rounded-tr" />
                <span className="absolute -bottom-0.5 -left-0.5 w-4 h-4 border-b-4 border-l-4 border-white rounded-bl" />
                <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 border-b-4 border-r-4 border-white rounded-br" />

                {/* Laser Line */}
                <div
                  className={`absolute inset-x-3 top-1/2 -translate-y-1/2 h-0.5 ${
                    flashTone === 'success' ? 'bg-emerald-400' : 'bg-rose-500/85'
                  }`}
                />

                <span className="absolute -bottom-7 left-1/2 -translate-x-1/2 text-[11px] font-medium text-white bg-slate-950/90 px-2.5 py-0.5 rounded whitespace-nowrap">
                  {flashTone === 'success'
                    ? 'Barcode terbaca!'
                    : 'Arahkan barcode barang ke garis merah'}
                </span>
              </div>
            </div>
          )}

          {/* Stopped / Paused Overlay */}
          {!cameraRunning && !cameraError && (
            <div className="absolute inset-0 bg-slate-900/92 p-5 flex flex-col items-center justify-center text-center gap-3">
              <CameraOff className="w-8 h-8 text-slate-400" />
              <div className="space-y-1 max-w-xs">
                <p className="text-sm font-semibold text-white">Kamera Dihentikan</p>
                <p className="text-xs text-slate-300">
                  Akses kamera dilepas untuk menghemat baterai. Klik tombol di bawah untuk memindai lagi.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCameraRunning(true)}
                className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-600 rounded-lg transition-colors"
              >
                <Play className="w-4 h-4" />
                Mulai Kamera Pemindai
              </button>
            </div>
          )}

          {/* Initializing Overlay */}
          {isInitializing && cameraRunning && (
            <div className="absolute inset-0 bg-slate-950/85 flex flex-col items-center justify-center gap-2 text-white p-4 text-center">
              <RefreshCw className="w-5 h-5 animate-spin text-teal-400" />
              <span className="text-xs font-medium">
                {permissionState === 'prompt'
                  ? 'Meminta izin akses kamera pada browser...'
                  : 'Menyiapkan kamera belakang & engine pemindai...'}
              </span>
            </div>
          )}

          {/* Error / Permission Denied Overlay */}
          {cameraError && (
            <div className="absolute inset-0 bg-slate-950/95 p-5 flex flex-col items-center justify-center text-center">
              <CameraOff className="w-7 h-7 text-rose-400 mb-2" />
              <p className="text-xs font-semibold text-white mb-1">
                {permissionState === 'denied'
                  ? 'Izin Kamera Diperlukan'
                  : 'Kamera Tidak Tersedia'}
              </p>
              <p className="text-xs text-slate-300 max-w-sm leading-relaxed mb-3">{cameraError}</p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setCameraRunning(true);
                    void startSession(selectedDeviceId || undefined);
                  }}
                  className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-900 bg-white rounded-lg hover:bg-slate-100 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {permissionState === 'denied' ? 'Minta Izin & Coba Lagi' : 'Coba Akses Kamera Lagi'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Scan Feedback, Unknown Barcode Workflow & Manual Fallback */}
        <div className="md:col-span-5 p-4 flex flex-col justify-between gap-3 border-t md:border-t-0 md:border-l border-slate-200 bg-white">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-600">Status Pemindaian</p>
              <button
                type="button"
                onClick={handleResetScanLock}
                title="Izinkan pindai ulang barcode yang sama segera tanpa menunggu jeda"
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-700 hover:text-teal-800"
              >
                <RotateCcw className="w-3 h-3" />
                Scan Ulang
              </button>
            </div>

            {validationNotice && (
              <div className="p-2.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <span>{validationNotice}</span>
              </div>
            )}

            {runtimeHint && (
              <p className="text-[11px] text-slate-500">{runtimeHint}</p>
            )}

            {lastScanStatus ? (
              <div
                className={`p-3 rounded-lg border ${
                  lastScanStatus.found
                    ? 'bg-emerald-50/75 border-emerald-200'
                    : 'bg-rose-50/75 border-rose-200'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                      lastScanStatus.found ? 'text-emerald-800' : 'text-rose-800'
                    }`}
                  >
                    {lastScanStatus.found ? (
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    )}
                    {lastScanStatus.found
                      ? 'Berhasil Dipindai'
                      : lastScanStatus.unknownBarcode
                      ? 'Barcode Belum Terdaftar'
                      : 'Gagal / Tidak Valid'}
                  </span>
                  <span className="font-mono text-[11px] text-slate-600 tabular-nums">
                    {lastScanStatus.barcode}
                    {lastScanStatus.format && lastScanStatus.format !== 'UNKNOWN'
                      ? ` · ${lastScanStatus.format}`
                      : ''}
                  </span>
                </div>

                <p className="text-sm font-semibold text-slate-900 mt-1 truncate">
                  {lastScanStatus.productName || lastScanStatus.message}
                </p>

                {lastScanStatus.productName && (
                  <p className="text-xs text-slate-600 mt-0.5 tabular-nums">
                    {lastScanStatus.message}
                  </p>
                )}

                {!lastScanStatus.found && lastScanStatus.unknownBarcode && (
                  <div className="mt-2.5 pt-2.5 border-t border-rose-200/80 flex flex-wrap items-center gap-2">
                    {onRegisterMissingBarcode && (
                      <button
                        type="button"
                        onClick={() => onRegisterMissingBarcode(lastScanStatus.barcode)}
                        className="min-h-[36px] px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors"
                      >
                        + Daftarkan Produk Baru
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleResetScanLock}
                      className="min-h-[36px] px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors"
                    >
                      Coba Scan Lagi
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
                <p className="text-xs text-slate-600 leading-relaxed">{contextHelperText}</p>
                <p className="text-[11px] text-slate-500 mt-1.5">
                  Proteksi anti-duplikat aktif ({(cooldownMs / 1000).toFixed(1)} dtk antar scan sama).
                </p>
              </div>
            )}

            {/* Manual Barcode Input Fallback (works even when camera is denied or unavailable) */}
            <form onSubmit={handleManualSubmit} className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600">
                <Keyboard className="w-3.5 h-3.5 text-slate-400" />
                Input / Koreksi Barcode Manual
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  placeholder="Ketik atau tempel barcode..."
                  className="flex-1 min-w-0 font-mono text-xs px-2.5 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
                <button
                  type="submit"
                  className="min-h-[38px] px-3 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg whitespace-nowrap shrink-0"
                >
                  Proses
                </button>
              </div>
            </form>
          </div>

          {sampleProducts.length > 0 && (
            <div className="pt-2 border-t border-slate-100">
              <p className="text-[11px] font-medium text-slate-500 mb-1.5">
                Simulasi Scan dari Katalog ({context === 'inventory' ? 'Pilih Produk' : 'Tambah Cepat'}):
              </p>
              <div className="grid grid-cols-1 gap-1.5">
                {sampleProducts.slice(0, 3).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      guardRef.current.reset();
                      void onScanBarcode(item.barcode, {
                        format: item.barcodes?.[0]?.barcodeType ?? 'EAN-13',
                        engine: 'manual',
                        checkDigitValid: null,
                      });
                    }}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs bg-slate-50 hover:bg-teal-50 border border-slate-200 hover:border-teal-300 rounded-lg transition-colors"
                  >
                    <span className="font-medium text-slate-800 truncate">{item.name}</span>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums shrink-0">
                      {context === 'inventory'
                        ? `${item.stock} ${item.unit}`
                        : formatRupiah(
                            item.specialPrice && item.specialPrice > 0
                              ? item.specialPrice
                              : item.sellPrice
                          )}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
