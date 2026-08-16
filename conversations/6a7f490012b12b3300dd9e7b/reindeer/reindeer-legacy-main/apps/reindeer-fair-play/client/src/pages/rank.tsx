import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  Lock,
  PencilLine,
  Plus,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { useLocation } from "wouter";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { ClassificationChangeBanner } from "@/components/notifications";
import { FlagToggles } from "@/components/classification-flags";
import { AskForAppraisalButton } from "@/components/ask-for-appraisal";
import { CategoryChip, DiscussionBadge } from "@/components/category-chips";
import { UNCATEGORIZED_LABEL } from "@shared/schema";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  STATE_KEY,
  activeWindowOf,
  money,
  useAppState,
  useCountdown,
  useIsCaptain,
  useUser,
} from "@/lib/app";
import { useToast } from "@/hooks/use-toast";
import type { Item } from "@shared/schema";

type AuditEntry = {
  id: string;
  itemId: number;
  itemName: string;
  oldRank: number | null;
  newRank: number | null;
  editedAt: number;
  editedByName: string;
  mode: string;
};
type AuditResponse = { entries: AuditEntry[]; active: AuditEntry[] };

type RankRow = { itemId: number; rank: number };
type RankResponse = {
  participantId: number;
  rankings: { itemId: number; rank: number }[];
  required: number;
  mode: string;
  locked: boolean;
};

