# API Reference — KassaRitel POS

Semua endpoint berada di bawah prefix `/api`. Kecuali ditandai sebagai **Publik**, seluruh endpoint mewajibkan autentikasi menggunakan cookie `HttpOnly` (`kassa_access_token`) atau header `Authorization: Bearer <accessToken>` serta otorisasi izin RBAC di backend.

---

## 1. Health & Static Assets

| Method | Endpoint | Akses | Deskripsi |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Publik | Health check status server (`{ ok: true }`). |
| `GET` | `/api/uploads/products/:fileName` | Publik (file valid) | Mengirim gambar produk yang tersimpan di disk (`POS_UPLOADS_DIR`) dengan perlindungan path traversal. |
| `GET` | `/api/uploads/store/:fileName` | Publik (file valid) | Mengirim logo toko untuk struk yang tersimpan di disk (`POS_STORE_UPLOADS_DIR`) dengan perlindungan path traversal. |
| `GET` | `/api/receipts/public/:id` | Publik (Token QR valid) | Mengambil struk digital resmi menggunakan query `?token=<verificationToken>` (validasi `timingSafeEqual`; `403` jika token tidak cocok, `409` jika transaksi belum `COMPLETED`). |

---

## 2. Autentikasi, PIN & Manajemen Sesi

| Method | Endpoint | Izin / Akses | Deskripsi & Payload |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/login` | Publik | Body: `{ identifier, password }`. Mengembalikan `{ user, sessionId, expiresAt, accessToken, refreshToken }` + set cookie `HttpOnly`. |
| `POST` | `/api/auth/refresh` | Publik (Refresh Token) | Body opsional `{ refreshToken }` atau cookie refresh. Melakukan rotasi access & refresh token. |
| `POST` | `/api/auth/logout` | Publik / Auth | Mencabut sesi aktif & membersihkan cookie autentikasi. |
| `GET` | `/api/auth/me` | Authenticated | Mengembalikan profil & izin aktif `{ user, sessionId }`. |
| `POST` | `/api/auth/change-password` | Authenticated | Body: `{ currentPassword, newPassword }`. |
| `POST` | `/api/auth/verify-pin` | Authenticated | Body: `{ authorizerIdentifier, pin, action, reason? }`. Mengembalikan token single-use `pinApprovalToken` (berlaku 5 menit) untuk `discount_approval`, `price_override`, `void`, `refund`, atau `stock_adjustment`. |
| `GET` | `/api/sessions` | Authenticated (`sessions:view` untuk semua) | Daftar sesi aktif & riwayat login. Pengguna non-admin hanya melihat sesi miliknya. |
| `DELETE` | `/api/sessions/:id` | `sessions:revoke` atau pemilik sesi | Memutus sesi aktif secara paksa. |

---

## 3. Pengguna, Role, Permission & Audit Log

| Method | Endpoint | Izin | Deskripsi |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/users` | `users:view` | Daftar pengguna beserta daftar role. |
| `GET` | `/api/users/:id` | `users:view` atau diri sendiri | Detail profil pengguna & role. |
| `POST` | `/api/users` | `users:create` | Membuat pengguna baru `{ username, email, fullName, password, pin?, roleIds }`. |
| `PUT` | `/api/users/:id` | `users:edit` | Memperbarui data pengguna & penugasan role. |
| `PATCH` | `/api/users/:id/status` | `users:edit` | Aktivasi/nonaktifkan pengguna `{ isActive: boolean }` (mencabut semua sesi saat dinonaktifkan). |
| `POST` | `/api/users/:id/reset-password` | `users:edit` | Reset kata sandi dan/atau PIN pengguna `{ newPassword?, newPin? }`. |
| `GET` | `/api/roles` | `roles:view` | Daftar role dan daftar kode izin yang dimiliki. |
| `GET` | `/api/permissions` | `roles:view` | Daftar seluruh permission granular per modul. |
| `POST` | `/api/roles` | `roles:edit` | Membuat role kustom baru `{ name, description, permissionCodes }`. |
| `PUT` | `/api/roles/:id` | `roles:edit` | Memperbarui nama, deskripsi, dan daftar izin role. |
| `PUT` | `/api/roles/:id/permissions` | `roles:edit` | Memperbarui matriks izin role. |
| `DELETE` | `/api/roles/:id` | `roles:edit` | Menghapus role non-sistem. |
| `GET` | `/api/audit-logs` | `audit:view` | Riwayat lengkap audit log sistem. |

---

## 4. Product Master, Multi-Barcode & Gambar Produk (Phase 03)

