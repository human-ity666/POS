# KassaRitel POS — Smart Retail Point of Sale

Aplikasi Point of Sale (POS) toko ritel berbasis web dengan pemindai barcode kamera langsung, kontrol akses berbasis role (RBAC), otorisasi PIN supervisor, manajemen master produk & katalog terstruktur, alur checkout atomik multi-pembayaran, serta laporan stok otomatis.

## Arsitektur & Teknologi

- **Frontend**: React 19 + TypeScript (`strict: true`) + Tailwind CSS v4 + Vite
- **Pemindai & Barcode**:
  - Mesin pemindai kamera hibrida (`src/utils/barcodeScanner.ts`): memprioritaskan native browser `BarcodeDetector` (hardware-accelerated) dengan fallback otomatis ke `@zxing/browser` & `@zxing/library`, mendukung `EAN-13`, `EAN-8`, `UPC-A`, `UPC-E`, `Code 128`, `Code 39`, serta mode `QR Code` opsional, kontrol torch/kamera belakang mobile, validasi GS1 check digit, dan proteksi duplikat/debounce
  - `jsbarcode` untuk render dan cetak label barcode SVG scannable (mendukung multi-barcode per produk)
  - Web Audio API untuk suara *beep* konfirmasi pemindaian + haptic feedback mobile
- **Backend**: Express + TypeScript (`server.ts`, `server/services/authService.ts`, `server/services/userRoleService.ts`, `server/services/catalogService.ts`, `server/services/customerService.ts`, `server/services/promotionService.ts`, `server/services/checkoutService.ts`, `server/services/returnVoidService.ts`, `server/services/shiftService.ts`, `server/services/inventoryService.ts`, `server/services/receiptService.ts`, `server/services/recognitionService.ts`, `server/services/ai/*`, `server/services/posService.ts`, `server/services/auditService.ts`)
- **Retur, Refund & Void (`Phase 11`)**: Pencarian struk/invoice historis, retur sebagian/penuh dengan kalkulasi proporsional `BigInt` dari harga historis transaksi, 4 disposisi stok (`SELLABLE` restok `RETURN_IN`, `DAMAGED`, `UNSELLABLE`, `PENDING_INSPECTION` + penyelesaian QC), pencatatan refund tunai (`CASH_REFUND` pada shift aktif) & non-tunai manual, serta void transaksi (`VOID_IN`, pemulihan stok & poin loyalitas) tanpa menghapus transaksi selesai.
- **Shift & Kas Kasir (`Phase 10`)**: Siklus buka/tutup shift kasir (`SHF-YYYYMMDD-XXXX`), pencegahan shift ganda per kasir, mutasi kas laci (`CASH_IN`, `CASH_OUT`, `EXPENSE`, `CASH_REFUND`), penghitung pecahan Rupiah, rekonsiliasi `BigInt` zero-float otomatis, persetujuan selisih kas oleh Supervisor (langsung via PIN maupun pasca-tutup), dan laporan shift siap cetak.
- **Pelanggan, Loyalitas & Promosi (`Phase 09`)**: Manajemen profil & histori belanja member (`CUST-XXXX` / `MBR-XXXX`), transaksi tamu opsional, fondasi poin loyalitas (`EARN`/`REDEEM`/`ADJUST` dengan aturan konfigurabel termasuk opsi nonaktifkan perolehan poin saat penukaran), serta mesin promosi `BigInt` (`PERCENT`, `FIXED_AMOUNT`, `SPECIAL_PRICE`, `BUY_X_GET_Y`, `BUNDLE`) dengan validasi periode & aturan stacking/batas diskon.
- **Pengenalan Produk AI (`Phase 08`)**: Arsitektur provider modular yang dapat diganti (`gemini-vision` server-side `@google/genai`, `local-inference`, `remote-inference`), pra-pemrosesan gambar di klien (`src/utils/imagePreprocess.ts`), ranking multi-sinyal (embedding visual + OCR + merek + varian + berat/volume + kemasan), ambang batas keyakinan terkonfigurasi, serta umpan balik terverifikasi.
- **Kalkulasi Moneter Zero-Float**: `server/utils/money.ts` menggunakan `BigInt` scaled-integer & basis-point untuk perhitungan harga, diskon baris, diskon promosi, penukaran poin, alokasi proporsional, dan pajak tanpa error floating-point.
- **Database & Migrasi**: SQLite relasional bawaan Node.js (`node:sqlite` `DatabaseSync`) di `data/pos.db` (dapat dikonfigurasi via `POS_DB_FILE`) dengan migrasi SQL formal di `server/db/migrations/` (`001_initial_pos.sql` s.d. `012_return_refund_void.sql`).
- **Struk, QR Digital & Pencetakan (`Phase 05`)**:
  - Snapshot historis struk (`receipt_snapshots`) dibekukan pada saat checkout sehingga cetak ulang selalu konsisten dan tidak pernah dihitung ulang dari harga katalog terbaru.
  - Tata letak cetak thermal `58mm`, `80mm`, standar `A4`, serta struk digital responsif dengan QR Code (`qrcode`) yang terhubung ke halaman verifikasi digital publik.
  - Arsitektur adapter printer modular (`src/services/printerService.ts`) menggunakan dialog cetak browser/OS + ekspor HTML mandiri dengan pelacakan salinan cetak (`receipt_print_logs`).
