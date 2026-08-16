import { useQuery, useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { STATE_KEY } from "@/lib/app";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import type { Participant } from "@shared/schema";

type Suggestion = { itemId: number; rank: number; name: string } | null;

/**
 * Pre-populates the pick window with the heir's top-ranked available item.
 * The heir confirms it, or ignores it and taps any item in the pool instead.
 */
export function RankSuggestion({
  me,
  round,
  canPick,
  onConfirm,
  submitting,
}: {
  me: Participant;
  round: number;
  canPick: boolean;
  onConfirm: (itemId: number) => void;
  submitting: boolean;
}) {
  const { toast } = useToast();

  const { data, isLoading } = useQuery<{ suggestion: Suggestion }>({
    queryKey: ["/api/picks/auto-suggest", me.id, round, canPick],
    enabled: canPick,
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/picks/auto-suggest", { participantId: me.id });
      return res.json();
    },
  });

  const toggleAuto = useMutation({
    mutationFn: async (autoSubmit: boolean) =>
      (
        await apiRequest("PATCH", `/api/participants/${me.id}`, {
          autoSubmit,
          actorId: me.id,
        })
      ).json(),
    onSuccess: (_r, autoSubmit) => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({
        title: autoSubmit ? "Auto-submit on" : "Auto-submit off",
        description: autoSubmit
          ? "Your highest-ranked available item will be submitted for you each round."
          : "You will choose manually each round.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Could not change auto-submit", description: e.message, variant: "destructive" }),
  });

  const s = data?.suggestion ?? null;

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3" data-testid="card-rank-suggestion">
      {canPick && (
        <div className="text-sm">
          {isLoading ? (
            <span className="text-muted-foreground">Checking your ranked list…</span>
          ) : s ? (
            <>
              <p data-testid="text-rank-suggestion">
                <Sparkles className="mr-1 inline h-3.5 w-3.5 text-primary" />
                Your #{s.rank} pick is available: <strong>{s.name}</strong>
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  data-testid="button-confirm-suggestion"
                  disabled={submitting}
                  onClick={() => onConfirm(s.itemId)}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="button-override-suggestion"
                  onClick={() =>
                    document
                      .querySelector('[data-testid="text-pool-heading"]')
                      ?.scrollIntoView({ behavior: "smooth" })
                  }
                >
                  Pick something else…
                </Button>
              </div>
            </>
          ) : (
            <p data-testid="text-no-ranks-left" className="text-muted-foreground">
              You have no more ranked items. Pass (no pick this round) — you can re-rank for the
              Secondary Draft.
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
        <div className="min-w-0">
          <Label htmlFor="auto-submit" className="text-sm font-medium">
            Auto-submit my top-ranked item
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Off by default. When on, each round submits your highest-ranked available item without
            waiting for you.
          </p>
        </div>
        <Switch
          id="auto-submit"
          checked={!!me.autoSubmit}
          data-testid="switch-auto-submit"
          disabled={toggleAuto.isPending}
          onCheckedChange={(v) => toggleAuto.mutate(v)}
        />
      </div>
    </div>
  );
}
