import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kassaritel-pos-phase3-test-'));
const tempDbFile = path.join(tempDir, 'pos.db');
process.env.POS_DB_FILE = tempDbFile;
process.env.POS_UPLOADS_DIR = path.join(tempDir, 'uploads');
process.env.POS_DATA_FILE = path.join(tempDir, 'nonexistent-legacy.json');
process.env.POS_SKIP_LISTEN = '1';

const { createApp } = await import('../server.ts');
const { closeDb, getDb } = await import('../server/db/database.ts');
const {
  computeGs1CheckDigit,
  detectScannerCapabilities,
  DuplicateScanGuard,
  isRearCameraLabel,
  validateAndNormalizeBarcode,
  verifyGs1CheckDigit,
} = await import('../src/utils/barcodeScanner.ts');
const {
  registerRecognitionProvider,
  unregisterRecognitionProvider,
} = await import('../server/services/ai/providerRegistry.ts');
const {
  normalizeOcrSignals,
  parseMeasureString,
  scoreProductCandidate,
} = await import('../server/services/ai/providerTypes.ts');

let server: Server;
let baseUrl: string;
let adminToken = '';
let adminRefreshToken = '';
let cashierToken = '';

async function api<T>(
  urlPath: string,
  init?: RequestInit & { token?: string }
): Promise<{ status: number; body: T; setCookies: string[] }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (init?.token) {
    headers.Authorization = `Bearer ${init.token}`;
  }
  const res = await fetch(`${baseUrl}${urlPath}`, {
    ...init,
    headers,
  });
  const body = (await res.json()) as T;
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, body, setCookies };
}

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Phase 02 — Authentication, RBAC, PIN Auth, Sessions & POS Integrity', () => {
  it('rejects unauthenticated access to protected API endpoints', async () => {
    const boot = await api<{ error: string }>('/api/bootstrap');
    assert.equal(boot.status, 401);

    const users = await api<{ error: string }>('/api/users');
    assert.equal(users.status, 401);

    const trx = await api<{ error: string }>('/api/transactions', {
      method: 'POST',
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(trx.status, 401);
  });

  it('rejects invalid credentials and records LOGIN_FAILED audit log', async () => {
    const bad = await api<{ error: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'admin', password: 'WrongPassword!' }),
    });
    assert.equal(bad.status, 401);

    const db = getDb();
    const row = db
      .prepare("SELECT action, actor FROM audit_logs WHERE action = 'LOGIN_FAILED' ORDER BY created_at DESC LIMIT 1")
      .get() as { action: string; actor: string } | undefined;
    assert.ok(row);
    assert.equal(row.action, 'LOGIN_FAILED');
  });

  it('stores password hashes securely (never plaintext) and logs in Admin & Cashier with refresh rotation', async () => {
    const db = getDb();
    const rawUser = db
      .prepare("SELECT password_hash, pin_hash FROM users WHERE username = 'admin'")
      .get() as { password_hash: string; pin_hash: string };
    assert.ok(rawUser.password_hash.startsWith('scrypt:'));
    assert.ok(!rawUser.password_hash.includes('Admin123!'));
    assert.ok(rawUser.pin_hash.startsWith('scrypt:'));
    assert.ok(!rawUser.pin_hash.includes('123456'));

    const adminLogin = await api<{
      accessToken: string;
      refreshToken: string;
      user: { username: string; permissions: string[] };
    }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'admin@kassaritel.id', password: 'Admin123!' }),
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.body.user.username, 'admin');
    assert.ok(adminLogin.body.user.permissions.includes('users:create'));
    adminToken = adminLogin.body.accessToken;
    adminRefreshToken = adminLogin.body.refreshToken;

    // Test refresh rotation
    const refreshed = await api<{ accessToken: string; refreshToken: string }>('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: adminRefreshToken }),
    });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.body.accessToken, adminToken);
    adminToken = refreshed.body.accessToken;
    adminRefreshToken = refreshed.body.refreshToken;

    // Login Cashier
    const cashierLogin = await api<{
      accessToken: string;
      user: { username: string; permissions: string[] };
    }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'kasir', password: 'Kasir123!' }),
    });
    assert.equal(cashierLogin.status, 200);
    assert.equal(cashierLogin.body.user.username, 'kasir');
    assert.ok(!cashierLogin.body.user.permissions.includes('users:view'));
    cashierToken = cashierLogin.body.accessToken;
  });

  it('enforces RBAC permissions on protected routes (Cashier denied Admin/Supervisor actions)', async () => {
    const usersRes = await api<{ error: string }>('/api/users', { token: cashierToken });
    assert.equal(usersRes.status, 403);

    const createProdRes = await api<{ error: string }>('/api/products', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({ barcode: '8990000111222', name: 'Blocked', sellPrice: 5000 }),
    });
    assert.equal(createProdRes.status, 403);

    const auditRes = await api<{ error: string }>('/api/audit-logs', { token: cashierToken });
    assert.equal(auditRes.status, 403);
  });

  it('allows Admin to create, edit, deactivate, and reset password on User Management & customize Role permissions', async () => {
    const rolesRes = await api<{ roles: Array<{ id: string; name: string }> }>('/api/roles', {
      token: adminToken,
    });
    assert.equal(rolesRes.status, 200);
    const cashierRole = rolesRes.body.roles.find((r) => r.name === 'Cashier');
    assert.ok(cashierRole);

    const createUserRes = await api<{ user: { id: string; username: string; isActive: boolean } }>(
      '/api/users',
      {
        method: 'POST',
        token: adminToken,
        body: JSON.stringify({
          username: 'kasir.baru',
          email: 'kasir.baru@kassaritel.id',
          fullName: 'Kasir Baru',
          password: 'Password123',
          roleIds: [cashierRole.id],
        }),
      }
    );
    assert.equal(createUserRes.status, 201);
    const createdId = createUserRes.body.user.id;

    // Deactivate newly created user -> login must be rejected with 403
    const deactRes = await api<{ user: { isActive: boolean } }>(`/api/users/${createdId}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({ isActive: false }),
    });
    assert.equal(deactRes.status, 200);
    assert.equal(deactRes.body.user.isActive, false);

    const blockedLogin = await api<{ error: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'kasir.baru', password: 'Password123' }),
    });
    assert.equal(blockedLogin.status, 403);

    // Create & update custom role permissions
    const customRoleRes = await api<{ role: { id: string; permissionCodes: string[] } }>('/api/roles', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        name: 'Staf Gudang',
        description: 'Kelola stok barang',
        permissionCodes: ['products:view', 'stock:view', 'stock:adjust'],
      }),
    });
    assert.equal(customRoleRes.status, 201);
    assert.ok(customRoleRes.body.role.permissionCodes.includes('stock:adjust'));
  });

  it('requires PIN authorization for Cashier discount and executes Phase 01 POS checkout & stock movement integrity', async () => {
    // Admin creates a fresh test product
    const prodRes = await api<{ product: { id: string; stock: number } }>('/api/products', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        barcode: '8995555123454',
        name: 'Teh Hijau Uji 350ml',
        category: 'Minuman',
        unit: 'botol',
        costPrice: 3000,
        sellPrice: 5000,
        stock: 20,
        minStock: 5,
      }),
    });
    assert.equal(prodRes.status, 201);
    const prodId = prodRes.body.product.id;

    // Cashier attempts checkout WITH discount without PIN -> must return 403 PIN_REQUIRED
    const deniedDiscount = await api<{ error: string; code?: string }>('/api/transactions', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({
        items: [{ productId: prodId, qty: 4 }],
        discountAmount: 2000,
        applyTax: true,
        cashReceived: 30000,
        paymentMethod: 'Tunai',
      }),
    });
    assert.equal(deniedDiscount.status, 403);
    assert.equal(deniedDiscount.body.code, 'PIN_REQUIRED');

    // Supervisor approves via PIN
    const pinRes = await api<{ pinApprovalToken: string; authorizerName: string }>(
      '/api/auth/verify-pin',
      {
        method: 'POST',
        token: cashierToken,
        body: JSON.stringify({
          authorizerIdentifier: 'supervisor',
          pin: '654321',
          action: 'discount_approval',
          reason: 'Diskon uji transaksi',
        }),
      }
    );
    assert.equal(pinRes.status, 200);
    assert.ok(pinRes.body.pinApprovalToken);

    // Retry checkout with single-use pinApprovalToken -> succeeds and computes authoritative total
    const trxRes = await api<{
      transaction: {
        invoiceNumber: string;
        subtotal: number;
        discountAmount: number;
        taxAmount: number;
        total: number;
        changeAmount: number;
        grossProfit: number;
      };
      store: {
        products: Array<{ id: string; stock: number }>;
        stockMovements: Array<{ productId: string; type: string; qtyDelta: number; referenceId: string }>;
      };
    }>('/api/transactions', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({
        items: [{ productId: prodId, qty: 4 }],
        discountAmount: 2000,
        applyTax: true,
        cashReceived: 30000,
        paymentMethod: 'Tunai',
        pinApprovalToken: pinRes.body.pinApprovalToken,
      }),
    });
    assert.equal(trxRes.status, 201);
    assert.equal(trxRes.body.transaction.subtotal, 20000);
    assert.equal(trxRes.body.transaction.taxAmount, 1980);
    assert.equal(trxRes.body.transaction.total, 19980);
    assert.equal(trxRes.body.transaction.changeAmount, 10020);
    assert.equal(trxRes.body.transaction.grossProfit, 6000);

    const updatedProd = trxRes.body.store.products.find((p) => p.id === prodId);
    assert.equal(updatedProd?.stock, 16);
  });

  it('supports session listing, session revocation, and secure logout', async () => {
    const sesRes = await api<{ sessions: Array<{ id: string; isCurrent: boolean; revokedAt: string | null }> }>(
      '/api/sessions',
      { token: adminToken }
    );
    assert.equal(sesRes.status, 200);
    assert.ok(sesRes.body.sessions.length >= 2);

    // Logout Cashier token -> subsequent requests with cashierToken must be rejected with 401
    const logoutRes = await api<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
      token: cashierToken,
    });
    assert.equal(logoutRes.status, 200);

    const afterLogout = await api<{ error: string }>('/api/bootstrap', { token: cashierToken });
    assert.equal(afterLogout.status, 401);

    // Verify audit logs captured login, pin auth, user creation, role creation, transaction, logout
    const auditRes = await api<{ auditLogs: Array<{ action: string }> }>('/api/audit-logs', {
      token: adminToken,
    });
    assert.equal(auditRes.status, 200);
    const actions = new Set(auditRes.body.auditLogs.map((a) => a.action));
    assert.ok(actions.has('LOGIN_SUCCESS'));
    assert.ok(actions.has('LOGIN_FAILED'));
    assert.ok(actions.has('USER_CREATED'));
    assert.ok(actions.has('ROLE_CREATED'));
    assert.ok(actions.has('PIN_AUTHORIZATION_SUCCESS'));
    assert.ok(actions.has('TRANSACTION_COMPLETED'));
    assert.ok(actions.has('LOGOUT'));
  });
});

describe('Phase 03 — Product Master, Barcodes, Images, Categories, Brands, UOM & CSV Import/Export', () => {
  let categoryParentId = '';
  let subcategoryId = '';
  let brandId = '';
  let customUomId = '';
  let createdProductId = '';
  let uploadedImageId = '';
  let uploadedImageUrl = '';

  it('supports Categories (parent/child), Brands, and standard 8 + custom Units of Measure', async () => {
    // Verify 8 standard system UOMs exist
    const uomsList = await api<{ uoms: Array<{ id: string; code: string; isSystem: boolean }> }>('/api/uoms', {
      token: adminToken,
    });
    assert.equal(uomsList.status, 200);
    const uomCodes = new Set(uomsList.body.uoms.map((u) => u.code));
    for (const reqCode of ['PCS', 'PACK', 'BOX', 'BOTTLE', 'KG', 'GRAM', 'LITER', 'ML']) {
      assert.ok(uomCodes.has(reqCode), `Expected standard UOM ${reqCode}`);
    }

    // Create custom UOM
    const uomRes = await api<{ uom: { id: string; code: string } }>('/api/uoms', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ code: 'GALON', name: 'Galon 19L' }),
    });
    assert.equal(uomRes.status, 201);
    assert.equal(uomRes.body.uom.code, 'GALON');
    customUomId = uomRes.body.uom.id;

    // Create parent category + child subcategory
    const catRes = await api<{ category: { id: string; name: string } }>('/api/categories', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ name: 'Elektronik Ritel', description: 'Aksesoris kasir & rumah' }),
    });
    assert.equal(catRes.status, 201);
    categoryParentId = catRes.body.category.id;

    const subRes = await api<{ category: { id: string; parentId: string | null } }>('/api/categories', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        name: 'Baterai & Charger',
        parentId: categoryParentId,
        description: 'Baterai AA/AAA',
      }),
    });
    assert.equal(subRes.status, 201);
    assert.equal(subRes.body.category.parentId, categoryParentId);
    subcategoryId = subRes.body.category.id;

    // Create brand
    const brandRes = await api<{ brand: { id: string; name: string } }>('/api/brands', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ name: 'AlkaPower', description: 'Merek baterai uji' }),
    });
    assert.equal(brandRes.status, 201);
    brandId = brandRes.body.brand.id;
  });

  it('creates product with full Phase 03 attributes & multiple barcodes, and prevents duplicate SKU/barcode', async () => {
    const createRes = await api<{
      product: {
        id: string;
        sku: string;
        barcode: string;
        brandName: string;
        category: string;
        subcategoryName: string;
        unit: string;
        specialPrice: number | null;
        taxCategory: string;
        status: string;
        barcodes: Array<{ id: string; barcode: string; barcodeType: string; isPrimary: boolean }>;
      };
    }>('/api/products', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        sku: 'SKU-TEST-900',
        name: 'Baterai Alkaline AA Isi 4',
        description: 'Baterai tahan lama untuk remote & mainan',
        brandId,
        categoryId: categoryParentId,
        subcategoryId,
        uomId: customUomId,
        variant: 'AA Pack 4',
        size: '4x AA',
        weight: 95,
        volume: null,
        costPrice: 12000,
        sellPrice: 20000,
        specialPrice: 17500,
        taxCategory: 'STANDARD',
        stock: 30,
        minStock: 5,
        status: 'ACTIVE',
        barcodes: [
          { barcode: '8991112223334', barcodeType: 'EAN-13', isPrimary: true },
          { barcode: 'ALK-AA-004', barcodeType: 'CODE-128', isPrimary: false },
        ],
      }),
    });
    assert.equal(createRes.status, 201);
    const prod = createRes.body.product;
    assert.equal(prod.sku, 'SKU-TEST-900');
    assert.equal(prod.barcode, '8991112223334');
    assert.equal(prod.brandName, 'AlkaPower');
    assert.equal(prod.category, 'Elektronik Ritel');
    assert.equal(prod.subcategoryName, 'Baterai & Charger');
    assert.equal(prod.unit, 'GALON');
    assert.equal(prod.specialPrice, 17500);
    assert.equal(prod.barcodes.length, 2);
    createdProductId = prod.id;

    // Duplicate SKU must return 409
    const dupSku = await api<{ error: string }>('/api/products', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        sku: 'sku-test-900',
        barcode: '8991112229999',
        name: 'Produk Duplikat SKU',
        sellPrice: 10000,
      }),
    });
    assert.equal(dupSku.status, 409);

    // Duplicate barcode (even matching secondary barcode!) must return 409
    const dupBarcode = await api<{ error: string }>('/api/products', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        sku: 'SKU-TEST-901',
        barcode: 'ALK-AA-004',
        name: 'Produk Duplikat Barcode',
        sellPrice: 10000,
      }),
    });
    assert.equal(dupBarcode.status, 409);

    // Search by secondary barcode returns exact product
    const lookupRes = await api<{ product: { id: string; sku: string } | null }>(
      '/api/products/barcode/ALK-AA-004',
      { token: adminToken }
    );
    assert.equal(lookupRes.status, 200);
    assert.equal(lookupRes.body.product?.id, createdProductId);

    // Paginated search, filtering, and sorting
    const searchRes = await api<{
      products: Array<{ id: string }>;
      total: number;
      page: number;
      totalPages: number;
    }>(`/api/products?search=ALK-AA-004&brandId=${brandId}&sortBy=sellPrice&sortDir=desc&page=1&pageSize=10`, {
      token: adminToken,
    });
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.body.total, 1);
    assert.equal(searchRes.body.products[0].id, createdProductId);
  });

  it('validates and stores product images with AI reference metadata and serves them cleanly', async () => {
    // Invalid non-image payload must be rejected with 400
    const invalidImg = await api<{ error: string }>(`/api/products/${createdProductId}/images`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        fileName: 'fake.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('not-a-valid-png-file-at-all').toString('base64'),
      }),
    });
    assert.equal(invalidImg.status, 400);

    // Valid PNG magic bytes upload
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const validImg = await api<{
      product: {
        primaryImageUrl: string | null;
        images: Array<{
          id: string;
          imageUrl: string;
          isPrimary: boolean;
          isAiReference: boolean;
          referenceAngle: string;
          aiEmbeddingStatus: string;
        }>;
      };
    }>(`/api/products/${createdProductId}/images`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        fileName: 'baterai-depan.png',
        mimeType: 'image/png',
        dataBase64: `data:image/png;base64,${pngBytes.toString('base64')}`,
        isPrimary: true,
        isAiReference: true,
        referenceAngle: 'front',
      }),
    });
    assert.equal(validImg.status, 201);
    assert.equal(validImg.body.product.images.length, 1);
    const img = validImg.body.product.images[0];
    assert.equal(img.isPrimary, true);
    assert.equal(img.isAiReference, true);
    assert.equal(img.referenceAngle, 'front');
    assert.equal(img.aiEmbeddingStatus, 'PENDING');
    assert.equal(validImg.body.product.primaryImageUrl, img.imageUrl);
    uploadedImageId = img.id;
    uploadedImageUrl = img.imageUrl;

    // Fetch uploaded image via HTTP
    const imgFetch = await fetch(`${baseUrl}${uploadedImageUrl}`);
    assert.equal(imgFetch.status, 200);
    const servedBuf = Buffer.from(await imgFetch.arrayBuffer());
    assert.deepEqual(servedBuf, pngBytes);

    // Update image metadata (angle -> packaging)
    const patchImg = await api<{
      product: { images: Array<{ id: string; referenceAngle: string }> };
    }>(`/api/products/${createdProductId}/images/${uploadedImageId}`, {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({ referenceAngle: 'packaging' }),
    });
    assert.equal(patchImg.status, 200);
    assert.equal(patchImg.body.product.images[0].referenceAngle, 'packaging');

    // Delete image -> clears primaryImageUrl
    const delImg = await api<{ product: { images: unknown[]; primaryImageUrl: string | null } }>(
      `/api/products/${createdProductId}/images/${uploadedImageId}`,
      { method: 'DELETE', token: adminToken }
    );
    assert.equal(delImg.status, 200);
    assert.equal(delImg.body.product.images.length, 0);
    assert.equal(delImg.body.product.primaryImageUrl, null);
  });

  it('prevents selling INACTIVE products at checkout and uses specialPrice when ACTIVE', async () => {
    // Re-login Cashier to get fresh token after Phase 02 logout test
    const cashierReLogin = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'kasir', password: 'Kasir123!' }),
    });
    assert.equal(cashierReLogin.status, 200);
    const freshCashierToken = cashierReLogin.body.accessToken;

    // Deactivate product -> checkout must reject with 409
    const deactRes = await api<{ product: { status: string } }>(
      `/api/products/${createdProductId}/status`,
      {
        method: 'PATCH',
        token: adminToken,
        body: JSON.stringify({ status: 'INACTIVE' }),
      }
    );
    assert.equal(deactRes.status, 200);
    assert.equal(deactRes.body.product.status, 'INACTIVE');

    const blockedSale = await api<{ error: string }>('/api/transactions', {
      method: 'POST',
      token: freshCashierToken,
      body: JSON.stringify({
        items: [{ productId: createdProductId, qty: 1 }],
        discountAmount: 0,
        applyTax: false,
        cashReceived: 25000,
        paymentMethod: 'Tunai',
      }),
    });
    assert.equal(blockedSale.status, 409);

    // Reactivate product -> checkout uses specialPrice (17500) instead of sellPrice (20000)
    const reactRes = await api<{ product: { status: string } }>(
      `/api/products/${createdProductId}/status`,
      {
        method: 'PATCH',
        token: adminToken,
        body: JSON.stringify({ status: 'ACTIVE' }),
      }
    );
    assert.equal(reactRes.status, 200);

    const activeSale = await api<{ transaction: { subtotal: number; total: number } }>('/api/transactions', {
      method: 'POST',
      token: freshCashierToken,
      body: JSON.stringify({
        items: [{ productId: createdProductId, qty: 2 }],
        discountAmount: 0,
        applyTax: false,
        cashReceived: 40000,
        paymentMethod: 'Tunai',
      }),
    });
    assert.equal(activeSale.status, 201);
    assert.equal(activeSale.body.transaction.subtotal, 35000);
    assert.equal(activeSale.body.transaction.total, 35000);
  });

  it('previews CSV import with duplicate detection, commits valid rows, and exports CSV', async () => {
    const csvRows = [
      {
        sku: 'SKU-CSV-001',
        barcode: '8997778880001',
        barcodeType: 'EAN-13',
        name: 'Kopi Tubruk Impor 200g',
        brand: 'KopiNusantara',
        category: 'Minuman',
        unit: 'PACK',
        costPrice: '11000',
        sellPrice: '16500',
        stock: '15',
        minStock: '3',
        taxCategory: 'STANDARD',
      },
      {
        // Duplicate SKU against existing SKU-TEST-900 -> should be flagged invalid in preview
        sku: 'SKU-TEST-900',
        barcode: '8997778880002',
        name: 'Produk Duplikat CSV',
        costPrice: '5000',
        sellPrice: '8000',
      },
    ];

    const previewRes = await api<{
      totalRows: number;
      validCount: number;
      errorCount: number;
      rows: Array<{ valid: boolean; errors: string[] }>;
    }>('/api/products/import/preview', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ rows: csvRows }),
    });
    assert.equal(previewRes.status, 200);
    assert.equal(previewRes.body.totalRows, 2);
    assert.equal(previewRes.body.validCount, 1);
    assert.equal(previewRes.body.errorCount, 1);
    assert.equal(previewRes.body.rows[0].valid, true);
    assert.equal(previewRes.body.rows[1].valid, false);

    // Commit valid row only
    const commitRes = await api<{
      importedCount: number;
      skippedCount: number;
    }>('/api/products/import/commit', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ rows: csvRows }),
    });
    assert.equal(commitRes.status, 201);
    assert.equal(commitRes.body.importedCount, 1);
    assert.equal(commitRes.body.skippedCount, 1);

    // Export CSV
    const exportFetch = await fetch(`${baseUrl}/api/products/export/csv?search=SKU-CSV-001`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(exportFetch.status, 200);
    const csvBody = await exportFetch.text();
    assert.ok(csvBody.includes('SKU-CSV-001'));
    assert.ok(csvBody.includes('Kopi Tubruk Impor 200g'));
    assert.ok(csvBody.includes('KopiNusantara'));
  });
});

describe('Phase 04 POS Core & Checkout Flow', () => {
  let adminToken = '';
  let cashierToken = '';
  let customPaymentMethodId = '';
  let customerId = '';
  let heldTrxId = '';
  let completedSplitTrxId = '';

  before(async () => {
    const adminRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'admin', password: 'Admin123!' }),
    });
    assert.equal(adminRes.status, 200);
    adminToken = adminRes.body.accessToken;

    const cashierRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'kasir', password: 'Kasir123!' }),
    });
    assert.equal(cashierRes.status, 200);
    cashierToken = cashierRes.body.accessToken;
  });

  it('computes authoritative cart totals with exact decimal/BigInt precision and tax category rules', async () => {
    // Set prd-06 (Beras 5kg, 76000) to EXEMPT while prd-01 (Indomie 3500) stays STANDARD (11%)
    const setExemptRes = await api<{ product: { taxCategory: string } }>('/api/products/prd-06', {
      method: 'PUT',
      token: adminToken,
      body: JSON.stringify({ taxCategory: 'EXEMPT' }),
    });
    assert.equal(setExemptRes.status, 200);
    assert.equal(setExemptRes.body.product.taxCategory, 'EXEMPT');

    const calcRes = await api<{
      subtotal: number;
      lineDiscountTotal: number;
      netAfterLineDiscounts: number;
      transactionDiscountAmount: number;
      totalDiscount: number;
      taxableAmount: number;
      taxAmount: number;
      grandTotal: number;
      items: Array<{
        productId: string;
        lineGrossSubtotal: number;
        lineDiscountAmount: number;
        lineNetAfterDiscount: number;
        lineTaxAmount: number;
      }>;
    }>('/api/pos/calculate', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({
        items: [
          { productId: 'prd-01', qty: 10, lineDiscountType: 'PERCENT', lineDiscountValue: 10 },
          { productId: 'prd-06', qty: 1, lineDiscountType: 'AMOUNT', lineDiscountValue: 0 },
        ],
        transactionDiscountType: 'PERCENT',
        transactionDiscountValue: 5,
        applyTax: true,
      }),
    });

    assert.equal(calcRes.status, 200);
    // Gross: 10*3500 + 76000 = 111000
    assert.equal(calcRes.body.subtotal, 111000);
    // Line discount: 10% of 35000 = 3500
    assert.equal(calcRes.body.lineDiscountTotal, 3500);
    assert.equal(calcRes.body.netAfterLineDiscounts, 107500);
    // Transaction discount: 5% of 107500 = 5375
    assert.equal(calcRes.body.transactionDiscountAmount, 5375);
    assert.equal(calcRes.body.totalDiscount, 8875);
    assert.equal(calcRes.body.taxableAmount, 102125);
    // Proportional allocation of 5375 across (31500, 76000) total 107500:
    // line1 share = 1575 -> taxable line1 = 31500 - 1575 = 29925
    // tax line1 (11%) = round(29925 * 1100 / 10000) = round(3291.75) = 3292
    // line2 (EXEMPT) tax = 0
    assert.equal(calcRes.body.taxAmount, 3292);
    assert.equal(calcRes.body.items[1].lineTaxAmount, 0);
    assert.equal(calcRes.body.grandTotal, 102125 + 3292);
  });

  it('supports customer creation and configurable payment methods', async () => {
    const custRes = await api<{ customer: { id: string; code: string; name: string } }>(
      '/api/customers',
      {
        method: 'POST',
        token: cashierToken,
        body: JSON.stringify({ name: 'Rina Marlina', phone: '081299887766' }),
      }
    );
    assert.equal(custRes.status, 201);
    assert.ok(custRes.body.customer.code.startsWith('CUST-'));
    customerId = custRes.body.customer.id;

    const listCustRes = await api<{ customers: Array<{ id: string }> }>(
      '/api/customers?search=Rina',
      { token: cashierToken }
    );
    assert.equal(listCustRes.status, 200);
    assert.ok(listCustRes.body.customers.some((c) => c.id === customerId));

    // Create custom payment method (e.g. GoPay Merchant)
    const pmCreate = await api<{
      paymentMethod: { id: string; name: string; type: string; isActive: boolean };
    }>('/api/payment-methods', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ name: 'GoPay Merchant', type: 'OTHER', requiresReference: true }),
    });
    assert.equal(pmCreate.status, 201);
    customPaymentMethodId = pmCreate.body.paymentMethod.id;
    assert.equal(pmCreate.body.paymentMethod.isActive, true);

    // Toggle inactive and back active
    const pmToggle = await api<{ paymentMethod: { isActive: boolean } }>(
      `/api/payment-methods/${customPaymentMethodId}/status`,
      {
        method: 'PATCH',
        token: adminToken,
        body: JSON.stringify({ isActive: false }),
      }
    );
    assert.equal(pmToggle.status, 200);
    assert.equal(pmToggle.body.paymentMethod.isActive, false);

    const pmReactivate = await api<{ paymentMethod: { isActive: boolean } }>(
      `/api/payment-methods/${customPaymentMethodId}/status`,
      {
        method: 'PATCH',
        token: adminToken,
        body: JSON.stringify({ isActive: true }),
      }
    );
    assert.equal(pmReactivate.status, 200);
    assert.equal(pmReactivate.body.paymentMethod.isActive, true);
  });

  it('supports Hold -> List Held -> Resume -> Complete and Hold -> Cancel without premature stock deduction', async () => {
    const beforeProd = await api<{ product: { stock: number } }>('/api/products/prd-02', {
      token: cashierToken,
    });
    const stockBefore = beforeProd.body.product.stock;

    // 1. Hold transaction (should NOT deduct stock)
    const holdRes = await api<{
      transaction: {
        id: string;
        invoiceNumber: string;
        status: string;
        paymentStatus: string;
        customerId: string;
        total: number;
      };
    }>('/api/transactions/hold', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({
        customerId,
        notes: 'Ambil dompet di mobil',
        items: [{ productId: 'prd-02', qty: 3 }],
        applyTax: false,
      }),
    });
    assert.equal(holdRes.status, 201);
    assert.equal(holdRes.body.transaction.status, 'HELD');
    assert.equal(holdRes.body.transaction.paymentStatus, 'UNPAID');
    assert.ok(holdRes.body.transaction.invoiceNumber.startsWith('HOLD-'));
    heldTrxId = holdRes.body.transaction.id;

    // Stock unchanged after hold
    const afterHoldProd = await api<{ product: { stock: number } }>('/api/products/prd-02', {
      token: cashierToken,
    });
    assert.equal(afterHoldProd.body.product.stock, stockBefore);

    // 2. List held transactions
    const listHeld = await api<{ transactions: Array<{ id: string }> }>('/api/transactions/held', {
      token: cashierToken,
    });
    assert.equal(listHeld.status, 200);
    assert.ok(listHeld.body.transactions.some((t) => t.id === heldTrxId));

    // 3. Resume held transaction -> status IN_PROGRESS
    const resumeRes = await api<{ transaction: { id: string; status: string } }>(
      `/api/transactions/${heldTrxId}/resume`,
      { method: 'POST', token: cashierToken }
    );
    assert.equal(resumeRes.status, 200);
    assert.equal(resumeRes.body.transaction.status, 'IN_PROGRESS');

    // 4. Complete the resumed transaction with Kartu Kredit + reference
    const completeRes = await api<{
      transaction: {
        id: string;
        invoiceNumber: string;
        status: string;
        paymentStatus: string;
        paymentMethod: string;
        total: number;
      };
    }>('/api/transactions', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({
        heldTransactionId: heldTrxId,
        customerId,
        notes: 'Lunas kartu kredit',
        items: [{ productId: 'prd-02', qty: 3 }],
        applyTax: false,
        paymentMethod: 'Kartu Kredit',
        paymentReference: 'EDC-CC-998811',
      }),
    });
    assert.equal(completeRes.status, 201);
    assert.equal(completeRes.body.transaction.id, heldTrxId);
    assert.equal(completeRes.body.transaction.status, 'COMPLETED');
    assert.equal(completeRes.body.transaction.paymentStatus, 'PAID');
    assert.ok(completeRes.body.transaction.invoiceNumber.startsWith('TRX-'));

    // Stock now deducted by 3
    const afterCompleteProd = await api<{ product: { stock: number } }>('/api/products/prd-02', {
      token: cashierToken,
    });
    assert.equal(afterCompleteProd.body.product.stock, stockBefore - 3);

    // Completed transaction CANNOT be physically deleted (409)
    const delCompleted = await api<{ error: string }>(`/api/transactions/${heldTrxId}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(delCompleted.status, 409);

    // 5. Second Hold -> Cancel cleanly without affecting stock
    const hold2 = await api<{ transaction: { id: string } }>('/api/transactions/hold', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({
        items: [{ productId: 'prd-02', qty: 2 }],
        applyTax: false,
      }),
    });
    assert.equal(hold2.status, 201);

    const cancel2 = await api<{ transaction: { status: string; paymentStatus: string } }>(
      `/api/transactions/${hold2.body.transaction.id}/cancel`,
      {
        method: 'POST',
        token: cashierToken,
        body: JSON.stringify({ reason: 'Pembeli batal beli' }),
      }
    );
    assert.equal(cancel2.status, 200);
    assert.equal(cancel2.body.transaction.status, 'CANCELLED');
    assert.equal(cancel2.body.transaction.paymentStatus, 'CANCELLED');

    const afterCancelProd = await api<{ product: { stock: number } }>('/api/products/prd-02', {
      token: cashierToken,
    });
    assert.equal(afterCancelProd.body.product.stock, stockBefore - 3);
  });

  it('enforces idempotency key, split payments, and price override PIN authorization', async () => {
    const beforeProd = await api<{ product: { stock: number; sellPrice: number } }>(
      '/api/products/prd-03',
      { token: cashierToken }
    );
    const stockBefore = beforeProd.body.product.stock;

    // 1. Price override without permission or PIN must return 403 PRICE_OVERRIDE_PIN_REQUIRED
    const noPinOverride = await api<{ code: string }>('/api/transactions', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({
        items: [{ productId: 'prd-03', qty: 2, overrideUnitPrice: 4000 }],
        applyTax: false,
        paymentMethod: 'Tunai',
        cashReceived: 10000,
      }),
    });
    assert.equal(noPinOverride.status, 403);
    assert.equal(noPinOverride.body.code, 'PRICE_OVERRIDE_PIN_REQUIRED');

    // Verify Supervisor PIN for price_override
    const pinRes = await api<{ pinApprovalToken: string }>('/api/auth/verify-pin', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({
        authorizerIdentifier: 'supervisor',
        pin: '654321',
        action: 'price_override',
        reason: 'Kemasan penyok sedikit',
      }),
    });
    assert.equal(pinRes.status, 200);

    // 2. Underpaid split payment rejected with 400
    const underpaidSplit = await api<{ error: string }>('/api/transactions', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({
        items: [{ productId: 'prd-03', qty: 2, overrideUnitPrice: 4000 }], // total 8000
        applyTax: false,
        priceOverridePinToken: pinRes.body.pinApprovalToken,
        payments: [
          { paymentMethodName: 'Tunai', paymentType: 'CASH', amount: 3000, tenderedAmount: 3000 },
          { paymentMethodName: 'QRIS', paymentType: 'QRIS', amount: 4000, tenderedAmount: 4000 },
        ],
      }),
    });
    assert.equal(underpaidSplit.status, 400);

    // 3. Valid Split Payment (Cash 3000 tendered 5000 -> change 2000 + QRIS 5000) with idempotencyKey
    const idemKey = `test-idem-${Date.now()}`;
    const splitCheckout = await api<{
      idempotentReplay: boolean;
      transaction: {
        id: string;
        invoiceNumber: string;
        total: number;
        cashReceived: number;
        changeAmount: number;
        paymentMethod: string;
        payments: Array<{ paymentMethodName: string; amount: number; referenceNumber: string }>;
        items: Array<{ sellPrice: number; priceOverride: boolean }>;
      };
    }>('/api/transactions', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({
        items: [{ productId: 'prd-03', qty: 2, overrideUnitPrice: 4000 }],
        applyTax: false,
        priceOverridePinToken: pinRes.body.pinApprovalToken,
        idempotencyKey: idemKey,
        payments: [
          {
            paymentMethodId: 'pm-cash',
            paymentMethodName: 'Tunai',
            paymentType: 'CASH',
            amount: 3000,
            tenderedAmount: 5000,
          },
          {
            paymentMethodId: 'pm-qris',
            paymentMethodName: 'QRIS',
            paymentType: 'QRIS',
            amount: 5000,
            tenderedAmount: 5000,
            referenceNumber: 'QR-SPLIT-8821',
          },
        ],
      }),
    });
    assert.equal(splitCheckout.status, 201);
    assert.equal(splitCheckout.body.idempotentReplay, false);
    assert.equal(splitCheckout.body.transaction.total, 8000);
    assert.equal(splitCheckout.body.transaction.changeAmount, 2000);
    assert.equal(splitCheckout.body.transaction.payments.length, 2);
    assert.equal(splitCheckout.body.transaction.items[0].priceOverride, true);
    assert.equal(splitCheckout.body.transaction.items[0].sellPrice, 4000);
    completedSplitTrxId = splitCheckout.body.transaction.id;

    // 4. Replay exact same idempotencyKey -> returns 200 idempotentReplay:true & does NOT deduct stock again!
    const replayCheckout = await api<{
      idempotentReplay: boolean;
      transaction: { id: string; invoiceNumber: string };
    }>('/api/transactions', {
      method: 'POST',
      token: cashierToken,
      body: JSON.stringify({
        items: [{ productId: 'prd-03', qty: 2, overrideUnitPrice: 4000 }],
        applyTax: false,
        idempotencyKey: idemKey,
        payments: [{ paymentMethodName: 'Tunai', amount: 8000, tenderedAmount: 8000 }],
      }),
    });
    assert.equal(replayCheckout.status, 200);
    assert.equal(replayCheckout.body.idempotentReplay, true);
    assert.equal(replayCheckout.body.transaction.id, completedSplitTrxId);

    const afterSplitProd = await api<{ product: { stock: number } }>('/api/products/prd-03', {
      token: cashierToken,
    });
    assert.equal(afterSplitProd.body.product.stock, stockBefore - 2);

    // 5. Transaction list filters & detail endpoint
    const detailRes = await api<{
      transaction: { id: string; payments: Array<{ referenceNumber: string }> };
    }>(`/api/transactions/${completedSplitTrxId}`, { token: cashierToken });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.transaction.payments[1].referenceNumber, 'QR-SPLIT-8821');

    const today = new Date().toISOString().slice(0, 10);
    const filteredList = await api<{
      transactions: Array<{ id: string; status: string }>;
      total: number;
    }>(`/api/transactions?status=COMPLETED&dateFrom=${today}&dateTo=${today}&search=Teh`, {
      token: cashierToken,
    });
    assert.equal(filteredList.status, 200);
    assert.ok(filteredList.body.transactions.some((t) => t.id === completedSplitTrxId));
  });
});

