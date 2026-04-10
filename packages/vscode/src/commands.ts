import * as vscode from "vscode";
import * as fs from "fs";
import {
  exportAccounts,
  importAccounts,
  ExportData,
  ProviderProfile,
  getModeDisplayName,
  switchMode,
} from "@codex-account-switch/core";
import { AccountDetailItem, AccountTreeProvider, AccountTreeItem, AccountTreeNode } from "./accountTree";
import { ProviderDetailItem, ProviderTreeItem, ProviderTreeProvider } from "./providerTree";
import { StatusBarManager } from "./statusBar";
import { buildCompletedProviderProfile } from "./providerProfile";
import { RefreshCoordinator } from "./refreshCoordinator";
import { logError, logInfo, logWarn, showLogs, startPerformanceLog } from "./log";
import {
  ensureSavedAuthPassphrase,
  forgetSavedAuthPassphrase,
  promptAndStoreSavedAuthPassphrase,
  unlockSavedAuthStorage,
} from "./storagePassword";
import {
  buildProviderProfileForSource,
  ensureCurrentDeviceRegistered,
  getCurrentDeviceName,
  getSavedAccountEntry,
  getSavedCurrentSelection,
  getSavedProviderEntry,
  listSyncedDevices,
  listSavedAccounts,
  listSavedProviders,
  moveSavedAccountEntry,
  moveSavedProviderEntry,
  refreshSavedAccountEntry,
  renameSavedAccountEntry,
  removeSavedAccountEntry,
  saveCurrentAuthAsAccount,
  saveProviderProfileToSource,
  SavedAccountInfo,
  SavedProviderInfo,
  setAutoRefreshDeviceName,
  StorageSource,
  switchToSavedProviderEntry,
  useSavedAccountEntry,
} from "./savedEntries";
const LOG_PREFIX = "[codex-account-switch:vscode:commands]";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logCommandInfo(command: string, event: string, details: Record<string, unknown> = {}): void {
  logInfo(LOG_PREFIX, `${command}-${event}`, details);
}

function logCommandWarn(command: string, event: string, details: Record<string, unknown> = {}): void {
  logWarn(LOG_PREFIX, `${command}-${event}`, details);
}

function logCommandError(command: string, event: string, details: Record<string, unknown> = {}): void {
  logError(LOG_PREFIX, `${command}-${event}`, details);
}

function getUseDeviceAuthForLogin(): boolean {
  return vscode.workspace
    .getConfiguration("codex-account-switch")
    .get<boolean>("useDeviceAuthForLogin", false);
}

function getCodexLoginCommand(useDeviceAuth = getUseDeviceAuthForLogin()): string {
  return useDeviceAuth ? "codex login --device-auth" : "codex login";
}

function refreshViews(refreshCoordinator: RefreshCoordinator) {
  const perf = startPerformanceLog(LOG_PREFIX, "command-support:refreshViews");
  refreshCoordinator.refreshViews();
  perf.finish();
}

async function showSyncConflictWarning(message: string) {
  const action = await vscode.window.showWarningMessage(message, "Refresh List", "Open Settings JSON");
  if (action === "Refresh List") {
    await vscode.commands.executeCommand("codex-account-switch.refreshList");
    return;
  }
  if (action === "Open Settings JSON") {
    await vscode.commands.executeCommand("workbench.action.openSettingsJson");
  }
}

function refreshAll(refreshCoordinator: RefreshCoordinator, targetIds?: Iterable<string>) {
  const normalizedTargetIds = targetIds ? [...targetIds] : undefined;
  const perf = startPerformanceLog(LOG_PREFIX, "command-support:refreshAll", {
    targetCount: normalizedTargetIds?.length ?? null,
  });
  refreshCoordinator.refreshViews();
  perf.mark("refresh-views");
  refreshCoordinator.scheduleQuotaRefresh(normalizedTargetIds);
  perf.finish();
}

async function refreshTokenAndQuota(
  accountTree: AccountTreeProvider,
  statusBar: StatusBarManager,
  accountId?: string
) {
  const perf = startPerformanceLog(LOG_PREFIX, "command-support:refreshTokenAndQuota", {
    accountId: accountId ?? null,
  });
  accountTree.refresh();
  perf.mark("account-tree-refresh");
  await Promise.all([accountTree.refreshQuota(accountId ? [accountId] : undefined), statusBar.refreshNow()]);
  perf.finish();
}

async function runTimedCommand<T>(
  operation: string,
  action: (perf: ReturnType<typeof startPerformanceLog>) => Promise<T>,
  details: Record<string, unknown> = {},
): Promise<T> {
  const perf = startPerformanceLog(LOG_PREFIX, `command:${operation}`, details);
  try {
    const result = await action(perf);
    perf.finish();
    return result;
  } catch (error) {
    perf.fail(error);
    throw error;
  }
}

function getReloadBehavior(): "never" | "prompt" | "always" {
  return vscode.workspace
    .getConfiguration("codex-account-switch")
    .get<"never" | "prompt" | "always">("reloadWindowAfterSwitch", "prompt");
}

