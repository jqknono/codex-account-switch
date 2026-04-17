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
  private scheduledTimer: ReturnType<typeof setTimeout> | undefined;
  private runningRefresh: Promise<void> | null = null;
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
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = undefined;
    }
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
    let targetIds: string[] | undefined;
    if (pendingFullRefresh) {
      targetIds = snapshot.accounts
        .filter((account) => account.storageState === "ready")
        .map((account) => account.id);
    } else if (explicitTargetIds && explicitTargetIds.length > 0) {
      targetIds = explicitTargetIds;
    } else if (pendingAutoRefresh && snapshot.selection.kind === "account") {
      const current = snapshot.bySourceAndName.get(`${snapshot.selection.source}:${snapshot.selection.name}`);
      targetIds = current ? [current.id] : [];
    } else {
      targetIds = [];
    }

    if (targetIds.length === 0) {
      await this.statusBar.refreshNow({
        snapshot,
        skipQuota: snapshot.selection.kind === "provider",
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

    const refreshPromise = Promise.all([
      this.accountTree.refreshQuota(targetIds, {
        snapshot,
        queryContext,
        reason: pendingReason,
        refreshId,
      }),
      this.statusBar.refreshNow({
        snapshot,
        queryContext,
        reason: pendingReason,
        refreshId,
      }),
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
        if (this.pendingFullRefresh || this.pendingTargetIds.size > 0) {
          this.ensureScheduled();
        }
      });

    this.runningRefresh = refreshPromise;
    await refreshPromise;
  }
}
