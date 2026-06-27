import {
  SNAPSHOT_STORAGE_TYPES,
  SNAPSHOT_KEY_PREFIX,
  UNSUPPORTED_STORAGE_TYPES,
  calculateSnapshotSize,
  createSnapshotId,
  defaultSnapshotName,
  getSnapshotKey,
  getSupportedOrigin,
  isSnapshotRecord,
  normalizeRedirects,
  resolveRedirectUrl,
  summarizeSnapshot,
  type ActionResult,
  type PopupState,
  type ProfileSnapshot,
  type SiteSnapshotGroup,
  type SnapshotCookie,
  type SnapshotRedirect,
  type SnapshotSummary,
} from '@/utils/snapshots';

type Request =
  | { type: 'GET_STATE' }
  | { type: 'CREATE_SNAPSHOT'; tabId: number; name?: string }
  | { type: 'APPLY_SNAPSHOT'; tabId: number; snapshotId: string; redirectId?: string }
  | { type: 'DELETE_SNAPSHOT'; snapshotId: string }
  | { type: 'CLEAR_ORIGIN'; tabId: number }
  | { type: 'DELETE_ALL_SNAPSHOTS' }
  | { type: 'GET_SNAPSHOT'; snapshotId: string }
  | { type: 'SET_SNAPSHOT_REDIRECTS'; snapshotId: string; redirects: SnapshotRedirect[] };

type WebStorageDump = {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
};

type BrowserCookie = Browser.cookies.Cookie;
type CookieGetAllDetails = Parameters<typeof browser.cookies.getAll>[0];
type CookieSetDetails = Parameters<typeof browser.cookies.set>[0];

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((request: Request) => {
    return handleRequest(request);
  });
});

async function handleRequest(request: Request) {
  switch (request.type) {
    case 'GET_STATE':
      return getPopupState();
    case 'CREATE_SNAPSHOT':
      return createSnapshot(request.tabId, request.name);
    case 'APPLY_SNAPSHOT':
      return applySnapshot(request.tabId, request.snapshotId, request.redirectId);
    case 'DELETE_SNAPSHOT':
      return deleteSnapshot(request.snapshotId);
    case 'CLEAR_ORIGIN':
      return clearOriginState(request.tabId, true);
    case 'DELETE_ALL_SNAPSHOTS':
      return deleteAllSnapshots();
    case 'GET_SNAPSHOT':
      return getSnapshot(request.snapshotId);
    case 'SET_SNAPSHOT_REDIRECTS':
      return setSnapshotRedirects(request.snapshotId, request.redirects);
  }
}

async function getPopupState(): Promise<PopupState> {
  const tab = await getActiveTab();
  const origin = getSupportedOrigin(tab.url);
  const snapshots = await getAllSnapshots();
  const summaries = snapshots.map(summarizeSnapshot);
  const allGroups = groupSnapshots(summaries);
  const totalSizeBytes = summaries.reduce((total, item) => total + item.sizeBytes, 0);

  if (!origin) {
    return {
      tabId: tab.id,
      pageUrl: tab.url,
      supported: false,
      error: 'This page cannot be snapshotted.',
      snapshots: [],
      allGroups,
      totalSizeBytes,
      unsupportedStorageTypes: UNSUPPORTED_STORAGE_TYPES,
    };
  }

  return {
    tabId: tab.id,
    origin,
    pageUrl: tab.url,
    supported: typeof tab.id === 'number',
    error: typeof tab.id === 'number' ? undefined : 'Unable to read the current tab.',
    snapshots: summaries
      .filter((snapshot) => snapshot.origin === origin)
      .sort(sortNewestFirst),
    allGroups,
    totalSizeBytes,
    unsupportedStorageTypes: UNSUPPORTED_STORAGE_TYPES,
  };
}

