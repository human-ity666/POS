export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

const STORAGE_KEY = 'kassaritel_auth_tokens';
let memoryTokens: StoredTokens | null = null;

export function getStoredTokens(): StoredTokens | null {
  if (memoryTokens) return memoryTokens;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY) || window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTokens>;
    if (typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string') {
      memoryTokens = { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
      return memoryTokens;
    }
  } catch {
    // Ignore storage access errors in restricted sandboxes
  }
  return null;
}

export function setStoredTokens(accessToken: string, refreshToken: string): void {
  memoryTokens = { accessToken, refreshToken };
  try {
    const serialized = JSON.stringify(memoryTokens);
    window.sessionStorage.setItem(STORAGE_KEY, serialized);
    window.localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Ignore storage access errors; memoryTokens remains active
  }
}

export function clearStoredTokens(): void {
  memoryTokens = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage access errors
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function attemptTokenRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const tokens = getStoredTokens();
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tokens?.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      });
      if (!res.ok) {
        clearStoredTokens();
        return false;
      }
      const data = (await res.json().catch(() => ({}))) as Partial<StoredTokens>;
      if (typeof data.accessToken === 'string' && typeof data.refreshToken === 'string') {
        setStoredTokens(data.accessToken, data.refreshToken);
      }
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const exec = () => {
    const tokens = getStoredTokens();
    const authHeaders: Record<string, string> = {};
    if (tokens?.accessToken) {
      authHeaders.Authorization = `Bearer ${tokens.accessToken}`;
    }
    return fetch(url, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...(init?.headers ?? {}),
      },
    });
  };

  let res = await exec();
  let body = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  } & T;

  if (res.status === 401 && body.code === 'TOKEN_EXPIRED' && url !== '/api/auth/refresh') {
    const refreshed = await attemptTokenRefresh();
    if (refreshed) {
      res = await exec();
      body = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      } & T;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, body.error || `Permintaan gagal (HTTP ${res.status}).`, body.code);
  }

  return body;
}
