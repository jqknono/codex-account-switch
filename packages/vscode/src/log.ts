import * as vscode from "vscode";

const OUTPUT_CHANNEL_NAME = "Codex Account Switch";
const DETAILED_PERFORMANCE_LOGGING_SETTING = "detailedPerformanceLogging";

interface PerformanceTimer {
  mark(stage: string, details?: Record<string, unknown>): void;
  finish(details?: Record<string, unknown>): void;
  fail(error: unknown, details?: Record<string, unknown>): void;
}

let outputChannel: vscode.LogOutputChannel | null = null;

function getOutputChannel(): vscode.LogOutputChannel {
  outputChannel ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
  return outputChannel;
}

function formatLine(prefix: string, event: string, details: Record<string, unknown>): string {
  return `${new Date().toISOString()} ${prefix} ${event} ${JSON.stringify(details)}`;
}

export function isDetailedPerformanceLoggingEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("codex-account-switch")
    .get<boolean>(DETAILED_PERFORMANCE_LOGGING_SETTING, false);
}

export function initializeLogging(): void {
  getOutputChannel();
}

export function disposeLogging(): void {
  outputChannel?.dispose();
  outputChannel = null;
}

export function showLogs(preserveFocus = false): void {
  getOutputChannel().show(preserveFocus);
}

export function writeRawLog(level: "info" | "warn" | "error", line: string): void {
  if (level === "error") {
    getOutputChannel().error(line);
  } else if (level === "warn") {
    getOutputChannel().warn(line);
  } else {
    getOutputChannel().info(line);
  }
}

export function logInfo(prefix: string, event: string, details: Record<string, unknown>): void {
  writeRawLog("info", formatLine(prefix, event, details));
}

export function logWarn(prefix: string, event: string, details: Record<string, unknown>): void {
  writeRawLog("warn", formatLine(prefix, event, details));
}

export function logError(prefix: string, event: string, details: Record<string, unknown>): void {
  writeRawLog("error", formatLine(prefix, event, details));
}

export function startPerformanceLog(
  prefix: string,
  operation: string,
  details: Record<string, unknown> = {},
): PerformanceTimer {
  const startedAt = Date.now();
  let lastMarkAt = startedAt;
  let finished = false;

  logInfo(prefix, "perf-start", {
    operation,
    ...details,
  });

  return {
    mark(stage: string, stageDetails: Record<string, unknown> = {}) {
      if (finished || !isDetailedPerformanceLoggingEnabled()) {
        return;
      }

      const now = Date.now();
      logInfo(prefix, "perf-stage", {
        operation,
        stage,
        durationMs: now - lastMarkAt,
        totalDurationMs: now - startedAt,
        ...details,
        ...stageDetails,
      });
      lastMarkAt = now;
    },
    finish(finishDetails: Record<string, unknown> = {}) {
      if (finished) {
        return;
      }

      finished = true;
      logInfo(prefix, "perf-finish", {
        operation,
        durationMs: Date.now() - startedAt,
        ...details,
        ...finishDetails,
      });
    },
    fail(error: unknown, failDetails: Record<string, unknown> = {}) {
      if (finished) {
        return;
      }

      finished = true;
      logWarn(prefix, "perf-fail", {
        operation,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        ...details,
        ...failDetails,
      });
    },
  };
}
