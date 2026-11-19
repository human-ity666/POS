import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Boxes,
  History,
  LogOut,
  Menu,
  ReceiptText,
  RefreshCw,
  ScanBarcode,
  Settings,
  Shield,
  User,
  Users,
  X,
} from 'lucide-react';
import type {
  Customer,
  DiscountMode,
  PinSensitiveAction,
  Product,
  StockMovementType,
  StoreData,
  StoreSettings,
  Transaction,
  UserSummary,
} from './types';
import { apiFetch, ApiError, clearStoredTokens, getStoredTokens } from './utils/api';
import { AccessDeniedView } from './components/AccessDeniedView';
import { CashierView, type CashierCheckoutPayload } from './components/CashierView';
import { InventoryView } from './components/InventoryView';
import { LoginScreen } from './components/LoginScreen';
import { PinAuthorizationModal } from './components/PinAuthorizationModal';
import {
  BarcodeLabelModal,
  ProductFormModal,
  type ProductSavePayload,
  StockAdjustModal,
} from './components/ProductModals';
import { ProfileModal } from './components/ProfileModal';
import { ReceiptDetailView } from './components/ReceiptDetailView';
import { ReceiptModal } from './components/ReceiptModal';
import { RolesPermissionsView } from './components/RolesPermissionsView';
import { SecurityAuditView } from './components/SecurityAuditView';
import { SettingsModal } from './components/SettingsModal';
import { StockReportView } from './components/StockReportView';
import { TransactionDetailModal } from './components/TransactionDetailModal';
import { TransactionsView } from './components/TransactionsView';
import { UsersView } from './components/UsersView';

type AppTab =
  | 'cashier'
  | 'reports'
  | 'inventory'
  | 'transactions'
  | 'users'
  | 'roles'
  | 'security';

interface NavDefinition {
  id: AppTab;
  label: string;
  icon: typeof ScanBarcode;
  requiredAnyPermissions?: string[];
}

