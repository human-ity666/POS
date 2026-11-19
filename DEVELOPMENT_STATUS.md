# Development Status — KassaRitel POS

Terakhir diperbarui: 2026-11-18

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

## Keterbatasan & Ruang Lingkup Fase Berikutnya (Phase 06+)

1. **Komunikasi Hardware Printer Thermal Langsung (ESC/POS USB / Bluetooth / Serial)**:
   - Pencetakan fisik saat ini menggunakan dialog cetak sistem/browser (`window.print()` dengan CSS `@media print` untuk `58mm`, `80mm`, dan `A4`) serta ekspor struk digital HTML. Komunikasi byte mentah ESC/POS langsung ke perangkat keras USB/Bluetooth/Serial (`WebUSB`/`WebSerial`/agent lokal) belum diimplementasikan dan tidak diklaim aktif.
2. **Void & Refund Transaksi Selesai**:
   - Transaksi berstatus `COMPLETED` dilindungi agar tidak dapat dihapus fisik; alur Void/Retur resmi dengan otorisasi PIN dijadwalkan pada fase berikutnya.
3. **Shift Kasir & Tutup Kasir (Cash Drawer / Z-Report)**:
   - Buka/tutup shift kasir dan rekonsiliasi selisih kas laci dijadwalkan pada fase berikutnya.

---

## Riwayat Pengujian Terakhir

- `npm run lint` (`tsc --noEmit` dengan `strict: true`): Lulus tanpa error.
- `npm run build` (`vite build`): Kompilasi bundle produksi berhasil.
- `npm test` (`tsx --test tests/pos.test.ts`): Seluruh **18 skenario integrasi** (Phase 02, Phase 03, Phase 04, & Phase 05) lulus (`pass 18, fail 0`).
