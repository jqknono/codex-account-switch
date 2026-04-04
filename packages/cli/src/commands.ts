import * as fs from "fs";
import { execSync } from "child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import {
  listAccounts,
  addAccountFromAuth,
  removeAccount,
  useAccount,
  getCurrentAccount,
  queryQuota,
  refreshAccount,
  exportAccounts,
  importAccounts,
  AuthFile,
  formatTokenExpiry,
  formatRefreshTokenStatus,
  ExportData,
  WindowInfo,
  getNamedAuthPath,
  readNamedAuth,
  readCurrentAuth,
  getCurrentSelection,
  listModes,
  switchMode,
  readProviderProfile,
  writeProviderProfile,
  getDefaultProviderProfile,
  getNamedProviderPath,
  ProviderProfile,
  getModeDisplayName,
} from "@codex-account-switch/core";

function getCodexLoginCommand(deviceAuth = false): string {
  return deviceAuth ? "codex login --device-auth" : "codex login";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PromptSession =
  | {
      rl: readline.Interface;
      pipedLines: null;
      pipedIndex: 0;
    }
  | {
      rl: null;
      pipedLines: string[];
      pipedIndex: number;
    };

async function createPromptSession(): Promise<PromptSession> {
  if (input.isTTY && output.isTTY) {
    return {
      rl: readline.createInterface({ input, output }),
      pipedLines: null,
      pipedIndex: 0,
    };
  }

  input.setEncoding("utf8");
  let raw = "";
  for await (const chunk of input) {
    raw += chunk;
  }
  return {
    rl: null,
    pipedLines: raw.split(/\r?\n/),
    pipedIndex: 0,
  };
}

async function askRequired(session: PromptSession, label: string, defaultValue?: string): Promise<string> {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    let answer = "";

    if (session.rl) {
      answer = (await session.rl.question(`${label}${suffix}: `)).trim();
    } else {
      output.write(`${label}${suffix}: `);
      const rawAnswer =
        session.pipedIndex < session.pipedLines.length ? session.pipedLines[session.pipedIndex] : "";
      session.pipedIndex += 1;
      answer = rawAnswer.trim();
      output.write("\n");
    }

    if (answer) {
      return answer;
    }
    if (defaultValue) {
      return defaultValue;
    }
    if (!session.rl && session.pipedIndex >= session.pipedLines.length) {
      throw new Error(`Missing required input for ${label}.`);
    }
    console.log(chalk.yellow("This value is required."));
  }
}

function resolveModeNameInput(name: string): string {
  return name;
}

