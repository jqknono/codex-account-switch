export type DiagnosticLogLevel = "info" | "warn" | "error";
export type DiagnosticLogger = (level: DiagnosticLogLevel, line: string) => void;

let diagnosticLogger: DiagnosticLogger | null = null;

export function setDiagnosticLogger(logger: DiagnosticLogger | null | undefined): void {
  diagnosticLogger = logger ?? null;
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
