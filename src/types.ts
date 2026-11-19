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
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
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
    lineNetAfterDiscount: number;
    lineTaxAmount: number;
    taxCategory: TaxCategory;
  }>;
  subtotal: number;
  lineDiscountTotal: number;
  netAfterLineDiscounts: number;
  transactionDiscountType: DiscountMode;
  transactionDiscountValue: number;
  transactionDiscountAmount: number;
  totalDiscount: number;
  taxableAmount: number;
  taxAmount: number;
  grandTotal: number;
  requiresDiscountApproval: boolean;
  requiresPriceOverrideApproval: boolean;
}

export type StockMovementType = 'PENJUALAN' | 'RESTOK' | 'OPNAME' | 'STOK_AWAL';

export interface StockMovement {
  id: string;
  productId: string;
  productName: string;
  barcode: string;
  type: StockMovementType;
  qtyDelta: number;
  stockBefore: number;
  stockAfter: number;
  referenceId: string;
  notes: string;
  createdAt: string;
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
  | 'TRANSACTION_HELD'
  | 'TRANSACTION_RESUMED'
  | 'TRANSACTION_CANCELLED'
  | 'TRANSACTION_COMPLETED'
  | 'RECEIPT_PRINTED'
  | 'RECEIPT_REPRINTED'
  | 'CUSTOMER_CREATED'
  | 'PAYMENT_METHOD_CREATED'
  | 'PAYMENT_METHOD_UPDATED'
  | 'STORE_LOGO_UPDATED'
  | 'SETTINGS_UPDATED';

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
    | 'payment_method'
    | 'stock'
    | 'transaction'
    | 'receipt'
    | 'settings';
  entityId: string;
  actorUserId?: string | null;
  actor: string;
  summary: string;
  createdAt: string;
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
  paymentMethods: PaymentMethodConfig[];
  transactions: Transaction[];
  heldTransactions: Transaction[];
  stockMovements: StockMovement[];
  settings: StoreSettings;
  auditLogs: AuditLog[];
}
