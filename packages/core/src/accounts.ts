import * as fs from "fs";
import {
  getCodexAuthPath,
  getNamedAuthPath,
  listNamedAuthFiles,
  getNamedAuthDir,
} from "./paths";
import { readCurrentAuth, readAuthFile, extractMeta, hasAccountAuthTokens } from "./auth";
import { refreshAndSave } from "./refresh";
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

function normalizeIdentityValue(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function getAccountIdentity(meta: AccountMeta | null | undefined): string | null {
  if (!meta) return null;
  const email = normalizeIdentityValue(meta.email);
  const plan = normalizeIdentityValue(meta.plan);
  if (!email || !plan) return null;
  return `${email}::${plan}`;
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
    if (getAccountIdentity(account.meta) === identity) {
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

  if (current.tokens?.account_id) {
    for (const name of listNamedAuthFiles()) {
      const named = readNamedAuth(name);
      if (named?.tokens?.account_id === current.tokens.account_id) {
        return name;
      }
    }
  }

  const currentIdentity = getAccountIdentity(extractMeta(current));
  if (!currentIdentity) {
    return null;
  }

  for (const account of getSavedAccountsSnapshot()) {
    if (getAccountIdentity(account.meta) === currentIdentity) {
      return account.name;
    }
  }
  return null;
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
  const identity = getAccountIdentity(meta);
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

  const dest = getNamedAuthPath(name);
  fs.mkdirSync(getNamedAuthDir(), { recursive: true });
  fs.copyFileSync(getCodexAuthPath(), dest);

  return { success: true, message: `Account "${name}" was saved`, meta };
}

export function removeAccount(name: string): { success: boolean; message: string } {
  const p = getNamedAuthPath(name);
  if (!fs.existsSync(p)) {
    return { success: false, message: `Account "${name}" does not exist.` };
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
  let auth: AuthFile | null;
  let displayName: string;

  if (name) {
    auth = readNamedAuth(name);
    if (!auth) {
      return { kind: "not_found", message: `Account "${name}" does not exist.` };
    }
    displayName = name;
  } else {
    const selection = getCurrentSelection();
    if (selection.kind === "provider") {
      return {
        kind: "unsupported",
        modeName: selection.name,
        message: `Quota is unavailable in provider mode "${getModeDisplayName(selection.name)}". Switch to an account or pass an account name explicitly.`,
      };
    }

    if (selection.kind === "account") {
      auth = readNamedAuth(selection.name);
      displayName = selection.name;
    } else {
      auth = readCurrentAuth();
      displayName = "Current auth";
    }
  }

  if (!auth) {
    return { kind: "not_found", message: "No auth information found." };
  }

  const info = await getQuotaInfo(auth);
  return { kind: "ok", displayName, info };
}

export async function refreshAccount(name?: string): Promise<{
  success: boolean;
  message: string;
  meta?: AccountMeta;
  lastRefresh?: string;
  unsupported?: boolean;
}> {
  let authPath: string;
  let displayName: string;

  if (name) {
    authPath = getNamedAuthPath(name);
    if (!fs.existsSync(authPath)) {
      return { success: false, message: `Account "${name}" does not exist.` };
    }
    displayName = name;
  } else {
    const selection = getCurrentSelection();
    if (selection.kind === "provider") {
      return {
        success: false,
        unsupported: true,
        message: `Refresh is unavailable in provider mode "${getModeDisplayName(selection.name)}". Switch to an account or pass an account name explicitly.`,
      };
    }

    if (selection.kind === "account") {
      authPath = getNamedAuthPath(selection.name);
      displayName = selection.name;
    } else {
      authPath = getCodexAuthPath();
      displayName = "Current auth";
    }
  }

  if (!fs.existsSync(authPath)) {
    return { success: false, message: "Auth file was not found." };
  }

  try {
    const updated = await refreshAndSave(authPath);

    if (name) {
      const currentName = detectCurrentName();
      if (currentName === name) {
        fs.copyFileSync(authPath, getCodexAuthPath());
      }
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
      message: `Token refresh failed: ${err instanceof Error ? err.message : err}`,
    };
  }
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
      fs.writeFileSync(dest, JSON.stringify(account.auth, null, 2), "utf-8");
      imported.push(account.name);
    } catch (err) {
      errors.push(`${account.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { imported, skipped, errors };
}
