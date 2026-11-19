# KassaRitel POS — Smart Retail Point of Sale

Aplikasi Point of Sale (POS) toko ritel berbasis web dengan pemindai barcode kamera langsung, kontrol akses berbasis role (RBAC), otorisasi PIN supervisor, manajemen master produk & katalog terstruktur, alur checkout atomik multi-pembayaran, serta laporan stok otomatis.

## Arsitektur & Teknologi

- **Frontend**: React 19 + TypeScript (`strict: true`) + Tailwind CSS v4 + Vite
- **Pemindai & Barcode**:
  - `@zxing/browser` & `@zxing/library` untuk pemindaian kamera langsung (`EAN-13`, `EAN-8`, `UPC-A`, `UPC-E`, `Code 128`, `Code 39`, `QR Code`)
  - `jsbarcode` untuk render dan cetak label barcode SVG scannable (mendukung multi-barcode per produk)
  - Web Audio API untuk suara *beep* konfirmasi pemindaian
- **Backend**: Express + TypeScript (`server.ts`, `server/services/authService.ts`, `server/services/userRoleService.ts`, `server/services/catalogService.ts`, `server/services/checkoutService.ts`, `server/services/receiptService.ts`, `server/services/posService.ts`, `server/services/auditService.ts`)
- **Kalkulasi Moneter Zero-Float**: `server/utils/money.ts` menggunakan `BigInt` scaled-integer & basis-point untuk perhitungan harga, diskon baris, diskon transaksi, alokasi diskon proporsional, dan pajak tanpa error floating-point.
- **Database & Migrasi**: SQLite relasional bawaan Node.js (`node:sqlite` `DatabaseSync`) di `data/pos.db` (dapat dikonfigurasi via `POS_DB_FILE`) dengan migrasi SQL formal di `server/db/migrations/` (`001_initial_pos.sql`, `002_auth_rbac.sql`, `003_product_catalog.sql`, `004_pos_core_checkout.sql`, `005_receipt_printing.sql`).
- **Struk, QR Digital & Pencetakan (`Phase 05`)**:
  - Snapshot historis struk (`receipt_snapshots`) dibekukan pada saat checkout sehingga cetak ulang selalu konsisten dan tidak pernah dihitung ulang dari harga katalog terbaru.
  - Tata letak cetak thermal `58mm`, `80mm`, standar `A4`, serta struk digital responsif dengan QR Code (`qrcode`) yang terhubung ke halaman verifikasi digital publik.
  - Arsitektur adapter printer modular (`src/services/printerService.ts`) menggunakan dialog cetak browser/OS + ekspor HTML mandiri dengan pelacakan salinan cetak (`receipt_print_logs`).
- **Penyimpanan Gambar & Logo**: Gambar produk di `data/uploads/products/` (`POS_UPLOADS_DIR`) dan logo toko di `data/uploads/store/` (`POS_STORE_UPLOADS_DIR`) dengan validasi MIME & magic bytes (`JPG`, `PNG`, `WEBP`).
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
│   │       └── 005_receipt_printing.sql       # Store logo/receipt settings, receipt_snapshots, receipt_print_logs
│   ├── services/
│   │   ├── auditService.ts                    # Pencatatan & query audit log
│   │   ├── authService.ts                     # Login, refresh rotation, logout, sesi, & verifikasi PIN
│   │   ├── catalogService.ts                  # Master katalog, multi-barcode, gambar, kategori/merek/UOM, CSV
│   │   ├── checkoutService.ts                 # Kalkulasi BigInt, hold/resume/cancel, & checkout atomik 14 langkah
│   │   ├── errors.ts                          # ServiceError terstruktur
│   │   ├── posService.ts                      # Wrapper POS & laporan stok server-authoritative
│   │   ├── receiptService.ts                  # Snapshot struk historis, log cetak ulang, QR token, & logo toko
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
│   │   └── format.ts                          # Format Rupiah, tanggal, EAN-13, parser CSV RFC-4180, file helpers
│   └── components/
│       ├── AccessDeniedView.tsx               # Layar penolakan akses RBAC
│       ├── BarcodeSvg.tsx                     # Renderer barcode SVG scannable
│       ├── CameraPhotoCaptureModal.tsx        # Tangkap foto produk & referensi AI via kamera
│       ├── CameraScanner.tsx                  # Pemindai barcode kamera langsung
│       ├── CashierView.tsx                    # Terminal kasir (autocomplete, hold/resume, diskon/override)
│       ├── CatalogTaxonomyTabs.tsx            # Manajemen Kategori hierarkis, Merek, & Satuan UOM
│       ├── HeldTransactionsModal.tsx          # Daftar, lanjutkan, & batalkan transaksi ditahan (Hold)
│       ├── InventoryView.tsx                  # Katalog produk (filter, sort, pagination, ekspor/impor CSV)
│       ├── LoginScreen.tsx                    # Halaman login dengan show/hide password
│       ├── PaymentModal.tsx                   # Pembayaran tunggal & split multi-metode dengan idempotencyKey
│       ├── PinAuthorizationModal.tsx          # Modal verifikasi PIN supervisor/admin
│       ├── ProductDetailModal.tsx             # Detail lengkap produk, galeri gambar, & multi-barcode
│       ├── ProductImportModal.tsx             # Wizard impor CSV (mapping kolom, validasi, preview, ringkasan)
│       ├── ProductModals.tsx                  # Form produk 7 bagian, penyesuaian stok, & cetak label barcode
│       ├── ProfileModal.tsx                   # Profil pengguna & ubah kata sandi
│       ├── ReceiptDetailView.tsx              # Halaman detail struk, cetak ulang, riwayat cetak, & struk digital
│       ├── ReceiptDocument.tsx                # Renderer struk multi-format (58mm, 80mm, A4, Digital)
│       ├── ReceiptModal.tsx                   # Modal pratinjau cepat & cetak struk pasca-checkout
│       ├── ReceiptQrCode.tsx                  # Renderer QR code verifikasi struk digital
│       ├── RolesPermissionsView.tsx           # Manajemen role & matriks izin modul
│       ├── SecurityAuditView.tsx              # Manajemen sesi aktif & viewer audit log
│       ├── SettingsModal.tsx                  # Pengaturan toko, PPN, logo/kertas struk, & metode pembayaran
│       ├── StockReportView.tsx                # Laporan stok otomatis & valuasi kategori dinamis
│       ├── TransactionDetailModal.tsx         # Detail lengkap transaksi (item, diskon, split payment)
│       ├── TransactionsView.tsx               # Riwayat transaksi dengan filter tanggal, status & metode
│       └── UsersView.tsx                      # Manajemen pengguna
└── tests/
    └── pos.test.ts                            # Pengujian integrasi Phase 01–05
```

## Dokumentasi Terkait

- [API_REFERENCE.md](./API_REFERENCE.md) — Daftar lengkap endpoint API, izin RBAC, dan format payload.
- [DATABASE_DIAGRAM.md](./DATABASE_DIAGRAM.md) — Skema database ternormalisasi, relasi antar tabel, dan indeks.
- [DEVELOPMENT_STATUS.md](./DEVELOPMENT_STATUS.md) — Status setiap fase, aturan perhitungan, alur transaksi, & uji.

## Perintah Menjalankan & Menguji

- Jalankan server pengembangan (port 3000): `npm run dev`
- Periksa TypeScript strict mode: `npm run lint`
- Jalankan pengujian integrasi Phase 01–05: `npm test`
- Build produksi: `npm run build`
- Jalankan mode produksi: `NODE_ENV=production npm start`
