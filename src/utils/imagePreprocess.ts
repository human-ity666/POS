export interface PreprocessedAiImage {
  dataBase64: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  byteSize: number;
}

const DEFAULT_MAX_EDGE = 768;
const DEFAULT_JPEG_QUALITY = 0.82;

function estimateBase64ByteLength(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  return Math.floor((base64.length * 3) / 4);
}

export function resizeVideoFrameForAi(
  video: HTMLVideoElement,
  maxEdge = DEFAULT_MAX_EDGE,
  quality = DEFAULT_JPEG_QUALITY
): PreprocessedAiImage | null {
  const originalWidth = video.videoWidth;
  const originalHeight = video.videoHeight;
  if (!originalWidth || !originalHeight) return null;

  const scale = Math.min(1, maxEdge / Math.max(originalWidth, originalHeight));
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, width, height);
  const dataBase64 = canvas.toDataURL('image/jpeg', quality);

  return {
    dataBase64,
    mimeType: 'image/jpeg',
    width,
    height,
    originalWidth,
    originalHeight,
    byteSize: estimateBase64ByteLength(dataBase64),
  };
}

export function preprocessImageFileForAi(
  file: File,
  maxEdge = DEFAULT_MAX_EDGE,
  quality = DEFAULT_JPEG_QUALITY
): Promise<PreprocessedAiImage> {
  return new Promise((resolve, reject) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type.toLowerCase())) {
      reject(new Error('Format file harus berupa JPG, PNG, atau WEBP.'));
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      try {
        const originalWidth = img.naturalWidth || img.width;
        const originalHeight = img.naturalHeight || img.height;
        if (!originalWidth || !originalHeight) {
          reject(new Error('Dimensi gambar tidak valid.'));
          return;
        }

        const scale = Math.min(1, maxEdge / Math.max(originalWidth, originalHeight));
        const width = Math.max(1, Math.round(originalWidth * scale));
        const height = Math.max(1, Math.round(originalHeight * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Gagal membuat konteks kanvas untuk pra-pemrosesan gambar.'));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const dataBase64 = canvas.toDataURL('image/jpeg', quality);
        resolve({
          dataBase64,
          mimeType: 'image/jpeg',
          width,
          height,
          originalWidth,
          originalHeight,
          byteSize: estimateBase64ByteLength(dataBase64),
        });
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Gagal memuat gambar untuk diproses.'));
    };

    img.src = objectUrl;
  });
}
