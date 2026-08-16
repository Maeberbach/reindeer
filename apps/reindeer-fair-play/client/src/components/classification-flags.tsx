import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { STATE_KEY, useAppState, useUser } from "@/lib/app";
import { CLASSIFICATION_OPEN_PHASES, FLAG_LABEL, type ClassificationFlag } from "@shared/schema";
import type { Item } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Gem, Heart, Lock, Sparkles } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const FLAGS: { flag: ClassificationFlag; icon: typeof Gem; column: keyof Item }[] = [
  { flag: "isHeirloom", icon: Sparkles, column: "isHeirloomCandidate" },
  { flag: "needsAppraisal", icon: Gem, column: "needsAppraisal" as keyof Item },
  { flag: "isSentimental", icon: Heart, column: "isSentimental" as keyof Item },
];

/** Read-only chips for the three classification flags an item carries. */
export function FlagBadges({ item }: { item: Item }) {
  const on = FLAGS.filter((f) => !!(item as any)[f.column]);
  if (!on.length) return null;
  return (
    <span className="flex flex-wrap gap-1" data-testid={`flags-item-${item.id}`}>
      {on.map((f) => (
        <Badge
          key={f.flag}
          variant={f.flag === "needsAppraisal" ? "default" : "outline"}
          className="text-[10px]"
          data-testid={`badge-flag-${f.flag}-${item.id}`}
        >
          {FLAG_LABEL[f.flag]}
        </Badge>
      ))}
    </span>
  );
}

/**
 * The three toggles any heir may set while cataloguing or ranking. They lock
 * themselves once the draft begins — the server refuses the write too.
 */
export function FlagToggles({ item, compact = false }: { item: Item; compact?: boolean }) {
  const { data } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [openFor, setOpenFor] = useState<ClassificationFlag | null>(null);
  const phase = data?.session.phase ?? "welcome";
  const locked = !(CLASSIFICATION_OPEN_PHASES as readonly string[]).includes(phase);

  const setFlag = useMutation({
    mutationFn: async (vars: { flag: ClassificationFlag; value: boolean; reason: string }) => {
      const res = await apiRequest("PATCH", `/api/items/${item.id}/flags`, {
        participantId: userId,
        flags: { [vars.flag]: vars.value },
        reason: vars.reason,
      });
      return res.json();
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/classification-changes"] });
      // A high-value flag strips the item from everyone's ranking, so the
      // ranking panes have to be refetched, not only the shared state.
      queryClient.invalidateQueries({ queryKey: ["/api/rankings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications/mine"] });
      toast({
        title: vars.value ? `Marked ${FLAG_LABEL[vars.flag]}` : `Removed ${FLAG_LABEL[vars.flag]}`,
        description:
          vars.flag === "needsAppraisal" && vars.value
            ? "It is out of the ranking and draft pools until the captain reverts it."
            : `“${item.name}”`,
      });
      setReason("");
      setOpenFor(null);
    },
    onError: (e: Error) =>
      toast({ title: "Could not change", description: e.message, variant: "destructive" }),
  });

  if (locked) {
    return (
      <span
        className="flex items-center gap-1 text-xs text-muted-foreground"
        data-testid={`flags-locked-${item.id}`}
      >
        <Lock className="h-3 w-3" /> Classifications locked
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-1" data-testid={`flag-toggles-${item.id}`}>
      {FLAGS.map(({ flag, icon: Icon, column }) => {
        const active = !!(item as any)[column];
        const needsReason = flag === "needsAppraisal";
        const button = (
          <Button
            key={flag}
            size="sm"
            variant={active ? "default" : "outline"}
            className={compact ? "h-7 px-2 text-xs" : ""}
            data-testid={`button-flag-${flag}-${item.id}`}
            data-active={active ? "true" : "false"}
            disabled={setFlag.isPending}
            onClick={() => {
              if (needsReason) {
                setOpenFor(openFor === flag ? null : flag);
                return;
              }
              setFlag.mutate({ flag, value: !active, reason: "" });
            }}
          >
            <Icon className="mr-1 h-3 w-3" />
            {FLAG_LABEL[flag]}
          </Button>
        );
        if (!needsReason) return button;
        return (
          <Popover
            key={flag}
            open={openFor === flag}
            onOpenChange={(o) => setOpenFor(o ? flag : null)}
          >
            <PopoverTrigger asChild>{button}</PopoverTrigger>
            <PopoverContent className="w-72" data-testid={`popover-high-value-${item.id}`}>
              <p className="text-sm">
                {active
                  ? "Remove the high-value flag and return it to the pools?"
                  : "Flagging high value removes this item from every ranking and from the draft pool."}
              </p>
              <Input
                className="mt-3"
                placeholder="Reason (optional)"
                value={reason}
                data-testid={`input-flag-reason-${item.id}`}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                size="sm"
                className="mt-3 w-full"
                data-testid={`button-confirm-high-value-${item.id}`}
                onClick={() => setFlag.mutate({ flag, value: !active, reason })}
              >
                {active ? "Remove flag" : "Flag high value"}
              </Button>
            </PopoverContent>
          </Popover>
        );
      })}
    </span>
  );
}
