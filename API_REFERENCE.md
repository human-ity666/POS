# API Reference — KassaRitel POS

Semua endpoint berada di bawah prefix `/api`. Kecuali ditandai sebagai **Publik**, seluruh endpoint mewajibkan autentikasi menggunakan cookie `HttpOnly` (`kassa_access_token`) atau header `Authorization: Bearer <accessToken>` serta otorisasi izin RBAC di backend.

---

## 1. Health & Static Assets

| Method | Endpoint | Akses | Deskripsi |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Publik | Health check status server (`{ ok: true }`). |
| `GET` | `/api/uploads/products/:fileName` | Publik (file valid) | Mengirim gambar produk yang tersimpan di disk (`POS_UPLOADS_DIR`) dengan perlindungan path traversal. |
| `GET` | `/api/uploads/store/:fileName` | Publik (file valid) | Mengirim logo toko untuk struk yang tersimpan di disk (`POS_STORE_UPLOADS_DIR`) dengan perlindungan path traversal. |
| `GET` | `/api/uploads/recognition/:fileName` | Publik (file valid) | Mengirim gambar tangkapan identifikasi AI (`POS_RECOGNITION_UPLOADS_DIR`) dengan perlindungan path traversal. |
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
| `POST` | `/api/auth/verify-pin` | Authenticated | Body: `{ authorizerIdentifier, pin, action, reason? }`. Mengembalikan token single-use `pinApprovalToken` (berlaku 5 menit) untuk `discount_approval`, `price_override`, `void`, `refund`, `stock_adjustment`, `item_cancel`, atau `shift_discrepancy`. |
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
| `POST` | `/api/pos/calculate` | `pos:view` / `pos:create` | Menghitung total keranjang secara otoritatif di server menggunakan aritmetika `BigInt` (zero float): `{ customerId?, items: [{ productId, qty, overrideUnitPrice?, lineDiscountType?, lineDiscountValue? }], transactionDiscountType?, transactionDiscountValue?, selectedPromotionIds?, loyaltyPointsToRedeem?, applyTax? }`. Mengembalikan subtotal, diskon baris, diskon promosi per baris & transaksi, potongan poin loyalitas, estimasi poin didapat, daftar `eligiblePromotions[]`, pajak PPN, dan grand total. |
| `GET` | `/api/transactions` | `transactions:view` / `pos:view` | Daftar transaksi terpaginasi dengan filter `search`, `status`, `paymentStatus`, `paymentMethod`, `dateFrom`, `dateTo`, `page`, `pageSize`. |
| `GET` | `/api/transactions/held` | `pos:view` / `pos:hold` / `pos:resume` | Daftar transaksi berstatus `HELD`. |
| `GET` | `/api/transactions/:id` | `transactions:view` / `pos:view` | Detail lengkap transaksi (item, diskon baris/promo, override harga, rincian `payments[]`, poin loyalitas, catatan, pelanggan). |
| `POST` | `/api/transactions/hold` | `pos:hold` | Menahan/memperbarui draft keranjang menjadi `HELD` (`HOLD-YYYYMMDD-XXXX`) tanpa memotong stok atau poin. |
| `POST` | `/api/transactions/:id/resume` | `pos:resume` | Mengubah status transaksi `HELD` menjadi `IN_PROGRESS` untuk dilanjutkan di kasir. |
| `POST` | `/api/transactions/:id/cancel` | `pos:cancel` | Membatalkan transaksi `HELD`/`IN_PROGRESS` menjadi `CANCELLED` `{ reason? }`. Menolak `COMPLETED` (`409`). |
| `DELETE` | `/api/transactions/:id` | `pos:cancel` | Membatalkan draft/hold; **selalu menolak** transaksi `COMPLETED` dengan `409 Conflict` (tidak boleh dihapus secara fisik). |
| `POST` | `/api/transactions` | `pos:create` (+ `pos:discount_approve` / `pos:price_override` atau token PIN) | Checkout atomik dengan dukungan `idempotencyKey` (`201` saat dibuat baru, `200` + `idempotentReplay: true` jika kunci sama dikirim ulang), single/split payment, evaluasi & pencatatan pemakaian promosi (`selectedPromotionIds`), penukaran & perolehan poin loyalitas (`loyaltyPointsToRedeem`), pemotongan stok, `stock_movements`, capture `receipt_snapshots`, dan audit log. |

