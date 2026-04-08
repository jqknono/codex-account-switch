import * as fs from "fs";
import { jwtDecode } from "jwt-decode";
import { getCodexAuthPath, getNamedAuthPath, listNamedAuthFiles } from "./paths";
import { AuthFile, IdTokenPayload, AccountMeta } from "./types";
import { readSavedJsonFile, SavedStorageReadResult, writeSavedJsonFile } from "./savedStorage";

function parseAuthJson(raw: string): AuthFile | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as AuthFile;
  } catch {
    return null;
  }
}

function sanitizeAuthFile(auth: AuthFile): AuthFile {
  const sanitized: AuthFile = {};

  if (typeof auth.auth_mode === "string" && auth.auth_mode) {
    sanitized.auth_mode = auth.auth_mode;
  }

  if (Object.prototype.hasOwnProperty.call(auth, "OPENAI_API_KEY")) {
    sanitized.OPENAI_API_KEY = auth.OPENAI_API_KEY ?? null;
  }

  if (auth.tokens && typeof auth.tokens === "object") {
    const tokens = auth.tokens;
    const sanitizedTokens: NonNullable<AuthFile["tokens"]> = {};

    if (typeof tokens.id_token === "string") {
      sanitizedTokens.id_token = tokens.id_token;
    }
    if (typeof tokens.access_token === "string") {
      sanitizedTokens.access_token = tokens.access_token;
    }
    if (typeof tokens.refresh_token === "string") {
      sanitizedTokens.refresh_token = tokens.refresh_token;
    }
    if (typeof tokens.account_id === "string") {
      sanitizedTokens.account_id = tokens.account_id;
    }

    if (Object.keys(sanitizedTokens).length > 0) {
      sanitized.tokens = sanitizedTokens;
    }
  }

  if (typeof auth.last_refresh === "string" && auth.last_refresh) {
    sanitized.last_refresh = auth.last_refresh;
  }

  return sanitized;
}

export function readCurrentAuth(): AuthFile | null {
  const p = getCodexAuthPath();
  if (!fs.existsSync(p)) {
    return null;
  }
  return parseAuthJson(fs.readFileSync(p, "utf-8"));
}

export function readAuthFile(filePath: string): AuthFile | null {
  if (!fs.existsSync(filePath)) return null;
  return parseAuthJson(fs.readFileSync(filePath, "utf-8"));
}

export function writeAuthFile(filePath: string, auth: AuthFile): void {
  fs.writeFileSync(filePath, JSON.stringify(sanitizeAuthFile(auth), null, 2), "utf-8");
}

export function readSavedAuthFileResult(filePath: string): SavedStorageReadResult<AuthFile> {
  const result = readSavedJsonFile<AuthFile>(filePath, "saved_auth");
  if (result.status !== "ok") {
    return result;
  }

  return {
    ...result,
    value: sanitizeAuthFile(result.value),
  };
}

export function writeSavedAuthFile(filePath: string, auth: AuthFile): void {
  writeSavedJsonFile(filePath, "saved_auth", sanitizeAuthFile(auth));
}

export function writeCurrentAuth(auth: AuthFile): void {
  writeAuthFile(getCodexAuthPath(), auth);
}

