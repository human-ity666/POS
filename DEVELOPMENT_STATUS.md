# Development Status — KassaRitel POS

Terakhir diperbarui: 2026-11-20

## Ringkasan Status Fase

### Phase 01: Core Retail POS, Camera Barcode Scanner & Automated Stock Reporting — **COMPLETED**
- Terminal kasir cepat dengan pemindai kamera langsung (`@zxing/browser`), input USB barcode (`F2`), label barcode (`jsbarcode`), struk cetak, laporan stok otomatis, mutasi stok, dan ekspor CSV.

### Phase 02: Authentication, RBAC, Session Control & SQLite Migrations — **COMPLETED**
- Autentikasi aman (`scrypt` + `SHA-256` session token, cookie `HttpOnly`, rotasi refresh token), CRUD pengguna, role & permission granular (`Admin`, `Supervisor`, `Cashier`, plus role kustom), verifikasi PIN supervisor sekali pakai, manajemen sesi aktif, dan audit log lengkap.

### Phase 03: Product Master & Catalog — **COMPLETED**
- Master produk ternormalisasi (`003_product_catalog.sql`), multi-barcode per produk, unggah banyak gambar & tangkap kamera dengan metadata referensi AI, kategori hierarkis, merek, 8+ satuan UOM, pratinjau/commit impor CSV, serta ekspor CSV terfilter.

### Phase 04: POS Core & Checkout — **COMPLETED**
- Mesin kalkulasi `BigInt` zero-float (`server/utils/money.ts`), hold/resume/cancel transaksi, pembayaran tunggal & split multi-metode (`Tunai`, `Kartu Debit`, `Kartu Kredit`, `QRIS`, metode kustom), checkout atomik 14 langkah dengan `idempotencyKey`, dan perlindungan transaksi `COMPLETED` dari penghapusan fisik.

---

### Phase 05: Receipt & Printing — **COMPLETED**

Fitur yang sudah selesai dan terverifikasi:

1. **Migrasi Database Struk & Logo Toko (`server/db/migrations/005_receipt_printing.sql`)**:
   - Memperbarui tabel `store_settings` dengan `store_logo_url`, `receipt_paper_width` (`58mm` | `80mm` | `A4`), `receipt_show_logo`, `receipt_show_qr`, dan `receipt_header_note`.
   - Menambahkan tabel `receipt_snapshots` yang membekukan (*freeze*) profil toko, logo toko, catatan header/footer, tarif pajak, nomor struk, serta `verification_token` unik pada saat checkout selesai (`captureReceiptSnapshotTx`).
   - Menambahkan tabel `receipt_print_logs` beserta indeks `idx_receipt_print_logs_trx` untuk mencatat setiap aksi cetak asli (`ORIGINAL`) maupun cetak ulang (`REPRINT`), nomor salinan (`copy_number`), format tata letak, adapter printer, serta identitas staf pencetak.

2. **Integritas Data Historis & Cetak Ulang Aman (`server/services/receiptService.ts`, `server/services/checkoutService.ts`)**:
   - Nilai item, harga satuan historis, diskon, PPN, grand total, dan rincian pembayaran diambil murni dari arsip `transactions`, `transaction_items`, `transaction_payments`, dan `receipt_snapshots`.
   - Perubahan harga jual produk di katalog atau perubahan profil/logo toko **setelah transaksi selesai** tidak pernah mengubah data struk historis saat dilihat ulang atau dicetak ulang.
   - `POST /api/transactions/:id/receipt/print` hanya mencatat `receipt_print_logs` + audit log (`RECEIPT_PRINTED` / `RECEIPT_REPRINTED`) dan menambah `print_count` — tidak pernah membuat transaksi baru.
   - Transaksi yang belum selesai (`HELD` / `IN_PROGRESS`) ditolak saat permintaan struk resmi (`409 Conflict`).

3. **Multi-Layout Struk, QR Code Digital & Halaman Detail Struk (`ReceiptDocument.tsx`, `ReceiptDetailView.tsx`, `ReceiptModal.tsx`, `ReceiptQrCode.tsx`)**:
   - **Tata Letak Thermal `58mm` & `80mm`**, **Standar `A4`**, serta **Struk Digital Responsif Mobile** dengan QR code SVG (`qrcode`).
   - QR code mengarah ke tautan struk digital terverifikasi (`/?receipt=<id>&token=<verificationToken>`) yang divalidasi di backend menggunakan `crypto.timingSafeEqual` (`GET /api/receipts/public/:id?token=...`).
   - Print preview interaktif dengan pengalih lebar kertas, halaman detail struk khusus beserta riwayat cetak ulang, salin tautan digital, unduh file HTML mandiri, dan `@media print` CSS (`src/index.css`) yang menyembunyikan seluruh elemen UI (`.no-print`) dan mengatur lebar kertas cetak.

