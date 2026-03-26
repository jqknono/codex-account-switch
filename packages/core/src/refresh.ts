import * as fs from "fs";
import * as https from "https";
import * as querystring from "querystring";
import { AuthFile } from "./types";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

interface RefreshResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

function postForm(url: string, data: string): Promise<string> {
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
          resolve(body);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.write(data);
    req.end();
  });
}

export async function refreshAccessToken(auth: AuthFile): Promise<RefreshResponse> {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error("No refresh_token in auth file");
  }

  const body = querystring.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  const raw = await postForm(TOKEN_URL, body);
  return JSON.parse(raw) as RefreshResponse;
}

export async function refreshAndSave(authPath: string): Promise<AuthFile> {
  const auth = JSON.parse(fs.readFileSync(authPath, "utf-8")) as AuthFile;
  const result = await refreshAccessToken(auth);

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
  auth.last_refresh = new Date().toISOString();

  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8");
  return auth;
}
