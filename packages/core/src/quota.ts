import * as https from "https";
import { AuthFile, IdTokenPayload, WindowInfo, QuotaInfo, QuotaUnavailableReason } from "./types";
import { jwtDecode } from "jwt-decode";
import { refreshAccessToken } from "./refresh";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

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

async function fetchUsageApi(auth: AuthFile): Promise<UsageApiResponse> {
  const accessToken = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id ?? "";

  if (!accessToken) {
    throw new Error("No access_token in auth file");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "User-Agent": "codex-account-switch/1.0",
    Accept: "application/json",
  };

  try {
    const raw = await httpsGet(USAGE_URL, headers);
    return JSON.parse(raw) as UsageApiResponse;
  } catch (err: unknown) {
    const httpErr = err as { statusCode?: number };
    if (httpErr.statusCode === 401 || httpErr.statusCode === 403) {
      const refreshed = await refreshAccessToken(auth);
      auth.tokens ??= {};
      if (refreshed.access_token) {
        auth.tokens.access_token = refreshed.access_token;
      }
      if (refreshed.refresh_token) {
        auth.tokens.refresh_token = refreshed.refresh_token;
      }

      if (!auth.tokens.access_token) {
        throw new Error("No access_token in auth file");
      }

      headers.Authorization = `Bearer ${auth.tokens.access_token}`;
      const raw = await httpsGet(USAGE_URL, headers);
      return JSON.parse(raw) as UsageApiResponse;
    }
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

export async function getQuotaInfo(auth: AuthFile): Promise<QuotaInfo> {
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

  let apiData: UsageApiResponse;
  try {
    apiData = await fetchUsageApi(auth);
  } catch (err: unknown) {
    return {
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
  }

  const rl = apiData.rate_limit ?? {};
  const additional = (apiData.additional_rate_limits ?? []).map((item) => ({
    name: item.limit_name,
    primary: parseWindow(item.rate_limit?.primary_window),
    secondary: parseWindow(item.rate_limit?.secondary_window),
  }));

  return {
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
