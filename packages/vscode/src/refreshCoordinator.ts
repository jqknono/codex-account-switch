import * as vscode from "vscode";
import { AccountTreeProvider } from "./accountTree";
import { logWarn } from "./log";
import { ProviderTreeProvider } from "./providerTree";
import { StatusBarManager } from "./statusBar";

const LOG_PREFIX = "[codex-account-switch:vscode:refreshCoordinator]";

interface PreparedConfigurationRefresh {
  skipQuota: boolean;
  targetIds?: string[];
}

export class RefreshCoordinator implements vscode.Disposable {
  private scheduledTimer: ReturnType<typeof setTimeout> | undefined;
  private runningRefresh: Promise<void> | null = null;
  private pendingFullRefresh = false;
  private pendingTargetIds = new Set<string>();
  private preparedConfigurationRefresh: PreparedConfigurationRefresh | null = null;

  constructor(
    private readonly accountTree: AccountTreeProvider,
    private readonly providerTree: ProviderTreeProvider,
    private readonly statusBar: StatusBarManager,
  ) {}

  refreshViews(): void {
    this.accountTree.refresh();
    this.providerTree.refresh();
    void this.statusBar.refreshNow({ skipQuota: true }).catch((error) => {
      logWarn(LOG_PREFIX, "refresh-views-statusBar-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  scheduleQuotaRefresh(targetIds?: Iterable<string>): void {
    this.enqueueQuotaRefresh(targetIds);
    this.ensureScheduled();
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

  private enqueueQuotaRefresh(targetIds?: Iterable<string>): void {
    if (!targetIds) {
      this.pendingFullRefresh = true;
      this.pendingTargetIds.clear();
      return;
    }

    if (this.pendingFullRefresh) {
      return;
    }

    for (const id of targetIds) {
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
    if (this.runningRefresh) {
      return;
    }

    const targetIds = this.pendingFullRefresh ? undefined : [...this.pendingTargetIds];
    this.pendingFullRefresh = false;
    this.pendingTargetIds.clear();

    if (targetIds && targetIds.length === 0) {
      return;
    }

    const refreshPromise = Promise.all([
      this.accountTree.refreshQuota(targetIds),
      this.statusBar.refreshNow(),
    ])
      .then(() => {
        return;
      })
      .catch((error) => {
        logWarn(LOG_PREFIX, "quota-refresh-failed", {
          error: error instanceof Error ? error.message : String(error),
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
