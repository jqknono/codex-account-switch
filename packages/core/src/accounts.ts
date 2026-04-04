import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import {
  getCodexConfigDir,
  getCodexAuthPath,
  getNamedAuthPath,
  listNamedAuthFiles,
  getNamedAuthDir,
} from "./paths";
import {
  readCurrentAuth,
  readAuthFile,
  extractMeta,
  getAccountIdentity,
  hasAccountAuthTokens,
  getAccountIdentityFromMeta,
  findMatchingNamedAuthName,
  syncCurrentAuthToSavedAccount,
  writeAuthFile,
  writeCurrentAuth,
} from "./auth";
import { applyRefreshResponse, refreshAccessToken, refreshAndSave } from "./refresh";
import { getQuotaInfo } from "./quota";
import { AuthFile, AccountMeta, QuotaInfo, ExportData, CurrentSelection } from "./types";
import { clearActiveModelProvider, getActiveModelProvider } from "./config";
import { getModeDisplayName } from "./providers";

export interface AccountInfo {
  name: string;
  meta: AccountMeta | null;
  auth: AuthFile | null;
  isCurrent: boolean;
}

export type QuotaQueryResult =
  | {
      kind: "ok";
      displayName: string;
      info: QuotaInfo;
    }
  | {
      kind: "not_found";
      message: string;
    }
  | {
      kind: "unsupported";
      message: string;
      modeName: string;
    };

const QUOTA_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_LOCK_TIMEOUT_MS = 30 * 1000;
const ACCOUNT_LOCK_RETRY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAccountLockKey(auth: AuthFile): string {
  const basis =
    auth.tokens?.account_id?.trim() ||
    auth.tokens?.refresh_token?.trim() ||
    getAccountIdentity(auth) ||
    auth.tokens?.access_token?.trim() ||
    "unknown";

  return createHash("sha1").update(basis).digest("hex");
}

function getAccountLockLabel(auth: AuthFile): string {
  return auth.tokens?.account_id?.trim() || extractMeta(auth).email || "unknown";
}

function getAccountLockPath(auth: AuthFile): string {
  return path.join(getCodexConfigDir(), ".locks", `account-${getAccountLockKey(auth)}.lock`);
}

