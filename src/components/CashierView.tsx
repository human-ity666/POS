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
  Camera,
  CameraOff,
  Clock,
  CreditCard,
  Edit3,
  Minus,
  Package,
  PackageOpen,
  PauseCircle,
  Plus,
  ScanBarcode,
  Search,
  ShoppingCart,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import type {
  Customer,
  DiscountMode,
  PaymentMethodConfig,
  PosCalculationPreview,
  Product,
  StoreSettings,
  Transaction,
} from '../types';
import { apiFetch } from '../utils/api';
import { formatRupiah, playScannerSound } from '../utils/format';
import { CameraScanner } from './CameraScanner';
import { HeldTransactionsModal } from './HeldTransactionsModal';
import { PaymentModal, type SubmittedPaymentLine } from './PaymentModal';

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
  applyTax: boolean;
  payments: SubmittedPaymentLine[];
  idempotencyKey: string;
}

interface CashierViewProps {
  products: Product[];
  customers: Customer[];
  paymentMethods: PaymentMethodConfig[];
  heldTransactions: Transaction[];
  settings: StoreSettings;
  canCreateProduct: boolean;
  canApproveDiscount: boolean;
  canOverridePrice: boolean;
  canHold: boolean;
  canResume: boolean;
  canCancel: boolean;
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
    applyTax: boolean;
  }) => Promise<Transaction>;
  onResumeHeldTransaction: (trx: Transaction) => Promise<Transaction>;
  onCancelTransaction: (trx: Transaction, reason?: string) => Promise<void>;
  onCreateCustomer: (input: { name: string; phone?: string }) => Promise<Customer>;
  onOpenNewProductWithBarcode: (barcode: string) => void;
}