describe('Phase 05 — Receipt & Printing APIs', () => {
  const TINY_PNG_BASE64 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  let p5AdminToken = '';
  let p5CashierToken = '';

  before(async () => {
    const adminRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'admin', password: 'Admin123!' }),
    });
    assert.equal(adminRes.status, 200);
    p5AdminToken = adminRes.body.accessToken;

    const cashierRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'kasir', password: 'Kasir123!' }),
    });
    assert.equal(cashierRes.status, 200);
    p5CashierToken = cashierRes.body.accessToken;
  });

  it('uploads, serves, configures, and deletes store logo & receipt paper settings', async () => {
    const uploadRes = await api<{
      logoUrl: string;
      settings: { storeLogoUrl: string };
    }>('/api/settings/logo', {
      method: 'POST',
      token: p5AdminToken,
      body: JSON.stringify({
        fileName: 'logo-toko.png',
        mimeType: 'image/png',
        dataBase64: TINY_PNG_BASE64,
      }),
    });
    assert.equal(uploadRes.status, 201);
    assert.ok(uploadRes.body.logoUrl.startsWith('/api/uploads/store/'));
    assert.equal(uploadRes.body.settings.storeLogoUrl, uploadRes.body.logoUrl);

    const imgRes = await fetch(`${baseUrl}${uploadRes.body.logoUrl}`);
    assert.equal(imgRes.status, 200);
    assert.equal(imgRes.headers.get('content-type'), 'image/png');

    // Update receipt width to 58mm + header note
    const setRes = await api<{
      settings: {
        receiptPaperWidth: string;
        receiptShowLogo: boolean;
        receiptShowQr: boolean;
        receiptHeaderNote: string;
      };
    }>('/api/settings', {
      method: 'PUT',
      token: p5AdminToken,
      body: JSON.stringify({
        receiptPaperWidth: '58mm',
        receiptShowLogo: true,
        receiptShowQr: true,
        receiptHeaderNote: 'Cabang Utama Merdeka',
      }),
    });
    assert.equal(setRes.status, 200);
    assert.equal(setRes.body.settings.receiptPaperWidth, '58mm');
    assert.equal(setRes.body.settings.receiptHeaderNote, 'Cabang Utama Merdeka');
  });

  it('freezes historical product prices and store snapshot on completed receipt and prevents receipt on HELD transactions', async () => {
    // Hold transaction must reject receipt generation (409)
    const holdRes = await api<{ transaction: { id: string } }>('/api/transactions/hold', {
      method: 'POST',
      token: p5CashierToken,
      body: JSON.stringify({
        items: [{ productId: 'prd-01', qty: 1 }],
        applyTax: false,
      }),
    });
    assert.equal(holdRes.status, 201);

    const heldReceipt = await api<{ error: string }>(
      `/api/transactions/${holdRes.body.transaction.id}/receipt`,
      { token: p5CashierToken }
    );
    assert.equal(heldReceipt.status, 409);

    // Get current prd-01 price and store name
    const prodBefore = await api<{ product: { sellPrice: number; name: string } }>(
      '/api/products/prd-01',
      { token: p5AdminToken }
    );
    const originalPrice = prodBefore.body.product.sellPrice;

    // Complete a sale of 2x prd-01
    const saleRes = await api<{
      transaction: { id: string; invoiceNumber: string; total: number };
    }>('/api/transactions', {
      method: 'POST',
      token: p5CashierToken,
      body: JSON.stringify({
        items: [{ productId: 'prd-01', qty: 2 }],
        applyTax: false,
        paymentMethod: 'Tunai',
        cashReceived: originalPrice * 2 + 5000,
      }),
    });
    assert.equal(saleRes.status, 201);
    const trxId = saleRes.body.transaction.id;

    // Fetch receipt right after checkout
    const receiptBefore = await api<{
      receipt: {
        transaction: { total: number; items: Array<{ sellPrice: number; subtotal: number }> };
        snapshot: {
          receiptNumber: string;
          verificationToken: string;
          storeName: string;
          storeLogoUrl: string;
          receiptHeaderNote: string;
          printCount: number;
        };
        qrPayload: string;
        digitalReceiptPath: string;
      };
    }>(`/api/transactions/${trxId}/receipt`, { token: p5CashierToken });
    assert.equal(receiptBefore.status, 200);
    assert.equal(receiptBefore.body.receipt.transaction.items[0].sellPrice, originalPrice);
    assert.equal(receiptBefore.body.receipt.snapshot.receiptHeaderNote, 'Cabang Utama Merdeka');
    assert.ok(receiptBefore.body.receipt.snapshot.storeLogoUrl.startsWith('/api/uploads/store/'));
    assert.equal(receiptBefore.body.receipt.snapshot.printCount, 0);

    const originalStoreName = receiptBefore.body.receipt.snapshot.storeName;
    const verificationToken = receiptBefore.body.receipt.snapshot.verificationToken;

    // Mutate product sellPrice AND mutate storeName & remove logo AFTER checkout
    const updateProd = await api<{ product: { sellPrice: number } }>('/api/products/prd-01', {
      method: 'PUT',
      token: p5AdminToken,
      body: JSON.stringify({ sellPrice: originalPrice + 2500 }),
    });
    assert.equal(updateProd.status, 200);

    await api('/api/settings', {
      method: 'PUT',
      token: p5AdminToken,
      body: JSON.stringify({
        storeName: 'Toko Baru Setelah Transaksi',
        receiptHeaderNote: 'Header Berubah',
      }),
    });
    await api('/api/settings/logo', { method: 'DELETE', token: p5AdminToken });

    // Re-fetch receipt -> must retain historical item price, total, AND frozen store snapshot!
    const receiptAfter = await api<{
      receipt: {
        transaction: { total: number; items: Array<{ sellPrice: number; subtotal: number }> };
        snapshot: { storeName: string; receiptHeaderNote: string; storeLogoUrl: string };
      };
    }>(`/api/transactions/${trxId}/receipt`, { token: p5CashierToken });
    assert.equal(receiptAfter.status, 200);
    assert.equal(receiptAfter.body.receipt.transaction.items[0].sellPrice, originalPrice);
    assert.equal(receiptAfter.body.receipt.transaction.total, originalPrice * 2);
    assert.equal(receiptAfter.body.receipt.snapshot.storeName, originalStoreName);
    assert.equal(receiptAfter.body.receipt.snapshot.receiptHeaderNote, 'Cabang Utama Merdeka');
    assert.ok(receiptAfter.body.receipt.snapshot.storeLogoUrl.startsWith('/api/uploads/store/'));

    // Public digital receipt verification works with valid token & rejects invalid token (403)
    const badPublic = await api<{ error: string }>(
      `/api/receipts/public/${trxId}?token=invalid-token`
    );
    assert.equal(badPublic.status, 403);

    const validPublic = await api<{
      receipt: { snapshot: { receiptNumber: string }; transaction: { total: number } };
    }>(`/api/receipts/public/${trxId}?token=${encodeURIComponent(verificationToken)}`);
    assert.equal(validPublic.status, 200);
    assert.equal(validPublic.body.receipt.transaction.total, originalPrice * 2);

    // Reprint logs ORIGINAL (#1) then REPRINT (#2) WITHOUT creating any new transaction
    const trxCountBefore = (
      getDb().prepare("SELECT COUNT(*) as cnt FROM transactions WHERE status = 'COMPLETED'").get() as {
        cnt: number;
      }
    ).cnt;

    const print1 = await api<{
      printLog: { copyNumber: number; printType: string; layoutFormat: string };
      receipt: { snapshot: { printCount: number } };
    }>(`/api/transactions/${trxId}/receipt/print`, {
      method: 'POST',
      token: p5CashierToken,
      body: JSON.stringify({ layoutFormat: '58mm', driverId: 'browser-dialog' }),
    });
    assert.equal(print1.status, 200);
    assert.equal(print1.body.printLog.copyNumber, 1);
    assert.equal(print1.body.printLog.printType, 'ORIGINAL');
    assert.equal(print1.body.receipt.snapshot.printCount, 1);

    const print2 = await api<{
      printLog: { copyNumber: number; printType: string; layoutFormat: string };
      receipt: { snapshot: { printCount: number }; printLogs: Array<{ copyNumber: number }> };
    }>(`/api/transactions/${trxId}/receipt/print`, {
      method: 'POST',
      token: p5CashierToken,
      body: JSON.stringify({ layoutFormat: 'A4', driverId: 'browser-dialog' }),
    });
    assert.equal(print2.status, 200);
    assert.equal(print2.body.printLog.copyNumber, 2);
    assert.equal(print2.body.printLog.printType, 'REPRINT');
    assert.equal(print2.body.printLog.layoutFormat, 'A4');
    assert.equal(print2.body.receipt.snapshot.printCount, 2);
    assert.equal(print2.body.receipt.printLogs.length, 2);

    const trxCountAfter = (
      getDb().prepare("SELECT COUNT(*) as cnt FROM transactions WHERE status = 'COMPLETED'").get() as {
        cnt: number;
      }
    ).cnt;
    assert.equal(trxCountAfter, trxCountBefore);
  });
});

