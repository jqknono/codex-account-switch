import * as fs from "fs";
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
  getSavedAuthPassphrase,
  hasAccountAuthTokens,
  isSerializedSavedValueEncrypted,
  listNamedAuthFiles,
  listProviderModes,
  queryQuota,
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
  withAccountLock,
  writeCurrentAuth,
  writeProviderProfile,
  writeSavedAuthFile,
} from "@codex-account-switch/core";
import { logInfo, logWarn, startPerformanceLog } from "./log";
import { queryQuotaWithCache } from "./quotaCache";

export type StorageSource = "local" | "cloud";
export type SaveTarget = StorageSource;
const LOG_PREFIX = "[codex-account-switch:vscode:savedEntries]";
const SYNCED_CLOUD_STATE_KEY = "codex-account-switch.syncedCloudState.v1";
const SYNCED_CLOUD_ACCOUNT_KEY_PREFIX = "codex-account-switch.syncedCloudAccount.v1.";
const SYNCED_CLOUD_PROVIDER_KEY_PREFIX = "codex-account-switch.syncedCloudProvider.v1.";
const SYNCED_CLOUD_MIGRATION_KEY = "codex-account-switch.syncedCloudStateMigration.v1";

export interface SavedAccountInfo {
  id: string;
  name: string;
  source: StorageSource;
  meta: AccountMeta | null;
  publicEmail: string | null;
  auth: AuthFile | null;
  isCurrent: boolean;
  storageState: "ready" | "locked" | "invalid";
  storageMessage?: string;
  encrypted: boolean;
  syncVersion: number | null;
  syncUpdatedAt: string | null;
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
  lastWriterAction: string | null;
}

export interface CloudSyncConflict {
  entryType: "account" | "provider";
  name: string;
  expectedEntryVersion: number | null;
  expectedUpdatedAt: string | null;
  currentEntryVersion: number | null;
  currentUpdatedAt: string | null;
  currentLastWriterAction: string | null;
}

interface SavedStorageSyncMetadata {
  entryVersion: number | null;
  updatedAt: string | null;
  lastWriterAction?: string | null;
}

type ProviderAuditAction = "save_provider_profile" | "sync_current_provider_auth" | "move_provider_to_cloud";

interface CloudMutationResult {
  success: boolean;
  message: string;
  conflict?: CloudSyncConflict;
  syncVersion?: number | null;
  syncUpdatedAt?: string | null;
}

export interface HealedCloudMarker {
  kind: "account" | "provider";
  name: string;
  source: "cloud";
  previousEntryVersion: number | null;
  previousUpdatedAt: string | null;
  currentEntryVersion: number | null;
  currentUpdatedAt: string | null;
}

