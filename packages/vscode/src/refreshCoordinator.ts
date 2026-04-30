import * as vscode from "vscode";
import { AccountTreeProvider } from "./accountTree";
import { logWarn, startPerformanceLog } from "./log";
import { ProviderTreeProvider } from "./providerTree";
import { createSavedEntriesSnapshot, SavedAccountQuotaQueryContext } from "./savedEntries";
import { StatusBarManager } from "./statusBar";

const LOG_PREFIX = "[codex-account-switch:vscode:refreshCoordinator]";
let refreshSequence = 0;

export type RefreshReason =
  | "activate"
  | "manual"
  | "timer"
  | "config-change"
  | "provider-switch"
  | "account-switch";

interface PreparedConfigurationRefresh {
  skipQuota: boolean;
  targetIds?: string[];
}

interface ScheduledQuotaRefresh {
  reason: RefreshReason;
  fullRefresh: boolean;
  autoTargetCurrentSelection: boolean;
}

export class RefreshCoordinator implements vscode.Disposable {
  private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private configListener: vscode.Disposable | undefined;
  private scheduledTimer: ReturnType<typeof setTimeout> | undefined;
  private runningRefresh: Promise<void> | null = null;
  private lastAutoRefreshAccountId: string | null = null;
  private pendingFullRefresh = false;
  private pendingAutoRefresh = false;
  private pendingTargetIds = new Set<string>();
  private pendingReason: RefreshReason = "manual";
  private preparedConfigurationRefresh: PreparedConfigurationRefresh | null = null;

  constructor(
    private readonly accountTree: AccountTreeProvider,
    private readonly providerTree: ProviderTreeProvider,
    private readonly statusBar: StatusBarManager,
  ) {}