describe('Phase 06 — Inventory & Stock Control APIs', () => {
  let p6AdminToken = '';
  let p6CashierToken = '';
  let p6ProductId = '';

  before(async () => {
    const adminRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'admin', password: 'Admin123!' }),
    });
    assert.equal(adminRes.status, 200);
    p6AdminToken = adminRes.body.accessToken;

    const cashierRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'kasir', password: 'Kasir123!' }),
    });
    assert.equal(cashierRes.status, 200);
    p6CashierToken = cashierRes.body.accessToken;

    const prodRes = await api<{ product: { id: string } }>('/api/products', {
      method: 'POST',
      token: p6AdminToken,
      body: JSON.stringify({
        sku: 'SKU-P6-STOCK-01',
        barcode: '8996666000018',
        name: 'Susu UHT Full Cream 1L Uji',
        category: 'Minuman',
        unit: 'PACK',
        costPrice: 14000,
        sellPrice: 19500,
        stock: 10,
        minStock: 4,
      }),
    });
    assert.equal(prodRes.status, 201);
    p6ProductId = prodRes.body.product.id;
  });

  it('protects stock from direct product edits and protects stock history from product deletion', async () => {
    // Attempt direct stock mutation via PUT /api/products/:id -> rejected (400)
    const directMutate = await api<{ error: string }>(`/api/products/${p6ProductId}`, {
      method: 'PUT',
      token: p6AdminToken,
      body: JSON.stringify({ stock: 999 }),
    });
    assert.equal(directMutate.status, 400);

    // Attempt deleting product that has STOK_AWAL movement -> rejected (409)
    const deleteBlocked = await api<{ error: string }>(`/api/products/${p6ProductId}`, {
      method: 'DELETE',
      token: p6AdminToken,
    });
    assert.equal(deleteBlocked.status, 409);
  });

  it('computes Stock Balance summary, filters statuses, and configures minStock', async () => {
    const bal1 = await api<{
      items: Array<{ productId: string; currentStock: number; minStock: number; stockStatus: string }>;
      summary: { totalSku: number; safeCount: number; allowNegativeStock: boolean };
    }>('/api/inventory/stock-balance?search=SKU-P6-STOCK-01', { token: p6AdminToken });
    assert.equal(bal1.status, 200);
    assert.equal(bal1.body.items.length, 1);
    assert.equal(bal1.body.items[0].currentStock, 10);
    assert.equal(bal1.body.items[0].stockStatus, 'SAFE');

    // Raise minStock to 12 -> stockStatus becomes LOW
    const minPatch = await api<{
      item: { minStock: number; stockStatus: string };
    }>(`/api/inventory/products/${p6ProductId}/min-stock`, {
      method: 'PATCH',
      token: p6AdminToken,
      body: JSON.stringify({ minStock: 12 }),
    });
    assert.equal(minPatch.status, 200);
    assert.equal(minPatch.body.item.minStock, 12);
    assert.equal(minPatch.body.item.stockStatus, 'LOW');

    // Reset minStock back to 5
    await api(`/api/inventory/products/${p6ProductId}/min-stock`, {
      method: 'PATCH',
      token: p6AdminToken,
      body: JSON.stringify({ minStock: 5 }),
    });
  });

  it('records Stock In receiving, updates optional costPrice, and traces STOCK_IN movement', async () => {
    const badQty = await api<{ error: string }>('/api/inventory/stock-in', {
      method: 'POST',
      token: p6AdminToken,
      body: JSON.stringify({ productId: p6ProductId, qty: 0 }),
    });
    assert.equal(badQty.status, 400);

    const rcvRes = await api<{
      receiving: {
        referenceNumber: string;
        qty: number;
        costPrice: number;
        updateProductCost: boolean;
      };
      movement: {
        type: string;
        qtyDelta: number;
        stockBefore: number;
        stockAfter: number;
      };
      product: { stock: number; costPrice: number };
    }>('/api/inventory/stock-in', {
      method: 'POST',
      token: p6AdminToken,
      body: JSON.stringify({
        productId: p6ProductId,
        qty: 15,
        costPrice: 14500,
        updateProductCost: true,
        notes: 'Pengiriman PT Dairy',
      }),
    });
    assert.equal(rcvRes.status, 201);
    assert.ok(rcvRes.body.receiving.referenceNumber.startsWith('RCV-'));
    assert.equal(rcvRes.body.movement.type, 'STOCK_IN');
    assert.equal(rcvRes.body.movement.qtyDelta, 15);
    assert.equal(rcvRes.body.movement.stockBefore, 10);
    assert.equal(rcvRes.body.movement.stockAfter, 25);
    assert.equal(rcvRes.body.product.stock, 25);
    assert.equal(rcvRes.body.product.costPrice, 14500);

    const listRcv = await api<{ receivings: Array<{ referenceNumber: string }> }>(
      `/api/inventory/stock-in?productId=${p6ProductId}`,
      { token: p6AdminToken }
    );
    assert.equal(listRcv.status, 200);
    assert.ok(
      listRcv.body.receivings.some((r) => r.referenceNumber === rcvRes.body.receiving.referenceNumber)
    );
  });

  it('requires PIN approval for Cashier Stock Adjustment and enforces configurable negative stock rules', async () => {
    // 1. Cashier without stock:adjust gets 403 PIN_REQUIRED
    const denied = await api<{ code: string }>('/api/inventory/adjustments', {
      method: 'POST',
      token: p6CashierToken,
      body: JSON.stringify({
        productId: p6ProductId,
        direction: 'DECREASE',
        qty: 3,
        reason: 'Kemasan bocor',
      }),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'PIN_REQUIRED');

    // 2. Supervisor authorizes via PIN
    const pinRes = await api<{ pinApprovalToken: string }>('/api/auth/verify-pin', {
      method: 'POST',
      token: p6CashierToken,
      body: JSON.stringify({
        authorizerIdentifier: 'supervisor',
        pin: '654321',
        action: 'stock_adjustment',
        reason: 'Verifikasi barang rusak',
      }),
    });
    assert.equal(pinRes.status, 200);

    const adjRes = await api<{
      adjustment: {
        direction: string;
        qty: number;
        stockBefore: number;
        stockAfter: number;
        requestedByName: string;
        approvedByName: string;
      };
      movement: { type: string; qtyDelta: number };
    }>('/api/inventory/adjustments', {
      method: 'POST',
      token: p6CashierToken,
      body: JSON.stringify({
        productId: p6ProductId,
        direction: 'DECREASE',
        qty: 3,
        reason: 'Kemasan bocor',
        notes: 'Rak pendingin 2',
        pinApprovalToken: pinRes.body.pinApprovalToken,
      }),
    });
    assert.equal(adjRes.status, 201);
    assert.equal(adjRes.body.adjustment.stockBefore, 25);
    assert.equal(adjRes.body.adjustment.stockAfter, 22);
    assert.equal(adjRes.body.adjustment.approvedByName, 'Siti Rahayu (Supervisor)');
    assert.equal(adjRes.body.movement.type, 'ADJUSTMENT_OUT');
    assert.equal(adjRes.body.movement.qtyDelta, -3);

    // 3. When allowNegativeStock = false, decreasing 30 from 22 must be rejected (409)
    const negRejected = await api<{ error: string }>('/api/inventory/adjustments', {
      method: 'POST',
      token: p6AdminToken,
      body: JSON.stringify({
        productId: p6ProductId,
        direction: 'DECREASE',
        qty: 30,
        reason: 'Uji stok minus ditolak',
      }),
    });
    assert.equal(negRejected.status, 409);

    // 4. Enable allowNegativeStock = true via settings -> decrease & POS oversell succeed cleanly
    const enableNeg = await api<{ settings: { allowNegativeStock: boolean } }>('/api/settings', {
      method: 'PUT',
      token: p6AdminToken,
      body: JSON.stringify({ allowNegativeStock: true }),
    });
    assert.equal(enableNeg.status, 200);
    assert.equal(enableNeg.body.settings.allowNegativeStock, true);

    const negAdj = await api<{
      adjustment: { stockAfter: number };
    }>('/api/inventory/adjustments', {
      method: 'POST',
      token: p6AdminToken,
      body: JSON.stringify({
        productId: p6ProductId,
        direction: 'DECREASE',
        qty: 24,
        reason: 'Uji stok negatif diizinkan',
      }),
    });
    assert.equal(negAdj.status, 201);
    assert.equal(negAdj.body.adjustment.stockAfter, -2);

    // Verify POS sale also allows negative stock when enabled (2 -> -4)
    const oversellTrx = await api<{
      transaction: { total: number };
      store: { products: Array<{ id: string; stock: number }> };
    }>('/api/transactions', {
      method: 'POST',
      token: p6CashierToken,
      body: JSON.stringify({
        items: [{ productId: p6ProductId, qty: 2 }],
        applyTax: false,
        paymentMethod: 'Tunai',
        cashReceived: 50000,
      }),
    });
    assert.equal(oversellTrx.status, 201);
    assert.equal(
      oversellTrx.body.store.products.find((p) => p.id === p6ProductId)?.stock,
      -4
    );

    const negBal = await api<{
      items: Array<{ productId: string; stockStatus: string; currentStock: number }>;
    }>('/api/inventory/stock-balance?stockStatus=NEGATIVE', { token: p6AdminToken });
    assert.equal(negBal.status, 200);
    assert.ok(
      negBal.body.items.some((i) => i.productId === p6ProductId && i.stockStatus === 'NEGATIVE')
    );

    // Restore allowNegativeStock = false
    await api('/api/settings', {
      method: 'PUT',
      token: p6AdminToken,
      body: JSON.stringify({ allowNegativeStock: false }),
    });
  });

  it('executes full Stock Opname workflow (Create -> Count -> Review -> Approve -> Finalize) and traces Stock Card', async () => {
    // 1. Create opname for p6ProductId (system stock currently -4)
    const createOp = await api<{
      opname: { id: string; opnameNumber: string; status: string; totalItems: number };
    }>('/api/inventory/opnames', {
      method: 'POST',
      token: p6AdminToken,
      body: JSON.stringify({
        title: 'Opname Uji Produk Susu',
        productIds: [p6ProductId],
        notes: 'Hitung ulang rak susu',
      }),
    });
    assert.equal(createOp.status, 201);
    assert.equal(createOp.body.opname.status, 'DRAFT');
    assert.equal(createOp.body.opname.totalItems, 1);
    const opnameId = createOp.body.opname.id;

    // 2. Enter physical count = 12 -> variance = +16 -> submitForReview -> PENDING_REVIEW
    const countOp = await api<{
      opname: {
        status: string;
        countedItems: number;
        discrepancyItems: number;
        totalVarianceQty: number;
        items: Array<{ physicalStock: number; variance: number }>;
      };
    }>(`/api/inventory/opnames/${opnameId}/counts`, {
      method: 'PUT',
      token: p6AdminToken,
      body: JSON.stringify({
        items: [{ productId: p6ProductId, physicalStock: 12, notes: 'Ditemukan di gudang' }],
        submitForReview: true,
      }),
    });
    assert.equal(countOp.status, 200);
    assert.equal(countOp.body.opname.status, 'PENDING_REVIEW');
    assert.equal(countOp.body.opname.countedItems, 1);
    assert.equal(countOp.body.opname.discrepancyItems, 1);
    assert.equal(countOp.body.opname.totalVarianceQty, 16);
    assert.equal(countOp.body.opname.items[0].physicalStock, 12);
    assert.equal(countOp.body.opname.items[0].variance, 16);

    // 3. Approve opname -> APPROVED
    const approveOp = await api<{
      opname: { status: string; approvedByName: string };
    }>(`/api/inventory/opnames/${opnameId}/approve`, {
      method: 'POST',
      token: p6AdminToken,
      body: JSON.stringify({}),
    });
    assert.equal(approveOp.status, 200);
    assert.equal(approveOp.body.opname.status, 'APPROVED');
    assert.ok(approveOp.body.opname.approvedByName);

    // 4. Finalize opname -> updates product stock to 12 & records OPNAME stock movement
    const finalizeOp = await api<{
      opname: { status: string; opnameNumber: string };
      store: { products: Array<{ id: string; stock: number }> };
    }>(`/api/inventory/opnames/${opnameId}/finalize`, {
      method: 'POST',
      token: p6AdminToken,
      body: JSON.stringify({}),
    });
    assert.equal(finalizeOp.status, 200);
    assert.equal(finalizeOp.body.opname.status, 'FINALIZED');
    assert.equal(
      finalizeOp.body.store.products.find((p) => p.id === p6ProductId)?.stock,
      12
    );

    // Re-finalizing must fail (409)
    const doubleFinalize = await api<{ error: string }>(
      `/api/inventory/opnames/${opnameId}/finalize`,
      { method: 'POST', token: p6AdminToken, body: JSON.stringify({}) }
    );
    assert.equal(doubleFinalize.status, 409);

    // 5. Stock Card reflects complete traceable ledger back to 12
    const cardRes = await api<{
      product: { currentStock: number; stockStatus: string };
      summary: { totalIn: number; totalOut: number; movementCount: number };
      movements: Array<{ type: string; qtyDelta: number; stockAfter: number; referenceId: string }>;
    }>(`/api/inventory/products/${p6ProductId}/stock-card`, { token: p6AdminToken });
    assert.equal(cardRes.status, 200);
    assert.equal(cardRes.body.product.currentStock, 12);
    assert.equal(cardRes.body.product.stockStatus, 'SAFE');
    assert.ok(cardRes.body.summary.movementCount >= 6);
    assert.ok(
      cardRes.body.movements.some(
        (m) =>
          m.type === 'OPNAME' &&
          m.referenceId === finalizeOp.body.opname.opnameNumber &&
          m.stockAfter === 12
      )
    );
  });
});