4. **Konfigurasi Logo Toko & Arsitektur Printer Modular (`SettingsModal.tsx`, `src/services/printerService.ts`)**:
   - Unggah & hapus logo toko (`POST /api/settings/logo`, `DELETE /api/settings/logo`) dengan validasi MIME & magic bytes (`PNG`/`JPG`/`WEBP`, maks 2 MB) di `POS_STORE_UPLOADS_DIR` / `data/uploads/store`.
   - Adapter modular `ReceiptPrintAdapter`: `browserPrintAdapter` (`window.print()` via dialog OS/browser, `isHardwareDirect: false`) dan `digitalExportAdapter` (ekspor `.html` mandiri) dengan penanganan error cetak yang aman.

---

### Phase 06: Inventory & Stock Control — **COMPLETED**

Fitur yang sudah selesai dan terverifikasi:

1. **Migrasi Database & Kebijakan Integritas Stok (`server/db/migrations/006_inventory_stock_control.sql`)**:
   - Menambahkan opsi konfigurasi `allow_negative_stock` pada `store_settings` dan melepas batas `CHECK (stock >= 0)` hanya ketika mode stok negatif diaktifkan.
   - Memperkaya tabel `stock_movements` dengan kolom `sku`, `unit_cost`, `reason`, `actor_user_id`, `actor_name`, dan `movement_date`, memperluas tipe mutasi (`PENJUALAN`, `RESTOK`, `STOCK_IN`, `ADJUSTMENT_IN`, `ADJUSTMENT_OUT`, `OPNAME`, `STOK_AWAL`), serta mengubah relasi `product_id` menjadi `ON DELETE RESTRICT` agar histori stok tidak pernah terhapus.
   - Menambahkan tabel khusus `stock_receivings` (`RCV-*`), `stock_adjustments` (`ADJ-*`), `stock_opnames` (`OPN-*`), dan `stock_opname_items`.

2. **Kontrol Saldo, Barang Masuk, Penyesuaian & Otorisasi PIN (`server/services/inventoryService.ts`, `StockControlView.tsx`)**:
   - **Saldo & Peringatan Stok**: Klasifikasi status otomatis (`SAFE`, `LOW`, `OUT`, `NEGATIVE`), nilai aset modal/jual, pencarian & filter kategori/status, serta konfigurasi inline batas minimum stok (`PATCH /api/inventory/products/:id/min-stock`).
   - **Barang Masuk (`STOCK_IN`)**: Pencatatan penerimaan barang dari supplier beserta harga modal, opsi perbarui `cost_price` master produk, tanggal terima, referensi faktur, dan mutasi stok atomik.
   - **Penyesuaian Stok (`ADJUSTMENT_IN` / `ADJUSTMENT_OUT`)**: Penambahan/pengurangan stok dengan alasan wajib, pelacakan pemohon & penyetuju, serta penegakan izin `stock:adjust` atau otorisasi PIN Supervisor/Admin (`PIN_REQUIRED`).
   - **Perlindungan Mutasi Langsung**: `PUT /api/products/:id` menolak perubahan field `stock` secara langsung (`400`), dan `DELETE /api/products/:id` menolak penghapusan produk yang memiliki riwayat `stock_movements` atau `transaction_items` (`409`).

3. **Alur Kerja Stok Opname & Kartu Stok Produk (`StockControlView.tsx`, `StockCardModal.tsx`)**:
   - **Stok Opname End-to-End**: Buat Sesi (`DRAFT`) dengan semua produk aktif atau produk terpilih → Input Stok Fisik & catatan per SKU → Hitung Selisih Qty & Dampak Nilai Modal → Ajukan Review (`PENDING_REVIEW`) → Setujui (`APPROVED`, mendukung PIN Supervisor) → Finalisasi (`FINALIZED`) yang menerapkan mutasi `OPNAME` secara transaksional, plus opsi pembatalan (`CANCELLED`).
   - **Kartu Stok & Buku Besar Mutasi**: Modal Kartu Stok per produk (`GET /api/inventory/products/:id/stock-card`) lengkap dengan filter jenis mutasi, rentang tanggal, ringkasan masuk/keluar bersih, serta ekspor CSV.