/* ------------------------------------------------------------------ */
/* One row, draggable via pointer / touch / keyboard                    */
/* ------------------------------------------------------------------ */
function RankRowCard({
  item,
  rank,
  total,
  disabled,
  assistBadge,
  tinted,
  onMoveTo,
  onNudge,
  onRemove,
  onAdd,
  isCaptain,
}: {
  item: Item;
  rank: number | null;
  total: number;
  isCaptain: boolean;
  disabled: boolean;
  /** "Edited by captain at …" note shown on the heir's own list. */
  assistBadge?: string | null;
  /** Amber treatment used while the captain is assisting. */
  tinted?: boolean;
  onMoveTo?: (rank: number) => void;
  onNudge?: (delta: number) => void;
  onRemove?: () => void;
  onAdd?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled,
  });
  const [draft, setDraft] = useState(String(rank ?? ""));
  useEffect(() => setDraft(String(rank ?? "")), [rank]);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={`row-rank-item-${item.id}`}
      data-rank={rank ?? ""}
      className={`flex scroll-mt-28 items-center gap-2 rounded-md border px-2 py-2 ${
        tinted
          ? "border-[#c9a227]/60 bg-[#fdf3d0]/70 dark:bg-[#3a3007]/60"
          : "border-border bg-card"
      } ${isDragging ? "opacity-40" : ""}`}
    >
      <button
        type="button"
        aria-label={`Reorder ${item.name}`}
        data-testid={`button-drag-${item.id}`}
        className="cursor-grab touch-none scroll-mt-28 rounded p-1 text-muted-foreground hover-elevate disabled:cursor-not-allowed disabled:opacity-40"
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {rank !== null && (
        <Input
          type="number"
          min={1}
          max={total}
          value={draft}
          disabled={disabled}
          aria-label={`Rank for ${item.name}`}
          data-testid={`input-rank-${item.id}`}
          className="h-8 w-14 shrink-0 text-center tabular-nums"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft);
            if (!Number.isFinite(n) || n === rank) return setDraft(String(rank));
            onMoveTo?.(Math.max(1, Math.min(total, Math.round(n))));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      )}

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" data-testid={`text-rank-name-${item.id}`}>
          {item.name}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {item.room || "No room recorded"}
          {isCaptain && item.aiEstimatedValue ? ` · ${money(item.aiEstimatedValue)}` : ""}
        </div>
        {/* Ranking is where most families finally agree what a thing *is*. */}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <CategoryChip
            item={item}
            idPrefix="rank"
            affordance={item.category ? "chip" : "add"}
          />
          <DiscussionBadge item={item} />
        </div>
        {assistBadge && (
          <div
            className="mt-0.5 truncate text-[11px] text-[#8a6a0a] dark:text-[#f4e2a1]"
            data-testid={`badge-captain-edited-${item.id}`}
          >
            ✎ Edited by the captain at {assistBadge}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <FlagToggles item={item} compact />
          <AskForAppraisalButton item={item} size="sm" variant="ghost" />
        </div>
      </div>

      {rank !== null ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={`Move ${item.name} up`}
            data-testid={`button-rank-up-${item.id}`}
            disabled={disabled || rank <= 1}
            onClick={() => onNudge?.(-1)}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={`Move ${item.name} down`}
            data-testid={`button-rank-down-${item.id}`}
            disabled={disabled || rank >= total}
            onClick={() => onNudge?.(1)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={`Unrank ${item.name}`}
            data-testid={`button-rank-remove-${item.id}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 scroll-mt-28"
          data-testid={`button-rank-add-${item.id}`}
          disabled={disabled}
          onClick={onAdd}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Rank
        </Button>
      )}
    </li>
  );
}

/** A pane that accepts cross-list drops even when it is empty. */
function Pane({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <ul
      ref={setNodeRef}
      data-testid={`list-${id}`}
      className={`min-h-24 space-y-2 rounded-md p-1 transition-colors ${
        isOver ? "bg-primary/5 ring-1 ring-primary/40" : ""
      }`}
    >
      {children}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
export default function RankPage({
  assistParticipantId,
}: {
  /** Set on /rank/assist/:participantId — the heir whose list is being edited. */
  assistParticipantId?: number;
} = {}) {
  const { data, isLoading } = useAppState();
  const { userId } = useUser();
  const isCaptain = useIsCaptain();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [auditOpen, setAuditOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [dragging, setDragging] = useState<number | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const assisting = assistParticipantId !== undefined && assistParticipantId !== userId;
  const target = assisting
    ? (data?.participants.find((p) => p.id === assistParticipantId) ?? null)
    : me;
  const targetId = assisting ? (assistParticipantId ?? null) : userId;
  const win = activeWindowOf(data);
  const countdown = useCountdown(win?.deadline ?? null);
  const phase = data?.session.phase ?? "welcome";
  const secondary = phase === "secondary_ranking" || phase === "secondary_draft";

  const orderRef = useRef<number[]>([]);

  const query = useQuery<RankResponse>({
    queryKey: ["/api/rankings", targetId],
    enabled: targetId !== null,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/rankings/${targetId}?participantId=${userId}`);
      return res.json();
    },
  });

  /** Assist-mode audit trail — badges on the heir's own list, count for the captain. */
  const audit = useQuery<AuditResponse>({
    queryKey: ["/api/rankings/audit", targetId],
    enabled: targetId !== null,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/rankings/${targetId}/audit?participantId=${userId}`,
      );
      return res.json();
    },
  });

  const dismissAudit = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", `/api/rankings/${userId}/audit/dismiss`, {
          participantId: userId,
        })
      ).json(),
    onSuccess: () => {
      setAuditOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/rankings/audit", targetId] });
    },
  });

  // Refuse assist mode without the heir's consent, whichever kind of captain asks.
  useEffect(() => {
    if (!assisting || !data || !target) return;
    if (!me?.isAdmin) {
      navigate("/rank");
      return;
    }
    if (!target.allowsCaptainAssist) {
      toast({
        title: "Consent required",
        description: `${target.name} has not agreed to captain assistance.`,
        variant: "destructive",
      });
      navigate("/rank/all");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assisting, data, target?.id, target?.allowsCaptainAssist, me?.isAdmin]);

  // Server is the source of truth; local order only diverges while dragging.
  useEffect(() => {
    if (!query.data || dirty.current) return;
    const ids = query.data.rankings.map((r) => r.itemId);
    orderRef.current = ids;
    setOrder(ids);
  }, [query.data]);

  const save = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await apiRequest(
        "PUT",
        `/api/rankings/${targetId}${assisting ? "?mode=assist" : ""}`,
        {
          actorId: userId,
          rankings: ids.map((itemId, i) => ({ itemId, rank: i + 1 })),
        },
      );
      return res.json();
    },
    onSuccess: (_res, ids) => {
      // Only mark clean when nothing newer was queued while this PUT was in
      // flight — otherwise the refetch would clobber the newer local order.
      const current = orderRef.current;
      if (ids.length === current.length && ids.every((v, i) => v === current[i])) {
        dirty.current = false;
      }
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["/api/rankings", targetId] });
      queryClient.invalidateQueries({ queryKey: ["/api/rankings/audit", targetId] });
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
    },
    onError: (e: any) => {
      dirty.current = false;
      query.refetch();
      toast({
        title: e?.message?.includes("closed") ? "Ranking window closed" : "Could not save",
        description: e?.message ?? "Your change was not saved.",
        variant: "destructive",
      });
    },
  });

  /** Optimistic write + debounced PUT. */
  function commit(ids: number[]) {
    dirty.current = true;
    orderRef.current = ids;
    setOrder(ids);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate(ids), 400);
  }

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const items = data?.items ?? [];
  // High-value pieces leave the ranking pool entirely — they are settled
  // outside the draft once someone flags them.
  const pool = useMemo(
    () => items.filter((i) => i.status === "available" && !i.needsAppraisal),
    [items],
  );
  const byId = useMemo(() => new Map(pool.map((i) => [i.id, i])), [pool]);
  const ranked = useMemo(
    () => order.map((id) => byId.get(id)).filter((i): i is Item => !!i),
    [order, byId],
  );
  const rankedIds = useMemo(() => new Set(ranked.map((i) => i.id)), [ranked]);
  const unranked = useMemo(
    () =>
      pool
        .filter((i) => !rankedIds.has(i.id))
        .filter((i) =>
          catFilter === "all"
            ? true
            : catFilter === "__uncategorized__"
              ? !i.category
              : i.category === catFilter,
        )
        .filter((i) =>
          search.trim()
            ? `${i.name} ${i.room} ${i.category ?? ""}`
                .toLowerCase()
                .includes(search.toLowerCase())
            : true,
        ),
    [pool, rankedIds, search, catFilter],
  );

  const unrankedCategories = useMemo(
    () =>
      Array.from(
        new Set(
          pool.filter((i) => !rankedIds.has(i.id)).map((i) => i.category ?? ""),
        ),
      ).filter(Boolean) as string[],
    [pool, rankedIds],
  );
  const unrankedUncategorized = useMemo(
    () => pool.filter((i) => !rankedIds.has(i.id) && !i.category).length,
    [pool, rankedIds],
  );

  const required = query.data?.required ?? data?.rankSummary?.required ?? 0;
  const mode = query.data?.mode ?? data?.rankSummary?.mode ?? "topN";
  const locked = !!query.data?.locked || !!countdown?.closed;
  const disabled = locked || !me || (!assisting && !!me.administersOnly);

  const activeEdits = audit.data?.active ?? [];
  const assistEditCount = (audit.data?.entries ?? []).filter((e) => e.mode === "assist").length;
  /** itemId -> time of the most recent un-dismissed captain edit. */
  const badgeByItem = useMemo(() => {
    const m = new Map<number, string>();
    if (assisting) return m;
    for (const e of activeEdits) {
      if (!m.has(e.itemId))
        m.set(e.itemId, new Date(e.editedAt).toLocaleTimeString(undefined, { timeStyle: "short" }));
    }
    return m;
  }, [activeEdits, assisting]);
  const complete = ranked.length >= required;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const activeId = Number(e.active.id);
    if (!e.over) return;
    const overId = e.over.id;
    const wasRanked = rankedIds.has(activeId);

    // Dropped on a pane rather than a row: move between lists.
    if (overId === "unranked") {
      if (wasRanked) commit(order.filter((id) => id !== activeId));
      return;
    }
    if (overId === "ranked") {
      if (!wasRanked) commit([...order, activeId]);
      return;
    }

    const overNum = Number(overId);
    const overIsRanked = rankedIds.has(overNum);
    if (wasRanked && overIsRanked) {
      const from = order.indexOf(activeId);
      const to = order.indexOf(overNum);
      if (from !== to) commit(arrayMove(order, from, to));
    } else if (!wasRanked && overIsRanked) {
      const to = order.indexOf(overNum);
      const next = [...order];
      next.splice(to, 0, activeId);
      commit(next);
    } else if (wasRanked && !overIsRanked) {
      commit(order.filter((id) => id !== activeId));
    }
  }

  if (isLoading) {
    return (
      <AppShell>
        <PageHeader title="Ranking" subtitle="Loading your list…" />
        <LoadingRows />
      </AppShell>
    );
  }

  if (!me) {
    return (
      <AppShell>
        <PageHeader title="Ranking" subtitle="Sign in to rank the estate items." />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Choose who you are on the Sign in page first.
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  if (me.administersOnly && !assisting) {
    return (
      <AppShell>
          <PageHeader
          title="Ranking"
          subtitle="You're helping run this session and do not take items, so you have no list of your own."
        />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Open <span className="font-medium">Ranking overview</span> at /rank/all to see every
            heir's ranks.
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title={
          assisting
            ? `Assisting ${target?.name ?? "an heir"}`
            : secondary
              ? "Secondary Ranking"
              : "Ranking"
        }
        subtitle={
          assisting
            ? "You are editing this heir's list on their behalf. They see every change you make."
            : "Order every item from most-wanted to least. Your ranks are private."
        }
      />

      {assisting && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#c9a227] bg-[#fdf3d0] px-4 py-3 text-sm text-[#5a4409] dark:bg-[#3a3007] dark:text-[#f4e2a1]"
          data-testid="banner-assist-mode"
        >
          <span className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span>
              Assisting {target?.name ?? "this heir"} — {assistEditCount} edit
              {assistEditCount === 1 ? "" : "s"} so far this session. Every change is visible to
              them.
            </span>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate("/rank/all")}
            data-testid="button-exit-assist"
          >
            Exit assist mode
          </Button>
        </div>
      )}

      {!assisting && activeEdits.length > 0 && (
        <div
          className="mb-4 rounded-md border border-[#c9a227]/70 bg-[#fdf3d0]/80 px-4 py-3 text-sm text-[#5a4409] dark:bg-[#3a3007]/70 dark:text-[#f4e2a1]"
          data-testid="banner-assist-summary"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <PencilLine className="h-4 w-4 shrink-0" />
              The captain made {activeEdits.length} adjustment{activeEdits.length === 1 ? "" : "s"} to your
              ranking.
            </span>
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAuditOpen((v) => !v)}
                data-testid="button-review-assist-edits"
              >
                Review changes
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dismissAudit.mutate()}
                disabled={dismissAudit.isPending}
                data-testid="button-dismiss-assist-edits"
              >
                Dismiss
              </Button>
            </span>
          </div>
          {auditOpen && (
            <ul className="mt-3 space-y-1 text-xs" data-testid="list-assist-edits">
              {activeEdits.map((e) => (
                <li key={e.id} data-testid={`row-assist-edit-${e.id}`}>
                  {e.itemName}: {e.oldRank ?? "unranked"} → {e.newRank ?? "removed"} · by{" "}
                  {e.editedByName} at{" "}
                  {new Date(e.editedAt).toLocaleTimeString(undefined, { timeStyle: "short" })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {secondary && (
        <div
          className="mb-4 rounded-md border border-[#c9a227]/60 bg-[#fdf3d0] px-4 py-2 text-sm text-[#5a4409] dark:bg-[#3a3007] dark:text-[#f4e2a1]"
          data-testid="banner-secondary-ranking"
        >
          Secondary Draft — items no one ranked in the primary. Rank them now if you want them.
        </div>
      )}

      {locked && (
        <div
          className="mb-4 flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-2 text-sm text-destructive dark:text-red-300"
          data-testid="text-ranking-readonly"
        >
          <Lock className="h-4 w-4" />
          The ranking window closed on {countdown?.deadlineText ?? "the deadline"}. Contact the captain
          if you need to make changes.
        </div>
      )}

      <ClassificationChangeBanner />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="text-sm" data-testid="text-rank-progress">
            {mode === "all" ? (
              <>
                You've ranked <span className="font-semibold tabular-nums">{ranked.length}</span>/
                <span className="tabular-nums">{required}</span> items. Rank every item to be ready
                for the draft.
              </>
            ) : (
              <>
                You've ranked <span className="font-semibold tabular-nums">{ranked.length}</span>/
                <span className="tabular-nums">{required}</span> required. Rank at least{" "}
                {required} items to be ready for the draft.
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {complete && (
              <Badge variant="secondary" data-testid="badge-rank-complete">
                <Check className="mr-1 h-3 w-3" /> Ready
              </Badge>
            )}
            <span
              className="text-xs text-muted-foreground"
              data-testid="text-rank-save-status"
              data-saving={save.isPending ? "true" : "false"}
            >
              {save.isPending ? "Saving…" : savedAt ? "All changes saved" : "Autosaves as you go"}
            </span>
          </div>
        </CardContent>
      </Card>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(e: DragStartEvent) => setDragging(Number(e.active.id))}
        onDragCancel={() => setDragging(null)}
        onDragEnd={onDragEnd}
      >
        <div className="grid grid-cols-1 gap-4 [&>*]:min-w-0 lg:grid-cols-2">
          <Card data-testid="card-ranked-pane">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span>Ranked</span>
                <Badge variant="outline" data-testid="text-ranked-count">
                  {ranked.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SortableContext
                items={ranked.map((i) => i.id)}
                strategy={verticalListSortingStrategy}
              >
                <Pane id="ranked">
                  {ranked.length === 0 && (
                    <li className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                      Nothing ranked yet. Drag items across, or press Rank on the right.
                    </li>
                  )}
                  {ranked.map((item, idx) => (
                    <RankRowCard
                      key={item.id}
                      item={item}
                      rank={idx + 1}
                      total={ranked.length}
                      disabled={disabled}
                      tinted={assisting}
                      isCaptain={isCaptain}
                      assistBadge={badgeByItem.get(item.id) ?? null}
                      onMoveTo={(r) => commit(arrayMove(order, idx, r - 1))}
                      onNudge={(d) =>
                        commit(
                          arrayMove(
                            order,
                            idx,
                            Math.max(0, Math.min(order.length - 1, idx + d)),
                          ),
                        )
                      }
                      onRemove={() => commit(order.filter((id) => id !== item.id))}
                    />
                  ))}
                </Pane>
              </SortableContext>
            </CardContent>
          </Card>

          <Card data-testid="card-unranked-pane">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span>Unranked</span>
                <Badge variant="outline" data-testid="text-unranked-count">
                  {unranked.length}
                </Badge>
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <div className="relative min-w-[150px] flex-1">
                  <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search unranked items"
                    className="pl-8"
                    data-testid="input-rank-search"
                  />
                </div>
                <Select value={catFilter} onValueChange={setCatFilter}>
                  <SelectTrigger
                    className="w-full sm:w-[170px]"
                    data-testid="select-rank-category-filter"
                  >
                    <SelectValue placeholder="All categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    <SelectItem
                      value="__uncategorized__"
                      data-testid="option-rank-uncategorized"
                    >
                      {UNCATEGORIZED_LABEL} ({unrankedUncategorized})
                    </SelectItem>
                    {unrankedCategories.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              <SortableContext
                items={unranked.map((i) => i.id)}
                strategy={verticalListSortingStrategy}
              >
                <Pane id="unranked">
                  {unranked.length === 0 && (
                    <li className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                      Everything available is ranked.
                    </li>
                  )}
                  {unranked.map((item) => (
                    <RankRowCard
                      key={item.id}
                      item={item}
                      rank={null}
                      total={ranked.length}
                      disabled={disabled}
                      tinted={assisting}
                      isCaptain={isCaptain}
                      onAdd={() => commit([...order, item.id])}
                    />
                  ))}
                </Pane>
              </SortableContext>
            </CardContent>
          </Card>
        </div>

        <DragOverlay>
          {dragging !== null && byId.get(dragging) ? (
            <div className="rounded-md border border-primary bg-card px-3 py-2 text-sm font-medium shadow-lg">
              {byId.get(dragging)!.name}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <p className="mt-4 text-xs text-muted-foreground">
        Unranked items stay out of the primary draft. You can re-rank them later for a Secondary
        Draft. Your ranking stays editable until an item is awarded.
      </p>
    </AppShell>
  );
}
