import * as vscode from "vscode";
import { DiagnosticLogLevel, setDiagnosticLogger, setNamedAuthDir } from "@codex-account-switch/core";
import { AccountTreeProvider, AccountTreeNode } from "./accountTree";
import { ProviderTreeProvider, ProviderTreeNode } from "./providerTree";
import { StatusBarManager } from "./statusBar";
import { registerCommands } from "./commands";
import { disposeLogging, initializeLogging, logWarn, writeRawLog } from "./log";
const LOG_PREFIX = "[codex-account-switch:vscode:extension]";

function applyNamedAuthDirSetting() {
  const authDir = vscode.workspace
    .getConfiguration("codex-account-switch")
    .get<string>("authDirectory", "");

  setNamedAuthDir(authDir);
}

export function activate(context: vscode.ExtensionContext) {
  initializeLogging();
  setDiagnosticLogger((level: DiagnosticLogLevel, line: string) => {
    writeRawLog(level, line);
  });
  applyNamedAuthDirSetting();

  const accountTree = new AccountTreeProvider();
  const providerTree = new ProviderTreeProvider();
  const statusBarManager = new StatusBarManager();
  const accountTreeView = vscode.window.createTreeView<AccountTreeNode>("codexAccountSwitchAccounts", {
    treeDataProvider: accountTree,
    showCollapseAll: true,
  });
  const providerTreeView = vscode.window.createTreeView<ProviderTreeNode>("codexAccountSwitchProviders", {
    treeDataProvider: providerTree,
    showCollapseAll: true,
  });

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("codex-account-switch.authDirectory")) {
      applyNamedAuthDirSetting();
      accountTree.refresh();
      providerTree.refresh();
      void accountTree.refreshQuota().catch((error) => {
        logWarn(LOG_PREFIX, "auth-directory-accountTree-refresh-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      void statusBarManager.refreshNow().catch((error) => {
        logWarn(LOG_PREFIX, "auth-directory-statusBar-refresh-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });

  context.subscriptions.push(
    accountTreeView,
    providerTreeView,
    accountTree,
    providerTree,
    statusBarManager,
    configListener,
  );

  registerCommands(context, accountTree, providerTree, statusBarManager, accountTreeView);

  accountTree.startAutoRefresh(context);
  statusBarManager.startAutoRefresh(context);
}

export function deactivate() {
  setDiagnosticLogger(null);
  disposeLogging();
}
