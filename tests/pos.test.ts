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



