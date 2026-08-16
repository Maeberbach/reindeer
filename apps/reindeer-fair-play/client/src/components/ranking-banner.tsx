import { Link } from "wouter";
import { AlarmClock, CalendarClock, CheckCircle2, Lock } from "lucide-react";
import { activeWindowOf, useAppState, useCountdown, useUser } from "@/lib/app";
import { effectiveDeadline } from "@/lib/rankingWindow";
import { Button } from "@/components/ui/button";

/** Tailwind classes per urgency band. */
const TONE: Record<string, string> = {
  normal:
    "border-border bg-muted/70 text-foreground",
  soon: "border-[#c9a227]/60 bg-[#fdf3d0] text-[#5a4409] dark:bg-[#3a3007] dark:text-[#f4e2a1]",
  amber:
    "border-[#c9a227]/60 bg-[#fdf3d0] text-[#5a4409] dark:bg-[#3a3007] dark:text-[#f4e2a1]",
  red: "border-destructive/50 bg-destructive/10 text-destructive dark:text-red-300",
  closed: "border-destructive/50 bg-destructive/10 text-destructive dark:text-red-300",
};

/**
 * Sticky notification strip shown on every page while a ranking window is
 * running. Heirs see a countdown (amber once they are inside 48 hours and still
 * under-ranked); the captain sees the deadline plus who is outstanding.
 */
export function RankingDeadlineBanner({ compact = false }: { compact?: boolean }) {
  const { data } = useAppState();
  const { userId } = useUser();
  const win = activeWindowOf(data);
  // v7a Option A: the stored deadline never moves for a pause; the display
  // shifts it forward by however much pause time (past + in-progress) has
  // accrued, so the countdown looks frozen while paused.
  const totalPausedMs = data?.session.totalPausedMs ?? 0;
  const currentPauseMs =
    data?.session.state === "paused" && data.session.pausedAt
      ? Math.max(0, Date.now() - data.session.pausedAt)
      : 0;
  const adjustedDeadline = effectiveDeadline(win?.deadline ?? null, totalPausedMs, currentPauseMs);
  const countdown = useCountdown(adjustedDeadline);

  if (!data || !win || !countdown) return null;
  if (data.session.practiceMode !== "off") return null;

  const me = data.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !!me?.isAdmin;
  const mine = data.rankSummary.heirs.find((h) => h.participantId === userId) ?? null;
  const underRanked = !!mine && !mine.complete;
  const within48h = countdown.msRemaining < 48 * 60 * 60 * 1000;
  const secondary = win.phase === "secondary_ranking";

  // Heirs who are behind get nudged early; everyone else keeps the calm style.
  let tone = countdown.tone;
  if (!countdown.closed && underRanked && within48h && tone === "normal") tone = "amber";
  if (!underRanked && !countdown.closed && tone === "soon") tone = "normal";

  let message: string;
  if (countdown.closed) {
    message = isCaptain
      ? "Ranking window closed. The captain can advance or extend."
      : `The ranking window closed on ${countdown.deadlineText}. Contact the captain if you need to make changes.`;
  } else if (isCaptain) {
    message = `Ranking is open. Heirs have until ${countdown.deadlineText} to complete (${countdown.label} left).`;
  } else {
    message = `Ranking closes ${countdown.deadlineText} — ${countdown.label} left`;
  }

  const Icon = countdown.closed ? Lock : tone === "normal" ? CalendarClock : AlarmClock;

  return (
    <div
      role="status"
      data-testid="banner-ranking-deadline"
      data-tone={tone}
      data-closed={countdown.closed ? "true" : "false"}
      className={`no-print sticky top-0 z-30 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 ${
        compact ? "py-1.5" : "py-2"
      } text-center text-sm ${TONE[tone] ?? TONE.normal}`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {secondary && (
        <span className="font-semibold uppercase tracking-[0.14em]">Secondary ranking</span>
      )}
      <span data-testid="text-ranking-deadline">{message}</span>
      {isCaptain && data.rankSummary.underRanked.length > 0 && (
        <span className="opacity-80" data-testid="text-ranking-outstanding">
          Outstanding: {data.rankSummary.underRanked.map((u) => u.name).join(", ")}
        </span>
      )}
      {!isCaptain && underRanked && !countdown.closed && (
        <Button asChild size="sm" variant="outline" data-testid="button-finish-ranking">
          <Link href="/rank">Finish ranking now</Link>
        </Button>
      )}
      {!isCaptain && mine?.complete && !countdown.closed && (
        <span className="flex items-center gap-1 opacity-80">
          <CheckCircle2 className="h-3.5 w-3.5" /> Your ranking is complete
        </span>
      )}
    </div>
  );
}
