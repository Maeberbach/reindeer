import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { STATE_KEY, SESSION_LIFECYCLE_KEY, useUser } from "@/lib/app";
import { PAUSE_REASON_MAX_LEN } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

function invalidateLifecycle() {
  queryClient.invalidateQueries({ queryKey: STATE_KEY });
  queryClient.invalidateQueries({ queryKey: SESSION_LIFECYCLE_KEY });
}

/* ------------------------------------------------------------------ */
/* Pause dialog                                                        */
/* ------------------------------------------------------------------ */
export function PauseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { userId } = useUser();
  const { toast } = useToast();
  const [reason, setReason] = useState("");

  const pause = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/session/lifecycle/pause", {
          participantId: userId,
          reason: reason.trim() || undefined,
        })
      ).json(),
    onSuccess: () => {
      invalidateLifecycle();
      toast({ title: "Estate paused", description: "Heirs will see a paused banner until you resume." });
      setReason("");
      onOpenChange(false);
    },
    onError: (e: Error) =>
      toast({ title: "Could not pause", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-pause-estate">
        <DialogHeader>
          <DialogTitle>Pause the estate?</DialogTitle>
          <DialogDescription>
            While paused, heirs cannot add inventory, submit rankings, or draft picks. You keep
            full read access and can resume anytime.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="pause-reason">Reason (optional)</Label>
          <Textarea
            id="pause-reason"
            data-testid="input-pause-reason"
            value={reason}
            maxLength={PAUSE_REASON_MAX_LEN}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Waiting on the appraiser's report before we continue…"
            rows={3}
          />
          <p className="text-right text-xs text-muted-foreground" data-testid="text-pause-reason-count">
            {reason.length}/{PAUSE_REASON_MAX_LEN}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" data-testid="button-cancel-pause" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="button-confirm-pause-estate"
            disabled={pause.isPending}
            onClick={() => pause.mutate()}
          >
            Pause estate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Resume dialog                                                       */
/* ------------------------------------------------------------------ */
export function ResumeDialog({
  open,
  onOpenChange,
  pausedAt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Epoch ms the estate was paused at, used to decide whether to offer the extend-window input. */
  pausedAt: number | null;
}) {
  const { userId } = useUser();
  const { toast } = useToast();
  const pauseDurationDays = pausedAt ? (Date.now() - pausedAt) / (24 * 60 * 60 * 1000) : 0;
  const showExtend = pauseDurationDays >= 1;
  const defaultExtend = Math.ceil(pauseDurationDays) + 1;
  const [extendDays, setExtendDays] = useState(defaultExtend);

  const resume = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/session/lifecycle/resume", {
          participantId: userId,
          extendRankingDays: showExtend ? extendDays : undefined,
        })
      ).json(),
    onSuccess: () => {
      invalidateLifecycle();
      toast({ title: "Estate resumed", description: "Everyone can continue where they left off." });
      onOpenChange(false);
    },
    onError: (e: Error) =>
      toast({ title: "Could not resume", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-resume-estate">
        <DialogHeader>
          <DialogTitle>Resume the estate?</DialogTitle>
          <DialogDescription>
            Heirs will be able to continue where they left off. Ranking countdowns will adjust for
            the time paused.
          </DialogDescription>
        </DialogHeader>
        {showExtend && (
          <div className="space-y-1.5">
            <Label htmlFor="extend-days">
              Extend ranking window by
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="extend-days"
                type="number"
                min={0}
                max={365}
                data-testid="input-extend-ranking-days"
                value={extendDays}
                onChange={(e) => setExtendDays(Math.max(0, Number(e.target.value) || 0))}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">days</span>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" data-testid="button-cancel-resume" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="button-confirm-resume-estate"
            disabled={resume.isPending}
            onClick={() => resume.mutate()}
          >
            Resume estate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