- **Penyimpanan Gambar & Logo**: Gambar produk di `data/uploads/products/` (`POS_UPLOADS_DIR`), logo toko di `data/uploads/store/` (`POS_STORE_UPLOADS_DIR`), dan tangkapan AI di `data/uploads/recognition/` (`POS_RECOGNITION_UPLOADS_DIR`) dengan validasi MIME & magic bytes (`JPG`, `PNG`, `WEBP`).
- **Keamanan**:
  - Hashing kata sandi & PIN dengan `crypto.scryptSync` + salt acak 16-byte + perbandingan `timingSafeEqual`
  - Sesi token ter-hash (`SHA-256`) di database dengan cookie `HttpOnly` dan rotasi refresh token
  - Enforced backend RBAC permissions, idempotency checkout key, & otorisasi PIN single-use token

## Akun Uji Bawaan (Lingkungan Development)

| Role | Username | Email | Kata Sandi | PIN Otorisasi |
| :--- | :--- | :--- | :--- | :--- |
| `Admin` | `admin` | `admin@kassaritel.id` | `Admin123!` | `123456` |
| `Supervisor` | `supervisor` | `supervisor@kassaritel.id` | `Super123!` | `654321` |
| `Cashier` | `kasir` | `kasir@kassaritel.id` | `Kasir123!` | `-` |

## Struktur Proyek

