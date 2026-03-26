import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export const NAMED_AUTH_DIR_ENV_VAR = "CODEX_ACCOUNT_SWITCH_AUTH_DIR";

export function getCodexConfigDir(): string {
  if (process.env.CODEX_HOME) {
    return process.env.CODEX_HOME;
  }
  return path.join(os.homedir(), ".codex");
}

function normalizeOptionalDir(dir: string | null | undefined): string | null {
  const trimmed = dir?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

export function setNamedAuthDir(dir?: string | null): void {
  const normalized = normalizeOptionalDir(dir);
  if (normalized) {
    process.env[NAMED_AUTH_DIR_ENV_VAR] = normalized;
    return;
  }
  delete process.env[NAMED_AUTH_DIR_ENV_VAR];
}

export function getNamedAuthDir(): string {
  return normalizeOptionalDir(process.env[NAMED_AUTH_DIR_ENV_VAR]) ?? getCodexConfigDir();
}

export function getCodexAuthPath(): string {
  return path.join(getCodexConfigDir(), "auth.json");
}

export function getCodexConfigPath(): string {
  return path.join(getCodexConfigDir(), "config.toml");
}

export function getNamedAuthPath(name: string): string {
  return path.join(getNamedAuthDir(), `auth_${name}.json`);
}

export function getNamedProviderPath(name: string): string {
  return path.join(getNamedAuthDir(), `provider_${name}.json`);
}

export function listNamedAuthFiles(): string[] {
  const dir = getNamedAuthDir();
  if (!fs.existsSync(dir)) return [];

  const pattern = /^auth_(.+)\.json$/;
  return fs
    .readdirSync(dir)
    .map((f) => pattern.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

export function listNamedProviderFiles(): string[] {
  const dir = getNamedAuthDir();
  if (!fs.existsSync(dir)) return [];

  const pattern = /^provider_(.+)\.json$/;
  return fs
    .readdirSync(dir)
    .map((f) => pattern.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}
