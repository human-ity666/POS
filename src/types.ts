export type ProductCategory =
  | 'Sembako'
  | 'Minuman'
  | 'Makanan Ringan'
  | 'Perawatan Diri'
  | 'Rumah Tangga'
  | 'Lainnya';

export const PRODUCT_CATEGORIES: ProductCategory[] = [
  'Sembako',
  'Minuman',
  'Makanan Ringan',
  'Perawatan Diri',
  'Rumah Tangga',
  'Lainnya',
];

export type BarcodeType =
  | 'EAN-13'
  | 'EAN-8'
  | 'UPC-A'
  | 'UPC-E'
  | 'CODE-128'
  | 'CODE-39'
  | 'QR'
  | 'INTERNAL';

export const BARCODE_TYPES: BarcodeType[] = [
  'EAN-13',
  'EAN-8',
  'UPC-A',
  'UPC-E',
  'CODE-128',
  'CODE-39',
  'QR',
  'INTERNAL',
];

export type TaxCategory = 'STANDARD' | 'EXEMPT' | 'REDUCED';

export type ProductStatus = 'ACTIVE' | 'INACTIVE';

export type ImageReferenceAngle = 'front' | 'back' | 'side' | 'top' | 'packaging' | 'other';

export interface Category {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  parentName?: string | null;
  description: string;
  isActive: boolean;
  productCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Brand {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  productCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface UnitOfMeasure {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  isActive: boolean;
  productCount?: number;
  createdAt: string;
}

export interface ProductBarcode {
  id: string;
  productId: string;
  barcode: string;
  barcodeType: BarcodeType;
  isPrimary: boolean;
  createdAt: string;
}

export interface ProductImage {
  id: string;
  productId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  imageUrl: string;
  isPrimary: boolean;
  isAiReference: boolean;
  referenceAngle: ImageReferenceAngle;
  aiEmbeddingStatus: 'PENDING' | 'READY' | 'NOT_APPLICABLE';
  createdAt: string;
}

export interface Product {
  id: string;
  sku: string;
  barcode: string;
  name: string;
  description: string;
  brandId: string | null;
  brandName: string;
  categoryId: string | null;
  category: string;
  subcategoryId: string | null;
  subcategoryName: string;
  uomId: string | null;
  unit: string;
  variant: string;
  size: string;
  weight: number | null;
  volume: number | null;
  costPrice: number;
  sellPrice: number;
  specialPrice: number | null;
  taxCategory: TaxCategory;
  stock: number;
  minStock: number;
  status: ProductStatus;
  primaryImageId: string | null;
  primaryImageUrl: string | null;
  barcodes: ProductBarcode[];
  images: ProductImage[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductListResponse {
  products: Product[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CsvImportPreviewRow {
  rowNumber: number;
  sku: string;
  barcode: string;
  barcodeType: BarcodeType;
  name: string;
  category: string;
  subcategory: string;
  brand: string;
  unit: string;
  costPrice: number;
  sellPrice: number;
  specialPrice: number | null;
  stock: number;
  minStock: number;
  variant: string;
  size: string;
  weight: number | null;
  volume: number | null;
  taxCategory: TaxCategory;
  status: ProductStatus;
  description: string;
  valid: boolean;
  errors: string[];
}

export interface CsvImportPreviewResult {
  totalRows: number;
  validCount: number;
  errorCount: number;
  rows: CsvImportPreviewRow[];
}

export type DiscountMode = 'AMOUNT' | 'PERCENT';

export type TransactionStatus = 'NEW' | 'IN_PROGRESS' | 'HELD' | 'CANCELLED' | 'COMPLETED';

export type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'CANCELLED';

export type PaymentMethodType = 'CASH' | 'DEBIT' | 'CREDIT' | 'QRIS' | 'OTHER';

export interface Customer {
  id: string;
  code: string;
  membershipNumber: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  isActive: boolean;
  loyaltyPoints: number;
  totalPointsEarned: number;
  totalPointsRedeemed: number;
  totalSpending: number;
  transactionCount: number;
  lastPurchaseDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LoyaltyPointTransactionType = 'EARN' | 'REDEEM' | 'ADJUST';

export interface LoyaltyPointTransaction {
  id: string;
  customerId: string;
  transactionId: string | null;
  type: LoyaltyPointTransactionType;
  pointsDelta: number;
  pointsBefore: number;
  pointsAfter: number;
  referenceNumber: string;
  notes: string;
  actorUserId: string | null;
  actorName: string;
  createdAt: string;
}

export interface LoyaltySettings {
  enabled: boolean;
  pointsPerAmount: number;
  pointValueRp: number;
  minRedeemPoints: number;
  maxRedeemPercent: number;
  updatedAt: string;
}

export interface CustomerDetailResponse {
  customer: Customer;
  transactions: Transaction[];
  loyaltyHistory: LoyaltyPointTransaction[];
}

export type PromotionType =
  | 'PERCENT'
  | 'FIXED_AMOUNT'
  | 'SPECIAL_PRICE'
  | 'BUY_X_GET_Y'
  | 'BUNDLE';

export type PromotionScope = 'PRODUCT' | 'TRANSACTION' | 'CATEGORY' | 'BUNDLE';

export type PromotionStatus = 'ACTIVE' | 'INACTIVE';

export type PromotionEffectiveStatus = 'ACTIVE' | 'INACTIVE' | 'SCHEDULED' | 'EXPIRED';

export interface PromotionTarget {
  id: string;
  promotionId: string;
  targetType: 'PRODUCT' | 'CATEGORY';
  targetId: string;
  targetName?: string;
  requiredQty: number;
}

export interface PromotionRuleConfig {
  buyQty?: number;
  getQty?: number;
  getProductId?: string;
  getDiscountPercent?: number;
  bundlePrice?: number;
}

export interface Promotion {
  id: string;
  code: string;
  name: string;
  description: string;
  promoType: PromotionType;
  scope: PromotionScope;
  discountValue: number;
  maxDiscountAmount: number | null;
  minPurchaseAmount: number;
  minQty: number;
  startDate: string;
  endDate: string;
  status: PromotionStatus;
  effectiveStatus: PromotionEffectiveStatus;
  stackable: boolean;
  priority: number;
  ruleConfig: PromotionRuleConfig;
  targets: PromotionTarget[];
  usageCount: number;
  createdByUserId: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppliedPromotionSummary {
  id: string;
  code: string;
  name: string;
  promoType: PromotionType;
  scope: PromotionScope;
  discountAmount: number;
}

export interface PromotionEligibilityItem {
  promotion: Promotion;
  eligible: boolean;
  estimatedDiscount: number;
  reason?: string;
}

export interface PaymentMethodConfig {
  id: string;
  code: string;
  name: string;
  type: PaymentMethodType;
  requiresReference: boolean;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface TransactionPaymentRecord {
  id: string;
  paymentMethodId: string | null;
  paymentMethodName: string;
  paymentType: PaymentMethodType;
  amount: number;
  tenderedAmount: number;
  changeAmount: number;
  referenceNumber: string;
  createdAt: string;
}

export interface TransactionItem {
  productId: string;
  sku?: string;
  barcode: string;
  name: string;
  unit: string;
  qty: number;
  originalSellPrice?: number;
  sellPrice: number;
  priceOverride?: boolean;
  costPrice: number;
  lineDiscountType?: DiscountMode;
  lineDiscountValue?: number;
  lineDiscountAmount?: number;
  taxCategory?: TaxCategory;
  taxAmount?: number;
  promotionId?: string | null;
  promotionName?: string;
  promotionDiscountAmount?: number;
  subtotal: number;
}

export type PaymentMethod = string;

export interface Transaction {
  id: string;
  invoiceNumber: string;
  status: TransactionStatus;
  paymentStatus: PaymentStatus;
  customerId: string | null;
  customerName: string;
  items: TransactionItem[];
  payments?: TransactionPaymentRecord[];
  subtotal: number;
  lineDiscountTotal: number;
  transactionDiscountType: DiscountMode;
  transactionDiscountValue: number;
  transactionDiscountAmount: number;
  promotionDiscountAmount?: number;
  loyaltyPointsEarned?: number;
  loyaltyPointsRedeemed?: number;
  loyaltyDiscountAmount?: number;
  appliedPromotions?: AppliedPromotionSummary[];
  discountAmount: number;
  applyTax: boolean;
  taxAmount: number;
  total: number;
  cashReceived: number;
  changeAmount: number;
  paymentMethod: PaymentMethod;
  totalCost: number;
  grossProfit: number;
  notes: string;
  cashierId?: string | null;
  cashierName: string;
  heldAt?: string | null;
  cancelledAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface TransactionListResponse {
  transactions: Transaction[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PosCalculationPreview {
  items: Array<{
    productId: string;
    sku: string;
    barcode: string;
    name: string;
    unit: string;
    qty: number;
    originalSellPrice: number;
    unitPrice: number;
    priceOverride: boolean;
    lineGrossSubtotal: number;
    lineDiscountType: DiscountMode;
    lineDiscountValue: number;
    lineDiscountAmount: number;
    promotionId: string | null;
    promotionName: string;
    promotionDiscountAmount: number;
    lineNetAfterDiscount: number;
    lineTaxAmount: number;
    taxCategory: TaxCategory;
  }>;
  subtotal: number;
  lineDiscountTotal: number;
  promotionLineDiscountTotal: number;
  netAfterLineDiscounts: number;
  transactionDiscountType: DiscountMode;
  transactionDiscountValue: number;
  transactionDiscountAmount: number;
  promotionTransactionDiscountAmount: number;
  totalPromotionDiscount: number;
  loyaltyPointsRedeemed: number;
  loyaltyDiscountAmount: number;
  estimatedPointsEarned: number;
  appliedPromotions: AppliedPromotionSummary[];
  eligiblePromotions: PromotionEligibilityItem[];
  totalDiscount: number;
  taxableAmount: number;
  taxAmount: number;
  grandTotal: number;
  requiresDiscountApproval: boolean;
  requiresPriceOverrideApproval: boolean;
}

export type StockMovementType =
  | 'PENJUALAN'
  | 'RESTOK'
  | 'STOCK_IN'
  | 'ADJUSTMENT_IN'
  | 'ADJUSTMENT_OUT'
  | 'OPNAME'
  | 'STOK_AWAL';

export interface StockMovement {
  id: string;
  productId: string;
  sku?: string;
  productName: string;
  barcode: string;
  type: StockMovementType;
  qtyDelta: number;
  stockBefore: number;
  stockAfter: number;
  unitCost?: number | null;
  referenceId: string;
  reason?: string;
  notes: string;
  actorUserId?: string | null;
  actorName?: string;
  movementDate?: string;
  createdAt: string;
}

export type StockStatusLevel = 'SAFE' | 'LOW' | 'OUT' | 'NEGATIVE';

export interface StockBalanceItem {
  productId: string;
  sku: string;
  barcode: string;
  name: string;
  category: string;
  brandName: string;
  unit: string;
  costPrice: number;
  sellPrice: number;
  currentStock: number;
  minStock: number;
  stockStatus: StockStatusLevel;
  productStatus: ProductStatus;
  assetValue: number;
  retailValue: number;
  updatedAt: string;
}

export interface StockBalanceSummary {
  totalSku: number;
  totalUnits: number;
  safeCount: number;
  lowCount: number;
  outCount: number;
  negativeCount: number;
  totalCostValue: number;
  totalRetailValue: number;
  allowNegativeStock: boolean;
}

export interface StockBalanceResponse {
  items: StockBalanceItem[];
  summary: StockBalanceSummary;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface StockReceivingRecord {
  id: string;
  referenceNumber: string;
  productId: string;
  sku: string;
  productName: string;
  barcode: string;
  unit: string;
  qty: number;
  costPrice: number;
  previousCostPrice: number;
  updateProductCost: boolean;
  notes: string;
  receivedAt: string;
  movementId: string;
  createdByUserId: string | null;
  createdByName: string;
  createdAt: string;
}

export type StockAdjustmentDirection = 'INCREASE' | 'DECREASE';

export interface StockAdjustmentRecord {
  id: string;
  referenceNumber: string;
  productId: string;
  sku: string;
  productName: string;
  barcode: string;
  unit: string;
  direction: StockAdjustmentDirection;
  qty: number;
  stockBefore: number;
  stockAfter: number;
  reason: string;
  notes: string;
  approvalStatus: 'APPROVED';
  requestedByUserId: string | null;
  requestedByName: string;
  approvedByUserId: string | null;
  approvedByName: string;
  movementId: string;
  createdAt: string;
}

export type StockOpnameStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'FINALIZED'
  | 'CANCELLED';

export interface StockOpnameItem {
  id: string;
  opnameId: string;
  productId: string;
  sku: string;
  barcode: string;
  productName: string;
  unit: string;
  costPrice: number;
  systemStock: number;
  physicalStock: number | null;
  variance: number;
  varianceValue: number;
  isCounted: boolean;
  notes: string;
  appliedMovementId: string | null;
  updatedAt: string;
}

export interface StockOpnameSession {
  id: string;
  opnameNumber: string;
  title: string;
  status: StockOpnameStatus;
  notes: string;
  totalItems: number;
  countedItems: number;
  discrepancyItems: number;
  totalVarianceQty: number;
  totalVarianceValue: number;
  createdByUserId: string | null;
  createdByName: string;
  approvedByUserId: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  finalizedByUserId: string | null;
  finalizedByName: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StockOpnameDetail extends StockOpnameSession {
  items: StockOpnameItem[];
}

export interface StockCardResponse {
  product: StockBalanceItem;
  summary: {
    totalIn: number;
    totalOut: number;
    netChange: number;
    movementCount: number;
  };
  movements: StockMovement[];
}

export type ReceiptPaperWidth = '58mm' | '80mm' | 'A4';
export type ReceiptLayoutFormat = ReceiptPaperWidth | 'DIGITAL';

export interface ReceiptSnapshot {
  transactionId: string;
  receiptNumber: string;
  verificationToken: string;
  storeName: string;
  storeAddress: string;
  storePhone: string;
  storeLogoUrl: string;
  receiptHeaderNote: string;
  receiptFooter: string;
  taxRate: number;
  printCount: number;
  lastPrintedAt: string | null;
  createdAt: string;
}

export interface ReceiptPrintLog {
  id: string;
  transactionId: string;
  copyNumber: number;
  printType: 'ORIGINAL' | 'REPRINT';
  layoutFormat: ReceiptLayoutFormat;
  driverId: string;
  printedByUserId: string | null;
  printedByName: string;
  createdAt: string;
}

export interface ReceiptData {
  transaction: Transaction;
  snapshot: ReceiptSnapshot;
  printLogs: ReceiptPrintLog[];
  qrPayload: string;
  digitalReceiptPath: string;
}

export interface StoreSettings {
  storeName: string;
  storeAddress: string;
  storePhone: string;
  receiptFooter: string;
  taxEnabled: boolean;
  taxRate: number;
  cashierName: string;
  storeLogoUrl?: string;
  receiptPaperWidth?: ReceiptPaperWidth;
  receiptShowLogo?: boolean;
  receiptShowQr?: boolean;
  receiptHeaderNote?: string;
  allowNegativeStock?: boolean;
  allowPromoStacking?: boolean;
  allowManualWithPromo?: boolean;
  maxCashierDiscountPercent?: number;
  maxAuthorizedDiscountPercent?: number;
}

export type AuditAction =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'SESSION_REVOKED'
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'USER_STATUS_CHANGED'
  | 'PASSWORD_RESET'
  | 'ROLE_CREATED'
  | 'ROLE_UPDATED'
  | 'ROLE_DELETED'
  | 'ROLE_PERMISSIONS_UPDATED'
  | 'PIN_AUTHORIZATION_SUCCESS'
  | 'PIN_AUTHORIZATION_FAILED'
  | 'PRODUCT_CREATED'
  | 'PRODUCT_UPDATED'
  | 'PRODUCT_STATUS_CHANGED'
  | 'PRODUCT_DELETED'
  | 'PRODUCTS_IMPORTED'
  | 'PRODUCTS_EXPORTED'
  | 'CATEGORY_CREATED'
  | 'CATEGORY_UPDATED'
  | 'BRAND_CREATED'
  | 'BRAND_UPDATED'
  | 'UOM_CREATED'
  | 'UOM_UPDATED'
  | 'STOCK_ADJUSTED'
  | 'STOCK_IN_RECORDED'
  | 'STOCK_OPNAME_CREATED'
  | 'STOCK_OPNAME_APPROVED'
  | 'STOCK_OPNAME_FINALIZED'
  | 'STOCK_OPNAME_CANCELLED'
  | 'MIN_STOCK_UPDATED'
  | 'TRANSACTION_HELD'
  | 'TRANSACTION_RESUMED'
  | 'TRANSACTION_CANCELLED'
  | 'TRANSACTION_COMPLETED'
  | 'RECEIPT_PRINTED'
  | 'RECEIPT_REPRINTED'
  | 'CUSTOMER_CREATED'
  | 'CUSTOMER_UPDATED'
  | 'CUSTOMER_STATUS_CHANGED'
  | 'LOYALTY_POINTS_ADJUSTED'
  | 'LOYALTY_SETTINGS_UPDATED'
  | 'PROMOTION_CREATED'
  | 'PROMOTION_UPDATED'
  | 'PROMOTION_STATUS_CHANGED'
  | 'PAYMENT_METHOD_CREATED'
  | 'PAYMENT_METHOD_UPDATED'
  | 'STORE_LOGO_UPDATED'
  | 'SETTINGS_UPDATED'
  | 'RECOGNITION_SETTINGS_UPDATED'
  | 'RECOGNITION_FEEDBACK_RECORDED'
  | 'RECOGNITION_INDEX_SYNCED';

export interface AuditLog {
  id: string;
  action: AuditAction;
  entityType:
    | 'auth'
    | 'user'
    | 'role'
    | 'permission'
    | 'session'
    | 'product'
    | 'category'
    | 'brand'
    | 'uom'
    | 'customer'
    | 'loyalty'
    | 'promotion'
    | 'payment_method'
    | 'stock'
    | 'transaction'
    | 'receipt'
    | 'settings'
    | 'recognition';
  entityId: string;
  actorUserId?: string | null;
  actor: string;
  summary: string;
  createdAt: string;
}

export type RecognitionProviderKind =
  | 'vision-ai'
  | 'local-inference'
  | 'remote-inference'
  | 'ocr-similarity';

export type RecognitionConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export type RecognitionOutcome =
  | 'PENDING'
  | 'CONFIRMED'
  | 'CORRECTED'
  | 'REGISTERED_NEW'
  | 'REJECTED'
  | 'ERROR';

export type RecognitionContext =
  | 'POS_CASHIER'
  | 'STOCK_OPNAME'
  | 'CATALOG_CHECK'
  | 'API';

export interface RecognitionBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  confidence: number;
}

export interface RecognitionOcrSignals {
  productName: string;
  brand: string;
  variant: string;
  flavor: string;
  weight: string;
  volume: string;
  size: string;
  packagingType: string;
  productCode: string;
  rawText: string;
  keywords: string[];
}

export interface RecognitionSignalBreakdown {
  imageSimilarity: number;
  ocrTextSimilarity: number;
  brandMatch: number;
  variantMatch: number;
  measureMatch: number;
  packagingMatch: number;
  feedbackBoost: number;
}

export interface RecognitionCandidate {
  productId: string;
  sku: string;
  barcode: string;
  name: string;
  brandName: string;
  category: string;
  variant: string;
  size: string;
  sellPrice: number;
  specialPrice: number | null;
  stock: number;
  unit: string;
  primaryImageUrl: string | null;
  matchedReferenceImageUrl: string | null;
  confidence: number;
  confidenceBand: RecognitionConfidenceBand;
  matchReasons: string[];
  signals: RecognitionSignalBreakdown;
}

export interface RecognitionProviderStatus {
  id: string;
  label: string;
  kind: RecognitionProviderKind;
  available: boolean;
  supportsOcr: boolean;
  supportsEmbeddings: boolean;
  reason?: string;
  modelName?: string;
}

export interface RecognitionSettings {
  activeProviderId: string;
  autoAddHighConfidence: boolean;
  highConfidenceThreshold: number;
  mediumConfidenceThreshold: number;
  lowConfidenceThreshold: number;
  remoteEndpointUrl: string;
  requestTimeoutMs: number;
  updatedAt: string;
}

export interface RecognitionResult {
  logId: string;
  providerId: string;
  providerLabel: string;
  capturedImageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  detectedRegion: RecognitionBoundingBox | null;
  ocrSignals: RecognitionOcrSignals;
  candidates: RecognitionCandidate[];
  bestMatch: RecognitionCandidate | null;
  confidenceBand: RecognitionConfidenceBand;
  autoAddEligible: boolean;
  latencyMs: number;
  settingsSnapshot: RecognitionSettings;
  createdAt: string;
}

export interface RecognitionLogEntry {
  id: string;
  userId: string | null;
  userName: string;
  providerId: string;
  context: RecognitionContext;
  capturedImageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  detectedRegion: RecognitionBoundingBox | null;
  ocrSignals: RecognitionOcrSignals;
  candidates: RecognitionCandidate[];
  topProductId: string | null;
  topProductName: string | null;
  topConfidence: number;
  confidenceBand: RecognitionConfidenceBand;
  selectedProductId: string | null;
  selectedProductName: string | null;
  outcome: RecognitionOutcome;
  isVerifiedFeedback: boolean;
  notes: string;
  latencyMs: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceEmbeddingSyncSummary {
  providerId: string;
  totalReferenceImages: number;
  processed: number;
  readyCount: number;
  failedCount: number;
  errors: Array<{ imageId: string; productId: string; message: string }>;
}

export interface Permission {
  id: string;
  code: string;
  module: string;
  action: 'view' | 'create' | 'edit' | 'delete' | 'approve' | 'execute';
  label: string;
  description: string;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissionCodes: string[];
  userCount: number;
  createdAt: string;
}

export interface UserSummary {
  id: string;
  username: string;
  email: string;
  fullName: string;
  isActive: boolean;
  hasPin: boolean;
  roles: Array<{ id: string; name: string }>;
  permissions: string[];
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInfo {
  id: string;
  userId: string;
  username: string;
  fullName: string;
  roleNames: string[];
  userAgent: string;
  ipAddress: string;
  loginAt: string;
  lastActivityAt: string;
  expiresAt: string;
  revokedAt: string | null;
  isCurrent?: boolean;
}

export type PinSensitiveAction =
  | 'discount_approval'
  | 'price_override'
  | 'void'
  | 'refund'
  | 'stock_adjustment';

export interface StoreData {
  products: Product[];
  categories: Category[];
  brands: Brand[];
  uoms: UnitOfMeasure[];
  customers: Customer[];
  promotions: Promotion[];
  loyaltySettings: LoyaltySettings;
  paymentMethods: PaymentMethodConfig[];
  transactions: Transaction[];
  heldTransactions: Transaction[];
  stockMovements: StockMovement[];
  settings: StoreSettings;
  auditLogs: AuditLog[];
}
