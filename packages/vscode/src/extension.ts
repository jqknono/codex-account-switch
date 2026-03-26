import * as vscode from "vscode";
import { setNamedAuthDir } from "@codex-account-switch/core";
import { AccountTreeProvider, AccountTreeNode } from "./accountTree";
import { ProviderTreeProvider, ProviderTreeNode } from "./providerTree";
import { StatusBarManager } from "./statusBar";
import { registerCommands } from "./commands";

function applyNamedAuthDirSetting() {
  const authDir = vscode.workspace
    .getConfiguration("codex-account-switch")
    .get<string>("authDirectory", "");

  setNamedAuthDir(authDir);
}

export function activate(context: vscode.ExtensionContext) {
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
      void accountTree.refreshQuota();
      void statusBarManager.refreshNow();
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
  // VS Code disposes registered subscriptions automatically.
}
