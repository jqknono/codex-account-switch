export interface AuthTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

export interface AuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: AuthTokens;
  last_refresh?: string;
  [key: string]: unknown;
}

export interface IdTokenPayload {
  email?: string;
  name?: string;
  sub?: string;
  exp?: number;
  "https://api.openai.com/auth"?: {
    chatgpt_plan_type?: string;
    chatgpt_user_id?: string;
    chatgpt_account_id?: string;
    chatgpt_subscription_active_start?: string;
    chatgpt_subscription_active_until?: string;
    organizations?: Array<{ id: string; title: string; role: string }>;
  };
}

export interface AccountMeta {
  name: string;
  email: string;
  plan: string;
}

export interface ProviderConfig {
  name: string;
  base_url: string;
  wire_api: string;
}

export interface ProviderProfile {
  kind: "provider";
  name: string;
  auth: AuthFile;
  config: ProviderConfig;
}

export type CurrentSelection =
  | {
      kind: "account";
      name: string;
      meta: AccountMeta | null;
    }
  | {
      kind: "provider";
      name: string;
    }
  | {
      kind: "unknown";
      meta: AccountMeta | null;
    };

export interface WindowInfo {
  usedPercent: number;
  resetsAt: Date | null;
  windowSeconds: number | null;
}

export type QuotaUnavailableCode =
  | "workspace_deactivated"
  | "missing_auth_tokens"
  | "invalid_auth_token"
  | "request_failed";

export interface QuotaUnavailableReason {
  code: QuotaUnavailableCode;
  message: string;
  statusCode: number | null;
}

export interface QuotaInfo {
  plan: string;
  primaryWindow: WindowInfo | null;
  secondaryWindow: WindowInfo | null;
  additional: Array<{
    name: string;
    primary: WindowInfo | null;
    secondary: WindowInfo | null;
  }>;
  codeReview: WindowInfo | null;
  credits: { hasCredits: boolean } | null;
  email: string;
  tokenExpired: boolean;
  unavailableReason: QuotaUnavailableReason | null;
}

export interface ExportData {
  version: 1;
  exportedAt: string;
  accounts: Array<{
    name: string;
    auth: AuthFile;
  }>;
}
