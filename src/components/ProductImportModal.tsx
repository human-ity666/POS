import { useState, type ChangeEvent } from 'react';
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import type { CsvImportPreviewResult, StoreData } from '../types';
import { apiFetch } from '../utils/api';
import { downloadCSV, formatRupiah, parseCSVText } from '../utils/format';

interface ProductImportModalProps {
  open: boolean;
  onClose: () => void;
  onImported: (store: StoreData) => void;
}

const TARGET_FIELDS = [
  { key: 'sku', label: 'SKU (opsional, auto jika kosong)' },
  { key: 'barcode', label: 'Barcode Utama *' },
  { key: 'barcodeType', label: 'Tipe Barcode' },
  { key: 'name', label: 'Nama Produk *' },
  { key: 'category', label: 'Kategori' },
  { key: 'subcategory', label: 'Subkategori' },
  { key: 'brand', label: 'Merek' },
  { key: 'unit', label: 'Satuan (PCS/PACK/BOTTLE/dll)' },
  { key: 'costPrice', label: 'Harga Modal' },
  { key: 'sellPrice', label: 'Harga Jual *' },
  { key: 'specialPrice', label: 'Harga Khusus' },
  { key: 'stock', label: 'Stok Awal' },
  { key: 'minStock', label: 'Minimum Stok' },
  { key: 'variant', label: 'Varian' },
  { key: 'size', label: 'Ukuran' },
  { key: 'weight', label: 'Berat (g)' },
  { key: 'volume', label: 'Volume (ml)' },
  { key: 'taxCategory', label: 'Kategori Pajak' },
  { key: 'status', label: 'Status (ACTIVE/INACTIVE)' },
  { key: 'description', label: 'Deskripsi' },
] as const;

type TargetFieldKey = (typeof TARGET_FIELDS)[number]['key'];

const AUTO_MATCH_ALIASES: Record<TargetFieldKey, string[]> = {
  sku: ['sku', 'kode sku', 'product sku'],
  barcode: ['barcode', 'barcode utama', 'ean', 'upc', 'kode barcode'],
  barcodeType: ['barcodetype', 'barcode type', 'tipe barcode'],
  name: ['name', 'nama', 'nama produk', 'product name', 'produk'],
  category: ['category', 'kategori'],
  subcategory: ['subcategory', 'subkategori', 'sub kategori'],
  brand: ['brand', 'merek', 'merk'],
  unit: ['unit', 'uom', 'satuan'],
  costPrice: ['costprice', 'cost price', 'cost', 'harga modal', 'modal'],
  sellPrice: ['sellprice', 'sell price', 'selling price', 'price', 'harga jual'],
  specialPrice: ['specialprice', 'special price', 'harga khusus', 'harga promo'],
  stock: ['stock', 'stok', 'stok awal', 'qty'],
  minStock: ['minstock', 'min stock', 'minimum stock', 'minimum stok'],
  variant: ['variant', 'varian'],
  size: ['size', 'ukuran'],
  weight: ['weight', 'berat', 'berat (g)'],
  volume: ['volume', 'volume (ml)'],
  taxCategory: ['taxcategory', 'tax category', 'kategori pajak', 'pajak'],
  status: ['status', 'product status'],
  description: ['description', 'deskripsi', 'keterangan'],
};

function guessColumnMapping(headers: string[]): Record<TargetFieldKey, string> {
  const lowerHeaders = headers.map((h) => ({ raw: h, norm: h.trim().toLowerCase() }));
  const mapping = {} as Record<TargetFieldKey, string>;
  for (const field of TARGET_FIELDS) {
    const aliases = AUTO_MATCH_ALIASES[field.key];
    const exact = lowerHeaders.find((h) => aliases.includes(h.norm));
    const partial =
      exact ||
      lowerHeaders.find((h) => aliases.some((a) => h.norm.includes(a) || a.includes(h.norm)));
    mapping[field.key] = partial ? partial.raw : '';
  }
  return mapping;
}

