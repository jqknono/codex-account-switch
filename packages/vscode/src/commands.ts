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
import { AccountTreeProvider, AccountTreeItem, AccountTreeNode } from "./accountTree";
import { ProviderDetailItem, ProviderTreeItem, ProviderTreeProvider } from "./providerTree";
import { StatusBarManager } from "./statusBar";
import { buildCompletedProviderProfile } from "./providerProfile";
import { logWarn, showLogs } from "./log";
import {
  ensureSavedAuthPassphrase,
  forgetSavedAuthPassphrase,
  promptAndStoreSavedAuthPassphrase,
} from "./storagePassword";
import {
  buildProviderProfileForSource,
  getSavedAccountEntry,
  getSavedCurrentSelection,
  getSavedProviderEntry,
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
  StorageSource,
  switchToSavedProviderEntry,
  useSavedAccountEntry,
} from "./savedEntries";
const LOG_PREFIX = "[codex-account-switch:vscode:commands]";

function getUseDeviceAuthForLogin(): boolean {
  return vscode.workspace
    .getConfiguration("codex-account-switch")
    .get<boolean>("useDeviceAuthForLogin", false);
}

function getCodexLoginCommand(useDeviceAuth = getUseDeviceAuthForLogin()): string {
  return useDeviceAuth ? "codex login --device-auth" : "codex login";
}

