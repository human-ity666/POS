import { useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, X } from 'lucide-react';

interface CameraPhotoCaptureModalProps {
  open: boolean;
  onClose: () => void;
  onCapture: (payload: { fileName: string; mimeType: string; dataBase64: string }) => void;
}

export function CameraPhotoCaptureModal({
  open,
  onClose,
  onCapture,
}: CameraPhotoCaptureModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    if (!open) {
      stopStream();
      setPreviewDataUrl(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setStarting(true);
    setError(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('Peramban tidak mendukung akses kamera pada perangkat ini.');
      setStarting(false);
      return;
    }

    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? `Tidak dapat mengakses kamera: ${err.message}`
            : 'Izin kamera ditolak atau kamera tidak tersedia.'
        );
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [open]);

  if (!open) return null;

  const handleSnap = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setError('Stream kamera belum siap. Tunggu sesaat lalu coba lagi.');
      return;
    }
    const canvas = document.createElement('canvas');
    const maxDim = 960;
    const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    setPreviewDataUrl(dataUrl);
  };

  const handleConfirm = () => {
    if (!previewDataUrl) return;
    onCapture({
      fileName: `kamera-${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
      dataBase64: previewDataUrl,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-slate-900/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Ambil Foto Produk dari Kamera"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">Ambil Foto Produk via Kamera</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Tutup kamera"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {error ? (
            <div className="p-4 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
              {error}
            </div>
          ) : (
            <div className="relative bg-slate-900 rounded-lg overflow-hidden aspect-[4/3] flex items-center justify-center">
              {previewDataUrl ? (
                <img
                  src={previewDataUrl}
                  alt="Pratinjau foto produk"
                  className="w-full h-full object-contain"
                />
              ) : (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
              )}
              {starting && !previewDataUrl && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/70 text-xs text-white">
                  Menyiapkan kamera...
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Batal
            </button>
            {previewDataUrl ? (
              <>
                <button
                  type="button"
                  onClick={() => setPreviewDataUrl(null)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Ulangi
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
                >
                  Gunakan Foto Ini
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={Boolean(error) || starting}
                onClick={handleSnap}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
              >
                <Camera className="w-3.5 h-3.5" />
                Ambil Foto
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