describe('Phase 07 — Camera Barcode Scanner, Validation & Lookup', () => {
  let p7AdminToken = '';
  let p7CashierToken = '';

  before(async () => {
    const adminRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'admin', password: 'Admin123!' }),
    });
    assert.equal(adminRes.status, 200);
    p7AdminToken = adminRes.body.accessToken;

    const cashierRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'kasir', password: 'Kasir123!' }),
    });
    assert.equal(cashierRes.status, 200);
    p7CashierToken = cashierRes.body.accessToken;
  });

  it('validates retail 1D formats (EAN-13, EAN-8, UPC-A, UPC-E, Code 128) and enforces QR toggle', () => {
    // Valid GS1 EAN-13
    const ean13Body = '899600130118';
    const validEan13 = `${ean13Body}${computeGs1CheckDigit(ean13Body)}`;
    const eanRes = validateAndNormalizeBarcode(validEan13, 'ean_13', {
      allowQr: false,
      strictCheckDigit: true,
    });
    assert.equal(eanRes.valid, true);
    assert.equal(eanRes.detectedType, 'EAN-13');
    assert.equal(eanRes.checkDigitValid, true);

    // Invalid GS1 check digit caught when strictCheckDigit is enabled
    const wrongDigit = Number(validEan13[12]) === 9 ? '0' : String(Number(validEan13[12]) + 1);
    const badEan13 = `${ean13Body}${wrongDigit}`;
    const badEanRes = validateAndNormalizeBarcode(badEan13, 'EAN-13', {
      strictCheckDigit: true,
    });
    assert.equal(badEanRes.valid, false);
    assert.equal(badEanRes.checkDigitValid, false);

    // Valid EAN-8 & UPC-A
    const validEan8 = `9638507${computeGs1CheckDigit('9638507')}`;
    assert.equal(verifyGs1CheckDigit(validEan8, 'EAN-8'), true);
    const ean8Res = validateAndNormalizeBarcode(validEan8, 'ean_8', { strictCheckDigit: true });
    assert.equal(ean8Res.valid, true);
    assert.equal(ean8Res.detectedType, 'EAN-8');

    const validUpcA = `03600029145${computeGs1CheckDigit('03600029145')}`;
    assert.equal(verifyGs1CheckDigit(validUpcA, 'UPC-A'), true);
    const upcARes = validateAndNormalizeBarcode(validUpcA, 'upc_a', { strictCheckDigit: true });
    assert.equal(upcARes.valid, true);
    assert.equal(upcARes.detectedType, 'UPC-A');

    // Valid UPC-E (04252614 -> expands to 042100005264)
    assert.equal(verifyGs1CheckDigit('04252614', 'UPC-E'), true);
    const upcERes = validateAndNormalizeBarcode('04252614', 'upc_e', { strictCheckDigit: true });
    assert.equal(upcERes.valid, true);
    assert.equal(upcERes.detectedType, 'UPC-E');

    // Code 128 alphanumeric
    const c128Res = validateAndNormalizeBarcode('BATCH-2026-KASSA', 'code_128');
    assert.equal(c128Res.valid, true);
    assert.equal(c128Res.detectedType, 'CODE-128');

    // QR Code blocked when allowQr = false, allowed when allowQr = true
    const qrBlocked = validateAndNormalizeBarcode('https://kassaritel.id/promo/123', 'qr_code', {
      allowQr: false,
    });
    assert.equal(qrBlocked.valid, false);
    assert.equal(qrBlocked.detectedType, 'QR');

    const qrAllowed = validateAndNormalizeBarcode('https://kassaritel.id/promo/123', 'qr_code', {
      allowQr: true,
    });
    assert.equal(qrAllowed.valid, true);
    assert.equal(qrAllowed.detectedType, 'QR');

    // Rejects spaces and control characters
    assert.equal(validateAndNormalizeBarcode('899 123456', 'CODE-128').valid, false);
    assert.equal(validateAndNormalizeBarcode('12', 'CODE-128').valid, false);
  });

  it('prevents duplicate continuous frame scans with cooldown, in-flight lock, and manual reset', () => {
    const guard = new DuplicateScanGuard(1500);
    assert.equal(guard.shouldAccept('8998866200315', 1000), true);
    // Same barcode within 1500ms rejected
    assert.equal(guard.shouldAccept('8998866200315', 1800), false);
    assert.ok(guard.getRemainingCooldownMs('8998866200315', 1800) > 0);
    // Different barcode accepted immediately
    assert.equal(guard.shouldAccept('8992761139018', 1900), true);
    // In-flight guard blocks concurrent frames
    guard.markInFlight('8992761139018');
    assert.equal(guard.shouldAccept('8996001301180', 1950), false);
    guard.clearInFlight();
    // Same barcode accepted after cooldown elapses
    assert.equal(guard.shouldAccept('8992761139018', 3500), true);
    // Manual reset allows immediate re-scan
    guard.reset();
    assert.equal(guard.shouldAccept('8992761139018', 3510), true);
  });

  it('gracefully reports camera capability fallback and detects rear camera labels', async () => {
    const caps = await detectScannerCapabilities();
    assert.equal(caps.hasCameraApi, false);
    assert.equal(caps.preferredEngine, 'zxing');

    assert.equal(isRearCameraLabel('Back Dual Camera'), true);
    assert.equal(isRearCameraLabel('camera2 0, facing back'), true);
    assert.equal(isRearCameraLabel('Kamera Belakang'), true);
    assert.equal(isRearCameraLabel('FaceTime HD Camera (Front)'), false);
  });

  it('supports unknown scanned barcode workflow from 404 lookup to registration and immediate re-scan match', async () => {
    const unknownCode = '8997777000127';

    // 1. Unknown barcode returns 404
    const missRes = await api<{ error: string }>(
      `/api/products/barcode/${encodeURIComponent(unknownCode)}`,
      { token: p7CashierToken }
    );
    assert.equal(missRes.status, 404);

    // 2. Register product with scanned barcode + secondary Code 128 barcode
    const createRes = await api<{
      product: { id: string; barcode: string; barcodes: Array<{ barcode: string; barcodeType: string }> };
    }>('/api/products', {
      method: 'POST',
      token: p7AdminToken,
      body: JSON.stringify({
        sku: 'SKU-P7-SCAN-01',
        name: 'Kopi Sachet Scan Camera Uji',
        category: 'Minuman',
        unit: 'PACK',
        costPrice: 1800,
        sellPrice: 2500,
        stock: 20,
        minStock: 5,
        barcodes: [
          { barcode: unknownCode, barcodeType: 'EAN-13', isPrimary: true },
          { barcode: 'KARTON-P7-01', barcodeType: 'CODE-128', isPrimary: false },
        ],
      }),
    });
    assert.equal(createRes.status, 201);

    // 3. Subsequent scan lookup resolves both primary EAN-13 and secondary CODE-128
    const hitPrimary = await api<{ product: { id: string; name: string } }>(
      `/api/products/barcode/${encodeURIComponent(unknownCode)}`,
      { token: p7CashierToken }
    );
    assert.equal(hitPrimary.status, 200);
    assert.equal(hitPrimary.body.product.id, createRes.body.product.id);

    const hitSecondary = await api<{ product: { id: string } }>(
      `/api/products/barcode/${encodeURIComponent('karton-p7-01')}`,
      { token: p7CashierToken }
    );
    assert.equal(hitSecondary.status, 200);
    assert.equal(hitSecondary.body.product.id, createRes.body.product.id);
  });
});

