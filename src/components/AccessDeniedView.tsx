import { ShieldAlert } from 'lucide-react';

interface AccessDeniedViewProps {
  requiredPermission?: string;
  onGoBack: () => void;
}

export function AccessDeniedView({ requiredPermission, onGoBack }: AccessDeniedViewProps) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-lg mx-auto mt-8 text-center">
      <div className="w-12 h-12 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center mx-auto mb-4">
        <ShieldAlert className="w-6 h-6 text-rose-700" />
      </div>
      <h2 className="text-base font-bold text-slate-900">Akses Ditolak</h2>
      <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
        Akun Anda tidak memiliki izin untuk membuka halaman atau menjalankan operasi ini.
        {requiredPermission ? ` Izin yang dibutuhkan: ${requiredPermission}.` : ''}
      </p>
      <button
        type="button"
        onClick={onGoBack}
        className="mt-5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors"
      >
        Kembali ke Halaman Utama
      </button>
    </div>
  );
}