async function createSnapshot(tabId: number, requestedName?: string): Promise<ActionResult> {
  const tab = await browser.tabs.get(tabId);
  const origin = getSupportedOrigin(tab.url);
  if (!origin) return fail('This page cannot be snapshotted.');

  try {
    const now = new Date();
    const cookies = await getCookiesForOrigin(origin);
    const webStorage = await readWebStorage(tabId);
    const name = requestedName?.trim() || defaultSnapshotName(origin, now);
    const withoutSize: Omit<ProfileSnapshot, 'sizeBytes'> = {
      id: createSnapshotId(now),
      name,
      origin,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      storageTypes: SNAPSHOT_STORAGE_TYPES,
      cookies,
      localStorage: webStorage.localStorage,
      sessionStorage: webStorage.sessionStorage,
      redirects: [],
    };
    const snapshot: ProfileSnapshot = {
      ...withoutSize,
      sizeBytes: calculateSnapshotSize(withoutSize),
    };

    await browser.storage.local.set({ [getSnapshotKey(snapshot.id)]: snapshot });
    return { ok: true, message: 'Snapshot created.' };
  } catch (error) {
    return fail(toFriendlyError(error, 'Unable to create snapshot.'));
  }
}

async function applySnapshot(
  tabId: number,
  snapshotId: string,
  redirectId?: string,
): Promise<ActionResult> {
  const snapshot = await getStoredSnapshot(snapshotId);
  if (!snapshot) return fail('Snapshot not found.');

  const tab = await browser.tabs.get(tabId);
  const origin = getSupportedOrigin(tab.url);
  if (!origin) return fail('This page cannot be snapshotted.');
  if (origin !== snapshot.origin) {
    return fail(`Open ${snapshot.origin} before applying this snapshot.`);
  }

  const redirect = redirectId
    ? (snapshot.redirects ?? []).find((item) => item.id === redirectId)
    : undefined;
  const redirectUrl = redirect ? resolveRedirectUrl(snapshot.origin, redirect.path) : undefined;

  try {
    await clearOriginState(tabId, false);
    const cookieErrors = await restoreCookies(snapshot);
    await writeWebStorage(tabId, snapshot);

    if (redirectUrl) {
      await browser.tabs.update(tabId, { url: redirectUrl });
    } else {
      await browser.tabs.reload(tabId);
    }

    const destination = redirectUrl ? ` Opening ${redirect!.path}.` : ' The tab was reloaded.';

    if (cookieErrors.length > 0) {
      return {
        ok: true,
        message:
          'Snapshot applied, but some cookies could not be restored. The session may have expired.',
      };
    }

    return { ok: true, message: `Snapshot applied.${destination}` };
  } catch (error) {
    return fail(toFriendlyError(error, 'Unable to apply snapshot.'));
  }
}

async function deleteSnapshot(snapshotId: string): Promise<ActionResult> {
  await browser.storage.local.remove(getSnapshotKey(snapshotId));
  return { ok: true, message: 'Snapshot deleted.' };
}

async function deleteAllSnapshots(): Promise<ActionResult> {
  const snapshots = await getAllSnapshots();
  await browser.storage.local.remove(snapshots.map((snapshot) => getSnapshotKey(snapshot.id)));
  return { ok: true, message: 'All snapshots deleted.' };
}

async function getSnapshot(snapshotId: string) {
  const snapshot = await getStoredSnapshot(snapshotId);
  if (!snapshot) return { ok: false, message: 'Snapshot not found.' };
  return { ok: true, snapshot };
}

async function setSnapshotRedirects(
  snapshotId: string,
  redirects: SnapshotRedirect[],
): Promise<ActionResult> {
  const snapshot = await getStoredSnapshot(snapshotId);
  if (!snapshot) return fail('Snapshot not found.');

  try {
    const base: Omit<ProfileSnapshot, 'sizeBytes'> & { sizeBytes?: number } = {
      ...snapshot,
      redirects: normalizeRedirects(snapshot.origin, redirects),
      updatedAt: new Date().toISOString(),
    };
    const updated: ProfileSnapshot = { ...base, sizeBytes: calculateSnapshotSize(base) };

    await browser.storage.local.set({ [getSnapshotKey(snapshot.id)]: updated });
    return { ok: true, message: 'Redirect targets saved.' };
  } catch (error) {
    return fail(toFriendlyError(error, 'Unable to save redirect targets.'));
  }
}

