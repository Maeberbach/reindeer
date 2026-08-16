import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CalendarClock, Clock, Lock, RotateCcw } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { STATE_KEY, phaseLabel, useAppState, useCountdown, useUser } from "@/lib/app";
import { RANKING_WINDOW_MAX_DAYS, RANKING_WINDOW_MIN_DAYS } from "@shared/schema";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

const clean = (m: string) =>
  m.replace(/^\d+:\s*/, "").replace(/^\{"message":"/, "").replace(/".*\}$/, "");

/* ------------------------------------------------------------------ */
/* Rank depth + ranking window + guarded phase advance                 */
/* ------------------------------------------------------------------ */
export function RankingAdminCards() {
  const { data } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const session = data?.session;
  const summary = data?.rankSummary;
  const phase = session?.phase ?? "welcome";
  const inRanking = phase === "ranking" || phase === "secondary_ranking";
  const activeWindowPhase: "ranking" | "secondary_ranking" =
    phase === "secondary_ranking" ? "secondary_ranking" : "ranking";
  const win =
    activeWindowPhase === "secondary_ranking" ? data?.secondaryRankingWindow : data?.rankingWindow;
  const countdown = useCountdown(win?.deadline ?? null);

  const [mode, setMode] = useState<"all" | "topN">("topN");
  const [topN, setTopN] = useState("20");
  const [days, setDays] = useState("30");
  const [secondaryDays, setSecondaryDays] = useState("30");
  const [gate, setGate] = useState<{
    message: string;
    underRanked: { name: string; shortfall: number }[];
    deadlinePassed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!session) return;
    setMode((session.rankDepthMode as "all" | "topN") ?? "topN");
    setTopN(String(session.rankTopN ?? 20));
    setDays(String(session.rankingWindowDays ?? 30));
    setSecondaryDays(String(session.secondaryRankingWindowDays ?? 30));
  }, [session?.rankDepthMode, session?.rankTopN, session?.rankingWindowDays, session?.secondaryRankingWindowDays]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: STATE_KEY });

  const patchSession = useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      (await apiRequest("PATCH", "/api/session", { ...patch, actorId: userId })).json(),
    onSuccess: () => {
      refresh();
      toast({ title: "Ranking requirements saved" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not save", description: clean(e.message), variant: "destructive" }),
  });

  const windowAction = useMutation({
    mutationFn: async (v: { path: string; body?: Record<string, unknown>; method?: "PATCH" | "POST" }) =>
      (
        await apiRequest(v.method ?? "POST", `/api/session/ranking-window${v.path}`, {
          ...(v.body ?? {}),
          actorId: userId,
        })
      ).json(),
    onSuccess: () => {
      refresh();
      toast({ title: "Ranking window updated" });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not change the window",
        description: clean(e.message),
        variant: "destructive",
      }),
  });

  const advance = useMutation({
    mutationFn: async (force: boolean) => {
      const res = await apiRequest(
        "POST",
        `/api/session/next-phase${force ? "?force=true" : ""}`,
        { actorId: userId, force },
      );
      return res.json();
    },
    onSuccess: (s: any) => {
      setGate(null);
      refresh();
      toast({ title: `Phase is now ${phaseLabel(s.phase)}` });
    },
    onError: async (e: any) => {
      // The gate error arrives as `<status>: <json body>` from apiRequest.
      let parsed: any = null;
      const raw = String(e?.message ?? "");
      const brace = raw.indexOf("{");
      if (brace >= 0) {
        try {
          parsed = JSON.parse(raw.slice(brace));
        } catch {
          /* fall through to the plain toast */
        }
      }
      if (parsed?.underRanked) {
        setGate({
          message: parsed.message,
          underRanked: parsed.underRanked,
          deadlinePassed: !!parsed.deadlinePassed,
        });
        return;
      }
      toast({ title: "Cannot advance", description: clean(raw), variant: "destructive" });
    },
  });

  if (!session) return null;

  return (
    <>
      {/* -------------------- Ranking requirements -------------------- */}
      <Card data-testid="card-ranking-requirements">
        <CardContent className="p-4">
          <Label className="text-sm font-medium">Ranking requirements</Label>
          <p className="mb-3 mt-1 max-w-2xl text-xs text-muted-foreground">
            Unranked items stay out of the primary draft. Heirs can re-rank them later for a
            Secondary Draft.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="rankDepthMode"
                checked={mode === "all"}
                data-testid="radio-rank-all"
                onChange={() => {
                  setMode("all");
                  patchSession.mutate({ rankDepthMode: "all" });
                }}
              />
              Rank all items
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="rankDepthMode"
                checked={mode === "topN"}
                data-testid="radio-rank-topn"
                onChange={() => {
                  setMode("topN");
                  patchSession.mutate({ rankDepthMode: "topN" });
                }}
              />
              Rank top N items
            </label>
            <Input
              type="number"
              min={5}
              max={500}
              value={topN}
              disabled={mode !== "topN"}
              aria-label="Number of items each heir must rank"
              data-testid="input-rank-topn"
              className="h-9 w-24"
              onChange={(e) => setTopN(e.target.value)}
              onBlur={() => {
                const n = Number(topN);
                if (!Number.isFinite(n)) return;
                const clamped = Math.max(5, Math.min(500, Math.round(n)));
                setTopN(String(clamped));
                if (clamped !== session.rankTopN) patchSession.mutate({ rankTopN: clamped });
              }}
            />
          </div>
          {summary && (
            <div className="mt-3 flex flex-wrap gap-2" data-testid="list-rank-progress">
              {summary.heirs.map((h) => (
                <Badge
                  key={h.participantId}
                  variant={h.complete ? "secondary" : "outline"}
                  data-testid={`badge-admin-rank-${h.participantId}`}
                >
                  {h.name}: {h.ranked}/{summary.required}
                  {h.complete ? " ✓" : ` (needs ${h.shortfall} more)`}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* -------------------- Ranking window -------------------- */}
      <Card data-testid="card-ranking-window">
        <CardContent className="p-4">
          <Label className="text-sm font-medium">Ranking window</Label>
          <p className="mb-3 mt-1 max-w-2xl text-xs text-muted-foreground">
            Deadline auto-adjusts if you change this while ranking is open.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="window-days" className="text-xs">
                Days heirs have to complete ranking
              </Label>
              <Input
                id="window-days"
                type="number"
                min={RANKING_WINDOW_MIN_DAYS}
                max={RANKING_WINDOW_MAX_DAYS}
                value={days}
                data-testid="input-ranking-window-days"
                className="mt-1 h-9 w-28"
                onChange={(e) => setDays(e.target.value)}
                onBlur={() => {
                  const n = Math.round(Number(days));
                  if (!Number.isFinite(n) || n === session.rankingWindowDays) {
                    return setDays(String(session.rankingWindowDays ?? 30));
                  }
                  windowAction.mutate({
                    path: "",
                    method: "PATCH",
                    body: { days: n, phase: "ranking" },
                  });
                }}
              />
            </div>
            <div>
              <Label htmlFor="secondary-window-days" className="text-xs">
                Secondary ranking window (for leftover items)
              </Label>
              <Input
                id="secondary-window-days"
                type="number"
                min={RANKING_WINDOW_MIN_DAYS}
                max={RANKING_WINDOW_MAX_DAYS}
                value={secondaryDays}
                data-testid="input-secondary-window-days"
                className="mt-1 h-9 w-28"
                onChange={(e) => setSecondaryDays(e.target.value)}
                onBlur={() => {
                  const n = Math.round(Number(secondaryDays));
                  if (!Number.isFinite(n) || n === session.secondaryRankingWindowDays) {
                    return setSecondaryDays(String(session.secondaryRankingWindowDays ?? 30));
                  }
                  windowAction.mutate({
                    path: "",
                    method: "PATCH",
                    body: { days: n, phase: "secondary_ranking" },
                  });
                }}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
              data-testid="text-admin-countdown"
            >
              <CalendarClock className="h-4 w-4" />
              {countdown
                ? countdown.closed
                  ? `Ranking closed on ${countdown.deadlineText}`
                  : `Ranking closes in ${countdown.label} (${countdown.deadlineText})`
                : "The ranking window opens when you advance to the ranking phase."}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="button-extend-ranking"
              disabled={windowAction.isPending || !win?.openedAt}
              onClick={() =>
                windowAction.mutate({
                  path: "/extend",
                  body: { days: 7, phase: activeWindowPhase },
                })
              }
            >
              <Clock className="mr-1.5 h-4 w-4" /> Extend ranking by 7 days
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="button-close-ranking"
                  disabled={windowAction.isPending || !win?.openedAt || !!countdown?.closed}
                >
                  <Lock className="mr-1.5 h-4 w-4" /> Close ranking now
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-serif">Close ranking now?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will lock all heirs' rankings immediately. Continue?
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-cancel-close-ranking">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    data-testid="button-confirm-close-ranking"
                    onClick={() =>
                      windowAction.mutate({ path: "/close-now", body: { phase: activeWindowPhase } })
                    }
                  >
                    Yes, close it
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            {countdown?.closed && (
              <Button
                size="sm"
                variant="outline"
                data-testid="button-reopen-ranking"
                disabled={windowAction.isPending}
                onClick={() =>
                  windowAction.mutate({ path: "/reopen", body: { phase: activeWindowPhase } })
                }
              >
                <RotateCcw className="mr-1.5 h-4 w-4" /> Reopen ranking (+7 days)
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* -------------------- Guarded phase advance -------------------- */}
      <Card data-testid="card-advance-phase">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
          <div>
            <Label className="text-sm font-medium">Advance to the next phase</Label>
            <p className="mt-1 max-w-lg text-xs text-muted-foreground">
              Moves {phaseLabel(phase)} forward in order. During ranking every heir must meet the
              rank requirement first, unless the deadline has already passed.
            </p>
          </div>
          <Button
            size="sm"
            data-testid="button-next-phase"
            disabled={advance.isPending || session.practiceMode !== "off"}
            onClick={() => advance.mutate(false)}
          >
            {advance.isPending ? "Advancing…" : "Advance phase"}
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        </CardContent>
      </Card>

      {/* Warning modal listing who is short. */}
      <AlertDialog open={!!gate} onOpenChange={(o) => !o && setGate(null)}>
        <AlertDialogContent data-testid="dialog-rank-gate">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 font-serif">
              <AlertTriangle className="h-4 w-4 text-[#c9a227]" />
              {gate?.deadlinePassed ? "Deadline passed — heirs are still short" : "Ranking is not finished"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>{gate?.message}</p>
                <ul className="mt-2 list-disc pl-5" data-testid="list-under-ranked">
                  {gate?.underRanked.map((u) => (
                    <li key={u.name}>
                      {u.name} needs {u.shortfall} more rank{u.shortfall === 1 ? "" : "s"}
                    </li>
                  ))}
                </ul>
                {!gate?.deadlinePassed && (
                  <p className="mt-2 text-xs">
                    You can still force this through, but those heirs will enter the draft with a
                    short list.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-advance">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-advance-anyway"
              onClick={() => advance.mutate(true)}
            >
              Advance anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
