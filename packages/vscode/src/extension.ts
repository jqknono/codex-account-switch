import * as vscode from "vscode";
import {
  DiagnosticLogLevel,
  setDiagnosticLogger,
  setDiagnosticLogOptions,
  setNamedAuthDir,
} from "@codex-account-switch/core";
import { AccountTreeProvider, AccountTreeNode } from "./accountTree";
import { ProviderTreeProvider, ProviderTreeNode } from "./providerTree";
import { RefreshCoordinator } from "./refreshCoordinator";
import { StatusBarManager } from "./statusBar";
import { registerCommands } from "./commands";
import { disposeLogging, initializeLogging, logInfo, writeRawLog } from "./log";
import { restoreSavedAuthPassphrase } from "./storagePassword";
import { hasEncryptedSyncedEntries, initializeSavedEntries } from "./savedEntries";

const LOG_PREFIX = "[codex-account-switch:vscode:extension]";

function applyNamedAuthDirSetting() {
  const authDir = vscode.workspace
    .getConfiguration("codex-account-switch")
    .get<string>("authDirectory", "");

  setNamedAuthDir(authDir);
}

function applyDiagnosticLogSettings() {
  const config = vscode.workspace.getConfiguration("codex-account-switch");
  setDiagnosticLogOptions({
    detailedPerformanceLogging: config.get<boolean>("detailedPerformanceLogging", false),
  });
}

export async function activate(context: vscode.ExtensionContext) {
  initializeLogging();
  logInfo(LOG_PREFIX, "activate-start", {});
  setDiagnosticLogger((level: DiagnosticLogLevel, line: string) => {
    writeRawLog(level, line);
  });
  applyNamedAuthDirSetting();
  applyDiagnosticLogSettings();
  await initializeSavedEntries(context);
  await restoreSavedAuthPassphrase(context, {
    promptIfMissing: true,
    promptForLockedStorage: hasEncryptedSyncedEntries(),
  });

  const accountTree = new AccountTreeProvider();
  const providerTree = new ProviderTreeProvider();
  const statusBarManager = new StatusBarManager();
  const refreshCoordinator = new RefreshCoordinator(accountTree, providerTree, statusBarManager);
  const accountTreeView = vscode.window.createTreeView<AccountTreeNode>("codexAccountSwitchAccounts", {
    treeDataProvider: accountTree,
    showCollapseAll: true,
  });
  const providerTreeView = vscode.window.createTreeView<ProviderTreeNode>("codexAccountSwitchProviders", {
    treeDataProvider: providerTree,
    showCollapseAll: true,
  });

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration("codex-account-switch.authDirectory")
      || e.affectsConfiguration("codex-account-switch.defaultSaveTarget")
      || e.affectsConfiguration("codex-account-switch.detailedPerformanceLogging")
    ) {
      logInfo(LOG_PREFIX, "configuration-changed", {
        authDirectory: e.affectsConfiguration("codex-account-switch.authDirectory"),
        defaultSaveTarget: e.affectsConfiguration("codex-account-switch.defaultSaveTarget"),
        detailedPerformanceLogging: e.affectsConfiguration("codex-account-switch.detailedPerformanceLogging"),
      });
      applyNamedAuthDirSetting();
      applyDiagnosticLogSettings();
      void restoreSavedAuthPassphrase(context, {
        promptIfMissing: true,
        promptForLockedStorage: hasEncryptedSyncedEntries(),
      });
      refreshCoordinator.refreshViews("config-change");

      refreshCoordinator.scheduleQuotaRefresh({
        reason: "config-change",
      });
    }
  });

  context.subscriptions.push(
    accountTreeView,
    providerTreeView,
    accountTree,
    providerTree,
    statusBarManager,
    refreshCoordinator,
    configListener,
  );

  registerCommands(context, accountTree, providerTree, statusBarManager, accountTreeView, refreshCoordinator);

  statusBarManager.startConfigurationSync(context);
  refreshCoordinator.startAutoRefresh(context);
  refreshCoordinator.refreshViews("activate");
  refreshCoordinator.scheduleQuotaRefresh({
    reason: "activate",
  });
  logInfo(LOG_PREFIX, "activate-ready", {});
}

export function deactivate() {
  logInfo(LOG_PREFIX, "deactivate", {});
  setDiagnosticLogger(null);
  disposeLogging();
}
