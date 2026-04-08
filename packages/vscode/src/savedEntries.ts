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
  listAccounts,
  listProviderModes,
  readCurrentAuth,
  readProviderProfileResult,
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

export type StorageSource = "local" | "cloud";
export type SaveTarget = StorageSource;

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
}

export type SavedSelection =
  | { kind: "account"; name: string; source: StorageSource; meta: AccountMeta | null }
  | { kind: "provider"; name: string; source: StorageSource }
  | { kind: "unknown"; meta: AccountMeta | null };

interface SyncedStorageData {
  version: 1;
  accounts: Record<string, unknown>;
  providers: Record<string, unknown>;
}

interface CurrentSelectionMarker {
  kind: "account" | "provider";
  name: string;
  source: StorageSource;
}

const SYNCED_STORAGE_SETTING = "syncedStorage";
const DEFAULT_TARGET_SETTING = "defaultSaveTarget";
const CLOUD_TOKEN_AUTO_UPDATE_SETTING = "cloudTokenAutoUpdate";
const CLOUD_TOKEN_AUTO_UPDATE_INTERVAL_HOURS_SETTING = "cloudTokenAutoUpdateIntervalHours";
const CURRENT_SELECTION_KEY = "codex-account-switch.currentSavedSelection";
const DEFAULT_CLOUD_TOKEN_AUTO_UPDATE_INTERVAL_HOURS = 24;
const QUOTA_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const inflightCloudQuotaQueries = new Map<string, Promise<QuotaQueryResult>>();

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

export function initializeSavedEntries(context: vscode.ExtensionContext): void {
  extensionContext = context;
}

function getDefaultSyncedStorage(): SyncedStorageData {
  return {
    version: 1,
    accounts: {},
    providers: {},
  };
}

function readSyncedStorage(): SyncedStorageData {
  const raw = getConfiguration().get<unknown>(SYNCED_STORAGE_SETTING, getDefaultSyncedStorage());
  if (!isRecord(raw) || raw.version !== 1) {
    return getDefaultSyncedStorage();
  }

  return {
    version: 1,
    accounts: isRecord(raw.accounts) ? clone(raw.accounts) : {},
    providers: isRecord(raw.providers) ? clone(raw.providers) : {},
  };
}

async function writeSyncedStorage(data: SyncedStorageData): Promise<void> {
  await getConfiguration().update(SYNCED_STORAGE_SETTING, data, vscode.ConfigurationTarget.Global);
}

export function getSyncedStorageSettingKey(): string {
  return SYNCED_STORAGE_SETTING;
}

export function hasEncryptedSyncedEntries(): boolean {
  const storage = readSyncedStorage();
  return Object.values(storage.accounts).some((value) => isSerializedSavedValueEncrypted(value))
    || Object.values(storage.providers).some((value) => isSerializedSavedValueEncrypted(value));
}

function requireCloudPassphrase(): void {
  if (!getSavedAuthPassphrase()) {
    throw new Error("Cloud storage requires a local storage password before saving synced auth data.");
  }
}

function toId(source: StorageSource, name: string): string {
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

function readCloudAccount(name: string) {
  return deserializeSavedValue<AuthFile>(readSyncedStorage().accounts[name], "saved_auth");
}

function readCloudProvider(name: string) {
  return deserializeSavedValue<ProviderProfile>(readSyncedStorage().providers[name], "saved_provider");
}

function getLocalAccounts(): SavedAccountInfo[] {
  return listAccounts().map((account) => ({
    ...account,
    id: toId("local", account.name),
    source: "local" as const,
  }));
}

function getCloudAccounts(): SavedAccountInfo[] {
  return getCloudAccountNames().map((name) => {
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
    };
  });
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
    };
  });
}

