import * as https from "https";
import { AuthFile, IdTokenPayload, WindowInfo, QuotaInfo, QuotaUnavailableReason } from "./types";
import { jwtDecode } from "jwt-decode";
import { refreshAccessToken, applyRefreshResponse } from "./refresh";
import { createDiagnosticPerformanceTimer } from "./log";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const LOG_PREFIX = "[codex-account-switch:core:quota]";

export interface RateLimitWindow {
  used_percent: number;
  reset_at: number | null;
  limit_window_seconds?: number;
}

interface UsageApiResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: RateLimitWindow;
    secondary_window?: RateLimitWindow;
  };
  additional_rate_limits?: Array<{
    limit_name: string;
    rate_limit: {
      primary_window?: RateLimitWindow;
      secondary_window?: RateLimitWindow;
    };
  }>;
  code_review_rate_limit?: {
    primary_window?: RateLimitWindow;
  };
  credits?: {
    has_credits?: boolean;
    [key: string]: unknown;
  };
}

interface HttpErrorLike {
  statusCode?: number;
  body?: string;
  message?: string;
}

type AuthUpdateHook = (auth: AuthFile) => void | Promise<void>;

export interface QuotaPerformanceOptions {
  performanceMode?: "summary" | "adaptive";
  slowThresholdMs?: number;
}

function httpsGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject({ statusCode: res.statusCode, body });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.end();
  });
}

async function fetchUsageApi(
  auth: AuthFile,
  onAuthUpdated?: AuthUpdateHook,
  options: QuotaPerformanceOptions = {},
): Promise<UsageApiResponse> {
  const perf = createDiagnosticPerformanceTimer(
    LOG_PREFIX,
    "fetchUsageApi",
    {
      hasAccessToken: Boolean(auth.tokens?.access_token),
      hasAccountId: Boolean(auth.tokens?.account_id),
    },
    {
      mode: options.performanceMode === "adaptive" ? "adaptive" : "normal",
      slowThresholdMs: options.slowThresholdMs ?? 0,
    },
  );
  const accessToken = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id ?? "";

  if (!accessToken) {
    const error = new Error("No access_token in auth file");
    perf.fail(error);
    throw error;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "User-Agent": "codex-account-switch/1.0",
    Accept: "application/json",
  };

  try {
    const raw = await httpsGet(USAGE_URL, headers);
    perf.mark("usage-request");
    const parsed = JSON.parse(raw) as UsageApiResponse;
    perf.mark("parse-usage-response");
    perf.finish({
      retriedAfterAuthError: false,
    });
    return parsed;
  } catch (err: unknown) {
    const httpErr = err as { statusCode?: number };
    if (httpErr.statusCode === 401 || httpErr.statusCode === 403) {
      perf.mark("usage-request-auth-error", {
        statusCode: httpErr.statusCode,
      });
      const refreshed = await refreshAccessToken(auth);
      applyRefreshResponse(auth, refreshed);
      perf.mark("refresh-access-token");
      await onAuthUpdated?.(auth);
      perf.mark("persist-refreshed-auth");
      const refreshedAccessToken = auth.tokens?.access_token;

      if (!refreshedAccessToken) {
        const error = new Error("No access_token in auth file");
        perf.fail(error, {
          retriedAfterAuthError: true,
        });
        throw error;
      }

      headers.Authorization = `Bearer ${refreshedAccessToken}`;
      const raw = await httpsGet(USAGE_URL, headers);
      perf.mark("retry-usage-request");
      const parsed = JSON.parse(raw) as UsageApiResponse;
      perf.mark("parse-retry-usage-response");
      perf.finish({
        retriedAfterAuthError: true,
      });
      return parsed;
    }
    perf.fail(err);
    throw err;
  }
}

function parseWindow(w?: RateLimitWindow): WindowInfo | null {
  if (!w) return null;
  return {
    usedPercent: w.used_percent,
    resetsAt: w.reset_at ? new Date(w.reset_at * 1000) : null,
    windowSeconds: w.limit_window_seconds ?? null,
  };
}

