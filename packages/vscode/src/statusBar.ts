import * as vscode from "vscode";
import { QuotaInfo, WindowInfo, getModeDisplayName } from "@codex-account-switch/core";
import { logInfo, logWarn } from "./log";
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

  private updateVisibility() {
    const config = vscode.workspace.getConfiguration("codex-account-switch");
    if (config.get<boolean>("showStatusBar", true)) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  startAutoRefresh(context: vscode.ExtensionContext) {
    void this.refreshNow().catch((error) => {
      logWarn(LOG_PREFIX, "startup-refresh-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.restartTimer();

    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codex-account-switch.quotaRefreshInterval")) {
        this.restartTimer();
      }
      if (e.affectsConfiguration("codex-account-switch.showStatusBar")) {
        this.updateVisibility();
      }
    });
    context.subscriptions.push(this.configListener);
  }

  private restartTimer() {
    if (this.timer) {
      clearInterval(this.timer);
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

  async refreshNow() {
    const selection = getSavedCurrentSelection();
    logInfo(LOG_PREFIX, "refresh-start", {
      selectionKind: selection.kind,
      name: "name" in selection ? selection.name : null,
    });

    if (selection.kind === "provider") {
      const modeLabel = getModeDisplayName(selection.name);
      const sourceLabel = selection.source === "cloud" ? "cloud" : "local";
      this.statusBarItem.text = `$(plug) ${modeLabel} [${sourceLabel}]`;
      this.statusBarItem.tooltip = `Mode: ${modeLabel}\nSource: ${sourceLabel}\nQuota is unavailable in provider mode`;
      return;
    }

    if (selection.kind !== "account") {
      this.statusBarItem.text = "$(account) Codex: No account";
      this.statusBarItem.tooltip = "No active Codex account detected";
      return;
    }

    const name = selection.name;
    const account = getSavedAccountEntry(name, selection.source);
    if (!account) {
      this.statusBarItem.text = `$(account) ${name}`;
      this.statusBarItem.tooltip = `Account: ${name}\nSource: ${selection.source}\nSaved entry is unavailable`;
      return;
    }

    this.statusBarItem.text = `$(loading~spin) ${name} [${selection.source}]`;

    try {
      const result = await querySavedAccountQuota(account);
      if (result.kind !== "ok") {
        logWarn(LOG_PREFIX, "refresh-result-not-ok", {
          resultKind: result.kind,
          message: result.message,
          account: account.id,
        });
        this.statusBarItem.text = `$(account) ${name} [${selection.source}]`;
        this.statusBarItem.tooltip = result.message;
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
    } catch (error) {
      logWarn(LOG_PREFIX, "refresh-error", {
        account: name,
        error: error instanceof Error ? error.message : String(error),
      });
      this.statusBarItem.text = `$(account) ${name} [${selection.source}]`;
      this.statusBarItem.tooltip = "Quota lookup failed";
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
