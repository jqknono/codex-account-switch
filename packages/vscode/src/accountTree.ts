import * as vscode from "vscode";
import {
  AuthFile,
  getTokenExpiry,
  formatTokenExpiry,
  QuotaInfo,
  WindowInfo,
} from "@codex-account-switch/core";
import { logInfo, logWarn, startPerformanceLog } from "./log";
import {
  createSavedEntriesSnapshot,
  getSavedCurrentSelection,
  listSavedAccounts,
  querySavedAccountQuota,
  SavedAccountInfo,
  SavedAccountQuotaQueryContext,
  SavedEntriesSnapshot,
} from "./savedEntries";

interface QuotaState {
  info: QuotaInfo | null;
  loading: boolean;
  error: boolean;
  updatedAt: number | null;
}

export type AccountTreeNode = AccountGroupItem | AccountTreeItem | AccountDetailItem;
const LOG_PREFIX = "[codex-account-switch:vscode:accountTree]";
const ACCOUNT_REFRESH_CONCURRENCY = 4;
const SLOW_ACCOUNT_THRESHOLD_MS = 3000;

interface AccountTreeRefreshOptions {
  snapshot?: SavedEntriesSnapshot;
  queryContext?: SavedAccountQuotaQueryContext;
  reason?: string;
  refreshId?: string;
  concurrency?: number;
}

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

function formatLastRefresh(auth: AuthFile): string {
  if (typeof auth.last_refresh === "string" && auth.last_refresh.trim()) {
    return auth.last_refresh.trim();
  }
  const refreshToken = auth.tokens?.refresh_token;
  return typeof refreshToken === "string" && refreshToken.trim() ? "Never" : "Unavailable";
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

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * fraction) - 1));
  return sortedValues[index];
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, concurrency);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex]);
    }
  });
  await Promise.all(runners);
}

export class AccountDetailItem extends vscode.TreeItem {
  constructor(
    label: string,
    description?: string,
    tooltip?: string,
    public readonly parent?: AccountTreeItem,
    public readonly rawValue?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = "accountDetail";
  }
}

