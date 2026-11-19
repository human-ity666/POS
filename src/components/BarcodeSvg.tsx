import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

interface BarcodeSvgProps {
  value: string;
  height?: number;
  width?: number;
  fontSize?: number;
  displayValue?: boolean;
  className?: string;
}

export function BarcodeSvg({
  value,
  height = 46,
  width = 1.6,
  fontSize = 12,
  displayValue = true,
  className = '',
}: BarcodeSvgProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const el = svgRef.current;
    if (!el || !value) return;

    const clean = value.trim();
    const isValidEan13 = /^\d{13}$/.test(clean);

    try {
      JsBarcode(el, clean, {
        format: isValidEan13 ? 'EAN13' : 'CODE128',
        width,
        height,
        fontSize,
        displayValue,
        margin: 6,
        background: '#ffffff',
        lineColor: '#0f172a',
        font: 'JetBrains Mono, monospace',
      });
    } catch {
      try {
        JsBarcode(el, clean, {
          format: 'CODE128',
          width,
          height,
          fontSize,
          displayValue,
          margin: 6,
          background: '#ffffff',
          lineColor: '#0f172a',
          font: 'JetBrains Mono, monospace',
        });
      } catch {
        // Fallback silently if barcode string is malformed
      }
    }
  }, [value, height, width, fontSize, displayValue]);

  return <svg ref={svgRef} className={className} aria-label={`Barcode ${value}`} />;
}