| Method | Endpoint | Izin | Deskripsi & Parameter |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/products` | `products:view` / `pos:view` | Daftar produk dengan pagination, search, filter & sort. |
| `GET` | `/api/products/barcode/:code` | `products:view` / `pos:view` | Pencarian produk berdasarkan primary barcode maupun secondary barcode. |
| `GET` | `/api/products/:id` | `products:view` / `pos:view` | Detail lengkap produk beserta `barcodes[]` dan `images[]`. |
| `POST` | `/api/products` | `products:create` | Membuat produk baru. Mencegah duplikasi SKU & barcode (`409`). |
| `PUT` | `/api/products/:id` | `products:edit` | Memperbarui data master produk & sinkronisasi daftar barcode. |
| `PATCH` | `/api/products/:id/status` | `products:edit` | Aktivasi/nonaktifkan produk `{ status: 'ACTIVE' \| 'INACTIVE' }`. |
| `DELETE` | `/api/products/:id` | `products:delete` | Menghapus produk beserta relasi barcode, gambar, dan mutasi stok. |
| `POST` | `/api/products/:id/barcodes` | `products:edit` | Menambah barcode tambahan `{ barcode, barcodeType, isPrimary }`. |
| `PATCH` | `/api/products/:id/barcodes/:barcodeId/primary` | `products:edit` | Menjadikan salah satu barcode sebagai barcode utama. |
| `DELETE` | `/api/products/:id/barcodes/:barcodeId` | `products:edit` | Menghapus barcode sekunder (minimal 1 barcode tersisa wajib dipertahankan). |
| `POST` | `/api/products/:id/images` | `products:edit` | Mengunggah gambar produk (JPG/PNG/WEBP, maks 3 MB, validasi magic bytes). |
| `PATCH` | `/api/products/:id/images/:imageId` | `products:edit` | Mengubah gambar utama (`isPrimary`), referensi AI (`isAiReference`), atau sudut referensi (`referenceAngle`). |
| `DELETE` | `/api/products/:id/images/:imageId` | `products:edit` | Menghapus metadata gambar dan file fisiknya dari disk. |
| `POST` | `/api/products/import/preview` | `products:import` / `products:create` | Pratinjau & validasi CSV sebelum impor `{ rows }`. |
| `POST` | `/api/products/import/commit` | `products:import` / `products:create` | Commit impor baris valid secara atomik. |
| `GET` | `/api/products/export/csv` | `products:view` | Mengunduh katalog produk terfilter sebagai CSV (`UTF-8 BOM`). |

---

## 5. Kategori, Merek & Satuan (UOM) (Phase 03)

| Method | Endpoint | Izin | Deskripsi |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/categories` | `products:view` / `pos:view` / `catalog:manage` | Daftar kategori & subkategori. |
| `POST` | `/api/categories` | `catalog:manage` / `products:create` | Membuat kategori induk / subkategori. |
| `PUT` | `/api/categories/:id` | `catalog:manage` / `products:edit` | Memperbarui kategori. |
| `PATCH` | `/api/categories/:id/status` | `catalog:manage` / `products:edit` | Toggle `isActive` kategori. |
| `GET` | `/api/brands` | `products:view` / `pos:view` / `catalog:manage` | Daftar merek produk. |
| `POST` | `/api/brands` | `catalog:manage` / `products:create` | Menambah merek baru. |
| `PUT` | `/api/brands/:id` | `catalog:manage` / `products:edit` | Mengubah merek. |
| `PATCH` | `/api/brands/:id/status` | `catalog:manage` / `products:edit` | Toggle `isActive` merek. |
| `GET` | `/api/uoms` | `products:view` / `pos:view` / `catalog:manage` | Daftar satuan UOM. |
| `POST` | `/api/uoms` | `catalog:manage` / `products:create` | Menambah satuan UOM kustom. |
| `PUT` | `/api/uoms/:id` | `catalog:manage` / `products:edit` | Mengubah satuan UOM. |
| `PATCH` | `/api/uoms/:id/status` | `catalog:manage` / `products:edit` | Toggle `isActive` satuan UOM. |

---

## 6. POS Core, Checkout, Hold/Resume, Pelanggan & Metode Pembayaran (Phase 04)

