import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  useAppState,
  useUser,
  STATE_KEY,
  heirsOf,
  owedLevel,
  priorityList,
  money,
  useCanSeeValues,
} from "@/lib/app";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { RankSuggestion } from "@/components/rank-suggestion";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Eye, Lock, Sparkles } from "lucide-react";
import { ReconciliationModal, AutoDraftBanner } from "@/components/auto-draft";

export default function DraftPage() {
  const { data, isLoading } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const [log, setLog] = useState<string[]>([]);
  const qc = useQueryClient();

  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !!me?.isAdmin;
  const canSeeValues = useCanSeeValues();
  const heirs = heirsOf(data?.participants ?? []);
  const round = data?.session.currentRound ?? 0;
  const priority = data ? priorityList(data.session) : [];
  const roundPicks = (data?.picks ?? []).filter((p) => p.round === round && !p.isTiebreak);
  const myLevel = me && !me.administersOnly ? owedLevel(me.id, data?.picks ?? [], round) : 0;
  // High-value flags take an item out of the draft pool until the captain reverts.
  const available = (data?.items ?? []).filter((i) => i.status === "available" && !i.needsAppraisal);
  const highValue = (data?.items ?? []).filter((i) => i.status === "needs_appraisal");
  const pickedItemIds = new Set(roundPicks.map((p) => p.itemId));

  const submit = useMutation({
    mutationFn: async (v: { itemId: number; highValue: boolean }) => {
      const res = await apiRequest("POST", "/api/picks", {
        participantId: userId,
        itemId: v.itemId,
        highValue: v.highValue,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Choice locked in", description: "No one else can see it until the reveal." });
    },
    onError: (e: Error) =>
      toast({ title: "Could not submit", description: e.message, variant: "destructive" }),
  });

  const reveal = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/session/reveal-round", { actorId: userId });
      return res.json() as Promise<{ resolved: number; roundComplete: boolean; log: string[] }>;
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      setLog((l) => [...r.log, ...l]);
      toast({
        title: r.roundComplete ? "Round complete — priority rotated" : "Picks revealed",
        description: `${r.resolved} contest(s) resolved.`,
      });
    },
  });

  const startDraft = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/session/start-draft")).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "The draft has begun" });
    },
  });

  const myPosition = me ? priority.indexOf(me.id) : -1;
  const waiting = heirs.filter((h) => owedLevel(h.id, data?.picks ?? [], round) > 0);
  const inDraft = data?.session.phase === "draft" || data?.session.phase === "complete";
  const inPractice = (data?.session.practiceMode ?? "off") !== "off";
  const submittedCount = heirs.length - waiting.length;
  // Practice is a rehearsal: anyone at the table may trigger the reveal.
  const canReveal = isCaptain || inPractice;

  // The server advances automatic rounds on the back of this poll.
  const autoLive =
    !!data?.session.autoDraftEnabled &&
    (data?.session.phase === "draft" || data?.session.phase === "secondary_draft") &&
    (data?.session.practiceMode ?? "off") === "off";
  useEffect(() => {
    if (!autoLive) return;
    const id = setInterval(() => {
      qc.invalidateQueries({ queryKey: STATE_KEY });
    }, 3000);
    return () => clearInterval(id);
  }, [autoLive, qc]);

  return (
    <AppShell>
      <ReconciliationModal />
      <PageHeader
        title="The draft"
        subtitle="Every heir chooses privately. Choices are revealed together: uncontested picks are awarded at once, contested picks go to the heir with the most contested losses, and the losers pick again."
        actions={
          canReveal ? (
            <>
              {!inDraft && isCaptain && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="button-begin-draft"
                  disabled={startDraft.isPending}
                  onClick={() => startDraft.mutate()}
                >
                  Begin the draft
                </Button>
              )}
              {data?.session.phase !== "complete" && (
              <Button
                size="sm"
                data-testid="button-reveal-round"
                disabled={reveal.isPending}
                onClick={() => reveal.mutate()}
              >
                <Eye className="mr-1.5 h-4 w-4" />
                {reveal.isPending ? "Revealing…" : "Reveal picks"}
              </Button>
              )}
            </>
          ) : null
        }
      />

      <AutoDraftBanner />

      {isLoading ? (
        <LoadingRows rows={5} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
          <div className="space-y-6">
            {inPractice && (
              <Card className="border-[#c9a227]" data-testid="card-practice-status">
                <CardContent className="p-4">
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                    Practice round status
                  </Label>
                  <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                    <span data-testid="text-practice-status-round">Round {round}</span>
                    <span data-testid="text-practice-status-picks">
                      {submittedCount} of {heirs.length} picks in
                    </span>
                    <span data-testid="text-practice-status-waiting">
                      {waiting.length === 0
                        ? "Everyone has picked — ready to reveal"
                        : `Still to pick: ${waiting.map((w) => w.name).join(", ")}`}
                    </span>
                    <span data-testid="text-practice-status-reveal">
                      Reveal: anyone at the table
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}

            {me && !me.administersOnly && data?.session.phase !== "complete" && (
              <Card
                className={myLevel > 0 ? "border-primary" : ""}
                data-testid="card-pick-window"
              >
                <CardContent className="p-4">
                  {myLevel > 0 ? (
                    <>
                      <div className="font-serif text-base" data-testid="text-pick-window-title">
                        {me.name}, it&rsquo;s your turn to choose
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground" data-testid="text-pick-window-body">
                        {myLevel === 1
                          ? "Tap an item in the pool below to lock in your private first choice. No one sees it until the reveal."
                          : myLevel === 2
                            ? "You lost a contest — tap another item below to lock in your second choice."
                            : "Third-choice cleanup — tap another item below to lock in your choice."}
                      </p>
                    </>
                  ) : (
                    <div className="text-sm" data-testid="text-pick-locked">
                      Your pick is locked in, waiting for others.
                      {waiting.length > 0 && (
                        <span className="text-muted-foreground">
                          {" "}
                          Still to pick: {waiting.map((w) => w.name).join(", ")}.
                        </span>
                      )}
                    </div>
                  )}
                  <RankSuggestion
                    me={me}
                    round={round}
                    canPick={myLevel > 0}
                    submitting={submit.isPending}
                    onConfirm={(itemId) =>
                      submit.mutate({
                        itemId,
                        highValue: highValue.some((h) => h.id === itemId),
                      })
                    }
                  />
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="flex flex-wrap items-center gap-3 p-4">
                <Badge variant="secondary" data-testid="text-draft-round">
                  {data?.session.phase === "complete" ? "Draft complete" : `Round ${round}`}
                </Badge>
                {data?.session.phase !== "complete" && (
                <Badge variant="outline" data-testid="text-draft-mode">
                  {myLevel === 0
                    ? "Awaiting reveal"
                    : myLevel === 1
                      ? "Private first choice"
                      : myLevel === 2
                        ? "Second choice (you lost a contest)"
                        : "Third-choice cleanup"}
                </Badge>
                )}
                {me && !me.administersOnly && (
                  <Badge variant="outline" data-testid="text-my-priority">
                    Your priority: {myPosition >= 0 ? `P${myPosition + 1}` : "—"}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground" data-testid="text-waiting-on">
                  {data?.session.phase === "complete"
                    ? "Every item has been awarded — see the Results page."
                    : `Waiting on: ${waiting.length === 0 ? "no one — ready to reveal" : waiting.map((w) => w.name).join(", ")}`}
                </span>
              </CardContent>
            </Card>

            {highValue.length > 0 && (
              <section>
                <h2 className="mb-2 font-serif text-lg" data-testid="text-highvalue-heading">
                  High-value round
                </h2>
                <p className="mb-3 text-sm text-muted-foreground">
                  These items were confirmed into the high-value pool. Losing a contest here does
                  not change your ordinary-draft counter.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {highValue.map((i) => (
                    <Card
                      key={i.id}
                      className="cursor-pointer p-3 hover-elevate"
                      data-testid={`card-highvalue-item-${i.id}`}
                      onClick={() =>
                        myLevel > 0 && submit.mutate({ itemId: i.id, highValue: true })
                      }
                    >
                      <div className="text-sm font-medium">{i.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {i.room}{canSeeValues ? ` · ${money(i.aiEstimatedValue)}` : ""}
                      </div>
                    </Card>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-3 font-serif text-lg" data-testid="text-pool-heading">
                Available pool · {available.length} item(s)
              </h2>
              {available.length === 0 ? (
                <Card className="p-8 text-center" data-testid="text-empty-pool">
                  <p className="font-serif text-lg">The pool is empty</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Every item has been awarded. See the Results page for the final ledger.
                  </p>
                </Card>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="list-pool">
                  {available.map((i) => {
                    const isMine = roundPicks.some(
                      (p) => p.itemId === i.id && p.participantId === userId && p.outcome !== "lost_contest",
                    );
                    return (
                      <Card
                        key={i.id}
                        role="button"
                        tabIndex={0}
                        data-testid={`card-pool-item-${i.id}`}
                        className={`cursor-pointer p-3 hover-elevate ${isMine ? "border-primary" : ""}`}
                        onClick={() =>
                          myLevel > 0
                            ? submit.mutate({ itemId: i.id, highValue: false })
                            : toast({
                                title: "Nothing to submit",
                                description: "Your pick for this round is already in.",
                              })
                        }
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium" data-testid={`text-pool-name-${i.id}`}>
                              {i.name}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {i.room || "—"}{canSeeValues ? ` · ${money(i.aiEstimatedValue)}` : ""}
                            </div>
                          </div>
                          {isMine && <Lock className="h-3.5 w-3.5 shrink-0 text-primary" />}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-3 font-serif text-lg">This round</h2>
              {roundPicks.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="text-no-picks">
                  No choices submitted yet.
                </p>
              ) : (
                <div className="space-y-2" data-testid="list-round-picks">
                  {roundPicks.map((p) => {
                    const who = data?.participants.find((x) => x.id === p.participantId);
                    const item = data?.items.find((x) => x.id === p.itemId);
                    const hidden = p.outcome === "pending" && p.participantId !== userId;
                    return (
                      <Card key={p.id} data-testid={`row-pick-${p.id}`}>
                        <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                          <span className="font-medium">{who?.name}</span>
                          <span data-testid={`text-pick-item-${p.id}`}>
                            {hidden ? "Choice submitted — sealed" : item?.name}
                          </span>
                          <div className="flex gap-1.5">
                            <Badge variant="outline">
                              {p.pickOrder === 1 ? "1st" : p.pickOrder === 2 ? "2nd" : "3rd"} choice
                            </Badge>
                            <Badge
                              variant={
                                p.outcome === "awarded"
                                  ? "default"
                                  : p.outcome === "lost_contest"
                                    ? "destructive"
                                    : "secondary"
                              }
                              data-testid={`status-pick-${p.id}`}
                            >
                              {p.outcome === "awarded"
                                ? "Awarded"
                                : p.outcome === "lost_contest"
                                  ? "Lost contest"
                                  : "Sealed"}
                            </Badge>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>

            {log.length > 0 && (
              <section>
                <h2 className="mb-2 font-serif text-lg">Reveal log</h2>
                <ul className="space-y-1 text-sm text-muted-foreground" data-testid="list-reveal-log">
                  {log.map((l, i) => (
                    <li key={i} data-testid={`text-reveal-log-${i}`}>
                      · {l}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          {/* Sidebar */}
          <aside className="space-y-4">
            <Card>
              <CardContent className="p-4">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Contested-loss counters
                </Label>
                <div className="mt-2 space-y-1.5">
                  {heirs.map((h) => (
                    <div
                      key={h.id}
                      className="flex items-center justify-between text-sm"
                      data-testid={`row-counter-${h.id}`}
                    >
                      <span>{h.name}</span>
                      <Badge variant="outline" data-testid={`text-counter-${h.id}`}>
                        {h.contestedLossCounter}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Priority order
                </Label>
                <ol className="mt-2 space-y-1 text-sm" data-testid="list-priority">
                  {priority.map((pid, idx) => {
                    const p = data?.participants.find((x) => x.id === pid);
                    return (
                      <li key={pid} className="flex justify-between" data-testid={`row-priority-${idx}`}>
                        <span>
                          P{idx + 1} · {p?.name}
                        </span>
                      </li>
                    );
                  })}
                </ol>
                <p className="mt-2 text-xs text-muted-foreground">
                  After each round P1 moves to the back and everyone else shifts up.
                </p>
              </CardContent>
            </Card>
          </aside>
        </div>
      )}
    </AppShell>
  );
}