function readProviderProfileDraft(name: string): {
  auth: Record<string, unknown>;
  config: Record<string, unknown>;
  exists: boolean;
  invalid: boolean;
} {
  const providerPath = getNamedProviderPath(name);
  if (!fs.existsSync(providerPath)) {
    return { auth: {}, config: {}, exists: false, invalid: false };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(providerPath, "utf-8")) as unknown;
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

async function ensureProviderProfile(name: string): Promise<ProviderProfile | null> {
  const existing = readProviderProfile(name);
  if (existing) {
    return existing;
  }

  const defaults = getDefaultProviderProfile(name);
  const draft = readProviderProfileDraft(name);
  console.log(
    chalk.cyan(
      `${draft.exists ? "Completing" : "Creating"} provider "${name}".`
    )
  );
  console.log(chalk.dim(`  Profile file: ${getNamedProviderPath(name)}`));
  if (draft.invalid) {
    console.log(chalk.yellow("  Existing profile is incomplete or invalid. Required fields will be prompted and the file will be updated."));
  }

  const prompts = await createPromptSession();
  try {
    const existingApiKey =
      typeof draft.auth.OPENAI_API_KEY === "string" && draft.auth.OPENAI_API_KEY.trim()
        ? draft.auth.OPENAI_API_KEY
        : undefined;
    const existingBaseUrl =
      typeof draft.config.base_url === "string" && draft.config.base_url.trim()
        ? draft.config.base_url
        : defaults.config.base_url || undefined;
    const existingWireApi =
      typeof draft.config.wire_api === "string" && draft.config.wire_api.trim()
        ? draft.config.wire_api
        : defaults.config.wire_api;

    const apiKey = await askRequired(prompts, "OPENAI_API_KEY", existingApiKey);
    const baseUrl = await askRequired(prompts, "base_url", existingBaseUrl);
    const wireApi = await askRequired(prompts, "wire_api", existingWireApi);

    const profile: ProviderProfile = {
      kind: "provider",
      name,
      auth: {
        ...defaults.auth,
        ...draft.auth,
        OPENAI_API_KEY: apiKey,
      },
      config: {
        name,
        base_url: baseUrl,
        wire_api: wireApi,
      },
    };

    writeProviderProfile(profile);
    console.log(chalk.green(`✓ Created provider profile for "${name}"`));
    return profile;
  } finally {
    prompts.rl?.close();
  }
}

export function cmdList(): void {
  const accounts = listAccounts();

  if (accounts.length === 0) {
    console.log(chalk.yellow("No saved accounts. Use the add command to create one."));
    return;
  }

  console.log(chalk.bold("\nSaved accounts:\n"));

  const maxNameLen = Math.max(...accounts.map((a) => a.name.length), 4);

  for (const account of accounts) {
    const marker = account.isCurrent ? chalk.green("● ") : "  ";
    const tag = account.isCurrent ? chalk.green(" [current]") : "";
    const paddedName = account.name.padEnd(maxNameLen);
    const email = account.meta?.email ?? "unknown";
    const plan = account.meta?.plan ?? "unknown";
    const tokenStatus = account.auth
      ? `${formatTokenStatusTag("access", account.auth)}${formatTokenStatusTag("refresh", account.auth)}`
      : "";

    console.log(
      `${marker}${chalk.bold(paddedName)}  ${chalk.dim(email)}  ${chalk.cyan(plan)}${tokenStatus}${tag}`
    );
  }
  console.log();
}

function colorTokenStatus(status: string): string {
  if (status === "unknown" || status === "missing") {
    return chalk.yellow(status);
  }
  if (status.startsWith("expired")) {
    return chalk.red(status);
  }
  return chalk.green(status);
}

function getAccessTokenStatus(auth: AuthFile): string {
  return formatTokenExpiry(auth);
}

function getRefreshTokenStatus(auth: AuthFile): string {
  return formatRefreshTokenStatus(auth);
}

function formatTokenStatusTag(kind: "access" | "refresh", auth: AuthFile): string {
  const status = kind === "access" ? getAccessTokenStatus(auth) : getRefreshTokenStatus(auth);
  return ` [${kind}: ${colorTokenStatus(status)}]`;
}

function printTokenStatusLines(auth: AuthFile | null): void {
  if (!auth) {
    console.log(`  Access token: ${chalk.yellow("unknown")}`);
    console.log(`  Refresh token: ${chalk.yellow("unknown")}`);
    return;
  }

  console.log(`  Access token:  ${colorTokenStatus(getAccessTokenStatus(auth))}`);
  console.log(`  Refresh token: ${colorTokenStatus(getRefreshTokenStatus(auth))}`);
}

function readQuotaDisplayAuth(name?: string): AuthFile | null {
  if (name) {
    return readNamedAuth(name);
  }

  const selection = getCurrentSelection();
  if (selection.kind === "account") {
    return readNamedAuth(selection.name);
  }

  return readCurrentAuth();
}

function getQuotaTargetLabel(name?: string): string {
  if (name) {
    return name;
  }

  const selection = getCurrentSelection();
  if (selection.kind === "account") {
    return selection.name;
  }

  return "Current auth";
}

export async function cmdAdd(name: string, options?: { deviceAuth?: boolean }): Promise<void> {
  const deviceAuth = options?.deviceAuth ?? false;
  const loginCommand = getCodexLoginCommand(deviceAuth);
  const dest = getNamedAuthPath(name);
  if (fs.existsSync(dest)) {
    console.log(chalk.yellow(`Account "${name}" already exists. Trying to refresh its token first.`));

    const refreshResult = await refreshAccount(name);
    if (refreshResult.success) {
      const refreshedAuth = readNamedAuth(name);

      console.log(chalk.green(`✓ Account "${name}" already existed and its token was refreshed.`));
      printTokenStatusLines(refreshedAuth);
      return;
    }

    console.log(chalk.yellow(`  Token refresh failed: ${refreshResult.message}`));
    console.log(chalk.cyan("  Starting a new login flow to re-authorize and overwrite the saved account.\n"));
  }

  const previousSelection = getCurrentSelection();
  let restoreProviderOnFailure = false;
  if (previousSelection.kind === "provider") {
    const switchResult = switchMode("account");
    if (!switchResult.success) {
      console.log(chalk.red(switchResult.message));
      return;
    }
    restoreProviderOnFailure = true;
    console.log(
      chalk.dim(
        `Exited provider mode "${getModeDisplayName(previousSelection.name)}" before login so Codex can create an account auth.json.`
      )
    );
  }

  console.log(
    chalk.cyan(
      `Starting the Codex login flow${deviceAuth ? " with device auth" : ""}...\n  Command: ${loginCommand}\n`
    )
  );
  if (deviceAuth) {
    console.log(
      chalk.dim(
        '  If Codex says "Enable device code authorization for Codex in ChatGPT Security Settings, then run \\"codex login --device-auth\\" again.", enable it in ChatGPT first and retry.\n'
      )
    );
  }

  try {
    execSync(loginCommand, { stdio: "inherit" });
  } catch {
    if (restoreProviderOnFailure && previousSelection.kind === "provider") {
      switchMode(previousSelection.name);
    }
    console.log(chalk.red("\nLogin failed or was cancelled."));
    return;
  }

  const result = addAccountFromAuth(name);
  if (!result.success) {
    if (restoreProviderOnFailure && previousSelection.kind === "provider") {
      switchMode(previousSelection.name);
    }
    console.log(chalk.red(result.message));
    return;
  }

  console.log(chalk.green(`\n✓ ${result.message}`));
  if (result.meta) {
    console.log(chalk.dim(`  Email: ${result.meta.email}`));
    console.log(chalk.dim(`  Plan: ${result.meta.plan}`));
  }
  console.log(chalk.dim(`  File: ${dest}`));
}

export function cmdRemove(name: string): void {
  const result = removeAccount(name);
  console.log(result.success ? chalk.green(`✓ ${result.message}`) : chalk.red(result.message));
}

export function cmdUse(name: string): void {
  const result = useAccount(name);
  if (!result.success) {
    console.log(chalk.red(result.message));
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log(chalk.yellow("  (none)"));
    } else {
      accounts.forEach((a) => console.log(`  - ${a.name}`));
    }
    return;
  }

  console.log(chalk.green(`✓ ${result.message}`));
  if (result.meta) {
    console.log(chalk.dim(`  Email: ${result.meta.email}`));
    console.log(chalk.dim(`  Plan: ${result.meta.plan}`));
  }
}

