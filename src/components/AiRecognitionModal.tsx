import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle,
  Camera,
  CameraOff,
  Check,
  History,
  ImagePlus,
  Loader2,
  PackagePlus,
  RefreshCw,
  ScanBarcode,
  Search,
  Settings2,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  Product,
  RecognitionCandidate,
  RecognitionConfidenceBand,
  RecognitionLogEntry,
  RecognitionOcrSignals,
  RecognitionProviderStatus,
  RecognitionResult,
  RecognitionSettings,
  ReferenceEmbeddingSyncSummary,
  StoreData,
} from '../types';
import { apiFetch } from '../utils/api';
import { formatFileSize, formatRupiah } from '../utils/format';
import {
  preprocessImageFileForAi,
  resizeVideoFrameForAi,
  type PreprocessedAiImage,
} from '../utils/imagePreprocess';

export interface RecognitionNewProductPrefill {
  ocrSignals: RecognitionOcrSignals;
  capturedImageDataUrl: string | null;
  logId: string;
}

interface AiRecognitionModalProps {
  open: boolean;
  products: Product[];
  canManageAi: boolean;
  canCreateProduct: boolean;
  canEditProduct: boolean;
  onClose: () => void;
  onAddProductToCart: (product: Product, sourceLabel: string) => void;
  onSwitchToBarcodeScanner: () => void;
  onSwitchToManualSearch: (initialQuery?: string) => void;
  onRegisterNewProduct: (prefill: RecognitionNewProductPrefill) => void;
  onStoreUpdate?: (store: StoreData) => void;
}

type ModalTab = 'identify' | 'logs' | 'settings';
type CaptureMode = 'camera' | 'upload';

const BAND_STYLES: Record<
  RecognitionConfidenceBand,
  { border: string; bg: string; text: string; label: string; description: string }
> = {
  HIGH: {
    border: 'border-emerald-300',
    bg: 'bg-emerald-50',
    text: 'text-emerald-900',
    label: 'Keyakinan Tinggi',
    description: 'Cocok kuat pada teks kemasan & referensi produk.',
  },
  MEDIUM: {
    border: 'border-amber-300',
    bg: 'bg-amber-50',
    text: 'text-amber-900',
    label: 'Keyakinan Sedang — Perlu Konfirmasi',
    description: 'Periksa kembali nama, varian, dan ukuran sebelum menambahkan ke keranjang.',
  },
  LOW: {
    border: 'border-orange-300',
    bg: 'bg-orange-50',
    text: 'text-orange-900',
    label: 'Keyakinan Rendah',
    description: 'Kecocokan lemah. Disarankan scan barcode atau cari manual.',
  },
  UNKNOWN: {
    border: 'border-slate-300',
    bg: 'bg-slate-50',
    text: 'text-slate-800',
    label: 'Produk Belum Dikenali',
    description: 'Tidak ada kecocokan memadai di katalog. Gunakan barcode, pencarian manual, atau daftarkan produk baru.',
  },
};

