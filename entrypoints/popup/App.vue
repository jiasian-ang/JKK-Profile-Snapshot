<script lang="ts" setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome';
import {
  faArrowRight,
  faClockRotateLeft,
  faFileExport,
  faTrashCan,
} from '@fortawesome/free-solid-svg-icons';
import { computed, onMounted, ref } from 'vue';
import {
  formatBytes,
  type ActionResult,
  type PopupState,
  type ProfileSnapshot,
  type SnapshotRedirect,
} from '@/utils/snapshots';

type SnapshotPayload = ActionResult & {
  snapshot?: ProfileSnapshot;
};

const state = ref<PopupState | null>(null);
const loading = ref(true);
const busy = ref(false);
const message = ref('');
const snapshotName = ref('');
const activeView = ref<'site' | 'all'>('site');
const warningOpen = ref(true);
const summaryOpen = ref(true);
const selectedSnapshot = ref<ProfileSnapshot | null>(null);
const detailLoading = ref(false);
const createPanelOpen = ref(false);
const newRedirectLabel = ref('');
const newRedirectPath = ref('');
const redirectBusy = ref(false);

const WARNING_OPEN_KEY = 'profileSnapshotPopup:warningOpen';
const SUMMARY_OPEN_KEY = 'profileSnapshotPopup:summaryOpen';

const currentSnapshots = computed(() => state.value?.snapshots ?? []);
const allGroups = computed(() => state.value?.allGroups ?? []);
const currentTotalSize = computed(() =>
  currentSnapshots.value.reduce((total, snapshot) => total + snapshot.sizeBytes, 0),
);

onMounted(() => {
  warningOpen.value = readBooleanPreference(WARNING_OPEN_KEY, true);
  summaryOpen.value = readBooleanPreference(SUMMARY_OPEN_KEY, true);
  refreshState();
});

async function sendMessage<T>(payload: unknown): Promise<T> {
  return browser.runtime.sendMessage(payload);
}

async function refreshState() {
  loading.value = true;
  message.value = '';

  try {
    state.value = await sendMessage<PopupState>({ type: 'GET_STATE' });
  } catch (error) {
    message.value = friendlyError(error, 'Unable to load extension state.');
  } finally {
    loading.value = false;
  }
}

async function createSnapshot() {
  if (!state.value?.tabId || busy.value) return;
  busy.value = true;
  message.value = '';

  try {
    const result = await sendMessage<ActionResult>({
      type: 'CREATE_SNAPSHOT',
      tabId: state.value.tabId,
      name: snapshotName.value,
    });
    message.value = result.message ?? '';
    if (result.ok) {
      snapshotName.value = '';
      createPanelOpen.value = false;
      await refreshState();
    }
  } catch (error) {
    message.value = friendlyError(error, 'Unable to create snapshot.');
  } finally {
    busy.value = false;
  }
}

async function applySnapshot(
  snapshotId: string,
  snapshotName: string,
  redirect?: SnapshotRedirect,
) {
  if (!state.value?.tabId || busy.value) return;
  const destination = redirect
    ? `\n\nAfter applying, the tab opens ${redirect.path}.`
    : '\n\nAfter applying, the tab reloads on the current page.';
  const confirmed = confirm(
    `Apply "${snapshotName}"?\n\nThis will clear this site's current cookies, localStorage, and sessionStorage.${destination}`,
  );
  if (!confirmed) return;

  await runAction({
    type: 'APPLY_SNAPSHOT',
    tabId: state.value.tabId,
    snapshotId,
    redirectId: redirect?.id,
  });
}

async function deleteSnapshot(snapshotId: string, snapshotName: string) {
  if (busy.value) return;
  const confirmed = confirm(
    `Delete "${snapshotName}"?\n\nThis only removes the saved snapshot. It will not change the current site state.`,
  );
  if (!confirmed) return;

  await runAction({ type: 'DELETE_SNAPSHOT', snapshotId });
}

