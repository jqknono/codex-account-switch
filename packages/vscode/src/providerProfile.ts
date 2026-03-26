import * as fs from "fs";
import type { ProviderProfile } from "@codex-account-switch/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ProviderProfileDraft {
  auth: Record<string, unknown>;
  config: Record<string, unknown>;
  exists: boolean;
  invalid: boolean;
}

function truncateDisplayValue(value: string, limit = 72): string {
  if (value.length <= limit) {
    return value;
  }
  const head = Math.max(16, Math.floor(limit / 2) - 2);
  const tail = Math.max(8, limit - head - 3);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function isSecretLikeProviderKey(key: string): boolean {
  return /(api[-_]?key|token|secret|password|authorization|auth)/i.test(key);
}

export function formatProviderFieldValue(
  key: string,
  value: unknown,
  options?: { revealSecrets?: boolean }
): string {
  if (value == null) {
    return "Not set";
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return "Empty";
    }

    if (isSecretLikeProviderKey(key) && !options?.revealSecrets) {
      return trimmed.length > 4
        ? `Configured (${trimmed.length} chars, ends with ${trimmed.slice(-4)})`
        : `Configured (${trimmed.length} chars)`;
    }

    return truncateDisplayValue(trimmed);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return truncateDisplayValue(JSON.stringify(value));
  } catch {
    return truncateDisplayValue(String(value));
  }
}

export function readProviderProfileDraft(filePath: string, name: string): ProviderProfileDraft {
  if (!fs.existsSync(filePath)) {
    return { auth: {}, config: {}, exists: false, invalid: false };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (!isRecord(parsed)) {
      return { auth: {}, config: {}, exists: true, invalid: true };
    }

    const auth = isRecord(parsed.auth) ? parsed.auth : {};
    const config = isRecord(parsed.config) ? parsed.config : {};

    return {
      auth,
      config,
      exists: true,
      invalid:
        parsed.kind !== "provider" ||
        parsed.name !== name ||
        !isRecord(parsed.auth) ||
        !isRecord(parsed.config) ||
        typeof auth.OPENAI_API_KEY !== "string" ||
        auth.OPENAI_API_KEY.trim() === "" ||
        typeof config.base_url !== "string" ||
        config.base_url.trim() === "" ||
        typeof config.wire_api !== "string" ||
        config.wire_api.trim() === "",
    };
  } catch {
    return { auth: {}, config: {}, exists: true, invalid: true };
  }
}

export function buildCompletedProviderProfile(
  name: string,
  defaults: ProviderProfile,
  draft: ProviderProfileDraft,
  values: { apiKey: string; baseUrl: string; wireApi: string }
): ProviderProfile {
  return {
    kind: "provider",
    name,
    auth: {
      ...defaults.auth,
      ...draft.auth,
      OPENAI_API_KEY: values.apiKey.trim(),
    },
    config: {
      ...defaults.config,
      ...draft.config,
      name,
      base_url: values.baseUrl.trim(),
      wire_api: values.wireApi.trim(),
    },
  };
}