---

### Phase 07: Camera Barcode Scanner — **COMPLETED**

Fitur yang sudah selesai dan terverifikasi:

1. **Mesin Pemindai Kamera Hibrida & Validasi Barcode (`src/utils/barcodeScanner.ts`)**:
   - **Prioritas Deteksi Native + Fallback ZXing**: Memilih `window.BarcodeDetector` berakselerasi hardware bila didukung browser untuk format aktif, dengan fallback otomatis tanpa gangguan ke `@zxing/browser` (`BrowserMultiFormatReader.decodeFromStream`).
   - **Dukungan Format Ritel & Kontrol QR Kontekstual**: Mendukung `EAN-13`, `EAN-8`, `UPC-A`, `UPC-E`, dan `Code 128` (`Code 39` opsional). Pemindaian `QR Code` bersifat opsional/toggleable (`1D Saja` vs `1D + QR`) sehingga checkout ritel tidak terganggu QR kemasan yang tidak relevan.
   - **Validasi Format & Check Digit GS1**: `validateAndNormalizeBarcode`, `computeGs1CheckDigit`, `expandUpcEToUpcA`, dan `verifyGs1CheckDigit` memeriksa panjang, karakter valid, dan digit pemeriksa GS1 Mod-10 sebelum lookup produk.
   - **Proteksi Duplikat & Debounce**: `DuplicateScanGuard` menerapkan jeda cooldown `1.5 detik` per barcode + kunci *in-flight* selama lookup async berlangsung + tombol manual `Scan Ulang` bila kasir ingin memindai item yang sama secara cepat berturut-turut.

2. **Siklus Hidup Kamera Mobile/Desktop & Pemulihan Izin (`src/components/CameraScanner.tsx`)**:
   - **Preferensi Kamera Belakang di Mobile**: Menginisialisasi stream menggunakan `facingMode: { ideal: 'environment' }` terlebih dahulu, lalu memanggil `enumerateDevices()` setelah izin diberikan sehingga label kamera di iOS Safari dan Android Chrome akurat.
   - **Kontrol Kamera Lengkap**: Tombol `Mulai Kamera` / `Hentikan`, `Putar Kamera` (flip depan/belakang), dropdown pilih kamera, toggle `Lampu` (torch via `track.getCapabilities().torch`), toggle suara `Beep`/`Senyap` + haptic vibrate, dan pelepasan stream otomatis saat menutup pemindai, berpindah tab/layar, atau halaman tersembunyi (`visibilitychange` / `pagehide`).
   - **Alur Barcode Tidak Dikenal & Degradasi Aman**: Menampilkan kartu aksi khusus untuk barcode belum terdaftar (`+ Daftarkan Produk Baru`, input koreksi manual, dan `Coba Scan Lagi`). POS tetap 100% operasional tanpa izin kamera melalui input manual, scanner USB (`F2`), dan pencarian cepat (`F3`).

3. **Integrasi Kontekstual (`CashierView.tsx`, `StockControlView.tsx`, `ProductModals.tsx`)**:
   - **Konteks Kasir (`pos`)**: Pencocokan katalog lokal instan + fallback async ke `GET /api/products/barcode/:code`, otomatis menambah ke keranjang (+1) dengan umpan balik visual kilatan overlay, suara beep, dan status item.
   - **Konteks Penerimaan Barang Masuk (`inventory`)**: Pemindai kamera di tab *Barang Masuk* menampilkan konfirmasi dan memilih produk target ke form receiving tanpa menyentuh keranjang POS.
   - **Konteks Master Barcode (`barcode-field`)**: Pemindai kamera di modal produk mengisi kode barcode dan tipe formatnya langsung ke input barcode produk.

---

### Phase 08: AI Product Recognition — **COMPLETED**

Fitur yang sudah selesai dan terverifikasi:

1. **Arsitektur Provider AI Modular & Dapat Diganti (`server/services/ai/*`)**:
   - Antarmuka `RecognitionProvider` dan `providerRegistry.ts` memisahkan frontend POS sepenuhnya dari logika inferensi AI, mendukung `gemini-vision` (`@google/genai` server-side dengan `gemini-4-hydrogen` + `gemini-embedding-2`), `local-inference` (sidecar lokal `POS_LOCAL_AI_URL`), serta `remote-inference` (layanan HTTP eksternal terkonfigurasi), plus pendaftaran provider kustom secara runtime.
   - Penanganan error & ketidaksediaan jujur: bila API key atau runtime tidak tersedia, endpoint mengembalikan `503 PROVIDER_UNAVAILABLE` dan mencatat `outcome = 'ERROR'` tanpa pernah mengarang nilai keyakinan atau kecocokan palsu.

