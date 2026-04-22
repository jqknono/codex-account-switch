import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import {
  AccountMeta,
  AuthFile,
  CurrentSelection,
  ProviderProfile,
  QuotaQueryResult,
  addAccountFromAuth,
  applyRefreshResponse,
  clearActiveModelProvider,
  deleteProviderProfile,
  deserializeSavedValue,
  extractMeta,
  getAccountIdentity,
  getActiveModelProvider,
  getCurrentSelection,
  getDefaultProviderProfile,
  getModeDisplayName,
  getNamedAuthPath,
  getNamedProviderPath,
  getQuotaInfo,
  isRefreshTokenExpiringWithin,
  getSavedAuthPassphrase,
  hasAccountAuthTokens,
  isSerializedSavedValueEncrypted,
  listNamedAuthFiles,
  listProviderModes,
  readCurrentAuth,
  readProviderProfileResult,
  readSavedAuthFileResult,
  refreshAccessToken,
  refreshAccount,
  removeAccount,
  renameAccount,
  serializeSavedValue,
  switchMode,
  syncCurrentAuthToSavedAccount,
  useAccount,
  writeCurrentAuth,
  writeProviderProfile,
  writeSavedAuthFile,
} from "@codex-account-switch/core";
import { logWarn, startPerformanceLog } from "./log";

export type StorageSource = "local" | "cloud";
export type SaveTarget = StorageSource;
const LOG_PREFIX = "[codex-account-switch:vscode:savedEntries]";
const TIMER_REFRESH_TOKEN_THRESHOLD_MS = 5 * 24 * 3600 * 1000;
const SYNCED_CLOUD_STATE_KEY = "codex-account-switch.syncedCloudState.v1";
const SYNCED_CLOUD_MIGRATION_KEY = "codex-account-switch.syncedCloudStateMigration.v1";

export interface SavedAccountInfo {
  id: string;
  name: string;
  source: StorageSource;
  meta: AccountMeta | null;
  auth: AuthFile | null;
  isCurrent: boolean;
  storageState: "ready" | "locked" | "invalid";
  storageMessage?: string;
  encrypted: boolean;
  syncVersion: number | null;
  syncUpdatedAt: string | null;
  currentDeviceName: string | null;
  effectiveAutoRefreshDeviceName: string | null;
  autoRefreshAllowed: boolean | null;
}

export interface SavedProviderInfo {
  id: string;
  name: string;
  source: StorageSource;
  isCurrent: boolean;
  invalid: boolean;
  locked: boolean;
  storageMessage?: string;
  encrypted: boolean;
  auth: Record<string, unknown>;
  config: Record<string, unknown>;
  profile: ProviderProfile | null;
  syncVersion: number | null;
  syncUpdatedAt: string | null;
}

export interface CloudSyncConflict {
  entryType: "account" | "provider";
  name: string;
  expectedEntryVersion: number | null;
  expectedUpdatedAt: string | null;
  currentEntryVersion: number | null;
  currentUpdatedAt: string | null;
}

interface SavedStorageSyncMetadata {
  entryVersion: number | null;
  updatedAt: string | null;
}

interface CloudMutationResult {
  success: boolean;
  message: string;
  conflict?: CloudSyncConflict;
  syncVersion?: number | null;
  syncUpdatedAt?: string | null;
}

export type SavedSelection =
  | { kind: "account"; name: string; source: StorageSource; meta: AccountMeta | null }
  | { kind: "provider"; name: string; source: StorageSource }
  | { kind: "unknown"; meta: AccountMeta | null };

export interface SavedEntriesSnapshot {
  accounts: SavedAccountInfo[];
  selection: SavedSelection;
  byId: Map<string, SavedAccountInfo>;
  bySourceAndName: Map<string, SavedAccountInfo>;
  createdAt: number;
}

export interface SavedAccountQuotaQueryContext {
  snapshot?: SavedEntriesSnapshot;
  sharedQueries?: Map<string, Promise<QuotaQueryResult>>;
}

interface SavedAccountQuotaQueryOptions {
  reason?: string;
}

interface SyncedStorageData {
  version: 1;
  accounts: Record<string, unknown>;
  providers: Record<string, unknown>;
  devices: string[];
  autoRefreshDeviceName: string | null;
}

interface CurrentSelectionMarker {
  kind: "account" | "provider";
  name: string;
  source: StorageSource;
  entryVersion?: number | null;
  updatedAt?: string | null;
}

interface SyncedCloudMigrationState {
  completedAt: string;
  migratedFromLegacy: boolean;
  legacyCleanupSucceeded: boolean;
}

const SYNCED_STORAGE_SETTING = "syncedStorage";
const DEFAULT_TARGET_SETTING = "defaultSaveTarget";
const CLOUD_TOKEN_AUTO_UPDATE_SETTING = "cloudTokenAutoUpdate";
const CLOUD_TOKEN_AUTO_UPDATE_INTERVAL_HOURS_SETTING = "cloudTokenAutoUpdateIntervalHours";
const CURRENT_SELECTION_KEY = "codex-account-switch.currentSavedSelection";
const DEFAULT_CLOUD_TOKEN_AUTO_UPDATE_INTERVAL_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;
const inflightCloudQuotaQueries = new Map<string, Promise<QuotaQueryResult>>();
let inflightAutoRefreshDevicePrompt: Promise<string | null> | null = null;
const EMPTY_SYNC_METADATA: SavedStorageSyncMetadata = {
  entryVersion: null,
  updatedAt: null,
};

let extensionContext: vscode.ExtensionContext | null = null;

function getConfiguration() {
  return vscode.workspace.getConfiguration("codex-account-switch");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSyncedStorage(raw: unknown): SyncedStorageData {
  if (!isRecord(raw) || raw.version !== 1) {
    return getDefaultSyncedStorage();
  }

  return {
    version: 1,
    accounts: isRecord(raw.accounts) ? clone(raw.accounts) : {},
    providers: isRecord(raw.providers) ? clone(raw.providers) : {},
    devices: normalizeDeviceNames(raw.devices),
    autoRefreshDeviceName: getNormalizedAutoRefreshDeviceName(raw.autoRefreshDeviceName),
  };
}

function getSyncMetadata(value: unknown): SavedStorageSyncMetadata {
  if (!isRecord(value)) {
    return {
      entryVersion: null,
      updatedAt: null,
    };
  }

  return {
    entryVersion:
      Number.isInteger(value.entryVersion) && (value.entryVersion as number) >= 1
        ? (value.entryVersion as number)
        : null,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt.length > 0 ? value.updatedAt : null,
  };
}

function nextSyncMetadata(current: SavedStorageSyncMetadata): SavedStorageSyncMetadata {
  return {
    entryVersion: current.entryVersion == null ? 1 : current.entryVersion + 1,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeDeviceNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || normalized.includes(trimmed)) {
      continue;
    }
    normalized.push(trimmed);
  }
  return normalized;
}

function getNormalizedAutoRefreshDeviceName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function applySyncMetadata(value: Record<string, unknown>, metadata: SavedStorageSyncMetadata): Record<string, unknown> {
  value.entryVersion = metadata.entryVersion;
  value.updatedAt = metadata.updatedAt;
  return value;
}

function hasSyncConflict(expectedEntryVersion: number | null | undefined, current: SavedStorageSyncMetadata): boolean {
  return expectedEntryVersion != null && current.entryVersion !== expectedEntryVersion;
}

