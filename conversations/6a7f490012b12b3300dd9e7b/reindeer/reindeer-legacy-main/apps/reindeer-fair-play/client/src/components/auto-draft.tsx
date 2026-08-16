import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { STATE_KEY, useAppState, useUser } from "@/lib/app";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PauseCircle, Sparkles } from "lucide-react";
import { ReconciliationAdminBanner } from "@/components/admin-flow-cards";

/**
 * A quiet line on the draft page explaining that rounds are resolving on their
 * own, plus the captain's check-in banner when one is open.
 */
export function AutoDraftBanner() {
  const { data } = useAppState();
  const { userId } = useUser();
  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const rec = data?.reconciliation;
  const phase = data?.session.phase ?? "welcome";
  const inDraft = phase === "draft" || phase === "secondary_draft";
  if (!inDraft || !rec) return null;

  return (
    <>
      {me?.isAdmin && <ReconciliationAdminBanner />}
      <div
        className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-4 py-2 text-sm"
        data-testid="banner-auto-draft"
        data-auto-enabled={rec.autoEnabled ? "true" : "false"}
        data-auto-paused={rec.paused ? "true" : "false"}
      >
        {rec.paused ? (
          <PauseCircle className="h-4 w-4 text-muted-foreground" />
        ) : (
          <Sparkles className="h-4 w-4 text-primary" />
        )}
        <span data-testid="text-auto-draft-status">
          {!rec.autoEnabled
            ? "Automatic rounds are off — the captain reveals each round by hand."
            : rec.paused
              ? "Automatic rounds are paused. The captain can resume them."
              : "Automatic rounds are on. Uncontested rounds resolve from everyone's ranked lists."}
        </span>
        {rec.autoEnabled && (
          <Badge variant="outline" className="ml-auto" data-testid="badge-auto-streak-draft">
            {rec.streak}/{rec.interval} to the next check-in
          </Badge>
        )}
      </div>
    </>
  );
}

/**
 * Every heir must answer the check-in before the automation carries on. One
 * "pause" stops it for the whole table.
 */
export function ReconciliationModal() {
  const { data } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const rec = data?.reconciliation;
  const me = data?.participants.find((p) => p.id === userId) ?? null;

  const respond = useMutation({
    mutationFn: async (choice: "continue" | "pause") =>
      (
        await apiRequest("POST", "/api/reconciliation/respond", {
          participantId: userId,
          choice,
        })
      ).json(),
    onSuccess: (_d, choice) => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({
        title: choice === "continue" ? "Answered: continue" : "Answered: pause",
        description:
          choice === "pause"
            ? "The automatic draft stops until the captain resumes it."
            : "Waiting on anyone who has not answered yet.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Could not answer", description: e.message, variant: "destructive" }),
  });

  const mustAnswer =
    !!rec?.active &&
    !!me &&
    !me.administersOnly &&
    !Object.prototype.hasOwnProperty.call(rec.responses ?? {}, String(me.id));

  return (
    <Dialog open={mustAnswer}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="dialog-reconciliation"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Check in — round {rec?.round}</DialogTitle>
          <DialogDescription>
            {rec?.interval} rounds have resolved automatically. Is everyone content to carry on, or
            should the table pause and look at where things stand? One pause stops the automation
            for everybody.
          </DialogDescription>
        </DialogHeader>
        <div className="text-xs text-muted-foreground" data-testid="text-reconciliation-pending">
          {(rec?.responded ?? []).length} of{" "}
          {(rec?.responded ?? []).length + (rec?.pending ?? []).length} answered
          {(rec?.pending ?? []).length > 0
            ? ` · waiting on ${(rec?.pending ?? []).map((p) => p.name).join(", ")}`
            : ""}
        </div>
        <div className="flex gap-2">
          <Button
            className="flex-1"
            data-testid="button-reconciliation-continue"
            disabled={respond.isPending}
            onClick={() => respond.mutate("continue")}
          >
            Continue
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            data-testid="button-reconciliation-pause"
            disabled={respond.isPending}
            onClick={() => respond.mutate("pause")}
          >
            Pause
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