2. **Pipeline 13 Langkah, Ranking Multi-Sinyal & Indeks Referensi (`server/services/recognitionService.ts`, `007_ai_product_recognition.sql`)**:
   - Pra-pemrosesan gambar di klien (`src/utils/imagePreprocess.ts` melalui `<canvas>`, maks 768px JPEG) sebelum dikirim, dipicu secara manual oleh kasir (tidak pernah menjalankan inferensi per frame).
   - Ekstraksi wilayah produk (`detectedRegion`), teks OCR terstruktur (`productName`, `brand`, `variant`, `flavor`, `weight`, `volume`, `size`, `packagingType`, `productCode`), dan vektor embedding gambar referensi (`product_image_embeddings`).
   - Penilaian kandidat multi-sinyal (`scoreProductCandidate`): menggabungkan kemiripan visual kosinus, kecocokan teks OCR/kode SKU, merek, varian/rasa, normalisasi berat/volume (`1L = 1000ml`, `5kg = 5000g`), jenis kemasan, dan penguatan umpan balik terverifikasi — **tidak pernah hanya mengandalkan warna**.

3. **Alur Kasir, Ambang Batas Keyakinan & Umpan Balik Terverifikasi (`AiRecognitionModal.tsx`, `CashierView.tsx`, `ProductModals.tsx`)**:
   - Klasifikasi keyakinan `HIGH`, `MEDIUM`, `LOW`, `UNKNOWN` yang dapat dikonfigurasi (`recognition_settings`); penambahan otomatis ke keranjang hanya dimungkinkan untuk `HIGH` jika opsi `autoAddHighConfidence` diaktifkan secara eksplisit.
   - Aksi lengkap di modal hasil: `Tambah ke Keranjang`, `Konfirmasi Cocok`, `Pilih Kandidat`, `Foto Ulang`, `Scan Barcode`, `Cari Manual`, dan `Daftarkan Produk` (mengisi otomatis form produk dari OCR & foto tangkapan).
   - Umpan balik terverifikasi (`CONFIRMED`, `CORRECTED`, `REGISTERED_NEW`, `REJECTED`) beserta opsi mempromosikan foto tangkapan sebagai gambar referensi AI produk dan sinkronisasi embedding massal (`POST /api/recognition/references/sync`).

---

### Phase 09: Customer Management, Loyalty Foundation & Promotion Engine — **COMPLETED**

Fitur yang sudah selesai dan terverifikasi:

1. **Migrasi Database Pelanggan, Loyalitas & Promosi (`server/db/migrations/008_customer_promotion.sql`)**:
   - Memperbarui tabel `customers` dengan `membership_number` (`MBR-XXXX`, indeks unik), `loyalty_points`, `total_points_earned`, dan `total_points_redeemed`.
   - Menambahkan tabel `loyalty_settings` (aturan perolehan & penukaran poin) dan buku besar `loyalty_point_transactions` (`EARN`, `REDEEM`, `ADJUST`).
   - Menambahkan tabel `promotions` & `promotion_targets` untuk cakupan `PRODUCT`, `CATEGORY`, `TRANSACTION`, dan `BUNDLE`, serta kebijakan stacking & batas diskon global pada `store_settings` dan snapshot promo/poin pada `transactions` & `transaction_items`.

2. **Manajemen Pelanggan & Fondasi Loyalitas (`server/services/customerService.ts`, `CustomersView.tsx`)**:
   - Pencatatan pelanggan lengkap (`CUST-XXXX`, `MBR-XXXX`, nama, telepon, email, alamat opsional, catatan, status aktif/nonaktif), pencarian & filter status, serta metrik agregat real-time (`totalSpending`, `transactionCount`, `lastPurchaseDate`).
   - Halaman detail pelanggan dengan tab Riwayat Transaksi dan tab Mutasi Poin Loyalitas serta penyesuaian poin manual dengan audit log.
   - Transaksi tamu (`Pelanggan Umum`) tetap didukung penuh tanpa kewajiban memilih pelanggan.