function getCloudProviders(): SavedProviderInfo[] {
  return getCloudProviderNames().map((name) => {
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

export function listSavedAccounts(): SavedAccountInfo[] {
  return selectCurrentAccount([...getLocalAccounts(), ...getCloudAccounts()]);
}

export function listSavedProviders(): SavedProviderInfo[] {
  return selectCurrentProvider([...getLocalProviders(), ...getCloudProviders()]);
}

export function getSavedAccountEntry(name: string, source: StorageSource): SavedAccountInfo | null {
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
): Promise<boolean> {
  if (mode === "automatic" && !shouldAutoPersistCloudTokens(auth)) {
    return false;
  }

  markCloudTokenSync(auth);
  await writeCloudAccount(name, auth);
  return true;
}

function getReadyAccounts(): SavedAccountInfo[] {
  return listSavedAccounts().filter((account) => account.storageState === "ready" && account.auth);
}

function getLocalSelection(): CurrentSelection {
  return getCurrentSelection();
}

export function getSavedCurrentSelection(): SavedSelection {
  const activeProvider = getActiveModelProvider();
  if (activeProvider) {
    const marker = getMarker();
    return {
      kind: "provider",
      name: activeProvider,
      source: marker?.kind === "provider" && marker.name === activeProvider ? marker.source : "local",
    };
  }

  const currentAuth = readCurrentAuth();
  if (!currentAuth) {
    return { kind: "unknown", meta: null };
  }

  const identity = getAccountIdentity(currentAuth);
  const marker = getMarker();
  const matches = getReadyAccounts().filter((account) => getAccountIdentity(account.auth) === identity);
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

async function writeCloudAccount(name: string, auth: AuthFile): Promise<void> {
  requireCloudPassphrase();
  const storage = readSyncedStorage();
  storage.accounts[name] = serializeSavedValue("saved_auth", auth as Record<string, unknown>, {
    requireEncryption: true,
  });
  await writeSyncedStorage(storage);
}

async function writeCloudProvider(profile: ProviderProfile): Promise<void> {
  requireCloudPassphrase();
  const storage = readSyncedStorage();
  storage.providers[profile.name] = serializeSavedValue("saved_provider", profile as unknown as Record<string, unknown>, {
    requireEncryption: true,
  });
  await writeSyncedStorage(storage);
}

export async function syncCurrentAuthToSavedSelection(): Promise<void> {
  const marker = getMarker();
  if (!marker || marker.source === "local") {
    syncCurrentAuthToSavedAccount();
    return;
  }

  if (marker.kind === "account") {
    const auth = readCurrentAuth();
    if (auth && hasAccountAuthTokens(auth)) {
      await persistCloudAccountAuth(marker.name, auth, "automatic");
    }
    return;
  }

  const activeProvider = getActiveModelProvider();
  if (marker.kind === "provider" && activeProvider === marker.name) {
    const provider = getSavedProviderEntry(marker.name, "cloud");
    const currentAuth = readCurrentAuth();
    if (provider?.profile && currentAuth) {
      await writeCloudProvider({
        ...provider.profile,
        auth: currentAuth,
      });
    }
  }
}

function getSourceLabel(source: StorageSource): string {
  return source === "cloud" ? "cloud" : "local";
}

export async function saveCurrentAuthAsAccount(
  name: string,
  source: StorageSource,
): Promise<{ success: boolean; message: string; meta?: AccountMeta }> {
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
  await writeCloudAccount(name, auth);
  return { success: true, message: `Account "${name}" was saved to cloud storage`, meta };
}

export async function useSavedAccountEntry(
  account: SavedAccountInfo,
): Promise<{ success: boolean; message: string; meta?: AccountMeta }> {
  await syncCurrentAuthToSavedSelection();

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
  await setMarker({ kind: "account", name: account.name, source: "cloud" });
  return {
    success: true,
    message: `Switched to account "${account.name}"`,
    meta: account.meta ?? extractMeta(account.auth),
  };
}

function shouldRefreshBeforeQuota(auth: AuthFile): boolean {
  const refreshToken = auth.tokens?.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    return false;
  }
  if (!auth.last_refresh) {
    return true;
  }
  const lastRefreshTime = Date.parse(auth.last_refresh);
  if (Number.isNaN(lastRefreshTime)) {
    return true;
  }
  return Date.now() - lastRefreshTime >= QUOTA_REFRESH_INTERVAL_MS;
}

export async function querySavedAccountQuota(account: SavedAccountInfo): Promise<QuotaQueryResult> {
  if (account.source === "local") {
    const core = await import("@codex-account-switch/core");
    return core.queryQuota(account.name);
  }

  const existingQuery = inflightCloudQuotaQueries.get(account.id);
  if (existingQuery) {
    return existingQuery;
  }

  if (account.storageState !== "ready" || !account.auth) {
    return {
      kind: "not_found",
      message: account.storageMessage ?? `Saved cloud account "${account.name}" is unavailable.`,
    };
  }

  const initialAuth = account.auth;
  const queryPromise = (async (): Promise<QuotaQueryResult> => {
    const auth = clone(initialAuth);
    const persist = async (mode: "manual" | "automatic"): Promise<void> => {
      await persistCloudAccountAuth(account.name, auth, mode);
      const current = getSavedCurrentSelection();
      if (current.kind === "account" && current.source === "cloud" && current.name === account.name) {
        writeCurrentAuth(auth);
      }
    };

    if (shouldRefreshBeforeQuota(auth)) {
      const refreshed = await refreshAccessToken(auth);
      applyRefreshResponse(auth, refreshed);
      await persist("automatic");
    }

    const info = await getQuotaInfo(auth, () => persist("automatic"));
    return {
      kind: "ok",
      displayName: account.name,
      info,
    };
  })();

  inflightCloudQuotaQueries.set(account.id, queryPromise);
  queryPromise.finally(() => {
    if (inflightCloudQuotaQueries.get(account.id) === queryPromise) {
      inflightCloudQuotaQueries.delete(account.id);
    }
  });

  return queryPromise;
}

export async function refreshSavedAccountEntry(account: SavedAccountInfo): Promise<{
  success: boolean;
  message: string;
  meta?: AccountMeta;
  lastRefresh?: string;
  unsupported?: boolean;
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
    await persistCloudAccountAuth(account.name, auth, "manual");
    const current = getSavedCurrentSelection();
    if (current.kind === "account" && current.source === "cloud" && current.name === account.name) {
      writeCurrentAuth(auth);
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
): Promise<{ success: boolean; message: string }> {
  if (account.source === "local") {
    return renameAccount(account.name, newName);
  }

  const storage = readSyncedStorage();
  if (!(account.name in storage.accounts)) {
    return { success: false, message: `Account "${account.name}" does not exist.` };
  }
  if (newName in storage.accounts) {
    return { success: false, message: `Account "${newName}" already exists.` };
  }

  storage.accounts[newName] = storage.accounts[account.name];
  delete storage.accounts[account.name];
  await writeSyncedStorage(storage);

  const marker = getMarker();
  if (marker?.kind === "account" && marker.source === "cloud" && marker.name === account.name) {
    await setMarker({ ...marker, name: newName });
  }

  return { success: true, message: `Renamed account "${account.name}" to "${newName}"` };
}

async function removeLocalAccountFile(name: string): Promise<void> {
  const authPath = getNamedAuthPath(name);
  if (fs.existsSync(authPath)) {
    fs.unlinkSync(authPath);
  }
}

async function removeCloudAccountEntry(name: string): Promise<void> {
  const storage = readSyncedStorage();
  delete storage.accounts[name];
  await writeSyncedStorage(storage);
}

export async function removeSavedAccountEntry(account: SavedAccountInfo): Promise<{ success: boolean; message: string }> {
  if (account.source === "local") {
    return removeAccount(account.name);
  }

  const current = getSavedCurrentSelection();
  if (current.kind === "account" && current.source === "cloud" && current.name === account.name) {
    return { success: false, message: `Account "${account.name}" is currently in use and cannot be removed.` };
  }

  const storage = readSyncedStorage();
  if (!(account.name in storage.accounts)) {
    return { success: false, message: `Account "${account.name}" does not exist.` };
  }

  delete storage.accounts[account.name];
  await writeSyncedStorage(storage);
  return { success: true, message: `Account "${account.name}" was removed` };
}

export async function moveSavedAccountEntry(
  account: SavedAccountInfo,
  target: StorageSource,
): Promise<{ success: boolean; message: string }> {
  if (account.source === target) {
    return { success: true, message: `Account "${account.name}" is already stored in ${target}.` };
  }
  if (account.storageState !== "ready" || !account.auth) {
    return { success: false, message: account.storageMessage ?? `Saved account "${account.name}" is unavailable.` };
  }

  if (target === "local") {
    writeSavedAuthFile(getNamedAuthPath(account.name), account.auth);
    await removeCloudAccountEntry(account.name);
  } else {
    requireCloudPassphrase();
    const auth = clone(account.auth);
    markCloudTokenSync(auth);
    await writeCloudAccount(account.name, auth);
    await removeLocalAccountFile(account.name);
  }

  const current = getSavedCurrentSelection();
  if (current.kind === "account" && current.name === account.name && current.source === account.source) {
    await setMarker({ kind: "account", name: account.name, source: target });
  }

  return { success: true, message: `Moved account "${account.name}" to ${getSourceLabel(target)} storage.` };
}

export async function saveProviderProfileToSource(profile: ProviderProfile, source: StorageSource): Promise<void> {
  if (source === "local") {
    writeProviderProfile(profile);
    return;
  }

  requireCloudPassphrase();
  await writeCloudProvider(profile);
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
): Promise<{ success: boolean; message: string }> {
  await syncCurrentAuthToSavedSelection();

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
  await setMarker({ kind: "provider", name: provider.name, source: "cloud" });
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

async function removeCloudProviderEntry(name: string): Promise<void> {
  const storage = readSyncedStorage();
  delete storage.providers[name];
  await writeSyncedStorage(storage);
}

export async function deleteSavedProviderEntry(
  provider: SavedProviderInfo,
): Promise<{ success: boolean; message: string; deactivated?: boolean }> {
  if (provider.source === "local") {
    return deleteProviderProfile(provider.name);
  }

  const current = getSavedCurrentSelection();
  if (current.kind === "provider" && current.source === "cloud" && current.name === provider.name) {
    return { success: false, message: `Provider "${provider.name}" is currently in use and cannot be removed.` };
  }

  const storage = readSyncedStorage();
  if (!(provider.name in storage.providers)) {
    return { success: false, message: `Provider "${provider.name}" does not exist.` };
  }

  delete storage.providers[provider.name];
  await writeSyncedStorage(storage);
  return { success: true, message: `Removed provider "${provider.name}"` };
}

export async function moveSavedProviderEntry(
  provider: SavedProviderInfo,
  target: StorageSource,
): Promise<{ success: boolean; message: string }> {
  if (provider.source === target) {
    return { success: true, message: `Provider "${provider.name}" is already stored in ${target}.` };
  }
  if (!provider.profile || provider.locked || provider.invalid) {
    return { success: false, message: provider.storageMessage ?? `Provider "${provider.name}" is unavailable.` };
  }

  await saveProviderProfileToSource(provider.profile, target);
  if (provider.source === "local") {
    await removeLocalProviderFile(provider.name);
  } else {
    await removeCloudProviderEntry(provider.name);
  }

  const current = getSavedCurrentSelection();
  if (current.kind === "provider" && current.name === provider.name && current.source === provider.source) {
    await setMarker({ kind: "provider", name: provider.name, source: target });
  }

  return { success: true, message: `Moved provider "${provider.name}" to ${getSourceLabel(target)} storage.` };
}
