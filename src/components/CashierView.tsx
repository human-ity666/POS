import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Award,
  Camera,
  CameraOff,
  ChevronDown,
  ChevronUp,
  Clock,
  CreditCard,
  Edit3,
  Minus,
  Package,
  PackageOpen,
  PauseCircle,
  PlayCircle,
  Plus,
  ScanBarcode,
  Search,
  ShoppingCart,
  Sparkles,
  Tag,
  Trash2,
  UserPlus,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import type {
  CashierShift,
  Customer,
  DiscountMode,
  LoyaltySettings,
  PaymentMethodConfig,
  PosCalculationPreview,
  Product,
  ShiftSettings,
  StoreData,
  StoreSettings,
  Transaction,
} from '../types';
import { apiFetch } from '../utils/api';
import { formatDateTime, formatRupiah, playScannerSound } from '../utils/format';
import {
  validateAndNormalizeBarcode,
  type ScanResultFeedback,
} from '../utils/barcodeScanner';
import {
  AiRecognitionModal,
  type RecognitionNewProductPrefill,
} from './AiRecognitionModal';
import { CameraScanner, type CameraScanEventMeta } from './CameraScanner';
import { HeldTransactionsModal } from './HeldTransactionsModal';
import { PaymentModal, type SubmittedPaymentLine } from './PaymentModal';
import { OpenShiftModal } from './ShiftModals';

export interface CartItem {
  product: Product;
  qty: number;
  overrideUnitPrice: number | null;
  lineDiscountType: DiscountMode;
  lineDiscountValue: number;
}

export interface CashierCheckoutPayload {
  heldTransactionId?: string | null;
  customerId: string | null;
  notes: string;
  items: Array<{
    productId: string;
    qty: number;
    overrideUnitPrice?: number | null;
    lineDiscountType: DiscountMode;
    lineDiscountValue: number;
  }>;
  transactionDiscountType: DiscountMode;
  transactionDiscountValue: number;
  selectedPromotionIds: string[];
  loyaltyPointsToRedeem: number;
  applyTax: boolean;
  payments: SubmittedPaymentLine[];
  idempotencyKey: string;
}

interface PersistedCartSnapshot {
  activeDraftId: string | null;
  activeDraftNumber: string | null;
  customerId: string;
  notes: string;
  txDiscountType: DiscountMode;
  txDiscountInput: string;
  selectedPromotionIds: string[];
  loyaltyPointsInput: string;
  applyTax: boolean;
  items: Array<{
    productId: string;
    qty: number;
    overrideUnitPrice: number | null;
    lineDiscountType: DiscountMode;
    lineDiscountValue: number;
  }>;
}

function readPersistedCartSnapshot(storageKey: string): PersistedCartSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedCartSnapshot>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return null;
    return {
      activeDraftId: typeof parsed.activeDraftId === 'string' ? parsed.activeDraftId : null,
      activeDraftNumber: typeof parsed.activeDraftNumber === 'string' ? parsed.activeDraftNumber : null,
      customerId: typeof parsed.customerId === 'string' ? parsed.customerId : '',
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      txDiscountType: parsed.txDiscountType === 'PERCENT' ? 'PERCENT' : 'AMOUNT',
      txDiscountInput: typeof parsed.txDiscountInput === 'string' ? parsed.txDiscountInput : '',
      selectedPromotionIds: Array.isArray(parsed.selectedPromotionIds)
        ? parsed.selectedPromotionIds.filter((x): x is string => typeof x === 'string')
        : [],
      loyaltyPointsInput: typeof parsed.loyaltyPointsInput === 'string' ? parsed.loyaltyPointsInput : '',
      applyTax: typeof parsed.applyTax === 'boolean' ? parsed.applyTax : true,
      items: parsed.items
        .filter((item): item is PersistedCartSnapshot['items'][number] =>
          Boolean(item && typeof item.productId === 'string' && Number(item.qty) > 0)
        )
        .map((item) => ({
          productId: item.productId,
          qty: Math.max(1, Math.floor(Number(item.qty))),
          overrideUnitPrice:
            item.overrideUnitPrice !== null && item.overrideUnitPrice !== undefined
              ? Number(item.overrideUnitPrice)
              : null,
          lineDiscountType: item.lineDiscountType === 'PERCENT' ? 'PERCENT' : 'AMOUNT',
          lineDiscountValue: Math.max(0, Number(item.lineDiscountValue || 0)),
        })),
    };
  } catch {
    return null;
  }
}

interface CashierViewProps {
  currentUserId: string;
  products: Product[];
  customers: Customer[];
  paymentMethods: PaymentMethodConfig[];
  heldTransactions: Transaction[];
  settings: StoreSettings;
  loyaltySettings: LoyaltySettings;
  canCreateProduct: boolean;
  canCreateCustomer?: boolean;
  canApproveDiscount: boolean;
  canOverridePrice: boolean;
  canHold: boolean;
  canResume: boolean;
  canCancel: boolean;
  canCancelItem?: boolean;
  canUseAiRecognition?: boolean;
  canManageAiRecognition?: boolean;
  canEditProduct?: boolean;
  currentShift?: CashierShift | null;
  shiftSettings?: ShiftSettings;
  canOpenShift?: boolean;
  onOpenShiftScreen?: () => void;
  resumedTransaction?: Transaction | null;
  onConsumeResumedTransaction?: () => void;
  onCheckout: (payload: CashierCheckoutPayload) => Promise<void>;
  onHoldTransaction: (payload: {
    heldTransactionId?: string | null;
    customerId: string | null;
    notes: string;
    items: CashierCheckoutPayload['items'];
    transactionDiscountType: DiscountMode;
    transactionDiscountValue: number;
    selectedPromotionIds?: string[];
    loyaltyPointsToRedeem?: number;
    applyTax: boolean;
  }) => Promise<Transaction>;
  onResumeHeldTransaction: (trx: Transaction) => Promise<Transaction>;
  onCancelTransaction: (trx: Transaction, reason?: string) => Promise<void>;
  onRequestCancelItemPin?: (opts: { title: string; description: string }) => Promise<string>;
  onCreateCustomer: (input: {
    name: string;
    membershipNumber?: string;
    phone?: string;
    email?: string;
    address?: string;
    notes?: string;
  }) => Promise<Customer>;
  onOpenNewProductWithBarcode: (barcode: string) => void;
  onRegisterProductFromAi?: (prefill: RecognitionNewProductPrefill) => void;
  onStoreUpdate?: (store: StoreData) => void;
}

