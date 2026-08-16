/**
 * Captain's appraisal review screen — commit 4c.
 *
 * A required stop between "inventory complete" and "ranking opens." The
 * captain looks over what the automatic rules have flagged for the
 * appraisal queue and can:
 *   - Uncheck an auto-flagged item to keep it in the game (soft revert, per
 *     project rule "captain revert is soft").
 *   - Check an item that no rule caught to add it to the queue.
 *
 * The captain is NOT the boss (verbatim, per user's locked-in statement).
 * Heirs have already flagged what mattered to them and the auto-rules have
 * done their pass. The captain's role here is to look, not overrule.
 *
 * The "Open ranking" button on this page is the ONLY path from intake to
 * ranking — the admin flow card sends the captain here first, and this page
 * calls /api/session/mark-inventory-complete when the captain confirms.
 *
 * Owner-source flags are read-only — the owner is deceased at this stage,
 * and their selections cannot be reverted.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useAppState, useUser, STATE_KEY } from "@/lib/app";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { AppraisalFlag, Item } from "@shared/schema";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Lock } from "lucide-react";

/**
 * Money formatter used only for display of AI estimates on this page.
 * Kept local so the page has no dependency on server code.
 */
function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "";
  const rounded = Math.round(n);
  return "$" + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

type ReviewRow = {
  item: Item;
  activeFlag: AppraisalFlag | null;
  /** True when the row is owner-sourced and therefore cannot be unchecked. */
  locked: boolean;
};

