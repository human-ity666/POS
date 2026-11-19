import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { Camera, CameraOff, RefreshCw, Volume2, VolumeX, Flashlight } from 'lucide-react';
import type { Product } from '../types';
import { formatRupiah } from '../utils/format';

interface CameraScannerProps {
  active: boolean;
  onToggle: () => void;
  onScanBarcode: (barcode: string) => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  lastScanStatus: {
    barcode: string;
    productName?: string;
    found: boolean;
    message: string;
    timestamp: number;
  } | null;
  sampleProducts: Product[];
  onRegisterMissingBarcode?: (barcode: string) => void;
}

export function CameraScanner({
  active,
  onToggle,
  onScanBarcode,
  soundEnabled,
  onToggleSound,
  lastScanStatus,
  sampleProducts,
  onRegisterMissingBarcode,
}: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastCodeRef = useRef<{ code: string; time: number }>({ code: '', time: 0 });
  const onScanRef = useRef(onScanBarcode);
  onScanRef.current = onScanBarcode;

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const stopCamera = useCallback(() => {
    if (controlsRef.current) {
      try {
        controlsRef.current.stop();
      } catch {
        // ignore stop errors
      }
      controlsRef.current = null;
    }
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  const startCamera = useCallback(
    async (preferredDeviceId?: string) => {
      if (!videoRef.current) return;
      stopCamera();
      setIsInitializing(true);
      setCameraError(null);

      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Browser ini tidak mendukung akses kamera (MediaDevices API).');
        }

        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
          BarcodeFormat.QR_CODE,
        ]);
        hints.set(DecodeHintType.TRY_HARDER, true);

        const reader = new BrowserMultiFormatReader(hints, {
          delayBetweenScanAttempts: 120,
          delayBetweenScanSuccess: 350,
        });

        const videoDevices = await BrowserMultiFormatReader.listVideoInputDevices();
        setDevices(videoDevices);

        let deviceToUse = preferredDeviceId || selectedDeviceId;
        if (!deviceToUse && videoDevices.length > 0) {
          const rearCam = videoDevices.find((d) => /back|rear|environment|belakang/i.test(d.label));
          deviceToUse = (rearCam ?? videoDevices[0]).deviceId;
          setSelectedDeviceId(deviceToUse);
        }

        const constraints: MediaStreamConstraints = deviceToUse
          ? {
              video: {
                deviceId: { exact: deviceToUse },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
            }
          : {
              video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
            };

        const controls = await reader.decodeFromConstraints(
          constraints,
          videoRef.current,
          (result, _err) => {
            if (result) {
              const code = result.getText().trim();
              const now = Date.now();
              // Cooldown 1.2 detik untuk barcode yang sama agar barang tidak terhitung berulang saat dipegang
              if (code === lastCodeRef.current.code && now - lastCodeRef.current.time < 1200) {
                return;
              }
              lastCodeRef.current = { code, time: now };
              onScanRef.current(code);
            }
          }
        );

        controlsRef.current = controls;

        // Check torch capability
        const stream = videoRef.current.srcObject as MediaStream | null;
        const track = stream?.getVideoTracks()[0];
        if (track && typeof track.getCapabilities === 'function') {
          const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
          setTorchSupported(Boolean(caps.torch));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Gagal mengakses kamera.';
        if (/Permission|NotAllowed|denied/i.test(message)) {
          setCameraError(
            'Izin kamera ditolak. Izinkan akses kamera pada browser untuk memindai barcode secara langsung.'
          );
        } else if (/NotFound|DevicesNotFound|Requested device not found/i.test(message)) {
          setCameraError(
            'Perangkat kamera tidak terdeteksi. Anda tetap dapat menggunakan scanner USB atau input barcode cepat di bawah.'
          );
        } else {
          setCameraError(message);
        }
      } finally {
        setIsInitializing(false);
      }
    },
    [selectedDeviceId, stopCamera]
  );

  useEffect(() => {
    if (active) {
      startCamera(selectedDeviceId || undefined);
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [active, selectedDeviceId, startCamera, stopCamera]);

  const handleToggleTorch = async () => {
    if (!videoRef.current?.srcObject) return;
    const stream = videoRef.current.srcObject as MediaStream;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    try {
      const nextState = !torchOn;
      await track.applyConstraints({
        advanced: [{ torch: nextState } as MediaTrackConstraintSet],
      });
      setTorchOn(nextState);
    } catch {
      // ignore if device rejects torch constraint
    }
  };

  if (!active) return null;

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 bg-slate-50/70">
        <div className="flex items-center gap-2.5">
          <Camera className="w-4 h-4 text-teal-700 shrink-0" />
          <span className="text-sm font-semibold text-slate-900">Pemindai Barcode Kamera</span>
          <span className="text-xs text-slate-500">EAN-13 · UPC · Code 128 · QR</span>
        </div>

        <div className="flex items-center gap-2">
          {devices.length > 1 && (
            <select
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              aria-label="Pilih kamera"
              className="text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
            >
              {devices.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Kamera ${i + 1}`}
                </option>
              ))}
            </select>
          )}

          {torchSupported && (
            <button
              type="button"
              onClick={handleToggleTorch}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                torchOn
                  ? 'bg-amber-50 text-amber-800 border-amber-300'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Flashlight className="w-3.5 h-3.5" />
              Lampu
            </button>
          )}

          <button
            type="button"
            onClick={onToggleSound}
            title={soundEnabled ? 'Matikan suara beep' : 'Aktifkan suara beep'}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-white text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5 text-teal-700" /> : <VolumeX className="w-3.5 h-3.5 text-slate-400" />}
            {soundEnabled ? 'Beep Aktif' : 'Senyap'}
          </button>

          <button
            type="button"
            onClick={onToggle}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            <CameraOff className="w-3.5 h-3.5" />
            Tutup Kamera
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12">
        {/* Live Camera Viewport */}
        <div className="md:col-span-7 relative bg-slate-900 min-h-[220px] flex items-center justify-center overflow-hidden">
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className="w-full h-[240px] object-cover"
          />

          {/* Targeting Reticle Overlay */}
          {!cameraError && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="w-64 h-32 border-2 border-teal-400/90 rounded-lg relative shadow-[0_0_0_9999px_rgba(15,23,42,0.35)]">
                <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 h-0.5 bg-rose-500/80" />
                <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[11px] font-medium text-white bg-slate-900/85 px-2 py-0.5 rounded whitespace-nowrap">
                  Arahkan barcode barang ke garis merah
                </span>
              </div>
            </div>
          )}

          {isInitializing && (
            <div className="absolute inset-0 bg-slate-900/80 flex flex-col items-center justify-center gap-2 text-white">
              <RefreshCw className="w-5 h-5 animate-spin text-teal-400" />
              <span className="text-xs font-medium">Menyiapkan kamera pemindai...</span>
            </div>
          )}

          {cameraError && (
            <div className="absolute inset-0 bg-slate-900/95 p-5 flex flex-col items-center justify-center text-center">
              <CameraOff className="w-7 h-7 text-rose-400 mb-2" />
              <p className="text-xs text-slate-200 max-w-sm leading-relaxed mb-3">{cameraError}</p>
              <button
                type="button"
                onClick={() => startCamera(selectedDeviceId || undefined)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-900 bg-white rounded-lg hover:bg-slate-100 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Coba Akses Kamera Lagi
              </button>
            </div>
          )}
        </div>

        {/* Scan Result Feedback & Quick Barcode Test */}
        <div className="md:col-span-5 p-4 flex flex-col justify-between gap-3 border-t md:border-t-0 md:border-l border-slate-200 bg-white">
          <div>
            <p className="text-xs font-semibold text-slate-500 mb-2">Status Pemindaian Terakhir</p>
            {lastScanStatus ? (
              <div
                className={`p-3 rounded-lg border ${
                  lastScanStatus.found
                    ? 'bg-emerald-50/70 border-emerald-200'
                    : 'bg-rose-50/70 border-rose-200'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-xs font-semibold ${
                      lastScanStatus.found ? 'text-emerald-800' : 'text-rose-800'
                    }`}
                  >
                    {lastScanStatus.found ? 'Berhasil Dipindai' : 'Tidak Ditemukan / Gagal'}
                  </span>
                  <span className="font-mono text-[11px] text-slate-600 tabular-nums">
                    {lastScanStatus.barcode}
                  </span>
                </div>
                <p className="text-sm font-semibold text-slate-900 mt-1 truncate">
                  {lastScanStatus.productName || lastScanStatus.message}
                </p>
                {lastScanStatus.productName && (
                  <p className="text-xs text-slate-600 mt-0.5">{lastScanStatus.message}</p>
                )}
                {!lastScanStatus.found && onRegisterMissingBarcode && (
                  <button
                    type="button"
                    onClick={() => onRegisterMissingBarcode(lastScanStatus.barcode)}
                    className="mt-2.5 text-xs font-semibold text-teal-700 hover:text-teal-800 underline underline-offset-2"
                  >
                    + Daftarkan barcode ini sebagai produk baru
                  </button>
                )}
              </div>
            ) : (
              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
                <p className="text-xs text-slate-600 leading-relaxed">
                  Siap memindai. Arahkan kemasan produk berbarcode ke kamera untuk langsung masuk ke keranjang kasir.
                </p>
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-slate-500 mb-1.5">
              Uji Cepat Scan (klik jika tanpa kamera):
            </p>
            <div className="grid grid-cols-1 gap-1.5">
              {sampleProducts.slice(0, 3).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onScanBarcode(item.barcode)}
                  className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs bg-slate-50 hover:bg-teal-50 border border-slate-200 hover:border-teal-300 rounded-lg transition-colors"
                >
                  <span className="font-medium text-slate-800 truncate">{item.name}</span>
                  <span className="font-mono text-[11px] text-slate-500 tabular-nums shrink-0">
                    {formatRupiah(item.sellPrice)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
