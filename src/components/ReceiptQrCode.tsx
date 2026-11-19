import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface ReceiptQrCodeProps {
  value: string;
  size?: number;
  className?: string;
}

export function ReceiptQrCode({ value, size = 104, className = '' }: ReceiptQrCodeProps) {
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setError(false);
    QRCode.toString(value, {
      type: 'svg',
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
      .then((svg) => {
        if (active) setSvgMarkup(svg);
      })
      .catch(() => {
        if (active) setError(true);
      });

    return () => {
      active = false;
    };
  }, [value, size]);

  if (error) {
    return (
      <div
        className={`inline-flex items-center justify-center border border-slate-300 rounded p-2 text-[10px] font-mono text-slate-500 ${className}`}
        style={{ width: size, height: size }}
      >
        QR Tidak Tersedia
      </div>
    );
  }

  if (!svgMarkup) {
    return (
      <div
        className={`inline-block bg-slate-100 rounded ${className}`}
        style={{ width: size, height: size }}
        aria-label="Membuat QR Code struk"
      />
    );
  }

  return (
    <div
      className={`inline-block bg-white p-1 border border-slate-200 rounded ${className}`}
      style={{ width: size + 10, height: size + 10 }}
      aria-label="QR Code Verifikasi Struk Digital"
      dangerouslySetInnerHTML={{ __html: svgMarkup }}
    />
  );
}
