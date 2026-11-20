import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import { getDb } from './server/db/database.ts';
import {
  authenticateAccessToken,
  changeOwnPassword,
  listSessions,
  loginWithCredentials,
  logoutSession,
  refreshSessionTokens,
  revokeSessionById,
  verifyPinAuthorization,
} from './server/services/authService.ts';
import {
  addBarcodeToProduct,
  commitProductCsvImport,
  createBrand,
  createCategory,
  createUom,
  deleteProductImage,
  exportProductsToCsv,
  findProductByBarcode,
  getProductById,
  listBrands,
  listCategories,
  listProductsPaginated,
  listUoms,
  previewProductCsvImport,
  removeBarcodeFromProduct,
  resolveUploadedProductImagePath,
  setPrimaryBarcode,
  updateBrand,
  updateCategory,
  updateProductImageMetadata,
  updateUom,
  uploadProductImage,
  type RawCsvImportRow,
} from './server/services/catalogService.ts';
import {
  calculateCartAuthoritative,
  cancelTransaction,
  createCustomer,
  createPaymentMethod,
  getTransactionById,
  holdTransaction,
  listCustomerTransactions,
  listCustomers,
  listHeldTransactions,
  listPaymentMethods,
  listTransactionsPaginated,
  resumeHeldTransaction,
  setPaymentMethodStatus,
} from './server/services/checkoutService.ts';
import {
  adjustCustomerLoyaltyPoints,
  getCustomerDetail,
  getLoyaltySettings,
  setCustomerStatus,
  updateCustomerProfile,
  updateLoyaltySettings,
} from './server/services/customerService.ts';
import { ServiceError } from './server/services/errors.ts';
import {
  approveStockOpname,
  cancelStockOpname,
  createStockAdjustment,
  createStockOpname,
  finalizeStockOpname,
  getProductStockCard,
  getStockBalanceList,
  getStockOpnameDetail,
  listStockAdjustments,
  listStockMovements,
  listStockOpnames,
  listStockReceivings,
  recordStockIn,
  updateProductMinStock,
  updateStockOpnameCounts,
} from './server/services/inventoryService.ts';
import {
  adjustStock,
  createProduct,
  deleteProduct,
  getAuditLogs,
  getBootstrapData,
  processTransaction,
  querySettings,
  setProductStatus,
  updateProduct,
  updateSettings,
} from './server/services/posService.ts';
import {
  createPromotion,
  getPromotionById,
  listPromotions,
  setPromotionStatus,
  updatePromotion,
} from './server/services/promotionService.ts';
import {
  deleteStoreLogo,
  getReceiptData,
  recordReceiptPrint,
  resolveStoreLogoPath,
  uploadStoreLogo,
} from './server/services/receiptService.ts';
import {
  getRecognitionProviderStatuses,
  getRecognitionSettings,
  identifyProductFromImage,
  listRecognitionLogs,
  recordRecognitionFeedback,
  resolveCapturedRecognitionImagePath,
  syncReferenceImageEmbeddings,
  updateRecognitionSettings,
} from './server/services/recognitionService.ts';
import {
  createRole,
  createUser,
  deleteRole,
  getUserDetail,
  listPermissions,
  listRoles,
  listUsers,
  resetUserPasswordOrPin,
  setUserActiveStatus,
  updateRolePermissions,
  updateUser,
} from './server/services/userRoleService.ts';
import type {
  PinSensitiveAction,
  ProductStatus,
  PromotionStatus,
  UserSummary,
} from './src/types.ts';

const PORT = Number(process.env.PORT || 3000);
const ACCESS_COOKIE = 'kassa_access_token';
const REFRESH_COOKIE = 'kassa_refresh_token';

interface AuthenticatedRequest extends Request {
  authUser?: UserSummary;
  sessionId?: string;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

function extractTokens(req: Request): { accessToken?: string; refreshToken?: string } {
  const cookies = parseCookies(req.headers.cookie);
  const authHeader = req.headers.authorization;
  let bearer: string | undefined;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    bearer = authHeader.slice(7).trim();
  }
  return {
    accessToken: bearer || cookies[ACCESS_COOKIE],
    refreshToken: cookies[REFRESH_COOKIE],
  };
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

function setAuthCookies(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string
): void {
  const https = isHttpsRequest(req);
  const sameSite = https ? 'SameSite=None; Secure' : 'SameSite=Lax';
  const common = `HttpOnly; Path=/; ${sameSite}`;
  res.setHeader('Set-Cookie', [
    `${ACCESS_COOKIE}=${encodeURIComponent(accessToken)}; Max-Age=1800; ${common}`,
    `${REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}; Max-Age=604800; ${common}`,
  ]);
}

function clearAuthCookies(req: Request, res: Response): void {
  const https = isHttpsRequest(req);
  const sameSite = https ? 'SameSite=None; Secure' : 'SameSite=Lax';
  const common = `HttpOnly; Path=/; ${sameSite}`;
  res.setHeader('Set-Cookie', [
    `${ACCESS_COOKIE}=; Max-Age=0; ${common}`,
    `${REFRESH_COOKIE}=; Max-Age=0; ${common}`,
  ]);
}

function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const { accessToken } = extractTokens(req);
  if (!accessToken) {
    next(new ServiceError(401, 'Autentikasi diperlukan. Silakan login terlebih dahulu.'));
    return;
  }
  const { user, sessionId } = authenticateAccessToken(accessToken);
  req.authUser = user;
  req.sessionId = sessionId;
  next();
}