export function CashierView({
  currentUserId,
  products,
  customers,
  paymentMethods,
  heldTransactions,
  settings,
  loyaltySettings,
  canCreateProduct,
  canCreateCustomer = true,
  canApproveDiscount,
  canOverridePrice,
  canHold,
  canResume,
  canCancel,
  canCancelItem = true,
  canUseAiRecognition = true,
  canManageAiRecognition = false,
  canEditProduct = false,
  currentShift = null,
  shiftSettings,
  canOpenShift = false,
  onOpenShiftScreen,
  resumedTransaction,
  onConsumeResumedTransaction,
  onCheckout,
  onHoldTransaction,
  onResumeHeldTransaction,
  onCancelTransaction,
  onRequestCancelItemPin,
  onCreateCustomer,
  onOpenNewProductWithBarcode,
  onRegisterProductFromAi,
  onStoreUpdate,
}: CashierViewProps) {
  const cartStorageKey = `kassaritel_pos_cart_v1:${currentUserId || 'default'}`;
  const initialSnapshotRef = useRef<PersistedCartSnapshot | null | undefined>(undefined);
  if (initialSnapshotRef.current === undefined) {
    initialSnapshotRef.current = readPersistedCartSnapshot(cartStorageKey);
  }
  const initialSnapshot = initialSnapshotRef.current;

  const [mobilePane, setMobilePane] = useState<'catalog' | 'cart'>('catalog');
  const [cameraActive, setCameraActive] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchDropdownOpen, setSearchDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState<string>('Semua');

  // Active transaction / cart state (persisted across tab switches & reloads)
  const [activeDraftId, setActiveDraftId] = useState<string | null>(
    () => initialSnapshot?.activeDraftId ?? null
  );
  const [activeDraftNumber, setActiveDraftNumber] = useState<string | null>(
    () => initialSnapshot?.activeDraftNumber ?? null
  );
  const [cart, setCart] = useState<CartItem[]>(() => {
    if (!initialSnapshot) return [];
    const hydrated: CartItem[] = [];
    for (const saved of initialSnapshot.items) {
      const fresh = products.find((p) => p.id === saved.productId);
      if (!fresh || fresh.status === 'INACTIVE' || fresh.stock <= 0) continue;
      hydrated.push({
        product: fresh,
        qty: Math.min(saved.qty, fresh.stock),
        overrideUnitPrice: saved.overrideUnitPrice,
        lineDiscountType: saved.lineDiscountType,
        lineDiscountValue: saved.lineDiscountValue,
      });
    }
    return hydrated;
  });
  const [expandedLineId, setExpandedLineId] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string>(() => initialSnapshot?.customerId ?? '');
  const [notes, setNotes] = useState(() => initialSnapshot?.notes ?? '');
  const [txDiscountType, setTxDiscountType] = useState<DiscountMode>(
    () => initialSnapshot?.txDiscountType ?? 'AMOUNT'
  );
  const [txDiscountInput, setTxDiscountInput] = useState(
    () => initialSnapshot?.txDiscountInput ?? ''
  );
  const [selectedPromotionIds, setSelectedPromotionIds] = useState<string[]>(
    () => initialSnapshot?.selectedPromotionIds ?? []
  );
  const [loyaltyPointsInput, setLoyaltyPointsInput] = useState(
    () => initialSnapshot?.loyaltyPointsInput ?? ''
  );
  const [promoPanelOpen, setPromoPanelOpen] = useState(true);
  const [applyTax, setApplyTax] = useState(() =>
    initialSnapshot ? initialSnapshot.applyTax : settings.taxEnabled
  );

  // Authoritative backend price preview
  const [calcPreview, setCalcPreview] = useState<PosCalculationPreview | null>(null);
  const [calculatingPreview, setCalculatingPreview] = useState(false);
  const [calcError, setCalcError] = useState<string | null>(null);

  // Searchable customer selector state
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const [customerHighlightIndex, setCustomerHighlightIndex] = useState(0);

  // Add Member popup modal state
  const [addMemberModalOpen, setAddMemberModalOpen] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustMemberNo, setNewCustMemberNo] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [newCustEmail, setNewCustEmail] = useState('');
  const [newCustAddress, setNewCustAddress] = useState('');
  const [newCustNotes, setNewCustNotes] = useState('');
  const [custModalError, setCustModalError] = useState<string | null>(null);
  const [savingCust, setSavingCust] = useState(false);

  // Modals
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [heldModalOpen, setHeldModalOpen] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [openShiftModalOpen, setOpenShiftModalOpen] = useState(false);
  const [isHolding, setIsHolding] = useState(false);
  const [bannerMessage, setBannerMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const [lastScanStatus, setLastScanStatus] = useState<ScanResultFeedback | null>(null);

  const barcodeInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const prevDefaultTaxRef = useRef(settings.taxEnabled);

  useEffect(() => {
    if (prevDefaultTaxRef.current !== settings.taxEnabled) {
      prevDefaultTaxRef.current = settings.taxEnabled;
      setApplyTax(settings.taxEnabled);
    }
  }, [settings.taxEnabled]);

  // Persist cart snapshot continuously so tab switches or page refreshes retain temporary cart state
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isEmpty =
      cart.length === 0 &&
      !activeDraftId &&
      !customerId &&
      !notes &&
      !txDiscountInput &&
      selectedPromotionIds.length === 0 &&
      !loyaltyPointsInput;
    try {
      if (isEmpty) {
        window.localStorage.removeItem(cartStorageKey);
      } else {
        const snapshot: PersistedCartSnapshot = {
          activeDraftId,
          activeDraftNumber,
          customerId,
          notes,
          txDiscountType,
          txDiscountInput,
          selectedPromotionIds,
          loyaltyPointsInput,
          applyTax,
          items: cart.map((c) => ({
            productId: c.product.id,
            qty: c.qty,
            overrideUnitPrice: c.overrideUnitPrice,
            lineDiscountType: c.lineDiscountType,
            lineDiscountValue: c.lineDiscountValue,
          })),
        };
        window.localStorage.setItem(cartStorageKey, JSON.stringify(snapshot));
      }
    } catch {
      // Ignore storage quota errors gracefully
    }
  }, [
    cartStorageKey,
    cart,
    activeDraftId,
    activeDraftNumber,
    customerId,
    notes,
    txDiscountType,
    txDiscountInput,
    selectedPromotionIds,
    loyaltyPointsInput,
    applyTax,
  ]);

  const activeProducts = useMemo(
    () => products.filter((p) => p.status !== 'INACTIVE'),
    [products]
  );

  const categoryTabs = useMemo(() => {
    const unique = Array.from(new Set(activeProducts.map((p) => p.category))).sort((a, b) =>
      a.localeCompare(b, 'id')
    );
    return ['Semua', ...unique];
  }, [activeProducts]);

  const getCatalogPrice = (p: Product) =>
    p.specialPrice !== null && p.specialPrice > 0 ? p.specialPrice : p.sellPrice;

  // Load resumed transaction from TransactionsView or HeldTransactionsModal
  const loadTransactionIntoCart = useCallback(
    (trx: Transaction) => {
      const nextCart: CartItem[] = [];
      for (const item of trx.items) {
        const fresh = products.find((p) => p.id === item.productId);
        if (!fresh || fresh.status === 'INACTIVE' || fresh.stock <= 0) continue;
        nextCart.push({
          product: fresh,
          qty: Math.min(item.qty, fresh.stock),
          overrideUnitPrice: item.priceOverride ? item.sellPrice : null,
          lineDiscountType: item.lineDiscountType ?? 'AMOUNT',
          lineDiscountValue: item.lineDiscountValue ?? 0,
        });
      }
      setActiveDraftId(trx.id);
      setActiveDraftNumber(trx.invoiceNumber);
      setCart(nextCart);
      setCustomerId(trx.customerId ?? '');
      setNotes(trx.notes ?? '');
      setTxDiscountType(trx.transactionDiscountType ?? 'AMOUNT');
      setTxDiscountInput(
        trx.transactionDiscountValue > 0 ? String(trx.transactionDiscountValue) : ''
      );
      setSelectedPromotionIds(trx.appliedPromotions?.map((p) => p.id) ?? []);
      setLoyaltyPointsInput(
        trx.loyaltyPointsRedeemed && trx.loyaltyPointsRedeemed > 0
          ? String(trx.loyaltyPointsRedeemed)
          : ''
      );
      setApplyTax(trx.applyTax);
      setBannerMessage({
        type: 'success',
        text: `Transaksi ${trx.invoiceNumber} dimuat ke keranjang kasir.`,
      });
    },
    [products]
  );

  useEffect(() => {
    if (resumedTransaction) {
      loadTransactionIntoCart(resumedTransaction);
      onConsumeResumedTransaction?.();
    }
  }, [resumedTransaction, loadTransactionIntoCart, onConsumeResumedTransaction]);

  // Keep cart product references fresh after backend updates stock
  useEffect(() => {
    setCart((prev) =>
      prev
        .map((item) => {
          const fresh = products.find((p) => p.id === item.product.id);
          if (!fresh || fresh.stock <= 0 || fresh.status === 'INACTIVE') return null;
          return {
            ...item,
            product: fresh,
            qty: Math.min(item.qty, fresh.stock),
          };
        })
        .filter((x): x is CartItem => x !== null)
    );
  }, [products]);

  const resetCartState = useCallback(() => {
    setCart([]);
    setActiveDraftId(null);
    setActiveDraftNumber(null);
    setExpandedLineId(null);
    setCustomerId('');
    setCustomerSearchQuery('');
    setCustomerDropdownOpen(false);
    setNotes('');
    setTxDiscountType('AMOUNT');
    setTxDiscountInput('');
    setSelectedPromotionIds([]);
    setLoyaltyPointsInput('');
    setApplyTax(settings.taxEnabled);
    setCalcPreview(null);
    setCalcError(null);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(cartStorageKey);
      } catch {
        // ignore
      }
    }
  }, [settings.taxEnabled, cartStorageKey]);

  const serializedCartPayload = useMemo(() => {
    const rawTxDisc = Number(txDiscountInput || 0);
    const parsedPoints =
      customerId && loyaltySettings.enabled
        ? Math.max(0, Math.trunc(Number(loyaltyPointsInput || 0)))
        : 0;
    return {
      customerId: customerId || null,
      items: cart.map((c) => ({
        productId: c.product.id,
        qty: c.qty,
        overrideUnitPrice: c.overrideUnitPrice,
        lineDiscountType: c.lineDiscountType,
        lineDiscountValue: c.lineDiscountValue,
      })),
      transactionDiscountType: txDiscountType,
      transactionDiscountValue: Number.isFinite(rawTxDisc) && rawTxDisc >= 0 ? rawTxDisc : 0,
      selectedPromotionIds,
      loyaltyPointsToRedeem: Number.isFinite(parsedPoints) ? parsedPoints : 0,
      applyTax,
    };
  }, [
    cart,
    customerId,
    txDiscountType,
    txDiscountInput,
    selectedPromotionIds,
    loyaltyPointsInput,
    loyaltySettings.enabled,
    applyTax,
  ]);

  // Authoritative backend calculation preview
  useEffect(() => {
    if (cart.length === 0) {
      setCalcPreview(null);
      setCalcError(null);
      setCalculatingPreview(false);
      return;
    }

    let cancelled = false;
    setCalculatingPreview(true);
    const timer = window.setTimeout(async () => {
      try {
        const preview = await apiFetch<PosCalculationPreview>('/api/pos/calculate', {
          method: 'POST',
          body: JSON.stringify(serializedCartPayload),
        });
        if (!cancelled) {
          setCalcPreview(preview);
          setCalcError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setCalcError(
            err instanceof Error ? err.message : 'Gagal menghitung total transaksi dari server.'
          );
        }
      } finally {
        if (!cancelled) setCalculatingPreview(false);
      }
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cart.length, serializedCartPayload]);

  const addProductToCart = useCallback(
    (product: Product, fromScanner = false, scanMeta?: CameraScanEventMeta): boolean => {
      if (product.status === 'INACTIVE') {
        if (fromScanner && soundEnabled) playScannerSound('error');
        setLastScanStatus({
          barcode: product.barcode,
          format: scanMeta?.format,
          engine: scanMeta?.engine === 'manual' ? undefined : scanMeta?.engine,
          productName: product.name,
          productSku: product.sku,
          found: false,
          message: 'Produk berstatus nonaktif dan tidak dapat dijual.',
          timestamp: Date.now(),
        });
        return false;
      }
      if (product.stock <= 0) {
        if (fromScanner && soundEnabled) playScannerSound('error');
        setLastScanStatus({
          barcode: product.barcode,
          format: scanMeta?.format,
          engine: scanMeta?.engine === 'manual' ? undefined : scanMeta?.engine,
          productName: product.name,
          productSku: product.sku,
          found: false,
          message: `Stok habis (0 ${product.unit}) — tidak bisa ditambahkan.`,
          timestamp: Date.now(),
        });
        return false;
      }

      let exceededStock = false;
      setCart((prev) => {
        const existing = prev.find((c) => c.product.id === product.id);
        if (existing) {
          if (existing.qty >= product.stock) {
            exceededStock = true;
            return prev;
          }
          return prev.map((c) =>
            c.product.id === product.id ? { ...c, qty: c.qty + 1 } : c
          );
        }
        return [
          ...prev,
          {
            product,
            qty: 1,
            overrideUnitPrice: null,
            lineDiscountType: 'AMOUNT',
            lineDiscountValue: 0,
          },
        ];
      });

      if (exceededStock) {
        if (fromScanner && soundEnabled) playScannerSound('error');
        setLastScanStatus({
          barcode: product.barcode,
          format: scanMeta?.format,
          engine: scanMeta?.engine === 'manual' ? undefined : scanMeta?.engine,
          productName: product.name,
          productSku: product.sku,
          found: false,
          message: `Batas stok tercapai (tersedia ${product.stock} ${product.unit}).`,
          timestamp: Date.now(),
        });
        return false;
      }

      const effectivePrice = getCatalogPrice(product);
      if (fromScanner && soundEnabled) playScannerSound('success');
      setLastScanStatus({
        barcode: product.barcode,
        format: scanMeta?.format,
        engine: scanMeta?.engine === 'manual' ? undefined : scanMeta?.engine,
        productName: product.name,
        productSku: product.sku,
        productPrice: effectivePrice,
        productStock: product.stock,
        productUnit: product.unit,
        found: true,
        message: `${formatRupiah(effectivePrice)} · Masuk keranjang (+1 ${product.unit})`,
        timestamp: Date.now(),
      });
      return true;
    },
    [soundEnabled]
  );

  const handleBarcodeLookup = useCallback(
    async (rawCode: string, scanMeta?: CameraScanEventMeta) => {
      const validated = validateAndNormalizeBarcode(rawCode, scanMeta?.format, {
        allowQr: true,
      });
      if (!validated.valid) {
        if (soundEnabled) playScannerSound('error');
        setLastScanStatus({
          barcode: rawCode.trim(),
          format: validated.detectedType,
          found: false,
          validationError: true,
          message: validated.reason || 'Format barcode tidak valid.',
          timestamp: Date.now(),
        });
        return;
      }

      const code = validated.code;
      const lower = code.toLowerCase();
      let found: Product | undefined = products.find(
        (p) =>
          p.barcode.toLowerCase() === lower ||
          (p.sku && p.sku.toLowerCase() === lower) ||
          (p.barcodes && p.barcodes.some((b) => b.barcode.toLowerCase() === lower))
      );

      // Fallback lookup against backend product database if not matched locally
      if (!found) {
        try {
          const remote = await apiFetch<{ product: Product }>(
            `/api/products/barcode/${encodeURIComponent(code)}`
          );
          if (remote?.product) {
            found = remote.product;
          }
        } catch {
          // 404 or network fallback handled cleanly below as unknown barcode
        }
      }

      if (!found) {
        if (soundEnabled) playScannerSound('error');
        setLastScanStatus({
          barcode: code,
          format: scanMeta?.format ?? validated.detectedType,
          engine: scanMeta?.engine === 'manual' ? undefined : scanMeta?.engine,
          found: false,
          unknownBarcode: true,
          message: 'Barcode belum terdaftar di database produk.',
          timestamp: Date.now(),
        });
        return;
      }

      addProductToCart(found, true, {
        format: scanMeta?.format ?? validated.detectedType,
        engine: scanMeta?.engine ?? 'manual',
        checkDigitValid: validated.checkDigitValid,
      });
    },
    [products, addProductToCart, soundEnabled]
  );

  // Global keyboard shortcuts: F2 (barcode input), F3 (product search), F9 (open payment)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        barcodeInputRef.current?.focus();
      } else if (e.key === 'F3') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === 'F9' && cart.length > 0 && calcPreview) {
        e.preventDefault();
        setPaymentModalOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cart.length, calcPreview]);

  const handleBarcodeFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!barcodeInput.trim()) return;
    handleBarcodeLookup(barcodeInput);
    setBarcodeInput('');
  };

  const updateCartQty = (productId: string, nextQty: number) => {
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.product.id !== productId) return item;
          if (nextQty <= 0) return null;
          return {
            ...item,
            qty: Math.min(Math.floor(nextQty), item.product.stock),
          };
        })
        .filter((x): x is CartItem => x !== null)
    );
  };

  const updateCartLineAdjustments = (
    productId: string,
    patch: Partial<Pick<CartItem, 'overrideUnitPrice' | 'lineDiscountType' | 'lineDiscountValue'>>
  ) => {
    setCart((prev) =>
      prev.map((item) => (item.product.id === productId ? { ...item, ...patch } : item))
    );
  };

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return activeProducts.filter((p) => {
      const matchesCat = selectedCategory === 'Semua' || p.category === selectedCategory;
      const matchesQuery =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q) ||
        p.brandName.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.barcodes.some((b) => b.barcode.toLowerCase().includes(q));
      return matchesCat && matchesQuery;
    });
  }, [activeProducts, selectedCategory, searchQuery]);

  const autocompleteSuggestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return activeProducts
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          p.barcode.toLowerCase().includes(q) ||
          p.brandName.toLowerCase().includes(q) ||
          p.barcodes.some((b) => b.barcode.toLowerCase().includes(q))
      )
      .slice(0, 7);
  }, [activeProducts, searchQuery]);

  const handleSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!searchDropdownOpen || autocompleteSuggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % autocompleteSuggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(
        (prev) => (prev - 1 + autocompleteSuggestions.length) % autocompleteSuggestions.length
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = autocompleteSuggestions[highlightedIndex];
      if (target && target.stock > 0) {
        addProductToCart(target, false);
        setSearchQuery('');
        setSearchDropdownOpen(false);
      }
    } else if (e.key === 'Escape') {
      setSearchDropdownOpen(false);
    }
  };

  const selectedCustomer = useMemo(
    () => (customerId ? customers.find((c) => c.id === customerId) ?? null : null),
    [customerId, customers]
  );

  const selectedCustomerName = selectedCustomer?.name ?? 'Pelanggan Umum';

  const activeCustomers = useMemo(
    () => customers.filter((c) => c.isActive).sort((a, b) => a.name.localeCompare(b.name, 'id')),
    [customers]
  );

  const filteredCustomerOptions = useMemo(() => {
    const q = customerSearchQuery.trim().toLowerCase();
    if (!q) return activeCustomers.slice(0, 12);
    return activeCustomers
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.membershipNumber.toLowerCase().includes(q) ||
          c.code.toLowerCase().includes(q) ||
          c.phone.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q)
      )
      .slice(0, 12);
  }, [activeCustomers, customerSearchQuery]);

  const selectCustomerFromCart = (nextCustomer: Customer | null) => {
    if (!nextCustomer) {
      setCustomerId('');
      setLoyaltyPointsInput('');
    } else {
      setCustomerId(nextCustomer.id);
      if (nextCustomer.id !== customerId) {
        setLoyaltyPointsInput('');
      }
    }
    setCustomerSearchQuery('');
    setCustomerDropdownOpen(false);
    setCustomerHighlightIndex(0);
  };

  const handleCustomerSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!customerDropdownOpen) {
      if (e.key === 'ArrowDown') {
        setCustomerDropdownOpen(true);
      }
      return;
    }
    const totalOptions = 1 + filteredCustomerOptions.length; // +1 for Walk-in option at index 0
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCustomerHighlightIndex((prev) => (prev + 1) % totalOptions);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCustomerHighlightIndex((prev) => (prev - 1 + totalOptions) % totalOptions);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (customerHighlightIndex === 0) {
        selectCustomerFromCart(null);
      } else {
        const picked = filteredCustomerOptions[customerHighlightIndex - 1];
        if (picked) selectCustomerFromCart(picked);
      }
    } else if (e.key === 'Escape') {
      setCustomerDropdownOpen(false);
    }
  };

  const handleTogglePromotion = (promoId: string) => {
    setSelectedPromotionIds((prev) =>
      prev.includes(promoId) ? prev.filter((id) => id !== promoId) : [...prev, promoId]
    );
  };

  const handleApplyMaxLoyaltyPoints = () => {
    if (!selectedCustomer || !loyaltySettings.enabled) return;
    const baseNet = Math.max(
      0,
      (calcPreview?.netAfterLineDiscounts ?? 0) -
        (calcPreview?.transactionDiscountAmount ?? 0) -
        (calcPreview?.promotionTransactionDiscountAmount ?? 0)
    );
    const maxValueAllowed = Math.floor((baseNet * loyaltySettings.maxRedeemPercent) / 100);
    const maxPointsByCap =
      loyaltySettings.pointValueRp > 0
        ? Math.floor(maxValueAllowed / loyaltySettings.pointValueRp)
        : 0;
    const optimal = Math.min(selectedCustomer.loyaltyPoints, maxPointsByCap);
    setLoyaltyPointsInput(optimal > 0 ? String(optimal) : '');
  };

  const openAddMemberModal = () => {
    setNewCustName('');
    setNewCustMemberNo('');
    setNewCustPhone('');
    setNewCustEmail('');
    setNewCustAddress('');
    setNewCustNotes('');
    setCustModalError(null);
    setAddMemberModalOpen(true);
  };

  const handleCreateMemberSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!newCustName.trim()) {
      setCustModalError('Nama member wajib diisi.');
      return;
    }
    setCustModalError(null);
    setSavingCust(true);
    try {
      const created = await onCreateCustomer({
        name: newCustName.trim(),
        membershipNumber: newCustMemberNo.trim() || undefined,
        phone: newCustPhone.trim(),
        email: newCustEmail.trim(),
        address: newCustAddress.trim(),
        notes: newCustNotes.trim(),
      });
      setCustomerId(created.id);
      setCustomerSearchQuery('');
      setCustomerDropdownOpen(false);
      setLoyaltyPointsInput('');
      setAddMemberModalOpen(false);
      setBannerMessage({
        type: 'success',
        text: `Member baru "${created.name}" (${created.membershipNumber}) berhasil ditambahkan & dipilih di keranjang.`,
      });
    } catch (err) {
      setCustModalError(err instanceof Error ? err.message : 'Gagal menambahkan member baru.');
    } finally {
      setSavingCust(false);
    }
  };

  const isStoreClosedForSales = Boolean(shiftSettings?.requireOpenShiftForSales && !currentShift);

  const handleHoldCurrentCart = async () => {
    if (cart.length === 0 || isHolding) return;
    if (isStoreClosedForSales) {
      setBannerMessage({
        type: 'error',
        text: 'Toko belum dibuka. Silakan lakukan Buka Toko terlebih dahulu sebelum menahan transaksi.',
      });
      if (canOpenShift) setOpenShiftModalOpen(true);
      return;
    }
    setBannerMessage(null);
    setIsHolding(true);
    try {
      const held = await onHoldTransaction({
        heldTransactionId: activeDraftId,
        notes: notes.trim(),
        ...serializedCartPayload,
      });
      resetCartState();
      setBannerMessage({
        type: 'success',
        text: `Transaksi berhasil ditahan sebagai ${held.invoiceNumber}.`,
      });
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menahan transaksi.',
      });
    } finally {
      setIsHolding(false);
    }
  };

  const authorizeCartItemRemoval = async (opts: {
    productId: string;
    productName: string;
    qty: number;
  }): Promise<boolean> => {
    if (canCancelItem) return true;
    if (!onRequestCancelItemPin) {
      setBannerMessage({
        type: 'error',
        text: 'Akun Anda tidak memiliki otoritas Batalkan Item di keranjang.',
      });
      return false;
    }
    try {
      const pinApprovalToken = await onRequestCancelItemPin({
        title: `Otorisasi Batalkan Item: ${opts.productName}`,
        description: `Pembatalan ${opts.qty}× "${opts.productName}" dari keranjang membutuhkan otoritas Batalkan Item (PIN Supervisor atau Admin).`,
      });
      await apiFetch<{ authorized: boolean }>('/api/pos/item-cancel/authorize', {
        method: 'POST',
        body: JSON.stringify({
          pinApprovalToken,
          productId: opts.productId,
          productName: opts.productName,
          qty: opts.qty,
        }),
      });
      return true;
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Pembatalan item di keranjang dibatalkan karena otorisasi PIN gagal.',
      });
      return false;
    }
  };

  const handleRequestRemoveCartItem = async (item: CartItem) => {
    const ok = await authorizeCartItemRemoval({
      productId: item.product.id,
      productName: item.product.name,
      qty: item.qty,
    });
    if (!ok) return;
    updateCartQty(item.product.id, 0);
  };

  const handleCancelDraftOrClear = async () => {
    if (cart.length > 0 && !canCancelItem) {
      const totalCartUnits = cart.reduce((s, c) => s + c.qty, 0);
      const ok = await authorizeCartItemRemoval({
        productId: 'cart-clear',
        productName: `Kosongkan ${cart.length} item keranjang`,
        qty: totalCartUnits,
      });
      if (!ok) return;
    }

    if (activeDraftId && canCancel) {
      try {
        const activeTarget =
          heldTransactions.find((h) => h.id === activeDraftId) ??
          ({ id: activeDraftId, invoiceNumber: activeDraftNumber || activeDraftId } as Transaction);
        await onCancelTransaction(activeTarget, 'Dibatalkan oleh kasir dari keranjang');
        setBannerMessage({
          type: 'success',
          text: `Draft transaksi ${activeDraftNumber || ''} dibatalkan.`,
        });
      } catch (err) {
        setBannerMessage({
          type: 'error',
          text: err instanceof Error ? err.message : 'Gagal membatalkan draft transaksi.',
        });
        return;
      }
    }
    resetCartState();
  };

  const openPaymentFlow = () => {
    if (isStoreClosedForSales) {
      setBannerMessage({
        type: 'error',
        text: 'Toko belum dibuka. Silakan lakukan Buka Toko terlebih dahulu sebelum menyelesaikan pembayaran.',
      });
      if (canOpenShift) {
        setOpenShiftModalOpen(true);
      }
      return;
    }
    setPaymentModalOpen(true);
  };

  const totalUnits = cart.reduce((s, c) => s + c.qty, 0);
  const displaySubtotal = calcPreview?.subtotal ?? cart.reduce((s, i) => s + getCatalogPrice(i.product) * i.qty, 0);
  const displayGrandTotal = calcPreview?.grandTotal ?? displaySubtotal;

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
      {/* Compact Store Operational Status Strip */}
      <div
        className={`rounded-xl border px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 ${
          currentShift
            ? 'bg-white border-slate-200'
            : shiftSettings?.requireOpenShiftForSales
            ? 'bg-amber-50/70 border-amber-300'
            : 'bg-white border-slate-200'
        }`}
      >
        <div className="flex items-center gap-2.5 text-xs min-w-0">
          <Wallet
            className={`w-4 h-4 shrink-0 ${
              currentShift
                ? 'text-teal-700'
                : shiftSettings?.requireOpenShiftForSales
                ? 'text-amber-700'
                : 'text-slate-400'
            }`}
          />
          {currentShift ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-slate-700 min-w-0">
              <span className="font-semibold text-teal-800">Toko Buka:</span>
              <span className="font-mono font-semibold text-slate-900">
                {currentShift.shiftNumber}
              </span>
              <span className="text-slate-400" aria-hidden="true">
                ·
              </span>
              <span>
                Dibuka oleh <strong className="text-slate-900">{currentShift.openedByName || currentShift.cashierName}</strong>
              </span>
              <span className="text-slate-400 hidden sm:inline" aria-hidden="true">
                ·
              </span>
              <span className="hidden sm:inline text-slate-500">
                Modal awal{' '}
                <strong className="font-mono text-slate-800 tabular-nums">
                  {formatRupiah(currentShift.openingCash)}
                </strong>{' '}
                ({formatDateTime(currentShift.openedAt)})
              </span>
            </div>
          ) : (
            <div className="min-w-0">
              <p
                className={`font-semibold ${
                  shiftSettings?.requireOpenShiftForSales ? 'text-amber-900' : 'text-slate-800'
                }`}
              >
                {shiftSettings?.requireOpenShiftForSales
                  ? 'Toko belum dibuka — wajib Buka Toko sebelum memproses transaksi penjualan'
                  : 'Toko belum dibuka'}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!currentShift && (
            <button
              type="button"
              disabled={!canOpenShift}
              onClick={() => setOpenShiftModalOpen(true)}
              title={!canOpenShift ? 'Akun Anda tidak memiliki hak akses Buka Toko.' : undefined}
              className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap"
            >
              <PlayCircle className="w-3.5 h-3.5" />
              Buka Toko
            </button>
          )}
          {onOpenShiftScreen && (
            <button
              type="button"
              onClick={onOpenShiftScreen}
              className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap"
            >
              {currentShift ? 'Kelola & Tutup Toko' : 'Halaman Buka/Tutup Toko'}
            </button>
          )}
        </div>
      </div>

      {/* Mobile Pane Toggle */}
      <div className="lg:hidden grid grid-cols-2 gap-2 bg-white border border-slate-200 rounded-xl p-1.5">
        <button
          type="button"
          onClick={() => setMobilePane('catalog')}
          className={`min-h-[44px] rounded-lg text-xs font-semibold transition-colors ${
            mobilePane === 'catalog'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Katalog & Scan
        </button>
        <button
          type="button"
          onClick={() => {
            setMobilePane('cart');
            setCameraActive(false);
          }}
          className={`min-h-[44px] rounded-lg text-xs font-semibold transition-colors tabular-nums ${
            mobilePane === 'cart'
              ? 'bg-teal-700 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Keranjang ({totalUnits})
        </button>
      </div>

      {bannerMessage && (
        <div
          className={`flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border text-xs font-medium ${
            bannerMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <span>{bannerMessage.text}</span>
          <button
            type="button"
            onClick={() => setBannerMessage(null)}
            className="font-semibold underline underline-offset-2 shrink-0"
          >
            Tutup
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left Workspace: Scanner + Autocomplete Search + Catalog */}
        <div
          className={`lg:col-span-8 space-y-4 ${
            mobilePane === 'cart' ? 'hidden lg:block' : 'block'
          }`}
        >
          {/* Fast Scanner & Held Bar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <form onSubmit={handleBarcodeFormSubmit} className="flex-1 min-w-[240px] flex gap-2">
                <div className="relative flex-1">
                  <ScanBarcode className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    ref={barcodeInputRef}
                    type="text"
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    placeholder="Scan USB atau ketik barcode / SKU + Enter (F2)"
                    className="w-full font-mono text-sm pl-9 pr-3 py-2 bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <button
                  type="submit"
                  className="min-h-[40px] px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  Cari Barcode
                </button>
              </form>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setHeldModalOpen(true)}
                  className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Clock className="w-3.5 h-3.5 text-amber-700" />
                  <span>Hold ({heldTransactions.length})</span>
                </button>

                <button
                  type="button"
                  onClick={() => setCameraActive((prev) => !prev)}
                  className={`min-h-[40px] inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                    cameraActive
                      ? 'bg-slate-900 text-white hover:bg-slate-800'
                      : 'bg-teal-700 text-white hover:bg-teal-800'
                  }`}
                >
                  {cameraActive ? (
                    <>
                      <CameraOff className="w-4 h-4" />
                      Tutup Kamera
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4" />
                      Scan Kamera
                    </>
                  )}
                </button>

                {canUseAiRecognition && (
                  <button
                    type="button"
                    onClick={() => {
                      setCameraActive(false);
                      setAiModalOpen(true);
                    }}
                    className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-teal-900 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <Sparkles className="w-4 h-4 text-teal-700" />
                    Identifikasi AI
                  </button>
                )}
              </div>
            </div>

            {!cameraActive && lastScanStatus && (
              <div
                className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg border text-xs ${
                  lastScanStatus.found
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-rose-50 border-rose-200 text-rose-900'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-[11px] font-semibold">
                    {lastScanStatus.barcode}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate font-medium">
                    {lastScanStatus.productName || lastScanStatus.message}
                  </span>
                </div>
                {!lastScanStatus.found && lastScanStatus.unknownBarcode && canCreateProduct && (
                  <button
                    type="button"
                    onClick={() => onOpenNewProductWithBarcode(lastScanStatus.barcode)}
                    className="font-semibold text-teal-800 underline underline-offset-2 shrink-0"
                  >
                    + Daftarkan Produk
                  </button>
                )}
              </div>
            )}
          </div>

          <CameraScanner
            active={cameraActive}
            onToggle={() => setCameraActive(false)}
            onScanBarcode={handleBarcodeLookup}
            soundEnabled={soundEnabled}
            onToggleSound={() => setSoundEnabled((s) => !s)}
            lastScanStatus={lastScanStatus}
            sampleProducts={activeProducts.filter((p) => p.stock > 0)}
            onRegisterMissingBarcode={canCreateProduct ? onOpenNewProductWithBarcode : undefined}
            context="pos"
            allowQrDefault={false}
          />

          {/* Fast Product Search (Autocomplete + Keyboard Nav) & Category Grid */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
                {categoryTabs.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                      selectedCategory === cat
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              <div className="relative w-full sm:w-72 shrink-0">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onFocus={() => setSearchDropdownOpen(true)}
                  onBlur={() => window.setTimeout(() => setSearchDropdownOpen(false), 160)}
                  onKeyDown={handleSearchKeyDown}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setHighlightedIndex(0);
                    setSearchDropdownOpen(true);
                  }}
                  placeholder="Cari nama, SKU, merek, barcode (F3)"
                  className="w-full text-xs pl-8 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />

                {searchDropdownOpen && autocompleteSuggestions.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden divide-y divide-slate-100">
                    {autocompleteSuggestions.map((p, idx) => {
                      const out = p.stock <= 0;
                      const active = idx === highlightedIndex;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          disabled={out}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            if (!out) {
                              addProductToCart(p, false);
                              setSearchQuery('');
                              setSearchDropdownOpen(false);
                            }
                          }}
                          className={`w-full px-3 py-2 text-left flex items-center justify-between gap-2 text-xs transition-colors ${
                            active ? 'bg-teal-50' : 'hover:bg-slate-50'
                          } disabled:opacity-50`}
                        >
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-900 truncate">{p.name}</p>
                            <p className="font-mono text-[10px] text-slate-500 truncate">
                              {p.sku} · {p.barcode} · {p.brandName}
                            </p>
                          </div>
                          <div className="text-right shrink-0 tabular-nums">
                            <p className="font-mono font-bold text-slate-900">
                              {formatRupiah(getCatalogPrice(p))}
                            </p>
                            <p className="text-[10px] text-slate-500">
                              Stok {p.stock} {p.unit}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {filteredProducts.length === 0 ? (
              <div className="py-12 text-center border border-dashed border-slate-200 rounded-lg">
                <PackageOpen className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                <p className="text-sm font-medium text-slate-700">Tidak ada produk yang cocok</p>
                <p className="text-xs text-slate-500 mt-1">
                  Coba ubah kata kunci pencarian atau pilih kategori lain.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {filteredProducts.map((product) => {
                  const isOut = product.stock <= 0;
                  const isLow = product.stock > 0 && product.stock <= product.minStock;
                  const inCartQty = cart.find((c) => c.product.id === product.id)?.qty ?? 0;
                  const effectivePrice = getCatalogPrice(product);

                  return (
                    <button
                      key={product.id}
                      type="button"
                      disabled={isOut}
                      onClick={() => addProductToCart(product, false)}
                      className={`text-left p-3.5 rounded-xl border transition-colors flex flex-col justify-between gap-2.5 ${
                        isOut
                          ? 'bg-slate-50 border-slate-200 opacity-60 cursor-not-allowed'
                          : inCartQty > 0
                          ? 'bg-teal-50/40 border-teal-500 hover:bg-teal-50/70'
                          : 'bg-white border-slate-200 hover:border-teal-500 hover:bg-slate-50/50'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className="w-10 h-10 rounded-lg border border-slate-200 bg-slate-100 overflow-hidden flex items-center justify-center shrink-0">
                          {product.primaryImageUrl ? (
                            <img
                              src={product.primaryImageUrl}
                              alt={product.name}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Package className="w-4 h-4 text-slate-400" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                            <span className="truncate">{product.brandName || product.category}</span>
                            <span className="font-mono tabular-nums shrink-0">{product.sku}</span>
                          </div>
                          <p className="text-sm font-semibold text-slate-900 mt-0.5 line-clamp-2 leading-snug">
                            {product.name}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-end justify-between gap-2 pt-2 border-t border-slate-100">
                        <div>
                          <div className="flex items-baseline gap-1.5">
                            <p className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                              {formatRupiah(effectivePrice)}
                            </p>
                            {product.specialPrice && product.specialPrice > 0 && (
                              <span className="font-mono text-[10px] text-slate-400 line-through tabular-nums">
                                {formatRupiah(product.sellPrice)}
                              </span>
                            )}
                          </div>
                          <p
                            className={`text-[11px] font-medium tabular-nums mt-0.5 ${
                              isOut
                                ? 'text-rose-700'
                                : isLow
                                ? 'text-amber-700'
                                : 'text-emerald-700'
                            }`}
                          >
                            {isOut
                              ? 'Stok Habis'
                              : isLow
                              ? `Menipis: ${product.stock} ${product.unit}`
                              : `Stok: ${product.stock} ${product.unit}`}
                          </p>
                        </div>

                        {inCartQty > 0 && (
                          <span className="font-mono text-xs font-bold text-teal-800 bg-teal-100 px-2 py-0.5 rounded tabular-nums shrink-0">
                            {inCartQty}x
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Workspace: Active Cart, Customer, Line Discounts & Payment Trigger */}
        <aside
          className={`lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden lg:sticky lg:top-6 ${
            mobilePane === 'catalog' ? 'hidden lg:block' : 'block'
          }`}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50/70">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ShoppingCart className="w-4 h-4 text-teal-700 shrink-0" />
                <h2 className="text-sm font-semibold text-slate-900 truncate">
                  Keranjang Belanja
                </h2>
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5 truncate">
                Status:{' '}
                <span className="font-semibold text-slate-700">
                  {activeDraftNumber
                    ? `LANJUTAN ${activeDraftNumber}`
                    : cart.length > 0
                    ? 'BERJALAN'
                    : 'TRANSAKSI BARU'}
                </span>
              </p>
            </div>
            {(cart.length > 0 || activeDraftId) && (
              <button
                type="button"
                onClick={handleCancelDraftOrClear}
                className="text-xs font-medium text-rose-700 hover:text-rose-800 whitespace-nowrap"
              >
                {activeDraftId && canCancel ? 'Batalkan Draft' : 'Kosongkan'}
              </button>
            )}
          </div>

          {/* Searchable Customer Selector + Popup Add Member Trigger */}
          <div className="px-4 py-2.5 border-b border-slate-100 bg-white space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <Users className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={
                    customerDropdownOpen
                      ? customerSearchQuery
                      : selectedCustomer
                      ? `${selectedCustomer.name}${
                          selectedCustomer.membershipNumber
                            ? ` (${selectedCustomer.membershipNumber})`
                            : ''
                        }`
                      : customerSearchQuery
                  }
                  onFocus={() => {
                    setCustomerDropdownOpen(true);
                    setCustomerHighlightIndex(0);
                  }}
                  onBlur={() => window.setTimeout(() => setCustomerDropdownOpen(false), 160)}
                  onKeyDown={handleCustomerSearchKeyDown}
                  onChange={(e) => {
                    setCustomerSearchQuery(e.target.value);
                    setCustomerDropdownOpen(true);
                    setCustomerHighlightIndex(0);
                  }}
                  placeholder="Cari konsumen (nama, MBR, no HP)..."
                  aria-label="Cari konsumen di keranjang"
                  className="w-full text-xs pl-8 pr-7 py-1.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
                {(selectedCustomer || customerSearchQuery) && (
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectCustomerFromCart(null);
                    }}
                    title="Reset ke Pelanggan Umum"
                    aria-label="Reset pilihan pelanggan"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}

                {customerDropdownOpen && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-xl shadow-lg max-h-56 overflow-y-auto divide-y divide-slate-100">
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectCustomerFromCart(null);
                      }}
                      className={`w-full px-3 py-2 text-left text-xs transition-colors flex items-center justify-between ${
                        customerHighlightIndex === 0
                          ? 'bg-teal-50 text-teal-900 font-semibold'
                          : 'hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <span>Pelanggan Umum (Walk-in)</span>
                      {!customerId && (
                        <span className="text-[10px] font-semibold text-teal-700">Dipilih</span>
                      )}
                    </button>
                    {filteredCustomerOptions.length === 0 ? (
                      <div className="px-3 py-2.5 text-[11px] text-slate-500">
                        Tidak ada member cocok untuk &ldquo;{customerSearchQuery}&rdquo;.
                      </div>
                    ) : (
                      filteredCustomerOptions.map((c, idx) => {
                        const isHighlighted = customerHighlightIndex === idx + 1;
                        const isSelected = c.id === customerId;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              selectCustomerFromCart(c);
                            }}
                            className={`w-full px-3 py-2 text-left text-xs transition-colors flex items-center justify-between gap-2 ${
                              isHighlighted
                                ? 'bg-teal-50'
                                : isSelected
                                ? 'bg-teal-50/50'
                                : 'hover:bg-slate-50'
                            }`}
                          >
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-900 truncate">{c.name}</p>
                              <p className="font-mono text-[10px] text-slate-500 truncate">
                                {c.membershipNumber || c.code}
                                {c.phone ? ` · ${c.phone}` : ''}
                              </p>
                            </div>
                            <span className="font-mono text-[11px] font-semibold text-teal-800 shrink-0 tabular-nums">
                              {c.loyaltyPoints.toLocaleString('id-ID')} poin
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              {canCreateCustomer && (
                <button
                  type="button"
                  onClick={openAddMemberModal}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  title="Tambah member baru (popup)"
                  aria-label="Tambah member baru"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  <span>+ Member</span>
                </button>
              )}
            </div>

            {selectedCustomer ? (
              <div className="flex items-center justify-between text-[11px] text-teal-800 font-mono tabular-nums px-1">
                <span>
                  Member {selectedCustomer.membershipNumber || selectedCustomer.code}
                  {selectedCustomer.phone ? ` · ${selectedCustomer.phone}` : ''}
                </span>
                <span className="font-semibold">
                  {selectedCustomer.loyaltyPoints.toLocaleString('id-ID')} poin
                </span>
              </div>
            ) : (
              <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
                <span>Mode saat ini: Pelanggan Umum (Walk-in)</span>
                <span>{activeCustomers.length} member aktif</span>
              </div>
            )}
          </div>

          {/* Cart Line Items */}
          <div className="divide-y divide-slate-100 max-h-[300px] overflow-y-auto px-4">
            {cart.length === 0 ? (
              <div className="py-10 text-center">
                <p className="text-xs font-medium text-slate-600">Keranjang masih kosong</p>
                <p className="text-[11px] text-slate-400 mt-1">
                  Scan barcode via kamera/USB atau klik produk di sebelah kiri.
                </p>
              </div>
            ) : (
              cart.map((item) => {
                const catalogPrice = getCatalogPrice(item.product);
                const unitPrice = item.overrideUnitPrice ?? catalogPrice;
                const serverLine = calcPreview?.items.find(
                  (li) => li.productId === item.product.id
                );
                const isExpanded = expandedLineId === item.product.id;

                return (
                  <div key={item.product.id} className="py-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-slate-900 truncate">
                          {item.product.name}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 mt-0.5 tabular-nums">
                          <span className="font-mono">
                            {formatRupiah(unitPrice)} / {item.product.unit}
                          </span>
                          {item.overrideUnitPrice !== null && (
                            <span className="text-amber-700 font-semibold">· Override</span>
                          )}
                          {(serverLine?.lineDiscountAmount ?? 0) > 0 && (
                            <span className="text-rose-700 font-medium">
                              · Diskon -{formatRupiah(serverLine?.lineDiscountAmount ?? 0)}
                            </span>
                          )}
                          {(serverLine?.promotionDiscountAmount ?? 0) > 0 && (
                            <span className="text-teal-700 font-medium">
                              · {serverLine?.promotionName || 'Promo'} -
                              {formatRupiah(serverLine?.promotionDiscountAmount ?? 0)}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            if (item.qty <= 1) {
                              void handleRequestRemoveCartItem(item);
                            } else {
                              updateCartQty(item.product.id, item.qty - 1);
                            }
                          }}
                          className="w-8 h-8 flex items-center justify-center border border-slate-300 rounded-md text-slate-700 hover:bg-slate-100"
                          aria-label={`Kurangi ${item.product.name}`}
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <input
                          type="number"
                          min={1}
                          max={item.product.stock}
                          value={item.qty}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10);
                            if (Number.isFinite(val) && val >= 1) {
                              updateCartQty(item.product.id, val);
                            }
                          }}
                          aria-label={`Jumlah ${item.product.name}`}
                          className="w-11 h-8 text-center font-mono text-xs font-semibold text-slate-900 border border-slate-300 rounded-md tabular-nums"
                        />
                        <button
                          type="button"
                          disabled={item.qty >= item.product.stock}
                          onClick={() => updateCartQty(item.product.id, item.qty + 1)}
                          className="w-8 h-8 flex items-center justify-center border border-slate-300 rounded-md text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                          aria-label={`Tambah ${item.product.name}`}
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedLineId(isExpanded ? null : item.product.id)
                          }
                          className={`w-8 h-8 flex items-center justify-center rounded-md border transition-colors ${
                            isExpanded
                              ? 'bg-teal-50 border-teal-300 text-teal-800'
                              : 'border-transparent text-slate-500 hover:bg-slate-100'
                          }`}
                          title="Diskon item / Override harga"
                          aria-label={`Ubah diskon atau harga ${item.product.name}`}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRequestRemoveCartItem(item)}
                          className={`w-7 h-8 flex items-center justify-center ${
                            canCancelItem
                              ? 'text-slate-400 hover:text-rose-600'
                              : 'text-amber-600 hover:text-rose-700'
                          }`}
                          title={
                            canCancelItem
                              ? 'Batalkan / hapus item dari keranjang'
                              : 'Batalkan item (butuh otoritas PIN Supervisor/Admin)'
                          }
                          aria-label={`Batalkan item ${item.product.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg grid grid-cols-2 gap-2 text-[11px]">
                        <div>
                          <label className="block font-medium text-slate-600 mb-1">
                            Diskon Baris ({item.lineDiscountType === 'PERCENT' ? '%' : 'Rp'})
                          </label>
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={() =>
                                updateCartLineAdjustments(item.product.id, {
                                  lineDiscountType:
                                    item.lineDiscountType === 'AMOUNT' ? 'PERCENT' : 'AMOUNT',
                                  lineDiscountValue: 0,
                                })
                              }
                              className="px-2 py-1 font-mono font-semibold bg-white border border-slate-300 rounded text-slate-700"
                            >
                              {item.lineDiscountType === 'PERCENT' ? '%' : 'Rp'}
                            </button>
                            <input
                              type="number"
                              min="0"
                              max={item.lineDiscountType === 'PERCENT' ? 100 : undefined}
                              value={item.lineDiscountValue || ''}
                              onChange={(e) =>
                                updateCartLineAdjustments(item.product.id, {
                                  lineDiscountValue: Math.max(0, Number(e.target.value || 0)),
                                })
                              }
                              placeholder="0"
                              className="w-full font-mono px-2 py-1 bg-white border border-slate-300 rounded tabular-nums"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block font-medium text-slate-600 mb-1">
                            Harga Satuan{!canOverridePrice ? ' · PIN' : ''}
                          </label>
                          <input
                            type="number"
                            min="0"
                            value={
                              item.overrideUnitPrice !== null
                                ? item.overrideUnitPrice
                                : catalogPrice
                            }
                            onChange={(e) => {
                              const next = Math.max(0, Math.round(Number(e.target.value || 0)));
                              updateCartLineAdjustments(item.product.id, {
                                overrideUnitPrice: next === catalogPrice ? null : next,
                              });
                            }}
                            className="w-full font-mono px-2 py-1 bg-white border border-slate-300 rounded tabular-nums"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Discounts, Tax, Notes & Backend-Calculated Totals */}
          <div className="p-4 border-t border-slate-200 bg-slate-50/50 space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Diskon Transaksi{!canApproveDiscount ? ' · PIN' : ''}
                </label>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setTxDiscountType((t) => (t === 'AMOUNT' ? 'PERCENT' : 'AMOUNT'));
                      setTxDiscountInput('');
                    }}
                    className="px-2 py-1.5 text-xs font-mono font-semibold bg-white border border-slate-300 rounded-lg text-slate-700"
                  >
                    {txDiscountType === 'PERCENT' ? '%' : 'Rp'}
                  </button>
                  <input
                    type="number"
                    min="0"
                    max={txDiscountType === 'PERCENT' ? 100 : undefined}
                    value={txDiscountInput}
                    onChange={(e) => setTxDiscountInput(e.target.value)}
                    placeholder="0"
                    className="w-full font-mono text-xs px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>

              <div className="flex flex-col justify-end">
                <label className="flex items-center gap-2 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={applyTax}
                    onChange={(e) => setApplyTax(e.target.checked)}
                    className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                  />
                  <span className="text-xs font-medium text-slate-700">
                    PPN {settings.taxRate}%
                  </span>
                </label>
              </div>
            </div>

            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Catatan transaksi (opsional)..."
              className="w-full text-xs px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />

            {/* Phase 09: Promotion Selector */}
            {cart.length > 0 && (calcPreview?.eligiblePromotions?.length ?? 0) > 0 && (
              <div className="border border-slate-200 bg-white rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setPromoPanelOpen((o) => !o)}
                  className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-slate-800 hover:bg-slate-50"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-teal-700" />
                    Promosi (
                    {calcPreview?.eligiblePromotions.filter((p) => p.eligible).length ?? 0}{' '}
                    memenuhi syarat)
                  </span>
                  <span className="inline-flex items-center gap-1 font-mono text-[11px] text-teal-800">
                    {selectedPromotionIds.length > 0
                      ? `${selectedPromotionIds.length} dipilih`
                      : 'Pilih'}
                    {promoPanelOpen ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </span>
                </button>

                {promoPanelOpen && (
                  <div className="border-t border-slate-100 divide-y divide-slate-100 max-h-40 overflow-y-auto">
                    {calcPreview?.eligiblePromotions.map((item) => {
                      const checked = selectedPromotionIds.includes(item.promotion.id);
                      const disabled = !item.eligible && !checked;
                      return (
                        <label
                          key={item.promotion.id}
                          className={`px-3 py-2 flex items-start justify-between gap-2 text-[11px] cursor-pointer ${
                            disabled ? 'opacity-55 cursor-not-allowed' : 'hover:bg-slate-50'
                          }`}
                        >
                          <span className="flex items-start gap-2 min-w-0">
                            <input
                              type="checkbox"
                              disabled={disabled}
                              checked={checked}
                              onChange={() => handleTogglePromotion(item.promotion.id)}
                              className="mt-0.5 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                            />
                            <span className="min-w-0">
                              <span className="font-mono font-bold text-slate-800 mr-1">
                                {item.promotion.code}
                              </span>
                              <span className="font-medium text-slate-700">
                                {item.promotion.name}
                              </span>
                              {!item.eligible && item.reason && (
                                <span className="block text-[10px] text-slate-500 mt-0.5">
                                  {item.reason}
                                </span>
                              )}
                            </span>
                          </span>
                          {item.eligible && item.estimatedDiscount > 0 && (
                            <span className="font-mono font-semibold text-teal-700 whitespace-nowrap shrink-0">
                              -{formatRupiah(item.estimatedDiscount)}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Phase 09: Loyalty Points Redemption — always visible when a member is selected */}
            {cart.length > 0 && selectedCustomer && (
              <div className="p-2.5 bg-white border border-slate-200 rounded-lg space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 font-semibold text-slate-800 text-[11px]">
                    <Award className="w-3.5 h-3.5 text-teal-700" />
                    Tukar Poin Loyalitas
                  </span>
                  <div className="flex items-center gap-2">
                    {loyaltyPointsInput && (
                      <button
                        type="button"
                        onClick={() => setLoyaltyPointsInput('')}
                        className="text-[11px] font-semibold text-rose-700 hover:underline"
                      >
                        Reset
                      </button>
                    )}
                    {loyaltySettings.enabled &&
                      loyaltySettings.pointValueRp > 0 &&
                      loyaltySettings.maxRedeemPercent > 0 &&
                      selectedCustomer.loyaltyPoints >= loyaltySettings.minRedeemPoints && (
                        <button
                          type="button"
                          onClick={handleApplyMaxLoyaltyPoints}
                          className="text-[11px] font-semibold text-teal-800 hover:underline"
                        >
                          Tukar Maks
                        </button>
                      )}
                  </div>
                </div>

                {!loyaltySettings.enabled ? (
                  <p className="text-[11px] text-slate-500">
                    Program penukaran poin loyalitas sedang nonaktif di pengaturan Promosi &amp; Loyalitas.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        max={selectedCustomer.loyaltyPoints}
                        disabled={
                          loyaltySettings.pointValueRp <= 0 ||
                          loyaltySettings.maxRedeemPercent <= 0 ||
                          selectedCustomer.loyaltyPoints <= 0 ||
                          selectedCustomer.loyaltyPoints < loyaltySettings.minRedeemPoints
                        }
                        value={loyaltyPointsInput}
                        onChange={(e) => setLoyaltyPointsInput(e.target.value)}
                        placeholder={`Min ${loyaltySettings.minRedeemPoints} poin`}
                        aria-label="Jumlah poin ditukar"
                        className="flex-1 font-mono text-xs px-2.5 py-1.5 border border-slate-300 rounded-md tabular-nums disabled:bg-slate-50 disabled:text-slate-400"
                      />
                      <span className="font-mono text-[11px] text-slate-500 whitespace-nowrap">
                        1 poin = {formatRupiah(loyaltySettings.pointValueRp)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-500">
                      <span>
                        Saldo member:{' '}
                        <strong className="font-mono text-slate-700">
                          {selectedCustomer.loyaltyPoints.toLocaleString('id-ID')} poin
                        </strong>
                      </span>
                      <span>
                        Min {loyaltySettings.minRedeemPoints} poin · Maks {loyaltySettings.maxRedeemPercent}%
                      </span>
                    </div>
                    {(loyaltySettings.pointValueRp <= 0 ||
                      loyaltySettings.maxRedeemPercent <= 0) ? (
                      <p className="text-[11px] text-amber-700">
                        Ketentuan nilai tukar atau batas maksimal potongan poin masih 0.
                      </p>
                    ) : selectedCustomer.loyaltyPoints < loyaltySettings.minRedeemPoints ? (
                      <p className="text-[11px] text-amber-700">
                        Saldo poin ({selectedCustomer.loyaltyPoints} poin) belum memenuhi minimum penukaran ({loyaltySettings.minRedeemPoints} poin).
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            )}

            <div className="space-y-1.5 text-xs pt-2 border-t border-slate-200 tabular-nums">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal ({totalUnits} unit)</span>
                <span className="font-mono">{formatRupiah(displaySubtotal)}</span>
              </div>
              {(calcPreview?.lineDiscountTotal ?? 0) > 0 && (
                <div className="flex justify-between text-rose-700">
                  <span>Diskon Item</span>
                  <span className="font-mono">
                    -{formatRupiah(calcPreview?.lineDiscountTotal ?? 0)}
                  </span>
                </div>
              )}
              {(calcPreview?.totalPromotionDiscount ?? 0) > 0 && (
                <div className="flex justify-between text-teal-700">
                  <span>Diskon Promosi ({calcPreview?.appliedPromotions.length ?? 0})</span>
                  <span className="font-mono">
                    -{formatRupiah(calcPreview?.totalPromotionDiscount ?? 0)}
                  </span>
                </div>
              )}
              {(calcPreview?.transactionDiscountAmount ?? 0) > 0 && (
                <div className="flex justify-between text-rose-700">
                  <span>Diskon Transaksi</span>
                  <span className="font-mono">
                    -{formatRupiah(calcPreview?.transactionDiscountAmount ?? 0)}
                  </span>
                </div>
              )}
              {(calcPreview?.loyaltyDiscountAmount ?? 0) > 0 && (
                <div className="flex justify-between text-teal-700">
                  <span>Tukar Poin ({calcPreview?.loyaltyPointsRedeemed ?? 0} poin)</span>
                  <span className="font-mono">
                    -{formatRupiah(calcPreview?.loyaltyDiscountAmount ?? 0)}
                  </span>
                </div>
              )}
              {(calcPreview?.taxAmount ?? 0) > 0 && (
                <div className="flex justify-between text-slate-600">
                  <span>PPN ({settings.taxRate}%)</span>
                  <span className="font-mono">{formatRupiah(calcPreview?.taxAmount ?? 0)}</span>
                </div>
              )}
              {(calcPreview?.estimatedPointsEarned ?? 0) > 0 && (
                <div className="flex justify-between text-emerald-700 text-[11px]">
                  <span>Estimasi Poin Didapat</span>
                  <span className="font-mono font-semibold">
                    +{calcPreview?.estimatedPointsEarned ?? 0} poin
                  </span>
                </div>
              )}
              {loyaltySettings.disableEarnOnRedeem &&
                (calcPreview?.loyaltyPointsRedeemed ?? 0) > 0 &&
                (calcPreview?.estimatedPointsEarned ?? 0) === 0 && (
                  <div className="flex justify-between text-amber-700 text-[11px]">
                    <span>Poin Baru Transaksi Ini</span>
                    <span className="font-mono font-semibold">0 poin (aturan tukar poin aktif)</span>
                  </div>
                )}
              <div className="flex justify-between items-baseline pt-2 border-t border-slate-200">
                <span className="text-sm font-bold text-slate-900">Total Bayar</span>
                <span className="font-mono text-xl font-bold text-teal-800">
                  {calculatingPreview && !calcPreview
                    ? 'Menghitung...'
                    : formatRupiah(displayGrandTotal)}
                </span>
              </div>
            </div>

            {calcError && (
              <div className="p-2.5 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                {calcError}
              </div>
            )}

            {isStoreClosedForSales && (
              <div className="p-2.5 text-xs font-medium text-amber-900 bg-amber-50 border border-amber-300 rounded-lg">
                Toko belum dibuka. Silakan lakukan <strong>Buka Toko</strong> terlebih dahulu sebelum
                memproses pembayaran atau menahan transaksi.
              </div>
            )}

            <div className="grid grid-cols-12 gap-2 pt-1">
              {canHold && (
                <button
                  type="button"
                  disabled={cart.length === 0 || isHolding || isStoreClosedForSales}
                  title={isStoreClosedForSales ? 'Lakukan Buka Toko terlebih dahulu.' : undefined}
                  onClick={handleHoldCurrentCart}
                  className="col-span-4 min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap"
                >
                  <PauseCircle className="w-4 h-4 shrink-0" />
                  <span>{isHolding ? 'Menahan...' : 'Tahan'}</span>
                </button>
              )}
              <button
                type="button"
                disabled={cart.length === 0 || Boolean(calcError) || !calcPreview || isStoreClosedForSales}
                title={isStoreClosedForSales ? 'Lakukan Buka Toko terlebih dahulu.' : undefined}
                onClick={openPaymentFlow}
                className={`${
                  canHold ? 'col-span-8' : 'col-span-12'
                } min-h-[44px] inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap`}
              >
                <CreditCard className="w-4 h-4 shrink-0" />
                <span>Bayar (F9)</span>
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/* Compact Mobile Quick Checkout Strip (<= 15% height, touch >= 44px) */}
      {cart.length > 0 && mobilePane === 'catalog' && (
        <div className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-slate-200 px-4 py-2.5 shadow-lg flex items-center justify-between gap-3">
          <div className="min-w-0 tabular-nums">
            <p className="text-[11px] font-medium text-slate-500 truncate">
              {totalUnits} unit · {selectedCustomerName}
            </p>
            <p className="font-mono text-base font-bold text-teal-800">
              {formatRupiah(displayGrandTotal)}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setMobilePane('cart')}
              className="min-h-[44px] px-3.5 text-xs font-semibold text-slate-700 bg-slate-100 rounded-lg"
            >
              Keranjang
            </button>
            <button
              type="button"
              disabled={!calcPreview || Boolean(calcError) || isStoreClosedForSales}
              onClick={openPaymentFlow}
              className="min-h-[44px] px-4 text-xs font-semibold text-white bg-teal-700 rounded-lg disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed"
            >
              Bayar
            </button>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      <PaymentModal
        open={paymentModalOpen}
        preview={calcPreview}
        calculating={calculatingPreview}
        paymentMethods={paymentMethods}
        customerName={selectedCustomerName}
        notes={notes.trim()}
        disableEarnOnRedeem={loyaltySettings.disableEarnOnRedeem}
        onClose={() => setPaymentModalOpen(false)}
        onConfirmPayment={async ({ payments, idempotencyKey }) => {
          await onCheckout({
            heldTransactionId: activeDraftId,
            notes: notes.trim(),
            ...serializedCartPayload,
            payments,
            idempotencyKey,
          });
          setPaymentModalOpen(false);
          resetCartState();
        }}
      />

      {/* Popup Add Member Modal */}
      {addMemberModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Tambah Member Baru"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md overflow-hidden shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-teal-700" />
                <h3 className="text-base font-semibold text-slate-900">Tambah Member Baru</h3>
              </div>
              <button
                type="button"
                onClick={() => setAddMemberModalOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
                aria-label="Tutup modal tambah member"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateMemberSubmit} className="p-5 space-y-3 text-xs">
              {custModalError && (
                <div className="p-3 font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                  {custModalError}
                </div>
              )}

              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Nama Lengkap Member *
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={newCustName}
                  onChange={(e) => setNewCustName(e.target.value)}
                  placeholder="Contoh: Siti Rahmawati"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Nomor Member (Opsional)
                  </label>
                  <input
                    type="text"
                    value={newCustMemberNo}
                    onChange={(e) => setNewCustMemberNo(e.target.value)}
                    placeholder="Otomatis MBR-xxxx"
                    className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    No. HP / WhatsApp
                  </label>
                  <input
                    type="text"
                    value={newCustPhone}
                    onChange={(e) => setNewCustPhone(e.target.value)}
                    placeholder="0812xxxxxxxx"
                    className="w-full font-mono px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                  />
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Email (Opsional)</label>
                <input
                  type="email"
                  value={newCustEmail}
                  onChange={(e) => setNewCustEmail(e.target.value)}
                  placeholder="member@email.com"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Alamat (Opsional)</label>
                <input
                  type="text"
                  value={newCustAddress}
                  onChange={(e) => setNewCustAddress(e.target.value)}
                  placeholder="Alamat tempat tinggal / pengiriman"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Catatan</label>
                <input
                  type="text"
                  value={newCustNotes}
                  onChange={(e) => setNewCustNotes(e.target.value)}
                  placeholder="Catatan preferensi member (opsional)"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div className="pt-3 border-t border-slate-200 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAddMemberModalOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingCust || !newCustName.trim()}
                  className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg disabled:opacity-50"
                >
                  {savingCust ? 'Menyimpan...' : 'Simpan & Pilih Member'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Held Transactions Modal */}
      <HeldTransactionsModal
        open={heldModalOpen}
        heldTransactions={heldTransactions}
        canResume={canResume}
        canCancel={canCancel}
        onClose={() => setHeldModalOpen(false)}
        onResume={async (trx) => {
          const resumed = await onResumeHeldTransaction(trx);
          loadTransactionIntoCart(resumed);
        }}
        onCancelHeld={async (trx, reason) => {
          await onCancelTransaction(trx, reason);
        }}
      />

      {/* Phase 08 AI Product Recognition Modal */}
      <AiRecognitionModal
        open={aiModalOpen}
        products={activeProducts}
        canManageAi={canManageAiRecognition}
        canCreateProduct={canCreateProduct}
        canEditProduct={canEditProduct}
        onClose={() => setAiModalOpen(false)}
        onAddProductToCart={(product, sourceLabel) => {
          const added = addProductToCart(product, false);
          if (added) {
            if (soundEnabled) playScannerSound('success');
            setBannerMessage({
              type: 'success',
              text: `${product.name} ditambahkan ke keranjang via ${sourceLabel}.`,
            });
          }
        }}
        onSwitchToBarcodeScanner={() => setCameraActive(true)}
        onSwitchToManualSearch={(initialQuery) => {
          setMobilePane('catalog');
          if (initialQuery) {
            setSearchQuery(initialQuery);
            setSearchDropdownOpen(true);
          }
          window.setTimeout(() => searchInputRef.current?.focus(), 60);
        }}
        onRegisterNewProduct={(prefill) => {
          onRegisterProductFromAi?.(prefill);
        }}
        onStoreUpdate={onStoreUpdate}
      />

      {/* Inline Buka Toko Modal */}
      <OpenShiftModal
        open={openShiftModalOpen}
        onClose={() => setOpenShiftModalOpen(false)}
        onSuccess={(shift, store) => {
          onStoreUpdate?.(store as StoreData);
          setBannerMessage({
            type: 'success',
            text: `Toko dibuka (${shift.shiftNumber}) oleh ${shift.openedByName || shift.cashierName} dengan modal awal ${formatRupiah(shift.openingCash)}.`,
          });
        }}
      />
    </div>
  );
}