export class AccountGroupItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly children: AccountTreeItem[],
    iconId: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${children.length}`;
    this.contextValue = "accountGroup";
    this.iconPath = new vscode.ThemeIcon(iconId);
    for (const child of children) {
      child.groupParent = this;
    }
  }
}

export class AccountTreeItem extends vscode.TreeItem {
  groupParent?: AccountGroupItem;

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
    this.contextValue =
      account.source === "cloud" && account.storageState === "locked"
        ? "accountCloudLocked"
        : account.source === "cloud"
          ? "accountCloud"
          : "accountLocal";

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
    if (account.source === "cloud" && (account.syncVersion != null || account.syncUpdatedAt)) {
      tooltipLines.push(`Sync version: ${account.syncVersion ?? "legacy"}`);
      tooltipLines.push(`Updated: ${account.syncUpdatedAt ?? "unknown"}`);
      tooltipLines.push(`Current device: ${account.currentDeviceName ?? "unknown"}`);
      tooltipLines.push(`Auto-refresh device: ${account.effectiveAutoRefreshDeviceName ?? "none"}`);
      tooltipLines.push(`Auto-refresh here: ${account.autoRefreshAllowed ? "Yes" : "No"}`);
    }

    if (account.storageState !== "ready") {
      tooltipLines.push(account.storageMessage ?? "Saved auth is unavailable");
      this.tooltip = tooltipLines.join("\n");
      return;
    }

    if (account.auth) {
      const expiry = getTokenExpiry(account.auth);
      const tokenStatus = formatTokenExpiry(account.auth);
      tooltipLines.push(`Token: ${tokenStatus}`);
      tooltipLines.push(`Last refresh: ${formatLastRefresh(account.auth)}`);

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
  private rootItems: AccountGroupItem[] = [];
  private refreshVersion = 0;

  refresh(snapshot?: SavedEntriesSnapshot): void {
    const perf = startPerformanceLog(LOG_PREFIX, "accountTree.refresh");
    try {
      const currentSnapshot = snapshot ?? createSavedEntriesSnapshot();
      this.pruneQuotaState(currentSnapshot.accounts.map((account) => account.id));
      perf.mark("prune-quota-state");
      this.syncRootItems(currentSnapshot.accounts);
      perf.mark("sync-root-items");
      this._onDidChangeTreeData.fire(undefined);
      perf.finish();
    } catch (error) {
      perf.fail(error);
      throw error;
    }
  }

  startAutoRefresh(context: vscode.ExtensionContext) {
    this.restartTimer();

    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codex-account-switch.quotaRefreshInterval")) {
        this.restartTimer();
      }
    });
    context.subscriptions.push(this.configListener);
  }

  async refreshQuota(targetIds?: Iterable<string>, options: AccountTreeRefreshOptions = {}): Promise<void> {
    const normalizedTargetIds = targetIds ? [...targetIds] : undefined;
    const perf = startPerformanceLog(LOG_PREFIX, "accountTree.refreshQuota", {
      targetCount: normalizedTargetIds?.length ?? null,
      reason: options.reason ?? null,
      refreshId: options.refreshId ?? null,
    });
    try {
      const snapshot = options.snapshot ?? createSavedEntriesSnapshot();
      const accounts = snapshot.accounts;
      perf.mark("list-saved-accounts", {
        accountCount: accounts.length,
        selectionKind: snapshot.selection.kind,
      });
      const refreshVersion = ++this.refreshVersion;
      const targetIdSet = normalizedTargetIds ? new Set(normalizedTargetIds) : null;
      const accountsToRefresh = targetIdSet
        ? accounts.filter((account) => targetIdSet.has(account.id) && account.storageState === "ready")
        : accounts.filter((account) => account.storageState === "ready");
      const notReadyCount = targetIdSet
        ? accounts.filter((account) => targetIdSet.has(account.id) && account.storageState !== "ready").length
        : 0;
      const requestedCount = targetIdSet?.size ?? accountsToRefresh.length;
      perf.mark("filter-target-accounts", {
        refreshVersion,
        requestedCount,
        effectiveCount: accountsToRefresh.length,
        skippedCount: requestedCount - accountsToRefresh.length,
      });

      logInfo(LOG_PREFIX, "refresh-start", {
        targetIds: targetIdSet ? [...targetIdSet] : null,
        refreshVersion,
        refreshId: options.refreshId ?? null,
        reason: options.reason ?? null,
        selectionKind: snapshot.selection.kind,
        requestedCount,
        effectiveCount: accountsToRefresh.length,
        skippedCount: requestedCount - accountsToRefresh.length,
      });

      this.pruneQuotaState(accounts.map((account) => account.id));
      perf.mark("prune-quota-state");
      for (const account of accountsToRefresh) {
        const previous = this.quotaState.get(account.id);
        this.quotaState.set(account.id, {
          info: previous?.info ?? null,
          error: false,
          loading: true,
          updatedAt: previous?.updatedAt ?? null,
        });
      }
      perf.mark("set-loading-state");
      this.syncRootItems(accounts);
      perf.mark("sync-root-items-loading");
      this._onDidChangeTreeData.fire(undefined);
      perf.mark("fire-tree-loading");

      const accountDurations: number[] = [];
      const slowestAccounts: Array<{ account: string; source: string; durationMs: number }> = [];
      let okCount = 0;
      let errorCount = 0;
      let inflightReuseCount = 0;
      const concurrency = options.concurrency ?? ACCOUNT_REFRESH_CONCURRENCY;

      await runWithConcurrency(accountsToRefresh, concurrency, async (account) => {
        const startedAt = Date.now();
        try {
          const accountPerf = startPerformanceLog(
            LOG_PREFIX,
            "accountTree.refreshQuota.account",
            {
              account: account.name,
              source: account.source,
              refreshVersion,
              refreshId: options.refreshId ?? null,
            },
            {
              mode: "adaptive",
              slowThresholdMs: SLOW_ACCOUNT_THRESHOLD_MS,
            },
          );
          const result = await querySavedAccountQuota(account, options.queryContext, {
            reason: options.reason,
          });
          const durationMs = Date.now() - startedAt;
          accountDurations.push(durationMs);
          slowestAccounts.push({
            account: account.name,
            source: account.source,
            durationMs,
          });
          if (slowestAccounts.length > 5) {
            slowestAccounts.sort((left, right) => right.durationMs - left.durationMs);
            slowestAccounts.length = 5;
          }
          if ((result as { source?: string }).source === "reused" || (result as { reusedInflight?: boolean }).reusedInflight) {
            inflightReuseCount += 1;
          }
          accountPerf.finish({
            resultKind: result.kind,
            source: (result as { source?: string }).source ?? "direct",
          });
          if (result.kind === "ok") {
            okCount += 1;
          } else {
            errorCount += 1;
          }
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
              refreshId: options.refreshId ?? null,
            });
          }
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          accountDurations.push(durationMs);
          slowestAccounts.push({
            account: account.name,
            source: account.source,
            durationMs,
          });
          if (slowestAccounts.length > 5) {
            slowestAccounts.sort((left, right) => right.durationMs - left.durationMs);
            slowestAccounts.length = 5;
          }
          errorCount += 1;
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
            refreshId: options.refreshId ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
          perf.mark("account-refresh-error", {
            account: account.name,
          });
        }

        if (refreshVersion === this.refreshVersion) {
          this.syncRootItems(accounts, { logPerformance: false });
          this._onDidChangeTreeData.fire(undefined);
        }
      });
      perf.mark("await-account-queries");

      if (refreshVersion === this.refreshVersion) {
        this.syncRootItems(accounts);
        perf.mark("sync-root-items-final");
        this._onDidChangeTreeData.fire(undefined);
        perf.mark("fire-tree-final");
        logInfo(LOG_PREFIX, "refresh-finish", {
          targetIds: targetIdSet ? [...targetIdSet] : null,
          refreshVersion,
          refreshId: options.refreshId ?? null,
          reason: options.reason ?? null,
        });
      }
      const sortedDurations = [...accountDurations].sort((left, right) => left - right);
      slowestAccounts.sort((left, right) => right.durationMs - left.durationMs);
      perf.finish({
        refreshVersion,
        reason: options.reason ?? null,
        requestedCount,
        effectiveCount: accountsToRefresh.length,
        skippedCount: requestedCount - accountsToRefresh.length,
        concurrency,
        okCount,
        errorCount,
        notReadyCount,
        inflightReuseCount,
        cacheReuseCount: 0,
        p50Ms: percentile(sortedDurations, 0.5),
        p95Ms: percentile(sortedDurations, 0.95),
        maxMs: sortedDurations[sortedDurations.length - 1] ?? 0,
        slowestAccountsTopN: slowestAccounts,
      });
    } catch (error) {
      perf.fail(error);
      throw error;
    }
  }

  getTreeItem(element: AccountTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AccountTreeNode): AccountTreeNode[] {
    if (!element) {
      return this.getRootItems();
    }

    if (element instanceof AccountGroupItem) {
      return element.children;
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
    if (element instanceof AccountTreeItem) {
      return element.groupParent;
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
      const snapshot = createSavedEntriesSnapshot();
      const selection = getSavedCurrentSelection(snapshot);
      const targetIds = selection.kind === "account"
        ? [snapshot.bySourceAndName.get(`${selection.source}:${selection.name}`)?.id].filter((id): id is string => Boolean(id))
        : undefined;
      if (!targetIds || targetIds.length === 0) {
        return;
      }
      void this.refreshQuota(targetIds, {
        snapshot,
        reason: "timer",
      }).catch((error) => {
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

  getRootItems(): AccountGroupItem[] {
    if (this.rootItems.length === 0) {
      this.syncRootItems(createSavedEntriesSnapshot().accounts);
    }
    return this.rootItems;
  }

  private syncRootItems(accounts = listSavedAccounts(), options: { logPerformance?: boolean } = {}) {
    const perf = options.logPerformance === false
      ? null
      : startPerformanceLog(LOG_PREFIX, "accountTree.syncRootItems", {
        accountCount: accounts.length,
      });
    const quotaFailed: AccountTreeItem[] = [];
    const local: AccountTreeItem[] = [];
    const cloud: AccountTreeItem[] = [];

    for (const account of accounts) {
      const item = new AccountTreeItem(account, this.quotaState.get(account.id));
      if (this.quotaState.get(account.id)?.error) {
        quotaFailed.push(item);
      } else if (account.source === "cloud") {
        cloud.push(item);
      } else {
        local.push(item);
      }
    }

    const groups: AccountGroupItem[] = [];
    if (quotaFailed.length > 0) {
      groups.push(new AccountGroupItem("Quota Failed", quotaFailed, "warning"));
    }
    if (local.length > 0) {
      groups.push(new AccountGroupItem("Local Accounts", local, "device-desktop"));
    }
    if (cloud.length > 0) {
      groups.push(new AccountGroupItem("Cloud Accounts", cloud, "cloud"));
    }
    this.rootItems = groups;
    perf?.finish({
      quotaFailedCount: quotaFailed.length,
      localCount: local.length,
      cloudCount: cloud.length,
      groupCount: groups.length,
    });
  }

  private getAccountDetails(parent: AccountTreeItem): AccountDetailItem[] {
    const { account, quotaState } = parent;
    const email = account.meta?.email ?? "unknown";
    const plan = account.meta?.plan ?? "unknown";
    const items: AccountDetailItem[] = [];

    const emailItem = new AccountDetailItem("Email", email, email, parent, email);
    if (email !== "unknown") {
      emailItem.contextValue = "accountCopyableField";
    }
    emailItem.iconPath = new vscode.ThemeIcon("mail");
    items.push(emailItem);

    const sourceItem = new AccountDetailItem("Source", account.source, account.source, parent);
    sourceItem.iconPath = new vscode.ThemeIcon(account.source === "cloud" ? "cloud" : "device-desktop");
    items.push(sourceItem);

    if (account.source === "cloud" && (account.syncVersion != null || account.syncUpdatedAt)) {
      const syncVersionItem = new AccountDetailItem(
        "Sync version",
        String(account.syncVersion ?? "legacy"),
        String(account.syncVersion ?? "legacy"),
        parent,
      );
      syncVersionItem.iconPath = new vscode.ThemeIcon("versions");
      items.push(syncVersionItem);

      const updatedItem = new AccountDetailItem(
        "Updated",
        account.syncUpdatedAt ?? "unknown",
        account.syncUpdatedAt ?? "unknown",
        parent,
      );
      updatedItem.iconPath = new vscode.ThemeIcon("history");
      items.push(updatedItem);

      const currentDeviceItem = new AccountDetailItem(
        "Current device",
        account.currentDeviceName ?? "unknown",
        account.currentDeviceName ?? "unknown",
        parent,
      );
      currentDeviceItem.iconPath = new vscode.ThemeIcon("device-desktop");
      items.push(currentDeviceItem);

      const autoRefreshDeviceItem = new AccountDetailItem(
        "Auto-refresh device",
        account.effectiveAutoRefreshDeviceName ?? "none",
        account.effectiveAutoRefreshDeviceName ?? "none",
        parent,
      );
      autoRefreshDeviceItem.iconPath = new vscode.ThemeIcon("sync");
      items.push(autoRefreshDeviceItem);

      const autoRefreshAllowedItem = new AccountDetailItem(
        "Auto-refresh here",
        account.autoRefreshAllowed ? "Yes" : "No",
        account.autoRefreshAllowed ? "This device can automatically persist refreshed cloud tokens" : "This device cannot automatically persist refreshed cloud tokens",
        parent,
      );
      autoRefreshAllowedItem.iconPath = new vscode.ThemeIcon(account.autoRefreshAllowed ? "check" : "circle-slash");
      items.push(autoRefreshAllowedItem);
    }

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

      const lastRefresh = formatLastRefresh(account.auth);
      const lastRefreshItem = new AccountDetailItem(
        "Last refresh",
        lastRefresh,
        lastRefresh,
        parent
      );
      lastRefreshItem.iconPath = lastRefresh === "Unavailable"
        ? new vscode.ThemeIcon("circle-slash")
        : new vscode.ThemeIcon("history", new vscode.ThemeColor("charts.green"));
      items.push(lastRefreshItem);
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