  startAutoRefresh(context: vscode.ExtensionContext): void {
    this.restartAutoRefreshTimer();
    this.configListener?.dispose();
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codex-account-switch.quotaRefreshInterval")) {
        this.restartAutoRefreshTimer();
      }
    });
    context.subscriptions.push(this.configListener);
  }

  refreshViews(reason: RefreshReason = "manual"): void {
    const perf = startPerformanceLog(LOG_PREFIX, "refreshCoordinator.refreshViews", {
      reason,
    });
    const snapshot = createSavedEntriesSnapshot();
    this.accountTree.refresh(snapshot);
    perf.mark("account-tree-refresh");
    this.providerTree.refresh();
    perf.mark("provider-tree-refresh");
    void this.statusBar.refreshNow({ skipQuota: true, snapshot, reason }).catch((error) => {
      logWarn(LOG_PREFIX, "refresh-views-statusBar-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      perf.fail(error);
    });
    perf.finish();
  }

  scheduleQuotaRefresh(options?: { targetIds?: Iterable<string>; reason?: RefreshReason; fullRefresh?: boolean }): void {
    const normalizedTargetIds = options?.targetIds ? [...options.targetIds] : undefined;
    const reason = options?.reason ?? "manual";
    const perf = startPerformanceLog(LOG_PREFIX, "refreshCoordinator.scheduleQuotaRefresh", {
      targetCount: normalizedTargetIds?.length ?? null,
      reason,
      fullRefresh: options?.fullRefresh ?? false,
    });
    this.enqueueQuotaRefresh({
      targetIds: normalizedTargetIds,
      reason,
      fullRefresh: options?.fullRefresh ?? false,
      autoTargetCurrentSelection: !normalizedTargetIds && !(options?.fullRefresh ?? false),
    });
    perf.mark("enqueue");
    this.ensureScheduled();
    perf.finish({
      pendingFullRefresh: this.pendingFullRefresh,
      pendingAutoRefresh: this.pendingAutoRefresh,
      pendingTargetCount: this.pendingTargetIds.size,
      reason: this.pendingReason,
    });
  }

  prepareConfigurationRefresh(options?: { skipQuota?: boolean; targetIds?: Iterable<string> }): void {
    const targetIds = options?.targetIds
      ? [...options.targetIds].filter((id): id is string => typeof id === "string" && id.length > 0)
      : undefined;
    this.preparedConfigurationRefresh = {
      skipQuota: options?.skipQuota ?? false,
      ...(targetIds && targetIds.length > 0 ? { targetIds } : {}),
    };
  }

  consumePreparedConfigurationRefresh(): PreparedConfigurationRefresh | null {
    const prepared = this.preparedConfigurationRefresh;
    this.preparedConfigurationRefresh = null;
    return prepared;
  }

  clearPreparedConfigurationRefresh(): void {
    this.preparedConfigurationRefresh = null;
  }

  dispose(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = undefined;
    }
    this.configListener?.dispose();
    this.configListener = undefined;
  }

  private restartAutoRefreshTimer(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }

    const intervalSec = vscode.workspace.getConfiguration("codex-account-switch").get<number>("quotaRefreshInterval", 30);
    if (!Number.isFinite(intervalSec)) {
      return;
    }
    const effectiveIntervalSec = Math.max(intervalSec, 5);

    this.autoRefreshTimer = setInterval(() => {
      this.scheduleQuotaRefresh({
        reason: "timer",
      });
    }, effectiveIntervalSec * 1000);
  }

  private enqueueQuotaRefresh(request: ScheduledQuotaRefresh & { targetIds?: Iterable<string> }): void {
    this.pendingReason = request.reason;
    if (request.fullRefresh) {
      this.pendingFullRefresh = true;
      this.pendingAutoRefresh = false;
      this.pendingTargetIds.clear();
      return;
    }

    if (request.autoTargetCurrentSelection) {
      if (!this.pendingFullRefresh) {
        this.pendingAutoRefresh = true;
      }
      return;
    }

    if (this.pendingFullRefresh) {
      return;
    }

    this.pendingAutoRefresh = false;
    for (const id of request.targetIds ?? []) {
      if (typeof id === "string" && id.length > 0) {
        this.pendingTargetIds.add(id);
      }
    }
  }

  private ensureScheduled(): void {
    if (this.scheduledTimer || this.runningRefresh) {
      return;
    }

    this.scheduledTimer = setTimeout(() => {
      this.scheduledTimer = undefined;
      void this.flushQuotaRefresh();
    }, 0);
  }

  private async flushQuotaRefresh(): Promise<void> {
    const perf = startPerformanceLog(LOG_PREFIX, "refreshCoordinator.flushQuotaRefresh");
    if (this.runningRefresh) {
      perf.finish({
        result: "already-running",
      });
      return;
    }

    const pendingReason = this.pendingReason;
    const pendingFullRefresh = this.pendingFullRefresh;
    const pendingAutoRefresh = this.pendingAutoRefresh;
    const explicitTargetIds = this.pendingTargetIds.size > 0 ? [...this.pendingTargetIds] : undefined;
    this.pendingFullRefresh = false;
    this.pendingAutoRefresh = false;
    this.pendingTargetIds.clear();
    perf.mark("drain-pending-queue", {
      targetCount: explicitTargetIds?.length ?? null,
      reason: pendingReason,
      pendingFullRefresh,
      pendingAutoRefresh,
    });

    const refreshId = `refresh-${++refreshSequence}`;
    const snapshot = createSavedEntriesSnapshot();
    const queryContext: SavedAccountQuotaQueryContext = {
      snapshot,
      sharedQueries: new Map(),
    };
    const currentSelectionAccountId = this.getCurrentSelectionAccountId(snapshot);
    let targetIds: string[] | undefined;
    if (pendingFullRefresh) {
      targetIds = snapshot.accounts
        .filter((account) => account.storageState === "ready")
        .map((account) => account.id);
    } else if (explicitTargetIds && explicitTargetIds.length > 0) {
      targetIds = explicitTargetIds;
    } else if (pendingAutoRefresh && pendingReason === "timer") {
      targetIds = this.getNextAutoRefreshTargetIds(snapshot);
    } else if (pendingAutoRefresh && snapshot.selection.kind === "account") {
      targetIds = currentSelectionAccountId ? [currentSelectionAccountId] : [];
    } else {
      targetIds = [];
    }

    if (
      pendingReason !== "timer"
      && currentSelectionAccountId
      && targetIds.includes(currentSelectionAccountId)
    ) {
      this.lastAutoRefreshAccountId = currentSelectionAccountId;
    }

    if (targetIds.length === 0) {
      await this.statusBar.refreshNow({
        snapshot,
        skipQuota: snapshot.selection.kind === "provider" || pendingReason === "timer",
        queryContext,
        reason: pendingReason,
        refreshId,
      });
      perf.finish({
        reason: pendingReason,
        refreshId,
        effectiveCount: 0,
        result: "empty-targets",
      });
      return;
    }

    const shouldRefreshStatusBarQuota =
      pendingReason !== "timer"
      || (currentSelectionAccountId != null && targetIds.includes(currentSelectionAccountId));

    const refreshPromise = Promise.all([
      this.accountTree.refreshQuota(targetIds, {
        snapshot,
        queryContext,
        reason: pendingReason,
        refreshId,
      }),
      shouldRefreshStatusBarQuota
        ? this.statusBar.refreshNow({
          snapshot,
          queryContext,
          reason: pendingReason,
          refreshId,
        })
        : Promise.resolve(),
    ])
      .then(() => {
        perf.finish({
          targetCount: targetIds?.length ?? null,
          effectiveCount: targetIds?.length ?? 0,
          reason: pendingReason,
          refreshId,
        });
        return;
      })
      .catch((error) => {
        logWarn(LOG_PREFIX, "quota-refresh-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        perf.fail(error, {
          targetCount: targetIds?.length ?? null,
          reason: pendingReason,
          refreshId,
        });
      })
      .finally(() => {
        this.runningRefresh = null;
        if (this.pendingFullRefresh || this.pendingAutoRefresh || this.pendingTargetIds.size > 0) {
          this.ensureScheduled();
        }
      });

    this.runningRefresh = refreshPromise;
    await refreshPromise;
  }

  private getCurrentSelectionAccountId(snapshot: ReturnType<typeof createSavedEntriesSnapshot>): string | null {
    if (snapshot.selection.kind !== "account") {
      return null;
    }
    const current = snapshot.bySourceAndName.get(`${snapshot.selection.source}:${snapshot.selection.name}`);
    return current?.id ?? null;
  }

  private getNextAutoRefreshTargetIds(snapshot: ReturnType<typeof createSavedEntriesSnapshot>): string[] {
    const readyAccounts = snapshot.accounts
      .filter((account) => account.storageState === "ready")
      .sort((left, right) => {
        const sourceCompare = left.source.localeCompare(right.source);
        return sourceCompare !== 0 ? sourceCompare : left.name.localeCompare(right.name);
      });

    if (readyAccounts.length === 0) {
      return [];
    }

    const fallbackCursorId = this.lastAutoRefreshAccountId ?? this.getCurrentSelectionAccountId(snapshot);
    if (fallbackCursorId) {
      const currentIndex = readyAccounts.findIndex((account) => account.id === fallbackCursorId);
      if (currentIndex >= 0) {
        const next = readyAccounts[(currentIndex + 1) % readyAccounts.length];
        this.lastAutoRefreshAccountId = next.id;
        return [next.id];
      }
    }

    this.lastAutoRefreshAccountId = readyAccounts[0].id;
    return [readyAccounts[0].id];
  }
}