async function clearOriginState(tabId: number, reload: boolean): Promise<ActionResult> {
  const tab = await browser.tabs.get(tabId);
  const origin = getSupportedOrigin(tab.url);
  if (!origin) return fail('This page cannot be snapshotted.');

  try {
    await clearCookiesForOrigin(origin);
    await clearPageStorage(tabId);
    if (reload) await browser.tabs.reload(tabId);
    return { ok: true, message: 'Current site browser state cleared.' };
  } catch (error) {
    return fail(toFriendlyError(error, 'Unable to clear this site.'));
  }
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab ?? {};
}

async function getAllSnapshots() {
  const records = await browser.storage.local.get(null);
  return Object.entries(records)
    .filter(([key, value]) => key.startsWith(SNAPSHOT_KEY_PREFIX) && isSnapshotRecord(value))
    .map(([, value]) => value as ProfileSnapshot)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function getStoredSnapshot(snapshotId: string) {
  const records = await browser.storage.local.get(getSnapshotKey(snapshotId));
  const snapshot = records[getSnapshotKey(snapshotId)];
  return isSnapshotRecord(snapshot) ? snapshot : undefined;
}

function groupSnapshots(snapshots: SnapshotSummary[]): SiteSnapshotGroup[] {
  const groups = new Map<string, SiteSnapshotGroup>();

  for (const snapshot of snapshots) {
    const group =
      groups.get(snapshot.origin) ??
      ({
        origin: snapshot.origin,
        snapshots: [],
        totalSizeBytes: 0,
      } satisfies SiteSnapshotGroup);

    group.snapshots.push(snapshot);
    group.totalSizeBytes += snapshot.sizeBytes;
    groups.set(snapshot.origin, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, snapshots: group.snapshots.sort(sortNewestFirst) }))
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

function sortNewestFirst(a: SnapshotSummary, b: SnapshotSummary) {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

async function getCookiesForOrigin(origin: string): Promise<SnapshotCookie[]> {
  const { hostname } = new URL(origin);
  const cookies = await getAllCookiePartitions({ domain: hostname });

  return cookies.filter((cookie) => cookieBelongsToHost(cookie, hostname)).map(copyCookie);
}

async function getAllCookiePartitions(details: CookieGetAllDetails) {
  const unpartitioned = await browser.cookies.getAll(details);
  const partitioned = await browser.cookies
    .getAll({ ...details, partitionKey: {} })
    .catch(() => [] as BrowserCookie[]);
  const seen = new Set<string>();
  const cookies: BrowserCookie[] = [];

  for (const cookie of [...unpartitioned, ...partitioned]) {
    const key = [
      cookie.storeId,
      cookie.domain,
      cookie.path,
      cookie.name,
      JSON.stringify(cookie.partitionKey ?? null),
    ].join('|');
    if (!seen.has(key)) {
      seen.add(key);
      cookies.push(cookie);
    }
  }

  return cookies;
}

function copyCookie(cookie: BrowserCookie): SnapshotCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    session: cookie.session,
    expirationDate: cookie.expirationDate,
    storeId: cookie.storeId,
    firstPartyDomain: (cookie as { firstPartyDomain?: string }).firstPartyDomain,
    partitionKey: cookie.partitionKey,
  };
}

