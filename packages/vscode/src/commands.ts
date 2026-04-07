import * as vscode from "vscode";
import * as fs from "fs";
import {
  addAccountFromAuth,
  removeAccount,
  renameAccount,
  useAccount,
  refreshAccount,
  exportAccounts,
  importAccounts,
  listAccounts,
  ExportData,
  getNamedAuthPath,
  getNamedProviderPath,
  readNamedAuth,
  formatTokenExpiry,
  listModes,
  switchMode,
  getCurrentSelection,
  readProviderProfile,
  writeProviderProfile,
  deleteProviderProfile,
  getDefaultProviderProfile,
  ProviderProfile,
  getModeDisplayName,
} from "@codex-account-switch/core";
import { AccountTreeProvider, AccountTreeItem, AccountTreeNode } from "./accountTree";
import { ProviderDetailItem, ProviderTreeProvider } from "./providerTree";
import { StatusBarManager } from "./statusBar";
import { buildCompletedProviderProfile, readProviderProfileDraft } from "./providerProfile";
import { logWarn, showLogs } from "./log";
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

const DELETE_MODE_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("trash"),
  tooltip: "Delete provider mode",
};

interface ModeQuickPickItem extends vscode.QuickPickItem {
  modeName: string;
  intent: "switch" | "create";
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

function exitProviderModeForLogin(): { previousSelection: ReturnType<typeof getCurrentSelection>; switched: boolean } | null {
  const previousSelection = getCurrentSelection();
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

function restoreProviderModeAfterFailedLogin(previousSelection: ReturnType<typeof getCurrentSelection>, switched: boolean) {
  if (!switched || previousSelection.kind !== "provider") {
    return;
  }

  const restored = switchMode(previousSelection.name);
  if (!restored.success) {
    void vscode.window.showWarningMessage(
      `Restoring mode "${getModeDisplayName(previousSelection.name)}" failed: ${restored.message}`
    );
  }
}

async function pickAccountName(
  item: AccountTreeItem | undefined,
  placeHolder: string
): Promise<string | undefined> {
  if (item) {
    return item.account.name;
  }

  const accounts = listAccounts();
  if (accounts.length === 0) {
    vscode.window.showWarningMessage("No saved accounts");
    return undefined;
  }

  return vscode.window.showQuickPick(
    accounts.map((account) => account.name),
    { placeHolder }
  );
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

async function pickModeAction(
  currentMode: string,
  modes: string[]
): Promise<
  | { action: "switch"; modeName: string }
  | { action: "delete"; modeName: string }
  | { action: "create" }
  | undefined
> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<ModeQuickPickItem>();
    let settled = false;

    const finish = (
      result:
        | { action: "switch"; modeName: string }
        | { action: "delete"; modeName: string }
        | { action: "create" }
        | undefined
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      quickPick.hide();
      quickPick.dispose();
    };

    quickPick.items = [
      ...modes.map((modeName) => ({
        label: modeName === currentMode ? `$(check) ${getModeDisplayName(modeName)}` : getModeDisplayName(modeName),
        description: modeName === "account" ? "Account mode" : "Provider mode",
        modeName,
        intent: "switch" as const,
        buttons: modeName === "account" ? undefined : [DELETE_MODE_BUTTON],
      })),
      {
        label: "$(add) New Provider...",
        description: "Create a new provider profile",
        modeName: "__new_provider__",
        intent: "create" as const,
      },
    ];
    quickPick.placeholder = "Select a mode to switch to";
    quickPick.matchOnDescription = true;

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (!selected) {
        return;
      }

      if (selected.intent === "create") {
        finish({ action: "create" });
        return;
      }

      finish({ action: "switch", modeName: selected.modeName });
    });

    quickPick.onDidTriggerItemButton(({ item }) => {
      if (item.intent !== "switch" || item.modeName === "account") {
        return;
      }
      finish({ action: "delete", modeName: item.modeName });
    });

    quickPick.onDidHide(() => finish(undefined));
    quickPick.show();
  });
}

