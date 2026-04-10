import * as vscode from "vscode";
import { QuotaInfo, WindowInfo, getModeDisplayName } from "@codex-account-switch/core";
import { logInfo, logWarn, startPerformanceLog } from "./log";
import { getSavedAccountEntry, getSavedCurrentSelection, querySavedAccountQuota } from "./savedEntries";
const LOG_PREFIX = "[codex-account-switch:vscode:statusBar]";

function windowLabel(window: WindowInfo): string {
  if (window.windowSeconds == null) return "quota";
  const hours = window.windowSeconds / 3600;
  if (hours <= 5) return "5h";
  if (hours <= 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function isFiveHourWindow(window: WindowInfo): boolean {
  if (window.windowSeconds == null) return false;
  return window.windowSeconds / 3600 <= 5;
}

function getPreferredStatusWindow(info: QuotaInfo): WindowInfo | null {
  if (info.primaryWindow && isFiveHourWindow(info.primaryWindow)) {
    return info.primaryWindow;
  }
  if (info.secondaryWindow && isFiveHourWindow(info.secondaryWindow)) {
    return info.secondaryWindow;
  }
  return info.primaryWindow ?? info.secondaryWindow ?? null;
}

export class StatusBarManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private configListener: vscode.Disposable | undefined;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = "codex-account-switch.refreshQuota";
    this.statusBarItem.name = "Codex Account Switch Quota";
    this.updateVisibility();
  }

  private isVisibleEnabled(): boolean {
    return vscode.workspace.getConfiguration("codex-account-switch").get<boolean>("showStatusBar", true);
  }

  private updateVisibility() {
    if (this.isVisibleEnabled()) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  startAutoRefresh(context: vscode.ExtensionContext) {
    if (this.isVisibleEnabled()) {
      void this.refreshNow().catch((error) => {
        logWarn(LOG_PREFIX, "startup-refresh-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    this.restartTimer();

    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codex-account-switch.quotaRefreshInterval")) {
        this.restartTimer();
      }
      if (e.affectsConfiguration("codex-account-switch.showStatusBar")) {
        this.updateVisibility();
        this.restartTimer();
        if (this.isVisibleEnabled()) {
          void this.refreshNow().catch((error) => {
            logWarn(LOG_PREFIX, "show-status-bar-refresh-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    });
    context.subscriptions.push(this.configListener);
  }

  private restartTimer() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (!this.isVisibleEnabled()) {
      this.timer = undefined;
      return;
    }
    const config = vscode.workspace.getConfiguration("codex-account-switch");
    const intervalSec = config.get<number>("quotaRefreshInterval", 300);
    this.timer = setInterval(() => {
      void this.refreshNow().catch((error) => {
        logWarn(LOG_PREFIX, "timer-refresh-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalSec * 1000);
  }

  async refreshNow(options?: { skipQuota?: boolean }) {
    const perf = startPerformanceLog(LOG_PREFIX, "statusBar.refreshNow", {
      skipQuota: options?.skipQuota ?? false,
    });
    if (!this.isVisibleEnabled()) {
      perf.finish({
        result: "hidden",
      });
      return;
    }

    try {
      const selection = getSavedCurrentSelection();
      perf.mark("get-saved-current-selection", {
        selectionKind: selection.kind,
        name: "name" in selection ? selection.name : null,
      });
      logInfo(LOG_PREFIX, "refresh-start", {
        selectionKind: selection.kind,
        name: "name" in selection ? selection.name : null,
      });

      if (selection.kind === "provider") {
        const modeLabel = getModeDisplayName(selection.name);
        const sourceLabel = selection.source === "cloud" ? "cloud" : "local";
        this.statusBarItem.text = `$(plug) ${modeLabel} [${sourceLabel}]`;
        this.statusBarItem.tooltip = `Mode: ${modeLabel}\nSource: ${sourceLabel}\nQuota is unavailable in provider mode`;
        perf.finish({
          result: "provider",
          name: selection.name,
          source: selection.source,
        });
        return;
      }

      if (selection.kind !== "account") {
        this.statusBarItem.text = "$(account) Codex: No account";
        this.statusBarItem.tooltip = "No active Codex account detected";
        perf.finish({
          result: "no-account",
        });
        return;
      }

      const name = selection.name;
      if (options?.skipQuota) {
        this.statusBarItem.text = `$(account) ${name} [${selection.source}]`;
        this.statusBarItem.tooltip = `Account: ${name}\nSource: ${selection.source}\nQuota refresh pending`;
        perf.finish({
          result: "skip-quota",
          name,
          source: selection.source,
        });
        return;
      }

      const account = getSavedAccountEntry(name, selection.source);
      perf.mark("get-saved-account-entry", {
        foundAccount: Boolean(account),
        name,
        source: selection.source,
      });
      if (!account) {
        this.statusBarItem.text = `$(account) ${name}`;
        this.statusBarItem.tooltip = `Account: ${name}\nSource: ${selection.source}\nSaved entry is unavailable`;
        perf.finish({
          result: "missing-account",
          name,
          source: selection.source,
        });
        return;
      }

      this.statusBarItem.text = `$(loading~spin) ${name} [${selection.source}]`;
      const result = await querySavedAccountQuota(account);
      perf.mark("query-saved-account-quota", {
        resultKind: result.kind,
      });
      if (result.kind !== "ok") {
        logWarn(LOG_PREFIX, "refresh-result-not-ok", {
          resultKind: result.kind,
          message: result.message,
          account: account.id,
        });
        this.statusBarItem.text = `$(account) ${name} [${selection.source}]`;
        this.statusBarItem.tooltip = result.message;
        perf.finish({
          resultKind: result.kind,
          name,
          source: selection.source,
        });
        return;
      }

      const { info } = result;
      const preferredWindow = getPreferredStatusWindow(info);

      if (preferredWindow) {
        const used = Math.round(preferredWindow.usedPercent);
        const remaining = Math.max(0, 100 - used);
        const icon =
          remaining === 0 ? "$(error)" : remaining <= 30 ? "$(warning)" : remaining <= 50 ? "$(info)" : "$(check)";
        this.statusBarItem.text = `${icon} ${name} [${selection.source}]: ${remaining}%`;

        let tip = `Account: ${name}\nSource: ${selection.source}\nEmail: ${info.email}\nPlan: ${info.plan}\n`;
        tip += `\n${windowLabel(preferredWindow)} quota: ${remaining}% remaining`;
        const otherWindow =
          preferredWindow === info.primaryWindow ? info.secondaryWindow : info.primaryWindow;
        if (otherWindow) {
          tip += `\n${windowLabel(otherWindow)} quota: ${Math.max(0, 100 - Math.round(otherWindow.usedPercent))}% remaining`;
        }
        this.statusBarItem.tooltip = tip;
      } else {
        const reason = info.unavailableReason?.message;
        this.statusBarItem.text = `${reason ? "$(warning)" : "$(account)"} ${name} [${selection.source}]`;
        this.statusBarItem.tooltip = reason
          ? `Account: ${name}\nSource: ${selection.source}\nEmail: ${info.email}\nPlan: ${info.plan}\nQuota: ${reason}`
          : `Account: ${name}\nSource: ${selection.source}\nEmail: ${info.email}\nPlan: ${info.plan}`;
      }
      logInfo(LOG_PREFIX, "refresh-finish", { account: name });
      perf.finish({
        resultKind: result.kind,
        name,
        source: selection.source,
        unavailableReason: info.unavailableReason?.code ?? null,
      });
    } catch (error) {
      logWarn(LOG_PREFIX, "refresh-error", {
        account: this.statusBarItem.text,
        error: error instanceof Error ? error.message : String(error),
      });
      this.statusBarItem.text = this.statusBarItem.text || "$(account) Codex";
      this.statusBarItem.tooltip = "Quota lookup failed";
      perf.fail(error);
    }
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.configListener?.dispose();
    this.statusBarItem.dispose();
  }
}
