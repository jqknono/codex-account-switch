import * as fs from "fs";
import * as path from "path";
import {
  DiagnosticLogLevel,
  getCodexConfigDir,
  setDiagnosticLogger,
} from "@codex-account-switch/core";

const CLI_LOG_FILE_NAME = "codex-account-switch-cli.log";
const TIMESTAMP_PREFIX_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+/;

let loggingInitialized = false;

function getCliDiagnosticLogPath(): string {
  return path.join(getCodexConfigDir(), "logs", CLI_LOG_FILE_NAME);
}

function formatDiagnosticLine(level: DiagnosticLogLevel, line: string): string {
  const matchedTimestamp = TIMESTAMP_PREFIX_PATTERN.exec(line);
  if (matchedTimestamp) {
    return line.replace(TIMESTAMP_PREFIX_PATTERN, `${matchedTimestamp[1]} [${level}] `);
  }
  return `${new Date().toISOString()} [${level}] ${line}`;
}

function appendDiagnosticLine(level: DiagnosticLogLevel, line: string): void {
  try {
    const logPath = getCliDiagnosticLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${formatDiagnosticLine(level, line)}\n`, "utf-8");
  } catch {
    // Keep CLI output clean even when diagnostic logging is unavailable.
  }
}

export function initializeCliDiagnosticLogging(): void {
  if (loggingInitialized) {
    return;
  }

  setDiagnosticLogger((level: DiagnosticLogLevel, line: string) => {
    appendDiagnosticLine(level, line);
  });
  loggingInitialized = true;
}