export async function cmdMode(name?: string): Promise<void> {
  if (!name) {
    const selection = getCurrentSelection();
    const currentMode = selection.kind === "provider" ? selection.name : "account";
    console.log(chalk.green(`Current mode: ${getModeDisplayName(currentMode)}`));

    const modes = Array.from(new Set([...listModes(), ...(selection.kind === "provider" ? [selection.name] : [])]));
    console.log(chalk.bold("\nAvailable modes:\n"));
    modes.forEach((modeName) => {
      const tag = modeName === currentMode ? chalk.green(" [current]") : "";
      const kindLabel = modeName === "account" ? chalk.dim("account mode") : chalk.cyan("provider mode");
      console.log(`  ${getModeDisplayName(modeName)}  ${kindLabel}${tag}`);
    });
    console.log();
    return;
  }

  const resolvedName = resolveModeNameInput(name);

  if (resolvedName !== "account" && !readProviderProfile(resolvedName)) {
    const created = await ensureProviderProfile(resolvedName);
    if (!created) {
      console.log(chalk.red(`Failed to create provider "${resolvedName}".`));
      return;
    }
  }

  const result = switchMode(resolvedName);
  console.log(result.success ? chalk.green(`✓ ${result.message}`) : chalk.red(result.message));
}

function formatResetTime(resetsAt: Date | null): string {
  if (!resetsAt) return "";
  const secs = Math.floor((resetsAt.getTime() - Date.now()) / 1000);
  if (secs <= 0) return "";
  const minutes = Math.floor(secs / 60);
  if (minutes >= 60) return `resets in ${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `resets in ${minutes}m`;
}

function colorPercent(pct: number): string {
  const rounded = Math.round(pct);
  if (rounded >= 70) return chalk.red(`${rounded}%`);
  if (rounded >= 50) return chalk.yellow(`${rounded}%`);
  return chalk.green(`${rounded}%`);
}

function formatBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  if (pct >= 70) return chalk.red(bar);
  if (pct >= 50) return chalk.yellow(bar);
  return chalk.green(bar);
}

function windowLabel(w: WindowInfo): string {
  if (w.windowSeconds == null) return "quota";
  const hours = w.windowSeconds / 3600;
  if (hours <= 5) return "5h quota";
  if (hours <= 24) return `${Math.round(hours)}h quota`;
  const days = Math.round(hours / 24);
  return `${days}d quota`;
}

function printWindowLine(label: string, w: WindowInfo): void {
  const used = w.usedPercent;
  const remaining = Math.max(0, 100 - used);
  const reset = formatResetTime(w.resetsAt);
  const padded = label.padEnd(10);
  console.log(
    `  ${padded}${formatBar(used)} ${colorPercent(used)} used / ${chalk.bold(`${Math.round(remaining)}%`)} remaining`
  );
  if (reset) {
    console.log(`  ${" ".repeat(10)}${chalk.dim(reset)}`);
  }
}

export async function cmdQuota(name?: string): Promise<void> {
  let result: Awaited<ReturnType<typeof queryQuota>>;
  try {
    result = await queryQuota(name);
  } catch (err) {
    const targetLabel = getQuotaTargetLabel(name);
    console.log(chalk.red(`Quota refresh failed for "${targetLabel}": ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  if (result.kind === "unsupported") {
    console.log(chalk.yellow(result.message));
    return;
  }

  if (result.kind === "not_found") {
    console.log(chalk.red(result.message));
    return;
  }

  const { displayName, info } = result;
  const auth = readQuotaDisplayAuth(name);

  console.log(chalk.bold(`\nAccount quota - ${displayName}\n`));
  console.log(`  Email: ${info.email}`);
  console.log(`  Plan:  ${chalk.cyan(info.plan)}`);
  printTokenStatusLines(auth);

  if (info.primaryWindow || info.secondaryWindow) console.log();

  if (info.primaryWindow) printWindowLine(windowLabel(info.primaryWindow), info.primaryWindow);
  if (info.secondaryWindow) printWindowLine(windowLabel(info.secondaryWindow), info.secondaryWindow);

  if (info.additional.length > 0) {
    console.log();
    for (const item of info.additional) {
      if (item.primary && item.primary.usedPercent > 0) {
        printWindowLine(`${item.name} (${windowLabel(item.primary)})`, item.primary);
      }
      if (item.secondary && item.secondary.usedPercent > 0) {
        printWindowLine(`${item.name} (${windowLabel(item.secondary)})`, item.secondary);
      }
    }
  }

  if (info.codeReview && info.codeReview.usedPercent > 0) {
    printWindowLine("code review", info.codeReview);
  }

  if (info.credits) {
    console.log(`\n  ${chalk.green("✓")} Extra purchased credits available`);
  }

  if (!info.primaryWindow && !info.secondaryWindow) {
    console.log(
      chalk.yellow(`\n  ${info.unavailableReason?.message ?? "Unable to load quota information (API request failed or token expired)"}`)
    );
  }

  console.log();
}