function refreshAll(
  accountTree: AccountTreeProvider,
  providerTree: ProviderTreeProvider,
  statusBar: StatusBarManager
) {
  accountTree.refresh();
  providerTree.refresh();
  void accountTree.refreshQuota().catch((error) => {
    logWarn(LOG_PREFIX, "refresh-all-accountTree-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  void statusBar.refreshNow().catch((error) => {
    logWarn(LOG_PREFIX, "refresh-all-statusBar-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function refreshTokenAndQuota(
  accountTree: AccountTreeProvider,
  statusBar: StatusBarManager,
  name?: string
) {
  accountTree.refresh();
  await Promise.all([accountTree.refreshQuota(name), statusBar.refreshNow()]);
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
  const terminal = vscode.window.createTerminal("Codex Login");
  terminal.show();
  terminal.sendText(loginCommand);

  const message = useDeviceAuth
    ? `Complete \`${loginCommand}\` in the terminal, then click Done. If Codex says "Enable device code authorization for Codex in ChatGPT Security Settings, then run \\"codex login --device-auth\\" again.", enable it in ChatGPT Security Settings first.`
    : `Complete \`${loginCommand}\` in the terminal, then click Done.`;

  const action = await vscode.window.showInformationMessage(message, "Done", "Cancel");

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
    void vscode.window.showErrorMessage(switched.message);
    return null;
  }

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

  await saveProviderProfileToSource(profile, source);
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
  accountTreeView: vscode.TreeView<AccountTreeNode>
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("codex-account-switch.addAccount", async () => {
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
      if (target === "cloud" && !(await ensureSavedAuthPassphrase(context))) {
        vscode.window.showWarningMessage("Cloud storage requires a local storage password.");
        return;
      }

      const existing = getSavedAccountEntry(trimmedName, target);
      if (existing) {
        if (existing.storageState !== "ready") {
          vscode.window.showErrorMessage(existing.storageMessage ?? `Saved account "${trimmedName}" is unavailable.`);
          return;
        }

        const refreshResult = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Refreshing token for "${trimmedName}"...` },
          async () => refreshSavedAccountEntry(existing),
        );
        if (refreshResult.success) {
          await refreshTokenAndQuota(accountTree, statusBar, existing.id);
          vscode.window.showInformationMessage(`Account "${trimmedName}" already exists in ${getSourceLabel(target)} storage. Token refreshed.`);
          refreshAll(accountTree, providerTree, statusBar);
          return;
        }

        const overwriteMethod = await promptLoginMethod(
          `Account "${trimmedName}" already exists in ${getSourceLabel(target)} storage and token refresh failed. Start login and overwrite it?`,
          "Login and overwrite",
        );
        if (overwriteMethod === "cancel") return;

        const loginState = exitProviderModeForLogin();
        if (!loginState) return;

        const completed = await runCodexLogin({ useDeviceAuth: overwriteMethod === "device-auth" });
        if (!completed) {
          await restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
          return;
        }

        const result = await saveCurrentAuthAsAccount(trimmedName, target);
        if (result.success) {
          refreshAll(accountTree, providerTree, statusBar);
          await promptReloadWindowAfterAdd(trimmedName, result.meta?.email);
        } else {
          await restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
          vscode.window.showErrorMessage(result.message);
        }
        return;
      }

      const loginMethod = await promptLoginMethod(
        `Add account "${trimmedName}" to ${getSourceLabel(target)} storage. Use device auth for this login?`,
        "Login",
      );
      if (loginMethod === "cancel") return;

      const loginState = exitProviderModeForLogin();
      if (!loginState) return;

      const completed = await runCodexLogin({ useDeviceAuth: loginMethod === "device-auth" });
      if (!completed) {
        await restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
        return;
      }

      const result = await saveCurrentAuthAsAccount(trimmedName, target);
      if (result.success) {
        refreshAll(accountTree, providerTree, statusBar);
        await promptReloadWindowAfterAdd(trimmedName, result.meta?.email);
      } else {
        await restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
        vscode.window.showErrorMessage(result.message);
      }
    }),

    vscode.commands.registerCommand(
      "codex-account-switch.reloginAccount",
      async (item?: AccountTreeItem) => {
        const account = await pickSavedAccount(item, "Select an account to re-login");
        if (!account) return;
        if (account.storageState !== "ready") {
          vscode.window.showErrorMessage(account.storageMessage ?? `Saved account "${account.name}" is unavailable.`);
          return;
        }

        const loginMethod = await promptLoginMethod(
          `Re-login account "${account.name}" and overwrite its saved auth in ${getSourceLabel(account.source)} storage?`,
          "Re-login",
        );
        if (loginMethod === "cancel") return;

        const loginState = exitProviderModeForLogin();
        if (!loginState) return;

        const previousSelection = loginState.previousSelection;
        const completed = await runCodexLogin({ useDeviceAuth: loginMethod === "device-auth" });
        if (!completed) {
          await restoreProviderModeAfterFailedLogin(previousSelection, loginState.switched);
          return;
        }

        const result = await saveCurrentAuthAsAccount(account.name, account.source);
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
          refreshAll(accountTree, providerTree, statusBar);
          if (restoreResult.restored) {
            const savedMessage = result.meta?.email
              ? `✓ Account "${account.name}" was updated (${result.meta.email}). Active selection stayed on "${restoreResult.restoredLabel}".`
              : `✓ Account "${account.name}" was updated. Active selection stayed on "${restoreResult.restoredLabel}".`;
            vscode.window.showInformationMessage(savedMessage);
          } else {
            await promptReloadWindowAfterAdd(account.name, result.meta?.email);
          }
        } else {
          if (restoreResult.restored) {
            refreshAll(accountTree, providerTree, statusBar);
          }
          vscode.window.showErrorMessage(result.message);
        }
      }
    ),

    vscode.commands.registerCommand(
      "codex-account-switch.renameAccount",
      async (item?: AccountTreeItem) => {
        const account = await pickSavedAccount(item, "Select an account to rename");
        if (!account) return;

        const newName = await promptForAccountRename(account);
        if (!newName) return;

        const result = await renameSavedAccountEntry(account, newName);
        if (result.success) {
          vscode.window.showInformationMessage(`✓ ${result.message}`);
          refreshAll(accountTree, providerTree, statusBar);
        } else {
          vscode.window.showErrorMessage(result.message);
        }
      }
    ),

    vscode.commands.registerCommand(
      "codex-account-switch.removeAccount",
      async (item?: AccountTreeItem) => {
        const account = await pickSavedAccount(item, "Select an account to remove");
        if (!account) return;

        const confirm = await vscode.window.showWarningMessage(
          `Remove account "${account.name}" from ${getSourceLabel(account.source)} storage?`,
          "Remove",
          "Cancel",
        );
        if (confirm !== "Remove") return;

        const result = await removeSavedAccountEntry(account);
        if (result.success) {
          vscode.window.showInformationMessage(`✓ ${result.message}`);
          refreshAll(accountTree, providerTree, statusBar);
        } else {
          vscode.window.showErrorMessage(result.message);
        }
      }
    ),

    vscode.commands.registerCommand(
      "codex-account-switch.useAccount",
      async (item?: AccountTreeItem) => {
        const account = await pickSavedAccount(item, "Select an account to switch to");
        if (!account) return;

        const result = await useSavedAccountEntry(account);
        if (result.success) {
          vscode.window.showInformationMessage(
            `✓ ${result.message} (${result.meta?.email ?? "unknown"})`
          );
          refreshAll(accountTree, providerTree, statusBar);
          await maybeReloadWindowAfterSwitch(account.name, "account");
        } else {
          vscode.window.showErrorMessage(result.message);
        }
      }
    ),

    vscode.commands.registerCommand("codex-account-switch.switchMode", async () => {
      const picked = await pickModeAction();
      if (!picked) {
        return;
      }

      if (picked.action === "create") {
        if (picked.source === "cloud" && !(await ensureSavedAuthPassphrase(context))) {
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
        const created = await ensureProviderProfile(targetName, picked.source);
        if (!created) {
          return;
        }
        const provider = getSavedProviderEntry(targetName, picked.source);
        if (!provider) {
          vscode.window.showErrorMessage(`Provider "${targetName}" was not found after saving.`);
          return;
        }
        const result = await switchToSavedProviderEntry(provider);
        if (!result.success) {
          vscode.window.showErrorMessage(result.message);
          return;
        }
        vscode.window.showInformationMessage(`✓ ${result.message}`);
        refreshAll(accountTree, providerTree, statusBar);
        await maybeReloadWindowAfterSwitch(targetName, "mode");
        return;
      }

      if (!picked.provider) {
        const result = switchMode("account");
        if (!result.success) {
          vscode.window.showErrorMessage(result.message);
          return;
        }
        vscode.window.showInformationMessage(`✓ ${result.message}`);
        refreshAll(accountTree, providerTree, statusBar);
        await maybeReloadWindowAfterSwitch("account", "mode");
        return;
      }

      if (picked.provider.locked) {
        vscode.window.showErrorMessage(picked.provider.storageMessage ?? `Provider "${picked.provider.name}" is unavailable.`);
        return;
      }

      if (picked.provider.invalid || !picked.provider.profile) {
        const created = await ensureProviderProfile(picked.provider.name, picked.provider.source);
        if (!created) {
          return;
        }
      }

      const provider = getSavedProviderEntry(picked.provider.name, picked.provider.source);
      if (!provider) {
        vscode.window.showErrorMessage(`Provider "${picked.provider.name}" is unavailable.`);
        return;
      }

      const result = await switchToSavedProviderEntry(provider);
      if (!result.success) {
        vscode.window.showErrorMessage(result.message);
        return;
      }

      vscode.window.showInformationMessage(`✓ ${result.message}`);
      refreshAll(accountTree, providerTree, statusBar);
      await maybeReloadWindowAfterSwitch(provider.name, "mode");
    }),

    vscode.commands.registerCommand(
      "codex-account-switch.refreshToken",
      async (item?: AccountTreeItem) => {
        const account = await pickSavedAccount(item, "Select an account to refresh");
        if (!account) return;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Refreshing token and quota..." },
          async () => {
            let result;
            try {
              result = await refreshSavedAccountEntry(account);
            } catch (error) {
              logWarn(LOG_PREFIX, "refresh-token-command-failed", {
                account: account.id,
                error: error instanceof Error ? error.message : String(error),
              });
              vscode.window.showErrorMessage(
                `Token refresh failed for "${account.name}": ${error instanceof Error ? error.message : error}`,
              );
              return;
            }
            if (result.success) {
              try {
                await refreshTokenAndQuota(accountTree, statusBar, account.id);
              } catch (error) {
                logWarn(LOG_PREFIX, "refresh-token-quota-followup-failed", {
                  account: account.id,
                  error: error instanceof Error ? error.message : String(error),
                });
                vscode.window.showWarningMessage(
                  `Token refreshed for "${account.name}", but quota refresh failed: ${error instanceof Error ? error.message : error}`,
                );
                return;
              }
              vscode.window.showInformationMessage(`✓ ${result.message} and quota was refreshed`);
            } else if (result.unsupported) {
              vscode.window.showWarningMessage(result.message);
            } else if (refreshFailureSupportsRelogin(result.message)) {
              const action = await vscode.window.showErrorMessage(result.message, "Re-login");
              if (action === "Re-login") {
                await vscode.commands.executeCommand("codex-account-switch.reloginAccount", item);
              }
            } else {
              vscode.window.showErrorMessage(result.message);
            }
          }
        );
      }
    ),

    vscode.commands.registerCommand("codex-account-switch.moveAccountToCloud", async (item?: AccountTreeItem) => {
      const account = await pickSavedAccount(item, "Select a local account to move to cloud storage");
      if (!account) return;
      if (!(await ensureSavedAuthPassphrase(context))) {
        vscode.window.showWarningMessage("Cloud storage requires a local storage password.");
        return;
      }
      const result = await moveSavedAccountEntry(account, "cloud");
      if (!result.success) {
        vscode.window.showErrorMessage(result.message);
        return;
      }
      vscode.window.showInformationMessage(`✓ ${result.message}`);
      refreshAll(accountTree, providerTree, statusBar);
    }),

    vscode.commands.registerCommand("codex-account-switch.moveAccountToLocal", async (item?: AccountTreeItem) => {
      const account = await pickSavedAccount(item, "Select a cloud account to move to local storage");
      if (!account) return;
      const result = await moveSavedAccountEntry(account, "local");
      if (!result.success) {
        vscode.window.showErrorMessage(result.message);
        return;
      }
      vscode.window.showInformationMessage(`✓ ${result.message}`);
      refreshAll(accountTree, providerTree, statusBar);
    }),

    vscode.commands.registerCommand("codex-account-switch.moveProviderToCloud", async (item?: ProviderTreeItem) => {
      const provider = await pickSavedProvider(item, "Select a local provider to move to cloud storage");
      if (!provider) return;
      if (!(await ensureSavedAuthPassphrase(context))) {
        vscode.window.showWarningMessage("Cloud storage requires a local storage password.");
        return;
      }
      const result = await moveSavedProviderEntry(provider, "cloud");
      if (!result.success) {
        vscode.window.showErrorMessage(result.message);
        return;
      }
      vscode.window.showInformationMessage(`✓ ${result.message}`);
      refreshAll(accountTree, providerTree, statusBar);
    }),

    vscode.commands.registerCommand("codex-account-switch.moveProviderToLocal", async (item?: ProviderTreeItem) => {
      const provider = await pickSavedProvider(item, "Select a cloud provider to move to local storage");
      if (!provider) return;
      const result = await moveSavedProviderEntry(provider, "local");
      if (!result.success) {
        vscode.window.showErrorMessage(result.message);
        return;
      }
      vscode.window.showInformationMessage(`✓ ${result.message}`);
      refreshAll(accountTree, providerTree, statusBar);
    }),

    vscode.commands.registerCommand("codex-account-switch.refreshQuota", () => {
      void accountTree.refreshQuota().catch((error) => {
        logWarn(LOG_PREFIX, "refresh-quota-command-accountTree-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      void statusBar.refreshNow().catch((error) => {
        logWarn(LOG_PREFIX, "refresh-quota-command-statusBar-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }),

    vscode.commands.registerCommand("codex-account-switch.showLogs", () => {
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
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        return;
      }
      if (data.accounts.length === 0) {
        vscode.window.showWarningMessage("No accounts to export");
        return;
      }

      fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2), "utf-8");
      vscode.window.showInformationMessage(
        `✓ Exported ${data.accounts.length} account(s) to ${uri.fsPath}`
      );
    }),

    vscode.commands.registerCommand("codex-account-switch.importAccounts", async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ["json"] },
        openLabel: "Import",
      });
      if (!uris || uris.length === 0) return;

      let data: ExportData;
      try {
        data = JSON.parse(
          fs.readFileSync(uris[0].fsPath, "utf-8")
        ) as ExportData;
      } catch {
        vscode.window.showErrorMessage("Invalid file format: unable to parse JSON");
        return;
      }

      if (data.version !== 1 || !Array.isArray(data.accounts)) {
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

      const result = importAccounts(data, overwrite.value);

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
      refreshAll(accountTree, providerTree, statusBar);
    }),

    vscode.commands.registerCommand("codex-account-switch.refreshList", () => {
      refreshAll(accountTree, providerTree, statusBar);
    }),

    vscode.commands.registerCommand("codex-account-switch.expandAllAccounts", async () => {
      for (const item of accountTree.getRootItems()) {
        await accountTreeView.reveal(item, { expand: true, focus: false, select: false });
      }
    }),

    vscode.commands.registerCommand("codex-account-switch.reloadWindow", async () => {
      await reloadWindow();
    }),

    vscode.commands.registerCommand("codex-account-switch.setStoragePassword", async () => {
      const result = await promptAndStoreSavedAuthPassphrase(context, "set");
      if (!result.stored) {
        return;
      }
      vscode.window.showInformationMessage("Stored the local storage password on this machine.");
      refreshAll(accountTree, providerTree, statusBar);
    }),

    vscode.commands.registerCommand("codex-account-switch.changeStoragePassword", async () => {
      const result = await promptAndStoreSavedAuthPassphrase(context, "change");
      if (!result.stored) {
        return;
      }
      const suffix =
        result.rewritten > 0
          ? ` Re-encrypted ${result.rewritten} saved file${result.rewritten === 1 ? "" : "s"}.`
          : "";
      vscode.window.showInformationMessage(`Updated the local storage password on this machine.${suffix}`);
      refreshAll(accountTree, providerTree, statusBar);
    }),

    vscode.commands.registerCommand("codex-account-switch.forgetStoragePassword", async () => {
      await forgetSavedAuthPassphrase(context);
      vscode.window.showInformationMessage("Forgot the local storage password on this machine.");
      refreshAll(accountTree, providerTree, statusBar);
    }),

    vscode.commands.registerCommand("codex-account-switch.copyProviderField", async (item?: ProviderDetailItem) => {
      const value = item?.rawValue;
      if (!value) {
        vscode.window.showWarningMessage("No provider value available to copy.");
        return;
      }

      const label = typeof item?.label === "string" ? item.label : "provider value";
      await vscode.env.clipboard.writeText(value);
      vscode.window.showInformationMessage(`Copied ${label} to clipboard.`);
    })
  );
}

