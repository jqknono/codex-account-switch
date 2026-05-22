import { QuotaInfo, WindowInfo } from "@codex-account-switch/core";

export interface AutoSwitchCandidate<T> {
  candidate: T;
  info: QuotaInfo;
}

export interface RankedAutoSwitchCandidate<T> {
  candidate: T;
  info: QuotaInfo;
  window: WindowInfo;
  remainingPercent: number;
}

function isFiveHourWindow(window: WindowInfo): boolean {
  if (window.windowSeconds == null) {
    return false;
  }
  return window.windowSeconds / 3600 <= 5;
}

export function getFiveHourQuotaWindow(info: QuotaInfo): WindowInfo | null {
  if (info.primaryWindow && isFiveHourWindow(info.primaryWindow)) {
    return info.primaryWindow;
  }
  if (info.secondaryWindow && isFiveHourWindow(info.secondaryWindow)) {
    return info.secondaryWindow;
  }
  return null;
}

export function getRemainingQuotaPercent(window: WindowInfo): number {
  return Math.max(0, 100 - Math.round(window.usedPercent));
}

export function isFiveHourQuotaExhausted(info: QuotaInfo): boolean {
  const window = getFiveHourQuotaWindow(info);
  if (!window) {
    return false;
  }
  return getRemainingQuotaPercent(window) <= 0;
}

export function rankAutoSwitchCandidates<T>(
  candidates: AutoSwitchCandidate<T>[],
): RankedAutoSwitchCandidate<T>[] {
  return candidates
    .map((entry) => {
      const window = getFiveHourQuotaWindow(entry.info);
      if (!window) {
        return null;
      }

      return {
        candidate: entry.candidate,
        info: entry.info,
        window,
        remainingPercent: getRemainingQuotaPercent(window),
      };
    })
    .filter((entry): entry is RankedAutoSwitchCandidate<T> => entry != null && entry.remainingPercent > 0)
    .sort((left, right) => {
      if (right.remainingPercent !== left.remainingPercent) {
        return right.remainingPercent - left.remainingPercent;
      }

      const leftResetAt = left.window.resetsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightResetAt = right.window.resetsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (leftResetAt !== rightResetAt) {
        return leftResetAt - rightResetAt;
      }

      return 0;
    });
}