---

## 7. Struk, Cetak Ulang & Struk Digital (Phase 05)

| Method | Endpoint | Izin | Deskripsi & Payload |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/transactions/:id/receipt` | `transactions:view` / `pos:view` / `pos:create` | Mengambil arsip struk historis (`transaction`, `snapshot` toko yang dibekukan saat checkout, `printLogs[]`, `qrPayload`, `digitalReceiptPath`). Menolak transaksi belum `COMPLETED` (`409`). |
| `POST` | `/api/transactions/:id/receipt/print` | `transactions:view` / `pos:create` | Mencatat aksi cetak (`ORIGINAL`) atau cetak ulang (`REPRINT`, menambah `printCount` & menyimpan `receipt_print_logs` + `audit_logs`) untuk `{ layoutFormat: '58mm' \| '80mm' \| 'A4' \| 'DIGITAL', driverId }`. Tidak membuat transaksi baru. |

---

## 8. Kontrol Stok, Barang Masuk, Penyesuaian, Stok Opname & Kartu Stok (Phase 06)

| Method | Endpoint | Izin | Deskripsi & Payload |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/inventory/stock-balance` | `stock:view` / `reports:view` / `products:view` | Daftar saldo stok per produk beserta `summary` (`totalSku`, `totalUnits`, `safeCount`, `lowCount`, `outCount`, `negativeCount`, `totalCostValue`, `totalRetailValue`, `allowNegativeStock`). Query: `search`, `stockStatus` (`ALL`, `LOW_OR_OUT`, `LOW`, `OUT`, `NEGATIVE`, `SAFE`), `categoryId`, `productStatus`, `page`, `pageSize`. |
| `PATCH` | `/api/inventory/products/:id/min-stock` | `stock:adjust` / `products:edit` | Memperbarui batas minimum stok `{ minStock }` dan mencatat audit log `MIN_STOCK_UPDATED`. |
| `GET` | `/api/inventory/products/:id/stock-card` | `stock:view` / `reports:view` / `products:view` | Kartu stok produk beserta saldo terkini, ringkasan masuk/keluar, dan daftar mutasi terfilter (`type`, `dateFrom`, `dateTo`). |
| `GET` | `/api/inventory/movements` | `stock:view` / `reports:view` | Buku besar mutasi stok (`productId`, `type`, `search`, `dateFrom`, `dateTo`, `limit`). Tidak ada endpoint `DELETE` agar histori stok tetap permanen. |
| `GET` | `/api/inventory/stock-in` | `stock:view` / `reports:view` | Riwayat penerimaan barang masuk (`search`, `productId`, `dateFrom`, `dateTo`, `limit`). |
| `POST` | `/api/inventory/stock-in` | `stock:adjust` atau `pinApprovalToken` (`stock_adjustment`) | Mencatat penerimaan barang masuk atomik `{ productId, qty, costPrice?, updateProductCost?, referenceNumber?, receivedAt?, notes?, pinApprovalToken? }` dan mutasi `STOCK_IN`. |
| `GET` | `/api/inventory/adjustments` | `stock:view` / `reports:view` | Riwayat penyesuaian stok (`search`, `productId`, `direction`, `limit`). |
| `POST` | `/api/inventory/adjustments` | `stock:adjust` atau `pinApprovalToken` (`stock_adjustment`) | Penyesuaian stok atomik `{ productId, direction: 'INCREASE' \| 'DECREASE', qty, reason, notes?, referenceNumber?, pinApprovalToken? }` (mematuhi kebijakan `allowNegativeStock`). |
| `GET` | `/api/inventory/opnames` | `stock:view` / `reports:view` | Daftar sesi stok opname (`?status=`). |
| `GET` | `/api/inventory/opnames/:id` | `stock:view` / `reports:view` | Detail sesi opname beserta seluruh baris item (`systemStock`, `physicalStock`, `variance`, `varianceValue`). |
| `POST` | `/api/inventory/opnames` | `stock:adjust` | Membuat sesi stok opname baru (`DRAFT`) untuk semua produk aktif atau `productIds[]` tertentu `{ title?, notes?, productIds?, includeInactive? }`. |
| `PUT` | `/api/inventory/opnames/:id/counts` | `stock:adjust` | Memperbarui stok fisik per item `{ items: [{ productId, physicalStock, notes? }], addProductIds?, removeProductIds?, submitForReview? }` dan menghitung selisih otomatis. |
| `POST` | `/api/inventory/opnames/:id/approve` | `stock:adjust` atau `pinApprovalToken` (`stock_adjustment`) | Menyetujui hasil stok opname (`APPROVED`) sebelum finalisasi saldo stok. |
| `POST` | `/api/inventory/opnames/:id/finalize` | `stock:adjust` | Memfinalisasi sesi `APPROVED`, memperbarui `products.stock` secara atomik, dan menulis mutasi `OPNAME`. |
| `POST` | `/api/inventory/opnames/:id/cancel` | `stock:adjust` | Membatalkan sesi opname yang belum difinalisasi `{ reason? }` tanpa mengubah saldo stok. |

