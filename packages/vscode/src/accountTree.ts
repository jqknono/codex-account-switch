import * as vscode from "vscode";
import {
  getTokenExpiry,
  formatTokenExpiry,
  formatRefreshTokenStatus,
  QuotaInfo,
  WindowInfo,
} from "@codex-account-switch/core";
import { logInfo, logWarn } from "./log";
import { listSavedAccounts, querySavedAccountQuota, SavedAccountInfo } from "./savedEntries";

interface QuotaState {
  info: QuotaInfo | null;
  loading: boolean;
  error: boolean;
  updatedAt: number | null;
}

export type AccountTreeNode = AccountTreeItem | AccountDetailItem;
const LOG_PREFIX = "[codex-account-switch:vscode:accountTree]";

function windowLabel(w: WindowInfo): string {
  if (w.windowSeconds == null) return "Quota";
  const hours = w.windowSeconds / 3600;
  if (hours <= 5) return "5h";
  if (hours <= 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatQuotaSummary(info: QuotaInfo | null): string | null {
  if (!info?.primaryWindow) {
    return null;
  }

  const parts = [`${windowLabel(info.primaryWindow)} ${Math.max(0, 100 - Math.round(info.primaryWindow.usedPercent))}%`];
  if (info.secondaryWindow) {
    parts.push(`${windowLabel(info.secondaryWindow)} ${Math.max(0, 100 - Math.round(info.secondaryWindow.usedPercent))}%`);
  }
  return parts.join(" · ");
}

function getQuotaUnavailableMessage(info: QuotaInfo | null | undefined): string | null {
  return info?.unavailableReason?.message ?? null;
}

function formatResetTime(resetsAt: Date | null): string | null {
  if (!resetsAt) return null;
  const secs = Math.floor((resetsAt.getTime() - Date.now()) / 1000);
  if (secs <= 0) return "Resets soon";

  const hours = Math.floor(secs / 3600);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `Resets in ${days}d${remainingHours}h`;
  }
  if (hours >= 1) {
    return `Resets in ${hours}h`;
  }
  return "Resets in <1h";
}

function formatWindowDescription(w: WindowInfo): string {
  const used = Math.round(w.usedPercent);
  const remaining = Math.max(0, 100 - used);
  const reset = formatResetTime(w.resetsAt);
  return reset
    ? `${used}% used / ${remaining}% remaining · ${reset}`
    : `${used}% used / ${remaining}% remaining`;
}

function formatWindowDetailDescription(w: WindowInfo): string {
  const used = Math.round(w.usedPercent);
  const remaining = Math.max(0, 100 - used);
  const reset = formatResetTime(w.resetsAt);
  return reset
    ? `${remaining}% remaining · ${reset}`
    : `${remaining}% remaining`;
}

function quotaIcon(usedPercent: number): vscode.ThemeIcon {
  const remaining = Math.max(0, 100 - Math.round(usedPercent));
  if (remaining === 0) {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
  }
  if (usedPercent >= 70) {
    return new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"));
  }
  if (usedPercent >= 50) {
    return new vscode.ThemeIcon("info", new vscode.ThemeColor("editorWarning.foreground"));
  }
  return new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
}

function appendQuotaTooltip(lines: string[], info: QuotaInfo) {
  if (info.primaryWindow) {
    lines.push(`${windowLabel(info.primaryWindow)} quota: ${formatWindowDescription(info.primaryWindow)}`);
  }

  if (info.secondaryWindow) {
    lines.push(`${windowLabel(info.secondaryWindow)} quota: ${formatWindowDescription(info.secondaryWindow)}`);
  }

  for (const item of info.additional) {
    if (item.primary) {
      lines.push(`${item.name}: ${formatWindowDescription(item.primary)}`);
    }
    if (item.secondary) {
      lines.push(`${item.name} secondary: ${formatWindowDescription(item.secondary)}`);
    }
  }

  if (info.codeReview) {
    lines.push(`Code review: ${formatWindowDescription(info.codeReview)}`);
  }

  if (info.credits?.hasCredits) {
    lines.push("Extra credits: Available");
  }
}

class AccountDetailItem extends vscode.TreeItem {
  constructor(
    label: string,
    description?: string,
    tooltip?: string,
    public readonly parent?: AccountTreeItem
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = "accountDetail";
  }
}

export class AccountTreeItem extends vscode.TreeItem {
  constructor(public readonly account: SavedAccountInfo, public readonly quotaState?: QuotaState) {
    super(account.name, vscode.TreeItemCollapsibleState.Expanded);

    const email = account.meta?.email ?? "unknown";
    const plan = account.meta?.plan ?? "unknown";
    const parts: string[] = [account.source];
    const quotaSummary = formatQuotaSummary(quotaState?.info ?? null);

    if (account.storageState === "locked") {
      parts.push("Storage locked");
    } else if (account.storageState === "invalid") {
      parts.push("Invalid saved auth");
    } else if (quotaState?.loading) {
      parts.push("Refreshing quota");
    } else if (quotaSummary) {
      parts.push(quotaSummary);
    } else if (getQuotaUnavailableMessage(quotaState?.info)) {
      parts.push(getQuotaUnavailableMessage(quotaState?.info)!);
    } else if (quotaState?.error) {
      parts.push("Quota unavailable");
    } else if (quotaState) {
      parts.push("No quota data");
    }

    this.description = parts.join(" · ");
    this.contextValue = account.source === "cloud" ? "accountCloud" : "accountLocal";

    if (account.isCurrent) {
      this.iconPath = new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"));
    } else if (account.storageState === "locked") {
      this.iconPath = new vscode.ThemeIcon("lock");
    } else if (account.storageState === "invalid") {
      this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"));
    } else {
      this.iconPath = new vscode.ThemeIcon("account");
    }

    const tooltipLines = [
      `Account: ${account.name}`,
      `Source: ${account.source}`,
      `Email: ${email}`,
      `Plan: ${plan}`,
    ];

    if (account.storageState !== "ready") {
      tooltipLines.push(account.storageMessage ?? "Saved auth is unavailable");
      this.tooltip = tooltipLines.join("\n");
      return;
    }

    if (account.auth) {
      const expiry = getTokenExpiry(account.auth);
      const tokenStatus = formatTokenExpiry(account.auth);
      tooltipLines.push(`Token: ${tokenStatus}`);
      tooltipLines.push(`Refresh token: ${formatRefreshTokenStatus(account.auth)}`);

      if (expiry && expiry.getTime() < Date.now()) {
        this.iconPath = new vscode.ThemeIcon(
          account.isCurrent ? "pass-filled" : "account",
          new vscode.ThemeColor("errorForeground")
        );
      }
    }

    if (quotaState?.loading) {
      tooltipLines.push("Quota: Refreshing");
    } else if (quotaState?.info) {
      appendQuotaTooltip(tooltipLines, quotaState.info);
      if (quotaState.info.unavailableReason) {
        tooltipLines.push(`Quota: ${quotaState.info.unavailableReason.message}`);
      }
    } else if (quotaState?.error) {
      tooltipLines.push("Quota: Failed to load");
    }

    this.tooltip = tooltipLines.join("\n");
  }
}

export class AccountTreeProvider implements vscode.TreeDataProvider<AccountTreeNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<AccountTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private timer: ReturnType<typeof setInterval> | undefined;
  private configListener: vscode.Disposable | undefined;
  private quotaState = new Map<string, QuotaState>();
  private rootItems: AccountTreeItem[] = [];
  private refreshVersion = 0;

  refresh(): void {
    this.pruneQuotaState();
    this.syncRootItems();
    this._onDidChangeTreeData.fire(undefined);
  }

  startAutoRefresh(context: vscode.ExtensionContext) {
    void this.refreshQuota().catch((error) => {
      logWarn(LOG_PREFIX, "startup-refresh-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.restartTimer();

    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codex-account-switch.quotaRefreshInterval")) {
        this.restartTimer();
        void this.refreshQuota().catch((error) => {
          logWarn(LOG_PREFIX, "config-refresh-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    });
    context.subscriptions.push(this.configListener);
  }

  async refreshQuota(targetName?: string): Promise<void> {
    const accounts = listSavedAccounts();
    const refreshVersion = ++this.refreshVersion;
    const targetNames = targetName ? new Set([targetName]) : null;
    const accountsToRefresh = targetNames
      ? accounts.filter((account) => targetNames.has(account.id) && account.storageState === "ready")
      : accounts.filter((account) => account.storageState === "ready");

    logInfo(LOG_PREFIX, "refresh-start", {
      targetName: targetName ?? null,
      refreshVersion,
      accounts: accountsToRefresh.map((account) => account.name),
    });

    this.pruneQuotaState(accounts.map((account) => account.id));
    for (const account of accountsToRefresh) {
      const previous = this.quotaState.get(account.id);
      this.quotaState.set(account.id, {
        info: previous?.info ?? null,
        error: false,
        loading: true,
        updatedAt: previous?.updatedAt ?? null,
      });
    }
    this.syncRootItems(accounts);
    this._onDidChangeTreeData.fire(undefined);

    await Promise.all(
      accountsToRefresh.map(async (account) => {
        try {
          const result = await querySavedAccountQuota(account);
          if (refreshVersion !== this.refreshVersion) {
            return;
          }

          const previous = this.quotaState.get(account.id);
          this.quotaState.set(account.id, {
            info: result.kind === "ok" ? result.info : null,
            error: result.kind !== "ok",
            loading: false,
            updatedAt: result.kind === "ok" ? Date.now() : previous?.updatedAt ?? null,
          });
          if (result.kind !== "ok") {
            logWarn(LOG_PREFIX, "refresh-result-not-ok", {
              account: account.id,
              resultKind: result.kind,
              message: "message" in result ? result.message : null,
              refreshVersion,
            });
          }
        } catch {
          if (refreshVersion !== this.refreshVersion) {
            return;
          }

          const previous = this.quotaState.get(account.id);
          this.quotaState.set(account.id, {
            info: previous?.info ?? null,
            error: true,
            loading: false,
            updatedAt: previous?.updatedAt ?? null,
          });
          logWarn(LOG_PREFIX, "refresh-result-error", {
            account: account.id,
            refreshVersion,
          });
        }
      })
    );

    if (refreshVersion === this.refreshVersion) {
      this.syncRootItems();
      this._onDidChangeTreeData.fire(undefined);
      logInfo(LOG_PREFIX, "refresh-finish", {
        targetName: targetName ?? null,
        refreshVersion,
      });
    }
  }

  getTreeItem(element: AccountTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AccountTreeNode): AccountTreeNode[] {
    if (!element) {
      return this.getRootItems();
    }

    if (element instanceof AccountDetailItem) {
      return [];
    }

    return this.getAccountDetails(element);
  }

  getParent(element: AccountTreeNode): AccountTreeNode | undefined {
    if (element instanceof AccountDetailItem) {
      return element.parent;
    }
    return undefined;
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.configListener?.dispose();
  }

  private restartTimer() {
    if (this.timer) {
      clearInterval(this.timer);
    }

    const config = vscode.workspace.getConfiguration("codex-account-switch");
    const intervalSec = config.get<number>("quotaRefreshInterval", 300);
    this.timer = setInterval(() => {
      void this.refreshQuota().catch((error) => {
        logWarn(LOG_PREFIX, "timer-refresh-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalSec * 1000);
  }

  private pruneQuotaState(validIds = listSavedAccounts().map((account) => account.id)) {
    const validIdSet = new Set(validIds);
    for (const id of this.quotaState.keys()) {
      if (!validIdSet.has(id)) {
        this.quotaState.delete(id);
      }
    }
  }

  getRootItems(): AccountTreeItem[] {
    if (this.rootItems.length === 0) {
      this.syncRootItems();
    }
    return this.rootItems;
  }

  private syncRootItems(accounts = listSavedAccounts()) {
    this.rootItems = accounts.map(
      (account) => new AccountTreeItem(account, this.quotaState.get(account.id))
    );
  }

  private getAccountDetails(parent: AccountTreeItem): AccountDetailItem[] {
    const { account, quotaState } = parent;
    const email = account.meta?.email ?? "unknown";
    const plan = account.meta?.plan ?? "unknown";
    const items: AccountDetailItem[] = [];

    const emailItem = new AccountDetailItem("Email", email, email, parent);
    emailItem.iconPath = new vscode.ThemeIcon("mail");
    items.push(emailItem);

    const sourceItem = new AccountDetailItem("Source", account.source, account.source, parent);
    sourceItem.iconPath = new vscode.ThemeIcon(account.source === "cloud" ? "cloud" : "device-desktop");
    items.push(sourceItem);

    const planItem = new AccountDetailItem("Plan", plan, plan, parent);
    planItem.iconPath = new vscode.ThemeIcon("tag");
    items.push(planItem);

    if (account.storageState !== "ready") {
      const storageItem = new AccountDetailItem(
        "Storage",
        account.storageState === "locked" ? "Locked" : "Invalid",
        account.storageMessage,
        parent
      );
      storageItem.iconPath =
        account.storageState === "locked"
          ? new vscode.ThemeIcon("lock")
          : new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"));
      items.push(storageItem);
      return items;
    }

    if (account.auth) {
      const tokenStatus = formatTokenExpiry(account.auth);
      const tokenItem = new AccountDetailItem("Token", tokenStatus, tokenStatus, parent);
      const expiry = getTokenExpiry(account.auth);

      if (expiry && expiry.getTime() < Date.now()) {
        tokenItem.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
      } else {
        tokenItem.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"));
      }
      items.push(tokenItem);

      const refreshTokenStatus = formatRefreshTokenStatus(account.auth);
      const refreshTokenItem = new AccountDetailItem(
        "Refresh token",
        refreshTokenStatus,
        refreshTokenStatus,
        parent
      );
      if (refreshTokenStatus === "available") {
        refreshTokenItem.iconPath = new vscode.ThemeIcon("refresh", new vscode.ThemeColor("charts.green"));
      } else {
        refreshTokenItem.iconPath = new vscode.ThemeIcon("circle-slash");
      }
      items.push(refreshTokenItem);
    }

    if (quotaState?.loading) {
      const loadingItem = new AccountDetailItem("Quota", "Refreshing", "Fetching quota information", parent);
      loadingItem.iconPath = new vscode.ThemeIcon("loading~spin");
      items.push(loadingItem);
      return items;
    }

    if (quotaState?.error) {
      const errorItem = new AccountDetailItem("Quota", "Failed", "Quota request failed", parent);
      errorItem.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"));
      items.push(errorItem);
      return items;
    }

    if (!quotaState?.info) {
      const emptyItem = new AccountDetailItem("Quota", "No data", "No quota data is available yet", parent);
      emptyItem.iconPath = new vscode.ThemeIcon("circle-slash");
      items.push(emptyItem);
      return items;
    }

    const info = quotaState.info;
    if (info.unavailableReason) {
      const unavailableItem = new AccountDetailItem(
        "Quota",
        info.unavailableReason.message,
        info.unavailableReason.message,
        parent
      );
      unavailableItem.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"));
      items.push(unavailableItem);
      return items;
    }

    if (info.primaryWindow) {
      const primaryItem = new AccountDetailItem(
        `${windowLabel(info.primaryWindow)} quota`,
        formatWindowDetailDescription(info.primaryWindow),
        formatWindowDetailDescription(info.primaryWindow),
        parent
      );
      primaryItem.iconPath = quotaIcon(info.primaryWindow.usedPercent);
      items.push(primaryItem);
    }

    if (info.secondaryWindow) {
      const secondaryItem = new AccountDetailItem(
        `${windowLabel(info.secondaryWindow)} quota`,
        formatWindowDetailDescription(info.secondaryWindow),
        formatWindowDetailDescription(info.secondaryWindow),
        parent
      );
      secondaryItem.iconPath = quotaIcon(info.secondaryWindow.usedPercent);
      items.push(secondaryItem);
    }

    for (const additional of info.additional) {
      if (additional.primary) {
        const primaryAdditionalItem = new AccountDetailItem(
          additional.name,
          formatWindowDetailDescription(additional.primary),
          formatWindowDetailDescription(additional.primary),
          parent
        );
        primaryAdditionalItem.iconPath = quotaIcon(additional.primary.usedPercent);
        items.push(primaryAdditionalItem);
      }

      if (additional.secondary) {
        const secondaryAdditionalItem = new AccountDetailItem(
          `${additional.name} secondary`,
          formatWindowDetailDescription(additional.secondary),
          formatWindowDetailDescription(additional.secondary),
          parent
        );
        secondaryAdditionalItem.iconPath = quotaIcon(additional.secondary.usedPercent);
        items.push(secondaryAdditionalItem);
      }
    }

    if (info.codeReview) {
      const codeReviewItem = new AccountDetailItem(
        "Code review",
        formatWindowDetailDescription(info.codeReview),
        formatWindowDetailDescription(info.codeReview),
        parent
      );
      codeReviewItem.iconPath = quotaIcon(info.codeReview.usedPercent);
      items.push(codeReviewItem);
    }

    if (info.credits?.hasCredits) {
      const creditsItem = new AccountDetailItem(
        "Extra credits",
        "Available",
        "This account has extra credits",
        parent
      );
      creditsItem.iconPath = new vscode.ThemeIcon("credit-card", new vscode.ThemeColor("charts.green"));
      items.push(creditsItem);
    }

    return items;
  }
}