function normalizeIdentityValue(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function extractMeta(auth: AuthFile): AccountMeta {
  let email = "unknown";
  let name = "unknown";
  let plan = "unknown";

  const idToken = auth.tokens?.id_token;
  if (typeof idToken === "string" && idToken) {
    try {
      const decoded = jwtDecode<IdTokenPayload>(idToken);
      email = decoded.email ?? email;
      name = decoded.name ?? decoded.sub ?? name;
      const authInfo = decoded["https://api.openai.com/auth"];
      if (authInfo?.chatgpt_plan_type) {
        plan = authInfo.chatgpt_plan_type;
      }
    } catch {
      // JWT decode failed
    }
  }

  return { name, email, plan };
}

export function getAccountIdentityFromMeta(meta: AccountMeta | null | undefined): string | null {
  if (!meta) return null;
  const email = normalizeIdentityValue(meta.email);
  const plan = normalizeIdentityValue(meta.plan);
  if (!email || !plan) return null;
  return `${email}::${plan}`;
}

export function getAccountIdentity(auth: AuthFile | null | undefined): string | null {
  const accountId = normalizeIdentityValue(auth?.tokens?.account_id);
  if (accountId) {
    return `account_id::${accountId}`;
  }

  return getAccountIdentityFromMeta(auth ? extractMeta(auth) : null);
}

export function hasAccountAuthTokens(auth: AuthFile | null | undefined): boolean {
  if (!auth) {
    return false;
  }

  return typeof auth.tokens?.access_token === "string" && auth.tokens.access_token.trim().length > 0;
}

function getJwtExpiry(token: string | null | undefined): Date | null {
  if (!token) return null;
  try {
    const decoded = jwtDecode<{ exp?: number }>(token);
    if (decoded.exp) {
      return new Date(decoded.exp * 1000);
    }
  } catch {
    // ignore
  }
  return null;
}

function formatExpiry(expiry: Date | null): string {
  if (!expiry) return "unknown";
  const now = Date.now();
  const diff = expiry.getTime() - now;
  if (diff <= 0) {
    const ago = Math.abs(diff);
    const m = Math.floor(ago / 60000);
    if (m < 60) return `expired ${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `expired ${h}h${m % 60}m ago`;
    return `expired ${Math.floor(h / 24)}d${h % 24}h ago`;
  }
  const m = Math.floor(diff / 60000);
  if (m < 60) return `expires in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `expires in ${h}h${m % 60}m`;
  return `expires in ${Math.floor(h / 24)}d${h % 24}h`;
}

export function getTokenExpiry(auth: AuthFile): Date | null {
  return getJwtExpiry(auth.tokens?.access_token);
}

export function isTokenExpired(auth: AuthFile): boolean {
  const expiry = getTokenExpiry(auth);
  if (!expiry) return true;
  return expiry.getTime() < Date.now();
}

export function formatTokenExpiry(auth: AuthFile): string {
  return formatExpiry(getTokenExpiry(auth));
}

export function getRefreshTokenStatus(auth: AuthFile): "available" | "missing" {
  const refreshToken = auth.tokens?.refresh_token;
  return typeof refreshToken === "string" && refreshToken.trim().length > 0 ? "available" : "missing";
}

export function formatRefreshTokenStatus(auth: AuthFile): string {
  return getRefreshTokenStatus(auth);
}

export function findMatchingNamedAuthName(auth: AuthFile | null | undefined): string | null {
  if (!hasAccountAuthTokens(auth)) {
    return null;
  }

  const accountId = auth?.tokens?.account_id;
  if (accountId) {
    for (const name of listNamedAuthFiles()) {
      const namedResult = readSavedAuthFileResult(getNamedAuthPath(name));
      if (namedResult.status === "ok" && namedResult.value.tokens?.account_id === accountId) {
        return name;
      }
    }
  }

  const identity = getAccountIdentityFromMeta(auth ? extractMeta(auth) : null);
  if (!identity) {
    return null;
  }

  for (const name of listNamedAuthFiles()) {
    const namedResult = readSavedAuthFileResult(getNamedAuthPath(name));
    if (namedResult.status === "ok" && getAccountIdentityFromMeta(extractMeta(namedResult.value)) === identity) {
      return name;
    }
  }

  return null;
}

export function syncCurrentAuthToSavedAccount(): { name: string; auth: AuthFile } | null {
  const auth = readCurrentAuth();
  if (!auth) {
    return null;
  }

  const name = findMatchingNamedAuthName(auth);
  if (!name) {
    return null;
  }

  writeSavedAuthFile(getNamedAuthPath(name), auth);
  return { name, auth };
}