export default function AppraisalReviewPage() {
  const { data: state, isLoading: stateLoading } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [confirming, setConfirming] = useState(false);

  const itemsQuery = useQuery<Item[]>({ queryKey: ["/api/items"] });
  const flagsQuery = useQuery<AppraisalFlag[]>({ queryKey: ["/api/appraisal"] });

  const items = itemsQuery.data ?? [];
  const flags = flagsQuery.data ?? [];

  const rows = useMemo<ReviewRow[]>(() => {
    // Practice items are never on the appraisal list. Awarded / owner-assigned
    // items are also excluded — they aren't going into the pool at all.
    const eligible = items.filter(
      (it) =>
        !it.isPractice &&
        it.status !== "awarded" &&
        it.status !== "owner_assigned" &&
        it.status !== "duplicate_dismissed",
    );
    return eligible.map((it) => {
      const active = flags.find((f) => f.itemId === it.id && f.revertedAt == null) ?? null;
      return {
        item: it,
        activeFlag: active,
        locked: active?.flaggedBySource === "owner",
      };
    });
  }, [items, flags]);

  const flaggedRows = rows.filter((r) => !!r.activeFlag);
  const unflaggedRows = rows.filter((r) => !r.activeFlag);

  const revert = useMutation({
    mutationFn: async (nominationId: number) =>
      (await apiRequest("POST", `/api/appraisal/${nominationId}/revert`, {})).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/appraisal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/items"] });
    },
    onError: (e: Error) =>
      toast({ title: "Could not uncheck", description: e.message, variant: "destructive" }),
  });

  const flag = useMutation({
    mutationFn: async (itemId: number) =>
      (
        await apiRequest("POST", "/api/appraisal/flag", {
          itemId,
          reason: "Captain added on review",
        })
      ).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/appraisal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/items"] });
    },
    onError: (e: Error) =>
      toast({ title: "Could not add", description: e.message, variant: "destructive" }),
  });

  const openRanking = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/session/mark-inventory-complete", {
          participantId: userId,
        })
      ).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({
        title: "Ranking is open",
        description: "The heirs can start ranking now.",
      });
      navigate("/admin");
    },
    onError: (e: Error) =>
      toast({ title: "Could not open ranking", description: e.message, variant: "destructive" }),
  });

  /**
   * Bulk-uncheck every non-locked flagged row. Owner-source rows stay flagged
   * (they're locked). Fires the revert calls sequentially so the audit trail
   * stays tidy.
   */
  const bulkUncheckAll = async () => {
    for (const r of flaggedRows) {
      if (r.locked || !r.activeFlag) continue;
      await revert.mutateAsync(r.activeFlag.id);
    }
  };

  const bulkCheckAll = async () => {
    for (const r of unflaggedRows) {
      await flag.mutateAsync(r.item.id);
    }
  };

  const phase = state?.session.phase ?? "welcome";
  const isCaptain = state?.session.captainParticipantId === userId;
  const canOpenRanking = phase === "intake" && isCaptain;

  if (stateLoading || itemsQuery.isLoading || flagsQuery.isLoading) {
    return (
      <AppShell>
        <PageHeader title="Appraisal review" />
        <LoadingRows />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Appraisal review"
        subtitle={
          phase === "intake"
            ? "One last look before the game opens."
            : "You can still add or remove items from the appraisal list."
        }
      />

      {/* The captain is not the boss — verbatim per user rule. Displayed as
          the FIRST thing on the page so it can't be missed. */}
      <Card
        className="border-amber-400/60 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
        data-testid="card-captain-not-boss"
      >
        <CardContent className="flex items-start gap-3 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-700 dark:text-amber-300" />
          <div className="text-sm">
            <p className="font-semibold" data-testid="text-captain-not-boss">
              The captain is not the boss!
            </p>
            <p className="mt-1 text-muted-foreground">
              Your heirs and the family rules already picked what should be
              looked at. Your job here is a last check — add anything they
              missed, or take off anything that clearly doesn't need the
              appraiser's time. When in doubt, leave it on. It costs nothing to
              have an appraiser look at an item that turns out not to matter.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Section 1: already flagged */}
      <Card data-testid="card-flagged-section">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold" data-testid="text-flagged-heading">
                Going for formal appraisal ({flaggedRows.length})
              </h2>
              <p className="text-xs text-muted-foreground">
                Anything checked here will wait outside the game while the
                an appraiser gets a real number for it. Uncheck to keep it in the
                game.
              </p>
            </div>
            {flaggedRows.some((r) => !r.locked) && (
              <Button
                size="sm"
                variant="outline"
                data-testid="button-bulk-uncheck-all"
                onClick={bulkUncheckAll}
                disabled={revert.isPending}
              >
                Uncheck all I can
              </Button>
            )}
          </div>
          {flaggedRows.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-flagged-empty">
              Nothing has been flagged yet. That's OK — you can add items
              from the list below.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {flaggedRows.map((r) => (
                <li
                  key={r.item.id}
                  className="flex items-start gap-3 px-3 py-2 text-sm"
                  data-testid={`row-flagged-${r.item.id}`}
                >
                  <Checkbox
                    checked
                    disabled={r.locked || revert.isPending}
                    onCheckedChange={() => {
                      if (r.locked || !r.activeFlag) return;
                      revert.mutate(r.activeFlag.id);
                    }}
                    data-testid={`checkbox-flagged-${r.item.id}`}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.item.name}</span>
                      {r.item.room && (
                        <span className="text-xs text-muted-foreground">· {r.item.room}</span>
                      )}
                      <Badge variant="outline" className="text-[10px]">
                        {r.activeFlag?.flaggedBySource === "ai" && "AI estimate"}
                        {r.activeFlag?.flaggedBySource === "category" && "Category rule"}
                        {r.activeFlag?.flaggedBySource === "heir" && "Someone flagged it"}
                        {r.activeFlag?.flaggedBySource === "owner" && "The owner marked this"}
                      </Badge>
                      {r.locked && (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
                          data-testid={`text-locked-${r.item.id}`}
                        >
                          <Lock className="h-3 w-3" /> locked
                        </span>
                      )}
                    </div>
                    {r.activeFlag?.reason && (
                      <p
                        className="mt-0.5 text-xs text-muted-foreground"
                        data-testid={`text-reason-${r.item.id}`}
                      >
                        {r.activeFlag.reason}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Section 2: not flagged */}
      <Card data-testid="card-unflagged-section">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold" data-testid="text-unflagged-heading">
                Staying in the game ({unflaggedRows.length})
              </h2>
              <p className="text-xs text-muted-foreground">
                Check any item you'd like an appraiser to look at. It will
                leave the game and wait for a real appraisal.
              </p>
            </div>
            {unflaggedRows.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                data-testid="button-bulk-check-all"
                onClick={bulkCheckAll}
                disabled={flag.isPending}
              >
                Check them all
              </Button>
            )}
          </div>
          {unflaggedRows.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-unflagged-empty">
              Nothing left in the game — everything is going to appraisal.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {unflaggedRows.map((r) => (
                <li
                  key={r.item.id}
                  className="flex items-start gap-3 px-3 py-2 text-sm"
                  data-testid={`row-unflagged-${r.item.id}`}
                >
                  <Checkbox
                    checked={false}
                    disabled={flag.isPending}
                    onCheckedChange={() => flag.mutate(r.item.id)}
                    data-testid={`checkbox-unflagged-${r.item.id}`}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.item.name}</span>
                      {r.item.room && (
                        <span className="text-xs text-muted-foreground">· {r.item.room}</span>
                      )}
                      {r.item.category && (
                        <span className="text-xs text-muted-foreground">· {r.item.category}</span>
                      )}
                      {r.item.aiEstimatedValue != null && (
                        <span
                          className="text-xs tabular-nums text-muted-foreground"
                          data-testid={`text-ai-estimate-${r.item.id}`}
                        >
                          AI est. {fmtMoney(r.item.aiEstimatedValue)}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Confirm and open ranking */}
      {phase === "intake" && (
        <Card data-testid="card-open-ranking">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="text-sm font-medium" data-testid="text-open-ranking-title">
                Ready to open the game?
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The heirs will be able to start ranking. You can come back to
                this screen any time before appraisals are finished.
              </p>
            </div>
            {!confirming ? (
              <Button
                data-testid="button-open-ranking"
                onClick={() => setConfirming(true)}
                disabled={!canOpenRanking}
                title={!canOpenRanking ? "Only the captain can open ranking." : undefined}
              >
                <ClipboardCheck className="mr-1 h-4 w-4" /> Open ranking
              </Button>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  data-testid="button-open-ranking-cancel"
                  onClick={() => setConfirming(false)}
                  disabled={openRanking.isPending}
                >
                  Wait, take me back
                </Button>
                <Button
                  data-testid="button-open-ranking-confirm"
                  onClick={() => openRanking.mutate()}
                  disabled={openRanking.isPending}
                >
                  <CheckCircle2 className="mr-1 h-4 w-4" /> Yes, open ranking
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}