interface SyncCurrentSelectionResult {
  success: boolean;
  message?: string;
  conflict?: CloudSyncConflict;
  healedMarker?: HealedCloudMarker;
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

interface RefreshSavedAccountOptions {
  shouldRefreshLatest?: (account: SavedAccountInfo) => boolean;
}

interface SavedAccountQuotaQueryOptions {
  reason?: string;
  forceFetch?: boolean;
  allowCachedFallback?: boolean;
}

interface SyncedStorageData {
  version: 1;
  accounts: Record<string, unknown>;
  accountNames: string[];
  providers: Record<string, unknown>;
  providerNames: string[];
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
const CURRENT_SELECTION_KEY = "codex-account-switch.currentSavedSelection";
const DEFAULT_QUOTA_CACHE_INTERVAL_MS = 30 * 1000;
const inflightCloudQuotaQueries = new Map<string, Promise<QuotaQueryResult>>();
const EMPTY_SYNC_METADATA: SavedStorageSyncMetadata = {
  entryVersion: null,
  updatedAt: null,
  lastWriterAction: null,
};

let extensionContext: vscode.ExtensionContext | null = null;

function getConfiguration() {
  return vscode.workspace.getConfiguration("codex-account-switch");
}

function getQuotaCacheIntervalMs(): number {
  const intervalSec = getConfiguration().get<number>("quotaRefreshInterval", 30);
  if (!Number.isFinite(intervalSec)) {
    return DEFAULT_QUOTA_CACHE_INTERVAL_MS;
  }
  return Math.max(intervalSec, 5) * 1000;
}

function shouldForceQuotaFetch(reason?: string): boolean {
  return reason === "manual" || reason === "auto-switch";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getPublicEmail(value: unknown): string | null {
  if (!isRecord(value) || typeof value.email !== "string") {
    return null;
  }
  const email = value.email.trim();
  return email.length > 0 ? email : null;
}

function withPublicEmail(value: Record<string, unknown>, email: string | null): Record<string, unknown> {
  const next = clone(value);
  if (email) {
    next.email = email;
  } else {
    delete next.email;
  }
  return next;
}

function normalizeSyncedStorage(raw: unknown): SyncedStorageData {
  if (!isRecord(raw) || raw.version !== 1) {
    return getDefaultSyncedStorage();
  }

  const accounts = isRecord(raw.accounts) ? clone(raw.accounts) : {};
  const accountNames = normalizeNames([
    ...Object.keys(accounts),
    ...(Array.isArray(raw.accountNames) ? raw.accountNames : []),
  ]);
  const providers = isRecord(raw.providers) ? clone(raw.providers) : {};
  const providerNames = normalizeNames([
    ...Object.keys(providers),
    ...(Array.isArray(raw.providerNames) ? raw.providerNames : []),
  ]);
  return {
    version: 1,
    accounts,
    accountNames,
    providers,
    providerNames,
  };
}

function getSyncMetadata(value: unknown): SavedStorageSyncMetadata {
  if (!isRecord(value)) {
    return {
      entryVersion: null,
      updatedAt: null,
      lastWriterAction: null,
    };
  }

  return {
    entryVersion:
      Number.isInteger(value.entryVersion) && (value.entryVersion as number) >= 1
        ? (value.entryVersion as number)
        : null,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt.length > 0 ? value.updatedAt : null,
    lastWriterAction:
      typeof value.lastWriterAction === "string" && value.lastWriterAction.trim().length > 0
        ? value.lastWriterAction.trim()
        : null,
  };
}

function nextSyncMetadata(
  current: SavedStorageSyncMetadata,
  options: { lastWriterAction?: string | null } = {},
): SavedStorageSyncMetadata {
  return {
    entryVersion: current.entryVersion == null ? 1 : current.entryVersion + 1,
    updatedAt: new Date().toISOString(),
    lastWriterAction: options.lastWriterAction ?? null,
  };
}

function normalizeNames(value: unknown): string[] {
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

function applySyncMetadata(value: Record<string, unknown>, metadata: SavedStorageSyncMetadata): Record<string, unknown> {
  value.entryVersion = metadata.entryVersion;
  value.updatedAt = metadata.updatedAt;
  value.lastWriterAction = metadata.lastWriterAction;
  return value;
}

function hasSyncConflict(expectedEntryVersion: number | null | undefined, current: SavedStorageSyncMetadata): boolean {
  return expectedEntryVersion != null && current.entryVersion !== expectedEntryVersion;
}

function shouldPreferCandidatePayload(current: unknown, candidate: unknown): boolean {
  if (candidate === undefined) {
    return false;
  }
  if (current === undefined) {
    return true;
  }
  const currentVersion = getSyncMetadata(current).entryVersion;
  const candidateVersion = getSyncMetadata(candidate).entryVersion;
  if (candidateVersion == null) {
    return currentVersion == null;
  }
  return currentVersion == null || candidateVersion >= currentVersion;
}

function mergeSyncedPayload(target: Record<string, unknown>, name: string, candidate: unknown): void {
  if (shouldPreferCandidatePayload(target[name], candidate)) {
    target[name] = clone(candidate);
  }
}

function getExpectedSyncMetadata(
  expectedEntryVersion?: number | null,
  expectedUpdatedAt?: string | null,
): SavedStorageSyncMetadata {
  return {
    entryVersion: expectedEntryVersion ?? null,
    updatedAt: expectedUpdatedAt ?? null,
    lastWriterAction: null,
  };
}

function shouldUseExpectedSnapshotAsCurrent(
  expected: SavedStorageSyncMetadata,
  current: SavedStorageSyncMetadata,
): boolean {
  return (
    expected.entryVersion != null
    && (current.entryVersion == null || expected.entryVersion > current.entryVersion)
  );
}

function formatMissingSyncedPayloadResult(
  entryType: "account" | "provider",
  name: string,
  expected: SavedStorageSyncMetadata,
): CloudMutationResult {
  const label = entryType === "account" ? "Cloud account" : "Cloud provider";
  const expectedVersion = expected.entryVersion ?? "unknown";
  const expectedUpdatedAt = expected.updatedAt ?? "unknown";
  return {
    success: false,
    message:
      `${label} "${name}" no longer has a synced payload. `
      + `The stale local snapshot expected version ${expectedVersion} (${expectedUpdatedAt}). `
      + "Refresh the list before retrying.",
  };
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
    currentLastWriterAction: current.lastWriterAction ?? null,
  };
}

function formatConflictResult(conflict: CloudSyncConflict): CloudMutationResult {
  const label = conflict.entryType === "account" ? "Cloud account" : "Cloud provider";
  const expectedVersion = conflict.expectedEntryVersion ?? "unknown";
  const currentVersion = conflict.currentEntryVersion ?? "unknown";
  const expectedUpdatedAt = conflict.expectedUpdatedAt ?? "unknown";
  const currentUpdatedAt = conflict.currentUpdatedAt ?? "unknown";
  const currentWriterAction = conflict.currentLastWriterAction ?? "unknown";
  return {
    success: false,
    message:
      `${label} "${conflict.name}" has a sync conflict: `
      + `expected version ${expectedVersion} (${expectedUpdatedAt}), `
      + `current version ${currentVersion} (${currentUpdatedAt}). `
      + `Last writer action ${currentWriterAction}. `
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

async function setCurrentAccountMarker(account: Pick<SavedAccountInfo, "name" | "source" | "syncVersion" | "syncUpdatedAt">): Promise<void> {
  await setMarker({
    kind: "account",
    name: account.name,
    source: account.source,
    entryVersion: account.source === "cloud" ? account.syncVersion : undefined,
    updatedAt: account.source === "cloud" ? account.syncUpdatedAt : undefined,
  });
}

async function setMarkerToCurrentAuthAccount(): Promise<void> {
  const selection = getSavedCurrentSelection();
  if (selection.kind !== "account") {
    await setMarker(null);
    return;
  }

  const account = getSavedAccountEntry(selection.name, selection.source);
  await setMarker({
    kind: "account",
    name: selection.name,
    source: selection.source,
    entryVersion: selection.source === "cloud" ? account?.syncVersion : undefined,
    updatedAt: selection.source === "cloud" ? account?.syncUpdatedAt : undefined,
  });
}

async function reconcileCurrentCloudMarker(): Promise<HealedCloudMarker | null> {
  const marker = getMarker();
  if (!marker || marker.source !== "cloud") {
    return null;
  }

  const currentValue =
    marker.kind === "account"
      ? readSyncedStorage().accounts[marker.name]
      : readSyncedStorage().providers[marker.name];
  const currentMetadata = getSyncMetadata(currentValue);
  if (currentMetadata.entryVersion == null) {
    return null;
  }

  const markerEntryVersion = marker.entryVersion ?? null;
  const markerUpdatedAt = marker.updatedAt ?? null;
  const sameVersion = markerEntryVersion === currentMetadata.entryVersion;
  const sameUpdatedAt = markerUpdatedAt === currentMetadata.updatedAt;
  if (sameVersion && sameUpdatedAt) {
    return null;
  }

  await setMarker({
    ...marker,
    entryVersion: currentMetadata.entryVersion,
    updatedAt: currentMetadata.updatedAt,
  });
  logInfo(LOG_PREFIX, "reconcile-current-cloud-marker", {
    kind: marker.kind,
    name: marker.name,
    source: marker.source,
    previousEntryVersion: markerEntryVersion,
    currentEntryVersion: currentMetadata.entryVersion,
    previousUpdatedAt: markerUpdatedAt,
    currentUpdatedAt: currentMetadata.updatedAt,
  });
  return {
    kind: marker.kind,
    name: marker.name,
    source: "cloud",
    previousEntryVersion: markerEntryVersion,
    previousUpdatedAt: markerUpdatedAt,
    currentEntryVersion: currentMetadata.entryVersion,
    currentUpdatedAt: currentMetadata.updatedAt,
  };
}

function getDefaultSyncedStorage(): SyncedStorageData {
  return {
    version: 1,
    accounts: {},
    accountNames: [],
    providers: {},
    providerNames: [],
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
  const storage = normalizeSyncedStorage(raw);
  const accounts: Record<string, unknown> = {};
  const providers: Record<string, unknown> = {};
  const legacy = readLegacySyncedStorage();
  const accountNames = normalizeNames([
    ...storage.accountNames,
    ...Object.keys(storage.accounts),
  ]);
  const providerNames = normalizeNames([
    ...storage.providerNames,
    ...Object.keys(storage.providers),
  ]);

  for (const name of accountNames) {
    mergeSyncedPayload(accounts, name, legacy.accounts[name]);
    mergeSyncedPayload(accounts, name, storage.accounts[name]);
    mergeSyncedPayload(accounts, name, requireContext().globalState.get<unknown>(getSyncedCloudAccountKey(name)));
  }

  for (const name of providerNames) {
    mergeSyncedPayload(providers, name, legacy.providers[name]);
    mergeSyncedPayload(providers, name, storage.providers[name]);
    mergeSyncedPayload(providers, name, requireContext().globalState.get<unknown>(getSyncedCloudProviderKey(name)));
  }

  return {
    ...storage,
    accounts,
    accountNames: Object.keys(accounts).sort(),
    providers,
    providerNames: Object.keys(providers).sort(),
  };
}

async function writeSyncedStorage(data: SyncedStorageData): Promise<void> {
  await writeSyncedCloudStateIndex(data);
}

function getSyncedCloudAccountKey(name: string): string {
  return `${SYNCED_CLOUD_ACCOUNT_KEY_PREFIX}${encodeURIComponent(name)}`;
}

function getSyncedCloudProviderKey(name: string): string {
  return `${SYNCED_CLOUD_PROVIDER_KEY_PREFIX}${encodeURIComponent(name)}`;
}

function getSyncedCloudSyncKeys(accountNames: string[], providerNames: string[]): string[] {
  return [
    SYNCED_CLOUD_STATE_KEY,
    ...normalizeNames(accountNames).sort().map(getSyncedCloudAccountKey),
    ...normalizeNames(providerNames).sort().map(getSyncedCloudProviderKey),
  ];
}

function setSyncedCloudSyncKeys(accountNames: string[], providerNames: string[]): void {
  requireContext().globalState.setKeysForSync(getSyncedCloudSyncKeys(accountNames, providerNames));
}

function toSyncedCloudStateIndex(data: SyncedStorageData): SyncedStorageData {
  const accountNames = Object.keys(data.accounts).sort();
  const providerNames = Object.keys(data.providers).sort();
  return {
    version: 1,
    accounts: {},
    accountNames,
    providers: {},
    providerNames,
  };
}

async function materializeSyncedCloudEntries(data: SyncedStorageData): Promise<void> {
  for (const [name, account] of Object.entries(data.accounts)) {
    if (account === undefined) {
      continue;
    }
    const key = getSyncedCloudAccountKey(name);
    const current = requireContext().globalState.get<unknown>(key);
    if (!shouldPreferCandidatePayload(current, account)) {
      continue;
    }
    await requireContext().globalState.update(key, clone(account));
  }
  for (const [name, provider] of Object.entries(data.providers)) {
    if (provider === undefined) {
      continue;
    }
    const key = getSyncedCloudProviderKey(name);
    const current = requireContext().globalState.get<unknown>(key);
    if (!shouldPreferCandidatePayload(current, provider)) {
      continue;
    }
    await requireContext().globalState.update(key, clone(provider));
  }
}

async function writeSyncedCloudStateIndex(data: SyncedStorageData): Promise<void> {
  const index = toSyncedCloudStateIndex(data);
  await requireContext().globalState.update(SYNCED_CLOUD_STATE_KEY, index);
  setSyncedCloudSyncKeys(index.accountNames, index.providerNames);
}

async function writeFullSyncedStorage(data: SyncedStorageData): Promise<void> {
  for (const [name, account] of Object.entries(data.accounts)) {
    await requireContext().globalState.update(getSyncedCloudAccountKey(name), clone(account));
  }
  for (const [name, provider] of Object.entries(data.providers)) {
    await requireContext().globalState.update(getSyncedCloudProviderKey(name), clone(provider));
  }
  await writeSyncedCloudStateIndex(data);
}

async function writeSyncedCloudAccount(name: string, value: Record<string, unknown>): Promise<void> {
  const storage = readSyncedStorage();
  storage.accounts[name] = clone(value);
  await requireContext().globalState.update(getSyncedCloudAccountKey(name), clone(value));
  await writeSyncedCloudStateIndex(storage);
}

async function writeSyncedCloudProvider(name: string, value: Record<string, unknown>): Promise<void> {
  const storage = readSyncedStorage();
  storage.providers[name] = clone(value);
  await requireContext().globalState.update(getSyncedCloudProviderKey(name), clone(value));
  await writeSyncedCloudStateIndex(storage);
}

async function removeSyncedCloudAccount(name: string): Promise<void> {
  const storage = readSyncedStorage();
  delete storage.accounts[name];
  await requireContext().globalState.update(getSyncedCloudAccountKey(name), undefined);
  await writeSyncedCloudStateIndex(storage);
}

async function removeSyncedCloudProvider(name: string): Promise<void> {
  const storage = readSyncedStorage();
  delete storage.providers[name];
  await requireContext().globalState.update(getSyncedCloudProviderKey(name), undefined);
  await writeSyncedCloudStateIndex(storage);
}

async function renameSyncedCloudAccount(oldName: string, newName: string, value: Record<string, unknown>): Promise<void> {
  const storage = readSyncedStorage();
  delete storage.accounts[oldName];
  storage.accounts[newName] = clone(value);
  await requireContext().globalState.update(getSyncedCloudAccountKey(oldName), undefined);
  await requireContext().globalState.update(getSyncedCloudAccountKey(newName), clone(value));
  await writeSyncedCloudStateIndex(storage);
}

async function clearLegacySyncedStorage(): Promise<void> {
  await getConfiguration().update(SYNCED_STORAGE_SETTING, undefined, vscode.ConfigurationTarget.Global);
}

export async function initializeSavedEntries(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  const currentStorage = readSyncedStorage();
  setSyncedCloudSyncKeys(currentStorage.accountNames, currentStorage.providerNames);

  const existingGlobalState = context.globalState.get<unknown>(SYNCED_CLOUD_STATE_KEY);
  if (existingGlobalState !== undefined) {
    await materializeSyncedCloudEntries(currentStorage);
    await writeSyncedCloudStateIndex(currentStorage);
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
  if (!hasSyncedCloudState(legacy)) {
    await setSyncedCloudMigrationState({
      completedAt: new Date().toISOString(),
      migratedFromLegacy: false,
      legacyCleanupSucceeded: true,
    });
    return;
  }

  await writeFullSyncedStorage(legacy);

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

function getCurrentWriterMetadata(action?: ProviderAuditAction): {
  lastWriterAction: string | null;
} {
  return {
    lastWriterAction: action ?? null,
  };
}

function hasSyncedCloudState(storage: SyncedStorageData): boolean {
  return (
    Object.keys(storage.accounts).length > 0
    || Object.keys(storage.providers).length > 0
    || storage.accountNames.length > 0
    || storage.providerNames.length > 0
  );
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

async function updateCloudAccountPublicEmail(name: string, raw: unknown, email: string): Promise<void> {
  if (!isRecord(raw) || getPublicEmail(raw)) {
    return;
  }
  await requireContext().globalState.update(getSyncedCloudAccountKey(name), withPublicEmail(raw, email));
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
        publicEmail: null,
        auth: result.value,
        isCurrent: false,
        storageState: "ready" as const,
        storageMessage: undefined,
        encrypted: result.encrypted,
        syncVersion: null,
        syncUpdatedAt: null,
      };
    }

    return {
      id: toId("local", name),
      name,
      source: "local" as const,
      meta: null,
      publicEmail: null,
      auth: null,
      isCurrent: false,
      storageState: result.status === "locked" ? "locked" as const : "invalid" as const,
      storageMessage: "message" in result ? result.message : undefined,
      encrypted: result.encrypted,
      syncVersion: null,
      syncUpdatedAt: null,
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
  const accounts = Object.keys(storage.accounts).sort().map((name) => {
    const raw = storage.accounts[name];
    const syncMetadata = getSyncMetadata(raw);
    const publicEmail = getPublicEmail(raw);
    const result = readCloudAccount(name);
    if (result.status === "ok") {
      const meta = extractMeta(result.value);
      if (!publicEmail && meta.email) {
        void updateCloudAccountPublicEmail(name, raw, meta.email).catch((error) => {
          logWarn(LOG_PREFIX, "cloud-account-public-email-backfill-failed", {
            account: name,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return {
        id: toId("cloud", name),
        name,
        source: "cloud" as const,
        meta,
        publicEmail: publicEmail ?? meta.email,
        auth: result.value,
        isCurrent: false,
        storageState: "ready" as const,
        encrypted: result.encrypted,
        syncVersion: syncMetadata.entryVersion,
        syncUpdatedAt: syncMetadata.updatedAt,
      };
    }

    return {
      id: toId("cloud", name),
      name,
      source: "cloud" as const,
      meta: null,
      publicEmail,
      auth: null,
      isCurrent: false,
      storageState: result.status === "locked" ? "locked" as const : "invalid" as const,
      storageMessage: "message" in result ? result.message : undefined,
      encrypted: result.encrypted,
      syncVersion: syncMetadata.entryVersion,
      syncUpdatedAt: syncMetadata.updatedAt,
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
      lastWriterAction: null,
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
      lastWriterAction: syncMetadata.lastWriterAction ?? null,
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

async function persistCloudAccountAuth(
  name: string,
  auth: AuthFile,
  expectedEntryVersion?: number | null,
  expectedUpdatedAt?: string | null,
): Promise<CloudMutationResult> {
  return writeCloudAccountWithExpectedVersion(name, auth, expectedEntryVersion, expectedUpdatedAt);
}

function persistLocalAccountAuth(
  name: string,
  auth: AuthFile,
  options: { shouldSyncCurrentAuth?: boolean } = {},
): { success: true } {
  writeSavedAuthFile(getNamedAuthPath(name), auth);
  if (options.shouldSyncCurrentAuth) {
    writeCurrentAuth(auth);
  }
  return { success: true };
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
  const storage = readSyncedStorage();
  const currentMetadata = getSyncMetadata(storage.accounts[name]);
  const expectedMetadata = getExpectedSyncMetadata(expectedEntryVersion, expectedUpdatedAt);
  const effectiveCurrentMetadata = shouldUseExpectedSnapshotAsCurrent(expectedMetadata, currentMetadata)
    ? expectedMetadata
    : currentMetadata;
  if (hasSyncConflict(expectedEntryVersion, currentMetadata) && effectiveCurrentMetadata !== expectedMetadata) {
    return formatConflictResult(
      buildConflict(
        "account",
        name,
        expectedMetadata,
        currentMetadata,
      ),
    );
  }
  const nextMetadata = nextSyncMetadata(effectiveCurrentMetadata);
  const serialized = serializeSavedValue("saved_auth", auth as Record<string, unknown>, {
    requireEncryption: true,
  });
  const nextAccount = applySyncMetadata(withPublicEmail(serialized, extractMeta(auth).email), nextMetadata);
  await writeSyncedCloudAccount(name, nextAccount);
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
  auditAction?: ProviderAuditAction,
): Promise<CloudMutationResult> {
  requireCloudPassphrase();
  const storage = readSyncedStorage();
  const currentMetadata = getSyncMetadata(storage.providers[profile.name]);
  const expectedMetadata = getExpectedSyncMetadata(expectedEntryVersion, expectedUpdatedAt);
  const effectiveCurrentMetadata = shouldUseExpectedSnapshotAsCurrent(expectedMetadata, currentMetadata)
    ? expectedMetadata
    : currentMetadata;
  if (hasSyncConflict(expectedEntryVersion, currentMetadata) && effectiveCurrentMetadata !== expectedMetadata) {
    return formatConflictResult(
      buildConflict(
        "provider",
        profile.name,
        expectedMetadata,
        currentMetadata,
      ),
    );
  }
  const nextMetadata = nextSyncMetadata(effectiveCurrentMetadata, getCurrentWriterMetadata(auditAction));
  const nextProvider = applySyncMetadata(serializeSavedValue("saved_provider", profile as unknown as Record<string, unknown>, {
    requireEncryption: true,
  }), nextMetadata);
  await writeSyncedCloudProvider(profile.name, nextProvider);
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
  const nextAccount = isRecord(currentRaw)
    ? applySyncMetadata(clone(currentRaw), nextMetadata)
    : applySyncMetadata(
        withPublicEmail(
          serializeSavedValue("saved_auth", (account.auth ?? {}) as Record<string, unknown>, {
            requireEncryption: true,
          }),
          account.meta?.email ?? account.publicEmail,
        ),
        nextMetadata,
      );
  await renameSyncedCloudAccount(account.name, newName, nextAccount);

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
    if (expected.entryVersion != null) {
      return formatMissingSyncedPayloadResult("account", name, expected);
    }
    return { success: false, message: `Account "${name}" does not exist.` };
  }
  const currentMetadata = getSyncMetadata(storage.accounts[name]);
  if (hasSyncConflict(expected.entryVersion, currentMetadata)) {
    return formatConflictResult(buildConflict("account", name, expected, currentMetadata));
  }
  await removeSyncedCloudAccount(name);
  return { success: true, message: `Account "${name}" was removed` };
}

async function removeCloudProviderEntry(
  name: string,
  expected: SavedStorageSyncMetadata = EMPTY_SYNC_METADATA,
): Promise<CloudMutationResult> {
  const storage = readSyncedStorage();
  if (!(name in storage.providers)) {
    if (expected.entryVersion != null) {
      return formatMissingSyncedPayloadResult("provider", name, expected);
    }
    return { success: false, message: `Provider "${name}" does not exist.` };
  }
  const currentMetadata = getSyncMetadata(storage.providers[name]);
  if (hasSyncConflict(expected.entryVersion, currentMetadata)) {
    return formatConflictResult(buildConflict("provider", name, expected, currentMetadata));
  }
  await removeSyncedCloudProvider(name);
  return { success: true, message: `Removed provider "${name}"` };
}

export async function syncCurrentAuthToSavedSelection(): Promise<SyncCurrentSelectionResult> {
  const healedMarker = await reconcileCurrentCloudMarker();
  const marker = getMarker();
  if (!marker || marker.source === "local") {
    syncCurrentAuthToSavedAccount();
    return healedMarker ? { success: true, healedMarker } : { success: true };
  }

  if (marker.kind === "account") {
    const auth = readCurrentAuth();
    if (auth && hasAccountAuthTokens(auth)) {
      const markerAccount = getSavedAccountEntry(marker.name, "cloud");
      const currentIdentity = getAccountIdentity(auth);
      const markerIdentity = markerAccount?.auth ? getAccountIdentity(markerAccount.auth) : null;
      if (currentIdentity && markerIdentity && currentIdentity !== markerIdentity) {
        logWarn(LOG_PREFIX, "skip-cloud-account-sync-identity-mismatch", {
          markerAccount: marker.name,
          markerEmail: markerAccount?.meta?.email ?? null,
          currentEmail: extractMeta(auth).email ?? null,
        });
        await setMarkerToCurrentAuthAccount();
        return healedMarker ? { success: true, healedMarker } : { success: true };
      }
      const result = await persistCloudAccountAuth(
        marker.name,
        auth,
        marker.entryVersion,
        marker.updatedAt,
      );
      if (!result.success) {
        return {
          success: false,
          message: result.message,
          conflict: result.conflict,
          healedMarker: healedMarker ?? undefined,
        };
      }
      await updateMarkerSyncMetadata("account", marker.name, {
        entryVersion: result.syncVersion ?? null,
        updatedAt: result.syncUpdatedAt ?? null,
      });
    }
    return healedMarker ? { success: true, healedMarker } : { success: true };
  }

  const activeProvider = getActiveModelProvider();
  if (marker.kind === "provider" && activeProvider === marker.name) {
    const provider = getSavedProviderEntry(marker.name, "cloud");
    const currentAuth = readCurrentAuth();
    if (provider?.profile && currentAuth) {
      const result = await writeCloudProviderWithExpectedVersion({
        ...provider.profile,
        auth: currentAuth,
      }, marker.entryVersion, marker.updatedAt, "sync_current_provider_auth");
      if (!result.success) {
        return {
          success: false,
          message: result.message,
          conflict: result.conflict,
          healedMarker: healedMarker ?? undefined,
        };
      }
      await updateMarkerSyncMetadata("provider", marker.name, {
        entryVersion: result.syncVersion ?? null,
        updatedAt: result.syncUpdatedAt ?? null,
      });
    }
  }
  return healedMarker ? { success: true, healedMarker } : { success: true };
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
    const result = addAccountFromAuth(name);
    if (result.success) {
      await setCurrentAccountMarker({
        name,
        source: "local",
        syncVersion: null,
        syncUpdatedAt: null,
      });
    }
    return result;
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

  const writeResult = await writeCloudAccountWithExpectedVersion(
    name,
    auth,
    options?.expectedEntryVersion,
    options?.expectedUpdatedAt,
  );
  if (!writeResult.success) {
    return { success: false, message: writeResult.message, meta, conflict: writeResult.conflict };
  }
  await setCurrentAccountMarker({
    name,
    source: "cloud",
    syncVersion: writeResult.syncVersion ?? null,
    syncUpdatedAt: writeResult.syncUpdatedAt ?? null,
  });
  return { success: true, message: `Account "${name}" was saved to cloud storage`, meta };
}

export async function useSavedAccountEntry(
  account: SavedAccountInfo,
): Promise<{ success: boolean; message: string; meta?: AccountMeta; conflict?: CloudSyncConflict; healedMarker?: HealedCloudMarker }> {
  const syncResult = await syncCurrentAuthToSavedSelection();
  if (!syncResult.success) {
    return {
      success: false,
      message: syncResult.message ?? "Failed to sync the current selection before switching accounts.",
      conflict: syncResult.conflict,
      healedMarker: syncResult.healedMarker,
    };
  }

  if (account.source === "local") {
    const result = useAccount(account.name);
    if (result.success) {
      await setMarker({ kind: "account", name: account.name, source: "local" });
    }
    return result.success && syncResult.healedMarker
      ? { ...result, healedMarker: syncResult.healedMarker }
      : result;
  }

  if (account.storageState !== "ready" || !account.auth) {
    return {
      success: false,
      message: account.storageMessage ?? `Saved cloud account "${account.name}" is unavailable.`,
      healedMarker: syncResult.healedMarker,
    };
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
    healedMarker: syncResult.healedMarker,
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
        perf.mark("await-shared-query", {
          source: "shared",
        });
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
      const resultPromise = queryQuotaWithCache(account, {
        minIntervalMs: getQuotaCacheIntervalMs(),
        forceFetch: options.forceFetch ?? shouldForceQuotaFetch(options.reason),
        allowCachedFallback: options.allowCachedFallback,
        fetch: async () => queryQuota(account.name, {
          performanceMode: "adaptive",
          slowThresholdMs: 3000,
          syncCurrentAuthBeforeRead: false,
        }),
      });
      context?.sharedQueries?.set(account.id, resultPromise);
      perf.mark("await-local-quota-query", {
        forceFetch: shouldForceQuotaFetch(options.reason),
      });
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
      perf.mark("await-inflight-cloud-query", {
        source: "cloud",
      });
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
      perf.mark("cloud-account-unavailable", {
        resultKind: result.kind,
      });
      perf.finish({
        resultKind: result.kind,
      });
      return result;
    }

    const initialAuth = account.auth;
    const queryPromise = queryQuotaWithCache(account, {
      minIntervalMs: getQuotaCacheIntervalMs(),
      forceFetch: options.forceFetch ?? shouldForceQuotaFetch(options.reason),
      allowCachedFallback: options.allowCachedFallback,
      fetch: async (): Promise<QuotaQueryResult> => {
        const auth = clone(initialAuth);
        const info = await getQuotaInfo(auth, {
          performanceMode: "adaptive",
          slowThresholdMs: 3000,
        });
        perf.mark("get-quota-info", {
          unavailableReason: info.unavailableReason?.code ?? null,
        });
        return {
          kind: "ok",
          displayName: account.name,
          info,
        };
      },
    });

    inflightCloudQuotaQueries.set(account.id, queryPromise);
    context?.sharedQueries?.set(account.id, queryPromise);
    perf.mark("await-cloud-quota-query", {
      source: "cloud",
      forceFetch: shouldForceQuotaFetch(options.reason),
    });
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

export async function refreshSavedAccountEntry(account: SavedAccountInfo, options: RefreshSavedAccountOptions = {}): Promise<{
  success: boolean;
  message: string;
  meta?: AccountMeta;
  lastRefresh?: string;
  unsupported?: boolean;
  conflict?: CloudSyncConflict;
  skipped?: boolean;
}> {
  if (account.source === "local") {
    return refreshAccount(account.name, {
      persistUpdatedAuth: ({ auth, shouldSyncCurrentAuth }) => {
        persistLocalAccountAuth(account.name, auth, {
          shouldSyncCurrentAuth,
        });
      },
    });
  }

  if (account.storageState !== "ready" || !account.auth) {
    return { success: false, message: account.storageMessage ?? `Saved cloud account "${account.name}" is unavailable.` };
  }

  return withAccountLock(account.auth, "refreshCloudAccount", async () => {
    const latestAccount = getSavedAccountEntry(account.name, "cloud");
    const accountToRefresh = latestAccount ?? account;
    if (accountToRefresh.storageState !== "ready" || !accountToRefresh.auth) {
      return {
        success: false,
        message: accountToRefresh.storageMessage ?? `Saved cloud account "${account.name}" is unavailable.`,
      };
    }
    const latestAuth = accountToRefresh.auth;
    if (options.shouldRefreshLatest && !options.shouldRefreshLatest(accountToRefresh)) {
      return {
        success: true,
        message: `Token for "${account.name}" is already fresh`,
        meta: accountToRefresh.meta ?? extractMeta(latestAuth),
        lastRefresh: latestAuth.last_refresh,
        skipped: true,
      };
    }

    return refreshCloudSavedAccountEntry({ ...accountToRefresh, auth: latestAuth });
  });
}

async function retryPersistRotatedCloudAuthAfterConflict(
  name: string,
  rotatedAuth: AuthFile,
  consumedRefreshToken: string | null,
  originalResult: CloudMutationResult,
): Promise<CloudMutationResult> {
  const latestAccount = getSavedAccountEntry(name, "cloud");
  const latestAuth = latestAccount?.auth;
  const latestRefreshToken = latestAuth?.tokens?.refresh_token ?? null;
  if (
    !latestAccount
    || latestAccount.storageState !== "ready"
    || !latestAuth
    || !consumedRefreshToken
    || latestRefreshToken !== consumedRefreshToken
  ) {
    return originalResult;
  }

  const mergedAuth = clone(latestAuth);
  mergedAuth.tokens ??= {};
  if (rotatedAuth.tokens?.access_token) {
    mergedAuth.tokens.access_token = rotatedAuth.tokens.access_token;
  }
  if (rotatedAuth.tokens?.refresh_token) {
    mergedAuth.tokens.refresh_token = rotatedAuth.tokens.refresh_token;
  }
  if (rotatedAuth.tokens?.id_token) {
    mergedAuth.tokens.id_token = rotatedAuth.tokens.id_token;
  }
  if (rotatedAuth.last_refresh) {
    mergedAuth.last_refresh = rotatedAuth.last_refresh;
  }

  logWarn(LOG_PREFIX, "retry-cloud-token-persist-after-conflict", {
    account: name,
    expectedEntryVersion: originalResult.conflict?.expectedEntryVersion ?? null,
    currentEntryVersion: latestAccount.syncVersion,
  });
  return persistCloudAccountAuth(
    name,
    mergedAuth,
    latestAccount.syncVersion,
    latestAccount.syncUpdatedAt,
  );
}

async function refreshCloudSavedAccountEntry(account: SavedAccountInfo & { auth: AuthFile }): Promise<{
  success: boolean;
  message: string;
  meta?: AccountMeta;
  lastRefresh?: string;
  conflict?: CloudSyncConflict;
}> {
  const auth = clone(account.auth);
  const consumedRefreshToken = auth.tokens?.refresh_token ?? null;
  try {
    const refreshed = await refreshAccessToken(auth);
    applyRefreshResponse(auth, refreshed);
    let persistResult = await persistCloudAccountAuth(
      account.name,
      auth,
      account.syncVersion,
      account.syncUpdatedAt,
    );
    if (!persistResult.success && persistResult.conflict) {
      persistResult = await retryPersistRotatedCloudAuthAfterConflict(
        account.name,
        auth,
        consumedRefreshToken,
        persistResult,
      );
    }
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
      await updateMarkerSyncMetadata("account", account.name, {
        entryVersion: persistResult.syncVersion ?? null,
        updatedAt: persistResult.syncUpdatedAt ?? null,
      });
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
  const currentBeforeMove = getSavedCurrentSelection();
  const wasCurrent =
    currentBeforeMove.kind === "account"
    && currentBeforeMove.name === account.name
    && currentBeforeMove.source === account.source;
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

  if (wasCurrent) {
    await setCurrentAccountMarker({
      name: account.name,
      source: target,
      syncVersion: target === "cloud" ? nextCloudMetadata.entryVersion : null,
      syncUpdatedAt: target === "cloud" ? nextCloudMetadata.updatedAt : null,
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
  const result = await writeCloudProviderWithExpectedVersion(
    profile,
    options?.expectedEntryVersion,
    options?.expectedUpdatedAt,
    "save_provider_profile",
  );
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
): Promise<{ success: boolean; message: string; conflict?: CloudSyncConflict; healedMarker?: HealedCloudMarker }> {
  const syncResult = await syncCurrentAuthToSavedSelection();
  if (!syncResult.success) {
    return {
      success: false,
      message: syncResult.message ?? "Failed to sync the current selection before switching modes.",
      conflict: syncResult.conflict,
      healedMarker: syncResult.healedMarker,
    };
  }

  if (provider.source === "local") {
    const result = switchMode(provider.name);
    if (result.success) {
      await setMarker({ kind: "provider", name: provider.name, source: "local" });
    }
    return result.success && syncResult.healedMarker
      ? { ...result, healedMarker: syncResult.healedMarker }
      : result;
  }

  if (!provider.profile || provider.locked || provider.invalid) {
    return {
      success: false,
      message: provider.storageMessage ?? `Provider "${provider.name}" is unavailable.`,
      healedMarker: syncResult.healedMarker,
    };
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
  return {
    success: true,
    message: `Switched to mode "${getModeDisplayName(provider.name)}"`,
    healedMarker: syncResult.healedMarker,
  };
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
    const writeResult = await writeCloudProviderWithExpectedVersion(provider.profile, undefined, undefined, "move_provider_to_cloud");
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