async function promptToDeleteMode(
  accountTree: AccountTreeProvider,
  providerTree: ProviderTreeProvider,
  statusBar: StatusBarManager,
  modeName: string
) {
  const selection = getCurrentSelection();
  const isActiveMode = selection.kind === "provider" && selection.name === modeName;
  if (isActiveMode) {
    vscode.window.showWarningMessage(
      `Provider mode "${getModeDisplayName(modeName)}" is currently in use and cannot be removed.`
    );
    return;
  }

  const action = await vscode.window.showWarningMessage(
    `Delete provider mode "${getModeDisplayName(modeName)}"? This removes its saved profile.`,
    { modal: true },
    "Delete"
  );
  if (action !== "Delete") {
    return;
  }

  const result = deleteProviderProfile(modeName);
  if (!result.success) {
    vscode.window.showErrorMessage(result.message);
    return;
  }

  vscode.window.showInformationMessage(`✓ ${result.message}`);
  refreshAll(accountTree, providerTree, statusBar);
}

async function restoreSelectionAfterLogin(
  previousSelection: ReturnType<typeof getCurrentSelection>,
  targetName: string
) {
  if (previousSelection.kind === "account" && previousSelection.name === targetName) {
    return { restored: false, restoredLabel: undefined as string | undefined };
  }

  if (previousSelection.kind === "account") {
    const restored = useAccount(previousSelection.name);
    if (!restored.success) {
      vscode.window.showWarningMessage(
        `Saved account "${targetName}" was updated, but restoring account "${previousSelection.name}" failed: ${restored.message}`
      );
      return { restored: false, restoredLabel: undefined as string | undefined };
    }
    return { restored: true, restoredLabel: previousSelection.name };
  }

  if (previousSelection.kind === "provider") {
    const restored = switchMode(previousSelection.name);
    if (!restored.success) {
      vscode.window.showWarningMessage(
        `Saved account "${targetName}" was updated, but restoring mode "${getModeDisplayName(previousSelection.name)}" failed: ${restored.message}`
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

async function promptForAccountRename(currentName: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: `Rename account "${currentName}"`,
    placeHolder: "Enter a new account name",
    value: currentName,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Name is required";
      }
      if (trimmed === currentName) {
        return "Enter a different name";
      }
      if (listAccounts().some((account) => account.name === trimmed)) {
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

async function ensureProviderProfile(name: string): Promise<ProviderProfile | null> {
  const existing = readProviderProfile(name);
  if (existing) {
    return existing;
  }

  const defaults = getDefaultProviderProfile(name);
  const draft = readProviderProfileDraft(getNamedProviderPath(name), name);
  if (draft.invalid) {
    void vscode.window.showWarningMessage(
      `Provider "${name}" is incomplete or invalid. Required fields will be prompted and the profile will be updated.`
    );
  }

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

  const apiKey = await askRequiredValue({
    prompt: `Configure provider "${name}": OPENAI_API_KEY`,
    placeHolder: "sk-...",
    value: existingApiKey,
    password: true,
  });
  if (!apiKey) {
    return null;
  }

  const baseUrl = await askRequiredValue({
    prompt: `Configure provider "${name}": base_url`,
    placeHolder: "https://api.example.com/v1",
    value: existingBaseUrl,
  });
  if (!baseUrl) {
    return null;
  }

  const wireApi = await askRequiredValue({
    prompt: `Configure provider "${name}": wire_api`,
    placeHolder: defaults.config.wire_api,
    value: existingWireApi,
  });
  if (!wireApi) {
    return null;
  }

  const profile = buildCompletedProviderProfile(name, defaults, draft, {
    apiKey,
    baseUrl,
    wireApi,
  });

  writeProviderProfile(profile);
  vscode.window.showInformationMessage(
    `${draft.exists ? "Updated" : "Created"} provider profile for "${name}".`
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

      const dest = getNamedAuthPath(name.trim());
      if (fs.existsSync(dest)) {
        const existingName = name.trim();
        const refreshResult = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Refreshing token for "${existingName}"...` },
          async () => refreshAccount(existingName)
        );

        if (refreshResult.success) {
          const refreshedAuth = readNamedAuth(existingName);
          const tokenStatus = refreshedAuth ? formatTokenExpiry(refreshedAuth) : undefined;
          vscode.window.showInformationMessage(
            tokenStatus
              ? `Account "${existingName}" already exists. Token refreshed. Remaining validity: ${tokenStatus}.`
              : `Account "${existingName}" already exists. Token refreshed.`
          );
          refreshAll(accountTree, providerTree, statusBar);
          return;
        }

        const loginMethod = await promptLoginMethod(
          `Account "${existingName}" already exists and token refresh failed. Start login and overwrite it?`,
          "Login and overwrite"
        );
        if (loginMethod === "cancel") return;

        const loginState = exitProviderModeForLogin();
        if (!loginState) return;

        const completed = await runCodexLogin({ useDeviceAuth: loginMethod === "device-auth" });
        if (!completed) {
          restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
          return;
        }

        const result = addAccountFromAuth(name.trim());
        if (result.success) {
          refreshAll(accountTree, providerTree, statusBar);
          await promptReloadWindowAfterAdd(name.trim(), result.meta?.email);
        } else {
          restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
          vscode.window.showErrorMessage(result.message);
        }
        return;
      }

      const loginMethod = await promptLoginMethod(
        `Add account "${name.trim()}". Use device auth for this login?`,
        "Login"
      );
      if (loginMethod === "cancel") return;

      const loginState = exitProviderModeForLogin();
      if (!loginState) return;

      const completed = await runCodexLogin({ useDeviceAuth: loginMethod === "device-auth" });
      if (!completed) {
        restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
        return;
      }

      const result = addAccountFromAuth(name.trim());
      if (result.success) {
        refreshAll(accountTree, providerTree, statusBar);
        await promptReloadWindowAfterAdd(name.trim(), result.meta?.email);
      } else {
        restoreProviderModeAfterFailedLogin(loginState.previousSelection, loginState.switched);
        vscode.window.showErrorMessage(result.message);
      }
    }),

    vscode.commands.registerCommand(
      "codex-account-switch.reloginAccount",
      async (item?: AccountTreeItem) => {
        const name = await pickAccountName(item, "Select an account to re-login");
        if (!name) return;

        const loginMethod = await promptLoginMethod(
          `Re-login account "${name}" and overwrite its saved auth.json?`,
          "Re-login"
        );
        if (loginMethod === "cancel") return;

        const loginState = exitProviderModeForLogin();
        if (!loginState) return;

        const previousSelection = loginState.previousSelection;
        const completed = await runCodexLogin({ useDeviceAuth: loginMethod === "device-auth" });
        if (!completed) {
          restoreProviderModeAfterFailedLogin(previousSelection, loginState.switched);
          return;
        }

        const result = addAccountFromAuth(name);
        const shouldRestore =
          previousSelection.kind !== "unknown" &&
          !(previousSelection.kind === "account" && previousSelection.name === name);
        const restoreResult = shouldRestore
          ? await restoreSelectionAfterLogin(previousSelection, name)
          : { restored: false, restoredLabel: undefined as string | undefined };

        if (result.success) {
          refreshAll(accountTree, providerTree, statusBar);
          if (restoreResult.restored) {
            const savedMessage = result.meta?.email
              ? `✓ Account "${name}" was updated (${result.meta.email}). Active selection stayed on "${restoreResult.restoredLabel}".`
              : `✓ Account "${name}" was updated. Active selection stayed on "${restoreResult.restoredLabel}".`;
            vscode.window.showInformationMessage(savedMessage);
          } else {
            await promptReloadWindowAfterAdd(name, result.meta?.email);
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
        const name = await pickAccountName(item, "Select an account to rename");
        if (!name) return;

        const newName = await promptForAccountRename(name);
        if (!newName) return;

        const result = renameAccount(name, newName);
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
        let name: string | undefined;

        if (item) {
          name = item.account.name;
        } else {
          const accounts = listAccounts();
          if (accounts.length === 0) {
            vscode.window.showWarningMessage("No saved accounts");
            return;
          }
          name = await vscode.window.showQuickPick(
            accounts.map((a) => a.name),
            { placeHolder: "Select an account to remove" }
          );
        }

        if (!name) return;

        const selection = getCurrentSelection();
        if (selection.kind === "account" && selection.name === name) {
          vscode.window.showWarningMessage(`Account "${name}" is currently in use and cannot be removed.`);
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Remove account "${name}"?`,
          "Remove",
          "Cancel"
        );
        if (confirm !== "Remove") return;

        const result = removeAccount(name);
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
        let name: string | undefined;

        if (item) {
          name = item.account.name;
        } else {
          const accounts = listAccounts();
          if (accounts.length === 0) {
            vscode.window.showWarningMessage("No saved accounts");
            return;
          }
          const items = accounts.map((a) => ({
            label: a.isCurrent ? `$(pass-filled) ${a.name}` : a.name,
            description: `${a.meta?.email ?? ""} (${a.meta?.plan ?? ""})`,
            name: a.name,
          }));
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: "Select an account to switch to",
          });
          name = picked?.name;
        }

        if (!name) return;

        const result = useAccount(name);
        if (result.success) {
          vscode.window.showInformationMessage(
            `✓ ${result.message} (${result.meta?.email ?? "unknown"})`
          );
          refreshAll(accountTree, providerTree, statusBar);
          await maybeReloadWindowAfterSwitch(name, "account");
        } else {
          vscode.window.showErrorMessage(result.message);
        }
      }
    ),

    vscode.commands.registerCommand("codex-account-switch.switchMode", async () => {
      const selection = getCurrentSelection();
      const currentMode = selection.kind === "provider" ? selection.name : "account";
      const modes = Array.from(new Set([...listModes(), ...(selection.kind === "provider" ? [selection.name] : [])]));
      const picked = await pickModeAction(currentMode, modes);
      if (!picked) {
        return;
      }

      if (picked.action === "delete") {
        await promptToDeleteMode(accountTree, providerTree, statusBar, picked.modeName);
        return;
      }

      let targetName = picked.action === "switch" ? picked.modeName : "";
      if (picked.action === "create") {
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
        targetName = newName.trim();
      }

      if (targetName !== "account" && !readProviderProfile(targetName)) {
        const created = await ensureProviderProfile(targetName);
        if (!created) {
          return;
        }
      }

      const result = switchMode(targetName);
      if (!result.success) {
        vscode.window.showErrorMessage(result.message);
        return;
      }

      vscode.window.showInformationMessage(`✓ ${result.message}`);
      refreshAll(accountTree, providerTree, statusBar);
      await maybeReloadWindowAfterSwitch(targetName, "mode");
    }),

    vscode.commands.registerCommand(
      "codex-account-switch.refreshToken",
      async (item?: AccountTreeItem) => {
        const name = item?.account.name;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Refreshing token and quota..." },
          async () => {
            let result;
            try {
              result = await refreshAccount(name);
            } catch (error) {
              logWarn(LOG_PREFIX, "refresh-token-command-failed", {
                account: name ?? null,
                error: error instanceof Error ? error.message : String(error),
              });
              vscode.window.showErrorMessage(
                `Token refresh failed${name ? ` for "${name}"` : ""}: ${error instanceof Error ? error.message : error}`
              );
              return;
            }
            if (result.success) {
              try {
                await refreshTokenAndQuota(accountTree, statusBar, name);
              } catch (error) {
                logWarn(LOG_PREFIX, "refresh-token-quota-followup-failed", {
                  account: name ?? null,
                  error: error instanceof Error ? error.message : String(error),
                });
                vscode.window.showWarningMessage(
                  `Token refreshed${name ? ` for "${name}"` : ""}, but quota refresh failed: ${error instanceof Error ? error.message : error}`
                );
                return;
              }
              vscode.window.showInformationMessage(`✓ ${result.message} and quota was refreshed`);
            } else if (result.unsupported) {
              vscode.window.showWarningMessage(result.message);
            } else if (name && refreshFailureSupportsRelogin(result.message)) {
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

      const data = exportAccounts();
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

