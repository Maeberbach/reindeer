import { countdownTone, formatRemaining, type RankingWindow } from "@shared/schema";

/**
 * v7a — Option A pause adjustment.
 *
 * The server never rewrites `rankingDeadline` / `secondaryRankingDeadline`
 * while paused (aside from an explicit captain-chosen extension on resume). The
 * client instead subtracts however much pause time has accrued — past pauses
 * (`totalPausedMs`) plus any pause currently in progress — from the raw
 * `msRemaining` the server reports, so the on-screen countdown looks frozen
 * while paused and picks up again, undiminished, once resumed.
 *
 * Both the admin ranking-window controls and the heir-facing countdown
 * banner should call this instead of reading `window.msRemaining` directly.
 */
export function adjustRankingWindowForPause(
  window: RankingWindow,
  totalPausedMs: number,
  currentPauseMs: number,
): RankingWindow {
  if (window.msRemaining === null) return window;
  const offset = Math.max(0, totalPausedMs) + Math.max(0, currentPauseMs);
  if (offset === 0) return window;
  const adjusted = window.msRemaining + offset;
  return {
    ...window,
    msRemaining: adjusted,
    closed: adjusted <= 0,
  };
}

/**
 * Shift a raw deadline forward by the accrued pause time, for feeding into
 * `useCountdown()` (which counts down against a deadline timestamp, not a
 * pre-computed `msRemaining`). Returns the deadline unchanged when there is
 * nothing to adjust for.
 */
export function effectiveDeadline(
  deadline: number | null,
  totalPausedMs: number,
  currentPauseMs: number,
): number | null {
  if (deadline === null) return null;
  const offset = Math.max(0, totalPausedMs) + Math.max(0, currentPauseMs);
  return offset === 0 ? deadline : deadline + offset;
}

/** Convenience: adjusted remaining-time label, ready to render. */
export function adjustedRemainingLabel(
  window: RankingWindow,
  totalPausedMs: number,
  currentPauseMs: number,
): string | null {
  const adjusted = adjustRankingWindowForPause(window, totalPausedMs, currentPauseMs);
  if (adjusted.msRemaining === null) return null;
  return formatRemaining(Math.max(0, adjusted.msRemaining));
}

/** Convenience: urgency tone computed off the pause-adjusted remaining time. */
export function adjustedCountdownTone(
  window: RankingWindow,
  totalPausedMs: number,
  currentPauseMs: number,
): ReturnType<typeof countdownTone> {
  const adjusted = adjustRankingWindowForPause(window, totalPausedMs, currentPauseMs);
  return countdownTone(adjusted.msRemaining);
}
