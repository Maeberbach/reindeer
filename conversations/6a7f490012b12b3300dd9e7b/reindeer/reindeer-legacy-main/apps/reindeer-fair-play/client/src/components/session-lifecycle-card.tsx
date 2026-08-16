import { useEffect, useState } from "react";
import { useAppState, useSessionState, useUser } from "@/lib/app";
import { formatRemaining } from "@shared/schema";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Pause, Play, Clock, History } from "lucide-react";
import { PauseDialog, ResumeDialog } from "@/components/lifecycle-dialogs";

/** Live-ticking "for X" duration, updated once a second. */
function useLiveDuration(sinceMs: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sinceMs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sinceMs]);
  if (!sinceMs) return null;
  return formatRemaining(Math.max(0, now - sinceMs));
}

const STATE_PILL: Record<string, string> = {
  active: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  paused: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  archived: "border-transparent bg-muted text-muted-foreground",
};

export function SessionLifecycleCard() {
  const { data: appState } = useAppState();
  const { data: lifecycle } = useSessionState();
  const { userId } = useUser();
  const [pauseOpen, setPauseOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const me = appState?.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !me || !!me.isAdmin;
  const state = lifecycle?.state ?? appState?.session.state ?? "active";
  const pausedAt = lifecycle?.pausedAt ?? appState?.session.pausedAt ?? null;
  const pausedByName =
    appState?.participants.find((p) => p.id === (lifecycle?.pausedBy ?? appState?.session.pausedBy))
      ?.name ?? "The captain";
  const pauseReason = lifecycle?.pauseReason ?? appState?.session.pauseReason ?? null;
  const pauseCount = lifecycle?.pauseCount ?? appState?.session.pauseCount ?? 0;
  const totalPausedMs = lifecycle?.totalPausedMs ?? appState?.session.totalPausedMs ?? 0;
  const liveDuration = useLiveDuration(state === "paused" ? pausedAt : null);
  const history = lifecycle?.stateChanges ?? [];

  if (!appState) return null;

  return (
    <Card data-testid="card-session-lifecycle">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge
              className={STATE_PILL[state] ?? STATE_PILL.active}
              data-testid="badge-lifecycle-state"
            >
              {state === "active" ? "Active" : state === "paused" ? "Paused" : "Archived"}
            </Badge>
            <span className="text-sm text-muted-foreground" data-testid="text-pause-count">
              Paused {pauseCount} time{pauseCount === 1 ? "" : "s"}
            </span>
            {totalPausedMs > 0 && (
              <span className="text-sm text-muted-foreground" data-testid="text-total-paused-time">
                · {formatRemaining(totalPausedMs)} total
              </span>
            )}
          </div>
          {isCaptain && (
            <>
              {state === "active" && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="button-pause-estate"
                  onClick={() => setPauseOpen(true)}
                >
                  <Pause className="mr-1.5 h-3.5 w-3.5" /> Pause estate
                </Button>
              )}
              {state === "paused" && (
                <Button size="sm" data-testid="button-resume-estate" onClick={() => setResumeOpen(true)}>
                  <Play className="mr-1.5 h-3.5 w-3.5" /> Resume estate
                </Button>
              )}
            </>
          )}
        </div>

        {state === "paused" && (
          <div
            className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40"
            data-testid="panel-pause-details"
          >
            <p className="font-medium text-amber-900 dark:text-amber-200">
              Paused by {pausedByName}
            </p>
            {liveDuration && (
              <p className="mt-1 flex items-center gap-1.5 text-amber-800 dark:text-amber-300" data-testid="text-paused-duration">
                <Clock className="h-3.5 w-3.5" /> Paused for {liveDuration}
              </p>
            )}
            {pauseReason && (
              <p className="mt-1 text-amber-800 dark:text-amber-300" data-testid="text-pause-reason">
                Reason: {pauseReason}
              </p>
            )}
          </div>
        )}

        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 px-0 text-muted-foreground"
              data-testid="button-toggle-state-history"
            >
              <History className="h-3.5 w-3.5" />
              State change history
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-1.5" data-testid="list-state-history">
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground">No state changes yet.</p>
            ) : (
              history.slice(0, 10).map((h) => (
                <div
                  key={h.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
                  data-testid={`row-state-change-${h.id}`}
                >
                  <span className="font-medium">
                    {h.fromState} → {h.toState}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(h.changedAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                  {h.reason && <span className="w-full text-muted-foreground">Reason: {h.reason}</span>}
                </div>
              ))
            )}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>

      <PauseDialog open={pauseOpen} onOpenChange={setPauseOpen} />
      <ResumeDialog open={resumeOpen} onOpenChange={setResumeOpen} pausedAt={pausedAt} />
    </Card>
  );
}