3. **Mesin Promosi BigInt, Stacking Rules & Checkout Kasir (`server/services/promotionService.ts`, `PromotionsView.tsx`, `CashierView.tsx`, `PaymentModal.tsx`, `ReceiptDocument.tsx`)**:
   - Mendukung diskon manual, persentase (`PERCENT` + `maxDiscountAmount`), nominal (`FIXED_AMOUNT`), harga spesial (`SPECIAL_PRICE`), serta arsitektur ekstensi `BUY_X_GET_Y`, `BUNDLE`, dan promosi berbasis kategori (`CATEGORY`) dengan validasi tanggal dan aturan di backend.
   - Penegakan aturan stacking (`allowPromoStacking`, `allowManualWithPromo`, per-promo `stackable`, `priority`) dan batas maksimum diskon terotorisasi (`maxAuthorizedDiscountPercent`) menggunakan aritmetika `BigInt` zero-float.
   - Terintegrasi langsung ke keranjang kasir (pemilihan promo eligible & penukaran poin), ringkasan `PaymentModal`, `TransactionDetailModal`, serta cetak struk historis `ReceiptDocument`.

---

### Phase 10: Shift & Cash Management — **COMPLETED**

Fitur yang sudah selesai dan terverifikasi:

1. **Migrasi Database & RBAC Shift Kasir (`server/db/migrations/011_shift_cash_management.sql`, `server/db/database.ts`)**:
   - Menambahkan tabel `shift_settings` (kebijakan wajib buka shift sebelum penjualan, izin multi-shift terbuka per kasir, kewajiban persetujuan supervisor atas selisih kas, dan toleransi selisih Rp), `cashier_shifts` (`SHF-YYYYMMDD-XXXX`), serta `cash_movements` (`CM-YYYYMMDD-XXXX` untuk `CASH_IN`, `CASH_OUT`, `EXPENSE`, `CASH_REFUND`).
   - Menambahkan kolom `shift_id` pada tabel `transactions` dan memperluas `pin_authorizations` untuk mendukung aksi PIN `shift_discrepancy`.
   - Menambahkan 5 izin granular modul **Shift & Kas** (`shifts:view`, `shifts:open`, `shifts:cash_movement`, `shifts:approve`, `shifts:manage`).

2. **Mesin Rekonsiliasi Kas BigInt & Siklus Hidup Shift (`server/services/shiftService.ts`, `server/services/checkoutService.ts`)**:
   - **Buka Shift & Pencegahan Shift Ganda**: Kasir membuka shift dengan modal awal kas, nama kasir/register, dan catatan pembukaan; sistem mencegah duplikasi shift terbuka per kasir jika `allow_duplicate_open_shifts` bernilai nonaktif (`409 SHIFT_ALREADY_OPEN`).
   - **Mutasi Kas Laci (`Cash Movement`)**: Pencatatan kas masuk, kas keluar, pengeluaran operasional laci, serta refund tunai dengan nominal positif, alasan wajib, referensi dokumen, pelaku, dan stempel waktu.
   - **Rekonsiliasi Otomatis Zero-Float**: Menghitung `expectedCash = openingCash + cashSales + cashInTotal - cashOutTotal - expenseTotal - cashRefunds` serta melacak `cashReceived` (gross diterima kasir), `cashChangeGiven`, `nonCashSales`, breakdown metode pembayaran, dan selisih (`actualCash - expectedCash`).
   - **Tutup Kasir, Pecahan Uang & Persetujuan Selisih**: Penghitung pecahan uang Rupiah (Rp 100 s.d. Rp 100.000) atau input tunai manual, konfirmasi tutup kasir wajib, serta persetujuan selisih baik langsung saat tutup shift dengan PIN Supervisor (`shift_discrepancy`) maupun peninjauan pasca-tutup oleh Supervisor (`PENDING_APPROVAL` → `APPROVED`).

3. **Antarmuka Kasir, Laporan Shift & Audit (`ShiftView.tsx`, `ShiftModals.tsx`, `CashierView.tsx`)**:
   - Status bar shift langsung di terminal kasir lengkap dengan modal Buka Shift instan serta penegakan opsional wajib buka shift sebelum checkout (`SHIFT_REQUIRED`).
   - Halaman khusus **Shift & Kas Kasir** dengan 3 sub-tab (`Shift Aktif & Mutasi Kas`, `Riwayat & Laporan Shift`, `Konfigurasi Shift`), ekspor CSV riwayat shift, serta modal Laporan Shift siap cetak (`@media print`).

---

### Phase 11: Return, Refund & Void — **COMPLETED**

Fitur yang sudah selesai dan terverifikasi:

1. **Migrasi Database & Pelacakan Arsip Historis (`server/db/migrations/012_return_refund_void.sql`)**:
   - Memperluas tabel `transactions` dengan status `'VOIDED'`, `payment_status` (`'PARTIALLY_REFUNDED'`, `'REFUNDED'`), `return_status` (`'NONE'`, `'PARTIAL'`, `'FULL'`), `returned_total`, `refunded_total`, serta jejak `void_number`, `void_reason`, `voided_at`, `voided_by_*`, dan `void_approved_by_*`.
   - Memperluas `stock_movements` untuk tipe mutasi `RETURN_IN` dan `VOID_IN` serta menambahkan tabel `transaction_returns` (`RET-YYYYMMDD-XXXX`), `transaction_return_items`, `transaction_voids` (`VOID-YYYYMMDD-XXXX`), dan `refund_records` (`RFD-YYYYMMDD-XXXX`).

2. **Mesin Retur, Disposisi Stok QC, Refund & Void Zero-Float (`server/services/returnVoidService.ts`)**:
   - **Pencarian Struk & Kalkulasi Proporsional `BigInt`**: Pencarian transaksi berdasarkan nomor struk (`receipt_number`), nomor invoice, pelanggan, atau nama produk; pratinjau kalkulasi retur menggunakan harga historis transaksi dan alokasi proporsional `allocateProportionally` sehingga total refund bertahap sama persis dengan total transaksi asli.
   - **Perlindungan Data & Idempotensi**: Melarang retur melebihi sisa kuantitas terjual, melarang duplikasi melalui `idempotency_key`, memvalidasi batas maksimum refund, serta **tidak pernah menghapus transaksi selesai** (`DELETE` pada `COMPLETED` maupun `VOIDED` ditolak `409 Conflict`).
   - **Disposisi Stok & Inspeksi QC**: Mendukung `SELLABLE` (restok otomatis via `RETURN_IN`), `DAMAGED`, `UNSELLABLE`, dan `PENDING_INSPECTION` (tidak menambah stok jual sampai keputusan QC selesai melalui `/api/returns/items/:itemId/resolve-inspection`).
   - **Refund Tunai & Non-Tunai + Integrasi Shift & Loyalitas**: Refund tunai otomatis mencatat mutasi `CASH_REFUND` pada shift aktif kasir; void pada shift yang masih `OPEN` tidak mengurangi kas laci dua kali dan mengembalikan stok (`VOID_IN`) serta poin loyalitas secara konsisten.
   - **RBAC & Otorisasi PIN Supervisor**: Membutuhkan izin `pos:refund` / `pos:void` atau verifikasi PIN single-use Supervisor/Admin (`action: 'refund' | 'void'`) dengan pencatatan lengkap ke `audit_logs`.

3. **Antarmuka Retur, Refund, Void & Struk Historis (`ReturnVoidView.tsx`, `ReturnVoidModals.tsx`, `TransactionsView.tsx`, `TransactionDetailModal.tsx`, `ReceiptDocument.tsx`)**:
   - Halaman khusus **Retur, Refund & Void** dengan 4 ringkasan KPI dan 4 sub-tab (`Cari & Proses Retur / Void`, `Riwayat Retur & QC`, `Buku Refund`, `Riwayat Void`) serta shortcut langsung dari *Riwayat Transaksi* dan *Detail Transaksi*.
   - Penandaan visual status `DI-VOID` / `Retur Tercatat` pada riwayat transaksi, detail transaksi, dan struk cetak tanpa mengubah nilai nominal historis struk asli.

---

## Keterbatasan & Ruang Lingkup Fase Berikutnya (Phase 12+)

1. **Komunikasi Hardware Printer Thermal Langsung (ESC/POS USB / Bluetooth / Serial)**:
   - Pencetakan fisik saat ini menggunakan dialog cetak sistem/browser (`window.print()` dengan CSS `@media print` untuk `58mm`, `80mm`, dan `A4`) serta ekspor struk digital HTML.
2. **Laporan Analitik & Eksekutif Lanjutan (Phase 12)**:
   - Dashboard analitik multi-periode, laporan margin produk/kategori mendalam, dan ringkasan pajak periode dijadwalkan pada fase berikutnya.

---

## Riwayat Pengujian Terakhir

- `npm run lint` (`tsc --noEmit` dengan `strict: true`): Lulus tanpa error.
- `npm run build` (`vite build`): Kompilasi bundle produksi berhasil.
- `npm test` (`tsx --test tests/pos.test.ts`): Seluruh skenario unit & integrasi (Phase 02–Phase 11) lulus.