---

## 9. Operasional Cepat, Bootstrap & Pengaturan Toko

| Method | Endpoint | Izin | Deskripsi |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/bootstrap` | Authenticated | Mengambil seluruh data awal dashboard (`products`, `categories`, `brands`, `uoms`, `customers`, `promotions`, `loyaltySettings`, `paymentMethods`, `heldTransactions`, `transactions`, `stockMovements`, `settings`, `auditLogs`, `currentShift`, `shiftSettings`). |
| `POST` | `/api/stock/adjust` | `stock:adjust` atau `pinApprovalToken` (`stock_adjustment`) | Penyesuaian restok masuk (`RESTOK`/`STOCK_IN`) atau stok opname (`OPNAME`) cepat. |
| `PUT` | `/api/settings` | `settings:edit` | Memperbarui profil toko, PPN, `allowNegativeStock`, konfigurasi struk, serta kebijakan diskon & promo (`allowPromoStacking`, `allowManualWithPromo`, `maxCashierDiscountPercent`, `maxAuthorizedDiscountPercent`). |
| `POST` | `/api/settings/logo` | `settings:edit` | Mengunggah logo toko (`PNG`/`JPG`/`WEBP`, maks 2 MB, validasi magic bytes) untuk dicetak pada struk. |
| `DELETE` | `/api/settings/logo` | `settings:edit` | Menghapus logo toko dari pengaturan aktif (snapshot transaksi lama tetap terjaga). |

---

## 10. Pengenalan Produk AI (Phase 08)

| Method | Endpoint | Izin | Deskripsi & Payload |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/recognition/providers` | `recognition:use` / `recognition:manage` / `pos:view` / `products:view` | Mengembalikan daftar provider AI terdaftar (`gemini-vision`, `local-inference`, `remote-inference`) beserta status ketersediaan jujur dan `settings` aktif. |
| `GET` | `/api/recognition/settings` | `recognition:use` / `recognition:manage` / `pos:view` / `settings:edit` | Mengambil konfigurasi ambang batas keyakinan (`HIGH`/`MEDIUM`/`LOW`), opsi `autoAddHighConfidence`, `activeProviderId`, `remoteEndpointUrl`, dan `requestTimeoutMs`. |
| `PUT` | `/api/recognition/settings` | `recognition:manage` / `settings:edit` | Memperbarui provider AI, batas keyakinan (`0 < low < medium < high <= 1`), `autoAddHighConfidence`, dan batas timeout (`3000–60000 ms`). |
| `POST` | `/api/recognition/identify` | `recognition:use` / `pos:view` / `products:view` / `stock:view` | Menjalankan pipeline 13 langkah identifikasi produk dari gambar terkompresi (`dataBase64`, `mimeType`, `width?`, `height?`, `context?`). Mengembalikan OCR, region produk, skor multi-sinyal, kandidat terurut, dan `confidenceBand` (atau `503 PROVIDER_UNAVAILABLE` tanpa hasil palsu jika provider belum siap). |
| `POST` | `/api/recognition/references/sync` | `recognition:manage` / `products:edit` / `catalog:manage` | Menghitung dan menyimpan vektor embedding (`product_image_embeddings`) untuk gambar referensi AI produk, serta memperbarui `ai_embedding_status = 'READY'`. |
| `POST` | `/api/recognition/logs/:id/feedback` | `recognition:use` / `pos:view` / `products:view` / `stock:view` | Mencatat umpan balik kasir (`CONFIRMED`, `CORRECTED`, `REGISTERED_NEW`, `REJECTED`) beserta opsi `promoteAsReferenceImage` untuk menambah gambar terverifikasi ke referensi produk. |
| `GET` | `/api/recognition/logs` | `recognition:use` / `recognition:manage` / `audit:view` / `pos:view` | Mengambil riwayat pengenalan AI dan hasil verifikasi kasir (`?outcome=&limit=`). |