export function cmdCurrent(): void {
  const selection = getCurrentSelection();

  if (selection.kind === "provider") {
    console.log(chalk.green(`Current mode: ${getModeDisplayName(selection.name)}`));
    console.log(chalk.dim("  Quota and token refresh are unavailable in provider mode."));
    return;
  }

  const { name, meta } = getCurrentAccount();

  if (!name) {
    console.log(chalk.yellow("No saved account matches the current auth. You may be using an unsaved login or a cleared account mode."));
    if (meta) {
      console.log(chalk.dim(`  Current auth.json email: ${meta.email}`));
    }
    return;
  }

  console.log(chalk.green(`Current account: ${name}`));
  if (meta) {
    console.log(chalk.dim(`  Email: ${meta.email}`));
    console.log(chalk.dim(`  Plan: ${meta.plan}`));
  }
}

export async function cmdRefresh(name?: string): Promise<void> {
  console.log(chalk.cyan("Refreshing token..."));
  const result = await refreshAccount(name);

  if (!result.success) {
    console.log(result.unsupported ? chalk.yellow(result.message) : chalk.red(result.message));
    if (!result.unsupported) {
      console.log(chalk.yellow("Try logging in again: codex-account-switch add <name>"));
    }
    return;
  }

  console.log(chalk.green(`✓ ${result.message}`));
  if (result.meta) {
    console.log(chalk.dim(`  Email: ${result.meta.email}`));
  }
  if (result.lastRefresh) {
    console.log(chalk.dim(`  Time: ${result.lastRefresh}`));
  }
  printTokenStatusLines(readQuotaDisplayAuth(name));
}