| Method | Endpoint | Izin | Deskripsi & Payload |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/customers` | `pos:view` / `transactions:view` | Daftar pelanggan (`?search=`). |
| `POST` | `/api/customers` | `pos:create` / `pos:view` | Menambah pelanggan baru `{ name, phone?, email?, address?, notes? }` dengan kode otomatis `CUST-XXXX`. |
| `GET` | `/api/payment-methods` | `pos:view` / `transactions:view` / `settings:edit` | Daftar metode pembayaran (`?includeInactive=true`). Default: `Tunai`, `Kartu Debit`, `Kartu Kredit`, `QRIS`, `Transfer Bank`. |
| `POST` | `/api/payment-methods` | `settings:edit` | Menambah metode pembayaran kustom `{ name, code?, type, requiresReference? }`. |
| `PATCH` | `/api/payment-methods/:id/status` | `settings:edit` | Mengaktifkan/menonaktifkan metode pembayaran `{ isActive: boolean }` (`Tunai` bawaan tidak dapat dinonaktifkan). |
| `POST` | `/api/pos/calculate` | `pos:view` / `pos:create` | Menghitung total keranjang secara otoritatif di server menggunakan aritmetika `BigInt` (zero float): `{ items: [{ productId, qty, overrideUnitPrice?, lineDiscountType?, lineDiscountValue? }], transactionDiscountType?, transactionDiscountValue?, applyTax? }`. |
| `GET` | `/api/transactions` | `transactions:view` / `pos:view` | Daftar transaksi terpaginasi dengan filter `search`, `status`, `paymentStatus`, `paymentMethod`, `dateFrom`, `dateTo`, `page`, `pageSize`. |
| `GET` | `/api/transactions/held` | `pos:view` / `pos:hold` / `pos:resume` | Daftar transaksi berstatus `HELD`. |
| `GET` | `/api/transactions/:id` | `transactions:view` / `pos:view` | Detail lengkap transaksi (item, diskon baris, override harga, rincian `payments[]`, catatan, pelanggan). |
| `POST` | `/api/transactions/hold` | `pos:hold` | Menahan/memperbarui draft keranjang menjadi `HELD` (`HOLD-YYYYMMDD-XXXX`) tanpa memotong stok. |
| `POST` | `/api/transactions/:id/resume` | `pos:resume` | Mengubah status transaksi `HELD` menjadi `IN_PROGRESS` untuk dilanjutkan di kasir. |
| `POST` | `/api/transactions/:id/cancel` | `pos:cancel` | Membatalkan transaksi `HELD`/`IN_PROGRESS` menjadi `CANCELLED` `{ reason? }`. Menolak `COMPLETED` (`409`). |
| `DELETE` | `/api/transactions/:id` | `pos:cancel` | Membatalkan draft/hold; **selalu menolak** transaksi `COMPLETED` dengan `409 Conflict` (tidak boleh dihapus secara fisik). |
| `POST` | `/api/transactions` | `pos:create` (+ `pos:discount_approve` / `pos:price_override` atau token PIN) | Checkout atomik 14 langkah dengan dukungan `idempotencyKey` (`201` saat dibuat baru, `200` + `idempotentReplay: true` jika kunci sama dikirim ulang), single payment atau `payments[]` split/multi-metode, pemotongan stok, `stock_movements`, capture `receipt_snapshots`, dan audit log. |

---

## 7. Struk, Cetak Ulang & Struk Digital (Phase 05)

| Method | Endpoint | Izin | Deskripsi & Payload |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/transactions/:id/receipt` | `transactions:view` / `pos:view` / `pos:create` | Mengambil arsip struk historis (`transaction`, `snapshot` toko yang dibekukan saat checkout, `printLogs[]`, `qrPayload`, `digitalReceiptPath`). Menolak transaksi belum `COMPLETED` (`409`). |
| `POST` | `/api/transactions/:id/receipt/print` | `transactions:view` / `pos:create` | Mencatat aksi cetak (`ORIGINAL`) atau cetak ulang (`REPRINT`, menambah `printCount` & menyimpan `receipt_print_logs` + `audit_logs`) untuk `{ layoutFormat: '58mm' \| '80mm' \| 'A4' \| 'DIGITAL', driverId }`. Tidak membuat transaksi baru. |

---

## 8. Operasional Stok, Bootstrap & Pengaturan Toko & Logo

| Method | Endpoint | Izin | Deskripsi |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/bootstrap` | Authenticated | Mengambil seluruh data awal dashboard (`products`, `categories`, `brands`, `uoms`, `customers`, `paymentMethods`, `heldTransactions`, `transactions`, `stockMovements`, `settings`, `auditLogs`). |
| `POST` | `/api/stock/adjust` | `stock:adjust` atau `pinApprovalToken` (`stock_adjustment`) | Penyesuaian restok masuk (`RESTOK`) atau stok opname (`OPNAME`). |
| `PUT` | `/api/settings` | `settings:edit` | Memperbarui nama toko, alamat, telepon, PPN, `receiptPaperWidth` (`58mm`/`80mm`/`A4`), `receiptShowLogo`, `receiptShowQr`, `receiptHeaderNote`, dan `receiptFooter`. |
| `POST` | `/api/settings/logo` | `settings:edit` | Mengunggah logo toko (`PNG`/`JPG`/`WEBP`, maks 2 MB, validasi magic bytes) untuk dicetak pada struk. |
| `DELETE` | `/api/settings/logo` | `settings:edit` | Menghapus logo toko dari pengaturan aktif (snapshot transaksi lama tetap terjaga). |