const NAV_ITEMS: NavDefinition[] = [
  { id: 'cashier', label: 'Kasir & Scan Kamera', icon: ScanBarcode, requiredAnyPermissions: ['pos:view'] },
  { id: 'reports', label: 'Laporan Stok Otomatis', icon: BarChart3, requiredAnyPermissions: ['reports:view', 'stock:view'] },
  { id: 'inventory', label: 'Produk & Barcode', icon: Boxes, requiredAnyPermissions: ['products:view'] },
  { id: 'transactions', label: 'Riwayat Transaksi', icon: ReceiptText, requiredAnyPermissions: ['transactions:view'] },
  { id: 'users', label: 'Manajemen Pengguna', icon: Users, requiredAnyPermissions: ['users:view'] },
  { id: 'roles', label: 'Role & Hak Akses', icon: Shield, requiredAnyPermissions: ['roles:view'] },
  { id: 'security', label: 'Sesi & Audit Log', icon: History },
];

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [currentUser, setCurrentUser] = useState<UserSummary | null>(null);

  const [activeTab, setActiveTab] = useState<AppTab>('cashier');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [storeData, setStoreData] = useState<StoreData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Modals state
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [prefillBarcode, setPrefillBarcode] = useState<string | undefined>(undefined);
  const [adjustingProduct, setAdjustingProduct] = useState<Product | null>(null);
  const [barcodeProduct, setBarcodeProduct] = useState<Product | null>(null);
  const [receiptTransaction, setReceiptTransaction] = useState<Transaction | null>(null);
  const [activeReceiptId, setActiveReceiptId] = useState<string | null>(null);
  const [detailTransaction, setDetailTransaction] = useState<Transaction | null>(null);
  const [resumedTransaction, setResumedTransaction] = useState<Transaction | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [publicReceiptParams, setPublicReceiptParams] = useState<{
    receiptId: string;
    token: string;
  } | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const receiptId = params.get('receipt')?.trim() || '';
    const token = params.get('token')?.trim() || '';
    return receiptId && token ? { receiptId, token } : null;
  });

  // Pending PIN-authorized operation state
  const [pinRequest, setPinRequest] = useState<{
    action: PinSensitiveAction;
    title: string;
    description: string;
    onTokenReady: (pinApprovalToken: string) => Promise<void>;
    onCancel: () => void;
  } | null>(null);

  const hasAnyPermission = useCallback(
    (perms?: string[]) => {
      if (!perms || perms.length === 0) return true;
      if (!currentUser) return false;
      return perms.some((p) => currentUser.permissions.includes(p));
    },
    [currentUser]
  );

  const visibleNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => hasAnyPermission(item.requiredAnyPermissions)),
    [hasAnyPermission]
  );

  const fetchBootstrap = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiFetch<StoreData>('/api/bootstrap');
      setStoreData(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearStoredTokens();
        setCurrentUser(null);
        setStoreData(null);
        return;
      }
      setLoadError(err instanceof Error ? err.message : 'Terjadi kesalahan jaringan.');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshCurrentUser = useCallback(async () => {
    try {
      const me = await apiFetch<{ user: UserSummary; sessionId: string }>('/api/auth/me');
      setCurrentUser(me.user);
      return me.user;
    } catch {
      clearStoredTokens();
      setCurrentUser(null);
      setStoreData(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await apiFetch<{ user: UserSummary; sessionId: string }>('/api/auth/me');
        if (!active) return;
        setCurrentUser(me.user);
        await fetchBootstrap();
      } catch {
        if (!active) return;
        clearStoredTokens();
        setCurrentUser(null);
      } finally {
        if (active) setAuthChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [fetchBootstrap]);

  // Ensure activeTab lands on a permitted tab after login
  useEffect(() => {
    if (!currentUser || visibleNavItems.length === 0) return;
    const allowed = visibleNavItems.some((n) => n.id === activeTab);
    if (!allowed) {
      setActiveTab(visibleNavItems[0].id);
    }
  }, [currentUser, visibleNavItems, activeTab]);

  const handleLoginSuccess = async (payload: { user: UserSummary }) => {
    setCurrentUser(payload.user);
    setActionError(null);
    const firstAllowed = NAV_ITEMS.find((item) =>
      !item.requiredAnyPermissions ||
      item.requiredAnyPermissions.some((p) => payload.user.permissions.includes(p))
    );
    if (firstAllowed) setActiveTab(firstAllowed.id);
    await fetchBootstrap();
  };

  const handleLogout = async () => {
    const tokens = getStoredTokens();
    try {
      await apiFetch<{ ok: boolean }>('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify(tokens?.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      });
    } catch {
      // Even if network fails, clear client state cleanly
    } finally {
      clearStoredTokens();
      setCurrentUser(null);
      setStoreData(null);
      setReceiptTransaction(null);
      setActionError(null);
    }
  };

  const lowStockCount = useMemo(() => {
    if (!storeData) return 0;
    return storeData.products.filter((p) => p.stock <= p.minStock).length;
  }, [storeData]);

  const executeCheckout = async (
    payload: CashierCheckoutPayload,
    tokens: { discountPinToken?: string; priceOverridePinToken?: string } = {}
  ) => {
    setActionError(null);
    try {
      const body = await apiFetch<{ transaction: Transaction; store: StoreData }>(
        '/api/transactions',
        {
          method: 'POST',
          body: JSON.stringify({
            ...payload,
            ...(tokens.discountPinToken ? { discountPinToken: tokens.discountPinToken } : {}),
            ...(tokens.priceOverridePinToken
              ? { priceOverridePinToken: tokens.priceOverridePinToken }
              : {}),
          }),
        }
      );
      setStoreData(body.store);
      setReceiptTransaction(body.transaction);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PIN_REQUIRED' && !tokens.discountPinToken) {
        return new Promise<void>((resolve, reject) => {
          setPinRequest({
            action: 'discount_approval',
            title: 'Persetujuan Diskon Kasir',
            description:
              'Diskon manual pada keranjang ini memerlukan otorisasi PIN Supervisor atau Admin.',
            onTokenReady: async (token) => {
              try {
                await executeCheckout(payload, { ...tokens, discountPinToken: token });
                resolve();
              } catch (retryErr) {
                reject(retryErr);
              }
            },
            onCancel: () => reject(new Error('Otorisasi PIN diskon dibatalkan.')),
          });
        });
      }
      if (
        err instanceof ApiError &&
        err.code === 'PRICE_OVERRIDE_PIN_REQUIRED' &&
        !tokens.priceOverridePinToken
      ) {
        return new Promise<void>((resolve, reject) => {
          setPinRequest({
            action: 'price_override',
            title: 'Persetujuan Override Harga Jual',
            description:
              'Perubahan harga satuan di keranjang memerlukan otorisasi PIN Supervisor atau Admin.',
            onTokenReady: async (token) => {
              try {
                await executeCheckout(payload, { ...tokens, priceOverridePinToken: token });
                resolve();
              } catch (retryErr) {
                reject(retryErr);
              }
            },
            onCancel: () => reject(new Error('Otorisasi PIN override harga dibatalkan.')),
          });
        });
      }
      throw err;
    }
  };

  const handleHoldTransaction = async (payload: {
    heldTransactionId?: string | null;
    customerId: string | null;
    notes: string;
    items: CashierCheckoutPayload['items'];
    transactionDiscountType: DiscountMode;
    transactionDiscountValue: number;
    applyTax: boolean;
  }): Promise<Transaction> => {
    setActionError(null);
    const body = await apiFetch<{ transaction: Transaction; store: StoreData }>(
      '/api/transactions/hold',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    setStoreData(body.store);
    return body.transaction;
  };

  const handleResumeHeldTransaction = async (trx: Transaction): Promise<Transaction> => {
    setActionError(null);
    const body = await apiFetch<{ transaction: Transaction; store: StoreData }>(
      `/api/transactions/${trx.id}/resume`,
      {
        method: 'POST',
      }
    );
    setStoreData(body.store);
    return body.transaction;
  };

  const handleCancelTransaction = async (trx: Transaction, reason?: string): Promise<void> => {
    setActionError(null);
    const body = await apiFetch<{ transaction: Transaction; store: StoreData }>(
      `/api/transactions/${trx.id}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }
    );
    setStoreData(body.store);
    if (detailTransaction?.id === trx.id) {
      setDetailTransaction(body.transaction);
    }
  };

  const handleCreateCustomer = async (input: {
    name: string;
    phone?: string;
  }): Promise<Customer> => {
    setActionError(null);
    const body = await apiFetch<{ customer: Customer; store: StoreData }>('/api/customers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    setStoreData(body.store);
    return body.customer;
  };

  const handleSaveProduct = async (payload: ProductSavePayload): Promise<Product> => {
    setActionError(null);
    const isEdit = Boolean(payload.id);
    const url = isEdit ? `/api/products/${payload.id}` : '/api/products';
    const method = isEdit ? 'PUT' : 'POST';

    const body = await apiFetch<{ product: Product; store: StoreData }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setStoreData(body.store);
    return body.product;
  };

  const handleToggleProductStatus = async (product: Product) => {
    setActionError(null);
    const nextStatus = product.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      const body = await apiFetch<{ product: Product; store: StoreData }>(
        `/api/products/${product.id}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: nextStatus }),
        }
      );
      setStoreData(body.store);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Gagal mengubah status produk.');
    }
  };

  const handleDeleteProduct = async (product: Product) => {
    setActionError(null);
    try {
      const body = await apiFetch<{ store: StoreData }>(`/api/products/${product.id}`, {
        method: 'DELETE',
      });
      setStoreData(body.store);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Gagal menghapus produk.');
    }
  };

  const handleAdjustStock = async (
    payload: {
      productId: string;
      type: StockMovementType;
      qty: number;
      notes: string;
    },
    pinApprovalToken?: string
  ) => {
    setActionError(null);
    try {
      const body = await apiFetch<{ store: StoreData }>('/api/stock/adjust', {
        method: 'POST',
        body: JSON.stringify({
          ...payload,
          ...(pinApprovalToken ? { pinApprovalToken } : {}),
        }),
      });
      setStoreData(body.store);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PIN_REQUIRED' && !pinApprovalToken) {
        return new Promise<void>((resolve, reject) => {
          setPinRequest({
            action: 'stock_adjustment',
            title: 'Otorisasi Penyesuaian Stok',
            description:
              'Akun Anda tidak memiliki izin penyesuaian stok langsung. Masukkan PIN Supervisor atau Admin untuk melanjutkan.',
            onTokenReady: async (token) => {
              try {
                await handleAdjustStock(payload, token);
                resolve();
              } catch (retryErr) {
                reject(retryErr);
              }
            },
            onCancel: () => reject(new Error('Otorisasi PIN dibatalkan.')),
          });
        });
      }
      throw err;
    }
  };

  const handleSaveSettings = async (next: StoreSettings) => {
    setActionError(null);
    const body = await apiFetch<{ store: StoreData }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(next),
    });
    setStoreData(body.store);
  };

  if (publicReceiptParams) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900">
        <header className="bg-white border-b border-slate-200 px-4 sm:px-6 h-14 flex items-center justify-between gap-3 no-print">
          <div className="flex items-center gap-2 min-w-0">
            <ReceiptText className="w-4 h-4 text-teal-700 shrink-0" />
            <span className="text-sm font-bold text-slate-900 truncate">
              Struk Digital Resmi · KassaRitel
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              if (typeof window !== 'undefined') {
                window.history.replaceState({}, '', '/');
              }
              setPublicReceiptParams(null);
            }}
            className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
          >
            Buka Aplikasi Kasir
          </button>
        </header>
        <main className="p-4 sm:p-6 max-w-4xl mx-auto">
          <ReceiptDetailView
            transactionId={publicReceiptParams.receiptId}
            publicToken={publicReceiptParams.token}
          />
        </main>
      </div>
    );
  }

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="text-xs font-medium text-slate-500">Memeriksa sesi autentikasi...</div>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  const activeNavDef = NAV_ITEMS.find((n) => n.id === activeTab);
  const activeNavLabel = activeReceiptId ? 'Detail & Cetak Struk' : activeNavDef?.label ?? 'Kasir';
  const isTabAuthorized = hasAnyPermission(activeNavDef?.requiredAnyPermissions);

  const canCreateProduct = currentUser.permissions.includes('products:create');
  const canEditProduct = currentUser.permissions.includes('products:edit');
  const canDeleteProduct = currentUser.permissions.includes('products:delete');
  const canImportProducts = currentUser.permissions.includes('products:import');
  const canManageCatalog = currentUser.permissions.includes('catalog:manage');
  const canAdjustStock = currentUser.permissions.includes('stock:adjust');
  const canApproveDiscount = currentUser.permissions.includes('pos:discount_approve');
  const canOverridePrice = currentUser.permissions.includes('pos:price_override');
  const canHoldTransaction = currentUser.permissions.includes('pos:hold');
  const canResumeTransaction = currentUser.permissions.includes('pos:resume');
  const canCancelTransaction = currentUser.permissions.includes('pos:cancel');
  const canEditSettings = currentUser.permissions.includes('settings:edit');

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 bg-white border-r border-slate-200 no-print">
        <div className="h-16 px-5 flex items-center border-b border-slate-200">
          <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
            KassaRitel
          </span>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Menu Utama">
          {visibleNavItems.map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setActiveTab(id);
                  setActiveReceiptId(null);
                }}
                className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-teal-50 text-teal-800 font-semibold'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon
                    className={`w-4 h-4 shrink-0 ${active ? 'text-teal-700' : 'text-slate-400'}`}
                  />
                  <span className="truncate">{label}</span>
                </span>
                {id === 'reports' && lowStockCount > 0 && (
                  <span className="font-mono text-xs font-semibold text-amber-700 tabular-nums">
                    {lowStockCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-200 space-y-1">
          {canEditSettings && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 rounded-lg transition-colors whitespace-nowrap"
            >
              <Settings className="w-4 h-4 text-slate-400 shrink-0" />
              <span>Pengaturan Toko</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left rounded-lg hover:bg-slate-100 transition-colors"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <User className="w-4 h-4 text-slate-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-900 truncate">
                  {currentUser.fullName}
                </p>
                <p className="text-[11px] text-slate-500 truncate">
                  {currentUser.roles.map((r) => r.name).join(', ')}
                </p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-50 rounded-lg transition-colors whitespace-nowrap"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <span>Keluar</span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer Navigation */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden bg-slate-900/50 flex no-print">
          <div className="w-64 bg-white h-full border-r border-slate-200 flex flex-col">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200">
              <span className="text-base font-bold text-slate-900">KassaRitel</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg"
                aria-label="Tutup menu"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
              {visibleNavItems.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setActiveTab(id);
                    setActiveReceiptId(null);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-lg ${
                    activeTab === id ? 'bg-teal-50 text-teal-800 font-semibold' : 'text-slate-700'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4" />
                    {label}
                  </span>
                  {id === 'reports' && lowStockCount > 0 && (
                    <span className="font-mono text-xs font-semibold text-amber-700 tabular-nums">
                      {lowStockCount}
                    </span>
                  )}
                </button>
              ))}
            </nav>
            <div className="p-3 border-t border-slate-200 space-y-1">
              {canEditSettings && (
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setSettingsOpen(true);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-slate-700 rounded-lg hover:bg-slate-100"
                >
                  <Settings className="w-4 h-4 text-slate-400" />
                  Pengaturan Toko
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setProfileOpen(true);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-slate-700 rounded-lg hover:bg-slate-100"
              >
                <User className="w-4 h-4 text-slate-400" />
                {currentUser.fullName}
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-rose-700 rounded-lg hover:bg-rose-50"
              >
                <LogOut className="w-4 h-4" />
                Keluar
              </button>
            </div>
          </div>
          <div className="flex-1" onClick={() => setMobileMenuOpen(false)} />
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 md:pl-64 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-4 sticky top-0 z-30 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="md:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              aria-label="Buka navigasi"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-500 hidden sm:inline truncate">
                {storeData?.settings.storeName || 'Toko Ritel'}
              </span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
                /
              </span>
              <h1 className="font-semibold text-slate-900 truncate">{activeNavLabel}</h1>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {canCreateProduct && (
              <button
                type="button"
                onClick={() => {
                  setEditingProduct(null);
                  setPrefillBarcode(undefined);
                  setProductModalOpen(true);
                }}
                className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                + Tambah Produk
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {!isTabAuthorized ? (
            <AccessDeniedView
              requiredPermission={activeNavDef?.requiredAnyPermissions?.join(' / ')}
              onGoBack={() => {
                if (visibleNavItems[0]) setActiveTab(visibleNavItems[0].id);
              }}
            />
          ) : loading && !storeData ? (
            <div className="space-y-4">
              <div className="h-16 bg-white border border-slate-200 rounded-xl animate-pulse" />
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                <div className="lg:col-span-8 h-96 bg-white border border-slate-200 rounded-xl animate-pulse" />
                <div className="lg:col-span-4 h-96 bg-white border border-slate-200 rounded-xl animate-pulse" />
              </div>
            </div>
          ) : loadError ? (
            <div className="bg-white border border-rose-200 rounded-xl p-6 text-center max-w-md mx-auto mt-10">
              <p className="text-sm font-semibold text-rose-800">{loadError}</p>
              <button
                type="button"
                onClick={fetchBootstrap}
                className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Muat Ulang Data
              </button>
            </div>
          ) : storeData ? (
            <>
              {actionError && (
                <div className="mb-4 flex items-center justify-between gap-3 px-4 py-3 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-xl">
                  <span>{actionError}</span>
                  <button
                    type="button"
                    onClick={() => setActionError(null)}
                    className="text-rose-700 hover:text-rose-900 font-semibold shrink-0"
                  >
                    Tutup
                  </button>
                </div>
              )}

              {activeReceiptId ? (
                <ReceiptDetailView
                  transactionId={activeReceiptId}
                  settings={storeData.settings}
                  onBack={() => setActiveReceiptId(null)}
                  onStoreUpdate={setStoreData}
                />
              ) : (
                <>
                  {activeTab === 'cashier' && (
                    <CashierView
                      products={storeData.products}
                      customers={storeData.customers ?? []}
                      paymentMethods={storeData.paymentMethods ?? []}
                      heldTransactions={storeData.heldTransactions ?? []}
                      settings={storeData.settings}
                      canCreateProduct={canCreateProduct}
                      canApproveDiscount={canApproveDiscount}
                      canOverridePrice={canOverridePrice}
                      canHold={canHoldTransaction}
                      canResume={canResumeTransaction}
                      canCancel={canCancelTransaction}
                      resumedTransaction={resumedTransaction}
                      onConsumeResumedTransaction={() => setResumedTransaction(null)}
                      onCheckout={(payload) => executeCheckout(payload)}
                      onHoldTransaction={handleHoldTransaction}
                      onResumeHeldTransaction={handleResumeHeldTransaction}
                      onCancelTransaction={handleCancelTransaction}
                      onCreateCustomer={handleCreateCustomer}
                      onOpenNewProductWithBarcode={(code) => {
                        setEditingProduct(null);
                        setPrefillBarcode(code);
                        setProductModalOpen(true);
                      }}
                    />
                  )}

                  {activeTab === 'reports' && (
                    <StockReportView
                      products={storeData.products}
                      stockMovements={storeData.stockMovements}
                      transactions={storeData.transactions.filter((t) => t.status === 'COMPLETED')}
                      onQuickRestock={(product) => setAdjustingProduct(product)}
                    />
                  )}

                  {activeTab === 'inventory' && (
                    <InventoryView
                      products={storeData.products}
                      categories={storeData.categories}
                      brands={storeData.brands}
                      uoms={storeData.uoms}
                      canCreate={canCreateProduct}
                      canEdit={canEditProduct}
                      canDelete={canDeleteProduct}
                      canImport={canImportProducts}
                      canManageCatalog={canManageCatalog}
                      canAdjustStock={canAdjustStock}
                      onAddProduct={() => {
                        setEditingProduct(null);
                        setPrefillBarcode(undefined);
                        setProductModalOpen(true);
                      }}
                      onEditProduct={(product) => {
                        setEditingProduct(product);
                        setPrefillBarcode(undefined);
                        setProductModalOpen(true);
                      }}
                      onToggleProductStatus={handleToggleProductStatus}
                      onDeleteProduct={handleDeleteProduct}
                      onAdjustStock={(product) => setAdjustingProduct(product)}
                      onShowBarcode={(product) => setBarcodeProduct(product)}
                      onStoreUpdate={setStoreData}
                    />
                  )}

                  {activeTab === 'transactions' && (
                    <TransactionsView
                      transactions={storeData.transactions}
                      heldTransactions={storeData.heldTransactions ?? []}
                      paymentMethods={storeData.paymentMethods ?? []}
                      onViewReceipt={(trx) => setReceiptTransaction(trx)}
                      onOpenReceiptDetail={(trx) => setActiveReceiptId(trx.id)}
                      onViewDetail={(trx) => setDetailTransaction(trx)}
                    />
                  )}

                  {activeTab === 'users' && <UsersView currentUser={currentUser} />}

                  {activeTab === 'roles' && (
                    <RolesPermissionsView
                      currentUser={currentUser}
                      onRolesChanged={() => {
                        refreshCurrentUser();
                      }}
                    />
                  )}

                  {activeTab === 'security' && (
                    <SecurityAuditView
                      currentUser={currentUser}
                      auditLogs={storeData.auditLogs}
                      onRefreshAuditLogs={fetchBootstrap}
                      onCurrentSessionRevoked={handleLogout}
                    />
                  )}
                </>
              )}
            </>
          ) : null}
        </main>
      </div>

      {/* Modals */}
      <ProductFormModal
        open={productModalOpen}
        editingProduct={editingProduct}
        initialBarcode={prefillBarcode}
        categories={storeData?.categories ?? []}
        brands={storeData?.brands ?? []}
        uoms={storeData?.uoms ?? []}
        existingProducts={storeData?.products ?? []}
        onClose={() => setProductModalOpen(false)}
        onSubmit={handleSaveProduct}
        onStoreUpdate={setStoreData}
      />

      <StockAdjustModal
        product={adjustingProduct}
        onClose={() => setAdjustingProduct(null)}
        onSubmit={(payload) => handleAdjustStock(payload)}
      />

      <BarcodeLabelModal
        product={barcodeProduct}
        onClose={() => setBarcodeProduct(null)}
      />

      {storeData && (
        <ReceiptModal
          transaction={receiptTransaction}
          settings={storeData.settings}
          onClose={() => setReceiptTransaction(null)}
          onOpenDetailPage={(trxId) => setActiveReceiptId(trxId)}
          onStoreUpdate={setStoreData}
        />
      )}

      <TransactionDetailModal
        transaction={detailTransaction}
        onClose={() => setDetailTransaction(null)}
        onPrintReceipt={(trx) => {
          setDetailTransaction(null);
          setReceiptTransaction(trx);
        }}
        onOpenReceiptDetail={(trx) => {
          setDetailTransaction(null);
          setActiveReceiptId(trx.id);
        }}
        onResumeHeld={
          canResumeTransaction
            ? async (trx) => {
                const resumed = await handleResumeHeldTransaction(trx);
                setDetailTransaction(null);
                setResumedTransaction(resumed);
                setActiveTab('cashier');
              }
            : undefined
        }
        onCancelHeld={
          canCancelTransaction
            ? async (trx) => {
                await handleCancelTransaction(trx, 'Dibatalkan dari detail transaksi');
              }
            : undefined
        }
      />

      {storeData && (
        <SettingsModal
          open={settingsOpen}
          settings={storeData.settings}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
          onStoreUpdate={setStoreData}
        />
      )}

      <ProfileModal
        open={profileOpen}
        user={currentUser}
        onClose={() => setProfileOpen(false)}
      />

      {pinRequest && (
        <PinAuthorizationModal
          open={Boolean(pinRequest)}
          action={pinRequest.action}
          actionTitle={pinRequest.title}
          description={pinRequest.description}
          onClose={() => {
            const cancel = pinRequest.onCancel;
            setPinRequest(null);
            cancel();
          }}
          onAuthorized={async ({ pinApprovalToken }) => {
            const pending = pinRequest;
            setPinRequest(null);
            await pending.onTokenReady(pinApprovalToken);
          }}
        />
      )}
    </div>
  );
}