```text
├── API_REFERENCE.md                           # Dokumentasi lengkap endpoint REST & izin RBAC
├── DATABASE_DIAGRAM.md                        # Diagram ER, tabel ternormalisasi, & indeks SQLite
├── DEVELOPMENT_STATUS.md                      # Ringkasan progres fase, uji, & keterbatasan
├── server.ts                                  # Express server, RBAC middleware, & routing API
├── server/
│   ├── db/
│   │   ├── database.ts                        # Koneksi SQLite, runner migrasi, seed RBAC, katalog & POS
│   │   └── migrations/
│   │       ├── 001_initial_pos.sql            # Produk, transaksi, item, mutasi stok, pengaturan, audit
│   │       ├── 002_auth_rbac.sql              # Users, roles, permissions, sessions, pin_authorizations
│   │       ├── 003_product_catalog.sql        # Categories, brands, uoms, product_barcodes, product_images
│   │       ├── 004_pos_core_checkout.sql      # Customers, payment_methods, document_sequences, transaction_payments
│   │       ├── 005_receipt_printing.sql       # Store logo/receipt settings, receipt_snapshots, receipt_print_logs
│   │       ├── 006_inventory_stock_control.sql# Stock receivings, adjustments, opnames, negative stock, movement audit
│   │       ├── 007_ai_product_recognition.sql # Image embeddings, recognition settings, & verification feedback logs
│   │       ├── 008_customer_promotion.sql     # Membership loyalty, point ledger, promotions, targets & stacking rules
│   │       ├── 009_loyalty_disable_earn_on_redeem.sql # Toggle disable earn points saat redeem poin
│   │       ├── 010_pin_item_cancel_constraint.sql     # Tambahan constraint PIN item_cancel
│   │       ├── 011_shift_cash_management.sql  # Pengaturan shift, cashier_shifts, cash_movements & transaksi shift_id
│   │       └── 012_return_refund_void.sql     # Retur, item retur, disposisi stok, void & buku besar refund
│   ├── services/
│   │   ├── ai/                                # Pluggable AI providers (Gemini, Local, Remote) & multi-signal scorer
│   │   ├── auditService.ts                    # Pencatatan & query audit log
│   │   ├── authService.ts                     # Login, refresh rotation, logout, sesi, & verifikasi PIN
│   │   ├── catalogService.ts                  # Master katalog, multi-barcode, gambar, kategori/merek/UOM, CSV
│   │   ├── checkoutService.ts                 # Kalkulasi BigInt, promo/poin, hold/resume/cancel, & checkout atomik
│   │   ├── customerService.ts                 # Manajemen pelanggan, metrik belanja, aturan & mutasi poin loyalitas
│   │   ├── errors.ts                          # ServiceError terstruktur
│   │   ├── inventoryService.ts                # Saldo stok, barang masuk, penyesuaian, stok opname & kartu stok
│   │   ├── posService.ts                      # Wrapper POS & laporan stok server-authoritative
│   │   ├── promotionService.ts                # Manajemen promosi, validasi aturan, & evaluator BigInt
│   │   ├── receiptService.ts                  # Snapshot struk historis, log cetak ulang, QR token, & logo toko
│   │   ├── recognitionService.ts              # Pipeline 13 langkah identifikasi produk AI & sinkronisasi referensi
│   │   ├── returnVoidService.ts               # Mesin retur proporsional BigInt, inspeksi QC, refund & void transaksi
│   │   ├── shiftService.ts                    # Buka/tutup shift, mutasi kas, rekonsiliasi BigInt & approval selisih
│   │   └── userRoleService.ts                 # Manajemen pengguna, role, & matriks izin
│   └── utils/
│       ├── crypto.ts                          # Hashing scrypt & SHA-256 token
│       └── money.ts                           # Aritmetika moneter BigInt tanpa floating-point
├── src/
│   ├── App.tsx                                # Gate autentikasi, rute struk digital publik, sidebar & routing view
│   ├── types.ts                               # Tipe TypeScript bersama
│   ├── services/
│   │   └── printerService.ts                  # Adapter cetak modular (dialog OS/browser & ekspor struk digital HTML)
│   ├── utils/
│   │   ├── api.ts                             # Client fetch terautentikasi + auto-refresh token
│   │   ├── barcodeScanner.ts                  # Engine pemindai kamera (native BarcodeDetector + ZXing), validator GS1, & guard debounce
│   │   ├── format.ts                          # Format Rupiah, tanggal, EAN-13, parser CSV RFC-4180, file helpers
│   │   └── imagePreprocess.ts                 # Resizing & kompresi kanvas klien untuk AI recognition
│   └── components/
│       ├── AccessDeniedView.tsx               # Layar penolakan akses RBAC
│       ├── AiRecognitionModal.tsx             # Modal kamera/unggah AI, hasil OCR, kandidat, threshold & umpan balik
│       ├── BarcodeSvg.tsx                     # Renderer barcode SVG scannable
│       ├── CameraPhotoCaptureModal.tsx        # Tangkap foto produk & referensi AI via kamera
│       ├── CameraScanner.tsx                  # Pemindai barcode kamera langsung
│       ├── CashierView.tsx                    # Terminal kasir (promo, poin loyalitas, autocomplete, hold/resume, AI)
│       ├── CatalogTaxonomyTabs.tsx            # Manajemen Kategori hierarkis, Merek, & Satuan UOM
│       ├── CustomersView.tsx                  # Manajemen pelanggan, profil member, riwayat belanja & mutasi poin
│       ├── HeldTransactionsModal.tsx          # Daftar, lanjutkan, & batalkan transaksi ditahan (Hold)
│       ├── InventoryView.tsx                  # Katalog produk (filter, sort, pagination, ekspor/impor CSV)
│       ├── LoginScreen.tsx                    # Halaman login dengan show/hide password
│       ├── PaymentModal.tsx                   # Pembayaran tunggal & split multi-metode dengan idempotencyKey
│       ├── PinAuthorizationModal.tsx          # Modal verifikasi PIN supervisor/admin
│       ├── ProductDetailModal.tsx             # Detail lengkap produk, galeri gambar, & multi-barcode
│       ├── ProductImportModal.tsx             # Wizard impor CSV (mapping kolom, validasi, preview, ringkasan)
│       ├── ProductModals.tsx                  # Form produk 7 bagian, penyesuaian stok, & cetak label barcode
│       ├── ProfileModal.tsx                   # Profil pengguna & ubah kata sandi
│       ├── PromotionsView.tsx                 # Manajemen promosi, paket bundle, aturan loyalitas & kebijakan diskon
│       ├── ReceiptDetailView.tsx              # Halaman detail struk, cetak ulang, riwayat cetak, & struk digital
│       ├── ReceiptDocument.tsx                # Renderer struk multi-format (58mm, 80mm, A4, Digital)
│       ├── ReceiptModal.tsx                   # Modal pratinjau cepat & cetak struk pasca-checkout
│       ├── ReceiptQrCode.tsx                  # Renderer QR code verifikasi struk digital
│       ├── ReturnVoidModals.tsx               # Modal buat retur, void transaksi, keputusan QC & update refund
│       ├── ReturnVoidView.tsx                 # Halaman Retur, Refund, Inspeksi QC & Riwayat Void
│       ├── RolesPermissionsView.tsx           # Manajemen role & matriks izin modul
│       ├── SecurityAuditView.tsx              # Manajemen sesi aktif & viewer audit log
│       ├── SettingsModal.tsx                  # Pengaturan toko, PPN, stok negatif, logo/kertas struk & metode bayar
│       ├── ShiftModals.tsx                    # Modal buka shift, mutasi kas, tutup kasir (pecahan IDR), approval & cetak laporan
│       ├── ShiftView.tsx                      # Halaman Shift & Kas Kasir (shift aktif, riwayat & laporan, konfigurasi)
│       ├── StockCardModal.tsx                 # Modal kartu stok per produk, filter tanggal/jenis & ekspor CSV
│       ├── StockControlView.tsx               # Kontrol stok (saldo/alert, barang masuk, penyesuaian, opname, mutasi)
│       ├── StockReportView.tsx                # Laporan stok otomatis & valuasi kategori dinamis
│       ├── TransactionDetailModal.tsx         # Detail lengkap transaksi (item, promo, poin, split payment)
│       ├── TransactionsView.tsx               # Riwayat transaksi dengan filter tanggal, status & metode
│       └── UsersView.tsx                      # Manajemen pengguna
└── tests/
    └── pos.test.ts                            # Pengujian unit & integrasi Phase 01–11
```

## Dokumentasi Terkait

- [API_REFERENCE.md](./API_REFERENCE.md) — Daftar lengkap endpoint API, izin RBAC, dan format payload.
- [DATABASE_DIAGRAM.md](./DATABASE_DIAGRAM.md) — Skema database ternormalisasi, relasi antar tabel, dan indeks.
- [DEVELOPMENT_STATUS.md](./DEVELOPMENT_STATUS.md) — Status setiap fase, aturan perhitungan, alur transaksi, & uji.

## Perintah Menjalankan & Menguji

- Jalankan server pengembangan (port 3000): `npm run dev`
- Periksa TypeScript strict mode: `npm run lint`
- Jalankan pengujian unit & integrasi Phase 01–11: `npm test`
- Build produksi: `npm run build`
- Jalankan mode produksi: `NODE_ENV=production npm start`
