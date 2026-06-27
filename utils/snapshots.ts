export type StorageType =
  | 'cookies'
  | 'localStorage'
  | 'sessionStorage'
  | 'indexedDB'
  | 'cacheStorage'
  | 'serviceWorker';

export type SnapshotCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  session: boolean;
  expirationDate?: number;
  storeId?: string;
  firstPartyDomain?: string;
  partitionKey?: {
    topLevelSite?: string;
    hasCrossSiteAncestor?: boolean;
  };
};

export type SnapshotRedirect = {
  id: string;
  label: string;
  path: string;
};

export type ProfileSnapshot = {
  id: string;
  name: string;
  origin: string;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
  storageTypes: StorageType[];
  cookies: SnapshotCookie[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  redirects: SnapshotRedirect[];
};

export type SnapshotSummary = Pick<
  ProfileSnapshot,
  'id' | 'name' | 'origin' | 'createdAt' | 'updatedAt' | 'sizeBytes' | 'storageTypes' | 'redirects'
> & {
  cookieCount: number;
  localStorageCount: number;
  sessionStorageCount: number;
};

export type SiteSnapshotGroup = {
  origin: string;
  snapshots: SnapshotSummary[];
  totalSizeBytes: number;
};

export type PopupState = {
  tabId?: number;
  origin?: string;
  pageUrl?: string;
  supported: boolean;
  error?: string;
  snapshots: SnapshotSummary[];
  allGroups: SiteSnapshotGroup[];
  totalSizeBytes: number;
  unsupportedStorageTypes: StorageType[];
};

export type ActionResult = {
  ok: boolean;
  message?: string;
};

export const SNAPSHOT_KEY_PREFIX = 'profileSnapshot:';
export const SNAPSHOT_STORAGE_TYPES: StorageType[] = [
  'cookies',
  'localStorage',
  'sessionStorage',
];
export const UNSUPPORTED_STORAGE_TYPES: StorageType[] = [
  'indexedDB',
  'cacheStorage',
  'serviceWorker',
];

export function getSnapshotKey(id: string) {
  return `${SNAPSHOT_KEY_PREFIX}${id}`;
}

export function isSnapshotRecord(value: unknown): value is ProfileSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ProfileSnapshot>;
  return (
    typeof snapshot.id === 'string' &&
    typeof snapshot.name === 'string' &&
    typeof snapshot.origin === 'string' &&
    typeof snapshot.createdAt === 'string' &&
    typeof snapshot.updatedAt === 'string' &&
    Array.isArray(snapshot.cookies) &&
    typeof snapshot.localStorage === 'object' &&
    typeof snapshot.sessionStorage === 'object'
  );
}

export function getSupportedOrigin(url: string | undefined) {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function createSnapshotId(date = new Date()) {
  return `snapshot_${date.toISOString().replace(/[:]/g, '-')}`;
}

export function createRedirectId(date = new Date()) {
  return `redirect_${date.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveRedirectUrl(origin: string, path: string): string | undefined {
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function normalizeRedirects(
  origin: string,
  redirects: SnapshotRedirect[],
): SnapshotRedirect[] {
  const seen = new Set<string>();
  const result: SnapshotRedirect[] = [];

  for (const redirect of redirects ?? []) {
    const path = (redirect?.path ?? '').trim();
    if (!path || !resolveRedirectUrl(origin, path) || seen.has(path)) continue;

    seen.add(path);
    result.push({
      id: redirect.id || createRedirectId(),
      label: (redirect.label ?? '').trim() || path,
      path,
    });
  }

  return result;
}

export function defaultSnapshotName(origin: string, date = new Date()) {
  return `${origin} ${date.toLocaleString()}`;
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${
    units[unitIndex]
  }`;
}

export function summarizeSnapshot(snapshot: ProfileSnapshot): SnapshotSummary {
  return {
    id: snapshot.id,
    name: snapshot.name,
    origin: snapshot.origin,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    sizeBytes: snapshot.sizeBytes,
    storageTypes: snapshot.storageTypes,
    redirects: snapshot.redirects ?? [],
    cookieCount: snapshot.cookies.length,
    localStorageCount: Object.keys(snapshot.localStorage).length,
    sessionStorageCount: Object.keys(snapshot.sessionStorage).length,
  };
}

export function calculateSnapshotSize(
  snapshot: Omit<ProfileSnapshot, 'sizeBytes'> & { sizeBytes?: number },
) {
  const encoder = new TextEncoder();
  return encoder.encode(JSON.stringify({ ...snapshot, sizeBytes: 0 })).byteLength;
}