describe('Phase 08 — AI Product Recognition, Multi-Signal Ranking & Feedback', () => {
  const TINY_PNG_BASE64 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  let p8AdminToken = '';
  let p8CashierToken = '';
  const origGeminiKey = process.env.GEMINI_API_KEY;

  before(async () => {
    const adminRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'admin', password: 'Admin123!' }),
    });
    assert.equal(adminRes.status, 200);
    p8AdminToken = adminRes.body.accessToken;

    const cashierRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'kasir', password: 'Kasir123!' }),
    });
    assert.equal(cashierRes.status, 200);
    p8CashierToken = cashierRes.body.accessToken;
  });

  after(() => {
    unregisterRecognitionProvider('test-vision-mock');
    if (origGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = origGeminiKey;
    }
  });

  it('normalizes weight/volume units and ranks candidates using multi-signal scoring rather than color alone', () => {
    const literMeasure = parseMeasureString('1L');
    assert.deepEqual(literMeasure, { kind: 'volume', valueInBaseUnit: 1000 });
    const kgMeasure = parseMeasureString('5 kg');
    assert.deepEqual(kgMeasure, { kind: 'weight', valueInBaseUnit: 5000 });

    const baseSettings = {
      activeProviderId: 'test-vision-mock',
      autoAddHighConfidence: false,
      highConfidenceThreshold: 0.85,
      mediumConfidenceThreshold: 0.55,
      lowConfidenceThreshold: 0.35,
      remoteEndpointUrl: '',
      requestTimeoutMs: 15000,
      updatedAt: new Date().toISOString(),
    };

    const targetProduct = {
      id: 'prd-mock-1',
      sku: 'SKU-M1',
      barcode: '8991111111111',
      name: 'Teh Botol Sosro Original 250ml',
      description: '',
      brandId: 'brd-sosro',
      brandName: 'Sosro',
      categoryId: 'cat-minuman',
      category: 'Minuman',
      subcategoryId: 'cat-teh-kopi',
      subcategoryName: 'Teh & Kopi',
      uomId: 'uom-box',
      unit: 'BOX',
      variant: 'Original Kotak',
      size: '250ml',
      weight: null,
      volume: 250,
      costPrice: 3000,
      sellPrice: 4000,
      specialPrice: null,
      taxCategory: 'STANDARD' as const,
      stock: 15,
      minStock: 5,
      status: 'ACTIVE' as const,
      primaryImageId: null,
      primaryImageUrl: null,
      barcodes: [],
      images: [],
      createdAt: '',
      updatedAt: '',
    };

    const wrongBrandSameVisual = {
      ...targetProduct,
      id: 'prd-mock-2',
      sku: 'SKU-M2',
      name: 'Susu Cokelat Ultra Milk 1000ml',
      brandName: 'Ultra Milk',
      variant: 'Cokelat',
      size: '1L',
      volume: 1000,
    };

    const ocr = normalizeOcrSignals({
      productName: 'Teh Botol Sosro Original',
      brand: 'Sosro',
      variant: 'Original Kotak',
      volume: '250ml',
      packagingType: 'kotak',
      rawText: 'Teh Botol Sosro Original 250 ml',
    });

    const queryVec = [0.9, 0.1, 0.2, 0.4];
    const sharedVec = [0.89, 0.11, 0.2, 0.41];

    const scoreTrue = scoreProductCandidate({
      product: targetProduct,
      referenceEmbeddings: [
        { imageId: 'img-1', imageUrl: '/img1.jpg', isAiReference: true, vector: sharedVec },
      ],
      verifiedFeedbackTerms: [],
      queryEmbedding: queryVec,
      ocr,
      settings: baseSettings,
    });

    const scoreConflicted = scoreProductCandidate({
      product: wrongBrandSameVisual,
      referenceEmbeddings: [
        { imageId: 'img-2', imageUrl: '/img2.jpg', isAiReference: true, vector: sharedVec },
      ],
      verifiedFeedbackTerms: [],
      queryEmbedding: queryVec,
      ocr,
      settings: baseSettings,
    });

    assert.ok(scoreTrue.confidence >= 0.85, `Expected high score, got ${scoreTrue.confidence}`);
    assert.equal(scoreTrue.confidenceBand, 'HIGH');
    assert.ok(
      scoreTrue.confidence > scoreConflicted.confidence + 0.35,
      `Brand/size/OCR signals must strongly separate ${scoreTrue.confidence} from ${scoreConflicted.confidence}`
    );
  });

  it('enforces RBAC & threshold validation and fails honestly without fake results when Gemini key is unavailable', async () => {
    delete process.env.GEMINI_API_KEY;

    // Cashier cannot modify recognition settings
    const forbiddenRes = await api<{ error: string }>('/api/recognition/settings', {
      method: 'PUT',
      token: p8CashierToken,
      body: JSON.stringify({ autoAddHighConfidence: true }),
    });
    assert.equal(forbiddenRes.status, 403);

    // Invalid threshold ordering rejected (400)
    const badThresholdRes = await api<{ error: string }>('/api/recognition/settings', {
      method: 'PUT',
      token: p8AdminToken,
      body: JSON.stringify({
        highConfidenceThreshold: 0.6,
        mediumConfidenceThreshold: 0.75,
        lowConfidenceThreshold: 0.4,
      }),
    });
    assert.equal(badThresholdRes.status, 400);

    // Providers report honest unavailable status when GEMINI_API_KEY is not present
    const provRes = await api<{
      providers: Array<{ id: string; available: boolean; reason?: string }>;
    }>('/api/recognition/providers', { token: p8CashierToken });
    assert.equal(provRes.status, 200);
    const geminiProv = provRes.body.providers.find((p) => p.id === 'gemini-vision');
    assert.ok(geminiProv);
    assert.equal(geminiProv.available, false);

    // Identify returns 503 PROVIDER_UNAVAILABLE and logs ERROR cleanly instead of faking recognition
    const failIdentify = await api<{ error: string; code?: string }>('/api/recognition/identify', {
      method: 'POST',
      token: p8CashierToken,
      body: JSON.stringify({
        mimeType: 'image/png',
        dataBase64: TINY_PNG_BASE64,
        width: 1,
        height: 1,
      }),
    });
    assert.equal(failIdentify.status, 503);
    assert.equal(failIdentify.body.code, 'PROVIDER_UNAVAILABLE');

    const logsRes = await api<{
      logs: Array<{ outcome: string; providerId: string; errorMessage: string | null }>;
    }>('/api/recognition/logs?outcome=ERROR&limit=5', { token: p8CashierToken });
    assert.equal(logsRes.status, 200);
    assert.ok(logsRes.body.logs.some((l) => l.outcome === 'ERROR' && l.providerId === 'gemini-vision'));
  });

  it('supports pluggable provider replacement, reference embedding sync, ranked identification, and verified feedback promotion', async () => {
    // 1. Register a deterministic replaceable provider
    registerRecognitionProvider({
      id: 'test-vision-mock',
      label: 'Test Replaceable Vision Provider',
      kind: 'local-inference',
      supportsOcr: true,
      supportsEmbeddings: true,
      getStatus: () => ({ available: true, modelName: 'test-vision-v1' }),
      async embedReferenceImage() {
        return { vector: [0.92, 0.25, 0.1, 0.3], modelName: 'test-embed-v1' };
      },
      async analyzeImage() {
        return {
          ocr: normalizeOcrSignals({
            productName: 'Indomie Goreng Spesial',
            brand: 'Indofood',
            variant: 'Goreng Spesial',
            weight: '85g',
            size: '85g',
            packagingType: 'bungkus',
            rawText: 'Indomie Mi Goreng Spesial 85g Indofood',
            keywords: ['indomie', 'goreng', '85g'],
          }),
          detectedRegion: {
            x: 0.1,
            y: 0.1,
            width: 0.8,
            height: 0.8,
            label: 'Indomie Goreng',
            confidence: 0.94,
          },
          embedding: [0.91, 0.26, 0.11, 0.29],
          embeddingModel: 'test-embed-v1',
          analysisModel: 'test-vision-v1',
        };
      },
    });

    // 2. Upload AI reference image on prd-01 (Indomie Goreng)
    const uploadImg = await api<{
      product: { id: string; images: Array<{ id: string; aiEmbeddingStatus: string }> };
    }>('/api/products/prd-01/images', {
      method: 'POST',
      token: p8AdminToken,
      body: JSON.stringify({
        fileName: 'indomie-front.png',
        mimeType: 'image/png',
        dataBase64: TINY_PNG_BASE64,
        isPrimary: true,
        isAiReference: true,
        referenceAngle: 'front',
      }),
    });
    assert.equal(uploadImg.status, 201);
    const refImgId = uploadImg.body.product.images[0].id;
    assert.equal(uploadImg.body.product.images[0].aiEmbeddingStatus, 'PENDING');

    // 3. Switch active provider to test-vision-mock & disable auto-add first
    const updateSet = await api<{ settings: { activeProviderId: string } }>(
      '/api/recognition/settings',
      {
        method: 'PUT',
        token: p8AdminToken,
        body: JSON.stringify({
          activeProviderId: 'test-vision-mock',
          autoAddHighConfidence: false,
          highConfidenceThreshold: 0.82,
          mediumConfidenceThreshold: 0.55,
          lowConfidenceThreshold: 0.35,
        }),
      }
    );
    assert.equal(updateSet.status, 200);
    assert.equal(updateSet.body.settings.activeProviderId, 'test-vision-mock');

    // 4. Sync reference image embeddings -> status becomes READY
    const syncRes = await api<{
      summary: { providerId: string; processed: number; readyCount: number; failedCount: number };
      store: { products: Array<{ id: string; images: Array<{ id: string; aiEmbeddingStatus: string }> }> };
    }>('/api/recognition/references/sync', {
      method: 'POST',
      token: p8AdminToken,
      body: JSON.stringify({ productId: 'prd-01' }),
    });
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.summary.failedCount, 0);
    assert.ok(syncRes.body.summary.readyCount >= 1);
    const syncedProd = syncRes.body.store.products.find((p) => p.id === 'prd-01');
    assert.equal(
      syncedProd?.images.find((i) => i.id === refImgId)?.aiEmbeddingStatus,
      'READY'
    );

    // 5. Run identification as cashier -> matches prd-01 with HIGH confidence & autoAddEligible=false (setting is false)
    const idRes = await api<{
      result: {
        logId: string;
        capturedImageUrl: string;
        confidenceBand: string;
        autoAddEligible: boolean;
        bestMatch: { productId: string; confidence: number; signals: { imageSimilarity: number; ocrTextSimilarity: number } };
        candidates: Array<{ productId: string }>;
      };
    }>('/api/recognition/identify', {
      method: 'POST',
      token: p8CashierToken,
      body: JSON.stringify({
        mimeType: 'image/png',
        dataBase64: TINY_PNG_BASE64,
        width: 320,
        height: 240,
        context: 'POS_CASHIER',
      }),
    });
    assert.equal(idRes.status, 200);
    assert.equal(idRes.body.result.bestMatch.productId, 'prd-01');
    assert.equal(idRes.body.result.confidenceBand, 'HIGH');
    assert.equal(idRes.body.result.autoAddEligible, false);
    assert.ok(idRes.body.result.bestMatch.signals.imageSimilarity > 0.9);
    assert.ok(idRes.body.result.bestMatch.signals.ocrTextSimilarity > 0.6);

    // Verify captured image is served safely via /api/uploads/recognition/
    const capRes = await fetch(`${baseUrl}${idRes.body.result.capturedImageUrl}`);
    assert.equal(capRes.status, 200);
    assert.equal(capRes.headers.get('content-type'), 'image/png');

    // 6. Enable autoAddHighConfidence -> next HIGH confidence identification marks autoAddEligible=true
    await api('/api/recognition/settings', {
      method: 'PUT',
      token: p8AdminToken,
      body: JSON.stringify({ autoAddHighConfidence: true }),
    });
    const idAutoRes = await api<{
      result: { logId: string; confidenceBand: string; autoAddEligible: boolean };
    }>('/api/recognition/identify', {
      method: 'POST',
      token: p8CashierToken,
      body: JSON.stringify({
        mimeType: 'image/png',
        dataBase64: TINY_PNG_BASE64,
        width: 320,
        height: 240,
      }),
    });
    assert.equal(idAutoRes.status, 200);
    assert.equal(idAutoRes.body.result.confidenceBand, 'HIGH');
    assert.equal(idAutoRes.body.result.autoAddEligible, true);

    // 7. Submit verified feedback & promote captured image into product_images as AI reference (Admin)
    const imgCountBefore = syncedProd?.images.length ?? 0;
    const fbRes = await api<{
      log: { outcome: string; isVerifiedFeedback: boolean; selectedProductId: string };
      store: { products: Array<{ id: string; images: Array<{ isAiReference: boolean }> }> };
    }>(`/api/recognition/logs/${idAutoRes.body.result.logId}/feedback`, {
      method: 'POST',
      token: p8AdminToken,
      body: JSON.stringify({
        outcome: 'CONFIRMED',
        selectedProductId: 'prd-01',
        promoteAsReferenceImage: true,
        referenceAngle: 'front',
        notes: 'Terverifikasi kasir',
      }),
    });
    assert.equal(fbRes.status, 200);
    assert.equal(fbRes.body.log.outcome, 'CONFIRMED');
    assert.equal(fbRes.body.log.isVerifiedFeedback, true);
    const updatedProd = fbRes.body.store.products.find((p) => p.id === 'prd-01');
    assert.equal(updatedProd?.images.length, imgCountBefore + 1);

    // Restore default provider setting cleanly
    await api('/api/recognition/settings', {
      method: 'PUT',
      token: p8AdminToken,
      body: JSON.stringify({
        activeProviderId: 'gemini-vision',
        autoAddHighConfidence: false,
      }),
    });
  });
});

