/**
 * v6 — categories, everywhere they are needed.
 *
 * Categories are optional in v6, so nothing here ever demands one. An item
 * without a category simply wears a quiet grey chip, and anyone permitted can
 * tap it to suggest a better home. The same picker is reused on Inventory, in
 * the ranking panes, and in the review queue so the gesture is always the same.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, History, Sparkles, X } from "lucide-react";
import {
  STANDARD_CATEGORIES,
  UNCATEGORIZED_LABEL,
  parseAiSuggestions,
  type Item,
} from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { STATE_KEY, useAppState, useUser } from "@/lib/app";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/* ------------------------------------------------------------------ */
/* Permission                                                          */
/* ------------------------------------------------------------------ */

/** The captain always may; heirs may while the Administration toggle is on. */
export function useCanCategorize(): boolean {
  const { data } = useAppState();
  const { userId } = useUser();
  const me = data?.participants.find((p) => p.id === userId) ?? null;
  if (!data) return false;
  if (!me || me.isAdmin) return true;
  return !!data.session.heirsCanCategorize;
}

/* ------------------------------------------------------------------ */
/* Write path                                                          */
/* ------------------------------------------------------------------ */

type CategoryResponse = {
  item: Item;
  throttled?: boolean;
  throttleMessage?: string;
  conflict?: boolean;
  needsDiscussion?: boolean;
};

/**
 * One shared mutation for every category edit in the app. A burst of edits
 * earns a gentle warning, never a refusal.
 */
export function useSetCategory() {
  const { userId } = useUser();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (v: {
      itemId: number;
      category: string | null;
      dismissAiSuggestion?: boolean;
    }) => {
      const res = await apiRequest("POST", `/api/items/${v.itemId}/category`, {
        category: v.category,
        dismissAiSuggestion: v.dismissAiSuggestion,
        participantId: userId,
      });
      return (await res.json()) as CategoryResponse;
    },
    onSuccess: (out) => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/taxonomy"] });
      if (out?.throttled) {
        toast({
          title: "That is a lot of changes at once",
          description: out.throttleMessage ?? "Give the others a chance to weigh in.",
          className:
            "border-[#c9a227] bg-[#fdf3d0] text-[#5a4409] dark:bg-[#3a3007] dark:text-[#f4e2a1]",
        });
        return;
      }
      if (out?.needsDiscussion) {
        toast({
          title: "Two people, two answers",
          description: "This item is marked for discussion — talk it over before it sticks.",
        });
        return;
      }
      toast({
        title: out?.item?.category ? `Filed under ${out.item.category}` : "Category cleared",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Could not change the category", description: e.message, variant: "destructive" }),
  });
}

/* ------------------------------------------------------------------ */
/* Picker                                                              */
/* ------------------------------------------------------------------ */

/** The chip grid itself, without any trigger around it. */
export function CategoryChipGrid({
  value,
  onPick,
  suggestions = [],
  idPrefix = "category",
}: {
  value: string | null;
  onPick: (category: string | null) => void;
  suggestions?: { category: string; confidence: number }[];
  idPrefix?: string;
}) {
  const [custom, setCustom] = useState("");
  const suggested = suggestions.map((s) => s.category);
  return (
    <div className="space-y-3" data-testid={`picker-${idPrefix}`}>
      {suggested.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs uppercase tracking-[0.14em] text-muted-foreground">
            Suggested
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.slice(0, 3).map((s) => (
              <button
                key={s.category}
                type="button"
                data-testid={`chip-suggested-${idPrefix}-${s.category}`}
                onClick={() => onPick(s.category)}
                className="rounded-full border border-primary/40 bg-primary/5 px-2.5 py-1 text-xs hover-elevate"
              >
                <Sparkles className="mr-1 inline h-3 w-3" />
                {s.category}
                <span className="ml-1 text-muted-foreground">{Math.round(s.confidence * 100)}%</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div>
        <p className="mb-1.5 text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Categories
        </p>
        <div className="flex flex-wrap gap-1.5">
          {STANDARD_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`chip-${idPrefix}-${c}`}
              onClick={() => onPick(c)}
              className={`rounded-full border px-2.5 py-1 text-xs hover-elevate ${
                value === c ? "border-primary bg-primary/10 font-medium" : "border-border"
              }`}
            >
              {value === c && <Check className="mr-1 inline h-3 w-3" />}
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          value={custom}
          placeholder="Something else…"
          className="h-8 text-xs"
          data-testid={`input-custom-${idPrefix}`}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom.trim()) {
              e.preventDefault();
              onPick(custom.trim());
              setCustom("");
            }
          }}
        />
        <Button
          size="sm"
          variant="outline"
          data-testid={`button-custom-${idPrefix}`}
          disabled={!custom.trim()}
          onClick={() => {
            onPick(custom.trim());
            setCustom("");
          }}
        >
          Use
        </Button>
      </div>
      {value && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          data-testid={`button-clear-${idPrefix}`}
          onClick={() => onPick(null)}
        >
          <X className="mr-1 h-3 w-3" />
          Leave it uncategorized
        </Button>
      )}
    </div>
  );
}

/**
 * The chip an item wears. Grey and quiet when nothing has been chosen; tap to
 * open the picker when this participant is allowed to categorise.
 */