async function reloadWindow() {
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

async function promptReloadWindow(message: string) {
  const action = await vscode.window.showInformationMessage(message, "Reload", "Later");
  if (action === "Reload") {
    await reloadWindow();
  }
}

async function maybeReloadWindowAfterSwitch(label: string, kind: "account" | "mode") {
  const behavior = getReloadBehavior();
  const noun = kind === "account" ? "account" : "mode";
  const displayLabel = kind === "mode" ? getModeDisplayName(label) : label;
  if (behavior === "never") {
    return;
  }

  if (behavior === "always") {
    void vscode.window.showInformationMessage(
      `Switched to ${noun} "${displayLabel}". Reloading the window so the Codex extension can pick up the new configuration.`
    );
    await reloadWindow();
    return;
  }

  await promptReloadWindow(
    `Switched to ${noun} "${displayLabel}". Reload the window if the Codex extension is still using the previous configuration.`
  );
}

async function promptReloadWindowAfterAdd(accountName: string, email?: string) {
  const savedMessage = email
    ? `✓ Account "${accountName}" was saved (${email}).`
    : `✓ Account "${accountName}" was saved.`;
  await promptReloadWindow(
    `${savedMessage} Reload the window if the Codex extension should use this account immediately.`
  );
}

async function runCodexLogin(options?: { useDeviceAuth?: boolean }): Promise<boolean> {
  const useDeviceAuth = options?.useDeviceAuth ?? getUseDeviceAuthForLogin();
  const loginCommand = getCodexLoginCommand(useDeviceAuth);
  logCommandInfo("login", "terminal-started", {
    useDeviceAuth,
    command: loginCommand,
  });
  const terminal = vscode.window.createTerminal("Codex Login");
  terminal.show();
  terminal.sendText(loginCommand);

  const message = useDeviceAuth
    ? `Complete \`${loginCommand}\` in the terminal, then click Done. If Codex says "Enable device code authorization for Codex in ChatGPT Security Settings, then run \\"codex login --device-auth\\" again.", enable it in ChatGPT Security Settings first.`
    : `Complete \`${loginCommand}\` in the terminal, then click Done.`;

  const action = await vscode.window.showInformationMessage(message, "Done", "Cancel");
  logCommandInfo("login", action === "Done" ? "confirmed" : "cancelled", {
    useDeviceAuth,
  });

  return action === "Done";
}

function getSourceLabel(source: StorageSource): string {
  return source === "cloud" ? "cloud" : "local";
}

function formatAccountChoice(account: SavedAccountInfo): string {
  const parts = [account.meta?.email ?? "unknown"];
  if (account.meta?.plan) {
    parts.push(account.meta.plan);
  }
  return `${parts.join(" · ")} · ${getSourceLabel(account.source)}`;
}

function formatProviderChoice(provider: SavedProviderInfo): string {
  const parts = [getSourceLabel(provider.source)];
  if (provider.locked) {
    parts.push("locked");
  } else if (provider.invalid) {
    parts.push("invalid");
  }
  return parts.join(" · ");
}

function resolveAccountFromItem(item?: AccountTreeItem): SavedAccountInfo | undefined {
  const account = item?.account;
  if (!account) {
    return undefined;
  }
  if (account.source === "local" || account.source === "cloud") {
    return account;
  }
  return getSavedAccountEntry(account.name, "local") ?? getSavedAccountEntry(account.name, "cloud") ?? undefined;
}

async function unlockStorageIfNeeded(
  context: vscode.ExtensionContext,
  refreshCoordinator: RefreshCoordinator,
): Promise<boolean> {
  const result = await unlockSavedAuthStorage(context);
  if (result === "cancelled") {
    return false;
  }
  refreshAll(refreshCoordinator);
  return true;
}

async function ensureAccountAvailable(
  context: vscode.ExtensionContext,
  refreshCoordinator: RefreshCoordinator,
  account: SavedAccountInfo,
): Promise<SavedAccountInfo | undefined> {
  if (account.storageState === "ready") {
    return account;
  }

  if (account.storageState === "locked") {
    const unlocked = await unlockStorageIfNeeded(context, refreshCoordinator);
    if (!unlocked) {
      return undefined;
    }

    const refreshed = getSavedAccountEntry(account.name, account.source);
    if (refreshed?.storageState === "ready") {
      return refreshed;
    }

    account = refreshed ?? account;
  }

  vscode.window.showErrorMessage(account.storageMessage ?? `Saved account "${account.name}" is unavailable.`);
  return undefined;
}

async function ensureProviderAvailable(
  context: vscode.ExtensionContext,
  refreshCoordinator: RefreshCoordinator,
  provider: SavedProviderInfo,
): Promise<SavedProviderInfo | undefined> {
  if (!provider.locked) {
    return provider;
  }

  const unlocked = await unlockStorageIfNeeded(context, refreshCoordinator);
  if (!unlocked) {
    return undefined;
  }

  const refreshed = getSavedProviderEntry(provider.name, provider.source);
  if (refreshed && !refreshed.locked) {
    return refreshed;
  }

  vscode.window.showErrorMessage(
    (refreshed ?? provider).storageMessage ?? `Provider "${provider.name}" is unavailable.`
  );
  return undefined;
}

async function pickSavedAccount(item: AccountTreeItem | undefined, placeHolder: string): Promise<SavedAccountInfo | undefined> {
  const existing = resolveAccountFromItem(item);
  if (existing) {
    return existing;
  }

  const accounts = listSavedAccounts();
  if (accounts.length === 0) {
    vscode.window.showWarningMessage("No saved accounts");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    accounts.map((account) => ({
      label: account.isCurrent ? `$(pass-filled) ${account.name}` : account.name,
      description: formatAccountChoice(account),
      account,
    })),
    { placeHolder },
  );

  return picked?.account;
}

async function pickSavedProvider(item: ProviderTreeItem | undefined, placeHolder: string): Promise<SavedProviderInfo | undefined> {
  if (item) {
    return item.provider;
  }

  const providers = listSavedProviders();
  if (providers.length === 0) {
    vscode.window.showWarningMessage("No saved providers");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    providers.map((provider) => ({
      label: provider.isCurrent ? `$(plug) ${getModeDisplayName(provider.name)}` : getModeDisplayName(provider.name),
      description: formatProviderChoice(provider),
      provider,
    })),
    { placeHolder },
  );

  return picked?.provider;
}

function exitProviderModeForLogin(): { previousSelection: ReturnType<typeof getSavedCurrentSelection>; switched: boolean } | null {
  const previousSelection = getSavedCurrentSelection();
  if (previousSelection.kind !== "provider") {
    return { previousSelection, switched: false };
  }

  const switched = switchMode("account");
  if (!switched.success) {
    logCommandWarn("login", "exit-provider-mode-failed", {
      provider: previousSelection.name,
      source: previousSelection.source,
      message: switched.message,
    });
    void vscode.window.showErrorMessage(switched.message);
    return null;
  }

  logCommandInfo("login", "exited-provider-mode", {
    provider: previousSelection.name,
    source: previousSelection.source,
  });
  void vscode.window.showInformationMessage(
    `Exited provider mode "${getModeDisplayName(previousSelection.name)}" before login so Codex can create an account auth.json.`
  );
  return { previousSelection, switched: true };
}

async function restoreProviderModeAfterFailedLogin(previousSelection: ReturnType<typeof getSavedCurrentSelection>, switched: boolean) {
  if (!switched || previousSelection.kind !== "provider") {
    return;
  }

  const restored =
    previousSelection.source === "local"
      ? switchMode(previousSelection.name)
      : await switchToSavedProviderEntry(
          getSavedProviderEntry(previousSelection.name, "cloud") ?? {
            id: `cloud:${previousSelection.name}`,
            name: previousSelection.name,
            source: "cloud",
            isCurrent: false,
            invalid: true,
            locked: false,
            encrypted: false,
            auth: {},
            config: {},
            profile: null,
            syncVersion: null,
            syncUpdatedAt: null,
          },
        );
  if (!restored.success) {
    void vscode.window.showWarningMessage(
      `Restoring mode "${getModeDisplayName(previousSelection.name)}" failed: ${restored.message}`
    );
  }
}

async function promptLoginMethod(
  message: string,
  defaultActionLabel: string
): Promise<"default" | "device-auth" | "cancel"> {
  const action = await vscode.window.showWarningMessage(
    message,
    defaultActionLabel,
    "Use Device Auth",
    "Cancel"
  );

  if (action === defaultActionLabel) {
    return "default";
  }
  if (action === "Use Device Auth") {
    return "device-auth";
  }
  return "cancel";
}

async function pickModeAction(): Promise<
  | { action: "switch"; provider: SavedProviderInfo | null }
  | { action: "create"; source: StorageSource }
  | undefined
> {
  const currentSelection = getSavedCurrentSelection();
  const providers = listSavedProviders();
  const items = [
    {
      label: currentSelection.kind === "account" ? "$(check) Account Mode" : "Account Mode",
      description: "Use saved account auth",
      action: "switch" as const,
      provider: null,
    },
    ...providers.map((provider) => ({
      label:
        currentSelection.kind === "provider"
          && currentSelection.name === provider.name
          && currentSelection.source === provider.source
          ? `$(check) ${getModeDisplayName(provider.name)}`
          : getModeDisplayName(provider.name),
      description: formatProviderChoice(provider),
      action: "switch" as const,
      provider,
    })),
    {
      label: "$(add) New Provider (Local)",
      description: "Create a local provider profile",
      action: "create" as const,
      source: "local" as const,
    },
    {
      label: "$(add) New Provider (Cloud)",
      description: "Create a synced provider profile",
      action: "create" as const,
      source: "cloud" as const,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a mode to switch to",
  });
  if (!picked) {
    return undefined;
  }
  if (picked.action === "create") {
    return { action: "create", source: picked.source };
  }
  return { action: "switch", provider: picked.provider };
}

async function restoreSelectionAfterLogin(
  previousSelection: ReturnType<typeof getSavedCurrentSelection>,
  targetAccount: SavedAccountInfo,
) {
  if (
    previousSelection.kind === "account"
    && previousSelection.name === targetAccount.name
    && previousSelection.source === targetAccount.source
  ) {
    return { restored: false, restoredLabel: undefined as string | undefined };
  }

  if (previousSelection.kind === "account") {
    const previousAccount = getSavedAccountEntry(previousSelection.name, previousSelection.source);
    if (!previousAccount) {
      return { restored: false, restoredLabel: undefined as string | undefined };
    }
    const restored = await useSavedAccountEntry(previousAccount);
    if (!restored.success) {
      vscode.window.showWarningMessage(
        `Saved account "${targetAccount.name}" was updated, but restoring account "${previousSelection.name}" failed: ${restored.message}`,
      );
      return { restored: false, restoredLabel: undefined as string | undefined };
    }
    return { restored: true, restoredLabel: `${previousSelection.name} (${getSourceLabel(previousSelection.source)})` };
  }

  if (previousSelection.kind === "provider") {
    const previousProvider = getSavedProviderEntry(previousSelection.name, previousSelection.source);
    if (!previousProvider) {
      return { restored: false, restoredLabel: undefined as string | undefined };
    }
    const restored = await switchToSavedProviderEntry(previousProvider);
    if (!restored.success) {
      vscode.window.showWarningMessage(
        `Saved account "${targetAccount.name}" was updated, but restoring mode "${getModeDisplayName(previousSelection.name)}" failed: ${restored.message}`,
      );
      return { restored: false, restoredLabel: undefined as string | undefined };
    }
    return {
      restored: true,
      restoredLabel: getModeDisplayName(previousSelection.name),
    };
  }

  return { restored: false, restoredLabel: undefined as string | undefined };
}

function refreshFailureSupportsRelogin(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("refresh_token_reused") || normalized.includes("sign in again");
}

async function promptForAccountRename(account: SavedAccountInfo): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: `Rename account "${account.name}"`,
    placeHolder: "Enter a new account name",
    value: account.name,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Name is required";
      }
      if (trimmed === account.name) {
        return "Enter a different name";
      }
      if (listSavedAccounts().some((candidate) => candidate.source === account.source && candidate.name === trimmed)) {
        return `Account "${trimmed}" already exists`;
      }
      return null;
    },
  });
}

