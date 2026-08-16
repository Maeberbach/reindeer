/**
 * InterestSelector — per-heir, per-item desire level.
 *
 * Three options: Want it, Interested, Don't care.
 * Optional — an heir can leave it unset.
 *
 * Particularly surfaced for high-value and contested categories
 * (heirlooms, jewelry, etc.), but available for ALL items.
 *
 * The data feeds into the draft algorithm (how exactly is TBD by Mark).
 * When 2+ heirs mark "want" on the same item, the server auto-flags
 * it as an heirloom candidate for resolution.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Heart, Minus, Sparkles } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { Item } from "@shared/schema";

export type InterestLevel = "want" | "interested" | "dont_care";

const INTEREST_META: Record<
  InterestLevel,
  { label: string; icon: typeof Heart; classes: string; activeClasses: string }
> = {
  want: {
    label: "Want it",
    icon: Heart,
    classes: "text-muted-foreground hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30",
    activeClasses: "bg-rose-100 text-rose-700 border-rose-300 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800",
  },
  interested: {
    label: "Interested",
    icon: Sparkles,
    classes: "text-muted-foreground hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/30",
    activeClasses: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800",
  },
  dont_care: {
    label: "Don't care",
    icon: Minus,
    classes: "text-muted-foreground hover:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-900/30",
    activeClasses: "bg-slate-100 text-slate-500 border-slate-300 dark:bg-slate-800/50 dark:text-slate-400 dark:border-slate-700",
  },
};

type InterestRow = {
  id: number;
  participantId: number;
  itemId: number;
  interest: InterestLevel;
  createdAt: number;
  updatedAt: number;
};

type InterestResponse = { interests: InterestRow[] };

/** Check if an item is high-value or in a contested category. */
function isHighPriority(item: Item): boolean {
  if (item.needsAppraisal) return true;
  if (item.isHeirloomConfirmed || item.isHeirloomCandidate) return true;
  const contested = ["heirloom", "jewelry", "art", "antique", "collectible"];
  if (item.category && contested.some((c) => item.category!.toLowerCase().includes(c))) {
    return true;
  }
  return false;
}

export function InterestSelector({
  item,
  participantId,
  compact = false,
}: {
  item: Item;
  participantId: number;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const [localInterest, setLocalInterest] = useState<InterestLevel | null>(null);

  const { data } = useQuery<InterestResponse>({
    queryKey: ["/api/interests", participantId],
    staleTime: Infinity,
  });

  const current: InterestLevel | null = (() => {
    if (localInterest !== null) return localInterest;
    const row = data?.interests?.find((r) => r.itemId === item.id);
    return (row?.interest as InterestLevel) ?? null;
  })();

  const mutation = useMutation({
    mutationFn: async (interest: InterestLevel) => {
      const res = await apiRequest("PUT", `/api/interests/${participantId}`, {
        itemId: item.id,
        interest,
      });
      return res.json();
    },
    onMutate: (interest) => {
      setLocalInterest(interest);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/interests", participantId] });
      queryClient.invalidateQueries({ queryKey: ["/api/interests"] });
    },
    onError: () => {
      setLocalInterest(null);
    },
  });

  const highPriority = isHighPriority(item);

  if (compact) {
    return (
      <div className="flex items-center gap-1" data-testid={`interest-selector-${item.id}`}>
        {(["want", "interested", "dont_care"] as InterestLevel[]).map((level) => {
          const meta = INTEREST_META[level];
          const Icon = meta.icon;
          const active = current === level;
          return (
            <button
              key={level}
              type="button"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(level)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                active ? meta.activeClasses : `border-transparent ${meta.classes}`,
              )}
              aria-pressed={active}
              aria-label={`${meta.label} for ${item.name}`}
              data-testid={`button-interest-${level}-${item.id}`}
            >
              <Icon className="h-3 w-3" />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border p-2",
        highPriority ? "border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20" : "border-border bg-card",
      )}
      data-testid={`interest-selector-${item.id}`}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {highPriority && <Sparkles className="h-3 w-3 text-amber-500" />}
        <span>My interest{highPriority ? " · high-priority item" : ""}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(["want", "interested", "dont_care"] as InterestLevel[]).map((level) => {
          const meta = INTEREST_META[level];
          const Icon = meta.icon;
          const active = current === level;
          return (
            <button
              key={level}
              type="button"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(level)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                active ? meta.activeClasses : `border-border ${meta.classes}`,
              )}
              aria-pressed={active}
              aria-label={`${meta.label} for ${item.name}`}
              data-testid={`button-interest-${level}-${item.id}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {meta.label}
            </button>
          );
        })}
        {current && (
          <button
            type="button"
            onClick={() => setLocalInterest(null)}
            className="text-[11px] text-muted-foreground underline hover:text-foreground"
            data-testid={`button-interest-clear-${item.id}`}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/** Captain-only view: shows all heirs' interests for a contested item. */
export function InterestSummary({ item }: { item: Item }) {
  const { data } = useQuery<{
    contested: { itemId: number; wantCount: number; itemName: string; interests: { interest: string; heirName: string }[] }[];
  }>({
    queryKey: ["/api/interests/contested"],
    staleTime: 10_000,
  });

  const entry = data?.contested.find((c) => c.itemId === item.id);
  if (!entry) return null;

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={`interest-summary-${item.id}`}>
      <span className="text-[11px] font-medium text-muted-foreground">
        {entry.wantCount} want
      </span>
      {entry.interests.map((i, idx) => (
        <span
          key={idx}
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            i.interest === "want" && "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
            i.interest === "interested" && "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
            i.interest === "dont_care" && "bg-slate-100 text-slate-500 dark:bg-slate-800/50 dark:text-slate-400",
          )}
        >
          {i.heirName}: {i.interest}
        </span>
      ))}
    </div>
  );
}
