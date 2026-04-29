import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import {
  AuthFile,
  QuotaInfo,
  QuotaQueryResult,
  WindowInfo,
  getCodexConfigDir,
  getNamedAuthDir,
} from "@codex-account-switch/core";
import { logInfo, logWarn } from "./log";

const LOG_PREFIX = "[codex-account-switch:vscode:quotaCache]";
const CACHE_VERSION = 1;
const CACHE_DIR = path.join(os.tmpdir(), "codex-account-switch-vscode");
const CACHE_FILE = path.join(CACHE_DIR, "quota-cache-v1.json");
const LOCK_DIR = path.join(CACHE_DIR, "quota-cache-locks");
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_TIMEOUT_MS = 2 * 1000;
const LOCK_WAIT_INTERVAL_MS = 100;
const CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface QuotaCacheAccountLike {
  id: string;
  name: string;
  source: "local" | "cloud";
  auth: AuthFile | null;
}

interface SerializedWindowInfo {
  usedPercent: number;
  resetsAt: string | null;
  windowSeconds: number | null;
}

interface SerializedQuotaInfo {
  plan: string;
  primaryWindow: SerializedWindowInfo | null;
  secondaryWindow: SerializedWindowInfo | null;
  additional: Array<{
    name: string;
    primary: SerializedWindowInfo | null;
    secondary: SerializedWindowInfo | null;
  }>;
  codeReview: SerializedWindowInfo | null;
  credits: { hasCredits: boolean } | null;
  email: string;
  tokenExpired: boolean;
  unavailableReason: QuotaInfo["unavailableReason"];
}

interface QuotaCacheEntry {
  version: 1;
  accountId: string;
  accountName: string;
  source: "local" | "cloud";
  queriedAt: string;
  info: SerializedQuotaInfo;
}

interface QuotaCacheFile {
  version: 1;
  entries: Record<string, QuotaCacheEntry>;
}

export interface CachedQuotaSnapshot {
  info: QuotaInfo;
  queriedAtMs: number;
}

interface QuotaCacheLock {
  key: string;
  path: string;
}

function ensureCacheDirs(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(LOCK_DIR, { recursive: true });
}

function createEmptyCacheFile(): QuotaCacheFile {
  return {
    version: CACHE_VERSION,
    entries: {},
  };
}

function serializeWindowInfo(window: WindowInfo | null): SerializedWindowInfo | null {
  if (!window) {
    return null;
  }
  return {
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt ? window.resetsAt.toISOString() : null,
    windowSeconds: window.windowSeconds,
  };
}

function deserializeWindowInfo(window: SerializedWindowInfo | null): WindowInfo | null {
  if (!window) {
    return null;
  }
  return {
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt ? new Date(window.resetsAt) : null,
    windowSeconds: window.windowSeconds,
  };
}

function serializeQuotaInfo(info: QuotaInfo): SerializedQuotaInfo {
  return {
    plan: info.plan,
    primaryWindow: serializeWindowInfo(info.primaryWindow),
    secondaryWindow: serializeWindowInfo(info.secondaryWindow),
    additional: info.additional.map((item) => ({
      name: item.name,
      primary: serializeWindowInfo(item.primary),
      secondary: serializeWindowInfo(item.secondary),
    })),
    codeReview: serializeWindowInfo(info.codeReview),
    credits: info.credits ? { hasCredits: info.credits.hasCredits } : null,
    email: info.email,
    tokenExpired: info.tokenExpired,
    unavailableReason: info.unavailableReason,
  };
}

function deserializeQuotaInfo(info: SerializedQuotaInfo): QuotaInfo {
  return {
    plan: info.plan,
    primaryWindow: deserializeWindowInfo(info.primaryWindow),
    secondaryWindow: deserializeWindowInfo(info.secondaryWindow),
    additional: info.additional.map((item) => ({
      name: item.name,
      primary: deserializeWindowInfo(item.primary),
      secondary: deserializeWindowInfo(item.secondary),
    })),
    codeReview: deserializeWindowInfo(info.codeReview),
    credits: info.credits ? { hasCredits: info.credits.hasCredits } : null,
    email: info.email,
    tokenExpired: info.tokenExpired,
    unavailableReason: info.unavailableReason,
  };
}