function parseUnavailableReason(auth: AuthFile, err: unknown): QuotaUnavailableReason {
  if (!auth.tokens?.access_token) {
    return {
      code: "missing_auth_tokens",
      message: "Missing auth tokens",
      statusCode: null,
    };
  }

  const httpErr = err as HttpErrorLike;
  const statusCode = typeof httpErr.statusCode === "number" ? httpErr.statusCode : null;

  if (typeof httpErr.body === "string" && httpErr.body) {
    try {
      const parsed = JSON.parse(httpErr.body) as {
        detail?: string | { code?: string };
      };
      if (parsed.detail && typeof parsed.detail === "object" && parsed.detail.code === "deactivated_workspace") {
        return {
          code: "workspace_deactivated",
          message: "Workspace deactivated",
          statusCode,
        };
      }

      if (typeof parsed.detail === "string" && /authentication token/i.test(parsed.detail)) {
        return {
          code: "invalid_auth_token",
          message: "Missing auth tokens",
          statusCode,
        };
      }
    } catch {
      // Ignore body parse failures and fall through to the generic mapping.
    }
  }

  if (httpErr.message === "No access_token in auth file") {
    return {
      code: "missing_auth_tokens",
      message: "Missing auth tokens",
      statusCode,
    };
  }

  return {
    code: "request_failed",
    message: "Quota unavailable",
    statusCode,
  };
}

export async function getQuotaInfo(
  auth: AuthFile,
  onAuthUpdated?: AuthUpdateHook,
  options: QuotaPerformanceOptions = {},
): Promise<QuotaInfo> {
  const perf = createDiagnosticPerformanceTimer(
    LOG_PREFIX,
    "getQuotaInfo",
    {
      hasIdToken: Boolean(auth.tokens?.id_token),
      hasAccessToken: Boolean(auth.tokens?.access_token),
    },
    {
      mode: options.performanceMode === "adaptive" ? "adaptive" : "normal",
      slowThresholdMs: options.slowThresholdMs ?? 0,
    },
  );
  let email = "unknown";
  let tokenExpired = false;

  const idToken = auth.tokens?.id_token;
  if (typeof idToken === "string" && idToken) {
    try {
      const decoded = jwtDecode<IdTokenPayload>(idToken);
      email = decoded.email ?? "unknown";
    } catch {
      // ignore
    }
  }
  perf.mark("decode-id-token", { email });

  const accessToken = auth.tokens?.access_token;
  if (typeof accessToken === "string" && accessToken) {
    try {
      const decoded = jwtDecode<{ exp?: number }>(accessToken);
      if (decoded.exp) {
        tokenExpired = decoded.exp * 1000 < Date.now();
      }
    } catch {
      // ignore
    }
  }
  perf.mark("decode-access-token", { tokenExpired });

  let apiData: UsageApiResponse;
  try {
    apiData = await fetchUsageApi(auth, onAuthUpdated, options);
    perf.mark("fetch-usage-api");
  } catch (err: unknown) {
    const unavailable = {
      plan: getPlanFromToken(auth),
      primaryWindow: null,
      secondaryWindow: null,
      additional: [],
      codeReview: null,
      credits: null,
      email,
      tokenExpired,
      unavailableReason: parseUnavailableReason(auth, err),
    };
    perf.finish({
      unavailableReason: unavailable.unavailableReason?.code ?? null,
    });
    return unavailable;
  }

  const rl = apiData.rate_limit ?? {};
  const additional = (apiData.additional_rate_limits ?? []).map((item) => ({
    name: item.limit_name,
    primary: parseWindow(item.rate_limit?.primary_window),
    secondary: parseWindow(item.rate_limit?.secondary_window),
  }));

  const info = {
    plan: apiData.plan_type ?? getPlanFromToken(auth),
    primaryWindow: parseWindow(rl.primary_window),
    secondaryWindow: parseWindow(rl.secondary_window),
    additional,
    codeReview: parseWindow(apiData.code_review_rate_limit?.primary_window),
    credits: apiData.credits?.has_credits ? { hasCredits: true } : null,
    email,
    tokenExpired,
    unavailableReason: null,
  };
  perf.mark("build-quota-info", {
    hasPrimaryWindow: Boolean(info.primaryWindow),
    hasSecondaryWindow: Boolean(info.secondaryWindow),
    additionalCount: info.additional.length,
  });
  perf.finish({
    unavailableReason: null,
    hasPrimaryWindow: Boolean(info.primaryWindow),
    hasSecondaryWindow: Boolean(info.secondaryWindow),
    additionalCount: info.additional.length,
  });
  return info;
}

function getPlanFromToken(auth: AuthFile): string {
  const idToken = auth.tokens?.id_token;
  if (!idToken) return "unknown";
  try {
    const decoded = jwtDecode<IdTokenPayload>(idToken);
    return decoded["https://api.openai.com/auth"]?.chatgpt_plan_type ?? "unknown";
  } catch {
    return "unknown";
  }
}