---

## 11. Manajemen Pelanggan, Loyalitas Member & Promosi (Phase 09)

| Method | Endpoint | Izin | Deskripsi & Payload |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/customers` | `customers:view` / `pos:view` / `transactions:view` | Daftar pelanggan lengkap dengan metrik agregat (`totalSpending`, `transactionCount`, `lastPurchaseDate`, `membershipNumber`, `loyaltyPoints`). Query: `?search=&status=`. |
| `GET` | `/api/customers/:id` | `customers:view` / `pos:view` / `transactions:view` | Detail pelanggan beserta `transactions[]` (riwayat transaksi) dan `loyaltyHistory[]` (mutasi poin `EARN`/`REDEEM`/`ADJUST`). |
| `POST` | `/api/customers` | `customers:create` / `pos:create` / `pos:view` | Membuat pelanggan baru `{ name, membershipNumber?, phone?, email?, address?, notes?, isActive? }`. Kode `CUST-XXXX` & nomor member `MBR-XXXX` dibuat otomatis bila kosong; menolak duplikat `membershipNumber` (`409`). |
| `PUT` | `/api/customers/:id` | `customers:edit` | Memperbarui profil dan nomor member pelanggan. |
| `PATCH` | `/api/customers/:id/status` | `customers:edit` | Mengubah status pelanggan `{ isActive: boolean }` (`CUSTOMER_STATUS_CHANGED`). |
| `POST` | `/api/customers/:id/loyalty/adjust` | `customers:edit` | Penyesuaian saldo poin loyalitas manual `{ pointsDelta, notes? }` dengan validasi saldo non-negatif dan pencatatan mutasi `ADJUST`. |
| `GET` | `/api/loyalty/settings` | `pos:view` / `customers:view` / `promotions:view` / `promotions:manage` / `settings:edit` | Mengambil konfigurasi program loyalitas (`enabled`, `pointsPerAmount`, `pointValueRp`, `minRedeemPoints`, `maxRedeemPercent`). |
| `PUT` | `/api/loyalty/settings` | `promotions:manage` / `settings:edit` | Memperbarui aturan dasar perolehan & penukaran poin loyalitas. |
| `GET` | `/api/promotions` | `promotions:view` / `promotions:manage` / `pos:view` | Daftar promosi dengan status efektif terhitung (`ACTIVE`, `SCHEDULED`, `EXPIRED`, `INACTIVE`). Query: `?search=&status=&scope=&activeOnly=true`. |
| `POST` | `/api/promotions/evaluate` | `pos:view` / `pos:create` | Mengevaluasi kelayakan promosi & pratinjau diskon `BigInt` untuk keranjang tanpa menyimpan transaksi. |
| `GET` | `/api/promotions/:id` | `promotions:view` / `promotions:manage` / `pos:view` | Detail aturan, target produk/kategori, dan statistik pemakaian promosi. |
| `POST` | `/api/promotions` | `promotions:manage` | Membuat promosi baru `{ code?, name, description?, promoType: 'PERCENT'\|'FIXED_AMOUNT'\|'SPECIAL_PRICE'\|'BUY_X_GET_Y'\|'BUNDLE', scope: 'PRODUCT'\|'CATEGORY'\|'TRANSACTION'\|'BUNDLE', discountValue, maxDiscountAmount?, minPurchaseAmount?, minQty?, startDate, endDate, status?, stackable?, priority?, ruleConfig?, targets? }`. |
| `PUT` | `/api/promotions/:id` | `promotions:manage` | Memperbarui aturan, periode, dan daftar target promosi. |
| `PATCH` | `/api/promotions/:id/status` | `promotions:manage` | Mengaktifkan atau menonaktifkan promosi `{ status: 'ACTIVE' \| 'INACTIVE' }`. |

---

## 12. Manajemen Shift & Kas Kasir (Phase 10)

| Method | Endpoint | Izin | Deskripsi & Payload |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/shifts/settings` | `shifts:view` / `shifts:open` / `shifts:manage` / `pos:view` / `settings:edit` | Mengambil konfigurasi kebijakan shift (`requireOpenShiftForSales`, `allowDuplicateOpenShifts`, `requireSupervisorApprovalOnDiscrepancy`, `discrepancyToleranceRp`). |
| `PUT` | `/api/shifts/settings` | `shifts:manage` / `settings:edit` | Memperbarui konfigurasi kebijakan shift dan mencatat audit log `SHIFT_SETTINGS_UPDATED`. |
| `GET` | `/api/shifts/current` | `shifts:view` / `shifts:open` / `pos:view` | Mengambil shift berstatus `OPEN` milik pengguna saat ini beserta `report` rekonsiliasi terkini dan `shiftSettings`. |
| `POST` | `/api/shifts/open` | `shifts:open` | Membuka shift kasir baru `{ openingCash, registerName?, openingNotes? }` dengan nomor `SHF-YYYYMMDD-XXXX`. Menolak duplikasi shift terbuka per kasir jika `allowDuplicateOpenShifts = false` (`409 SHIFT_ALREADY_OPEN`). |
| `GET` | `/api/shifts` | `shifts:view` / `shifts:open` / `shifts:approve` / `shifts:manage` / `reports:view` | Riwayat shift terpaginasi (`?search=&status=&discrepancyStatus=&cashierUserId=&dateFrom=&dateTo=&page=&pageSize=`). Kasir hanya melihat shift miliknya; Supervisor/Admin melihat seluruh shift. |
| `GET` | `/api/shifts/:id` | `shifts:view` / `shifts:open` / `shifts:approve` / `shifts:manage` / `reports:view` | Laporan detail shift (`shift`, `reconciliation`, `paymentBreakdown[]`, `cashMovements[]`, `transactions[]`). |
| `POST` | `/api/shifts/:id/cash-movements` | `shifts:cash_movement` | Mencatat mutasi kas laci `{ type: 'CASH_IN' \| 'CASH_OUT' \| 'EXPENSE' \| 'CASH_REFUND', amount, reason, referenceNumber?, notes? }` pada shift `OPEN` (`CM-YYYYMMDD-XXXX`). |
| `POST` | `/api/shifts/:id/close` | `shifts:open` | Menutup shift kasir dengan penghitungan kas aktual `{ actualCash?, denominations?: [{ denomination, count }], closingNotes?, confirmed: true, supervisorPinToken? }`. Menghitung `expectedCash` deterministik dari transaksi & mutasi kas; menandai `PENDING_APPROVAL` jika selisih melebihi toleransi tanpa otorisasi Supervisor/PIN. |
| `POST` | `/api/shifts/:id/approve` | `shifts:approve` | Menyetujui laporan selisih kas shift tertutup yang berstatus `PENDING_APPROVAL` `{ approvalNotes? }` dan mencatat `SHIFT_DISCREPANCY_APPROVED`. |

