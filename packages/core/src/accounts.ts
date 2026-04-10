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
  readSavedAuthFileResult,
  extractMeta,
  getAccountIdentity,
  hasAccountAuthTokens,
  getAccountIdentityFromMeta,
  findMatchingNamedAuthName,
  syncCurrentAuthToSavedAccount,
  writeAuthFile,
  writeCurrentAuth,
  writeSavedAuthFile,
} from "./auth";
import { refreshAndSave } from "./refresh";
import { getQuotaInfo } from "./quota";
import { AuthFile, AccountMeta, QuotaInfo, ExportData, CurrentSelection } from "./types";
import { clearActiveModelProvider, getActiveModelProvider } from "./config";
import { getModeDisplayName } from "./providers";
import { createDiagnosticPerformanceTimer, writeDiagnosticLog } from "./log";
import { SavedStorageReadResult } from "./savedStorage";

export interface AccountInfo {
  name: string;
  meta: AccountMeta | null;
  auth: AuthFile | null;
  isCurrent: boolean;
  storageState: "ready" | "locked" | "invalid";
  storageMessage?: string;
  encrypted: boolean;
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

const ACCOUNT_LOCK_TIMEOUT_MS = 30 * 1000;
const ACCOUNT_LOCK_RETRY_MS = 100;
const STALE_ACCOUNT_LOCK_MS = 5 * 60 * 1000;
const inflightQuotaQueries = new Map<string, Promise<QuotaQueryResult>>();
const LOCK_LOG_PREFIX = "[codex-account-switch:lock]";

function getSavedAuthReadErrorMessage(result: SavedStorageReadResult<AuthFile>, name: string): string {
  if (result.status === "locked" || result.status === "invalid") {
    return `Saved account "${name}" is unavailable: ${result.message}`;
  }
  return `Account "${name}" does not exist.`;
}

function readNamedAuthResult(name: string): SavedStorageReadResult<AuthFile> {
  return readSavedAuthFileResult(getNamedAuthPath(name));
}

function toAccountInfo(name: string, isCurrent: boolean): AccountInfo {
  const result = readNamedAuthResult(name);
  if (result.status === "ok") {
    return {
      name,
      meta: extractMeta(result.value),
      auth: result.value,
      isCurrent,
      storageState: "ready",
      storageMessage: undefined,
      encrypted: result.encrypted,
    };
  }

  return {
    name,
    meta: null,
    auth: null,
    isCurrent,
    storageState: result.status === "locked" ? "locked" : "invalid",
    storageMessage: "message" in result ? result.message : undefined,
    encrypted: result.encrypted,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logAccountLock(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>): void {
  const line = `${LOCK_LOG_PREFIX} ${event} ${JSON.stringify(details)}`;
  writeDiagnosticLog(level, line);
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

function readAccountLockDebugInfo(lockPath: string): Record<string, unknown> | null {
  try {
    const stat = fs.statSync(lockPath);
    const raw = fs.readFileSync(lockPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { raw };
    }

    return {
      ...(typeof parsed === "object" && parsed !== null ? parsed : { raw: String(parsed) }),
      lockMtime: stat.mtime.toISOString(),
      lockAgeMs: Math.max(0, Date.now() - stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function tryRemoveStaleAccountLock(
  lockPath: string,
  operation: string,
  lockLabel: string,
  lockKey: string
): boolean {
  const holder = readAccountLockDebugInfo(lockPath);
  if (!holder) {
    return false;
  }

  const holderPid = typeof holder.pid === "number" ? holder.pid : null;
  const lockAgeMs = typeof holder.lockAgeMs === "number" ? holder.lockAgeMs : null;
  const shouldRemove =
    (holderPid != null && !isProcessRunning(holderPid)) ||
    (lockAgeMs != null && lockAgeMs >= STALE_ACCOUNT_LOCK_MS);

  if (!shouldRemove) {
    return false;
  }

  try {
    fs.unlinkSync(lockPath);
    logAccountLock("warn", "stale-lock-removed", {
      operation,
      account: lockLabel,
      lockKey,
      lockPath,
      holder,
    });
    return true;
  } catch {
    return false;
  }
}

async function withAccountLock<T>(auth: AuthFile, operation: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = getAccountLockPath(auth);
  const lockKey = getAccountLockKey(auth);
  const lockLabel = getAccountLockLabel(auth);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  let waitLogged = false;

  while (true) {
    let handle: number | null = null;

    try {
      handle = fs.openSync(lockPath, "wx");
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf-8");
      const waitedMs = Date.now() - startedAt;
      if (waitedMs > 0) {
        logAccountLock("info", "acquired", {
          operation,
          account: lockLabel,
          lockKey,
          lockPath,
          waitedMs,
        });
      }
      try {
        return await fn();
      } finally {
        fs.closeSync(handle);
        handle = null;
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Ignore lock cleanup races.
        }
        if (waitedMs > 0) {
          logAccountLock("info", "released", {
            operation,
            account: lockLabel,
            lockKey,
            lockPath,
            heldMs: Date.now() - startedAt,
          });
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

      if (!waitLogged) {
        waitLogged = true;
        logAccountLock("warn", "waiting", {
          operation,
          account: lockLabel,
          lockKey,
          lockPath,
          holder: readAccountLockDebugInfo(lockPath),
        });
      }

      if (tryRemoveStaleAccountLock(lockPath, operation, lockLabel, lockKey)) {
        waitLogged = false;
        continue;
      }

      if (Date.now() - startedAt >= ACCOUNT_LOCK_TIMEOUT_MS) {
        const holder = readAccountLockDebugInfo(lockPath);
        logAccountLock("error", "timeout", {
          operation,
          account: lockLabel,
          lockKey,
          lockPath,
          waitedMs: Date.now() - startedAt,
          holder,
        });
        throw new Error(
          `Timed out waiting for account lock for "${lockLabel}" (${operation}). Holder: ${JSON.stringify(holder)}`
        );
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
    const savedResult = synced?.name === name ? null : readNamedAuthResult(name);
    const auth = synced?.name === name ? synced.auth : savedResult?.status === "ok" ? savedResult.value : null;
    if (!auth) {
      return {
        kind: "not_found",
        message: savedResult ? getSavedAuthReadErrorMessage(savedResult, name) : "No auth information found.",
      };
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
    const savedResult = synced?.name === selection.name ? null : readNamedAuthResult(selection.name);
    const auth = synced?.name === selection.name ? synced.auth : savedResult?.status === "ok" ? savedResult.value : null;
    if (!auth) {
      return {
        kind: "not_found",
        message: savedResult ? getSavedAuthReadErrorMessage(savedResult, selection.name) : "No auth information found.",
      };
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
    const savedResult = readNamedAuthResult(name);
    if (savedResult.status !== "ok") {
      return { kind: "error", success: false, message: getSavedAuthReadErrorMessage(savedResult, name) };
    }
    return {
      kind: "ok",
      auth: savedResult.value,
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
    const savedResult = readNamedAuthResult(selection.name);
    if (savedResult.status !== "ok") {
      return {
        kind: "error",
        success: false,
        message: getSavedAuthReadErrorMessage(savedResult, selection.name),
      };
    }
    return {
      kind: "ok",
      auth: savedResult.value,
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

function getSavedAccountsSnapshot(): Array<{ name: string; meta: AccountMeta | null; auth: AuthFile | null }> {
  return listNamedAuthFiles().map((name) => {
    const info = toAccountInfo(name, false);
    return { name, meta: info.meta, auth: info.auth };
  });
}

function findAccountByIdentity(identity: string, excludeName?: string): AccountInfo | null {
  for (const name of listNamedAuthFiles()) {
    if (excludeName && name === excludeName) {
      continue;
    }
    const account = toAccountInfo(name, false);
    if (getAccountIdentity(account.auth) === identity) {
      return account;
    }
  }
  return null;
}

export function readNamedAuth(name: string): AuthFile | null {
  const result = readNamedAuthResult(name);
  return result.status === "ok" ? result.value : null;
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
  return listNamedAuthFiles().map((name) => toAccountInfo(name, name === currentName));
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
    const existingResult = readNamedAuthResult(name);
    if (existingResult.status !== "ok") {
      return {
        success: false,
        message: getSavedAuthReadErrorMessage(existingResult, name),
        meta,
      };
    }
    const existingAuth = existingResult.value;
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
  writeSavedAuthFile(dest, auth);

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
  const result = readNamedAuthResult(name);
  if (result.status !== "ok") {
    return { success: false, message: getSavedAuthReadErrorMessage(result, name) };
  }
  writeCurrentAuth(result.value);
  clearActiveModelProvider();

  const meta = extractMeta(result.value);

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
  const perf = createDiagnosticPerformanceTimer("[codex-account-switch:core:accounts]", "queryQuota", {
    requestedName: name ?? null,
  });
  try {
    const initialTarget = resolveQuotaTarget(name);
    perf.mark("resolve-initial-target", {
      initialResultKind: initialTarget.kind,
    });
    if (initialTarget.kind !== "ok") {
      perf.finish({
        resultKind: initialTarget.kind,
      });
      return initialTarget;
    }

    const lockKey = getAccountLockKey(initialTarget.auth);
    const existingQuery = inflightQuotaQueries.get(lockKey);
    if (existingQuery) {
      logAccountLock("info", "reuse-inflight-quota", {
        operation: "queryQuota",
        account: getAccountLockLabel(initialTarget.auth),
        lockKey,
      });
      perf.finish({
        resultKind: "inflight",
        reusedInflight: true,
        account: getAccountLockLabel(initialTarget.auth),
      });
      return existingQuery;
    }

    const queryPromise: Promise<QuotaQueryResult> = withAccountLock(initialTarget.auth, "queryQuota", async () => {
      perf.mark("account-lock-acquired", {
        account: getAccountLockLabel(initialTarget.auth),
      });
      const target = resolveQuotaTarget(name);
      perf.mark("resolve-target-inside-lock", {
        targetKind: target.kind,
      });
      if (target.kind !== "ok") {
        return target;
      }

      const { auth, authPath, displayName, shouldSyncCurrentAuth } = target;
      const persistUpdatedAuth = async (): Promise<void> => {
        if (authPath) {
          writeSavedAuthFile(authPath, auth);
        }
        if (!authPath || shouldSyncCurrentAuth) {
          writeCurrentAuth(auth);
        }
        perf.mark("persist-updated-auth", {
          authPath: authPath ?? null,
          shouldSyncCurrentAuth,
        });
      };

      const authBefore = JSON.stringify(auth);
      const info = await getQuotaInfo(auth, persistUpdatedAuth);
      perf.mark("get-quota-info", {
        unavailableReason: info.unavailableReason?.code ?? null,
      });
      if (JSON.stringify(auth) !== authBefore) {
        await persistUpdatedAuth();
      }
      return { kind: "ok" as const, displayName, info };
    });

    inflightQuotaQueries.set(lockKey, queryPromise);
    queryPromise
      .then((result) => {
        perf.finish({
          resultKind: result.kind,
          displayName: "displayName" in result ? result.displayName : null,
        });
      })
      .catch((error) => {
        perf.fail(error, {
          account: getAccountLockLabel(initialTarget.auth),
        });
      })
      .finally(() => {
        if (inflightQuotaQueries.get(lockKey) === queryPromise) {
          inflightQuotaQueries.delete(lockKey);
        }
      });

    return queryPromise;
  } catch (error) {
    perf.fail(error);
    throw error;
  }
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

  try {
    return await withAccountLock(initialTarget.auth, "refreshAccount", async () => {
      const target = resolveRefreshTarget(name);
      if (target.kind !== "ok") {
        return target;
      }

      const { authPath, displayName, shouldSyncCurrentAuth } = target;

      try {
        const updated = await refreshAndSave(authPath, { saved: authPath !== getCodexAuthPath() });

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
  } catch (err) {
    return {
      success: false,
      message: `Token refresh failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}

export function exportAccounts(names?: string[]): ExportData {
  const allNames = names ?? listNamedAuthFiles();
  const accounts = allNames.map((name) => {
    const result = readNamedAuthResult(name);
    if (result.status !== "ok") {
      throw new Error(getSavedAuthReadErrorMessage(result, name));
    }
    return { name, auth: result.value };
  });

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
      writeSavedAuthFile(dest, account.auth);
      imported.push(account.name);
    } catch (err) {
      errors.push(`${account.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { imported, skipped, errors };
}
