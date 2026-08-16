/**
 * v6 — the review queue.
 *
 * Entirely optional. Nothing in the app waits on this screen; it exists
 * because families often *want* to tidy up, and doing it one card at a time
 * with the analyser's guesses to hand is far less tedious than a spreadsheet.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  STANDARD_CATEGORIES,
  UNCATEGORIZED_LABEL,
  parseAiSuggestions,
  type Item,
} from "@shared/schema";
import { useAppState, useUser } from "@/lib/app";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import {
  CategoryHistory,
  DiscussionBadge,
  useCanCategorize,
  useSetCategory,
} from "@/components/category-chips";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sparkles } from "lucide-react";

const PAGE_SIZE = 8;

export default function CategoryReviewPage() {
  const { data, isLoading } = useAppState();
  const { userId } = useUser();
  const canCategorize = useCanCategorize();
  const setCategory = useSetCategory();
  const [page, setPage] = useState(0);

  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !!me?.isAdmin;
  const status = data?.categorization;

  const queue = useMemo<Item[]>(
    () => (data?.items ?? []).filter((i) => !i.category),
    [data?.items],
  );
  const pageItems = queue.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const done = (status?.total ?? 0) - queue.length;
  const pct = status?.total ? Math.round((done / status.total) * 100) : 100;

  if (!isLoading && !isCaptain && !canCategorize) {
    return (
      <AppShell>
        <PageHeader
          title="Review categories"
          subtitle="The captain has switched off heir categorising for now."
        />
        <Card className="p-10 text-center" data-testid="text-review-locked">
          <p className="font-serif text-lg">Nothing to do here just yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Ask the captain to turn categorising back on.
          </p>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Review categories"
        subtitle="Optional tidying. Anything left uncategorized still enters the rankings and the draft exactly as it is."
        actions={
          <Link href="/inventory" data-testid="link-back-to-inventory">
            <Button variant="outline" size="sm">
              Back to inventory
            </Button>
          </Link>
        }
      />

      {/* Progress and who has been helping */}
      <div className="mb-5 space-y-3">
        <div>
          <div className="flex items-center justify-between text-sm">
            <span data-testid="text-review-progress">
              {queue.length} of {status?.total ?? 0} uncategorized left
            </span>
            <span className="text-muted-foreground tabular-nums">{pct}%</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
              data-testid="bar-review-progress"
            />
          </div>
        </div>
        {(status?.collaborators ?? []).length > 0 && (
          <div className="flex flex-wrap items-center gap-2" data-testid="list-collaborators">
            {(status?.collaborators ?? []).map((c) => (
              <span
                key={String(c.participantId)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs"
                data-testid={`chip-collaborator-${c.participantId ?? "captain"}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                {c.name} {c.count}
              </span>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <LoadingRows rows={4} />
      ) : queue.length === 0 ? (
        <Card className="p-10 text-center" data-testid="text-review-empty">
          <p className="font-serif text-lg">Everything has a category</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing left to file. This screen was never a requirement anyway.
          </p>
        </Card>
      ) : (
        <div className="space-y-3" data-testid="list-review-queue">
          {pageItems.map((item) => {
            const suggestions = parseAiSuggestions(item.aiSuggestions);
            return (
              <Card key={item.id} data-testid={`card-review-${item.id}`}>
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                  {item.thumbnailUrl ? (
                    <img
                      src={item.thumbnailUrl}
                      alt={item.name}
                      className="h-16 w-24 shrink-0 rounded-sm object-cover"
                      data-testid={`img-review-${item.id}`}
                    />
                  ) : (
                    <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded-sm border border-dashed border-border text-[10px] text-muted-foreground">
                      No photo
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium" data-testid={`text-review-name-${item.id}`}>
                        {item.name}
                      </span>
                      {item.room && <Badge variant="secondary">{item.room}</Badge>}
                      <Badge
                        variant="secondary"
                        className="border-dashed bg-muted/60 text-muted-foreground"
                      >
                        {UNCATEGORIZED_LABEL}
                      </Badge>
                      <DiscussionBadge item={item} />
                    </div>
                    {item.notes && (
                      <p className="mt-1 text-xs text-muted-foreground">{item.notes}</p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {suggestions.slice(0, 3).map((s) => (
                        <button
                          key={s.category}
                          type="button"
                          disabled={!canCategorize || setCategory.isPending}
                          data-testid={`button-review-suggestion-${item.id}-${s.category}`}
                          onClick={() =>
                            setCategory.mutate({ itemId: item.id, category: s.category })
                          }
                          className="rounded-full border border-primary/40 bg-primary/5 px-2.5 py-1 text-xs hover-elevate"
                        >
                          <Sparkles className="mr-1 inline h-3 w-3" />
                          {s.category}
                          <span className="ml-1 text-muted-foreground">
                            {Math.round(s.confidence * 100)}%
                          </span>
                        </button>
                      ))}
                      {suggestions.length === 0 && (
                        <span className="text-xs text-muted-foreground">
                          No suggestion — choose below, or leave it be.
                        </span>
                      )}
                      <Select
                        onValueChange={(v) =>
                          setCategory.mutate({ itemId: item.id, category: v })
                        }
                      >
                        <SelectTrigger
                          className="h-8 w-[170px] text-xs"
                          disabled={!canCategorize}
                          data-testid={`select-review-other-${item.id}`}
                        >
                          <SelectValue placeholder="Other…" />
                        </SelectTrigger>
                        <SelectContent>
                          {STANDARD_CATEGORIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <CategoryHistory itemId={item.id} />
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {queue.length > PAGE_SIZE && (
            <div className="flex items-center justify-between pt-1">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                data-testid="button-review-prev"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground" data-testid="text-review-page">
                Page {page + 1} of {Math.max(1, Math.ceil(queue.length / PAGE_SIZE))}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= queue.length}
                data-testid="button-review-next"
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}