export function AiRecognitionModal({
  open,
  products,
  canManageAi,
  canCreateProduct,
  canEditProduct,
  onClose,
  onAddProductToCart,
  onSwitchToBarcodeScanner,
  onSwitchToManualSearch,
  onRegisterNewProduct,
  onStoreUpdate,
}: AiRecognitionModalProps) {
  const [activeTab, setActiveTab] = useState<ModalTab>('identify');
  const [captureMode, setCaptureMode] = useState<CaptureMode>('camera');

  // Camera state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraList, setCameraList] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Capture & inference state
  const [capturedImage, setCapturedImage] = useState<PreprocessedAiImage | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [inferenceError, setInferenceError] = useState<string | null>(null);
  const [result, setResult] = useState<RecognitionResult | null>(null);
  const [promoteAsReference, setPromoteAsReference] = useState(false);
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);

  // Providers, settings & logs
  const [providers, setProviders] = useState<RecognitionProviderStatus[]>([]);
  const [settings, setSettings] = useState<RecognitionSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<RecognitionSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [syncingEmbeddings, setSyncingEmbeddings] = useState(false);
  const [syncSummary, setSyncSummary] = useState<ReferenceEmbeddingSyncSummary | null>(null);
  const [logs, setLogs] = useState<RecognitionLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const stopCameraStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraReady(false);
  }, []);

  const loadProviderConfig = useCallback(async () => {
    try {
      const res = await apiFetch<{
        settings: RecognitionSettings;
        providers: RecognitionProviderStatus[];
      }>('/api/recognition/providers');
      setSettings(res.settings);
      setSettingsDraft(res.settings);
      setProviders(res.providers);
    } catch {
      // Errors surfaced when running identification
    }
  }, []);

  const loadLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const res = await apiFetch<{ logs: RecognitionLogEntry[] }>('/api/recognition/logs?limit=40');
      setLogs(res.logs);
    } catch {
      // Keep quiet on passive tab switch
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  const startCamera = useCallback(
    async (deviceIdOverride?: string) => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError('Peramban tidak mendukung akses kamera pada perangkat ini.');
        return;
      }
      stopCameraStream();
      setCameraStarting(true);
      setCameraError(null);

      try {
        const targetId = deviceIdOverride ?? selectedDeviceId;
        const stream = await navigator.mediaDevices.getUserMedia({
          video: targetId
            ? { deviceId: { exact: targetId }, width: { ideal: 1280 }, height: { ideal: 960 } }
            : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
          audio: false,
        });

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setCameraReady(true);

        if (navigator.mediaDevices.enumerateDevices) {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = devices.filter((d) => d.kind === 'videoinput');
          setCameraList(videoInputs);
          const trackDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId;
          if (!selectedDeviceId && trackDeviceId) {
            setSelectedDeviceId(trackDeviceId);
          }
        }
      } catch (err) {
        setCameraError(
          err instanceof Error
            ? `Kamera tidak dapat diakses: ${err.message}`
            : 'Izin kamera ditolak atau kamera tidak tersedia.'
        );
      } finally {
        setCameraStarting(false);
      }
    },
    [selectedDeviceId, stopCameraStream]
  );

  // Lifecycle when modal opens/closes
  useEffect(() => {
    if (!open) {
      stopCameraStream();
      setCapturedImage(null);
      setResult(null);
      setInferenceError(null);
      setFeedbackNotice(null);
      setSyncSummary(null);
      return;
    }

    setActiveTab('identify');
    loadProviderConfig();
  }, [open, loadProviderConfig, stopCameraStream]);

  useEffect(() => {
    if (!open) return;
    if (activeTab === 'identify' && captureMode === 'camera' && !capturedImage) {
      startCamera();
    } else {
      stopCameraStream();
    }
    return () => {
      stopCameraStream();
    };
  }, [open, activeTab, captureMode, capturedImage, startCamera, stopCameraStream]);

  useEffect(() => {
    if (open && activeTab === 'logs') {
      loadLogs();
    }
  }, [open, activeTab, loadLogs]);

  const activeProviderStatus = useMemo(() => {
    if (!settings) return null;
    return providers.find((p) => p.id === settings.activeProviderId) ?? null;
  }, [providers, settings]);

  const runRecognitionOnImage = async (img: PreprocessedAiImage) => {
    setAnalyzing(true);
    setInferenceError(null);
    setFeedbackNotice(null);
    setResult(null);

    try {
      const response = await apiFetch<{ result: RecognitionResult }>('/api/recognition/identify', {
        method: 'POST',
        body: JSON.stringify({
          dataBase64: img.dataBase64,
          mimeType: img.mimeType,
          width: img.width,
          height: img.height,
          context: 'POS_CASHIER',
        }),
      });

      const res = response.result;
      setResult(res);

      // Explicit opt-in HIGH-confidence auto-add rule: only if autoAddEligible === true
      if (res.autoAddEligible && res.bestMatch) {
        const matchedProduct = products.find((p) => p.id === res.bestMatch!.productId);
        if (matchedProduct) {
          onAddProductToCart(matchedProduct, `Auto-AI (${Math.round(res.bestMatch.confidence * 100)}%)`);
          // Auto-record confirmation feedback asynchronously
          apiFetch(`/api/recognition/logs/${res.logId}/feedback`, {
            method: 'POST',
            body: JSON.stringify({
              outcome: 'CONFIRMED',
              selectedProductId: matchedProduct.id,
              notes: 'Otomatis ditambahkan (Keyakinan Tinggi)',
            }),
          }).catch(() => {});
          setFeedbackNotice(
            `Produk "${matchedProduct.name}" otomatis ditambahkan ke keranjang karena keyakinan tinggi (${Math.round(res.bestMatch.confidence * 100)}%).`
          );
        }
      }
    } catch (err) {
      setInferenceError(
        err instanceof Error
          ? err.message
          : 'Layanan AI gagal memproses gambar kemasan.'
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const handleCaptureAndIdentify = async () => {
    if (!videoRef.current) return;
    const processed = resizeVideoFrameForAi(videoRef.current);
    if (!processed) {
      setCameraError('Frame kamera belum siap. Tunggu sesaat lalu coba lagi.');
      return;
    }
    setCapturedImage(processed);
    stopCameraStream();
    await runRecognitionOnImage(processed);
  };

  const handleUploadFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setInferenceError(null);
    try {
      const processed = await preprocessImageFileForAi(file);
      setCapturedImage(processed);
      await runRecognitionOnImage(processed);
    } catch (err) {
      setInferenceError(err instanceof Error ? err.message : 'Gagal membaca file gambar.');
    }
  };

  const handleRetake = () => {
    setCapturedImage(null);
    setResult(null);
    setInferenceError(null);
    setFeedbackNotice(null);
  };

  const handleConfirmCandidate = async (candidate: RecognitionCandidate, addToCart: boolean) => {
    if (!result) return;
    const targetProduct = products.find((p) => p.id === candidate.productId);
    if (!targetProduct) {
      setInferenceError('Produk tidak ditemukan di data lokal kasir.');
      return;
    }

    setSubmittingFeedback(true);
    setInferenceError(null);
    try {
      const outcome =
        result.bestMatch && result.bestMatch.productId === candidate.productId
          ? 'CONFIRMED'
          : 'CORRECTED';

      const res = await apiFetch<{ log: RecognitionLogEntry; store?: StoreData }>(
        `/api/recognition/logs/${result.logId}/feedback`,
        {
          method: 'POST',
          body: JSON.stringify({
            outcome,
            selectedProductId: candidate.productId,
            promoteAsReferenceImage: promoteAsReference && canEditProduct,
            referenceAngle: 'front',
            notes:
              outcome === 'CONFIRMED'
                ? 'Dikonfirmasi kasir pada modal AI'
                : `Koreksi manual ke ${candidate.name}`,
          }),
        }
      );

      if (res.store && onStoreUpdate) {
        onStoreUpdate(res.store);
      }

      if (addToCart) {
        onAddProductToCart(
          targetProduct,
          `AI (${Math.round(candidate.confidence * 100)}%)`
        );
        onClose();
      } else {
        setFeedbackNotice(
          `Kecocokan dicatat untuk "${candidate.name}" (${outcome === 'CONFIRMED' ? 'Terkonfirmasi' : 'Terkoreksi'}).`
        );
      }
    } catch (err) {
      setInferenceError(err instanceof Error ? err.message : 'Gagal menyimpan umpan balik AI.');
    } finally {
      setSubmittingFeedback(false);
    }
  };

  const handleRejectResult = async () => {
    if (!result) return;
    setSubmittingFeedback(true);
    try {
      await apiFetch(`/api/recognition/logs/${result.logId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({
          outcome: 'REJECTED',
          notes: 'Kasir menandai kandidat tidak sesuai',
        }),
      });
      setFeedbackNotice('Ditandai tidak cocok. Silakan foto ulang, scan barcode, atau cari manual.');
    } catch (err) {
      setInferenceError(err instanceof Error ? err.message : 'Gagal mencatat penolakan.');
    } finally {
      setSubmittingFeedback(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!settingsDraft) return;
    setSavingSettings(true);
    setInferenceError(null);
    setFeedbackNotice(null);
    try {
      const res = await apiFetch<{
        settings: RecognitionSettings;
        providers: RecognitionProviderStatus[];
      }>('/api/recognition/settings', {
        method: 'PUT',
        body: JSON.stringify(settingsDraft),
      });
      setSettings(res.settings);
      setSettingsDraft(res.settings);
      setProviders(res.providers);
      setFeedbackNotice('Konfigurasi AI Product Recognition berhasil disimpan.');
    } catch (err) {
      setInferenceError(err instanceof Error ? err.message : 'Gagal menyimpan konfigurasi AI.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSyncReferenceEmbeddings = async (force = false) => {
    setSyncingEmbeddings(true);
    setInferenceError(null);
    setSyncSummary(null);
    try {
      const res = await apiFetch<{ summary: ReferenceEmbeddingSyncSummary; store: StoreData }>(
        '/api/recognition/references/sync',
        {
          method: 'POST',
          body: JSON.stringify({ force }),
        }
      );
      setSyncSummary(res.summary);
      if (res.store && onStoreUpdate) {
        onStoreUpdate(res.store);
      }
    } catch (err) {
      setInferenceError(err instanceof Error ? err.message : 'Gagal menyinkronkan embedding referensi.');
    } finally {
      setSyncingEmbeddings(false);
    }
  };

  if (!open) return null;

  const bandMeta = result ? BAND_STYLES[result.confidenceBand] : null;
  const searchSuggestion =
    result?.ocrSignals.productName ||
    result?.ocrSignals.brand ||
    result?.ocrSignals.keywords?.[0] ||
    '';

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-2 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Identifikasi Produk AI"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-teal-700 text-white flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-slate-900 truncate">
                Identifikasi Produk Kemasan (AI)
              </h3>
              <p className="text-[11px] text-slate-500 truncate">
                {activeProviderStatus
                  ? `${activeProviderStatus.label} · ${activeProviderStatus.available ? 'Siap' : 'Tidak Tersedia'}`
                  : 'Memuat status provider AI...'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-200/70"
            aria-label="Tutup identifikasi AI"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 px-4 sm:px-5 pt-2.5 border-b border-slate-200 bg-white overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('identify')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
              activeTab === 'identify'
                ? 'border-teal-700 text-teal-800'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Camera className="w-3.5 h-3.5" />
            Identifikasi Kemasan
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('logs')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
              activeTab === 'logs'
                ? 'border-teal-700 text-teal-800'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            Riwayat & Umpan Balik
          </button>
          {canManageAi && (
            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
                activeTab === 'settings'
                  ? 'border-teal-700 text-teal-800'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Settings2 className="w-3.5 h-3.5" />
              Konfigurasi & Referensi
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {activeTab === 'identify' && (
            <>
              {/* Honest Provider Unavailable Warning */}
              {activeProviderStatus && !activeProviderStatus.available && (
                <div className="p-3.5 rounded-xl border border-amber-300 bg-amber-50 text-amber-950 space-y-2">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <div className="text-xs space-y-1">
                      <p className="font-semibold">
                        Provider AI ({activeProviderStatus.label}) belum tersedia saat ini
                      </p>
                      <p className="text-amber-900">
                        {activeProviderStatus.reason ||
                          'Layanan AI belum aktif di server. Anda tetap dapat menggunakan pemindai barcode atau pencarian manual tanpa hambatan.'}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pl-6">
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onSwitchToBarcodeScanner();
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-white border border-amber-300 text-amber-950 hover:bg-amber-100 rounded-lg"
                    >
                      <ScanBarcode className="w-3.5 h-3.5" />
                      Pindah ke Scan Barcode
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onSwitchToManualSearch();
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-white border border-amber-300 text-amber-950 hover:bg-amber-100 rounded-lg"
                    >
                      <Search className="w-3.5 h-3.5" />
                      Cari Produk Manual
                    </button>
                  </div>
                </div>
              )}

              {inferenceError && (
                <div className="p-3.5 rounded-xl border border-rose-300 bg-rose-50 text-rose-900 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xs font-medium">{inferenceError}</p>
                    <button
                      type="button"
                      onClick={() => setInferenceError(null)}
                      className="text-xs font-semibold underline shrink-0"
                    >
                      Tutup
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {capturedImage && (
                      <button
                        type="button"
                        disabled={analyzing}
                        onClick={() => runRecognitionOnImage(capturedImage)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-rose-700 text-white hover:bg-rose-800 rounded-lg"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Coba Lagi
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onSwitchToBarcodeScanner();
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-white border border-rose-300 text-rose-900 hover:bg-rose-100 rounded-lg"
                    >
                      <ScanBarcode className="w-3.5 h-3.5" />
                      Scan Barcode
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onSwitchToManualSearch(searchSuggestion);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-white border border-rose-300 text-rose-900 hover:bg-rose-100 rounded-lg"
                    >
                      <Search className="w-3.5 h-3.5" />
                      Cari Manual
                    </button>
                  </div>
                </div>
              )}

              {feedbackNotice && (
                <div className="px-3.5 py-2.5 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 text-xs font-medium flex items-center justify-between gap-2">
                  <span>{feedbackNotice}</span>
                  <button
                    type="button"
                    onClick={() => setFeedbackNotice(null)}
                    className="font-semibold underline shrink-0"
                  >
                    Tutup
                  </button>
                </div>
              )}

              {/* Capture Input Stage (before snapshot or retake) */}
              {!capturedImage ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1">
                      <button
                        type="button"
                        onClick={() => setCaptureMode('camera')}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                          captureMode === 'camera'
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Kamera Langsung
                      </button>
                      <button
                        type="button"
                        onClick={() => setCaptureMode('upload')}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                          captureMode === 'upload'
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Unggah Foto Kemasan
                      </button>
                    </div>

                    {captureMode === 'camera' && cameraList.length > 1 && (
                      <select
                        value={selectedDeviceId}
                        onChange={(e) => {
                          setSelectedDeviceId(e.target.value);
                          startCamera(e.target.value);
                        }}
                        className="text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
                        aria-label="Pilih kamera"
                      >
                        {cameraList.map((cam, idx) => (
                          <option key={cam.deviceId} value={cam.deviceId}>
                            {cam.label || `Kamera ${idx + 1}`}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {captureMode === 'camera' ? (
                    <div className="space-y-3">
                      <div className="relative aspect-[4/3] max-h-[360px] w-full bg-slate-950 rounded-xl overflow-hidden flex items-center justify-center border border-slate-200">
                        {cameraError ? (
                          <div className="p-6 text-center space-y-3 max-w-sm">
                            <CameraOff className="w-8 h-8 text-slate-400 mx-auto" />
                            <p className="text-xs text-slate-200">{cameraError}</p>
                            <div className="flex flex-wrap justify-center gap-2">
                              <button
                                type="button"
                                onClick={() => startCamera()}
                                className="px-3 py-1.5 text-xs font-semibold bg-teal-600 text-white rounded-lg hover:bg-teal-700"
                              >
                                Coba Buka Kamera
                              </button>
                              <button
                                type="button"
                                onClick={() => setCaptureMode('upload')}
                                className="px-3 py-1.5 text-xs font-semibold bg-white/10 text-white rounded-lg hover:bg-white/20"
                              >
                                Unggah File Foto
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <video
                              ref={videoRef}
                              autoPlay
                              playsInline
                              muted
                              className="w-full h-full object-cover"
                            />
                            {/* Framing guide */}
                            <div className="pointer-events-none absolute inset-6 border-2 border-dashed border-white/50 rounded-xl flex items-end justify-center pb-2">
                              <span className="px-2.5 py-1 rounded bg-slate-900/75 text-[11px] text-white font-medium">
                                Arahkan label nama, merek & ukuran kemasan ke dalam bingkai
                              </span>
                            </div>
                            {cameraStarting && (
                              <div className="absolute inset-0 bg-slate-950/75 flex items-center justify-center gap-2 text-xs text-white">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Menyiapkan kamera...
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[11px] text-slate-500">
                          Gambar otomatis dikompresi (maks 768px) sebelum dikirim. Inferensi hanya berjalan saat tombol ditekan.
                        </p>
                        <button
                          type="button"
                          disabled={!cameraReady || analyzing}
                          onClick={handleCaptureAndIdentify}
                          className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
                        >
                          <Camera className="w-4 h-4" />
                          Foto & Identifikasi AI
                        </button>
                      </div>
                    </div>
                  ) : (
                    <label className="flex flex-col items-center justify-center p-10 border-2 border-dashed border-slate-300 rounded-xl bg-slate-50 hover:bg-slate-100/70 cursor-pointer transition-colors text-center space-y-2">
                      <ImagePlus className="w-8 h-8 text-teal-700" />
                      <span className="text-xs font-semibold text-slate-900">
                        Pilih atau Seret Foto Kemasan Produk (JPG, PNG, WEBP)
                      </span>
                      <span className="text-[11px] text-slate-500">
                        Ukuran gambar otomatis diperkecil di perangkat agar cepat diidentifikasi.
                      </span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={handleUploadFile}
                        className="hidden"
                      />
                    </label>
                  )}
                </div>
              ) : (
                /* Result & Comparison View */
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                  {/* Left: Captured image + bounding box + OCR signals */}
                  <div className="lg:col-span-5 space-y-3">
                    <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-950 relative">
                      <img
                        src={capturedImage.dataBase64}
                        alt="Foto kemasan yang dianalisis"
                        className="w-full max-h-[260px] object-contain mx-auto"
                      />
                      {result?.detectedRegion && (
                        <div
                          className="pointer-events-none absolute border-2 border-emerald-400 bg-emerald-400/10"
                          style={{
                            left: `${result.detectedRegion.x * 100}%`,
                            top: `${result.detectedRegion.y * 100}%`,
                            width: `${result.detectedRegion.width * 100}%`,
                            height: `${result.detectedRegion.height * 100}%`,
                          }}
                        >
                          <span className="inline-block bg-emerald-600 text-white text-[10px] font-semibold px-1.5 py-0.5">
                            {result.detectedRegion.label}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono tabular-nums px-1">
                      <span>
                        {capturedImage.width}x{capturedImage.height}px ({formatFileSize(capturedImage.byteSize)})
                      </span>
                      {result && <span>{result.latencyMs} ms</span>}
                    </div>

                    {result && (
                      <div className="border border-slate-200 rounded-xl p-3 bg-slate-50 space-y-2">
                        <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
                          Sinyal OCR & Kemasan Terbaca
                        </h4>
                        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                          <div>
                            <dt className="text-[10px] text-slate-500">Nama Terbaca</dt>
                            <dd className="font-medium text-slate-900">
                              {result.ocrSignals.productName || '—'}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[10px] text-slate-500">Merek</dt>
                            <dd className="font-medium text-slate-900">
                              {result.ocrSignals.brand || '—'}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[10px] text-slate-500">Varian / Rasa</dt>
                            <dd className="font-medium text-slate-900">
                              {[result.ocrSignals.variant, result.ocrSignals.flavor]
                                .filter(Boolean)
                                .join(' · ') || '—'}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[10px] text-slate-500">Berat / Volume</dt>
                            <dd className="font-mono font-medium text-slate-900 tabular-nums">
                              {result.ocrSignals.size ||
                                result.ocrSignals.weight ||
                                result.ocrSignals.volume ||
                                '—'}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[10px] text-slate-500">Kemasan</dt>
                            <dd className="font-medium text-slate-900">
                              {result.ocrSignals.packagingType || '—'}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[10px] text-slate-500">Kode / Angka</dt>
                            <dd className="font-mono text-slate-900">
                              {result.ocrSignals.productCode || '—'}
                            </dd>
                          </div>
                        </dl>
                        {result.ocrSignals.rawText && (
                          <div className="pt-1.5 border-t border-slate-200">
                            <p className="text-[10px] text-slate-500 mb-0.5">Teks Label</p>
                            <p className="text-[11px] text-slate-700 leading-relaxed break-words">
                              {result.ocrSignals.rawText}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Right: Loading OR Confidence Band + Best Match + Candidates + Actions */}
                  <div className="lg:col-span-7 space-y-3">
                    {analyzing ? (
                      <div className="border border-slate-200 rounded-xl p-10 flex flex-col items-center justify-center text-center space-y-3 bg-slate-50">
                        <Loader2 className="w-8 h-8 text-teal-700 animate-spin" />
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-slate-900">
                            Menganalisis kemasan & mencocokkan katalog...
                          </p>
                          <p className="text-xs text-slate-500">
                            Mengekstrak teks OCR, merek, berat/volume, dan kemiripan gambar referensi.
                          </p>
                        </div>
                      </div>
                    ) : result && bandMeta ? (
                      <>
                        {/* Confidence Banner */}
                        <div className={`p-3 rounded-xl border ${bandMeta.border} ${bandMeta.bg} ${bandMeta.text}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold">{bandMeta.label}</span>
                            {result.bestMatch && (
                              <span className="font-mono text-xs font-bold tabular-nums">
                                {Math.round(result.bestMatch.confidence * 100)}% kecocokan
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] mt-0.5 opacity-90">{bandMeta.description}</p>
                        </div>

                        {/* Best Match Card */}
                        {result.bestMatch ? (
                          <div className="border border-slate-300 rounded-xl p-3.5 bg-white space-y-3">
                            <div className="flex items-start gap-3">
                              <div className="w-16 h-16 rounded-lg bg-slate-100 border border-slate-200 overflow-hidden shrink-0 flex items-center justify-center">
                                {result.bestMatch.primaryImageUrl ||
                                result.bestMatch.matchedReferenceImageUrl ? (
                                  <img
                                    src={
                                      result.bestMatch.matchedReferenceImageUrl ||
                                      result.bestMatch.primaryImageUrl ||
                                      ''
                                    }
                                    alt={result.bestMatch.name}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <span className="text-[10px] font-mono text-slate-400">
                                    NO IMG
                                  </span>
                                )}
                              </div>

                              <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="text-[11px] font-mono text-slate-500">
                                      {result.bestMatch.sku} · {result.bestMatch.barcode}
                                    </p>
                                    <h4 className="text-sm font-bold text-slate-900 truncate">
                                      {result.bestMatch.name}
                                    </h4>
                                  </div>
                                  <span className="font-mono text-sm font-bold text-teal-800 tabular-nums shrink-0">
                                    {formatRupiah(
                                      result.bestMatch.specialPrice ?? result.bestMatch.sellPrice
                                    )}
                                  </span>
                                </div>

                                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
                                  <span>Merek: {result.bestMatch.brandName || 'Umum'}</span>
                                  {result.bestMatch.variant && (
                                    <span>Varian: {result.bestMatch.variant}</span>
                                  )}
                                  {result.bestMatch.size && (
                                    <span className="font-mono">Ukuran: {result.bestMatch.size}</span>
                                  )}
                                  <span
                                    className={`font-mono font-semibold tabular-nums ${
                                      result.bestMatch.stock <= 0 ? 'text-rose-700' : 'text-slate-800'
                                    }`}
                                  >
                                    Stok: {result.bestMatch.stock} {result.bestMatch.unit}
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* Multi-Signal Breakdown */}
                            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 pt-2 border-t border-slate-100 text-[10px]">
                              <div className="bg-slate-50 rounded p-1.5">
                                <span className="block text-slate-500">Visual Ref</span>
                                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                  {Math.round(result.bestMatch.signals.imageSimilarity * 100)}%
                                </span>
                              </div>
                              <div className="bg-slate-50 rounded p-1.5">
                                <span className="block text-slate-500">Teks OCR</span>
                                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                  {Math.round(result.bestMatch.signals.ocrTextSimilarity * 100)}%
                                </span>
                              </div>
                              <div className="bg-slate-50 rounded p-1.5">
                                <span className="block text-slate-500">Merek</span>
                                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                  {Math.round(result.bestMatch.signals.brandMatch * 100)}%
                                </span>
                              </div>
                              <div className="bg-slate-50 rounded p-1.5">
                                <span className="block text-slate-500">Varian</span>
                                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                  {Math.round(result.bestMatch.signals.variantMatch * 100)}%
                                </span>
                              </div>
                              <div className="bg-slate-50 rounded p-1.5">
                                <span className="block text-slate-500">Isi/Berat</span>
                                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                  {Math.round(result.bestMatch.signals.measureMatch * 100)}%
                                </span>
                              </div>
                              <div className="bg-slate-50 rounded p-1.5">
                                <span className="block text-slate-500">Kemasan</span>
                                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                  {Math.round(result.bestMatch.signals.packagingMatch * 100)}%
                                </span>
                              </div>
                            </div>

                            {canEditProduct && (
                              <label className="flex items-center gap-2 text-[11px] text-slate-700 cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={promoteAsReference}
                                  onChange={(e) => setPromoteAsReference(e.target.checked)}
                                  className="rounded border-slate-300 text-teal-700"
                                />
                                <span>
                                  Simpan foto terverifikasi ini sebagai gambar referensi AI produk
                                </span>
                              </label>
                            )}

                            <div className="flex flex-wrap gap-2 pt-1">
                              <button
                                type="button"
                                disabled={submittingFeedback || result.bestMatch.stock <= 0}
                                onClick={() => handleConfirmCandidate(result.bestMatch!, true)}
                                className="min-h-[44px] flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
                              >
                                <ShoppingCart className="w-4 h-4" />
                                Tambah ke Keranjang
                              </button>
                              <button
                                type="button"
                                disabled={submittingFeedback}
                                onClick={() => handleConfirmCandidate(result.bestMatch!, false)}
                                className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-teal-900 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-lg disabled:opacity-50"
                              >
                                <Check className="w-4 h-4" />
                                Konfirmasi Cocok
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="border border-dashed border-slate-300 rounded-xl p-5 text-center space-y-2 bg-slate-50">
                            <p className="text-xs font-semibold text-slate-800">
                              Tidak ditemukan produk yang cocok di katalog aktif.
                            </p>
                            <p className="text-[11px] text-slate-500">
                              Gunakan pemindai barcode, cari manual, atau daftarkan sebagai produk baru dengan data OCR yang sudah terbaca.
                            </p>
                          </div>
                        )}

                        {/* Alternative Candidates */}
                        {result.candidates.length > 1 && (
                          <div className="space-y-1.5">
                            <h5 className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
                              Kandidat Alternatif
                            </h5>
                            <div className="divide-y divide-slate-200 border border-slate-200 rounded-xl bg-white overflow-hidden">
                              {result.candidates.slice(1).map((cand) => (
                                <div
                                  key={cand.productId}
                                  className="p-2.5 flex items-center justify-between gap-3 hover:bg-slate-50"
                                >
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    <div className="w-10 h-10 rounded-md bg-slate-100 border border-slate-200 overflow-hidden shrink-0 flex items-center justify-center">
                                      {cand.primaryImageUrl ? (
                                        <img
                                          src={cand.primaryImageUrl}
                                          alt={cand.name}
                                          className="w-full h-full object-cover"
                                        />
                                      ) : (
                                        <span className="text-[9px] font-mono text-slate-400">
                                          IMG
                                        </span>
                                      )}
                                    </div>
                                    <div className="min-w-0">
                                      <p className="text-xs font-semibold text-slate-900 truncate">
                                        {cand.name}
                                      </p>
                                      <p className="text-[11px] text-slate-500 truncate">
                                        {cand.brandName} · {cand.variant || cand.size || cand.sku} ·{' '}
                                        <span className="font-mono tabular-nums">
                                          Stok {cand.stock}
                                        </span>
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span className="font-mono text-xs font-bold text-slate-700 tabular-nums">
                                      {Math.round(cand.confidence * 100)}%
                                    </span>
                                    <button
                                      type="button"
                                      disabled={submittingFeedback || cand.stock <= 0}
                                      onClick={() => handleConfirmCandidate(cand, true)}
                                      className="px-2.5 py-1.5 text-[11px] font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg disabled:opacity-40"
                                    >
                                      Pilih Kandidat
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Fallback / Recovery Action Row */}
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-200">
                          <button
                            type="button"
                            onClick={handleRetake}
                            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            Foto Ulang
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              onSwitchToBarcodeScanner();
                            }}
                            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
                          >
                            <ScanBarcode className="w-3.5 h-3.5" />
                            Scan Barcode
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              onSwitchToManualSearch(searchSuggestion);
                            }}
                            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
                          >
                            <Search className="w-3.5 h-3.5" />
                            Cari Manual
                          </button>
                          {result.bestMatch && (
                            <button
                              type="button"
                              disabled={submittingFeedback}
                              onClick={handleRejectResult}
                              className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 hover:bg-rose-100 rounded-lg"
                            >
                              Tidak Cocok
                            </button>
                          )}
                          {canCreateProduct && (
                            <button
                              type="button"
                              onClick={() => {
                                onClose();
                                onRegisterNewProduct({
                                  ocrSignals: result.ocrSignals,
                                  capturedImageDataUrl: capturedImage.dataBase64,
                                  logId: result.logId,
                                });
                              }}
                              className="min-h-[40px] ml-auto inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-teal-900 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-lg"
                            >
                              <PackagePlus className="w-3.5 h-3.5" />
                              Daftarkan Produk
                            </button>
                          )}
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              )}
            </>
          )}

          {activeTab === 'logs' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h4 className="text-xs font-bold text-slate-900">
                    Riwayat Pengenalan & Umpan Balik Kasir
                  </h4>
                  <p className="text-[11px] text-slate-500">
                    Setiap hasil identifikasi AI, konfirmasi, dan koreksi dicatat untuk audit dan kalibrasi katalog.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={loadLogs}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingLogs ? 'animate-spin' : ''}`} />
                  Muat Ulang
                </button>
              </div>

              {loadingLogs ? (
                <div className="p-8 text-center text-xs text-slate-500">Memuat riwayat AI...</div>
              ) : logs.length === 0 ? (
                <div className="p-8 text-center border border-dashed border-slate-200 rounded-xl text-xs text-slate-500">
                  Belum ada riwayat pengenalan produk AI.
                </div>
              ) : (
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-600">
                        <tr>
                          <th className="px-3 py-2 font-semibold">Waktu & Kasir</th>
                          <th className="px-3 py-2 font-semibold">OCR Terdeteksi</th>
                          <th className="px-3 py-2 font-semibold">Kandidat Teratas</th>
                          <th className="px-3 py-2 font-semibold">Keyakinan</th>
                          <th className="px-3 py-2 font-semibold">Hasil Akhir</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {logs.map((log) => (
                          <tr key={log.id} className="hover:bg-slate-50">
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <div className="font-mono text-[11px] text-slate-900">
                                {new Date(log.createdAt).toLocaleString('id-ID')}
                              </div>
                              <div className="text-[11px] text-slate-500">
                                {log.userName} · {log.providerId}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 max-w-[200px]">
                              <div className="font-medium text-slate-900 truncate">
                                {log.ocrSignals.productName || log.ocrSignals.rawText || '—'}
                              </div>
                              <div className="text-[11px] text-slate-500 truncate">
                                {[log.ocrSignals.brand, log.ocrSignals.size]
                                  .filter(Boolean)
                                  .join(' · ') || '—'}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="font-medium text-slate-900">
                                {log.topProductName || '—'}
                              </div>
                              {log.selectedProductName &&
                                log.selectedProductName !== log.topProductName && (
                                  <div className="text-[11px] text-teal-800">
                                    Dipilih: {log.selectedProductName}
                                  </div>
                                )}
                            </td>
                            <td className="px-3 py-2.5 font-mono tabular-nums">
                              {log.outcome === 'ERROR'
                                ? 'ERR'
                                : `${Math.round(log.topConfidence * 100)}% (${log.confidenceBand})`}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="font-mono text-[11px] font-semibold text-slate-800">
                                {log.outcome}
                              </span>
                              {log.errorMessage && (
                                <p className="text-[10px] text-rose-700 max-w-[200px] truncate">
                                  {log.errorMessage}
                                </p>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'settings' && canManageAi && settingsDraft && (
            <div className="space-y-5">
              {/* Provider selection */}
              <div className="border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4 text-teal-700" />
                  <h4 className="text-xs font-bold text-slate-900">
                    Arsitektur Provider Pengenalan AI (Dapat Diganti)
                  </h4>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                  {providers.map((prov) => {
                    const selected = settingsDraft.activeProviderId === prov.id;
                    return (
                      <button
                        key={prov.id}
                        type="button"
                        onClick={() =>
                          setSettingsDraft((prev) =>
                            prev ? { ...prev, activeProviderId: prov.id } : prev
                          )
                        }
                        className={`text-left p-3 rounded-xl border transition-colors space-y-1 ${
                          selected
                            ? 'border-teal-700 bg-teal-50/70'
                            : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-slate-900">{prov.label}</span>
                        </div>
                        <p className="text-[11px] font-mono text-slate-500">{prov.id}</p>
                        <p
                          className={`text-[11px] font-medium ${
                            prov.available ? 'text-emerald-700' : 'text-amber-700'
                          }`}
                        >
                          {prov.available ? 'Tersedia' : prov.reason || 'Belum dikonfigurasi'}
                        </p>
                      </button>
                    );
                  })}
                </div>

                {settingsDraft.activeProviderId === 'remote-inference' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      URL Endpoint Inferensi Remote (HTTP/HTTPS)
                    </label>
                    <input
                      type="url"
                      value={settingsDraft.remoteEndpointUrl}
                      onChange={(e) =>
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, remoteEndpointUrl: e.target.value } : prev
                        )
                      }
                      placeholder="https://vision-internal.toko.id/api/recognize"
                      className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg"
                    />
                  </div>
                )}
              </div>

              {/* Confidence Thresholds */}
              <div className="border border-slate-200 rounded-xl p-4 space-y-3">
                <h4 className="text-xs font-bold text-slate-900">
                  Ambang Batas Keyakinan & Aturan Otomatis
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Tinggi (0.01 - 1.00)
                    </label>
                    <input
                      type="number"
                      step="0.05"
                      min="0.1"
                      max="1"
                      value={settingsDraft.highConfidenceThreshold}
                      onChange={(e) =>
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, highConfidenceThreshold: Number(e.target.value) } : prev
                        )
                      }
                      className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Sedang
                    </label>
                    <input
                      type="number"
                      step="0.05"
                      min="0.05"
                      max="0.95"
                      value={settingsDraft.mediumConfidenceThreshold}
                      onChange={(e) =>
                        setSettingsDraft((prev) =>
                          prev
                            ? { ...prev, mediumConfidenceThreshold: Number(e.target.value) }
                            : prev
                        )
                      }
                      className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Rendah
                    </label>
                    <input
                      type="number"
                      step="0.05"
                      min="0.05"
                      max="0.9"
                      value={settingsDraft.lowConfidenceThreshold}
                      onChange={(e) =>
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, lowConfidenceThreshold: Number(e.target.value) } : prev
                        )
                      }
                      className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Timeout (ms)
                    </label>
                    <input
                      type="number"
                      step="1000"
                      min="3000"
                      max="60000"
                      value={settingsDraft.requestTimeoutMs}
                      onChange={(e) =>
                        setSettingsDraft((prev) =>
                          prev ? { ...prev, requestTimeoutMs: Number(e.target.value) } : prev
                        )
                      }
                      className="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded-lg tabular-nums"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs text-slate-800 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={settingsDraft.autoAddHighConfidence}
                    onChange={(e) =>
                      setSettingsDraft((prev) =>
                        prev ? { ...prev, autoAddHighConfidence: e.target.checked } : prev
                      )
                    }
                    className="rounded border-slate-300 text-teal-700"
                  />
                  <span>
                    Otomatis tambahkan ke keranjang hanya jika keyakinan{' '}
                    <strong>Tinggi</strong> (stok tersedia). Keyakinan Sedang & Rendah tetap
                    wajib konfirmasi manual.
                  </span>
                </label>

                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={savingSettings}
                    onClick={handleSaveSettings}
                    className="px-4 py-2 text-xs font-bold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
                  >
                    {savingSettings ? 'Menyimpan...' : 'Simpan Konfigurasi AI'}
                  </button>
                </div>
              </div>

              {/* Reference Image Embedding Sync */}
              <div className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-xs font-bold text-slate-900">
                      Indeks Embedding Gambar Referensi Produk
                    </h4>
                    <p className="text-[11px] text-slate-500">
                      Bangun vektor visual untuk gambar produk yang ditandai sebagai Referensi AI agar pencarian kemiripan lebih cepat dan akurat.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={syncingEmbeddings}
                      onClick={() => handleSyncReferenceEmbeddings(false)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${syncingEmbeddings ? 'animate-spin' : ''}`} />
                      {syncingEmbeddings ? 'Menyinkronkan...' : 'Sinkronkan Embedding'}
                    </button>
                  </div>
                </div>

                {syncSummary && (
                  <div className="p-3 rounded-lg bg-white border border-slate-200 text-xs space-y-1">
                    <p className="font-semibold text-slate-900 font-mono tabular-nums">
                      Provider: {syncSummary.providerId} · Siap: {syncSummary.readyCount}/
                      {syncSummary.totalReferenceImages} · Diproses baru: {syncSummary.processed} ·
                      Gagal: {syncSummary.failedCount}
                    </p>
                    {syncSummary.errors.length > 0 && (
                      <p className="text-[11px] text-rose-700">
                        {syncSummary.errors[0].message}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