---

## 13. Retur, Refund & Void Transaksi (Phase 11)

| Method | Endpoint | Izin | Deskripsi & Payload |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/returns-voids/summary` | `transactions:view` / `pos:view` / `pos:refund` / `pos:void` / `reports:view` | Ringkasan KPI retur, total refund tunai/non-tunai, antrean inspeksi QC, dan jumlah transaksi di-void. |
| `GET` | `/api/returns-voids/search` | `transactions:view` / `pos:view` / `pos:refund` / `pos:void` | Pencarian transaksi selesai/di-void berdasarkan nomor struk (`receipt_number`), nomor invoice, pelanggan, atau nama produk (`?search=&limit=`). |
| `GET` | `/api/transactions/:id/return-eligibility` | `transactions:view` / `pos:view` / `pos:refund` / `pos:void` | Detail kelayakan retur & void transaksi beserta item historis, jumlah sudah diretur, sisa kuota, riwayat retur, dan status void. |
| `POST` | `/api/transactions/:id/returns/preview` | `transactions:view` / `pos:view` / `pos:refund` | Menghitung pratinjau nilai refund proporsional `BigInt` (subtotal, PPN, total refund, estimasi pembalikan poin) dari `{ items: [{ transactionItemId, qty, stockDisposition? }] }`. |
| `POST` | `/api/transactions/:id/returns` | `pos:refund` atau `pinApprovalToken` (`refund`) | Memproses retur penuh/sebagian & mencatat refund `{ items: [{ transactionItemId, qty, stockDisposition }], reason, notes?, refundMethod?, refundPaymentType?, refundReference?, refundStatus?, refundAmount?, shiftId?, idempotencyKey?, pinApprovalToken? }`. Mengembalikan `201` (atau `200` `idempotentReplay: true`). |
| `GET` | `/api/returns` | `transactions:view` / `pos:view` / `pos:refund` / `stock:view` / `reports:view` | Daftar riwayat retur barang (`?search=&status=&disposition=&limit=`). |
| `GET` | `/api/returns/:id` | `transactions:view` / `pos:view` / `pos:refund` / `stock:view` | Detail dokumen retur (`RET-YYYYMMDD-XXXX`) beserta rincian item dan disposisi stok. |
| `POST` | `/api/returns/items/:itemId/resolve-inspection` | `pos:refund` / `stock:adjust` atau `pinApprovalToken` (`refund`) | Menetapkan hasil QC untuk item berstatus `PENDING_INSPECTION` `{ disposition: 'SELLABLE' \| 'DAMAGED' \| 'UNSELLABLE', notes?, pinApprovalToken? }`. Hanya `SELLABLE` yang menambah stok jual (`RETURN_IN`). |
| `POST` | `/api/transactions/:id/void` | `pos:void` atau `pinApprovalToken` (`void`) | Melakukan void transaksi `COMPLETED` yang belum memiliki retur `{ reason, notes?, refundMethod?, refundPaymentType?, refundReference?, refundStatus?, shiftId?, pinApprovalToken? }`. Menjaga arsip transaksi & struk tetap utuh (`status = 'VOIDED'`), memulihkan stok (`VOID_IN`), dan membalik poin loyalitas. |
| `GET` | `/api/voids` | `transactions:view` / `pos:void` / `reports:view` / `audit:view` | Riwayat transaksi di-void (`VOD-YYYYMMDD-XXXX`, `?search=&limit=`). |
| `GET` | `/api/refunds` | `transactions:view` / `pos:refund` / `pos:void` / `reports:view` | Buku besar seluruh refund tunai & non-tunai (`RFD-YYYYMMDD-XXXX`, `?search=&status=&paymentType=&sourceType=&limit=`). |
| `PATCH` | `/api/refunds/:id/status` | `pos:refund` | Memperbarui status & referensi refund `{ status: 'COMPLETED' \| 'PENDING' \| 'MANUAL_RECORDED' \| 'FAILED', referenceNumber?, notes? }` serta mencatat `REFUND_STATUS_UPDATED`. |