function hasMeaningfulQuotaInfo(info: QuotaInfo): boolean {
  return Boolean(
    info.primaryWindow
    || info.secondaryWindow
    || info.codeReview
    || (info.additional && info.additional.some((item) => item.primary || item.secondary))
    || info.credits?.hasCredits
  );
}

function getCacheKey(account: QuotaCacheAccountLike): string {
  const accountId = account.auth?.tokens?.account_id?.trim() ?? "";
  const basis = [
    getNamedAuthDir(),
    getCodexConfigDir(),
    account.source,
    account.name,
    accountId,
  ].join("|");
  return createHash("sha1").update(basis).digest("hex");
}

function getLockPath(key: string): string {
  return path.join(LOCK_DIR, `${key}.lock`);
}

function normalizeCacheFile(raw: unknown): QuotaCacheFile {
  if (typeof raw !== "object" || raw == null) {
    return createEmptyCacheFile();
  }
  const record = raw as { version?: unknown; entries?: unknown };
  if (record.version !== CACHE_VERSION || typeof record.entries !== "object" || record.entries == null) {
    return createEmptyCacheFile();
  }
  const now = Date.now();
  const entries = Object.fromEntries(
    Object.entries(record.entries as Record<string, QuotaCacheEntry>).filter(([, entry]) => {
      const queriedAtMs = Date.parse(entry?.queriedAt ?? "");
      return Number.isFinite(queriedAtMs) && now - queriedAtMs <= CACHE_RETENTION_MS;
    }),
  );
  return {
    version: CACHE_VERSION,
    entries,
  };
}

function readCacheFile(): QuotaCacheFile {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return createEmptyCacheFile();
    }
    return normalizeCacheFile(JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")));
  } catch (error) {
    logWarn(LOG_PREFIX, "read-cache-file-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return createEmptyCacheFile();
  }
}