export function CategoryChip({
  item,
  idPrefix = "inv",
  affordance = "chip",
}: {
  item: Item;
  idPrefix?: string;
  /** "chip" shows the category or a grey placeholder; "add" shows "+ Add category". */
  affordance?: "chip" | "add";
}) {
  const canEdit = useCanCategorize();
  const setCategory = useSetCategory();
  const [open, setOpen] = useState(false);
  const suggestions = parseAiSuggestions(item.aiSuggestions);
  const isAuto = item.aiCategorySource === "auto" && !!item.category;

  const label = item.category ?? UNCATEGORIZED_LABEL;

  const face =
    affordance === "add" && !item.category ? (
      <span
        className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground"
        data-testid={`button-add-category-${item.id}`}
      >
        + Add category
      </span>
    ) : (
      <Badge
        variant={item.category ? "outline" : "secondary"}
        className={
          item.category
            ? ""
            : "border-dashed bg-muted/60 text-muted-foreground"
        }
        data-testid={
          item.category ? `badge-category-${item.id}` : `badge-uncategorized-${item.id}`
        }
      >
        {isAuto && <Sparkles className="mr-1 h-3 w-3" />}
        {label}
      </Badge>
    );

  if (!canEdit) return face;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-full hover-elevate"
          aria-label={`Change the category on ${item.name}`}
          data-testid={`button-category-${idPrefix}-${item.id}`}
        >
          {face}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80"
        data-testid={`popover-category-${item.id}`}
      >
        <CategoryChipGrid
          value={item.category ?? null}
          suggestions={suggestions}
          idPrefix={`${idPrefix}-${item.id}`}
          onPick={(c) => {
            setOpen(false);
            setCategory.mutate({ itemId: item.id, category: c });
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Amber marker for the two-people-disagreed case. */
export function DiscussionBadge({ item }: { item: Item }) {
  const canEdit = useCanCategorize();
  const resolve = useMutation({
    mutationFn: async () =>
      apiRequest("POST", `/api/items/${item.id}/discussion-resolved`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STATE_KEY }),
  });
  if (!item.needsDiscussion) return null;
  return (
    <button
      type="button"
      disabled={!canEdit || resolve.isPending}
      onClick={() => canEdit && resolve.mutate()}
      data-testid={`badge-needs-discussion-${item.id}`}
      className="rounded-full border border-[#c9a227] bg-[#fdf3d0] px-2 py-0.5 text-[11px] text-[#5a4409] hover-elevate dark:bg-[#3a3007] dark:text-[#f4e2a1]"
      title={canEdit ? "Tap once the family has agreed" : undefined}
    >
      Discussion needed
    </button>
  );
}

/** The analyser's hunch that something may need an appraisal. */
export function HighValueSuggestion({ item }: { item: Item }) {
  const { userId } = useUser();
  const { toast } = useToast();
  const act = useMutation({
    mutationFn: async (accept: boolean) =>
      apiRequest("POST", `/api/items/${item.id}/ai-high-value`, { accept, participantId: userId }),
    onSuccess: (_d, accept) => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({
        title: accept ? "Marked as high value" : "Suggestion dismissed",
      });
    },
  });
  if (!item.aiSuggestsHighValue) return null;
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-[#c9a227]/50 bg-[#fdf3d0]/50 px-2.5 py-1.5 text-xs dark:bg-[#3a3007]/40"
      data-testid={`suggestion-high-value-${item.id}`}
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        This might be high value
        {item.aiHighValueReason ? `: ${item.aiHighValueReason}` : "."} Mark it as high-value?
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        data-testid={`button-accept-high-value-${item.id}`}
        disabled={act.isPending}
        onClick={() => act.mutate(true)}
      >
        Yes
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        data-testid={`button-dismiss-high-value-${item.id}`}
        disabled={act.isPending}
        onClick={() => act.mutate(false)}
      >
        Dismiss
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

type HistoryRow = {
  id: number;
  oldCategory: string | null;
  newCategory: string | null;
  changedAt: number;
  source: string;
  changedByName: string;
};

const SOURCE_WORD: Record<string, string> = {
  ai_auto: "sorted automatically",
  ai_dismissed: "overrode the suggestion",
  reviewed_by_heir: "chose",
  reviewed_by_captain: "chose",
  user: "chose",
};

/** A collapse under each item: who filed it where, and when. */
export function CategoryHistory({ itemId }: { itemId: number }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<{ changes: HistoryRow[] }>({
    queryKey: ["/api/items", itemId, "category-history"],
    queryFn: async () =>
      (await apiRequest("GET", `/api/items/${itemId}/category-history`)).json(),
    enabled: open,
  });
  return (
    <div className="mt-1.5">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-4 hover:underline"
        data-testid={`button-category-history-${itemId}`}
        onClick={() => setOpen((v) => !v)}
      >
        <History className="h-3 w-3" />
        {open ? "Hide history" : "See history"}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground" data-testid={`list-category-history-${itemId}`}>
          {isLoading && <li>Loading…</li>}
          {!isLoading && (data?.changes ?? []).length === 0 && <li>No changes recorded.</li>}
          {(data?.changes ?? []).map((c) => (
            <li key={c.id} data-testid={`row-category-history-${c.id}`}>
              {c.changedByName} {SOURCE_WORD[c.source] ?? "changed"}{" "}
              {c.newCategory ? <strong>{c.newCategory}</strong> : <em>no category</em>}
              {c.oldCategory ? ` (was ${c.oldCategory})` : ""} ·{" "}
              {new Date(c.changedAt).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