async function askRequiredValue(options: {
  prompt: string;
  placeHolder: string;
  value?: string;
  password?: boolean;
}): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: options.prompt,
    placeHolder: options.placeHolder,
    value: options.value,
    password: options.password,
    validateInput: (value) => (value.trim() ? null : "Value is required"),
  });
}

async function ensureProviderProfile(name: string, source: StorageSource): Promise<ProviderProfile | null> {
  return ensureProviderProfileWithExpectedVersion(name, source);
}

async function ensureProviderProfileWithExpectedVersion(
  name: string,
  source: StorageSource,
  expectedEntryVersion?: number | null,
  expectedUpdatedAt?: string | null,
): Promise<ProviderProfile | null> {
  const defaults = await buildProviderProfileForSource(name, source);
  const draft = {
    auth: defaults.auth as Record<string, unknown>,
    config: defaults.config as unknown as Record<string, unknown>,
    exists: true,
    invalid: false,
  };

  const apiKey = await askRequiredValue({
    prompt: `Configure provider "${name}": OPENAI_API_KEY`,
    placeHolder: "sk-...",
    value: typeof defaults.auth.OPENAI_API_KEY === "string" ? defaults.auth.OPENAI_API_KEY : undefined,
    password: true,
  });
  if (!apiKey) {
    return null;
  }

  const baseUrl = await askRequiredValue({
    prompt: `Configure provider "${name}": base_url`,
    placeHolder: "https://api.example.com/v1",
    value: defaults.config.base_url || undefined,
  });
  if (!baseUrl) {
    return null;
  }

  const wireApi = await askRequiredValue({
    prompt: `Configure provider "${name}": wire_api`,
    placeHolder: defaults.config.wire_api,
    value: defaults.config.wire_api,
  });
  if (!wireApi) {
    return null;
  }

  const profile = buildCompletedProviderProfile(name, defaults, draft, {
    apiKey,
    baseUrl,
    wireApi,
  });

  const saveResult = await saveProviderProfileToSource(profile, source, {
    expectedEntryVersion,
    expectedUpdatedAt,
  });
  if (!saveResult.success) {
    if (saveResult.conflict) {
      await showSyncConflictWarning(saveResult.message);
    } else {
      vscode.window.showErrorMessage(saveResult.message);
    }
    return null;
  }
  vscode.window.showInformationMessage(
    `${draft.exists ? "Updated" : "Created"} provider profile for "${name}" in ${getSourceLabel(source)} storage.`,
  );
  return profile;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  accountTree: AccountTreeProvider,
  providerTree: ProviderTreeProvider,
  statusBar: StatusBarManager,
  accountTreeView: vscode.TreeView<AccountTreeNode>,
  refreshCoordinator: RefreshCoordinator,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("codex-account-switch.addAccount", async () => {
      await runTimedCommand("addAccount", async (perf) => {
        const name = await vscode.window.showInputBox({
          prompt: "Enter an account name",
          placeHolder: "For example: work, personal",
          validateInput: (v) => (v.trim() ? null : "Name is required"),
        });
        if (!name) return;

        const trimmedName = name.trim();
        const target: StorageSource = vscode.workspace
          .getConfiguration("codex-account-switch")
          .get<StorageSource>("defaultSaveTarget", "local");
        perf.mark("collect-account-name", {
          account: trimmedName,
          target,
        });
        logCommandInfo("add-account", "started", {
          account: trimmedName,
          target,
        });
        if (target === "cloud" && !(await ensureSavedAuthPassphrase(context))) {
          logCommandWarn("add-account", "missing-storage-password", {
            account: trimmedName,
          });
          vscode.window.showWarningMessage("Cloud storage requires a local storage password.");
          return;
        }

        const existing = getSavedAccountEntry(trimmedName, target);
        perf.mark("lookup-existing-account", {
          exists: Boolean(existing),
        });
        if (existing) {
          if (existing.storageState !== "ready") {
            logCommandWarn("add-account", "existing-account-unavailable", {
              account: trimmedName,
              target,
              storageState: existing.storageState,
              message: existing.storageMessage,
            });
            vscode.window.showErrorMessage(existing.storageMessage ?? `Saved account "${trimmedName}" is unavailable.`);
            return;
          }

          const refreshResult = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Refreshing token for "${trimmedName}"...` },
            async () => refreshSavedAccountEntry(existing),
          );
          perf.mark("refresh-existing-account", {
            success: refreshResult.success,
          });
          if (refreshResult.success) {
            logCommandInfo("add-account", "existing-account-refreshed", {
              account: trimmedName,
              target,
            });
            await refreshTokenAndQuota(accountTree, statusBar, existing.id);
            vscode.window.showInformationMessage(`Account "${trimmedName}" already exists in ${getSourceLabel(target)} storage. Token refreshed.`);
            refreshAll(refreshCoordinator);
            return;
          }

          logCommandWarn("add-account", "existing-account-refresh-failed", {
            account: trimmedName,
            target,
            message: refreshResult.message,
          });
          const overwriteMethod = await promptLoginMethod(
            `Account "${trimmedName}" already exists in ${getSourceLabel(target)} storage and token refresh failed. Start login and overwrite it?`,
            "Login and overwrite",
          );
          if (overwriteMethod === "cancel") {
            logCommandInfo("add-account", "overwrite-cancelled", {
              account: trimmedName,
              target,
            });
            return;
          }

          const loginState = exitProviderModeForLogin();
          if (!loginState) return;

          const completed = await runCodexLogin({ useDeviceAuth: overwriteMethod === "device-auth" });
          if (!completed) {
            logCommandInfo("add-account", "login-cancelled", {
              account: trimmedName,
              target,
              overwrite: true,
            });
            await restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
            return;
          }

          const result = await saveCurrentAuthAsAccount(trimmedName, target, {
            expectedEntryVersion: existing.syncVersion,
            expectedUpdatedAt: existing.syncUpdatedAt,
          });
          if (result.success) {
            logCommandInfo("add-account", "saved", {
              account: trimmedName,
              target,
              overwrite: true,
              email: result.meta?.email ?? null,
            });
            refreshAll(refreshCoordinator);
            await promptReloadWindowAfterAdd(trimmedName, result.meta?.email);
          } else {
            logCommandWarn("add-account", "save-failed", {
              account: trimmedName,
              target,
              overwrite: true,
              conflict: result.conflict ?? false,
              message: result.message,
            });
            await restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
            if (result.conflict) {
              await showSyncConflictWarning(result.message);
            } else {
              vscode.window.showErrorMessage(result.message);
            }
          }
          return;
        }

        const loginMethod = await promptLoginMethod(
          `Add account "${trimmedName}" to ${getSourceLabel(target)} storage. Use device auth for this login?`,
          "Login",
        );
        if (loginMethod === "cancel") {
          logCommandInfo("add-account", "cancelled-before-login", {
            account: trimmedName,
            target,
          });
          return;
        }

        const loginState = exitProviderModeForLogin();
        if (!loginState) return;

        const completed = await runCodexLogin({ useDeviceAuth: loginMethod === "device-auth" });
        if (!completed) {
          logCommandInfo("add-account", "login-cancelled", {
            account: trimmedName,
            target,
            overwrite: false,
          });
          await restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
          return;
        }

        const result = await saveCurrentAuthAsAccount(trimmedName, target);
        if (result.success) {
          logCommandInfo("add-account", "saved", {
            account: trimmedName,
            target,
            overwrite: false,
            email: result.meta?.email ?? null,
          });
          refreshAll(refreshCoordinator);
          await promptReloadWindowAfterAdd(trimmedName, result.meta?.email);
        } else {
          logCommandWarn("add-account", "save-failed", {
            account: trimmedName,
            target,
            overwrite: false,
            conflict: result.conflict ?? false,
            message: result.message,
          });
          await restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
          if (result.conflict) {
            await showSyncConflictWarning(result.message);
          } else {
            vscode.window.showErrorMessage(result.message);
          }
        }
      });
    }),

    vscode.commands.registerCommand(
      "codex-account-switch.reloginAccount",
      async (item?: AccountTreeItem) => {
        await runTimedCommand("reloginAccount", async (perf) => {
          let account = await pickSavedAccount(item, "Select an account to re-login");
          if (!account) return;
          account = await ensureAccountAvailable(context, refreshCoordinator, account);
          if (!account) {
            return;
          }
          perf.mark("resolve-account", {
            account: account.name,
            source: account.source,
          });
          logCommandInfo("relogin-account", "started", {
            account: account.name,
            source: account.source,
          });

          const loginMethod = await promptLoginMethod(
            `Re-login account "${account.name}" and overwrite its saved auth in ${getSourceLabel(account.source)} storage?`,
            "Re-login",
          );
          if (loginMethod === "cancel") {
            logCommandInfo("relogin-account", "cancelled-before-login", {
              account: account.name,
              source: account.source,
            });
            return;
          }

          const loginState = exitProviderModeForLogin();
          if (!loginState) return;

          const previousSelection = loginState.previousSelection;
          const completed = await runCodexLogin({ useDeviceAuth: loginMethod === "device-auth" });
          if (!completed) {
            logCommandInfo("relogin-account", "login-cancelled", {
              account: account.name,
              source: account.source,
            });
            await restoreProviderModeAfterFailedLogin(previousSelection, loginState.switched);
            return;
          }

          const result = await saveCurrentAuthAsAccount(account.name, account.source, {
            expectedEntryVersion: account.syncVersion,
            expectedUpdatedAt: account.syncUpdatedAt,
          });
          perf.mark("save-current-auth-as-account", {
            success: result.success,
            conflict: result.conflict ?? false,
          });
          const updatedAccount = getSavedAccountEntry(account.name, account.source) ?? account;
          const shouldRestore =
            previousSelection.kind !== "unknown" &&
            !(
              previousSelection.kind === "account"
              && previousSelection.name === account.name
              && previousSelection.source === account.source
            );
          const restoreResult = shouldRestore
            ? await restoreSelectionAfterLogin(previousSelection, updatedAccount)
            : { restored: false, restoredLabel: undefined as string | undefined };

          if (result.success) {
            logCommandInfo("relogin-account", "saved", {
              account: account.name,
              source: account.source,
              email: result.meta?.email ?? null,
              restoredSelection: restoreResult.restoredLabel ?? null,
            });
            refreshAll(refreshCoordinator);
            if (restoreResult.restored) {
              const savedMessage = result.meta?.email
                ? `✓ Account "${account.name}" was updated (${result.meta.email}). Active selection stayed on "${restoreResult.restoredLabel}".`
                : `✓ Account "${account.name}" was updated. Active selection stayed on "${restoreResult.restoredLabel}".`;
              vscode.window.showInformationMessage(savedMessage);
            } else {
              await promptReloadWindowAfterAdd(account.name, result.meta?.email);
            }
          } else {
            logCommandWarn("relogin-account", "save-failed", {
              account: account.name,
              source: account.source,
              conflict: result.conflict ?? false,
              message: result.message,
            });
            if (restoreResult.restored) {
              refreshAll(refreshCoordinator);
            }
            if (result.conflict) {
              await showSyncConflictWarning(result.message);
            } else {
              vscode.window.showErrorMessage(result.message);
            }
          }
        });
      }
    ),

    vscode.commands.registerCommand(
      "codex-account-switch.renameAccount",
      async (item?: AccountTreeItem) => {
        await runTimedCommand("renameAccount", async (perf) => {
          const account = await pickSavedAccount(item, "Select an account to rename");
          if (!account) return;
          perf.mark("pick-saved-account", {
            account: account.name,
            source: account.source,
          });

          const newName = await promptForAccountRename(account);
          if (!newName) return;
          perf.mark("prompt-for-rename", {
            account: account.name,
          });

          const result = await renameSavedAccountEntry(account, newName);
          perf.mark("rename-saved-account-entry", {
            success: result.success,
            conflict: result.conflict ?? false,
          });
          if (result.success) {
            vscode.window.showInformationMessage(`✓ ${result.message}`);
            refreshAll(refreshCoordinator);
          } else if (result.conflict) {
            await showSyncConflictWarning(result.message);
          } else {
            vscode.window.showErrorMessage(result.message);
          }
        });
      }
    ),

    vscode.commands.registerCommand(
      "codex-account-switch.removeAccount",
      async (item?: AccountTreeItem) => {
        await runTimedCommand("removeAccount", async (perf) => {
          const account = await pickSavedAccount(item, "Select an account to remove");
          if (!account) return;
          perf.mark("pick-saved-account", {
            account: account.name,
            source: account.source,
          });

          const confirm = await vscode.window.showWarningMessage(
            `Remove account "${account.name}" from ${getSourceLabel(account.source)} storage?`,
            "Remove",
            "Cancel",
          );
          if (confirm !== "Remove") return;
          perf.mark("confirm-remove");

          const result = await removeSavedAccountEntry(account);
          perf.mark("remove-saved-account-entry", {
            success: result.success,
            conflict: result.conflict ?? false,
          });
          if (result.success) {
            vscode.window.showInformationMessage(`✓ ${result.message}`);
            refreshAll(refreshCoordinator);
          } else if (result.conflict) {
            await showSyncConflictWarning(result.message);
          } else {
            vscode.window.showErrorMessage(result.message);
          }
        });
      }
    ),

    vscode.commands.registerCommand(
      "codex-account-switch.useAccount",
      async (item?: AccountTreeItem) => {
        await runTimedCommand("useAccount", async (perf) => {
          let account = await pickSavedAccount(item, "Select an account to switch to");
          if (!account) return;
          perf.mark("pick-saved-account", {
            account: account.name,
            source: account.source,
          });
          account = await ensureAccountAvailable(context, refreshCoordinator, account);
          if (!account) {
            return;
          }
          perf.mark("ensure-account-available", {
            account: account.name,
            source: account.source,
          });
          logCommandInfo("use-account", "started", {
            account: account.name,
            source: account.source,
          });

          const result = await useSavedAccountEntry(account);
          perf.mark("use-saved-account-entry", {
            success: result.success,
            conflict: result.conflict ?? false,
          });
          if (result.success) {
            logCommandInfo("use-account", "switched", {
              account: account.name,
              source: account.source,
              email: result.meta?.email ?? null,
            });
            vscode.window.showInformationMessage(
              `✓ ${result.message} (${result.meta?.email ?? "unknown"})`
            );
            refreshViews(refreshCoordinator);
            perf.mark("refresh-views");
            refreshCoordinator.scheduleQuotaRefresh([account.id]);
            perf.mark("schedule-quota-refresh");
            await maybeReloadWindowAfterSwitch(account.name, "account");
          } else {
            logCommandWarn("use-account", "switch-failed", {
              account: account.name,
              source: account.source,
              conflict: result.conflict ?? false,
              message: result.message,
            });
            if (result.conflict) {
              await showSyncConflictWarning(result.message);
            } else {
              vscode.window.showErrorMessage(result.message);
            }
          }
        });
      }
    ),

    vscode.commands.registerCommand("codex-account-switch.switchMode", async () => {
      const picked = await pickModeAction();
      if (!picked) {
        logCommandInfo("switch-mode", "cancelled");
        return;
      }

      if (picked.action === "create") {
        logCommandInfo("switch-mode", "create-started", {
          source: picked.source,
        });
        if (picked.source === "cloud" && !(await ensureSavedAuthPassphrase(context))) {
          logCommandWarn("switch-mode", "missing-storage-password", {
            source: picked.source,
          });
          vscode.window.showWarningMessage("Cloud storage requires a local storage password.");
          return;
        }
        const newName = await vscode.window.showInputBox({
          prompt: "Enter a name for the new provider",
          placeHolder: "e.g. my-proxy, local-api",
          validateInput: (v) => {
            const trimmed = v.trim();
            if (!trimmed) return "Name is required";
            if (trimmed === "account") return '"account" is reserved';
            if (!/^[a-zA-Z0-9_\-]+$/.test(trimmed)) return "Only letters, numbers, hyphens and underscores are allowed";
            return null;
          },
        });
        if (!newName) {
          return;
        }
        const targetName = newName.trim();
        const created = await ensureProviderProfileWithExpectedVersion(targetName, picked.source);
        if (!created) {
          return;
        }
        const provider = getSavedProviderEntry(targetName, picked.source);
        if (!provider) {
          logCommandError("switch-mode", "provider-missing-after-save", {
            provider: targetName,
            source: picked.source,
          });
          vscode.window.showErrorMessage(`Provider "${targetName}" was not found after saving.`);
          return;
        }
        const result = await switchToSavedProviderEntry(provider);
        if (!result.success) {
          logCommandWarn("switch-mode", "create-switch-failed", {
            provider: targetName,
            source: picked.source,
            conflict: result.conflict ?? false,
            message: result.message,
          });
          if (result.conflict) {
            await showSyncConflictWarning(result.message);
          } else {
            vscode.window.showErrorMessage(result.message);
          }
          return;
        }
        logCommandInfo("switch-mode", "create-switched", {
          provider: targetName,
          source: picked.source,
        });
        vscode.window.showInformationMessage(`✓ ${result.message}`);
        refreshAll(refreshCoordinator);
        await maybeReloadWindowAfterSwitch(targetName, "mode");
        return;
      }

      if (!picked.provider) {
        const result = switchMode("account");
        if (!result.success) {
          logCommandWarn("switch-mode", "account-mode-failed", {
            message: result.message,
          });
          vscode.window.showErrorMessage(result.message);
          return;
        }
        logCommandInfo("switch-mode", "account-mode-switched");
        vscode.window.showInformationMessage(`✓ ${result.message}`);
        refreshAll(refreshCoordinator);
        await maybeReloadWindowAfterSwitch("account", "mode");
        return;
      }

      if (picked.provider.locked) {
        const provider = await ensureProviderAvailable(context, refreshCoordinator, picked.provider);
        if (!provider) {
          return;
        }
        picked.provider = provider;
      }

      if (picked.provider.locked) {
        return;
      }

      if (picked.provider.invalid || !picked.provider.profile) {
        const created = await ensureProviderProfileWithExpectedVersion(
          picked.provider.name,
          picked.provider.source,
          picked.provider.syncVersion,
          picked.provider.syncUpdatedAt,
        );
        if (!created) {
          return;
        }
      }

      const provider = getSavedProviderEntry(picked.provider.name, picked.provider.source);
      if (!provider) {
        logCommandError("switch-mode", "provider-unavailable", {
          provider: picked.provider.name,
          source: picked.provider.source,
        });
        vscode.window.showErrorMessage(`Provider "${picked.provider.name}" is unavailable.`);
        return;
      }

      const result = await switchToSavedProviderEntry(provider);
      if (!result.success) {
        logCommandWarn("switch-mode", "provider-switch-failed", {
          provider: provider.name,
          source: provider.source,
          conflict: result.conflict ?? false,
          message: result.message,
        });
        if (result.conflict) {
          await showSyncConflictWarning(result.message);
        } else {
          vscode.window.showErrorMessage(result.message);
        }
        return;
      }

      logCommandInfo("switch-mode", "provider-switched", {
        provider: provider.name,
        source: provider.source,
      });
      vscode.window.showInformationMessage(`✓ ${result.message}`);
      refreshAll(refreshCoordinator);
      await maybeReloadWindowAfterSwitch(provider.name, "mode");
    }),

    vscode.commands.registerCommand(
      "codex-account-switch.refreshToken",
      async (item?: AccountTreeItem) => {
        await runTimedCommand("refreshToken", async (perf) => {
          let account = await pickSavedAccount(item, "Select an account to refresh");
          if (!account) return;
          perf.mark("pick-saved-account", {
            account: account.name,
            source: account.source,
          });
          account = await ensureAccountAvailable(context, refreshCoordinator, account);
          if (!account) {
            return;
          }
          perf.mark("ensure-account-available", {
            account: account.name,
            source: account.source,
          });
          logCommandInfo("refresh-token", "started", {
            account: account.name,
            source: account.source,
          });

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Refreshing token and quota..." },
            async () => {
              let result;
              try {
                result = await refreshSavedAccountEntry(account);
                perf.mark("refresh-saved-account-entry", {
                  success: result.success,
                  conflict: result.conflict ?? false,
                });
              } catch (error) {
                logWarn(LOG_PREFIX, "refresh-token-command-failed", {
                  account: account.id,
                  error: toErrorMessage(error),
                });
                vscode.window.showErrorMessage(
                  `Token refresh failed for "${account.name}": ${toErrorMessage(error)}`,
                );
                perf.mark("refresh-saved-account-entry-failed");
                return;
              }
              if (result.success) {
                try {
                  await refreshTokenAndQuota(accountTree, statusBar, account.id);
                  perf.mark("refresh-token-and-quota");
                } catch (error) {
                  logWarn(LOG_PREFIX, "refresh-token-quota-followup-failed", {
                    account: account.id,
                    error: toErrorMessage(error),
                  });
                  vscode.window.showWarningMessage(
                    `Token refreshed for "${account.name}", but quota refresh failed: ${toErrorMessage(error)}`,
                  );
                  perf.mark("refresh-token-and-quota-failed");
                  return;
                }
                logCommandInfo("refresh-token", "succeeded", {
                  account: account.name,
                  source: account.source,
                });
                vscode.window.showInformationMessage(`✓ ${result.message} and quota was refreshed`);
              } else if (result.conflict) {
                logCommandWarn("refresh-token", "conflict", {
                  account: account.name,
                  source: account.source,
                  message: result.message,
                });
                await showSyncConflictWarning(result.message);
              } else if (result.unsupported) {
                logCommandWarn("refresh-token", "unsupported", {
                  account: account.name,
                  source: account.source,
                  message: result.message,
                });
                vscode.window.showWarningMessage(result.message);
              } else if (refreshFailureSupportsRelogin(result.message)) {
                logCommandWarn("refresh-token", "relogin-required", {
                  account: account.name,
                  source: account.source,
                  message: result.message,
                });
                const action = await vscode.window.showErrorMessage(result.message, "Re-login");
                if (action === "Re-login") {
                  await vscode.commands.executeCommand("codex-account-switch.reloginAccount", item);
                }
              } else {
                logCommandWarn("refresh-token", "failed", {
                  account: account.name,
                  source: account.source,
                  message: result.message,
                });
                vscode.window.showErrorMessage(result.message);
              }
            }
          );
        });
      }
    ),

    vscode.commands.registerCommand("codex-account-switch.refresh", async (item?: AccountTreeItem) => {
      await runTimedCommand("refresh", async (perf) => {
        const picked = await vscode.window.showQuickPick(
          [
            {
              label: "Refresh List",
              description: "Reload saved accounts and refresh quota",
              command: "codex-account-switch.refreshList",
            },
            {
              label: "Refresh Token and Quota",
              description: item ? `Refresh "${item.account.name}" token and quota` : "Select an account to refresh",
              command: "codex-account-switch.refreshToken",
            },
            {
              label: "Refresh Quota",
              description: item ? `Refresh "${item.account.name}" quota` : "Refresh quota for all accounts",
              command: "codex-account-switch.refreshQuota",
            },
          ],
          { placeHolder: "Choose what to refresh" },
        );

        if (!picked) {
          logCommandInfo("refresh", "cancelled");
          return;
        }

        perf.mark("pick-refresh-action", {
          command: picked.command,
        });
        logCommandInfo("refresh", "dispatched", {
          command: picked.command,
        });
        await vscode.commands.executeCommand(picked.command, item);
      });
    }),

    vscode.commands.registerCommand("codex-account-switch.moveAccountToCloud", async (item?: AccountTreeItem) => {
      await runTimedCommand("moveAccountToCloud", async (perf) => {
        let account = await pickSavedAccount(item, "Select a local account to move to cloud storage");
        if (!account) return;
        perf.mark("pick-saved-account", {
          account: account.name,
          source: account.source,
        });
        account = await ensureAccountAvailable(context, refreshCoordinator, account);
        if (!account) {
          return;
        }
        perf.mark("ensure-account-available");
        logCommandInfo("move-account-to-cloud", "started", {
          account: account.name,
          source: account.source,
        });
        if (!(await ensureSavedAuthPassphrase(context))) {
          logCommandWarn("move-account-to-cloud", "missing-storage-password", {
            account: account.name,
          });
          vscode.window.showWarningMessage("Cloud storage requires a local storage password.");
          return;
        }
        perf.mark("ensure-saved-auth-passphrase");
        refreshCoordinator.prepareConfigurationRefresh({
          targetIds: [`cloud:${account.name}`],
        });
        perf.mark("prepare-configuration-refresh");
        const result = await moveSavedAccountEntry(account, "cloud");
        perf.mark("move-saved-account-entry", {
          success: result.success,
          conflict: result.conflict ?? false,
        });
        if (!result.success) {
          logCommandWarn("move-account-to-cloud", "failed", {
            account: account.name,
            message: result.message,
            conflict: result.conflict ?? false,
          });
          refreshCoordinator.clearPreparedConfigurationRefresh();
          if (result.conflict) {
            await showSyncConflictWarning(result.message);
          } else {
            vscode.window.showErrorMessage(result.message);
          }
          return;
        }
        logCommandInfo("move-account-to-cloud", "succeeded", {
          account: account.name,
        });
        vscode.window.showInformationMessage(`✓ ${result.message}`);
        refreshViews(refreshCoordinator);
      });
    }),

    vscode.commands.registerCommand("codex-account-switch.moveAccountToLocal", async (item?: AccountTreeItem) => {
      await runTimedCommand("moveAccountToLocal", async (perf) => {
        let account = await pickSavedAccount(item, "Select a cloud account to move to local storage");
        if (!account) return;
        perf.mark("pick-saved-account", {
          account: account.name,
          source: account.source,
        });
        account = await ensureAccountAvailable(context, refreshCoordinator, account);
        if (!account) {
          return;
        }
        perf.mark("ensure-account-available");
        logCommandInfo("move-account-to-local", "started", {
          account: account.name,
          source: account.source,
        });
        refreshCoordinator.prepareConfigurationRefresh({
          targetIds: [`local:${account.name}`],
        });
        perf.mark("prepare-configuration-refresh");
        const result = await moveSavedAccountEntry(account, "local");
        perf.mark("move-saved-account-entry", {
          success: result.success,
          conflict: result.conflict ?? false,
        });
        if (!result.success) {
          logCommandWarn("move-account-to-local", "failed", {
            account: account.name,
            message: result.message,
            conflict: result.conflict ?? false,
          });
          refreshCoordinator.clearPreparedConfigurationRefresh();
          if (result.conflict) {
            await showSyncConflictWarning(result.message);
          } else {
            vscode.window.showErrorMessage(result.message);
          }
          return;
        }
        logCommandInfo("move-account-to-local", "succeeded", {
          account: account.name,
        });
        vscode.window.showInformationMessage(`✓ ${result.message}`);
        refreshViews(refreshCoordinator);
      });
    }),

    vscode.commands.registerCommand("codex-account-switch.moveProviderToCloud", async (item?: ProviderTreeItem) => {
      let provider = await pickSavedProvider(item, "Select a local provider to move to cloud storage");
      if (!provider) return;
      provider = await ensureProviderAvailable(context, refreshCoordinator, provider);
      if (!provider) {
        return;
      }
      logCommandInfo("move-provider-to-cloud", "started", {
        provider: provider.name,
        source: provider.source,
      });
      if (!(await ensureSavedAuthPassphrase(context))) {
        logCommandWarn("move-provider-to-cloud", "missing-storage-password", {
          provider: provider.name,
        });
        vscode.window.showWarningMessage("Cloud storage requires a local storage password.");
        return;
      }
      refreshCoordinator.prepareConfigurationRefresh({ skipQuota: true });
      const result = await moveSavedProviderEntry(provider, "cloud");
      if (!result.success) {
        logCommandWarn("move-provider-to-cloud", "failed", {
          provider: provider.name,
          message: result.message,
          conflict: result.conflict ?? false,
        });
        refreshCoordinator.clearPreparedConfigurationRefresh();
        if (result.conflict) {
          await showSyncConflictWarning(result.message);
        } else {
          vscode.window.showErrorMessage(result.message);
        }
        return;
      }
      logCommandInfo("move-provider-to-cloud", "succeeded", {
        provider: provider.name,
      });
      vscode.window.showInformationMessage(`✓ ${result.message}`);
      refreshViews(refreshCoordinator);
    }),

    vscode.commands.registerCommand("codex-account-switch.moveProviderToLocal", async (item?: ProviderTreeItem) => {
      let provider = await pickSavedProvider(item, "Select a cloud provider to move to local storage");
      if (!provider) return;
      provider = await ensureProviderAvailable(context, refreshCoordinator, provider);
      if (!provider) {
        return;
      }
      logCommandInfo("move-provider-to-local", "started", {
        provider: provider.name,
        source: provider.source,
      });
      refreshCoordinator.prepareConfigurationRefresh({ skipQuota: true });
      const result = await moveSavedProviderEntry(provider, "local");
      if (!result.success) {
        logCommandWarn("move-provider-to-local", "failed", {
          provider: provider.name,
          message: result.message,
          conflict: result.conflict ?? false,
        });
        refreshCoordinator.clearPreparedConfigurationRefresh();
        if (result.conflict) {
          await showSyncConflictWarning(result.message);
        } else {
          vscode.window.showErrorMessage(result.message);
        }
        return;
      }
      logCommandInfo("move-provider-to-local", "succeeded", {
        provider: provider.name,
      });
      vscode.window.showInformationMessage(`✓ ${result.message}`);
      refreshViews(refreshCoordinator);
    }),

    vscode.commands.registerCommand("codex-account-switch.refreshQuota", async (item?: AccountTreeItem) => {
      await runTimedCommand("refreshQuota", async (perf) => {
        const targetId = item?.account?.id;
        logCommandInfo("refresh-quota", "started");
        await Promise.all([
          accountTree.refreshQuota(targetId ? [targetId] : undefined).then(() => {
            perf.mark("account-tree-refreshQuota");
          }).catch((error) => {
            logWarn(LOG_PREFIX, "refresh-quota-command-accountTree-failed", {
              error: toErrorMessage(error),
            });
            throw error;
          }),
          statusBar.refreshNow().then(() => {
            perf.mark("status-bar-refreshNow");
          }).catch((error) => {
            logWarn(LOG_PREFIX, "refresh-quota-command-statusBar-failed", {
              error: toErrorMessage(error),
            });
            throw error;
          }),
        ]);
      });
    }),

    vscode.commands.registerCommand("codex-account-switch.showLogs", () => {
      logCommandInfo("show-logs", "opened");
      showLogs();
    }),

    vscode.commands.registerCommand("codex-account-switch.exportAccounts", async () => {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file("codex-accounts.json"),
        filters: { JSON: ["json"] },
      });
      if (!uri) return;

      let data;
      try {
        data = exportAccounts();
      } catch (error) {
        logCommandError("export-accounts", "failed", {
          path: uri.fsPath,
          error: toErrorMessage(error),
        });
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        return;
      }
      if (data.accounts.length === 0) {
        logCommandWarn("export-accounts", "no-accounts", {
          path: uri.fsPath,
        });
        vscode.window.showWarningMessage("No accounts to export");
        return;
      }

      fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2), "utf-8");
      logCommandInfo("export-accounts", "succeeded", {
        path: uri.fsPath,
        count: data.accounts.length,
      });
      vscode.window.showInformationMessage(
        `✓ Exported ${data.accounts.length} account(s) to ${uri.fsPath}`
      );
    }),

    vscode.commands.registerCommand("codex-account-switch.importAccounts", async () => {
      await runTimedCommand("importAccounts", async (perf) => {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { JSON: ["json"] },
          openLabel: "Import",
        });
        if (!uris || uris.length === 0) return;
        perf.mark("show-open-dialog");

        let data: ExportData;
        try {
          data = JSON.parse(
            fs.readFileSync(uris[0].fsPath, "utf-8")
          ) as ExportData;
        } catch {
          logCommandWarn("import-accounts", "invalid-json", {
            path: uris[0].fsPath,
          });
          vscode.window.showErrorMessage("Invalid file format: unable to parse JSON");
          return;
        }
        perf.mark("read-import-file");

        if (data.version !== 1 || !Array.isArray(data.accounts)) {
          logCommandWarn("import-accounts", "unsupported-format", {
            path: uris[0].fsPath,
            version: data.version,
          });
          vscode.window.showErrorMessage("Unsupported export file format");
          return;
        }

        const overwrite = await vscode.window.showQuickPick(
          [
            { label: "Skip existing accounts", value: false },
            { label: "Overwrite existing accounts", value: true },
          ],
          { placeHolder: "How should duplicate account names be handled?" }
        );
        if (!overwrite) return;
        perf.mark("pick-overwrite-mode");

        const result = importAccounts(data, overwrite.value);
        perf.mark("import-accounts-core", {
          imported: result.imported.length,
          skipped: result.skipped.length,
          failed: result.errors.length,
        });

        const msgs: string[] = [];
        if (result.imported.length > 0) {
          msgs.push(`imported ${result.imported.length}`);
        }
        if (result.skipped.length > 0) {
          msgs.push(`skipped ${result.skipped.length}`);
        }
        if (result.errors.length > 0) {
          msgs.push(`failed ${result.errors.length}`);
        }

        vscode.window.showInformationMessage(`Import finished: ${msgs.join(", ")}`);
        logCommandInfo("import-accounts", "finished", {
          path: uris[0].fsPath,
          overwrite: overwrite.value,
          imported: result.imported.length,
          skipped: result.skipped.length,
          failed: result.errors.length,
        });
        refreshAll(refreshCoordinator);
      });
    }),

    vscode.commands.registerCommand("codex-account-switch.refreshList", async (item?: AccountTreeItem) => {
      await runTimedCommand("refreshList", async () => {
        logCommandInfo("refresh-list", "started");
        refreshAll(refreshCoordinator, item?.account?.id ? [item.account.id] : undefined);
      });
    }),

    vscode.commands.registerCommand("codex-account-switch.selectAutoRefreshDevice", async () => {
      await ensureCurrentDeviceRegistered();
      const devices = listSyncedDevices();
      if (devices.length === 0) {
        logCommandWarn("select-auto-refresh-device", "no-devices");
        vscode.window.showWarningMessage("No synced devices are available yet.");
        return;
      }

      const currentDeviceName = getCurrentDeviceName();
      const picked = await vscode.window.showQuickPick(
        devices.map((deviceName) => ({
          label: deviceName,
          description: deviceName === currentDeviceName ? "Current device" : undefined,
          deviceName,
        })),
        {
          placeHolder: "Select the synced device that can automatically refresh cloud tokens",
        },
      );
      if (!picked) {
        logCommandInfo("select-auto-refresh-device", "cancelled");
        return;
      }

      await setAutoRefreshDeviceName(picked.deviceName);
      logCommandInfo("select-auto-refresh-device", "succeeded", {
        deviceName: picked.deviceName,
      });
      vscode.window.showInformationMessage(
        `Automatic cloud token refresh is now assigned to "${picked.deviceName}".`
      );
      refreshAll(refreshCoordinator);
    }),

    vscode.commands.registerCommand("codex-account-switch.expandAllAccounts", async () => {
      for (const item of accountTree.getRootItems()) {
        await accountTreeView.reveal(item, { expand: true, focus: false, select: false });
      }
    }),

    vscode.commands.registerCommand("codex-account-switch.reloadWindow", async () => {
      await reloadWindow();
    }),

    vscode.commands.registerCommand("codex-account-switch.unlockStorage", async () => {
      await runTimedCommand("unlockStorage", async (perf) => {
        const result = await unlockSavedAuthStorage(context);
        perf.mark("unlock-saved-auth-storage", {
          result,
        });
        if (result === "cancelled") {
          logCommandInfo("unlock-storage", "cancelled");
          return;
        }
        refreshAll(refreshCoordinator);
        logCommandInfo("unlock-storage", "succeeded", {
          alreadyUnlocked: result === "already-unlocked",
        });
        vscode.window.showInformationMessage(
          result === "already-unlocked"
            ? "Saved auth storage is already unlocked on this machine."
            : "Saved auth storage is unlocked on this machine."
        );
      });
    }),

    vscode.commands.registerCommand("codex-account-switch.setStoragePassword", async () => {
      const result = await promptAndStoreSavedAuthPassphrase(context, "set");
      if (!result.stored) {
        logCommandInfo("set-storage-password", "cancelled");
        return;
      }
      logCommandInfo("set-storage-password", "succeeded");
      vscode.window.showInformationMessage("Stored the local storage password on this machine.");
      refreshAll(refreshCoordinator);
    }),

    vscode.commands.registerCommand("codex-account-switch.changeStoragePassword", async () => {
      const result = await promptAndStoreSavedAuthPassphrase(context, "change");
      if (!result.stored) {
        logCommandInfo("change-storage-password", "cancelled");
        return;
      }
      logCommandInfo("change-storage-password", "succeeded", {
        rewritten: result.rewritten,
      });
      const suffix =
        result.rewritten > 0
          ? ` Re-encrypted ${result.rewritten} saved file${result.rewritten === 1 ? "" : "s"}.`
          : "";
      vscode.window.showInformationMessage(`Updated the local storage password on this machine.${suffix}`);
      refreshAll(refreshCoordinator);
    }),

    vscode.commands.registerCommand("codex-account-switch.forgetStoragePassword", async () => {
      await forgetSavedAuthPassphrase(context);
      logCommandInfo("forget-storage-password", "succeeded");
      vscode.window.showInformationMessage("Forgot the local storage password on this machine.");
      refreshAll(refreshCoordinator);
    }),

    vscode.commands.registerCommand("codex-account-switch.copyProviderField", async (item?: ProviderDetailItem) => {
      const value = item?.rawValue;
      if (!value) {
        logCommandWarn("copy-provider-field", "missing-value");
        vscode.window.showWarningMessage("No provider value available to copy.");
        return;
      }

      const label = typeof item?.label === "string" ? item.label : "provider value";
      await vscode.env.clipboard.writeText(value);
      logCommandInfo("copy-provider-field", "succeeded", {
        label,
      });
      vscode.window.showInformationMessage(`Copied ${label} to clipboard.`);
    }),

    vscode.commands.registerCommand("codex-account-switch.copyAccountField", async (item?: AccountDetailItem) => {
      const value = item?.rawValue;
      if (!value) {
        logCommandWarn("copy-account-field", "missing-value");
        vscode.window.showWarningMessage("No account value available to copy.");
        return;
      }

      const label = typeof item?.label === "string" ? item.label : "account value";
      await vscode.env.clipboard.writeText(value);
      logCommandInfo("copy-account-field", "succeeded", {
        label,
      });
      vscode.window.showInformationMessage(`Copied ${label} to clipboard.`);
    })
  );
}