function writeCacheFile(cache: QuotaCacheFile): void {
  try {
    ensureCacheDirs();
    const tempFile = `${CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2), "utf-8");
    fs.renameSync(tempFile, CACHE_FILE);
  } catch (error) {
    logWarn(LOG_PREFIX, "write-cache-file-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function tryAcquireLock(key: string): QuotaCacheLock | null {
  ensureCacheDirs();
  const lockPath = getLockPath(key);
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }));
    fs.closeSync(fd);
    return {
      key,
      path: lockPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      logWarn(LOG_PREFIX, "acquire-lock-failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

function releaseLock(lock: QuotaCacheLock | null): void {
  if (!lock) {
    return;
  }
  try {
    if (fs.existsSync(lock.path)) {
      fs.unlinkSync(lock.path);
    }
  } catch (error) {
    logWarn(LOG_PREFIX, "release-lock-failed", {
      key: lock.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function maybeRemoveStaleLock(key: string): void {
  const lockPath = getLockPath(key);
  try {
    if (!fs.existsSync(lockPath)) {
      return;
    }
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs >= LOCK_STALE_MS) {
      fs.unlinkSync(lockPath);
      logInfo(LOG_PREFIX, "removed-stale-lock", {
        key,
      });
    }
  } catch (error) {
    logWarn(LOG_PREFIX, "remove-stale-lock-failed", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getCachedQuotaSnapshotByKey(key: string): CachedQuotaSnapshot | null {
  const cache = readCacheFile();
  const entry = cache.entries[key];
  if (!entry) {
    return null;
  }
  const queriedAtMs = Date.parse(entry.queriedAt);
  if (!Number.isFinite(queriedAtMs)) {
    return null;
  }
  return {
    info: deserializeQuotaInfo(entry.info),
    queriedAtMs,
  };
}

export function getCachedQuotaSnapshot(account: QuotaCacheAccountLike): CachedQuotaSnapshot | null {
  return getCachedQuotaSnapshotByKey(getCacheKey(account));
}

export function shouldUseCachedQuota(queriedAtMs: number, minIntervalMs: number): boolean {
  return Date.now() - queriedAtMs < Math.max(0, minIntervalMs);
}

export function writeCachedQuotaSnapshot(account: QuotaCacheAccountLike, info: QuotaInfo): void {
  if (!hasMeaningfulQuotaInfo(info) || info.unavailableReason) {
    return;
  }

  const key = getCacheKey(account);
  const cache = readCacheFile();
  cache.entries[key] = {
    version: CACHE_VERSION,
    accountId: account.id,
    accountName: account.name,
    source: account.source,
    queriedAt: new Date().toISOString(),
    info: serializeQuotaInfo(info),
  };
  writeCacheFile(cache);
}

async function waitForCacheFromOtherProcess(key: string, minQueriedAtMs: number): Promise<CachedQuotaSnapshot | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCK_WAIT_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_INTERVAL_MS));
    const cached = getCachedQuotaSnapshotByKey(key);
    if (cached && cached.queriedAtMs >= minQueriedAtMs) {
      return cached;
    }
    if (!fs.existsSync(getLockPath(key))) {
      return getCachedQuotaSnapshotByKey(key);
    }
  }
  return getCachedQuotaSnapshotByKey(key);
}

export async function queryQuotaWithCache(
  account: QuotaCacheAccountLike,
  options: {
    minIntervalMs: number;
    forceFetch?: boolean;
    fetch: () => Promise<QuotaQueryResult>;
  },
): Promise<QuotaQueryResult> {
  const key = getCacheKey(account);
  const cached = getCachedQuotaSnapshotByKey(key);
  if (!options.forceFetch && cached && shouldUseCachedQuota(cached.queriedAtMs, options.minIntervalMs)) {
    logInfo(LOG_PREFIX, "use-fresh-cache", {
      account: account.name,
      source: account.source,
      ageMs: Date.now() - cached.queriedAtMs,
    });
    return {
      kind: "ok",
      displayName: account.name,
      info: cached.info,
    };
  }

  maybeRemoveStaleLock(key);
  let lock = tryAcquireLock(key);
  if (!lock) {
    if (cached) {
      logInfo(LOG_PREFIX, "reuse-stale-cache-while-locked", {
        account: account.name,
        source: account.source,
      });
      return {
        kind: "ok",
        displayName: account.name,
        info: cached.info,
      };
    }

    const waited = await waitForCacheFromOtherProcess(key, Date.now());
    if (waited) {
      logInfo(LOG_PREFIX, "use-cache-after-wait", {
        account: account.name,
        source: account.source,
      });
      return {
        kind: "ok",
        displayName: account.name,
        info: waited.info,
      };
    }

    maybeRemoveStaleLock(key);
    lock = tryAcquireLock(key);
  }

  try {
    const result = await options.fetch();
    if (result.kind === "ok") {
      if (result.info.unavailableReason && cached) {
        logWarn(LOG_PREFIX, "fallback-to-cache-after-unavailable-result", {
          account: account.name,
          source: account.source,
          unavailableReason: result.info.unavailableReason.code,
        });
        return {
          kind: "ok",
          displayName: account.name,
          info: cached.info,
        };
      }
      writeCachedQuotaSnapshot(account, result.info);
    } else if (cached) {
      return {
        kind: "ok",
        displayName: account.name,
        info: cached.info,
      };
    }
    return result;
  } catch (error) {
    if (cached) {
      logWarn(LOG_PREFIX, "fallback-to-cache-after-query-error", {
        account: account.name,
        source: account.source,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        kind: "ok",
        displayName: account.name,
        info: cached.info,
      };
    }
    throw error;
  } finally {
    releaseLock(lock);
  }
}