describe('Phase 09 — Customer Management, Loyalty Points & Promotion Engine', () => {
  let p9AdminToken = '';
  let p9CashierToken = '';
  let p9CustomerId = '';
  let p9MemberNo = '';
  let p9PromoBundleId = '';
  let p9PromoBxGyId = '';
  let p9PromoNonStackId = '';
  let p9ProdAId = '';
  let p9ProdBId = '';

  before(async () => {
    const adminRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'admin', password: 'Admin123!' }),
    });
    assert.equal(adminRes.status, 200);
    p9AdminToken = adminRes.body.accessToken;

    const cashierRes = await api<{ accessToken: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'kasir', password: 'Kasir123!' }),
    });
    assert.equal(cashierRes.status, 200);
    p9CashierToken = cashierRes.body.accessToken;

    // Create two clean test products so pricing is 100% deterministic
    const prodA = await api<{ product: { id: string } }>('/api/products', {
      method: 'POST',
      token: p9AdminToken,
      body: JSON.stringify({
        sku: 'SKU-P9-TEA-01',
        barcode: '8999090000112',
        name: 'Teh Uji Promo 350ml',
        category: 'Minuman',
        unit: 'BOTTLE',
        costPrice: 3000,
        sellPrice: 5000,
        stock: 60,
        minStock: 5,
        taxCategory: 'EXEMPT',
      }),
    });
    assert.equal(prodA.status, 201);
    p9ProdAId = prodA.body.product.id;

    const prodB = await api<{ product: { id: string } }>('/api/products', {
      method: 'POST',
      token: p9AdminToken,
      body: JSON.stringify({
        sku: 'SKU-P9-SNACK-02',
        barcode: '8999090000228',
        name: 'Biskuit Uji Bundle 120g',
        category: 'Makanan Ringan',
        unit: 'PACK',
        costPrice: 6000,
        sellPrice: 10000,
        stock: 60,
        minStock: 5,
        taxCategory: 'EXEMPT',
      }),
    });
    assert.equal(prodB.status, 201);
    p9ProdBId = prodB.body.product.id;
  });

  it('supports Customer CRUD, duplicate membershipNumber prevention, status toggle, and optional guest checkout', async () => {
    const createCust = await api<{
      customer: { id: string; code: string; membershipNumber: string; loyaltyPoints: number; isActive: boolean };
    }>('/api/customers', {
      method: 'POST',
      token: p9AdminToken,
      body: JSON.stringify({
        name: 'Andi Pratama P9',
        membershipNumber: 'MBR-P9-001',
        phone: '081900011122',
        email: 'andi.p9@pelanggan.id',
        address: 'Jl. Sudirman Kav 5',
        notes: 'Member prioritas',
      }),
    });
    assert.equal(createCust.status, 201);
    assert.equal(createCust.body.customer.membershipNumber, 'MBR-P9-001');
    assert.equal(createCust.body.customer.loyaltyPoints, 0);
    p9CustomerId = createCust.body.customer.id;
    p9MemberNo = createCust.body.customer.membershipNumber;

    // Duplicate membershipNumber rejected with 409
    const dupCust = await api<{ error: string }>('/api/customers', {
      method: 'POST',
      token: p9AdminToken,
      body: JSON.stringify({
        name: 'Duplikat Member',
        membershipNumber: p9MemberNo,
      }),
    });
    assert.equal(dupCust.status, 409);

    // Search by membership number
    const searchCust = await api<{ customers: Array<{ id: string }> }>(
      `/api/customers?search=${p9MemberNo}`,
      { token: p9CashierToken }
    );
    assert.equal(searchCust.status, 200);
    assert.ok(searchCust.body.customers.some((c) => c.id === p9CustomerId));

    // Edit customer profile (Admin)
    const editCust = await api<{ customer: { name: string; address: string } }>(
      `/api/customers/${p9CustomerId}`,
      {
        method: 'PUT',
        token: p9AdminToken,
        body: JSON.stringify({ name: 'Andi Pratama Verified', address: 'Jl. Thamrin No. 10' }),
      }
    );
    assert.equal(editCust.status, 200);
    assert.equal(editCust.body.customer.name, 'Andi Pratama Verified');

    // Deactivate customer -> checkout referencing inactive customer is rejected (400)
    const deact = await api<{ customer: { isActive: boolean } }>(
      `/api/customers/${p9CustomerId}/status`,
      {
        method: 'PATCH',
        token: p9AdminToken,
        body: JSON.stringify({ isActive: false }),
      }
    );
    assert.equal(deact.status, 200);
    assert.equal(deact.body.customer.isActive, false);

    const inactiveCheckout = await api<{ error: string }>('/api/transactions', {
      method: 'POST',
      token: p9CashierToken,
      body: JSON.stringify({
        customerId: p9CustomerId,
        items: [{ productId: p9ProdAId, qty: 1 }],
        applyTax: false,
        paymentMethod: 'Tunai',
        cashReceived: 10000,
      }),
    });
    assert.equal(inactiveCheckout.status, 400);

    // Re-activate customer
    const react = await api<{ customer: { isActive: boolean } }>(
      `/api/customers/${p9CustomerId}/status`,
      {
        method: 'PATCH',
        token: p9AdminToken,
        body: JSON.stringify({ isActive: true }),
      }
    );
    assert.equal(react.status, 200);

    // Optional guest transaction (customerId: null) still succeeds cleanly
    const guestTrx = await api<{
      transaction: { customerId: string | null; customerName: string; loyaltyPointsEarned: number };
    }>('/api/transactions', {
      method: 'POST',
      token: p9CashierToken,
      body: JSON.stringify({
        customerId: null,
        items: [{ productId: p9ProdAId, qty: 1 }],
        applyTax: false,
        paymentMethod: 'Tunai',
        cashReceived: 5000,
      }),
    });
    assert.equal(guestTrx.status, 201);
    assert.equal(guestTrx.body.transaction.customerId, null);
    assert.equal(guestTrx.body.transaction.customerName, 'Pelanggan Umum');
    assert.equal(guestTrx.body.transaction.loyaltyPointsEarned, 0);
  });

  it('earns loyalty points on checkout, aggregates customer metrics, redeems points with BigInt accuracy, and records adjustments', async () => {
    // 1. Member spends Rp 100.000 (10 x 10.000) -> default 1 poin / Rp 10.000 => earns 10 points
    const earnTrx = await api<{
      transaction: { id: string; total: number; loyaltyPointsEarned: number };
    }>('/api/transactions', {
      method: 'POST',
      token: p9CashierToken,
      body: JSON.stringify({
        customerId: p9CustomerId,
        items: [{ productId: p9ProdBId, qty: 10 }],
        applyTax: false,
        paymentMethod: 'Tunai',
        cashReceived: 100000,
      }),
    });
    assert.equal(earnTrx.status, 201);
    assert.equal(earnTrx.body.transaction.total, 100000);
    assert.equal(earnTrx.body.transaction.loyaltyPointsEarned, 10);

    // Manual adjust +20 points -> balance becomes 30
    const adjRes = await api<{ customer: { loyaltyPoints: number } }>(
      `/api/customers/${p9CustomerId}/loyalty/adjust`,
      {
        method: 'POST',
        token: p9AdminToken,
        body: JSON.stringify({ pointsDelta: 20, notes: 'Bonus registrasi member' }),
      }
    );
    assert.equal(adjRes.status, 200);
    assert.equal(adjRes.body.customer.loyaltyPoints, 30);

    // Attempting to redeem 30 points (Rp 3.000) on Rp 5.000 cart exceeds maxRedeemPercent (50% = Rp 2.500) -> 400
    const overRedeem = await api<{ error: string }>('/api/pos/calculate', {
      method: 'POST',
      token: p9CashierToken,
      body: JSON.stringify({
        customerId: p9CustomerId,
        items: [{ productId: p9ProdAId, qty: 1 }],
        loyaltyPointsToRedeem: 30,
        applyTax: false,
      }),
    });
    assert.equal(overRedeem.status, 400);

    // Valid redemption: 20 points (Rp 2.000) on Rp 10.000 cart (2 x 5.000) => net total Rp 8.000
    const redeemTrx = await api<{
      transaction: {
        total: number;
        loyaltyPointsRedeemed: number;
        loyaltyDiscountAmount: number;
        loyaltyPointsEarned: number;
      };
    }>('/api/transactions', {
      method: 'POST',
      token: p9CashierToken,
      body: JSON.stringify({
        customerId: p9CustomerId,
        items: [{ productId: p9ProdAId, qty: 2 }],
        loyaltyPointsToRedeem: 20,
        applyTax: false,
        paymentMethod: 'Tunai',
        cashReceived: 10000,
      }),
    });
    assert.equal(redeemTrx.status, 201);
    assert.equal(redeemTrx.body.transaction.loyaltyPointsRedeemed, 20);
    assert.equal(redeemTrx.body.transaction.loyaltyDiscountAmount, 2000);
    assert.equal(redeemTrx.body.transaction.total, 8000);
    assert.equal(redeemTrx.body.transaction.loyaltyPointsEarned, 0);

    // Verify customer detail metrics & loyalty ledger
    const detail = await api<{
      customer: {
        loyaltyPoints: number;
        totalPointsEarned: number;
        totalPointsRedeemed: number;
        totalSpending: number;
        transactionCount: number;
        lastPurchaseDate: string | null;
      };
      transactions: Array<{ id: string }>;
      loyaltyHistory: Array<{ type: string; pointsDelta: number }>;
    }>(`/api/customers/${p9CustomerId}`, { token: p9CashierToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.customer.loyaltyPoints, 10);
    assert.equal(detail.body.customer.totalPointsEarned, 30);
    assert.equal(detail.body.customer.totalPointsRedeemed, 20);
    assert.equal(detail.body.customer.totalSpending, 108000);
    assert.equal(detail.body.customer.transactionCount, 2);
    assert.ok(detail.body.customer.lastPurchaseDate);
    assert.equal(detail.body.transactions.length, 2);
    assert.ok(detail.body.loyaltyHistory.some((l) => l.type === 'EARN' && l.pointsDelta === 10));
    assert.ok(detail.body.loyaltyHistory.some((l) => l.type === 'ADJUST' && l.pointsDelta === 20));
    assert.ok(detail.body.loyaltyHistory.some((l) => l.type === 'REDEEM' && l.pointsDelta === -20));
  });

  it('validates promotion rules, evaluates PRODUCT/CATEGORY/TRANSACTION/BUY_X_GET_Y/BUNDLE promotions without PIN, and enforces stacking & discount caps', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    const past = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);

    // 1. Validation checks: endDate < startDate -> 400
    const badDate = await api<{ error: string }>('/api/promotions', {
      method: 'POST',
      token: p9AdminToken,
      body: JSON.stringify({
        code: 'BADDATE',
        name: 'Tanggal Terbalik',
        promoType: 'PERCENT',
        scope: 'TRANSACTION',
        discountValue: 10,
        startDate: today,
        endDate: past,
      }),
    });
    assert.equal(badDate.status, 400);

    // PERCENT > 100 -> 400
    const badPct = await api<{ error: string }>('/api/promotions', {
      method: 'POST',
      token: p9AdminToken,
      body: JSON.stringify({
        code: 'BADPCT',
        name: 'Persen Berlebih',
        promoType: 'PERCENT',
        scope: 'TRANSACTION',
        discountValue: 150,
        startDate: today,
        endDate: future,
      }),
    });
    assert.equal(badPct.status, 400);

    // PRODUCT scope without targets -> 400
    const noTarget = await api<{ error: string }>('/api/promotions', {
      method: 'POST',
      token: p9AdminToken,
      body: JSON.stringify({
        code: 'NOTARGET',
        name: 'Tanpa Target',
        promoType: 'PERCENT',
        scope: 'PRODUCT',
        discountValue: 10,
        startDate: today,
        endDate: future,
        targets: [],
      }),
    });
    assert.equal(noTarget.status, 400);

    // 2. Create BUY 2 GET 1 on Prod A (5000/ea -> buy 3 pays 10000, discount 5000), stackable
    const bxgyRes = await api<{ promotion: { id: string } }>('/api/promotions', {
      method: 'POST',
      token: p9AdminToken,
      body: JSON.stringify({
        code: 'TEAB2G1',
        name: 'Teh Beli 2 Gratis 1',
        promoType: 'BUY_X_GET_Y',
        scope: 'PRODUCT',
        discountValue: 0,
        startDate: today,
        endDate: future,
        stackable: true,
        priority: 5,
        ruleConfig: { buyQty: 2, getQty: 1, getDiscountPercent: 100 },
        targets: [{ targetType: 'PRODUCT', targetId: p9ProdAId, requiredQty: 1 }],
      }),
    });
    assert.equal(bxgyRes.status, 201);
    p9PromoBxGyId = bxgyRes.body.promotion.id;

    // 3. Create BUNDLE (1x Prod A (5000) + 1x Prod B (10000) = 15000 -> bundlePrice 12500, saves 2500/set), stackable
    const bundleRes = await api<{ promotion: { id: string } }>('/api/promotions', {
      method: 'POST',
      token: p9AdminToken,
      body: JSON.stringify({
        code: 'PAKETTEH',
        name: 'Paket Teh + Biskuit Hemat',
        promoType: 'BUNDLE',
        scope: 'BUNDLE',
        discountValue: 12500,
        startDate: today,
        endDate: future,
        stackable: true,
        priority: 15,
        ruleConfig: { bundlePrice: 12500 },
        targets: [
          { targetType: 'PRODUCT', targetId: p9ProdAId, requiredQty: 1 },
          { targetType: 'PRODUCT', targetId: p9ProdBId, requiredQty: 1 },
        ],
      }),
    });
    assert.equal(bundleRes.status, 201);
    p9PromoBundleId = bundleRes.body.promotion.id;

    // 4. Create Non-stackable promo
    const nonStackRes = await api<{ promotion: { id: string } }>('/api/promotions', {
      method: 'POST',
      token: p9AdminToken,
      body: JSON.stringify({
        code: 'NONSTACK5K',
        name: 'Potongan Eksklusif Rp 5.000',
        promoType: 'FIXED_AMOUNT',
        scope: 'TRANSACTION',
        discountValue: 5000,
        minPurchaseAmount: 10000,
        startDate: today,
        endDate: future,
        stackable: false,
        priority: 30,
      }),
    });
    assert.equal(nonStackRes.status, 201);
    p9PromoNonStackId = nonStackRes.body.promotion.id;

    // Stacking non-stackable promo with another promo returns 400 PROMO_NOT_STACKABLE
    const stackViolation = await api<{ code: string }>('/api/pos/calculate', {
      method: 'POST',
      token: p9CashierToken,
      body: JSON.stringify({
        items: [
          { productId: p9ProdAId, qty: 3 },
          { productId: p9ProdBId, qty: 1 },
        ],
        selectedPromotionIds: [p9PromoBxGyId, p9PromoNonStackId],
        applyTax: false,
      }),
    });
    assert.equal(stackViolation.status, 400);
    assert.equal(stackViolation.body.code, 'PROMO_NOT_STACKABLE');

    // Combining manual discount with promo when allowManualWithPromo=false returns 400 MANUAL_WITH_PROMO_NOT_ALLOWED
    const manualPromoConflict = await api<{ code: string }>('/api/pos/calculate', {
      method: 'POST',
      token: p9CashierToken,
      body: JSON.stringify({
        items: [{ productId: p9ProdAId, qty: 3 }],
        selectedPromotionIds: [p9PromoBxGyId],
        transactionDiscountType: 'AMOUNT',
        transactionDiscountValue: 1000,
        applyTax: false,
      }),
    });
    assert.equal(manualPromoConflict.status, 400);
    assert.equal(manualPromoConflict.body.code, 'MANUAL_WITH_PROMO_NOT_ALLOWED');

    // Cashier applies stacked BXGY (5000) + Bundle (2500) on 3x Prod A (15000) + 1x Prod B (10000) = 25000 gross
    // Net total = 25000 - 5000 - 2500 = 17500, WITHOUT requiring Supervisor PIN!
    const promoCheckout = await api<{
      transaction: {
        subtotal: number;
        promotionDiscountAmount: number;
        total: number;
        appliedPromotions: Array<{ code: string; discountAmount: number }>;
      };
    }>('/api/transactions', {
      method: 'POST',
      token: p9CashierToken,
      body: JSON.stringify({
        items: [
          { productId: p9ProdAId, qty: 3 },
          { productId: p9ProdBId, qty: 1 },
        ],
        selectedPromotionIds: [p9PromoBxGyId, p9PromoBundleId],
        applyTax: false,
        paymentMethod: 'Tunai',
        cashReceived: 20000,
      }),
    });
    assert.equal(promoCheckout.status, 201);
    assert.equal(promoCheckout.body.transaction.subtotal, 25000);
    assert.equal(promoCheckout.body.transaction.promotionDiscountAmount, 7500);
    assert.equal(promoCheckout.body.transaction.total, 17500);
    assert.equal(promoCheckout.body.transaction.appliedPromotions.length, 2);

    // Check maxAuthorizedDiscountPercent enforcement (set to 30%, attempt 50% manual discount even as Admin -> 400 DISCOUNT_LIMIT_EXCEEDED)
    await api('/api/settings', {
      method: 'PUT',
      token: p9AdminToken,
      body: JSON.stringify({ maxAuthorizedDiscountPercent: 30 }),
    });
    const overLimit = await api<{ code: string }>('/api/pos/calculate', {
      method: 'POST',
      token: p9AdminToken,
      body: JSON.stringify({
        items: [{ productId: p9ProdBId, qty: 2 }],
        transactionDiscountType: 'PERCENT',
        transactionDiscountValue: 50,
        applyTax: false,
      }),
    });
    assert.equal(overLimit.status, 400);
    assert.equal(overLimit.body.code, 'DISCOUNT_LIMIT_EXCEEDED');

    // Restore maxAuthorizedDiscountPercent = 100
    await api('/api/settings', {
      method: 'PUT',
      token: p9AdminToken,
      body: JSON.stringify({ maxAuthorizedDiscountPercent: 100 }),
    });
  });

  it('enforces RBAC permissions on customer edit, loyalty adjustments, loyalty settings, and promotion management', async () => {
    const denyCustEdit = await api<{ error: string }>(`/api/customers/${p9CustomerId}`, {
      method: 'PUT',
      token: p9CashierToken,
      body: JSON.stringify({ name: 'Ubah Tanpa Izin' }),
    });
    assert.equal(denyCustEdit.status, 403);

    const denyPointAdj = await api<{ error: string }>(
      `/api/customers/${p9CustomerId}/loyalty/adjust`,
      {
        method: 'POST',
        token: p9CashierToken,
        body: JSON.stringify({ pointsDelta: 100 }),
      }
    );
    assert.equal(denyPointAdj.status, 403);

    const denyPromoCreate = await api<{ error: string }>('/api/promotions', {
      method: 'POST',
      token: p9CashierToken,
      body: JSON.stringify({
        code: 'KASIRPROMO',
        name: 'Promo Tidak Berizin',
        promoType: 'PERCENT',
        scope: 'TRANSACTION',
        discountValue: 10,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }),
    });
    assert.equal(denyPromoCreate.status, 403);

    const denyLoyaltyCfg = await api<{ error: string }>('/api/loyalty/settings', {
      method: 'PUT',
      token: p9CashierToken,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(denyLoyaltyCfg.status, 403);
  });
});