function readLocalFileSnapshot(filePath: string): Buffer | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function restoreLocalFileSnapshot(filePath: string, snapshot: Buffer | null): void {
  if (snapshot) {
    fs.writeFileSync(filePath, snapshot);
    return;
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function buildConflict(
  entryType: "account" | "provider",
  name: string,
  expected: SavedStorageSyncMetadata,
  current: SavedStorageSyncMetadata,
): CloudSyncConflict {
  return {
    entryType,
    name,
    expectedEntryVersion: expected.entryVersion,
    expectedUpdatedAt: expected.updatedAt,
    currentEntryVersion: current.entryVersion,
    currentUpdatedAt: current.updatedAt,
  };
}

function formatConflictResult(conflict: CloudSyncConflict): CloudMutationResult {
  const label = conflict.entryType === "account" ? "Cloud account" : "Cloud provider";
  const expectedVersion = conflict.expectedEntryVersion ?? "unknown";
  const currentVersion = conflict.currentEntryVersion ?? "unknown";
  const expectedUpdatedAt = conflict.expectedUpdatedAt ?? "unknown";
  const currentUpdatedAt = conflict.currentUpdatedAt ?? "unknown";
  return {
    success: false,
    message:
      `${label} "${conflict.name}" has a sync conflict: `
      + `expected version ${expectedVersion} (${expectedUpdatedAt}), `
      + `current version ${currentVersion} (${currentUpdatedAt}). `
      + "Refresh the list before retrying.",
    conflict,
  };
}

function requireContext(): vscode.ExtensionContext {
  if (!extensionContext) {
    throw new Error("Saved entry context is not initialized.");
  }
  return extensionContext;
}

function getMarker(): CurrentSelectionMarker | null {
  return requireContext().globalState.get<CurrentSelectionMarker>(CURRENT_SELECTION_KEY) ?? null;
}

async function setMarker(marker: CurrentSelectionMarker | null): Promise<void> {
  await requireContext().globalState.update(CURRENT_SELECTION_KEY, marker ?? undefined);
}

async function updateMarkerSyncMetadata(
  kind: "account" | "provider",
  name: string,
  metadata: SavedStorageSyncMetadata,
): Promise<void> {
  const marker = getMarker();
  if (!marker || marker.source !== "cloud" || marker.kind !== kind || marker.name !== name) {
    return;
  }
  await setMarker({
    ...marker,
    entryVersion: metadata.entryVersion,
    updatedAt: metadata.updatedAt,
  });
}

function getDefaultSyncedStorage(): SyncedStorageData {
  return {
    version: 1,
    accounts: {},
    providers: {},
    devices: [],
    autoRefreshDeviceName: null,
  };
}

function readLegacySyncedStorage(): SyncedStorageData {
  return normalizeSyncedStorage(getConfiguration().get<unknown>(SYNCED_STORAGE_SETTING, getDefaultSyncedStorage()));
}

function getSyncedCloudMigrationState(): SyncedCloudMigrationState | null {
  return requireContext().globalState.get<SyncedCloudMigrationState>(SYNCED_CLOUD_MIGRATION_KEY) ?? null;
}

async function setSyncedCloudMigrationState(state: SyncedCloudMigrationState): Promise<void> {
  await requireContext().globalState.update(SYNCED_CLOUD_MIGRATION_KEY, state);
}

function readSyncedStorage(): SyncedStorageData {
  const raw = requireContext().globalState.get<unknown>(SYNCED_CLOUD_STATE_KEY);
  return normalizeSyncedStorage(raw);
}

async function writeSyncedStorage(data: SyncedStorageData): Promise<void> {
  await requireContext().globalState.update(SYNCED_CLOUD_STATE_KEY, clone(data));
}

async function clearLegacySyncedStorage(): Promise<void> {
  await getConfiguration().update(SYNCED_STORAGE_SETTING, undefined, vscode.ConfigurationTarget.Global);
}

export async function initializeSavedEntries(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  context.globalState.setKeysForSync([SYNCED_CLOUD_STATE_KEY]);

  const existingGlobalState = context.globalState.get<unknown>(SYNCED_CLOUD_STATE_KEY);
  if (existingGlobalState !== undefined) {
    if (!getSyncedCloudMigrationState()) {
      await setSyncedCloudMigrationState({
        completedAt: new Date().toISOString(),
        migratedFromLegacy: false,
        legacyCleanupSucceeded: true,
      });
    }
    return;
  }

  if (getSyncedCloudMigrationState()) {
    return;
  }

  const legacy = readLegacySyncedStorage();
  if (!hasSyncedDeviceState(legacy)) {
    await setSyncedCloudMigrationState({
      completedAt: new Date().toISOString(),
      migratedFromLegacy: false,
      legacyCleanupSucceeded: true,
    });
    return;
  }

  await writeSyncedStorage(legacy);

  let legacyCleanupSucceeded = false;
  try {
    await clearLegacySyncedStorage();
    legacyCleanupSucceeded = true;
  } catch (error) {
    logWarn(LOG_PREFIX, "legacy-synced-storage-cleanup-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    void vscode.window.showWarningMessage(
      "Synced cloud storage was migrated to extension state, but clearing the legacy User Settings entry failed. The new synced storage is active."
    );
  }

  await setSyncedCloudMigrationState({
    completedAt: new Date().toISOString(),
    migratedFromLegacy: true,
    legacyCleanupSucceeded,
  });
}

export function getSyncedStorageSettingKey(): string {
  return SYNCED_STORAGE_SETTING;
}

export function getSyncedCloudStateKey(): string {
  return SYNCED_CLOUD_STATE_KEY;
}

export function hasEncryptedSyncedEntries(): boolean {
  const storage = readSyncedStorage();
  return Object.values(storage.accounts).some((value) => isSerializedSavedValueEncrypted(value))
    || Object.values(storage.providers).some((value) => isSerializedSavedValueEncrypted(value));
}

export function getCurrentDeviceName(): string {
  const hostname = os.hostname().trim();
  return hostname.length > 0 ? hostname : "unknown-device";
}

export function getEffectiveAutoRefreshDeviceName(storage = readSyncedStorage()): string | null {
  if (storage.autoRefreshDeviceName && storage.devices.includes(storage.autoRefreshDeviceName)) {
    return storage.autoRefreshDeviceName;
  }
  return storage.devices[0] ?? null;
}

export function canCurrentDeviceAutoRefresh(storage = readSyncedStorage()): boolean {
  return getEffectiveAutoRefreshDeviceName(storage) === getCurrentDeviceName();
}

export function listSyncedDevices(): string[] {
  return [...readSyncedStorage().devices];
}

function hasSyncedDeviceState(storage: SyncedStorageData): boolean {
  return (
    storage.devices.length > 0
    || storage.autoRefreshDeviceName != null
    || Object.keys(storage.accounts).length > 0
    || Object.keys(storage.providers).length > 0
  );
}

export async function ensureCurrentDeviceRegistered(options?: { onActivate?: boolean }): Promise<SyncedStorageData> {
  const storage = readSyncedStorage();
  if (options?.onActivate && !hasSyncedDeviceState(storage)) {
    return storage;
  }

  const currentDeviceName = getCurrentDeviceName();
  if (storage.devices.includes(currentDeviceName)) {
    return storage;
  }

  storage.devices = [...storage.devices, currentDeviceName];
  await writeSyncedStorage(storage);
  return storage;
}

export async function setAutoRefreshDeviceName(deviceName: string | null): Promise<void> {
  const storage = await ensureCurrentDeviceRegistered();
  const normalized = typeof deviceName === "string" ? deviceName.trim() : "";
  storage.autoRefreshDeviceName = normalized && storage.devices.includes(normalized) ? normalized : null;
  await writeSyncedStorage(storage);
}

async function promptForAutoRefreshDevice(devices: string[]): Promise<string | null> {
  const currentDeviceName = getCurrentDeviceName();
  const options = normalizeDeviceNames([...devices, currentDeviceName]);
  if (options.length === 0) {
    return null;
  }
  if (inflightAutoRefreshDevicePrompt) {
    return inflightAutoRefreshDevicePrompt;
  }

  inflightAutoRefreshDevicePrompt = (async () => {
    const picked = await vscode.window.showQuickPick(
      options.map((deviceName) => ({
        label: deviceName,
        description: deviceName === currentDeviceName ? "Current device" : undefined,
        deviceName,
      })),
      {
        placeHolder: "Select the synced device that is allowed to automatically refresh cloud tokens",
      },
    );
    if (!picked) {
      return null;
    }
    await setAutoRefreshDeviceName(picked.deviceName);
    return picked.deviceName;
  })();

  try {
    return await inflightAutoRefreshDevicePrompt;
  } finally {
    inflightAutoRefreshDevicePrompt = null;
  }
}

async function resolveAutomaticRefreshAuthority(): Promise<{ allowed: boolean; storage: SyncedStorageData }> {
  let storage = readSyncedStorage();

  if (storage.autoRefreshDeviceName && !storage.devices.includes(storage.autoRefreshDeviceName)) {
    const selectedDeviceName = await promptForAutoRefreshDevice(storage.devices);
    storage = readSyncedStorage();
    if (!selectedDeviceName) {
      return {
        allowed: false,
        storage,
      };
    }
  }

  return {
    allowed: canCurrentDeviceAutoRefresh(storage),
    storage,
  };
}

function requireCloudPassphrase(): void {
  if (!getSavedAuthPassphrase()) {
    throw new Error("Cloud storage requires a local storage password before saving synced auth data.");
  }
}

function toId(source: StorageSource, name: string): string {
  return `${source}:${name}`;
}

function getAccountLookupKey(source: StorageSource, name: string): string {
  return `${source}:${name}`;
}

function parseProviderProfile(name: string, value: unknown): ProviderProfile | null {
  if (!isRecord(value) || value.kind !== "provider" || value.name !== name) {
    return null;
  }
  if (!isRecord(value.auth) || !isRecord(value.config)) {
    return null;
  }
  if (
    typeof value.config.name !== "string"
    || typeof value.config.base_url !== "string"
    || typeof value.config.wire_api !== "string"
  ) {
    return null;
  }
  return {
    kind: "provider",
    name,
    auth: clone(value.auth) as AuthFile,
    config: {
      name: value.config.name,
      base_url: value.config.base_url,
      wire_api: value.config.wire_api,
    },
  };
}

function getCloudAccountNames(): string[] {
  return Object.keys(readSyncedStorage().accounts).sort();
}

function getCloudProviderNames(): string[] {
  return Object.keys(readSyncedStorage().providers).sort();
}

function getStoredCloudAccountRaw(name: string): unknown {
  return readSyncedStorage().accounts[name];
}

function getStoredCloudProviderRaw(name: string): unknown {
  return readSyncedStorage().providers[name];
}

function readCloudAccount(name: string) {
  return deserializeSavedValue<AuthFile>(getStoredCloudAccountRaw(name), "saved_auth");
}

function readCloudProvider(name: string) {
  return deserializeSavedValue<ProviderProfile>(getStoredCloudProviderRaw(name), "saved_provider");
}

function getLocalAccounts(perf?: ReturnType<typeof startPerformanceLog>): SavedAccountInfo[] {
  const names = listNamedAuthFiles();
  perf?.mark("list-local-auth-files", {
    localFileCount: names.length,
  });
  const accounts = names.map((name) => {
    const result = readSavedAuthFileResult(getNamedAuthPath(name));
    if (result.status === "ok") {
      return {
        id: toId("local", name),
        name,
        source: "local" as const,
        meta: extractMeta(result.value),
        auth: result.value,
        isCurrent: false,
        storageState: "ready" as const,
        storageMessage: undefined,
        encrypted: result.encrypted,
        syncVersion: null,
        syncUpdatedAt: null,
        currentDeviceName: null,
        effectiveAutoRefreshDeviceName: null,
        autoRefreshAllowed: null,
      };
    }

    return {
      id: toId("local", name),
      name,
      source: "local" as const,
      meta: null,
      auth: null,
      isCurrent: false,
      storageState: result.status === "locked" ? "locked" as const : "invalid" as const,
      storageMessage: "message" in result ? result.message : undefined,
      encrypted: result.encrypted,
      syncVersion: null,
      syncUpdatedAt: null,
      currentDeviceName: null,
      effectiveAutoRefreshDeviceName: null,
      autoRefreshAllowed: null,
    };
  });
  perf?.mark("read-local-auth-files", {
    localCount: accounts.length,
  });
  return accounts;
}

function getCloudAccounts(perf?: ReturnType<typeof startPerformanceLog>): SavedAccountInfo[] {
  const storage = readSyncedStorage();
  perf?.mark("read-synced-storage", {
    cloudAccountCount: Object.keys(storage.accounts).length,
  });
  const currentDeviceName = getCurrentDeviceName();
  const effectiveAutoRefreshDeviceName = getEffectiveAutoRefreshDeviceName(storage);
  const autoRefreshAllowed = effectiveAutoRefreshDeviceName === currentDeviceName;
  const accounts = Object.keys(storage.accounts).sort().map((name) => {
    const raw = storage.accounts[name];
    const syncMetadata = getSyncMetadata(raw);
    const result = readCloudAccount(name);
    if (result.status === "ok") {
      return {
        id: toId("cloud", name),
        name,
        source: "cloud" as const,
        meta: extractMeta(result.value),
        auth: result.value,
        isCurrent: false,
        storageState: "ready" as const,
        encrypted: result.encrypted,
        syncVersion: syncMetadata.entryVersion,
        syncUpdatedAt: syncMetadata.updatedAt,
        currentDeviceName,
        effectiveAutoRefreshDeviceName,
        autoRefreshAllowed,
      };
    }

    return {
      id: toId("cloud", name),
      name,
      source: "cloud" as const,
      meta: null,
      auth: null,
      isCurrent: false,
      storageState: result.status === "locked" ? "locked" as const : "invalid" as const,
      storageMessage: "message" in result ? result.message : undefined,
      encrypted: result.encrypted,
      syncVersion: syncMetadata.entryVersion,
      syncUpdatedAt: syncMetadata.updatedAt,
      currentDeviceName,
      effectiveAutoRefreshDeviceName,
      autoRefreshAllowed,
    };
  });
  perf?.mark("deserialize-cloud-accounts", {
    cloudCount: accounts.length,
  });
  return accounts;
}

function getLocalProviders(): SavedProviderInfo[] {
  return listProviderModes().map((name) => {
    const result = readProviderProfileResult(name);
    const profile = result.status === "ok" ? result.value : null;
    return {
      id: toId("local", name),
      name,
      source: "local" as const,
      isCurrent: false,
      invalid: result.status === "invalid",
      locked: result.status === "locked",
      storageMessage: "message" in result ? result.message : undefined,
      encrypted: result.encrypted,
      auth: profile?.auth ?? {},
      config: profile ? { ...profile.config } : {},
      profile,
      syncVersion: null,
      syncUpdatedAt: null,
    };
  });
}

function getCloudProviders(): SavedProviderInfo[] {
  return getCloudProviderNames().map((name) => {
    const raw = getStoredCloudProviderRaw(name);
    const syncMetadata = getSyncMetadata(raw);
    const result = readCloudProvider(name);
    const profile = result.status === "ok" ? parseProviderProfile(name, result.value) : null;
    return {
      id: toId("cloud", name),
      name,
      source: "cloud" as const,
      isCurrent: false,
      invalid: result.status === "invalid" || (result.status === "ok" && !profile),
      locked: result.status === "locked",
      storageMessage:
        result.status === "ok" && !profile
          ? `Provider "${name}" is invalid.`
          : "message" in result
            ? result.message
            : undefined,
      encrypted: result.encrypted,
      auth: profile?.auth ?? {},
      config: profile ? { ...profile.config } : {},
      profile,
      syncVersion: syncMetadata.entryVersion,
      syncUpdatedAt: syncMetadata.updatedAt,
    };
  });
}

function selectCurrentAccount(accounts: SavedAccountInfo[]): SavedAccountInfo[] {
  const currentAuth = readCurrentAuth();
  if (!currentAuth || getActiveModelProvider()) {
    return accounts;
  }

  const identity = getAccountIdentity(currentAuth);
  const marker = getMarker();
  const matches = accounts.filter((account) => account.auth && getAccountIdentity(account.auth) === identity);
  const current =
    marker?.kind === "account"
      ? matches.find((account) => account.source === marker.source && account.name === marker.name) ?? matches[0]
      : matches[0];

  return accounts.map((account) => ({
    ...account,
    isCurrent: current ? account.id === current.id : false,
  }));
}

function selectCurrentProvider(providers: SavedProviderInfo[]): SavedProviderInfo[] {
  const activeProvider = getActiveModelProvider();
  if (!activeProvider) {
    return providers;
  }

  const marker = getMarker();
  return providers.map((provider) => ({
    ...provider,
    isCurrent:
      provider.name === activeProvider
      && (
        marker?.kind === "provider"
          ? marker.source === provider.source && marker.name === provider.name
          : provider.source === "local"
      ),
  }));
}

function buildSavedSelection(accounts: SavedAccountInfo[], perf?: ReturnType<typeof startPerformanceLog>): SavedSelection {
  const activeProvider = getActiveModelProvider();
  perf?.mark("get-active-provider", {
    hasActiveProvider: Boolean(activeProvider),
  });
  if (activeProvider) {
    const marker = getMarker();
    return {
      kind: "provider",
      name: activeProvider,
      source: marker?.kind === "provider" && marker.name === activeProvider ? marker.source : "local",
    };
  }

  const currentAuth = readCurrentAuth();
  perf?.mark("read-current-auth", {
    hasCurrentAuth: Boolean(currentAuth),
  });
  if (!currentAuth) {
    return { kind: "unknown", meta: null };
  }

  const identity = getAccountIdentity(currentAuth);
  const marker = getMarker();
  const matches = accounts.filter((account) => account.storageState === "ready" && account.auth && getAccountIdentity(account.auth) === identity);
  perf?.mark("find-ready-account-matches", {
    matchCount: matches.length,
  });
  if (matches.length === 0) {
    const selection = getLocalSelection();
    return selection.kind === "unknown"
      ? selection
      : { kind: "unknown", meta: extractMeta(currentAuth) };
  }

  const current =
    marker?.kind === "account"
      ? matches.find((account) => account.source === marker.source && account.name === marker.name) ?? matches[0]
      : matches[0];

  return {
    kind: "account",
    name: current.name,
    source: current.source,
    meta: current.meta,
  };
}

function buildSavedEntriesSnapshot(perf?: ReturnType<typeof startPerformanceLog>): SavedEntriesSnapshot {
  const localAccounts = getLocalAccounts(perf);
  const cloudAccounts = getCloudAccounts(perf);
  const accounts = selectCurrentAccount([...localAccounts, ...cloudAccounts]);
  perf?.mark("select-current-account", {
    localCount: localAccounts.length,
    cloudCount: cloudAccounts.length,
    totalCount: accounts.length,
  });
  const selection = buildSavedSelection(accounts, perf);
  const byId = new Map<string, SavedAccountInfo>();
  const bySourceAndName = new Map<string, SavedAccountInfo>();
  for (const account of accounts) {
    byId.set(account.id, account);
    bySourceAndName.set(getAccountLookupKey(account.source, account.name), account);
  }
  perf?.mark("build-account-indexes", {
    totalCount: accounts.length,
  });
  return {
    accounts,
    selection,
    byId,
    bySourceAndName,
    createdAt: Date.now(),
  };
}

export function createSavedEntriesSnapshot(): SavedEntriesSnapshot {
  const perf = startPerformanceLog(LOG_PREFIX, "listSavedAccounts");
  try {
    const snapshot = buildSavedEntriesSnapshot(perf);
    perf.finish({
      localCount: snapshot.accounts.filter((account) => account.source === "local").length,
      cloudCount: snapshot.accounts.filter((account) => account.source === "cloud").length,
      totalCount: snapshot.accounts.length,
      selectionKind: snapshot.selection.kind,
    });
    return snapshot;
  } catch (error) {
    perf.fail(error);
    throw error;
  }
}

export function listSavedAccounts(): SavedAccountInfo[] {
  return createSavedEntriesSnapshot().accounts;
}

export function listSavedProviders(): SavedProviderInfo[] {
  return selectCurrentProvider([...getLocalProviders(), ...getCloudProviders()]);
}

export function getSavedAccountEntry(
  name: string,
  source: StorageSource,
  snapshot?: SavedEntriesSnapshot,
): SavedAccountInfo | null {
  if (snapshot) {
    return snapshot.bySourceAndName.get(getAccountLookupKey(source, name)) ?? null;
  }
  return listSavedAccounts().find((account) => account.name === name && account.source === source) ?? null;
}

export function getSavedProviderEntry(name: string, source: StorageSource): SavedProviderInfo | null {
  return listSavedProviders().find((provider) => provider.name === name && provider.source === source) ?? null;
}

export function getDefaultSaveTarget(): SaveTarget {
  return getConfiguration().get<SaveTarget>(DEFAULT_TARGET_SETTING, "local");
}

function getCloudTokenAutoUpdate(): boolean {
  return getConfiguration().get<boolean>(CLOUD_TOKEN_AUTO_UPDATE_SETTING, false);
}

function getCloudTokenAutoUpdateIntervalHours(): number {
  const raw = getConfiguration().get<number>(
    CLOUD_TOKEN_AUTO_UPDATE_INTERVAL_HOURS_SETTING,
    DEFAULT_CLOUD_TOKEN_AUTO_UPDATE_INTERVAL_HOURS,
  );
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_CLOUD_TOKEN_AUTO_UPDATE_INTERVAL_HOURS;
}

function markCloudTokenSync(auth: AuthFile): void {
  auth.last_cloud_token_sync = new Date().toISOString();
}

function shouldAutoPersistCloudTokens(auth: AuthFile): boolean {
  if (!getCloudTokenAutoUpdate()) {
    return false;
  }

  const lastCloudTokenSync = auth.last_cloud_token_sync;
  if (typeof lastCloudTokenSync !== "string" || lastCloudTokenSync.length === 0) {
    return true;
  }

  const lastSyncTime = Date.parse(lastCloudTokenSync);
  if (Number.isNaN(lastSyncTime)) {
    return true;
  }

  return Date.now() - lastSyncTime >= getCloudTokenAutoUpdateIntervalHours() * HOUR_MS;
}

async function persistCloudAccountAuth(
  name: string,
  auth: AuthFile,
  mode: "manual" | "automatic",
  expectedEntryVersion?: number | null,
  expectedUpdatedAt?: string | null,
): Promise<CloudMutationResult | { success: true; skipped: true }> {
  if (mode === "automatic") {
    if (!shouldAutoPersistCloudTokens(auth)) {
      return { success: true, skipped: true };
    }
    const authority = await resolveAutomaticRefreshAuthority();
    if (!authority.allowed) {
      return { success: true, skipped: true };
    }
  }

  markCloudTokenSync(auth);
  return writeCloudAccountWithExpectedVersion(name, auth, expectedEntryVersion, expectedUpdatedAt);
}

function getReadyAccounts(snapshot?: SavedEntriesSnapshot): SavedAccountInfo[] {
  const accounts = snapshot?.accounts ?? listSavedAccounts();
  return accounts.filter((account) => account.storageState === "ready" && account.auth);
}

function getLocalSelection(): CurrentSelection {
  return getCurrentSelection();
}

export function getSavedCurrentSelection(snapshot?: SavedEntriesSnapshot): SavedSelection {
  const perf = startPerformanceLog(LOG_PREFIX, "getSavedCurrentSelection");
  try {
    const result = snapshot?.selection ?? buildSavedEntriesSnapshot(perf).selection;
    perf.finish({
      kind: result.kind,
      name: "name" in result ? result.name : null,
      source: "source" in result ? result.source : null,
    });
    return result;
  } catch (error) {
    perf.fail(error);
    throw error;
  }
}

async function writeCloudAccountWithExpectedVersion(
  name: string,
  auth: AuthFile,
  expectedEntryVersion?: number | null,
  expectedUpdatedAt?: string | null,
): Promise<CloudMutationResult> {
  requireCloudPassphrase();
  await ensureCurrentDeviceRegistered();
  const storage = readSyncedStorage();
  const currentMetadata = getSyncMetadata(storage.accounts[name]);
  if (hasSyncConflict(expectedEntryVersion, currentMetadata)) {
    return formatConflictResult(
      buildConflict(
        "account",
        name,
        {
          entryVersion: expectedEntryVersion ?? null,
          updatedAt: expectedUpdatedAt ?? null,
        },
        currentMetadata,
      ),
    );
  }
  const nextMetadata = nextSyncMetadata(currentMetadata);
  storage.accounts[name] = applySyncMetadata(serializeSavedValue("saved_auth", auth as Record<string, unknown>, {
    requireEncryption: true,
  }), nextMetadata);
  await writeSyncedStorage(storage);
  return {
    success: true,
    message: `Account "${name}" was saved to cloud storage`,
    syncVersion: nextMetadata.entryVersion,
    syncUpdatedAt: nextMetadata.updatedAt,
  };
}

async function writeCloudProviderWithExpectedVersion(
  profile: ProviderProfile,
  expectedEntryVersion?: number | null,
  expectedUpdatedAt?: string | null,
): Promise<CloudMutationResult> {
  requireCloudPassphrase();
  await ensureCurrentDeviceRegistered();
  const storage = readSyncedStorage();
  const currentMetadata = getSyncMetadata(storage.providers[profile.name]);
  if (hasSyncConflict(expectedEntryVersion, currentMetadata)) {
    return formatConflictResult(
      buildConflict(
        "provider",
        profile.name,
        {
          entryVersion: expectedEntryVersion ?? null,
          updatedAt: expectedUpdatedAt ?? null,
        },
        currentMetadata,
      ),
    );
  }
  const nextMetadata = nextSyncMetadata(currentMetadata);
  storage.providers[profile.name] = applySyncMetadata(serializeSavedValue("saved_provider", profile as unknown as Record<string, unknown>, {
    requireEncryption: true,
  }), nextMetadata);
  await writeSyncedStorage(storage);
  return {
    success: true,
    message: `Provider "${profile.name}" was saved to cloud storage`,
    syncVersion: nextMetadata.entryVersion,
    syncUpdatedAt: nextMetadata.updatedAt,
  };
}

async function renameCloudAccountEntry(
  account: SavedAccountInfo,
  newName: string,
): Promise<CloudMutationResult> {
  const storage = readSyncedStorage();
  if (!(account.name in storage.accounts)) {
    return { success: false, message: `Account "${account.name}" does not exist.` };
  }
  if (newName in storage.accounts) {
    return { success: false, message: `Account "${newName}" already exists.` };
  }

  const currentMetadata = getSyncMetadata(storage.accounts[account.name]);
  if (hasSyncConflict(account.syncVersion, currentMetadata)) {
    return formatConflictResult(
      buildConflict(
        "account",
        account.name,
        {
          entryVersion: account.syncVersion,
          updatedAt: account.syncUpdatedAt,
        },
        currentMetadata,
      ),
    );
  }

  const nextMetadata = nextSyncMetadata(currentMetadata);
  const currentRaw = storage.accounts[account.name];
  storage.accounts[newName] = isRecord(currentRaw)
    ? applySyncMetadata(clone(currentRaw), nextMetadata)
    : applySyncMetadata(
        serializeSavedValue("saved_auth", (account.auth ?? {}) as Record<string, unknown>, {
          requireEncryption: true,
        }),
        nextMetadata,
      );
  delete storage.accounts[account.name];
  await writeSyncedStorage(storage);

  const marker = getMarker();
  if (marker?.kind === "account" && marker.source === "cloud" && marker.name === account.name) {
    await setMarker({
      ...marker,
      name: newName,
      entryVersion: nextMetadata.entryVersion,
      updatedAt: nextMetadata.updatedAt,
    });
  }

  return {
    success: true,
    message: `Renamed account "${account.name}" to "${newName}"`,
    syncVersion: nextMetadata.entryVersion,
    syncUpdatedAt: nextMetadata.updatedAt,
  };
}

async function removeCloudAccountEntry(
  name: string,
  expected: SavedStorageSyncMetadata = EMPTY_SYNC_METADATA,
): Promise<CloudMutationResult> {
  const storage = readSyncedStorage();
  if (!(name in storage.accounts)) {
    return { success: false, message: `Account "${name}" does not exist.` };
  }
  const currentMetadata = getSyncMetadata(storage.accounts[name]);
  if (hasSyncConflict(expected.entryVersion, currentMetadata)) {
    return formatConflictResult(buildConflict("account", name, expected, currentMetadata));
  }
  delete storage.accounts[name];
  await writeSyncedStorage(storage);
  return { success: true, message: `Account "${name}" was removed` };
}

async function removeCloudProviderEntry(
  name: string,
  expected: SavedStorageSyncMetadata = EMPTY_SYNC_METADATA,
): Promise<CloudMutationResult> {
  const storage = readSyncedStorage();
  if (!(name in storage.providers)) {
    return { success: false, message: `Provider "${name}" does not exist.` };
  }
  const currentMetadata = getSyncMetadata(storage.providers[name]);
  if (hasSyncConflict(expected.entryVersion, currentMetadata)) {
    return formatConflictResult(buildConflict("provider", name, expected, currentMetadata));
  }
  delete storage.providers[name];
  await writeSyncedStorage(storage);
  return { success: true, message: `Removed provider "${name}"` };
}

export async function syncCurrentAuthToSavedSelection(): Promise<CloudMutationResult | null> {
  const marker = getMarker();
  if (!marker || marker.source === "local") {
    syncCurrentAuthToSavedAccount();
    return null;
  }

  if (marker.kind === "account") {
    const auth = readCurrentAuth();
    if (auth && hasAccountAuthTokens(auth)) {
      const result = await persistCloudAccountAuth(
        marker.name,
        auth,
        "automatic",
        marker.entryVersion,
        marker.updatedAt,
      );
      if (!result.success) {
        return result;
      }
      if (!("skipped" in result)) {
        await updateMarkerSyncMetadata("account", marker.name, {
          entryVersion: result.syncVersion ?? null,
          updatedAt: result.syncUpdatedAt ?? null,
        });
      }
    }
    return null;
  }

  const activeProvider = getActiveModelProvider();
  if (marker.kind === "provider" && activeProvider === marker.name) {
    const provider = getSavedProviderEntry(marker.name, "cloud");
    const currentAuth = readCurrentAuth();
    if (provider?.profile && currentAuth) {
      const result = await writeCloudProviderWithExpectedVersion({
        ...provider.profile,
        auth: currentAuth,
      }, marker.entryVersion, marker.updatedAt);
      if (!result.success) {
        return result;
      }
      await updateMarkerSyncMetadata("provider", marker.name, {
        entryVersion: result.syncVersion ?? null,
        updatedAt: result.syncUpdatedAt ?? null,
      });
    }
  }
  return null;
}

function getSourceLabel(source: StorageSource): string {
  return source === "cloud" ? "cloud" : "local";
}

export async function saveCurrentAuthAsAccount(
  name: string,
  source: StorageSource,
  options?: { expectedEntryVersion?: number | null; expectedUpdatedAt?: string | null },
): Promise<{ success: boolean; message: string; meta?: AccountMeta; conflict?: CloudSyncConflict }> {
  if (source === "local") {
    return addAccountFromAuth(name);
  }

  requireCloudPassphrase();
  const auth = readCurrentAuth();
  if (!auth) {
    return { success: false, message: "auth.json was not found after login. Failed to add account." };
  }
  if (!hasAccountAuthTokens(auth)) {
    return {
      success: false,
      message: "Current auth.json is not a valid account login result. Complete `codex login` in account mode and try again.",
    };
  }

  const meta = extractMeta(auth);
  const identity = getAccountIdentity(auth);
  const existing = readCloudAccount(name);
  if (existing.status === "ok") {
    const existingIdentity = getAccountIdentity(existing.value);
    if (existingIdentity && identity && existingIdentity !== identity) {
      return {
        success: false,
        message: `Saved cloud account "${name}" belongs to a different account. Overwrite was rejected.`,
        meta,
      };
    }
  } else if (existing.status === "locked" || existing.status === "invalid") {
    return { success: false, message: existing.message, meta };
  }

  if (identity) {
    for (const account of getCloudAccounts()) {
      if (account.name === name || !account.auth) {
        continue;
      }
      if (getAccountIdentity(account.auth) === identity) {
        return {
          success: false,
          message: `A cloud account with email ${meta.email} and plan ${meta.plan} is already saved as "${account.name}". Duplicate add was rejected.`,
          meta,
        };
      }
    }
  }

  markCloudTokenSync(auth);
  const writeResult = await writeCloudAccountWithExpectedVersion(
    name,
    auth,
    options?.expectedEntryVersion,
    options?.expectedUpdatedAt,
  );
  if (!writeResult.success) {
    return { success: false, message: writeResult.message, meta, conflict: writeResult.conflict };
  }
  await updateMarkerSyncMetadata("account", name, {
    entryVersion: writeResult.syncVersion ?? null,
    updatedAt: writeResult.syncUpdatedAt ?? null,
  });
  return { success: true, message: `Account "${name}" was saved to cloud storage`, meta };
}

export async function useSavedAccountEntry(
  account: SavedAccountInfo,
): Promise<{ success: boolean; message: string; meta?: AccountMeta; conflict?: CloudSyncConflict }> {
  const syncResult = await syncCurrentAuthToSavedSelection();
  if (syncResult && !syncResult.success) {
    return { success: false, message: syncResult.message, conflict: syncResult.conflict };
  }

  if (account.source === "local") {
    const result = useAccount(account.name);
    if (result.success) {
      await setMarker({ kind: "account", name: account.name, source: "local" });
    }
    return result;
  }

  if (account.storageState !== "ready" || !account.auth) {
    return { success: false, message: account.storageMessage ?? `Saved cloud account "${account.name}" is unavailable.` };
  }

  writeCurrentAuth(account.auth);
  clearActiveModelProvider();
  await setMarker({
    kind: "account",
    name: account.name,
    source: "cloud",
    entryVersion: account.syncVersion,
    updatedAt: account.syncUpdatedAt,
  });
  return {
    success: true,
    message: `Switched to account "${account.name}"`,
    meta: account.meta ?? extractMeta(account.auth),
  };
}

export async function querySavedAccountQuota(
  account: SavedAccountInfo,
  context?: SavedAccountQuotaQueryContext,
  options: SavedAccountQuotaQueryOptions = {},
): Promise<QuotaQueryResult> {
  const perf = startPerformanceLog(
    LOG_PREFIX,
    "querySavedAccountQuota",
    {
      account: account.name,
      source: account.source,
    },
    {
      mode: "adaptive",
      slowThresholdMs: 3000,
    },
  );
  try {
    const sharedQuery = context?.sharedQueries?.get(account.id);
    if (sharedQuery) {
      try {
        const result = await sharedQuery;
        perf.finish({
          resultKind: result.kind,
          source: "reused",
          reusedInflight: true,
        });
        return result;
      } catch (error) {
        perf.fail(error, {
          source: "reused",
          reusedInflight: true,
        });
        throw error;
      }
    }

    if (account.source === "local") {
      const resultPromise = (async () => {
        const core = await import("@codex-account-switch/core");
        if (options.reason === "timer" && account.auth && isRefreshTokenExpiringWithin(account.auth, TIMER_REFRESH_TOKEN_THRESHOLD_MS)) {
          perf.mark("timer-refresh-token-check", {
            shouldRefresh: true,
            source: account.source,
          });
          const refreshResult = await core.refreshAccount(account.name);
          perf.mark("timer-refresh-token", {
            success: refreshResult.success,
            source: account.source,
          });
          if (!refreshResult.success) {
            throw new Error(refreshResult.message);
          }
        } else if (options.reason === "timer") {
          perf.mark("timer-refresh-token-check", {
            shouldRefresh: false,
            source: account.source,
          });
        }
        perf.mark("delegate-to-core-queryQuota");
        return core.queryQuota(account.name, {
          performanceMode: "adaptive",
          slowThresholdMs: 3000,
        });
      })();
      context?.sharedQueries?.set(account.id, resultPromise);
      const result = await resultPromise;
      perf.finish({
        resultKind: result.kind,
        source: "direct",
      });
      return result;
    }

    const existingQuery = inflightCloudQuotaQueries.get(account.id);
    if (existingQuery) {
      context?.sharedQueries?.set(account.id, existingQuery);
      const result = await existingQuery;
      perf.finish({
        resultKind: result.kind,
        source: "reused",
        reusedInflight: true,
      });
      return result;
    }

    if (account.storageState !== "ready" || !account.auth) {
      const result = {
        kind: "not_found" as const,
        message: account.storageMessage ?? `Saved cloud account "${account.name}" is unavailable.`,
      };
      perf.finish({
        resultKind: result.kind,
      });
      return result;
    }

    const initialAuth = account.auth;
    const queryPromise = (async (): Promise<QuotaQueryResult> => {
      const auth = clone(initialAuth);
      const expectedSyncMetadata: SavedStorageSyncMetadata = {
        entryVersion: account.syncVersion,
        updatedAt: account.syncUpdatedAt,
      };
      const persist = async (mode: "manual" | "automatic"): Promise<void> => {
        const result = await persistCloudAccountAuth(
          account.name,
          auth,
          mode,
          expectedSyncMetadata.entryVersion,
          expectedSyncMetadata.updatedAt,
        );
        if (!result.success) {
          throw new Error(result.message);
        }
        perf.mark("persist-cloud-auth", {
          mode,
          skipped: "skipped" in result,
        });
        const current = getSavedCurrentSelection(context?.snapshot);
        if (current.kind === "account" && current.source === "cloud" && current.name === account.name) {
          writeCurrentAuth(auth);
        }
        if (!("skipped" in result)) {
          expectedSyncMetadata.entryVersion = result.syncVersion ?? null;
          expectedSyncMetadata.updatedAt = result.syncUpdatedAt ?? null;
          await updateMarkerSyncMetadata("account", account.name, {
            entryVersion: result.syncVersion ?? null,
            updatedAt: result.syncUpdatedAt ?? null,
          });
        }
      };

      if (options.reason === "timer") {
        const shouldRefreshToken = isRefreshTokenExpiringWithin(auth, TIMER_REFRESH_TOKEN_THRESHOLD_MS);
        perf.mark("timer-refresh-token-check", {
          shouldRefresh: shouldRefreshToken,
          source: account.source,
        });
        if (shouldRefreshToken) {
          const refreshed = await refreshAccessToken(auth);
          applyRefreshResponse(auth, refreshed);
          await persist("automatic");
          perf.mark("timer-refresh-token", {
            success: true,
            source: account.source,
          });
        }
      }

      const info = await getQuotaInfo(auth, () => persist("automatic"));
      perf.mark("get-quota-info", {
        unavailableReason: info.unavailableReason?.code ?? null,
      });
      return {
        kind: "ok",
        displayName: account.name,
        info,
      };
    })();

    inflightCloudQuotaQueries.set(account.id, queryPromise);
    context?.sharedQueries?.set(account.id, queryPromise);
    queryPromise
      .then((result) => {
        perf.finish({
          resultKind: result.kind,
          source: "direct",
        });
      })
      .catch((error) => {
        perf.fail(error);
      })
      .finally(() => {
        if (inflightCloudQuotaQueries.get(account.id) === queryPromise) {
          inflightCloudQuotaQueries.delete(account.id);
        }
      });

    return queryPromise;
  } catch (error) {
    perf.fail(error);
    throw error;
  }
}

export async function refreshSavedAccountEntry(account: SavedAccountInfo): Promise<{
  success: boolean;
  message: string;
  meta?: AccountMeta;
  lastRefresh?: string;
  unsupported?: boolean;
  conflict?: CloudSyncConflict;
}> {
  if (account.source === "local") {
    return refreshAccount(account.name);
  }

  if (account.storageState !== "ready" || !account.auth) {
    return { success: false, message: account.storageMessage ?? `Saved cloud account "${account.name}" is unavailable.` };
  }

  const auth = clone(account.auth);
  try {
    const refreshed = await refreshAccessToken(auth);
    applyRefreshResponse(auth, refreshed);
    const persistResult = await persistCloudAccountAuth(
      account.name,
      auth,
      "manual",
      account.syncVersion,
      account.syncUpdatedAt,
    );
    if (!persistResult.success) {
      return {
        success: false,
        message: persistResult.message,
        conflict: persistResult.conflict,
      };
    }
    const current = getSavedCurrentSelection();
    if (current.kind === "account" && current.source === "cloud" && current.name === account.name) {
      writeCurrentAuth(auth);
      if (!("skipped" in persistResult)) {
        await updateMarkerSyncMetadata("account", account.name, {
          entryVersion: persistResult.syncVersion ?? null,
          updatedAt: persistResult.syncUpdatedAt ?? null,
        });
      }
    }
    return {
      success: true,
      message: `Token for "${account.name}" was refreshed`,
      meta: extractMeta(auth),
      lastRefresh: auth.last_refresh,
    };
  } catch (error) {
    return {
      success: false,
      message: `Token refresh failed for "${account.name}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function renameSavedAccountEntry(
  account: SavedAccountInfo,
  newName: string,
): Promise<{ success: boolean; message: string; conflict?: CloudSyncConflict }> {
  if (account.source === "local") {
    return renameAccount(account.name, newName);
  }
  const result = await renameCloudAccountEntry(account, newName);
  return result.success
    ? { success: true, message: result.message }
    : { success: false, message: result.message, conflict: result.conflict };
}

async function removeLocalAccountFile(name: string): Promise<void> {
  const authPath = getNamedAuthPath(name);
  if (fs.existsSync(authPath)) {
    fs.unlinkSync(authPath);
  }
}

export async function removeSavedAccountEntry(
  account: SavedAccountInfo,
): Promise<{ success: boolean; message: string; conflict?: CloudSyncConflict }> {
  if (account.source === "local") {
    return removeAccount(account.name);
  }

  const current = getSavedCurrentSelection();
  if (current.kind === "account" && current.source === "cloud" && current.name === account.name) {
    return { success: false, message: `Account "${account.name}" is currently in use and cannot be removed.` };
  }

  const result = await removeCloudAccountEntry(account.name, {
    entryVersion: account.syncVersion,
    updatedAt: account.syncUpdatedAt,
  });
  return result.success
    ? { success: true, message: result.message }
    : { success: false, message: result.message, conflict: result.conflict };
}

export async function moveSavedAccountEntry(
  account: SavedAccountInfo,
  target: StorageSource,
): Promise<{ success: boolean; message: string; conflict?: CloudSyncConflict }> {
  if (account.source === target) {
    return { success: true, message: `Account "${account.name}" is already stored in ${target}.` };
  }
  if (account.storageState !== "ready" || !account.auth) {
    return { success: false, message: account.storageMessage ?? `Saved account "${account.name}" is unavailable.` };
  }

  let nextCloudMetadata: SavedStorageSyncMetadata = EMPTY_SYNC_METADATA;

  if (target === "local") {
    const authPath = getNamedAuthPath(account.name);
    const localSnapshot = readLocalFileSnapshot(authPath);
    writeSavedAuthFile(authPath, account.auth);
    const removeResult = await removeCloudAccountEntry(account.name, {
      entryVersion: account.syncVersion,
      updatedAt: account.syncUpdatedAt,
    });
    if (!removeResult.success) {
      restoreLocalFileSnapshot(authPath, localSnapshot);
      return { success: false, message: removeResult.message, conflict: removeResult.conflict };
    }
  } else {
    requireCloudPassphrase();
    const auth = clone(account.auth);
    markCloudTokenSync(auth);
    const writeResult = await writeCloudAccountWithExpectedVersion(account.name, auth);
    if (!writeResult.success) {
      return { success: false, message: writeResult.message, conflict: writeResult.conflict };
    }
    nextCloudMetadata = {
      entryVersion: writeResult.syncVersion ?? null,
      updatedAt: writeResult.syncUpdatedAt ?? null,
    };
    await removeLocalAccountFile(account.name);
  }

  const current = getSavedCurrentSelection();
  if (current.kind === "account" && current.name === account.name && current.source === account.source) {
    await setMarker({
      kind: "account",
      name: account.name,
      source: target,
      entryVersion: target === "cloud" ? nextCloudMetadata.entryVersion : undefined,
      updatedAt: target === "cloud" ? nextCloudMetadata.updatedAt : undefined,
    });
  }

  return { success: true, message: `Moved account "${account.name}" to ${getSourceLabel(target)} storage.` };
}

export async function saveProviderProfileToSource(
  profile: ProviderProfile,
  source: StorageSource,
  options?: { expectedEntryVersion?: number | null; expectedUpdatedAt?: string | null },
): Promise<CloudMutationResult> {
  if (source === "local") {
    writeProviderProfile(profile);
    return { success: true, message: `Updated provider profile for "${profile.name}" in local storage.` };
  }

  requireCloudPassphrase();
  const result = await writeCloudProviderWithExpectedVersion(profile, options?.expectedEntryVersion, options?.expectedUpdatedAt);
  if (result.success) {
    await updateMarkerSyncMetadata("provider", profile.name, {
      entryVersion: result.syncVersion ?? null,
      updatedAt: result.syncUpdatedAt ?? null,
    });
  }
  return result;
}

export async function buildProviderProfileForSource(
  name: string,
  source: StorageSource,
): Promise<ProviderProfile> {
  if (source === "local") {
    const result = readProviderProfileResult(name);
    if (result.status === "ok") {
      return result.value;
    }
  } else {
    const result = readCloudProvider(name);
    if (result.status === "ok") {
      const profile = parseProviderProfile(name, result.value);
      if (profile) {
        return profile;
      }
    }
  }

  return getDefaultProviderProfile(name);
}

export async function switchToSavedProviderEntry(
  provider: SavedProviderInfo,
): Promise<{ success: boolean; message: string; conflict?: CloudSyncConflict }> {
  const syncResult = await syncCurrentAuthToSavedSelection();
  if (syncResult && !syncResult.success) {
    return { success: false, message: syncResult.message, conflict: syncResult.conflict };
  }

  if (provider.source === "local") {
    const result = switchMode(provider.name);
    if (result.success) {
      await setMarker({ kind: "provider", name: provider.name, source: "local" });
    }
    return result;
  }

  if (!provider.profile || provider.locked || provider.invalid) {
    return { success: false, message: provider.storageMessage ?? `Provider "${provider.name}" is unavailable.` };
  }

  writeCurrentAuth(provider.profile.auth);
  const result = switchMode("account");
  if (!result.success) {
    return result;
  }
  const core = await import("@codex-account-switch/core");
  core.activateProviderConfig(provider.name, provider.profile.config);
  await setMarker({
    kind: "provider",
    name: provider.name,
    source: "cloud",
    entryVersion: provider.syncVersion,
    updatedAt: provider.syncUpdatedAt,
  });
  return { success: true, message: `Switched to mode "${getModeDisplayName(provider.name)}"` };
}

async function removeLocalProviderFile(name: string): Promise<void> {
  const providerPath = getNamedProviderPath(name);
  if (fs.existsSync(providerPath)) {
    fs.unlinkSync(providerPath);
  }
  const core = await import("@codex-account-switch/core");
  core.removeProviderConfig(name);
}

export async function deleteSavedProviderEntry(
  provider: SavedProviderInfo,
): Promise<{ success: boolean; message: string; deactivated?: boolean; conflict?: CloudSyncConflict }> {
  if (provider.source === "local") {
    return deleteProviderProfile(provider.name);
  }

  const current = getSavedCurrentSelection();
  if (current.kind === "provider" && current.source === "cloud" && current.name === provider.name) {
    return { success: false, message: `Provider "${provider.name}" is currently in use and cannot be removed.` };
  }

  const result = await removeCloudProviderEntry(provider.name, {
    entryVersion: provider.syncVersion,
    updatedAt: provider.syncUpdatedAt,
  });
  return result.success
    ? { success: true, message: result.message }
    : { success: false, message: result.message, conflict: result.conflict };
}

export async function moveSavedProviderEntry(
  provider: SavedProviderInfo,
  target: StorageSource,
): Promise<{ success: boolean; message: string; conflict?: CloudSyncConflict }> {
  if (provider.source === target) {
    return { success: true, message: `Provider "${provider.name}" is already stored in ${target}.` };
  }
  if (!provider.profile || provider.locked || provider.invalid) {
    return { success: false, message: provider.storageMessage ?? `Provider "${provider.name}" is unavailable.` };
  }

  let nextCloudMetadata: SavedStorageSyncMetadata = EMPTY_SYNC_METADATA;

  if (target === "cloud") {
    const writeResult = await writeCloudProviderWithExpectedVersion(provider.profile);
    if (!writeResult.success) {
      return { success: false, message: writeResult.message, conflict: writeResult.conflict };
    }
    nextCloudMetadata = {
      entryVersion: writeResult.syncVersion ?? null,
      updatedAt: writeResult.syncUpdatedAt ?? null,
    };
  } else {
    const providerPath = getNamedProviderPath(provider.name);
    const localSnapshot = readLocalFileSnapshot(providerPath);
    writeProviderProfile(provider.profile);
    if (provider.source === "local") {
      await removeLocalProviderFile(provider.name);
    } else {
      const removeResult = await removeCloudProviderEntry(provider.name, {
        entryVersion: provider.syncVersion,
        updatedAt: provider.syncUpdatedAt,
      });
      if (!removeResult.success) {
        restoreLocalFileSnapshot(providerPath, localSnapshot);
        return { success: false, message: removeResult.message, conflict: removeResult.conflict };
      }
    }
  }
  if (target === "cloud") {
    if (provider.source === "local") {
      await removeLocalProviderFile(provider.name);
    } else {
      const removeResult = await removeCloudProviderEntry(provider.name, {
        entryVersion: provider.syncVersion,
        updatedAt: provider.syncUpdatedAt,
      });
      if (!removeResult.success) {
        await removeLocalProviderFile(provider.name);
        return { success: false, message: removeResult.message, conflict: removeResult.conflict };
      }
    }
  }

  const current = getSavedCurrentSelection();
  if (current.kind === "provider" && current.name === provider.name && current.source === provider.source) {
    await setMarker({
      kind: "provider",
      name: provider.name,
      source: target,
      entryVersion: target === "cloud" ? nextCloudMetadata.entryVersion : undefined,
      updatedAt: target === "cloud" ? nextCloudMetadata.updatedAt : undefined,
    });
  }

  return { success: true, message: `Moved provider "${provider.name}" to ${getSourceLabel(target)} storage.` };
}