export function ProductImportModal({ open, onClose, onImported }: ProductImportModalProps) {
  const [fileName, setFileName] = useState<string>('');
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<TargetFieldKey, string>>(
    () => ({} as Record<TargetFieldKey, string>)
  );
  const [preview, setPreview] = useState<CsvImportPreviewResult | null>(null);
  const [commitSummary, setCommitSummary] = useState<{
    importedCount: number;
    skippedCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const resetAll = () => {
    setFileName('');
    setCsvHeaders([]);
    setCsvRows([]);
    setPreview(null);
    setCommitSummary(null);
    setError(null);
  };

  const handleDownloadTemplate = () => {
    downloadCSV(
      'template-impor-produk.csv',
      [
        'sku',
        'barcode',
        'barcodeType',
        'name',
        'category',
        'subcategory',
        'brand',
        'unit',
        'costPrice',
        'sellPrice',
        'specialPrice',
        'stock',
        'minStock',
        'variant',
        'size',
        'weight',
        'volume',
        'taxCategory',
        'status',
        'description',
      ],
      [
        [
          'SKU-9001',
          '8991234567890',
          'EAN-13',
          'Pocari Sweat Kaleng 330ml',
          'Minuman',
          'Air Mineral',
          'Pocari',
          'PCS',
          '5500',
          '7500',
          '7000',
          '24',
          '6',
          'Original',
          '330ml',
          '',
          '330',
          'STANDARD',
          'ACTIVE',
          'Minuman isotonik kemasan kaleng',
        ],
      ]
    );
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setPreview(null);
    setCommitSummary(null);
    try {
      const text = await file.text();
      const parsed = parseCSVText(text);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setError('File CSV kosong atau tidak memiliki baris data.');
        return;
      }
      setFileName(file.name);
      setCsvHeaders(parsed.headers);
      setCsvRows(parsed.rows);
      setMapping(guessColumnMapping(parsed.headers));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membaca file CSV.');
    } finally {
      e.target.value = '';
    }
  };

  const buildMappedRows = () => {
    const idxByHeader = new Map(csvHeaders.map((h, i) => [h, i]));
    return csvRows.map((row) => {
      const out: Record<string, string> = {};
      for (const field of TARGET_FIELDS) {
        const mappedHeader = mapping[field.key];
        if (mappedHeader) {
          const idx = idxByHeader.get(mappedHeader);
          if (idx !== undefined) {
            out[field.key] = row[idx] ?? '';
          }
        }
      }
      return out;
    });
  };

  const handlePreview = async () => {
    setError(null);
    setCommitSummary(null);
    if (!mapping.barcode || !mapping.name || !mapping.sellPrice) {
      setError('Pemetaan kolom Barcode, Nama Produk, dan Harga Jual wajib dipilih.');
      return;
    }
    setLoading(true);
    try {
      const mapped = buildMappedRows();
      const res = await apiFetch<CsvImportPreviewResult>('/api/products/import/preview', {
        method: 'POST',
        body: JSON.stringify({ rows: mapped }),
      });
      setPreview(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memvalidasi data CSV.');
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    setError(null);
    setLoading(true);
    try {
      const mapped = buildMappedRows();
      const res = await apiFetch<{
        importedCount: number;
        skippedCount: number;
        preview: CsvImportPreviewResult;
        store: StoreData;
      }>('/api/products/import/commit', {
        method: 'POST',
        body: JSON.stringify({ rows: mapped }),
      });
      setPreview(res.preview);
      setCommitSummary({
        importedCount: res.importedCount,
        skippedCount: res.skippedCount,
      });
      onImported(res.store);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengimpor produk.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Impor Katalog Produk CSV"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet className="w-5 h-5 text-teal-700" />
            <div>
              <h3 className="text-base font-semibold text-slate-900">Impor Katalog Produk (CSV)</h3>
              <p className="text-xs text-slate-500">
                Unggah CSV, petakan kolom, validasi duplikat SKU & barcode, lalu impor.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              resetAll();
              onClose();
            }}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
            aria-label="Tutup impor CSV"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="p-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {commitSummary && (
            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-emerald-900">
                <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0" />
                <div className="text-xs">
                  <p className="font-semibold">Impor Produk Selesai</p>
                  <p className="mt-0.5 tabular-nums">
                    {commitSummary.importedCount} produk berhasil disimpan ke katalog ·{' '}
                    {commitSummary.skippedCount} baris bermasalah dilewati.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  resetAll();
                  onClose();
                }}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg shrink-0"
              >
                Selesai
              </button>
            </div>
          )}

          {/* Step 1: Upload & Template */}
          <div className="border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg cursor-pointer transition-colors">
                <Upload className="w-3.5 h-3.5" />
                <span>{fileName ? 'Ganti File CSV' : 'Pilih File CSV'}</span>
                <input type="file" accept=".csv,text/csv" onChange={handleFileChange} className="hidden" />
              </label>
              {fileName && (
                <span className="text-xs font-medium text-slate-700 tabular-nums">
                  {fileName} · {csvRows.length} baris terdeteksi
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
            >
              <Download className="w-3.5 h-3.5" />
              Unduh Template CSV
            </button>
          </div>

          {/* Step 2: Column Mapping */}
          {csvHeaders.length > 0 && !commitSummary && (
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-semibold text-slate-900">Pemetaan Kolom CSV</h4>
                  <p className="text-[11px] text-slate-500">
                    Cocokkan kolom dari file CSV Anda dengan atribut produk KassaRitel.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={loading}
                  onClick={handlePreview}
                  className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg disabled:opacity-50"
                >
                  {loading ? 'Memvalidasi...' : 'Validasi & Pratinjau'}
                </button>
              </div>

              <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {TARGET_FIELDS.map((field) => (
                  <div key={field.key}>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      {field.label}
                    </label>
                    <select
                      value={mapping[field.key] || ''}
                      onChange={(e) => {
                        setMapping((prev) => ({ ...prev, [field.key]: e.target.value }));
                        setPreview(null);
                      }}
                      className="w-full text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                    >
                      <option value="">-- Abaikan --</option>
                      {csvHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Validation Preview & Error Report */}
          {preview && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 border border-slate-200 rounded-lg">
                  <p className="text-[11px] text-slate-500">Total Baris</p>
                  <p className="font-mono text-lg font-bold text-slate-900 tabular-nums">
                    {preview.totalRows}
                  </p>
                </div>
                <div className="p-3 border border-emerald-200 bg-emerald-50/50 rounded-lg">
                  <p className="text-[11px] text-emerald-700">Siap Diimpor (Valid)</p>
                  <p className="font-mono text-lg font-bold text-emerald-800 tabular-nums">
                    {preview.validCount}
                  </p>
                </div>
                <div className="p-3 border border-rose-200 bg-rose-50/50 rounded-lg">
                  <p className="text-[11px] text-rose-700">Ditolak / Duplikat</p>
                  <p className="font-mono text-lg font-bold text-rose-800 tabular-nums">
                    {preview.errorCount}
                  </p>
                </div>
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-500">
                      <tr>
                        <th className="py-2.5 px-3">#</th>
                        <th className="py-2.5 px-3">SKU</th>
                        <th className="py-2.5 px-3">Barcode</th>
                        <th className="py-2.5 px-3">Nama Produk</th>
                        <th className="py-2.5 px-3">Kategori / Merek</th>
                        <th className="py-2.5 px-3 text-right">Harga Jual</th>
                        <th className="py-2.5 px-3 text-right">Stok</th>
                        <th className="py-2.5 px-3">Hasil Validasi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {preview.rows.map((r) => (
                        <tr key={r.rowNumber} className={r.valid ? 'bg-white' : 'bg-rose-50/40'}>
                          <td className="py-2 px-3 font-mono text-slate-500 tabular-nums">
                            {r.rowNumber}
                          </td>
                          <td className="py-2 px-3 font-mono text-slate-700">
                            {r.sku || <span className="text-slate-400">Auto</span>}
                          </td>
                          <td className="py-2 px-3 font-mono text-slate-700 tabular-nums">
                            {r.barcode || '-'}
                          </td>
                          <td className="py-2 px-3 font-medium text-slate-900">{r.name || '-'}</td>
                          <td className="py-2 px-3 text-slate-600">
                            {r.category} · {r.brand}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums">
                            {formatRupiah(r.sellPrice)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums">
                            {r.stock} {r.unit}
                          </td>
                          <td className="py-2 px-3">
                            {r.valid ? (
                              <span className="text-emerald-700 font-semibold">Valid</span>
                            ) : (
                              <span className="text-rose-700 font-medium">
                                {r.errors.join('; ')}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              resetAll();
              onClose();
            }}
            className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Tutup
          </button>
          {preview && preview.validCount > 0 && !commitSummary && (
            <button
              type="button"
              disabled={loading}
              onClick={handleCommit}
              className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
            >
              {loading ? 'Mengimpor...' : `Impor ${preview.validCount} Produk Valid`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