async function withAccountLock<T>(auth: AuthFile, fn: () => Promise<T>): Promise<T> {
  const lockPath = getAccountLockPath(auth);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    let handle: number | null = null;

    try {
      handle = fs.openSync(lockPath, "wx");
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf-8");
      try {
        return await fn();
      } finally {
        fs.closeSync(handle);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Ignore lock cleanup races.
        }
      }
    } catch (err) {
      if (handle != null) {
        fs.closeSync(handle);
      }

      const fileError = err as NodeJS.ErrnoException;
      if (fileError.code !== "EEXIST") {
        throw err;
      }

      if (Date.now() - startedAt >= ACCOUNT_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for account lock for "${getAccountLockLabel(auth)}"`);
      }

      await sleep(ACCOUNT_LOCK_RETRY_MS);
    }
  }
}

function resolveQuotaTarget(
  name?: string
):
  | {
      kind: "ok";
      auth: AuthFile;
      authPath: string | null;
      displayName: string;
      shouldSyncCurrentAuth: boolean;
    }
  | {
      kind: "not_found";
      message: string;
    }
  | {
      kind: "unsupported";
      message: string;
      modeName: string;
    } {
  if (name) {
    const authPath = getNamedAuthPath(name);
    if (!fs.existsSync(authPath)) {
      return { kind: "not_found", message: `Account "${name}" does not exist.` };
    }
    const synced = syncCurrentAuthToSavedAccount();
    const auth = synced?.name === name ? synced.auth : readNamedAuth(name);
    if (!auth) {
      return { kind: "not_found", message: "No auth information found." };
    }
    return {
      kind: "ok",
      auth,
      authPath,
      displayName: name,
      shouldSyncCurrentAuth: detectCurrentName() === name,
    };
  }

  const selection = getCurrentSelection();
  if (selection.kind === "provider") {
    return {
      kind: "unsupported",
      modeName: selection.name,
      message: `Quota is unavailable in provider mode "${getModeDisplayName(selection.name)}". Switch to an account or pass an account name explicitly.`,
    };
  }

  if (selection.kind === "account") {
    const authPath = getNamedAuthPath(selection.name);
    const synced = syncCurrentAuthToSavedAccount();
    const auth = synced?.name === selection.name ? synced.auth : readNamedAuth(selection.name);
    if (!auth) {
      return { kind: "not_found", message: "No auth information found." };
    }
    return {
      kind: "ok",
      auth,
      authPath,
      displayName: selection.name,
      shouldSyncCurrentAuth: true,
    };
  }

  const auth = readCurrentAuth();
  if (!auth) {
    return { kind: "not_found", message: "No auth information found." };
  }

  return {
    kind: "ok",
    auth,
    authPath: null,
    displayName: "Current auth",
    shouldSyncCurrentAuth: true,
  };
}

function resolveRefreshTarget(
  name?: string
):
  | {
      kind: "ok";
      auth: AuthFile;
      authPath: string;
      displayName: string;
      shouldSyncCurrentAuth: boolean;
    }
  | {
      kind: "error";
      success: false;
      message: string;
      unsupported?: boolean;
    } {
  if (name) {
    const authPath = getNamedAuthPath(name);
    if (!fs.existsSync(authPath)) {
      return { kind: "error", success: false, message: `Account "${name}" does not exist.` };
    }
    syncCurrentAuthToSavedAccount();
    const auth = readNamedAuth(name);
    if (!auth) {
      return { kind: "error", success: false, message: "Auth file was not found." };
    }
    return {
      kind: "ok",
      auth,
      authPath,
      displayName: name,
      shouldSyncCurrentAuth: detectCurrentName() === name,
    };
  }

  const selection = getCurrentSelection();
  if (selection.kind === "provider") {
    return {
      kind: "error",
      success: false,
      unsupported: true,
      message: `Refresh is unavailable in provider mode "${getModeDisplayName(selection.name)}". Switch to an account or pass an account name explicitly.`,
    };
  }

  if (selection.kind === "account") {
    const authPath = getNamedAuthPath(selection.name);
    syncCurrentAuthToSavedAccount();
    const auth = readNamedAuth(selection.name);
    if (!auth) {
      return { kind: "error", success: false, message: "Auth file was not found." };
    }
    return {
      kind: "ok",
      auth,
      authPath,
      displayName: selection.name,
      shouldSyncCurrentAuth: true,
    };
  }

  const authPath = getCodexAuthPath();
  if (!fs.existsSync(authPath)) {
    return { kind: "error", success: false, message: "Auth file was not found." };
  }
  const auth = readCurrentAuth();
  if (!auth) {
    return { kind: "error", success: false, message: "Auth file was not found." };
  }
  return {
    kind: "ok",
    auth,
    authPath,
    displayName: "Current auth",
    shouldSyncCurrentAuth: false,
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

function getSavedAccountsSnapshot(): Array<{ name: string; meta: AccountMeta | null; auth: AuthFile | null }> {
  return listNamedAuthFiles().map((name) => {
    const auth = readNamedAuth(name);
    const meta = auth ? extractMeta(auth) : null;
    return { name, meta, auth };
  });
}

function findAccountByIdentity(identity: string, excludeName?: string): AccountInfo | null {
  for (const account of getSavedAccountsSnapshot()) {
    if (excludeName && account.name === excludeName) {
      continue;
    }
    if (getAccountIdentity(account.auth) === identity) {
      return { ...account, isCurrent: false };
    }
  }
  return null;
}

export function readNamedAuth(name: string): AuthFile | null {
  return readAuthFile(getNamedAuthPath(name));
}

export function detectCurrentName(): string | null {
  if (getActiveModelProvider()) {
    return null;
  }

  const current = readCurrentAuth();
  if (!current) return null;
  return findMatchingNamedAuthName(current);
}

export function getCurrentSelection(): CurrentSelection {
  const activeProvider = getActiveModelProvider();
  if (activeProvider) {
    return { kind: "provider", name: activeProvider };
  }

  const currentName = detectCurrentName();
  if (currentName) {
    const auth = readNamedAuth(currentName);
    return {
      kind: "account",
      name: currentName,
      meta: auth ? extractMeta(auth) : null,
    };
  }

  const auth = readCurrentAuth();
  return { kind: "unknown", meta: auth ? extractMeta(auth) : null };
}

export function listAccounts(): AccountInfo[] {
  const currentName = detectCurrentName();
  return getSavedAccountsSnapshot().map(({ name, meta, auth }) => {
    return { name, meta, auth, isCurrent: name === currentName };
  });
}

export function addAccountFromAuth(name: string): { success: boolean; message: string; meta?: AccountMeta } {
  const auth = readCurrentAuth();
  if (!auth) {
    return { success: false, message: "auth.json was not found after login. Failed to add account." };
  }

  if (!hasAccountAuthTokens(auth)) {
    return {
      success: false,
      message:
        "Current auth.json is not a valid account login result. Complete `codex login` in account mode and try again.",
    };
  }

  const meta = extractMeta(auth);
  const identity = getAccountIdentity(auth);
  const dest = getNamedAuthPath(name);
  if (fs.existsSync(dest)) {
    const existingAuth = readNamedAuth(name);
    const existingMeta = existingAuth ? extractMeta(existingAuth) : null;
    const existingIdentity = getAccountIdentity(existingAuth);

    if (!existingIdentity) {
      return {
        success: false,
        message: `Saved account "${name}" does not contain a stable identity, so overwrite was rejected. Remove and add it again if you want to replace it.`,
        meta,
      };
    }

    if (!identity) {
      return {
        success: false,
        message: `The new login result does not contain a stable identity, so "${name}" was not overwritten.`,
        meta,
      };
    }

    if (existingIdentity !== identity) {
      const existingLabel = existingMeta ? `${existingMeta.email} (${existingMeta.plan})` : "unknown account";
      const newLabel = `${meta.email} (${meta.plan})`;
      return {
        success: false,
        message: `Saved account "${name}" belongs to a different account: expected ${existingLabel}, but the new login is ${newLabel}. Overwrite was rejected.`,
        meta,
      };
    }
  }

  if (identity) {
    const existing = findAccountByIdentity(identity, name);
    if (existing) {
      return {
        success: false,
        message: `An account with email ${meta.email} and plan ${meta.plan} is already saved as "${existing.name}". Duplicate add was rejected.`,
        meta,
      };
    }
  }

  fs.mkdirSync(getNamedAuthDir(), { recursive: true });
  fs.copyFileSync(getCodexAuthPath(), dest);

  return { success: true, message: `Account "${name}" was saved`, meta };
}

export function removeAccount(name: string): { success: boolean; message: string } {
  const p = getNamedAuthPath(name);
  if (!fs.existsSync(p)) {
    return { success: false, message: `Account "${name}" does not exist.` };
  }

  if (detectCurrentName() === name) {
    return {
      success: false,
      message: `Account "${name}" is currently in use and cannot be removed.`,
    };
  }

  fs.unlinkSync(p);
  return { success: true, message: `Account "${name}" was removed` };
}

export function renameAccount(
  oldName: string,
  newName: string
): { success: boolean; message: string } {
  const trimmedNewName = newName.trim();
  if (!trimmedNewName) {
    return { success: false, message: "New account name is required." };
  }

  const src = getNamedAuthPath(oldName);
  if (!fs.existsSync(src)) {
    return { success: false, message: `Account "${oldName}" does not exist.` };
  }

  if (oldName === trimmedNewName) {
    return { success: true, message: `Account name is already "${trimmedNewName}".` };
  }

  const dest = getNamedAuthPath(trimmedNewName);
  if (fs.existsSync(dest)) {
    return { success: false, message: `Account "${trimmedNewName}" already exists.` };
  }

  fs.renameSync(src, dest);
  return {
    success: true,
    message: `Renamed account "${oldName}" to "${trimmedNewName}"`,
  };
}

export function useAccount(name: string): { success: boolean; message: string; meta?: AccountMeta } {
  const src = getNamedAuthPath(name);
  if (!fs.existsSync(src)) {
    return { success: false, message: `Account "${name}" does not exist.` };
  }

  syncCurrentAuthToSavedAccount();
  fs.copyFileSync(src, getCodexAuthPath());
  clearActiveModelProvider();

  const auth = readNamedAuth(name);
  const meta = auth ? extractMeta(auth) : undefined;

  return { success: true, message: `Switched to account "${name}"`, meta };
}

export function getCurrentAccount(): { name: string | null; meta: AccountMeta | null } {
  const selection = getCurrentSelection();
  if (selection.kind === "account") {
    return { name: selection.name, meta: selection.meta };
  }

  if (selection.kind === "unknown") {
    return { name: null, meta: selection.meta };
  }

  return { name: null, meta: null };
}

export async function queryQuota(name?: string): Promise<QuotaQueryResult> {
  const initialTarget = resolveQuotaTarget(name);
  if (initialTarget.kind !== "ok") {
    return initialTarget;
  }

  return withAccountLock(initialTarget.auth, async () => {
    const target = resolveQuotaTarget(name);
    if (target.kind !== "ok") {
      return target;
    }

    const { auth, authPath, displayName, shouldSyncCurrentAuth } = target;
    const persistUpdatedAuth = async (): Promise<void> => {
      if (authPath) {
        writeAuthFile(authPath, auth);
      }
      if (!authPath || shouldSyncCurrentAuth) {
        writeCurrentAuth(auth);
      }
    };

    const authBefore = JSON.stringify(auth);
    if (shouldRefreshBeforeQuota(auth)) {
      const refreshed = await refreshAccessToken(auth);
      applyRefreshResponse(auth, refreshed);
      await persistUpdatedAuth();
    }

    const info = await getQuotaInfo(auth, persistUpdatedAuth);
    if (JSON.stringify(auth) !== authBefore) {
      await persistUpdatedAuth();
    }
    return { kind: "ok", displayName, info };
  });
}

export async function refreshAccount(name?: string): Promise<{
  success: boolean;
  message: string;
  meta?: AccountMeta;
  lastRefresh?: string;
  unsupported?: boolean;
}> {
  const initialTarget = resolveRefreshTarget(name);
  if (initialTarget.kind !== "ok") {
    return initialTarget;
  }

  return withAccountLock(initialTarget.auth, async () => {
    const target = resolveRefreshTarget(name);
    if (target.kind !== "ok") {
      return target;
    }

    const { authPath, displayName, shouldSyncCurrentAuth } = target;

    try {
      const updated = await refreshAndSave(authPath);

      if (shouldSyncCurrentAuth) {
        writeCurrentAuth(updated);
      }

      const meta = extractMeta(updated);
      return {
        success: true,
        message: `Token for "${displayName}" was refreshed`,
        meta,
        lastRefresh: updated.last_refresh,
      };
    } catch (err) {
      return {
        success: false,
        message: `Token refresh failed for "${displayName}": ${err instanceof Error ? err.message : err}`,
      };
    }
  });
}

export function exportAccounts(names?: string[]): ExportData {
  const allNames = names ?? listNamedAuthFiles();
  const accounts = allNames
    .map((name) => {
      const auth = readNamedAuth(name);
      if (!auth) return null;
      return { name, auth };
    })
    .filter((a): a is { name: string; auth: AuthFile } => a !== null);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts,
  };
}

export function importAccounts(
  data: ExportData,
  overwrite = false
): { imported: string[]; skipped: string[]; errors: string[] } {
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const dir = getNamedAuthDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  for (const account of data.accounts) {
    try {
      const dest = getNamedAuthPath(account.name);
      if (fs.existsSync(dest) && !overwrite) {
        skipped.push(account.name);
        continue;
      }
      writeAuthFile(dest, account.auth);
      imported.push(account.name);
    } catch (err) {
      errors.push(`${account.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { imported, skipped, errors };
}