export function CashierView({
  products,
  customers,
  paymentMethods,
  heldTransactions,
  settings,
  canCreateProduct,
  canApproveDiscount,
  canOverridePrice,
  canHold,
  canResume,
  canCancel,
  resumedTransaction,
  onConsumeResumedTransaction,
  onCheckout,
  onHoldTransaction,
  onResumeHeldTransaction,
  onCancelTransaction,
  onCreateCustomer,
  onOpenNewProductWithBarcode,
}: CashierViewProps) {
  const [mobilePane, setMobilePane] = useState<'catalog' | 'cart'>('catalog');
  const [cameraActive, setCameraActive] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchDropdownOpen, setSearchDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState<string>('Semua');

  // Active transaction / cart state
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [activeDraftNumber, setActiveDraftNumber] = useState<string | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [expandedLineId, setExpandedLineId] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [txDiscountType, setTxDiscountType] = useState<DiscountMode>('AMOUNT');
  const [txDiscountInput, setTxDiscountInput] = useState('');
  const [applyTax, setApplyTax] = useState(settings.taxEnabled);

  // Authoritative backend price preview
  const [calcPreview, setCalcPreview] = useState<PosCalculationPreview | null>(null);
  const [calculatingPreview, setCalculatingPreview] = useState(false);
  const [calcError, setCalcError] = useState<string | null>(null);

  // Quick add customer inline form
  const [quickCustOpen, setQuickCustOpen] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [savingCust, setSavingCust] = useState(false);

  // Modals
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [heldModalOpen, setHeldModalOpen] = useState(false);
  const [isHolding, setIsHolding] = useState(false);
  const [bannerMessage, setBannerMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const [lastScanStatus, setLastScanStatus] = useState<{
    barcode: string;
    productName?: string;
    found: boolean;
    message: string;
    timestamp: number;
  } | null>(null);

  const barcodeInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setApplyTax(settings.taxEnabled);
  }, [settings.taxEnabled]);

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
    setNotes('');
    setTxDiscountType('AMOUNT');
    setTxDiscountInput('');
    setApplyTax(settings.taxEnabled);
    setCalcPreview(null);
    setCalcError(null);
  }, [settings.taxEnabled]);

  const serializedCartPayload = useMemo(() => {
    const rawTxDisc = Number(txDiscountInput || 0);
    return {
      items: cart.map((c) => ({
        productId: c.product.id,
        qty: c.qty,
        overrideUnitPrice: c.overrideUnitPrice,
        lineDiscountType: c.lineDiscountType,
        lineDiscountValue: c.lineDiscountValue,
      })),
      transactionDiscountType: txDiscountType,
      transactionDiscountValue: Number.isFinite(rawTxDisc) && rawTxDisc >= 0 ? rawTxDisc : 0,
      applyTax,
    };
  }, [cart, txDiscountType, txDiscountInput, applyTax]);

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
    (product: Product, fromScanner = false): boolean => {
      if (product.status === 'INACTIVE') {
        if (fromScanner && soundEnabled) playScannerSound('error');
        setLastScanStatus({
          barcode: product.barcode,
          productName: product.name,
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
          productName: product.name,
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
          productName: product.name,
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
        productName: product.name,
        found: true,
        message: `${formatRupiah(effectivePrice)} · Masuk keranjang (+1 ${product.unit})`,
        timestamp: Date.now(),
      });
      return true;
    },
    [soundEnabled]
  );

  const handleBarcodeLookup = useCallback(
    (rawCode: string) => {
      const code = rawCode.trim();
      if (!code) return;
      const lower = code.toLowerCase();
      const found = products.find(
        (p) =>
          p.barcode.toLowerCase() === lower ||
          (p.sku && p.sku.toLowerCase() === lower) ||
          (p.barcodes && p.barcodes.some((b) => b.barcode.toLowerCase() === lower))
      );
      if (!found) {
        if (soundEnabled) playScannerSound('error');
        setLastScanStatus({
          barcode: code,
          found: false,
          message: 'Barcode belum terdaftar di katalog.',
          timestamp: Date.now(),
        });
        return;
      }
      addProductToCart(found, true);
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

  const selectedCustomerName = useMemo(() => {
    if (!customerId) return 'Pelanggan Umum';
    return customers.find((c) => c.id === customerId)?.name ?? 'Pelanggan Umum';
  }, [customerId, customers]);

  const handleCreateQuickCustomer = async (e: FormEvent) => {
    e.preventDefault();
    if (!newCustName.trim()) return;
    setSavingCust(true);
    try {
      const created = await onCreateCustomer({
        name: newCustName.trim(),
        phone: newCustPhone.trim(),
      });
      setCustomerId(created.id);
      setNewCustName('');
      setNewCustPhone('');
      setQuickCustOpen(false);
    } finally {
      setSavingCust(false);
    }
  };

  const handleHoldCurrentCart = async () => {
    if (cart.length === 0 || isHolding) return;
    setBannerMessage(null);
    setIsHolding(true);
    try {
      const held = await onHoldTransaction({
        heldTransactionId: activeDraftId,
        customerId: customerId || null,
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

  const handleCancelDraftOrClear = async () => {
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

  const totalUnits = cart.reduce((s, c) => s + c.qty, 0);
  const displaySubtotal = calcPreview?.subtotal ?? cart.reduce((s, i) => s + getCatalogPrice(i.product) * i.qty, 0);
  const displayGrandTotal = calcPreview?.grandTotal ?? displaySubtotal;

  return (
    <div className="space-y-4 pb-20 lg:pb-0">
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
          onClick={() => setMobilePane('cart')}
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
                {!lastScanStatus.found && canCreateProduct && (
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
                {activeDraftId ? 'Batalkan Draft' : 'Kosongkan'}
              </button>
            )}
          </div>

          {/* Customer Selector */}
          <div className="px-4 py-2.5 border-b border-slate-100 bg-white space-y-2">
            <div className="flex items-center gap-2">
              <Users className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                aria-label="Pilih pelanggan"
                className="flex-1 text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
              >
                <option value="">Pelanggan Umum (Walk-in)</option>
                {customers
                  .filter((c) => c.isActive)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.phone ? ` · ${c.phone}` : ''}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                onClick={() => setQuickCustOpen((prev) => !prev)}
                className="p-1.5 text-slate-600 hover:text-teal-800 border border-slate-300 rounded-lg hover:bg-slate-50"
                title="Tambah pelanggan cepat"
                aria-label="Tambah pelanggan cepat"
              >
                <UserPlus className="w-3.5 h-3.5" />
              </button>
            </div>

            {quickCustOpen && (
              <form
                onSubmit={handleCreateQuickCustomer}
                className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2"
              >
                <input
                  type="text"
                  required
                  value={newCustName}
                  onChange={(e) => setNewCustName(e.target.value)}
                  placeholder="Nama pelanggan baru"
                  className="w-full text-xs px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                />
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newCustPhone}
                    onChange={(e) => setNewCustPhone(e.target.value)}
                    placeholder="No. HP (opsional)"
                    className="flex-1 text-xs px-2.5 py-1.5 bg-white border border-slate-300 rounded-md"
                  />
                  <button
                    type="submit"
                    disabled={savingCust || !newCustName.trim()}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 rounded-md disabled:opacity-50"
                  >
                    Simpan
                  </button>
                </div>
              </form>
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
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => updateCartQty(item.product.id, item.qty - 1)}
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
                          onClick={() => updateCartQty(item.product.id, 0)}
                          className="w-7 h-8 flex items-center justify-center text-slate-400 hover:text-rose-600"
                          aria-label={`Hapus ${item.product.name}`}
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
              {(calcPreview?.transactionDiscountAmount ?? 0) > 0 && (
                <div className="flex justify-between text-rose-700">
                  <span>Diskon Transaksi</span>
                  <span className="font-mono">
                    -{formatRupiah(calcPreview?.transactionDiscountAmount ?? 0)}
                  </span>
                </div>
              )}
              {(calcPreview?.taxAmount ?? 0) > 0 && (
                <div className="flex justify-between text-slate-600">
                  <span>PPN ({settings.taxRate}%)</span>
                  <span className="font-mono">{formatRupiah(calcPreview?.taxAmount ?? 0)}</span>
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

            <div className="grid grid-cols-12 gap-2 pt-1">
              {canHold && (
                <button
                  type="button"
                  disabled={cart.length === 0 || isHolding}
                  onClick={handleHoldCurrentCart}
                  className="col-span-4 min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 disabled:opacity-40 rounded-lg transition-colors whitespace-nowrap"
                >
                  <PauseCircle className="w-4 h-4 shrink-0" />
                  <span>{isHolding ? 'Menahan...' : 'Tahan'}</span>
                </button>
              )}
              <button
                type="button"
                disabled={cart.length === 0 || Boolean(calcError) || !calcPreview}
                onClick={() => setPaymentModalOpen(true)}
                className={`${
                  canHold ? 'col-span-8' : 'col-span-12'
                } min-h-[44px] inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap`}
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
              disabled={!calcPreview || Boolean(calcError)}
              onClick={() => setPaymentModalOpen(true)}
              className="min-h-[44px] px-4 text-xs font-semibold text-white bg-teal-700 rounded-lg disabled:bg-slate-300"
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
        onClose={() => setPaymentModalOpen(false)}
        onConfirmPayment={async ({ payments, idempotencyKey }) => {
          await onCheckout({
            heldTransactionId: activeDraftId,
            customerId: customerId || null,
            notes: notes.trim(),
            ...serializedCartPayload,
            payments,
            idempotencyKey,
          });
          setPaymentModalOpen(false);
          resetCartState();
        }}
      />

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
    </div>
  );
}