async function deleteAllSnapshots() {
  if (busy.value) return;
  const confirmed = confirm(
    'Delete every saved Profile Snapshot?\n\nThis does not clear any website browser state, but it cannot be undone.',
  );
  if (!confirmed) return;

  await runAction({ type: 'DELETE_ALL_SNAPSHOTS' });
}

async function exportSnapshot(snapshotId: string) {
  const confirmed = confirm(
    'Export this snapshot?\n\nThe file may contain session cookies, access tokens, client secrets, or other login credentials. Do not share it.',
  );
  if (!confirmed) return;

  try {
    const result = await sendMessage<SnapshotPayload>({ type: 'GET_SNAPSHOT', snapshotId });
    if (!result.ok || !result.snapshot) {
      message.value = result.message ?? 'Snapshot not found.';
      return;
    }

    const blob = new Blob([JSON.stringify(result.snapshot, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${result.snapshot.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
    message.value = 'Snapshot exported.';
  } catch (error) {
    message.value = friendlyError(error, 'Unable to export snapshot.');
  }
}

async function openSnapshotDetails(snapshotId: string) {
  detailLoading.value = true;
  message.value = '';

  try {
    const result = await sendMessage<SnapshotPayload>({ type: 'GET_SNAPSHOT', snapshotId });
    if (!result.ok || !result.snapshot) {
      message.value = result.message ?? 'Snapshot not found.';
      return;
    }

    selectedSnapshot.value = result.snapshot;
  } catch (error) {
    message.value = friendlyError(error, 'Unable to load snapshot details.');
  } finally {
    detailLoading.value = false;
  }
}

function closeSnapshotDetails() {
  selectedSnapshot.value = null;
  newRedirectLabel.value = '';
  newRedirectPath.value = '';
}

async function reloadSelectedSnapshot(snapshotId: string) {
  const result = await sendMessage<SnapshotPayload>({ type: 'GET_SNAPSHOT', snapshotId });
  if (result.ok && result.snapshot) selectedSnapshot.value = result.snapshot;
}

async function saveRedirects(snapshotId: string, redirects: SnapshotRedirect[]) {
  if (redirectBusy.value) return false;
  redirectBusy.value = true;
  message.value = '';

  try {
    const result = await sendMessage<ActionResult>({
      type: 'SET_SNAPSHOT_REDIRECTS',
      snapshotId,
      redirects,
    });
    if (!result.ok) {
      message.value = result.message ?? 'Unable to save redirect targets.';
      return false;
    }
    await reloadSelectedSnapshot(snapshotId);
    await refreshState();
    return true;
  } catch (error) {
    message.value = friendlyError(error, 'Unable to save redirect targets.');
    return false;
  } finally {
    redirectBusy.value = false;
  }
}

async function addRedirect() {
  if (!selectedSnapshot.value) return;
  const path = newRedirectPath.value.trim();
  if (!path) return;

  const next: SnapshotRedirect[] = [
    ...(selectedSnapshot.value.redirects ?? []),
    { id: '', label: newRedirectLabel.value.trim(), path },
  ];
  const saved = await saveRedirects(selectedSnapshot.value.id, next);
  if (saved) {
    newRedirectLabel.value = '';
    newRedirectPath.value = '';
  }
}

async function removeRedirect(redirectId: string) {
  if (!selectedSnapshot.value) return;
  const next = (selectedSnapshot.value.redirects ?? []).filter(
    (redirect) => redirect.id !== redirectId,
  );
  await saveRedirects(selectedSnapshot.value.id, next);
}

async function runAction(payload: unknown) {
  busy.value = true;
  message.value = '';

  try {
    const result = await sendMessage<ActionResult>(payload);
    message.value = result.message ?? '';
    await refreshState();
  } catch (error) {
    message.value = friendlyError(error, 'Action failed.');
  } finally {
    busy.value = false;
  }
}

function friendlyError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function readBooleanPreference(key: string, fallback: boolean) {
  const value = localStorage.getItem(key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function saveDetailsPreference(key: string, event: Event) {
  const details = event.currentTarget as HTMLDetailsElement;
  if (key === WARNING_OPEN_KEY) warningOpen.value = details.open;
  if (key === SUMMARY_OPEN_KEY) summaryOpen.value = details.open;
  localStorage.setItem(key, String(details.open));
}
</script>

<template>
  <main class="popup-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Profile Snapshot</p>
        <h1>{{ state?.origin ?? 'Unsupported page' }}</h1>
      </div>
      <button class="icon-button" :disabled="loading || busy" title="Refresh" @click="refreshState">
        ↻
      </button>
    </header>

    <div
      class="top-panels"
      :class="{ compact: state?.supported && !warningOpen && !summaryOpen }"
    >
      <details
        class="collapsible warning"
        :open="warningOpen"
        @toggle="saveDetailsPreference(WARNING_OPEN_KEY, $event)"
      >
        <summary>
          <span>Security warning</span>
          <span class="summary-hint">Sensitive data</span>
        </summary>
        <p>
          Snapshots can contain login cookies, access tokens, client secrets, and other sensitive
          session data. They stay in local extension storage.
        </p>
      </details>

      <details
        v-if="!loading && state?.supported"
        class="collapsible summary-panel"
        :open="summaryOpen"
        @toggle="saveDetailsPreference(SUMMARY_OPEN_KEY, $event)"
      >
        <summary>
          <span>Storage summary</span>
          <span class="summary-hint">{{ currentSnapshots.length }} snapshots</span>
        </summary>
        <div class="summary-grid">
          <div>
            <span>Current site</span>
            <strong>{{ currentSnapshots.length }}</strong>
          </div>
          <div>
            <span>Site storage</span>
            <strong>{{ formatBytes(currentTotalSize) }}</strong>
          </div>
          <div>
            <span>All storage</span>
            <strong>{{ formatBytes(state.totalSizeBytes) }}</strong>
          </div>
        </div>
      </details>
    </div>

    <p v-if="message" class="message">{{ message }}</p>

    <section v-if="loading" class="empty-state">Loading snapshots...</section>

    <template v-else>
      <section v-if="!state?.supported" class="empty-state">
        <strong>{{ state?.error ?? 'This page cannot be snapshotted.' }}</strong>
        <span>Open a regular http or https page and try again.</span>
      </section>

      <template v-else>
        <div class="segmented">
          <button :class="{ active: activeView === 'site' }" @click="activeView = 'site'">
            Current site
          </button>
          <button :class="{ active: activeView === 'all' }" @click="activeView = 'all'">
            All snapshots
          </button>
        </div>

        <section v-if="activeView === 'site'" class="snapshot-list">
          <div class="section-title">
            <h2>Saved for this site</h2>
            <div class="section-actions">
              <button class="ghost" :disabled="busy" @click="createPanelOpen = !createPanelOpen">
                New snapshot
              </button>
            </div>
          </div>

          <section v-if="createPanelOpen" class="create-panel">
            <label for="snapshot-name">Snapshot name</label>
            <div class="create-row">
              <input
                id="snapshot-name"
                v-model="snapshotName"
                :disabled="busy"
                placeholder="Optional, e.g. admin user - dev"
                @keyup.enter="createSnapshot"
              />
              <button :disabled="busy" @click="createSnapshot">Save</button>
            </div>
          </section>

          <p v-if="currentSnapshots.length === 0" class="empty-state">
            No snapshots saved for this origin yet.
          </p>

          <article v-for="snapshot in currentSnapshots" :key="snapshot.id" class="snapshot-card">
            <button
              class="snapshot-info-button"
              :disabled="detailLoading"
              @click="openSnapshotDetails(snapshot.id)"
            >
              <span class="snapshot-title">{{ snapshot.name }}</span>
              <span>{{ formatDate(snapshot.createdAt) }} · {{ formatBytes(snapshot.sizeBytes) }}</span>
            </button>
            <div class="snapshot-actions">
              <button
                :disabled="busy"
                title="Apply snapshot"
                data-tooltip="Apply snapshot"
                aria-label="Apply snapshot"
                @click="applySnapshot(snapshot.id, snapshot.name)"
              >
                <FontAwesomeIcon :icon="faClockRotateLeft" />
              </button>
              <button
                class="ghost"
                :disabled="busy"
                title="Export snapshot"
                data-tooltip="Export snapshot"
                aria-label="Export snapshot"
                @click="exportSnapshot(snapshot.id)"
              >
                <FontAwesomeIcon :icon="faFileExport" />
              </button>
              <button
                class="danger ghost"
                :disabled="busy"
                title="Delete snapshot"
                data-tooltip="Delete snapshot"
                aria-label="Delete snapshot"
                @click="deleteSnapshot(snapshot.id, snapshot.name)"
              >
                <FontAwesomeIcon :icon="faTrashCan" />
              </button>
            </div>
            <div v-if="snapshot.redirects?.length" class="redirect-buttons">
              <button
                v-for="redirect in snapshot.redirects"
                :key="redirect.id"
                class="redirect-chip"
                :disabled="busy"
                :title="`Apply and open ${redirect.path}`"
                @click="applySnapshot(snapshot.id, snapshot.name, redirect)"
              >
                <FontAwesomeIcon :icon="faArrowRight" />
                <span>{{ redirect.label }}</span>
              </button>
            </div>
          </article>
        </section>

        <section v-else class="snapshot-list">
          <div class="section-title">
            <h2>All saved snapshots</h2>
            <button class="danger ghost" :disabled="busy || state.totalSizeBytes === 0" @click="deleteAllSnapshots">
              Delete all
            </button>
          </div>

          <p v-if="allGroups.length === 0" class="empty-state">No snapshots saved yet.</p>

          <div v-for="group in allGroups" :key="group.origin" class="origin-group">
            <div class="origin-heading">
              <strong>{{ group.origin }}</strong>
              <span>{{ group.snapshots.length }} · {{ formatBytes(group.totalSizeBytes) }}</span>
            </div>
            <article v-for="snapshot in group.snapshots" :key="snapshot.id" class="compact-row">
              <button
                class="compact-info-button"
                :disabled="detailLoading"
                @click="openSnapshotDetails(snapshot.id)"
              >
                <span>{{ snapshot.name }}</span>
                <span>{{ formatDate(snapshot.createdAt) }} · {{ formatBytes(snapshot.sizeBytes) }}</span>
              </button>
              <div class="row-actions">
                <button
                  class="ghost"
                  :disabled="busy"
                  title="Export snapshot"
                  data-tooltip="Export snapshot"
                  aria-label="Export snapshot"
                  @click="exportSnapshot(snapshot.id)"
                >
                  <FontAwesomeIcon :icon="faFileExport" />
                </button>
                <button
                  class="danger ghost"
                  :disabled="busy"
                  title="Delete snapshot"
                  data-tooltip="Delete snapshot"
                  aria-label="Delete snapshot"
                  @click="deleteSnapshot(snapshot.id, snapshot.name)"
                >
                  <FontAwesomeIcon :icon="faTrashCan" />
                </button>
              </div>
            </article>
          </div>
        </section>

        <footer class="storage-note">
          Included now: cookies, localStorage, sessionStorage. Not saved in snapshots yet:
          {{ state.unsupportedStorageTypes.join(', ') }}.
        </footer>
      </template>
    </template>

    <div v-if="selectedSnapshot" class="dialog-backdrop" @click.self="closeSnapshotDetails">
      <section class="snapshot-dialog" role="dialog" aria-modal="true" aria-labelledby="snapshot-dialog-title">
        <header class="dialog-header">
          <div>
            <h2 id="snapshot-dialog-title">{{ selectedSnapshot.name }}</h2>
            <p>{{ selectedSnapshot.origin }} · {{ formatBytes(selectedSnapshot.sizeBytes) }}</p>
          </div>
          <button class="icon-button small-icon" title="Close" aria-label="Close" @click="closeSnapshotDetails">
            ×
          </button>
        </header>

        <p class="dialog-warning">
          This view may expose session cookies, tokens, and client secrets.
        </p>

        <div class="detail-section">
          <h3>Redirect targets ({{ (selectedSnapshot.redirects ?? []).length }})</h3>
          <p class="detail-hint">
            Each target adds an apply button that restores this snapshot and then opens the path on
            {{ selectedSnapshot.origin }}. The plain apply button keeps the current page.
          </p>
          <p v-if="(selectedSnapshot.redirects ?? []).length === 0" class="detail-empty">
            No redirect targets yet.
          </p>
          <div
            v-for="redirect in selectedSnapshot.redirects ?? []"
            :key="redirect.id"
            class="redirect-item"
          >
            <div class="redirect-meta">
              <strong>{{ redirect.label }}</strong>
              <span>{{ redirect.path }}</span>
            </div>
            <button
              class="danger ghost"
              :disabled="redirectBusy"
              title="Remove target"
              aria-label="Remove target"
              @click="removeRedirect(redirect.id)"
            >
              <FontAwesomeIcon :icon="faTrashCan" />
            </button>
          </div>
          <div class="redirect-form">
            <input
              v-model="newRedirectLabel"
              :disabled="redirectBusy"
              placeholder="Label (optional), e.g. Dashboard"
              @keyup.enter="addRedirect"
            />
            <div class="redirect-form-row">
              <input
                v-model="newRedirectPath"
                :disabled="redirectBusy"
                placeholder="Path, e.g. /dashboard"
                @keyup.enter="addRedirect"
              />
              <button :disabled="redirectBusy || !newRedirectPath.trim()" @click="addRedirect">
                Add
              </button>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <h3>Cookies ({{ selectedSnapshot.cookies.length }})</h3>
          <p v-if="selectedSnapshot.cookies.length === 0" class="detail-empty">No cookies saved.</p>
          <div v-for="cookie in selectedSnapshot.cookies" :key="`${cookie.domain}:${cookie.path}:${cookie.name}`" class="detail-item">
            <div class="detail-line">
              <strong>{{ cookie.name }}</strong>
              <span>{{ cookie.domain }}{{ cookie.path }}</span>
            </div>
            <code>{{ cookie.value }}</code>
            <div class="chips compact-chips">
              <span v-if="cookie.httpOnly">HttpOnly</span>
              <span v-if="cookie.secure">Secure</span>
              <span>{{ cookie.sameSite ?? 'sameSite unknown' }}</span>
              <span>{{ cookie.session ? 'Session' : 'Persistent' }}</span>
              <span v-if="cookie.partitionKey">Partitioned</span>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <h3>localStorage ({{ Object.keys(selectedSnapshot.localStorage).length }})</h3>
          <p v-if="Object.keys(selectedSnapshot.localStorage).length === 0" class="detail-empty">
            No localStorage entries saved.
          </p>
          <div v-for="[key, value] in Object.entries(selectedSnapshot.localStorage)" :key="key" class="detail-item">
            <strong>{{ key }}</strong>
            <code>{{ value }}</code>
          </div>
        </div>

        <div class="detail-section">
          <h3>sessionStorage ({{ Object.keys(selectedSnapshot.sessionStorage).length }})</h3>
          <p v-if="Object.keys(selectedSnapshot.sessionStorage).length === 0" class="detail-empty">
            No sessionStorage entries saved.
          </p>
          <div v-for="[key, value] in Object.entries(selectedSnapshot.sessionStorage)" :key="key" class="detail-item">
            <strong>{{ key }}</strong>
            <code>{{ value }}</code>
          </div>
        </div>
      </section>
    </div>
  </main>
</template>