function requirePermission(permissionCode: string) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      next(new ServiceError(401, 'Autentikasi diperlukan.'));
      return;
    }
    if (!req.authUser.permissions.includes(permissionCode)) {
      next(
        new ServiceError(
          403,
          `Akses ditolak: Anda tidak memiliki izin "${permissionCode}" untuk melakukan tindakan ini.`
        )
      );
      return;
    }
    next();
  };
}

function requireAnyPermission(permissionCodes: string[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      next(new ServiceError(401, 'Autentikasi diperlukan.'));
      return;
    }
    const allowed = permissionCodes.some((code) => req.authUser!.permissions.includes(code));
    if (!allowed) {
      next(
        new ServiceError(
          403,
          `Akses ditolak: Anda memerlukan salah satu izin (${permissionCodes.join(', ')}) untuk melakukan tindakan ini.`
        )
      );
      return;
    }
    next();
  };
}

export function createApp() {
  // Initialize SQLite database & run migrations on app startup
  getDb();

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Public health check
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Uploaded product images serving endpoint (safe filename & traversal guarded)
  app.get('/api/uploads/products/:fileName', (req, res) => {
    const filePath = resolveUploadedProductImagePath(String(req.params.fileName));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  });

  // Uploaded store logo serving endpoint (safe filename & traversal guarded)
  app.get('/api/uploads/store/:fileName', (req, res) => {
    const filePath = resolveStoreLogoPath(String(req.params.fileName));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  });

  // Captured AI recognition images serving endpoint (safe filename & traversal guarded)
  app.get('/api/uploads/recognition/:fileName', (req, res) => {
    const filePath = resolveCapturedRecognitionImagePath(String(req.params.fileName));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  });

  // Public Digital Receipt Verification (requires cryptographic verification token from QR)
  app.get('/api/receipts/public/:id', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const proto = isHttpsRequest(req) ? 'https' : req.protocol || 'http';
    const host = req.get('host');
    const originUrl = host ? `${proto}://${host}` : undefined;
    const receipt = getReceiptData(String(req.params.id), {
      publicToken: token,
      originUrl,
    });
    res.json({ receipt });
  });

  // --- Authentication & Session Lifecycle (Public) ---
  app.post('/api/auth/login', (req, res) => {
    const { identifier, password } = req.body as { identifier?: string; password?: string };
    const result = loginWithCredentials({
      identifier: typeof identifier === 'string' ? identifier : '',
      password: typeof password === 'string' ? password : '',
      userAgent: String(req.headers['user-agent'] || 'Unknown'),
      ipAddress: String(req.ip || req.socket.remoteAddress || '127.0.0.1'),
    });
    setAuthCookies(req, res, result.accessToken, result.refreshToken);
    res.json({
      user: result.user,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  });

  app.post('/api/auth/refresh', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const bodyToken =
      req.body && typeof (req.body as { refreshToken?: unknown }).refreshToken === 'string'
        ? (req.body as { refreshToken: string }).refreshToken
        : '';
    const token = bodyToken || cookies[REFRESH_COOKIE] || '';
    const result = refreshSessionTokens({
      refreshToken: token,
      userAgent: String(req.headers['user-agent'] || 'Unknown'),
      ipAddress: String(req.ip || req.socket.remoteAddress || '127.0.0.1'),
    });
    setAuthCookies(req, res, result.accessToken, result.refreshToken);
    res.json({
      user: result.user,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const { accessToken, refreshToken } = extractTokens(req);
    const bodyRefresh =
      req.body && typeof (req.body as { refreshToken?: unknown }).refreshToken === 'string'
        ? (req.body as { refreshToken: string }).refreshToken
        : undefined;
    logoutSession({ accessToken, refreshToken: refreshToken || bodyRefresh });
    clearAuthCookies(req, res);
    res.json({ ok: true });
  });

  // --- Protected Authentication Routes ---
  app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({
      user: req.authUser,
      sessionId: req.sessionId,
    });
  });

  app.post('/api/auth/change-password', requireAuth, (req: AuthenticatedRequest, res) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    changeOwnPassword(
      req.authUser!.id,
      typeof currentPassword === 'string' ? currentPassword : '',
      typeof newPassword === 'string' ? newPassword : ''
    );
    res.json({ ok: true });
  });

  app.post('/api/auth/verify-pin', requireAuth, (req: AuthenticatedRequest, res) => {
    const { authorizerIdentifier, pin, action, reason } = req.body as {
      authorizerIdentifier?: string;
      pin?: string;
      action?: PinSensitiveAction;
      reason?: string;
    };
    const result = verifyPinAuthorization({
      authorizerIdentifier: typeof authorizerIdentifier === 'string' ? authorizerIdentifier : '',
      pin: typeof pin === 'string' ? pin : '',
      action: action as PinSensitiveAction,
      reason: typeof reason === 'string' ? reason : undefined,
      requestedBy: req.authUser!,
    });
    res.json(result);
  });

  // --- Protected POS Core Routes ---
  app.get('/api/bootstrap', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json(getBootstrapData(req.authUser));
  });

  app.get(
    '/api/audit-logs',
    requireAuth,
    requirePermission('audit:view'),
    (_req, res) => {
      res.json({ auditLogs: getAuditLogs() });
    }
  );

  // --- Product Master & Catalog APIs (Phase 03) ---
  app.get(
    '/api/products',
    requireAuth,
    requireAnyPermission(['products:view', 'pos:view']),
    (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const result = listProductsPaginated({
        search: q.search,
        categoryId: q.categoryId,
        subcategoryId: q.subcategoryId,
        brandId: q.brandId,
        status: q.status,
        stockStatus: q.stockStatus,
        sortBy: q.sortBy,
        sortDir: q.sortDir,
        page: q.page ? Number(q.page) : 1,
        pageSize: q.pageSize ? Number(q.pageSize) : 25,
      });
      res.json(result);
    }
  );

  app.get(
    '/api/products/barcode/:code',
    requireAuth,
    requireAnyPermission(['products:view', 'pos:view']),
    (req, res) => {
      const product = findProductByBarcode(String(req.params.code));
      res.json({ product });
    }
  );

  app.get(
    '/api/products/export/csv',
    requireAuth,
    requirePermission('products:view'),
    (req: AuthenticatedRequest, res) => {
      const q = req.query as Record<string, string | undefined>;
      const csv = exportProductsToCsv(
        {
          search: q.search,
          categoryId: q.categoryId,
          subcategoryId: q.subcategoryId,
          brandId: q.brandId,
          status: q.status,
          stockStatus: q.stockStatus,
          sortBy: q.sortBy,
          sortDir: q.sortDir,
        },
        req.authUser!
      );
      const today = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="katalog-produk-${today}.csv"`
      );
      res.send(csv);
    }
  );

  app.post(
    '/api/products/import/preview',
    requireAuth,
    requireAnyPermission(['products:import', 'products:create']),
    (req, res) => {
      const { rows } = req.body as { rows?: RawCsvImportRow[] };
      const preview = previewProductCsvImport(Array.isArray(rows) ? rows : []);
      res.json(preview);
    }
  );

  app.post(
    '/api/products/import/commit',
    requireAuth,
    requireAnyPermission(['products:import', 'products:create']),
    (req: AuthenticatedRequest, res) => {
      const { rows } = req.body as { rows?: RawCsvImportRow[] };
      const summary = commitProductCsvImport(Array.isArray(rows) ? rows : [], req.authUser!);
      res.status(201).json({
        ...summary,
        store: getBootstrapData(req.authUser),
      });
    }
  );

  app.get(
    '/api/products/:id',
    requireAuth,
    requireAnyPermission(['products:view', 'pos:view']),
    (req, res) => {
      res.json({ product: getProductById(String(req.params.id)) });
    }
  );

  app.post(
    '/api/products',
    requireAuth,
    requirePermission('products:create'),
    (req: AuthenticatedRequest, res) => {
      const result = createProduct(req.body, req.authUser);
      res.status(201).json(result);
    }
  );

  app.put(
    '/api/products/:id',
    requireAuth,
    requirePermission('products:edit'),
    (req: AuthenticatedRequest, res) => {
      const result = updateProduct(String(req.params.id), req.body, req.authUser);
      res.json(result);
    }
  );

  app.patch(
    '/api/products/:id/status',
    requireAuth,
    requirePermission('products:edit'),
    (req: AuthenticatedRequest, res) => {
      const { status } = req.body as { status?: ProductStatus };
      const result = setProductStatus(String(req.params.id), status as ProductStatus, req.authUser);
      res.json(result);
    }
  );

  app.delete(
    '/api/products/:id',
    requireAuth,
    requirePermission('products:delete'),
    (req: AuthenticatedRequest, res) => {
      const result = deleteProduct(String(req.params.id), req.authUser);
      res.json(result);
    }
  );

  // Product Barcodes sub-API
  app.post(
    '/api/products/:id/barcodes',
    requireAuth,
    requirePermission('products:edit'),
    (req: AuthenticatedRequest, res) => {
      const product = addBarcodeToProduct(String(req.params.id), req.body, req.authUser!);
      res.status(201).json({ product, store: getBootstrapData(req.authUser) });
    }
  );

  app.patch(
    '/api/products/:id/barcodes/:barcodeId/primary',
    requireAuth,
    requirePermission('products:edit'),
    (req: AuthenticatedRequest, res) => {
      const product = setPrimaryBarcode(
        String(req.params.id),
        String(req.params.barcodeId),
        req.authUser!
      );
      res.json({ product, store: getBootstrapData(req.authUser) });
    }
  );

  app.delete(
    '/api/products/:id/barcodes/:barcodeId',
    requireAuth,
    requirePermission('products:edit'),
    (req: AuthenticatedRequest, res) => {
      const product = removeBarcodeFromProduct(
        String(req.params.id),
        String(req.params.barcodeId),
        req.authUser!
      );
      res.json({ product, store: getBootstrapData(req.authUser) });
    }
  );

  // Product Images sub-API
  app.post(
    '/api/products/:id/images',
    requireAuth,
    requirePermission('products:edit'),
    (req: AuthenticatedRequest, res) => {
      const product = uploadProductImage(String(req.params.id), req.body, req.authUser!);
      res.status(201).json({ product, store: getBootstrapData(req.authUser) });
    }
  );

  app.patch(
    '/api/products/:id/images/:imageId',
    requireAuth,
    requirePermission('products:edit'),
    (req: AuthenticatedRequest, res) => {
      const product = updateProductImageMetadata(
        String(req.params.id),
        String(req.params.imageId),
        req.body,
        req.authUser!
      );
      res.json({ product, store: getBootstrapData(req.authUser) });
    }
  );

  app.delete(
    '/api/products/:id/images/:imageId',
    requireAuth,
    requirePermission('products:edit'),
    (req: AuthenticatedRequest, res) => {
      const product = deleteProductImage(
        String(req.params.id),
        String(req.params.imageId),
        req.authUser!
      );
      res.json({ product, store: getBootstrapData(req.authUser) });
    }
  );

  // Categories API
  app.get(
    '/api/categories',
    requireAuth,
    requireAnyPermission(['products:view', 'pos:view', 'catalog:manage']),
    (req, res) => {
      const q = req.query as { search?: string; status?: string };
      res.json({ categories: listCategories(q.search, q.status) });
    }
  );

  app.post(
    '/api/categories',
    requireAuth,
    requireAnyPermission(['catalog:manage', 'products:create']),
    (req: AuthenticatedRequest, res) => {
      const category = createCategory(req.body, req.authUser!);
      res.status(201).json({ category, store: getBootstrapData(req.authUser) });
    }
  );

  app.put(
    '/api/categories/:id',
    requireAuth,
    requireAnyPermission(['catalog:manage', 'products:edit']),
    (req: AuthenticatedRequest, res) => {
      const category = updateCategory(String(req.params.id), req.body, req.authUser!);
      res.json({ category, store: getBootstrapData(req.authUser) });
    }
  );

  app.patch(
    '/api/categories/:id/status',
    requireAuth,
    requireAnyPermission(['catalog:manage', 'products:edit']),
    (req: AuthenticatedRequest, res) => {
      const { isActive } = req.body as { isActive?: unknown };
      if (typeof isActive !== 'boolean') {
        throw new ServiceError(400, 'Field isActive harus berupa boolean.');
      }
      const category = updateCategory(String(req.params.id), { isActive }, req.authUser!);
      res.json({ category, store: getBootstrapData(req.authUser) });
    }
  );

  // Brands API
  app.get(
    '/api/brands',
    requireAuth,
    requireAnyPermission(['products:view', 'pos:view', 'catalog:manage']),
    (req, res) => {
      const q = req.query as { search?: string; status?: string };
      res.json({ brands: listBrands(q.search, q.status) });
    }
  );

  app.post(
    '/api/brands',
    requireAuth,
    requireAnyPermission(['catalog:manage', 'products:create']),
    (req: AuthenticatedRequest, res) => {
      const brand = createBrand(req.body, req.authUser!);
      res.status(201).json({ brand, store: getBootstrapData(req.authUser) });
    }
  );

  app.put(
    '/api/brands/:id',
    requireAuth,
    requireAnyPermission(['catalog:manage', 'products:edit']),
    (req: AuthenticatedRequest, res) => {
      const brand = updateBrand(String(req.params.id), req.body, req.authUser!);
      res.json({ brand, store: getBootstrapData(req.authUser) });
    }
  );

  app.patch(
    '/api/brands/:id/status',
    requireAuth,
    requireAnyPermission(['catalog:manage', 'products:edit']),
    (req: AuthenticatedRequest, res) => {
      const { isActive } = req.body as { isActive?: unknown };
      if (typeof isActive !== 'boolean') {
        throw new ServiceError(400, 'Field isActive harus berupa boolean.');
      }
      const brand = updateBrand(String(req.params.id), { isActive }, req.authUser!);
      res.json({ brand, store: getBootstrapData(req.authUser) });
    }
  );

  // Units of Measure (UOM) API
  app.get(
    '/api/uoms',
    requireAuth,
    requireAnyPermission(['products:view', 'pos:view', 'catalog:manage']),
    (req, res) => {
      const q = req.query as { search?: string };
      res.json({ uoms: listUoms(q.search) });
    }
  );

  app.post(
    '/api/uoms',
    requireAuth,
    requireAnyPermission(['catalog:manage', 'products:create']),
    (req: AuthenticatedRequest, res) => {
      const uom = createUom(req.body, req.authUser!);
      res.status(201).json({ uom, store: getBootstrapData(req.authUser) });
    }
  );

  app.put(
    '/api/uoms/:id',
    requireAuth,
    requireAnyPermission(['catalog:manage', 'products:edit']),
    (req: AuthenticatedRequest, res) => {
      const uom = updateUom(String(req.params.id), req.body, req.authUser!);
      res.json({ uom, store: getBootstrapData(req.authUser) });
    }
  );

  app.patch(
    '/api/uoms/:id/status',
    requireAuth,
    requireAnyPermission(['catalog:manage', 'products:edit']),
    (req: AuthenticatedRequest, res) => {
      const { isActive } = req.body as { isActive?: unknown };
      if (typeof isActive !== 'boolean') {
        throw new ServiceError(400, 'Field isActive harus berupa boolean.');
      }
      const uom = updateUom(String(req.params.id), { isActive }, req.authUser!);
      res.json({ uom, store: getBootstrapData(req.authUser) });
    }
  );

  app.post('/api/stock/adjust', requireAuth, (req: AuthenticatedRequest, res) => {
    const result = adjustStock(req.body, req.authUser);
    res.json(result);
  });

  // --- Phase 06 Inventory & Stock Control APIs ---
  app.get(
    '/api/inventory/stock-balance',
    requireAuth,
    requireAnyPermission(['stock:view', 'reports:view', 'products:view']),
    (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const result = getStockBalanceList({
        search: q.search,
        stockStatus: q.stockStatus,
        categoryId: q.categoryId,
        productStatus: q.productStatus,
        page: q.page ? Number(q.page) : 1,
        pageSize: q.pageSize ? Number(q.pageSize) : 50,
      });
      res.json(result);
    }
  );

  app.patch(
    '/api/inventory/products/:id/min-stock',
    requireAuth,
    requireAnyPermission(['stock:adjust', 'products:edit']),
    (req: AuthenticatedRequest, res) => {
      const { minStock } = req.body as { minStock?: unknown };
      const result = updateProductMinStock(String(req.params.id), minStock, req.authUser!);
      res.json({ ...result, store: getBootstrapData(req.authUser) });
    }
  );

  app.get(
    '/api/inventory/products/:id/stock-card',
    requireAuth,
    requireAnyPermission(['stock:view', 'reports:view', 'products:view']),
    (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const card = getProductStockCard(String(req.params.id), {
        type: q.type,
        dateFrom: q.dateFrom,
        dateTo: q.dateTo,
      });
      res.json(card);
    }
  );

  app.get(
    '/api/inventory/movements',
    requireAuth,
    requireAnyPermission(['stock:view', 'reports:view']),
    (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const movements = listStockMovements({
        productId: q.productId,
        type: q.type,
        search: q.search,
        dateFrom: q.dateFrom,
        dateTo: q.dateTo,
        limit: q.limit ? Number(q.limit) : 400,
      });
      res.json({ movements });
    }
  );

  app.get(
    '/api/inventory/stock-in',
    requireAuth,
    requireAnyPermission(['stock:view', 'reports:view']),
    (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const receivings = listStockReceivings({
        search: q.search,
        productId: q.productId,
        dateFrom: q.dateFrom,
        dateTo: q.dateTo,
        limit: q.limit ? Number(q.limit) : 200,
      });
      res.json({ receivings });
    }
  );

  app.post('/api/inventory/stock-in', requireAuth, (req: AuthenticatedRequest, res) => {
    const result = recordStockIn(req.body, req.authUser!);
    res.status(201).json({ ...result, store: getBootstrapData(req.authUser) });
  });

  app.get(
    '/api/inventory/adjustments',
    requireAuth,
    requireAnyPermission(['stock:view', 'reports:view']),
    (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const adjustments = listStockAdjustments({
        search: q.search,
        productId: q.productId,
        direction: q.direction,
        limit: q.limit ? Number(q.limit) : 200,
      });
      res.json({ adjustments });
    }
  );

  app.post('/api/inventory/adjustments', requireAuth, (req: AuthenticatedRequest, res) => {
    const result = createStockAdjustment(req.body, req.authUser!);
    res.status(201).json({ ...result, store: getBootstrapData(req.authUser) });
  });

  app.get(
    '/api/inventory/opnames',
    requireAuth,
    requireAnyPermission(['stock:view', 'reports:view']),
    (req, res) => {
      const q = req.query as { status?: string };
      res.json({ opnames: listStockOpnames(q.status) });
    }
  );

  app.get(
    '/api/inventory/opnames/:id',
    requireAuth,
    requireAnyPermission(['stock:view', 'reports:view']),
    (req, res) => {
      res.json({ opname: getStockOpnameDetail(String(req.params.id)) });
    }
  );

  app.post(
    '/api/inventory/opnames',
    requireAuth,
    requirePermission('stock:adjust'),
    (req: AuthenticatedRequest, res) => {
      const opname = createStockOpname(req.body || {}, req.authUser!);
      res.status(201).json({ opname });
    }
  );

  app.put(
    '/api/inventory/opnames/:id/counts',
    requireAuth,
    requirePermission('stock:adjust'),
    (req: AuthenticatedRequest, res) => {
      const opname = updateStockOpnameCounts(String(req.params.id), req.body || {}, req.authUser!);
      res.json({ opname });
    }
  );

  app.post('/api/inventory/opnames/:id/approve', requireAuth, (req: AuthenticatedRequest, res) => {
    const opname = approveStockOpname(String(req.params.id), req.body || {}, req.authUser!);
    res.json({ opname });
  });

  app.post(
    '/api/inventory/opnames/:id/finalize',
    requireAuth,
    requirePermission('stock:adjust'),
    (req: AuthenticatedRequest, res) => {
      const opname = finalizeStockOpname(String(req.params.id), req.authUser!);
      res.json({ opname, store: getBootstrapData(req.authUser) });
    }
  );

  app.post(
    '/api/inventory/opnames/:id/cancel',
    requireAuth,
    requirePermission('stock:adjust'),
    (req: AuthenticatedRequest, res) => {
      const { reason } = (req.body || {}) as { reason?: string };
      const opname = cancelStockOpname(
        String(req.params.id),
        typeof reason === 'string' ? reason : undefined,
        req.authUser!
      );
      res.json({ opname });
    }
  );

  // --- Phase 09 Customer & Loyalty APIs ---
  app.get(
    '/api/customers',
    requireAuth,
    requireAnyPermission(['customers:view', 'pos:view', 'transactions:view']),
    (req, res) => {
      const q = req.query as { search?: string; status?: string };
      res.json({ customers: listCustomers(q.search, q.status) });
    }
  );

  app.get(
    '/api/customers/:id',
    requireAuth,
    requireAnyPermission(['customers:view', 'pos:view', 'transactions:view']),
    (req, res) => {
      const detail = getCustomerDetail(String(req.params.id), (custId) =>
        listCustomerTransactions(custId, 100)
      );
      res.json(detail);
    }
  );

  app.post(
    '/api/customers',
    requireAuth,
    requireAnyPermission(['customers:create', 'pos:create', 'pos:view']),
    (req: AuthenticatedRequest, res) => {
      const customer = createCustomer(req.body, req.authUser!);
      res.status(201).json({ customer, store: getBootstrapData(req.authUser) });
    }
  );

  app.put(
    '/api/customers/:id',
    requireAuth,
    requirePermission('customers:edit'),
    (req: AuthenticatedRequest, res) => {
      const customer = updateCustomerProfile(String(req.params.id), req.body, req.authUser!);
      res.json({ customer, store: getBootstrapData(req.authUser) });
    }
  );

  app.patch(
    '/api/customers/:id/status',
    requireAuth,
    requirePermission('customers:edit'),
    (req: AuthenticatedRequest, res) => {
      const { isActive } = req.body as { isActive?: unknown };
      if (typeof isActive !== 'boolean') {
        throw new ServiceError(400, 'Field isActive harus berupa boolean.');
      }
      const customer = setCustomerStatus(String(req.params.id), isActive, req.authUser!);
      res.json({ customer, store: getBootstrapData(req.authUser) });
    }
  );

  app.post(
    '/api/customers/:id/loyalty/adjust',
    requireAuth,
    requirePermission('customers:edit'),
    (req: AuthenticatedRequest, res) => {
      const result = adjustCustomerLoyaltyPoints(String(req.params.id), req.body, req.authUser!);
      res.json({ ...result, store: getBootstrapData(req.authUser) });
    }
  );

  app.get(
    '/api/loyalty/settings',
    requireAuth,
    requireAnyPermission([
      'pos:view',
      'customers:view',
      'promotions:view',
      'promotions:manage',
      'settings:edit',
    ]),
    (_req, res) => {
      res.json({ loyaltySettings: getLoyaltySettings() });
    }
  );

  app.put(
    '/api/loyalty/settings',
    requireAuth,
    requireAnyPermission(['promotions:manage', 'settings:edit']),
    (req: AuthenticatedRequest, res) => {
      const loyaltySettings = updateLoyaltySettings(req.body, req.authUser!);
      res.json({ loyaltySettings, store: getBootstrapData(req.authUser) });
    }
  );

  // --- Phase 09 Promotion APIs ---
  app.get(
    '/api/promotions',
    requireAuth,
    requireAnyPermission(['promotions:view', 'promotions:manage', 'pos:view']),
    (req, res) => {
      const q = req.query as {
        search?: string;
        status?: string;
        scope?: string;
        activeOnly?: string;
      };
      const promotions = listPromotions({
        search: q.search,
        status: q.status,
        scope: q.scope,
        activeOnly: q.activeOnly === 'true' || q.activeOnly === '1',
      });
      res.json({ promotions });
    }
  );

  app.post(
    '/api/promotions/evaluate',
    requireAuth,
    requireAnyPermission(['pos:view', 'pos:create']),
    (req, res) => {
      const settings = querySettings();
      const calc = calculateCartAuthoritative(req.body, settings, {
        checkStock: false,
        strictPromotions: false,
      });
      res.json({
        preview: calc.preview,
        eligiblePromotions: calc.preview.eligiblePromotions,
      });
    }
  );

  app.get(
    '/api/promotions/:id',
    requireAuth,
    requireAnyPermission(['promotions:view', 'promotions:manage', 'pos:view']),
    (req, res) => {
      res.json({ promotion: getPromotionById(String(req.params.id)) });
    }
  );

  app.post(
    '/api/promotions',
    requireAuth,
    requirePermission('promotions:manage'),
    (req: AuthenticatedRequest, res) => {
      const promotion = createPromotion(req.body, req.authUser!);
      res.status(201).json({ promotion, store: getBootstrapData(req.authUser) });
    }
  );

  app.put(
    '/api/promotions/:id',
    requireAuth,
    requirePermission('promotions:manage'),
    (req: AuthenticatedRequest, res) => {
      const promotion = updatePromotion(String(req.params.id), req.body, req.authUser!);
      res.json({ promotion, store: getBootstrapData(req.authUser) });
    }
  );

  app.patch(
    '/api/promotions/:id/status',
    requireAuth,
    requirePermission('promotions:manage'),
    (req: AuthenticatedRequest, res) => {
      const { status } = req.body as { status?: PromotionStatus };
      const promotion = setPromotionStatus(
        String(req.params.id),
        status as PromotionStatus,
        req.authUser!
      );
      res.json({ promotion, store: getBootstrapData(req.authUser) });
    }
  );

  app.get(
    '/api/payment-methods',
    requireAuth,
    requireAnyPermission(['pos:view', 'transactions:view', 'settings:edit']),
    (req, res) => {
      const includeInactive = req.query.includeInactive === 'true' || req.query.includeInactive === '1';
      res.json({ paymentMethods: listPaymentMethods(includeInactive) });
    }
  );

  app.post(
    '/api/payment-methods',
    requireAuth,
    requirePermission('settings:edit'),
    (req: AuthenticatedRequest, res) => {
      const paymentMethod = createPaymentMethod(req.body, req.authUser!);
      res.status(201).json({ paymentMethod, store: getBootstrapData(req.authUser) });
    }
  );

  app.patch(
    '/api/payment-methods/:id/status',
    requireAuth,
    requirePermission('settings:edit'),
    (req: AuthenticatedRequest, res) => {
      const { isActive } = req.body as { isActive?: unknown };
      if (typeof isActive !== 'boolean') {
        throw new ServiceError(400, 'Field isActive harus berupa boolean.');
      }
      const paymentMethod = setPaymentMethodStatus(String(req.params.id), isActive, req.authUser!);
      res.json({ paymentMethod, store: getBootstrapData(req.authUser) });
    }
  );

  app.post(
    '/api/pos/calculate',
    requireAuth,
    requireAnyPermission(['pos:view', 'pos:create']),
    (req, res) => {
      const settings = querySettings();
      const calc = calculateCartAuthoritative(req.body, settings, { checkStock: true });
      res.json(calc.preview);
    }
  );

  app.get(
    '/api/transactions',
    requireAuth,
    requireAnyPermission(['transactions:view', 'pos:view']),
    (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const result = listTransactionsPaginated({
        search: q.search,
        status: q.status,
        paymentStatus: q.paymentStatus,
        paymentMethod: q.paymentMethod,
        dateFrom: q.dateFrom,
        dateTo: q.dateTo,
        page: q.page ? Number(q.page) : 1,
        pageSize: q.pageSize ? Number(q.pageSize) : 25,
      });
      res.json(result);
    }
  );

  app.get(
    '/api/transactions/held',
    requireAuth,
    requireAnyPermission(['pos:view', 'transactions:view', 'pos:hold', 'pos:resume']),
    (_req, res) => {
      res.json({ transactions: listHeldTransactions() });
    }
  );

  app.get(
    '/api/transactions/:id',
    requireAuth,
    requireAnyPermission(['transactions:view', 'pos:view']),
    (req, res) => {
      res.json({ transaction: getTransactionById(String(req.params.id)) });
    }
  );

  app.post(
    '/api/transactions/hold',
    requireAuth,
    requirePermission('pos:hold'),
    (req: AuthenticatedRequest, res) => {
      const transaction = holdTransaction(req.body, req.authUser!);
      res.status(201).json({ transaction, store: getBootstrapData(req.authUser) });
    }
  );

  app.post(
    '/api/transactions/:id/resume',
    requireAuth,
    requirePermission('pos:resume'),
    (req: AuthenticatedRequest, res) => {
      const transaction = resumeHeldTransaction(String(req.params.id), req.authUser!);
      res.json({ transaction, store: getBootstrapData(req.authUser) });
    }
  );

  app.post(
    '/api/transactions/:id/cancel',
    requireAuth,
    requirePermission('pos:cancel'),
    (req: AuthenticatedRequest, res) => {
      const { reason } = (req.body || {}) as { reason?: string };
      const transaction = cancelTransaction(
        String(req.params.id),
        typeof reason === 'string' ? reason : undefined,
        req.authUser!
      );
      res.json({ transaction, store: getBootstrapData(req.authUser) });
    }
  );

  app.delete('/api/transactions/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const existing = getTransactionById(String(req.params.id));
    if (existing.status === 'COMPLETED') {
      throw new ServiceError(
        409,
        'Transaksi yang sudah selesai (COMPLETED) tidak dapat dihapus secara fisik.'
      );
    }
    if (!req.authUser!.permissions.includes('pos:cancel')) {
      throw new ServiceError(
        403,
        'Akses ditolak: Anda tidak memiliki izin "pos:cancel" untuk membatalkan transaksi.'
      );
    }
    const transaction = cancelTransaction(existing.id, 'Dibatalkan melalui API', req.authUser!);
    res.json({ transaction, store: getBootstrapData(req.authUser) });
  });

  app.post(
    '/api/transactions',
    requireAuth,
    requirePermission('pos:create'),
    (req: AuthenticatedRequest, res) => {
      const result = processTransaction(req.body, req.authUser);
      res.status(result.idempotentReplay ? 200 : 201).json(result);
    }
  );

  app.get(
    '/api/transactions/:id/receipt',
    requireAuth,
    requireAnyPermission(['transactions:view', 'pos:view', 'pos:create']),
    (req, res) => {
      const proto = isHttpsRequest(req) ? 'https' : req.protocol || 'http';
      const host = req.get('host');
      const originUrl = host ? `${proto}://${host}` : undefined;
      const receipt = getReceiptData(String(req.params.id), { originUrl });
      res.json({ receipt });
    }
  );

  app.post(
    '/api/transactions/:id/receipt/print',
    requireAuth,
    requireAnyPermission(['transactions:view', 'pos:create']),
    (req: AuthenticatedRequest, res) => {
      const proto = isHttpsRequest(req) ? 'https' : req.protocol || 'http';
      const host = req.get('host');
      const originUrl = host ? `${proto}://${host}` : undefined;
      const result = recordReceiptPrint(
        String(req.params.id),
        (req.body || {}) as { layoutFormat?: unknown; driverId?: unknown },
        req.authUser!,
        originUrl
      );
      res.json({ ...result, store: getBootstrapData(req.authUser) });
    }
  );

  app.put(
    '/api/settings',
    requireAuth,
    requirePermission('settings:edit'),
    (req: AuthenticatedRequest, res) => {
      const result = updateSettings(req.body, req.authUser);
      res.json(result);
    }
  );

  app.post(
    '/api/settings/logo',
    requireAuth,
    requirePermission('settings:edit'),
    (req: AuthenticatedRequest, res) => {
      const result = uploadStoreLogo(
        (req.body || {}) as { fileName?: unknown; mimeType?: unknown; dataBase64?: unknown },
        req.authUser!
      );
      res.status(201).json({ ...result, store: getBootstrapData(req.authUser) });
    }
  );

  app.delete(
    '/api/settings/logo',
    requireAuth,
    requirePermission('settings:edit'),
    (req: AuthenticatedRequest, res) => {
      const result = deleteStoreLogo(req.authUser!);
      res.json({ ...result, store: getBootstrapData(req.authUser) });
    }
  );

  // --- Protected User Management Routes ---
  app.get(
    '/api/users',
    requireAuth,
    requirePermission('users:view'),
    (_req, res) => {
      res.json({ users: listUsers() });
    }
  );

  app.get('/api/users/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const targetId = String(req.params.id);
    if (targetId !== req.authUser!.id && !req.authUser!.permissions.includes('users:view')) {
      throw new ServiceError(403, 'Akses ditolak: Anda tidak memiliki izin melihat detail pengguna.');
    }
    res.json({ user: getUserDetail(targetId) });
  });

  app.post(
    '/api/users',
    requireAuth,
    requirePermission('users:create'),
    (req: AuthenticatedRequest, res) => {
      const created = createUser(req.body, req.authUser!);
      res.status(201).json({ user: created });
    }
  );

  app.put(
    '/api/users/:id',
    requireAuth,
    requirePermission('users:edit'),
    (req: AuthenticatedRequest, res) => {
      const updated = updateUser(String(req.params.id), req.body, req.authUser!);
      res.json({ user: updated });
    }
  );

  app.patch(
    '/api/users/:id/status',
    requireAuth,
    requirePermission('users:edit'),
    (req: AuthenticatedRequest, res) => {
      const { isActive } = req.body as { isActive?: unknown };
      if (typeof isActive !== 'boolean') {
        throw new ServiceError(400, 'Field isActive harus berupa boolean.');
      }
      const updated = setUserActiveStatus(String(req.params.id), isActive, req.authUser!);
      res.json({ user: updated });
    }
  );

  app.post(
    '/api/users/:id/reset-password',
    requireAuth,
    requirePermission('users:edit'),
    (req: AuthenticatedRequest, res) => {
      const updated = resetUserPasswordOrPin(String(req.params.id), req.body, req.authUser!);
      res.json({ user: updated });
    }
  );

  // --- Protected Role & Permission Routes ---
  app.get(
    '/api/roles',
    requireAuth,
    requirePermission('roles:view'),
    (_req, res) => {
      res.json({ roles: listRoles() });
    }
  );

  app.get(
    '/api/permissions',
    requireAuth,
    requirePermission('roles:view'),
    (_req, res) => {
      res.json({ permissions: listPermissions() });
    }
  );

  app.post(
    '/api/roles',
    requireAuth,
    requirePermission('roles:edit'),
    (req: AuthenticatedRequest, res) => {
      const role = createRole(req.body, req.authUser!);
      res.status(201).json({ role });
    }
  );

  app.put(
    '/api/roles/:id',
    requireAuth,
    requirePermission('roles:edit'),
    (req: AuthenticatedRequest, res) => {
      const role = updateRolePermissions(String(req.params.id), req.body, req.authUser!);
      res.json({ role });
    }
  );

  app.put(
    '/api/roles/:id/permissions',
    requireAuth,
    requirePermission('roles:edit'),
    (req: AuthenticatedRequest, res) => {
      const role = updateRolePermissions(String(req.params.id), req.body, req.authUser!);
      res.json({ role });
    }
  );

  app.delete(
    '/api/roles/:id',
    requireAuth,
    requirePermission('roles:edit'),
    (req: AuthenticatedRequest, res) => {
      deleteRole(String(req.params.id), req.authUser!);
      res.json({ ok: true });
    }
  );

  // --- Protected Session Management Routes ---
  app.get('/api/sessions', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ sessions: listSessions(req.authUser!, req.sessionId!) });
  });

  app.delete('/api/sessions/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    revokeSessionById(String(req.params.id), req.authUser!);
    res.json({ ok: true });
  });

  // --- Phase 08 AI Product Recognition APIs ---
  app.get(
    '/api/recognition/providers',
    requireAuth,
    requireAnyPermission(['recognition:use', 'recognition:manage', 'pos:view', 'products:view']),
    (_req, res) => {
      res.json(getRecognitionProviderStatuses());
    }
  );

  app.get(
    '/api/recognition/settings',
    requireAuth,
    requireAnyPermission(['recognition:use', 'recognition:manage', 'pos:view', 'settings:edit']),
    (_req, res) => {
      res.json({ settings: getRecognitionSettings() });
    }
  );

  app.put(
    '/api/recognition/settings',
    requireAuth,
    requireAnyPermission(['recognition:manage', 'settings:edit']),
    (req: AuthenticatedRequest, res) => {
      const settings = updateRecognitionSettings(req.body, req.authUser!);
      res.json({ settings, providers: getRecognitionProviderStatuses().providers });
    }
  );

  app.post(
    '/api/recognition/identify',
    requireAuth,
    requireAnyPermission(['recognition:use', 'pos:view', 'products:view', 'stock:view']),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const result = await identifyProductFromImage(req.body, req.authUser!);
        res.json({ result });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/recognition/references/sync',
    requireAuth,
    requireAnyPermission(['recognition:manage', 'products:edit', 'catalog:manage']),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const body = (req.body || {}) as {
          productId?: string;
          providerId?: string;
          force?: boolean;
          limit?: number;
        };
        const summary = await syncReferenceImageEmbeddings(
          {
            productId: body.productId,
            providerId: body.providerId,
            force: Boolean(body.force),
            limit: body.limit,
          },
          req.authUser!
        );
        res.json({ summary, store: getBootstrapData(req.authUser) });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/recognition/logs/:id/feedback',
    requireAuth,
    requireAnyPermission(['recognition:use', 'pos:view', 'products:view', 'stock:view']),
    (req: AuthenticatedRequest, res) => {
      const log = recordRecognitionFeedback(String(req.params.id), req.body, req.authUser!);
      res.json({
        log,
        store: req.body?.promoteAsReferenceImage ? getBootstrapData(req.authUser) : undefined,
      });
    }
  );

  app.get(
    '/api/recognition/logs',
    requireAuth,
    requireAnyPermission(['recognition:use', 'recognition:manage', 'audit:view', 'pos:view']),
    (req, res) => {
      const q = req.query as { outcome?: string; limit?: string };
      const logs = listRecognitionLogs({
        outcome: q.outcome,
        limit: q.limit ? Number(q.limit) : 50,
      });
      res.json({ logs });
    }
  );

  // Centralized API error handler
  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceError) {
      res.status(err.statusCode).json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
      return;
    }
    console.error('Unhandled API error:', err);
    const message = err instanceof Error ? err.message : 'Terjadi kesalahan internal pada server.';
    res.status(500).json({ error: message });
  });

  return app;
}

async function startServer() {
  const app = createApp();

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`KassaRitel POS server listening on http://0.0.0.0:${PORT}`);
  });
}

if (process.env.POS_SKIP_LISTEN !== '1') {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
