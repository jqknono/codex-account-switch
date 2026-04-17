export type DiagnosticLogLevel = "info" | "warn" | "error";
export type DiagnosticLogger = (level: DiagnosticLogLevel, line: string) => void;
export interface DiagnosticLogOptions {
  detailedPerformanceLogging?: boolean;
}

interface PerformanceTimer {
  mark(stage: string, details?: Record<string, unknown>): void;
  finish(details?: Record<string, unknown>): void;
  fail(error: unknown, details?: Record<string, unknown>): void;
}

interface PerformanceLogOptions {
  mode?: "normal" | "adaptive";
  slowThresholdMs?: number;
}

let diagnosticLogger: DiagnosticLogger | null = null;
let diagnosticLogOptions: Required<DiagnosticLogOptions> = {
  detailedPerformanceLogging: false,
};

export function setDiagnosticLogger(logger: DiagnosticLogger | null | undefined): void {
  diagnosticLogger = logger ?? null;
}

export function setDiagnosticLogOptions(options: DiagnosticLogOptions | null | undefined): void {
  diagnosticLogOptions = {
    detailedPerformanceLogging: options?.detailedPerformanceLogging ?? false,
  };
}

export function writeDiagnosticLog(level: DiagnosticLogLevel, line: string): void {
  if (diagnosticLogger) {
    diagnosticLogger(level, line);
    return;
  }

  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.info(line);
}

function formatDiagnosticLine(prefix: string, event: string, details: Record<string, unknown>): string {
  return `${new Date().toISOString()} ${prefix} ${event} ${JSON.stringify(details)}`;
}

export function isDetailedDiagnosticPerformanceLoggingEnabled(): boolean {
  return diagnosticLogOptions.detailedPerformanceLogging;
}

export function createDiagnosticPerformanceTimer(
  prefix: string,
  operation: string,
  details: Record<string, unknown> = {},
  options: PerformanceLogOptions = {},
): PerformanceTimer {
  const startedAt = Date.now();
  let lastMarkAt = startedAt;
  let finished = false;
  const mode = options.mode ?? "normal";
  const slowThresholdMs = options.slowThresholdMs ?? 0;
  const immediateLogging = mode === "normal" || isDetailedDiagnosticPerformanceLoggingEnabled();

  if (immediateLogging) {
    writeDiagnosticLog("info", formatDiagnosticLine(prefix, "perf-start", {
      operation,
      ...details,
    }));
  }

  return {
    mark(stage: string, stageDetails: Record<string, unknown> = {}) {
      if (finished || !isDetailedDiagnosticPerformanceLoggingEnabled()) {
        return;
      }

      const now = Date.now();
      writeDiagnosticLog("info", formatDiagnosticLine(prefix, "perf-stage", {
        operation,
        stage,
        durationMs: now - lastMarkAt,
        totalDurationMs: now - startedAt,
        ...details,
        ...stageDetails,
      }));
      lastMarkAt = now;
    },
    finish(finishDetails: Record<string, unknown> = {}) {
      if (finished) {
        return;
      }

      finished = true;
      const durationMs = Date.now() - startedAt;
      if (!immediateLogging && durationMs < slowThresholdMs) {
        return;
      }
      writeDiagnosticLog("info", formatDiagnosticLine(prefix, "perf-finish", {
        operation,
        durationMs,
        ...(mode === "adaptive" ? { slow: durationMs >= slowThresholdMs } : {}),
        ...details,
        ...finishDetails,
      }));
    },
    fail(error: unknown, failDetails: Record<string, unknown> = {}) {
      if (finished) {
        return;
      }

      finished = true;
      writeDiagnosticLog("warn", formatDiagnosticLine(prefix, "perf-fail", {
        operation,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        ...details,
        ...failDetails,
      }));
    },
  };
}
