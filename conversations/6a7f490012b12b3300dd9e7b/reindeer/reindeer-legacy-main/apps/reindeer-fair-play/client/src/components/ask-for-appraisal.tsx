/**
 * "Ask for an appraisal" — the v14 escalation any heir (or the captain) may press
 * on any item at any time before the estate closes. It hits
 *   POST /api/fiduciary/items/:itemId/flag-high-value
 * which is:
 *   - not phase-locked (works during ranking and beyond, unlike the old
 *     classification-flag toggle),
 *   - authenticated by cookie session only (identity is req.actor; body
 *     carries only a reason, never a participantId),
 *   - idempotent (pressing it on an already-flagged item is a no-op that
 *     still writes an audit row with the new reason).
 *
 * A confirm popover lets the person add a short reason before sending — the
 * reason lands on the audit trail and later on the Record of Decisions so the
 * appraisal reviewer understands why the item is on the pending list.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { STATE_KEY } from "@/lib/app";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { Item } from "@shared/schema";
import { Gavel } from "lucide-react";

async function postFlag(itemId: number, reason: string): Promise<Item> {
  const res = await fetch(`/api/fiduciary/items/${itemId}/flag-high-value`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ reason }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data && typeof data === "object" && "message" in data && (data as { message?: string }).message) ||
        `Could not ask for an appraisal (${res.status}).`,
    );
  }
  return data as Item;
}

export function AskForAppraisalButton({
  item,
  size = "sm",
  variant = "outline",
  compact = false,
}: {
  item: Item;
  size?: "sm" | "default" | "lg";
  variant?: "default" | "outline" | "secondary" | "ghost";
  compact?: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const flag = useMutation({
    mutationFn: () => postFlag(item.id, reason.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/fiduciary/items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fiduciary/record-of-decisions"] });
      toast({
        title: "Appraisal requested",
        description: item.needsAppraisal
          ? `“${item.name}” is already on the high-value list — your reason has been added.`
          : `“${item.name}” has been added to the high-value list. It will be flagged for appraisal.`,
      });
      setOpen(false);
      setReason("");
    },
    onError: (e: Error) => {
      toast({
        title: "We couldn't send your request",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size={size}
          variant={variant}
          data-testid={`button-ask-appraisal-${item.id}`}
          // Elderly-friendly target: 44px min touch area regardless of size prop.
          className={compact ? "min-h-[44px] min-w-[44px]" : "min-h-[44px] gap-1.5"}
        >
          <Gavel className={compact ? "h-4 w-4" : "mr-1.5 h-4 w-4"} />
          {compact ? null : item.needsAppraisal ? "Add appraisal reason" : "Ask for appraisal"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="end" data-testid={`popover-ask-appraisal-${item.id}`}>
        <div>
          <p className="font-serif text-base font-semibold">
            {item.needsAppraisal ? "Add a reason for the appraisal" : "Ask for an appraisal"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.needsAppraisal
              ? `“${item.name}” is already on the high-value list. Your reason will be added to the appraisal record.`
              : `“${item.name}” will move to the high-value list. It stays in the draft, but its value will be determined by an appraiser after FairPlay ends.`}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ask-appraisal-reason-${item.id}`} className="text-sm">
            Why (optional)
          </Label>
          <Textarea
            id={`ask-appraisal-reason-${item.id}`}
            data-testid={`input-ask-appraisal-reason-${item.id}`}
            placeholder="e.g. It may be worth more than the estimate. Please have it appraised."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="text-sm"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="ghost"
            className="min-h-[44px]"
            data-testid={`button-ask-appraisal-cancel-${item.id}`}
            disabled={flag.isPending}
            onClick={() => {
              setReason("");
              setOpen(false);
            }}
          >
            Not now
          </Button>
          <Button
            className="min-h-[44px]"
            data-testid={`button-ask-appraisal-confirm-${item.id}`}
            disabled={flag.isPending}
            onClick={() => flag.mutate()}
          >
            {flag.isPending ? "Sending…" : "Send request"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