export function cmdExport(file?: string, names?: string[]): void {
  const outputPath = file ?? "codex-accounts.json";
  const data = exportAccounts(names);

  if (data.accounts.length === 0) {
    console.log(chalk.yellow("No accounts available to export."));
    return;
  }

  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf-8");
  console.log(chalk.green(`✓ Exported ${data.accounts.length} account(s) to ${outputPath}`));
  data.accounts.forEach((a) => console.log(chalk.dim(`  - ${a.name}`)));
}

export function cmdImport(file: string, overwrite?: boolean): void {
  if (!fs.existsSync(file)) {
    console.log(chalk.red(`File does not exist: ${file}`));
    return;
  }

  let data: ExportData;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf-8")) as ExportData;
  } catch {
    console.log(chalk.red("Invalid file format: unable to parse JSON."));
    return;
  }

  if (data.version !== 1 || !Array.isArray(data.accounts)) {
    console.log(chalk.red("Unsupported export file format."));
    return;
  }

  const result = importAccounts(data, overwrite);

  if (result.imported.length > 0) {
    console.log(chalk.green(`✓ Imported ${result.imported.length} account(s):`));
    result.imported.forEach((n) => console.log(chalk.dim(`  - ${n}`)));
  }
  if (result.skipped.length > 0) {
    console.log(chalk.yellow(`Skipped ${result.skipped.length} existing account(s) (use --overwrite to replace them):`));
    result.skipped.forEach((n) => console.log(chalk.dim(`  - ${n}`)));
  }
  if (result.errors.length > 0) {
    console.log(chalk.red("Import failed:"));
    result.errors.forEach((e) => console.log(chalk.dim(`  - ${e}`)));
  }
}