function cookieBelongsToHost(cookie: Pick<SnapshotCookie, 'domain' | 'hostOnly'>, hostname: string) {
  const domain = cookie.domain.replace(/^\./, '');
  if (cookie.hostOnly) return domain === hostname;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

async function clearCookiesForOrigin(origin: string) {
  const cookies = await getCookiesForOrigin(origin);
  await Promise.allSettled(
    cookies.map((cookie) =>
      browser.cookies.remove({
        url: cookieUrl(cookie, origin),
        name: cookie.name,
        storeId: cookie.storeId,
        partitionKey: cookie.partitionKey,
      }),
    ),
  );
}

async function restoreCookies(snapshot: ProfileSnapshot) {
  const errors: Error[] = [];

  for (const cookie of snapshot.cookies) {
    const details: CookieSetDetails = {
      url: cookieUrl(cookie, snapshot.origin),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      storeId: cookie.storeId,
      partitionKey: cookie.partitionKey,
    };

    if (!cookie.hostOnly) details.domain = cookie.domain;
    if (!cookie.session && cookie.expirationDate) details.expirationDate = cookie.expirationDate;

    try {
      await browser.cookies.set(details);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return errors;
}

function cookieUrl(cookie: Pick<SnapshotCookie, 'domain' | 'path' | 'secure'>, fallbackOrigin: string) {
  const fallback = new URL(fallbackOrigin);
  const host = cookie.domain.replace(/^\./, '') || fallback.hostname;
  const protocol = cookie.secure ? 'https:' : fallback.protocol;
  const path = cookie.path?.startsWith('/') ? cookie.path : '/';
  return `${protocol}//${host}${path}`;
}

async function readWebStorage(tabId: number): Promise<WebStorageDump> {
  const [result] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => {
      const dumpStorage = (storage: Storage) =>
        Object.fromEntries(
          Array.from({ length: storage.length }, (_, index) => {
            const key = storage.key(index) ?? '';
            return [key, storage.getItem(key) ?? ''];
          }).filter(([key]) => key),
        );

      return {
        localStorage: dumpStorage(localStorage),
        sessionStorage: dumpStorage(sessionStorage),
      };
    },
  });

  if (!result?.result) {
    throw new Error('localStorage / sessionStorage injection failed.');
  }

  return result.result as WebStorageDump;
}

async function writeWebStorage(tabId: number, snapshot: ProfileSnapshot) {
  await browser.scripting.executeScript({
    target: { tabId },
    args: [snapshot.localStorage, snapshot.sessionStorage],
    func: (
      localEntries: Record<string, string>,
      sessionEntries: Record<string, string>,
    ) => {
      localStorage.clear();
      sessionStorage.clear();

      for (const [key, value] of Object.entries(localEntries)) {
        localStorage.setItem(key, value);
      }

      for (const [key, value] of Object.entries(sessionEntries)) {
        sessionStorage.setItem(key, value);
      }
    },
  });
}

async function clearPageStorage(tabId: number) {
  await browser.scripting.executeScript({
    target: { tabId },
    func: async () => {
      localStorage.clear();
      sessionStorage.clear();

      if ('indexedDB' in globalThis && indexedDB.databases) {
        const databases = await indexedDB.databases();
        await Promise.allSettled(
          databases
            .map((database) => database.name)
            .filter((name): name is string => Boolean(name))
            .map(
              (name) =>
                new Promise<void>((resolve) => {
                  const request = indexedDB.deleteDatabase(name);
                  request.onsuccess = () => resolve();
                  request.onerror = () => resolve();
                  request.onblocked = () => resolve();
                }),
            ),
        );
      }

      if ('caches' in globalThis) {
        const keys = await caches.keys();
        await Promise.allSettled(keys.map((key) => caches.delete(key)));
      }

      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.allSettled(registrations.map((registration) => registration.unregister()));
      }
    },
  });
}

function toFriendlyError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : String(error);

  if (/quota|QUOTA|exceeded/i.test(message)) {
    return 'Not enough extension storage space. Delete old snapshots and try again.';
  }

  if (/Cannot access|Missing host permission|Cannot script|Cannot access contents/i.test(message)) {
    return 'This page cannot be snapshotted.';
  }

  if (/localStorage|sessionStorage|injection/i.test(message)) {
    return 'Could not read or write localStorage / sessionStorage for this page.';
  }

  return fallback;
}

function fail(message: string): ActionResult {
  return { ok: false, message };
}
