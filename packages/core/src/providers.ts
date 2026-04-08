import * as fs from "fs";
import { syncCurrentAuthToSavedAccount, writeCurrentAuth } from "./auth";
import { activateProviderConfig, clearActiveModelProvider, getActiveModelProvider, removeProviderConfig } from "./config";
import { getNamedAuthDir, getNamedProviderPath, listNamedProviderFiles } from "./paths";
import { ProviderProfile } from "./types";
import { readSavedJsonFile, SavedStorageReadResult, writeSavedJsonFile } from "./savedStorage";

export interface SwitchModeResult {
  success: boolean;
  message: string;
}

export interface DeleteProviderResult {
  success: boolean;
  message: string;
  deactivated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getModeDisplayName(name: string): string {
  return name;
}

export function getDefaultProviderProfile(name: string): ProviderProfile {
  return {
    kind: "provider",
    name,
    auth: {
      OPENAI_API_KEY: "",
    },
    config: {
      name,
      base_url: "",
      wire_api: "responses",
    },
  };
}

export function readProviderProfileResult(name: string): SavedStorageReadResult<ProviderProfile> {
  const providerPath = getNamedProviderPath(name);
  const result = readSavedJsonFile<ProviderProfile>(providerPath, "saved_provider");
  if (result.status !== "ok") {
    return result;
  }

  const parsed = result.value as unknown;
  if (!isRecord(parsed)) {
    return { status: "invalid", encrypted: result.encrypted, message: "Provider profile is not a JSON object." };
  }
  if (parsed.kind !== "provider" || parsed.name !== name) {
    return { status: "invalid", encrypted: result.encrypted, message: `Provider "${name}" is invalid.` };
  }
  if (!isRecord(parsed.auth) || !isRecord(parsed.config)) {
    return { status: "invalid", encrypted: result.encrypted, message: `Provider "${name}" is invalid.` };
  }

  const providerName = parsed.config.name;
  const baseUrl = parsed.config.base_url;
  const wireApi = parsed.config.wire_api;
  if (
    typeof providerName !== "string" ||
    typeof baseUrl !== "string" ||
    typeof wireApi !== "string"
  ) {
    return { status: "invalid", encrypted: result.encrypted, message: `Provider "${name}" is invalid.` };
  }

  return {
    status: "ok",
    encrypted: result.encrypted,
    value: {
      kind: "provider",
      name,
      auth: parsed.auth,
      config: {
        name: providerName,
        base_url: baseUrl,
        wire_api: wireApi,
      },
    },
  };
}

export function readProviderProfile(name: string): ProviderProfile | null {
  const result = readProviderProfileResult(name);
  return result.status === "ok" ? result.value : null;
}

export function writeProviderProfile(profile: ProviderProfile): void {
  fs.mkdirSync(getNamedAuthDir(), { recursive: true });
  writeSavedJsonFile(getNamedProviderPath(profile.name), "saved_provider", profile as unknown as Record<string, unknown>);
}

export function deleteProviderProfile(name: string): DeleteProviderResult {
  if (name === "account") {
    return {
      success: false,
      message: '"account" mode cannot be deleted.',
      deactivated: false,
    };
  }

  const providerPath = getNamedProviderPath(name);
  if (!fs.existsSync(providerPath)) {
    return {
      success: false,
      message: `Provider "${name}" does not exist.`,
      deactivated: false,
    };
  }

  if (getActiveModelProvider() === name) {
    return {
      success: false,
      message: `Provider "${name}" is currently in use and cannot be removed.`,
      deactivated: false,
    };
  }

  fs.unlinkSync(providerPath);

  removeProviderConfig(name);

  return {
    success: true,
    message: `Removed provider "${name}"`,
    deactivated: false,
  };
}

export function listProviderModes(): string[] {
  return listNamedProviderFiles().sort();
}

export function listModes(): string[] {
  return ["account", ...listProviderModes()];
}

export function switchMode(name: string): SwitchModeResult {
  if (name === "account") {
    clearActiveModelProvider();
    return { success: true, message: "Switched to account mode" };
  }

  const profileResult = readProviderProfileResult(name);
  if (profileResult.status !== "ok") {
    const providerPath = getNamedProviderPath(name);
    return {
      success: false,
      message:
        profileResult.status === "missing"
          ? `Provider "${name}" does not exist or is invalid. Create ${providerPath} first or run the mode command to configure it.`
          : profileResult.message,
    };
  }
  const profile = profileResult.value;

  fs.mkdirSync(getNamedAuthDir(), { recursive: true });
  syncCurrentAuthToSavedAccount();
  writeCurrentAuth(profile.auth);
  activateProviderConfig(name, profile.config);
  return { success: true, message: `Switched to mode "${getModeDisplayName(name)}"` };
}
