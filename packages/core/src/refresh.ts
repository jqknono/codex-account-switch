import * as fs from "fs";
import * as https from "https";
import * as querystring from "querystring";
import { AuthFile } from "./types";
import { readSavedAuthFileResult, writeAuthFile, writeSavedAuthFile } from "./auth";
import { createDiagnosticPerformanceTimer } from "./log";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const LOG_PREFIX = "[codex-account-switch:core:refresh]";

interface RefreshResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

export function applyRefreshResponse(auth: AuthFile, result: RefreshResponse, now = Date.now()): void {
  auth.tokens ??= {};
  if (result.access_token) {
    auth.tokens.access_token = result.access_token;
  }
  if (result.refresh_token) {
    auth.tokens.refresh_token = result.refresh_token;
  }
  if (result.id_token) {
    auth.tokens.id_token = result.id_token;
  }

  auth.last_refresh = new Date(now).toISOString();
}

function postForm(url: string, data: string): Promise<string> {
  const perf = createDiagnosticPerformanceTimer(LOG_PREFIX, "postForm", {
    url,
    contentLength: Buffer.byteLength(data),
  });
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          perf.finish({
            statusCode: res.statusCode,
            responseBytes: body.length,
          });
          resolve(body);
        } else {
          const error = new Error(`HTTP ${res.statusCode}: ${body}`);
          perf.fail(error, {
            statusCode: res.statusCode ?? null,
            responseBytes: body.length,
          });
          reject(error);
        }
      });
    });

    req.on("error", (error) => {
      perf.fail(error);
      reject(error);
    });
    req.setTimeout(15000, () => {
      req.destroy();
      const error = new Error("Request timeout");
      perf.fail(error);
      reject(error);
    });
    req.write(data);
    req.end();
  });
}

export async function refreshAccessToken(auth: AuthFile): Promise<RefreshResponse> {
  const perf = createDiagnosticPerformanceTimer(LOG_PREFIX, "refreshAccessToken", {
    hasRefreshToken: Boolean(auth.tokens?.refresh_token),
  });
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) {
    const error = new Error("No refresh_token in auth file");
    perf.fail(error);
    throw error;
  }

  try {
    const body = querystring.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });
    perf.mark("serialize-request");

    const raw = await postForm(TOKEN_URL, body);
    perf.mark("post-form");

    const parsed = JSON.parse(raw) as RefreshResponse;
    perf.mark("parse-response", {
      hasAccessToken: Boolean(parsed.access_token),
      hasRefreshToken: Boolean(parsed.refresh_token),
      hasIdToken: Boolean(parsed.id_token),
    });
    perf.finish({
      hasAccessToken: Boolean(parsed.access_token),
      hasRefreshToken: Boolean(parsed.refresh_token),
      hasIdToken: Boolean(parsed.id_token),
    });
    return parsed;
  } catch (error) {
    perf.fail(error);
    throw error;
  }
}

export async function refreshAndSave(authPath: string, options?: { saved?: boolean }): Promise<AuthFile> {
  const auth = options?.saved
    ? (() => {
        const result = readSavedAuthFileResult(authPath);
        if (result.status !== "ok") {
          throw new Error("message" in result ? result.message : "Saved auth file was not found.");
        }
        return result.value;
      })()
    : (JSON.parse(fs.readFileSync(authPath, "utf-8")) as AuthFile);
  const result = await refreshAccessToken(auth);
  applyRefreshResponse(auth, result);

  if (options?.saved) {
    writeSavedAuthFile(authPath, auth);
  } else {
    writeAuthFile(authPath, auth);
  }
  return auth;
}
