import * as vscode from "vscode";
import {
  listAccounts,
  AccountInfo,
  getTokenExpiry,
  formatTokenExpiry,
  queryQuota,
  QuotaInfo,
  WindowInfo,
} from "@codex-account-switch/core";

interface QuotaState {
  info: QuotaInfo | null;
  loading: boolean;
  error: boolean;
  updatedAt: number | null;
}

export type AccountTreeNode = AccountTreeItem | AccountDetailItem;

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
  constructor(public readonly account: AccountInfo, public readonly quotaState?: QuotaState) {
    super(account.name, vscode.TreeItemCollapsibleState.Expanded);

    const email = account.meta?.email ?? "unknown";
    const plan = account.meta?.plan ?? "unknown";
    const parts: string[] = [];
    const quotaSummary = formatQuotaSummary(quotaState?.info ?? null);

    if (quotaState?.loading) {
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
    this.contextValue = "account";

    if (account.isCurrent) {
      this.iconPath = new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"));
    } else {
      this.iconPath = new vscode.ThemeIcon("account");
    }

    const tooltipLines = [`Account: ${account.name}`, `Email: ${email}`, `Plan: ${plan}`];

    if (account.auth) {
      const expiry = getTokenExpiry(account.auth);
      const tokenStatus = formatTokenExpiry(account.auth);
      tooltipLines.push(`Token: ${tokenStatus}`);

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
    void this.refreshQuota();
    this.restartTimer();

    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codex-account-switch.quotaRefreshInterval")) {
        this.restartTimer();
        void this.refreshQuota();
      }
    });
    context.subscriptions.push(this.configListener);
  }

  async refreshQuota(targetName?: string): Promise<void> {
    const accounts = listAccounts();
    const refreshVersion = ++this.refreshVersion;
    const targetNames = targetName ? new Set([targetName]) : null;
    const accountsToRefresh = targetNames
      ? accounts.filter((account) => targetNames.has(account.name))
      : accounts;

    this.pruneQuotaState(accounts.map((account) => account.name));
    for (const account of accountsToRefresh) {
      const previous = this.quotaState.get(account.name);
      this.quotaState.set(account.name, {
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
          const result = await queryQuota(account.name);
          if (refreshVersion !== this.refreshVersion) {
            return;
          }

          const previous = this.quotaState.get(account.name);
          this.quotaState.set(account.name, {
            info: result.kind === "ok" ? result.info : null,
            error: result.kind !== "ok",
            loading: false,
            updatedAt: result.kind === "ok" ? Date.now() : previous?.updatedAt ?? null,
          });
        } catch {
          if (refreshVersion !== this.refreshVersion) {
            return;
          }

          const previous = this.quotaState.get(account.name);
          this.quotaState.set(account.name, {
            info: previous?.info ?? null,
            error: true,
            loading: false,
            updatedAt: previous?.updatedAt ?? null,
          });
        }
      })
    );

    if (refreshVersion === this.refreshVersion) {
      this.syncRootItems(accounts);
      this._onDidChangeTreeData.fire(undefined);
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
    this.timer = setInterval(() => void this.refreshQuota(), intervalSec * 1000);
  }

  private pruneQuotaState(validNames = listAccounts().map((account) => account.name)) {
    const validNameSet = new Set(validNames);
    for (const name of this.quotaState.keys()) {
      if (!validNameSet.has(name)) {
        this.quotaState.delete(name);
      }
    }
  }

  getRootItems(): AccountTreeItem[] {
    if (this.rootItems.length === 0) {
      this.syncRootItems();
    }
    return this.rootItems;
  }

  private syncRootItems(accounts = listAccounts()) {
    this.rootItems = accounts.map(
      (account) => new AccountTreeItem(account, this.quotaState.get(account.name))
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

    const planItem = new AccountDetailItem("Plan", plan, plan, parent);
    planItem.iconPath = new vscode.ThemeIcon("tag");
    items.push(planItem);

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

