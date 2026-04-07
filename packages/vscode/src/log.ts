import * as vscode from "vscode";

const OUTPUT_CHANNEL_NAME = "Codex Account Switch";

let outputChannel: vscode.OutputChannel | null = null;

function getOutputChannel(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  return outputChannel;
}

function formatLine(prefix: string, event: string, details: Record<string, unknown>): string {
  return `${new Date().toISOString()} ${prefix} ${event} ${JSON.stringify(details)}`;
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
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
  getOutputChannel().appendLine(line);
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
