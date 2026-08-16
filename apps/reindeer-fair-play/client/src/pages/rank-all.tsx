import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, EyeOff, ShieldCheck } from "lucide-react";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { useAppState, useUser } from "@/lib/app";
import { useToast } from "@/hooks/use-toast";
import type { Item, Participant, Ranking, RankingItemStat } from "@shared/schema";

type AllRankings = {
  /** True when the caller is a captain who also drafts: stats only, no rank cells. */
  aggregated?: boolean;
  stats?: RankingItemStat[];
  ownRankings?: Ranking[];
  rankings: Ranking[];
  summary: {
    required: number;
    mode: string;
    heirs: { participantId: number; name: string; ranked: number; shortfall: number }[];
    underRanked: { participantId: number; name: string; shortfall: number }[];
  };
  items: Item[];
  participants: Participant[];
};

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export default function RankAllPage() {
  const { data: state } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const [anonymize, setAnonymize] = useState(false);

  const me = state?.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !me || !!me.isAdmin;

  const { data, isLoading } = useQuery<AllRankings>({
    queryKey: ["/api/rankings/all", userId],
    enabled: isCaptain,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/rankings/all${userId ? `?participantId=${userId}` : ""}`,
      );
      return res.json();
    },
  });

  const heirs = data?.participants ?? [];
  const rows = useMemo(() => {
    if (!data) return [];
    return data.items.map((item) => {
      const ranks = heirs.map((h) => {
        const r = data.rankings.find((x) => x.participantId === h.id && x.itemId === item.id);
        return r?.rank ?? null;
      });
      const present = ranks.filter((r): r is number => r !== null);
      return {
        item,
        ranks,
        median: median(present),
        topFive: present.filter((r) => r <= 5).length,
        rankedBy: present.length,
      };
    });
  }, [data, heirs]);

  const contested = useMemo(
    () => rows.filter((r) => r.topFive >= 2).sort((a, b) => b.topFive - a.topFive).slice(0, 8),
    [rows],
  );
  const unrankedByNobody = rows.filter((r) => r.rankedBy === 0);

  async function downloadCsv() {
    try {
      const res = await apiRequest(
        "GET",
        `/api/rankings/export.csv${userId ? `?participantId=${userId}` : ""}`,
      );
      const text = await res.text();
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "rankings.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Export failed", description: e?.message, variant: "destructive" });
    }
  }

  if (!isCaptain) {
    return (
      <AppShell>
        <PageHeader title="Ranking overview" subtitle="Reserved for the captain." />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Everyone's rankings are private. Open your own list at /rank.
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  if (isLoading || !data) {
    return (
      <AppShell>
        <PageHeader title="Ranking overview" subtitle="Loading every heir's ranks…" />
        <LoadingRows />
      </AppShell>
    );
  }

  /* -------- captain who also drafts: aggregated, name-free view only -------- */
  if (data.aggregated) {
    const stats = data.stats ?? [];
    const own = data.ownRankings ?? [];
    const itemName = (id: number) => data.items.find((i) => i.id === id)?.name ?? `Item ${id}`;
    const itemMeta = (id: number) => {
      const it = data.items.find((i) => i.id === id);
      return [it?.room, it?.category].filter(Boolean).join(" · ");
    };
    const contestedStats = [...stats]
      .filter((s) => s.topFive >= 2)
      .sort((a, b) => b.topFive - a.topFive)
      .slice(0, 8);

    return (
      <AppShell>
        <PageHeader
          title="Ranking overview"
          subtitle="Aggregated statistics only — you are drafting too, so individual rankings stay private."
        />

        <Card className="mb-4 border-[#c9a227]/60 bg-[#fdf3d0]/60 dark:bg-[#3a3007]/50">
          <CardContent
            className="flex items-start gap-2 p-4 text-sm text-[#5a4409] dark:text-[#f4e2a1]"
            data-testid="note-captain-heir-privacy"
          >
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              You are participating as an heir. Individual rank values are hidden for fairness.
              Ask a non-participating co-captain (if any) or the family for the raw matrix.
            </span>
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Progress</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {data.summary.heirs.map((h) => (
              <Badge
                key={h.participantId}
                variant={h.shortfall === 0 ? "secondary" : "outline"}
                data-testid={`badge-rank-progress-${h.participantId}`}
              >
                {h.name}: {h.ranked}/{data.summary.required}
                {h.shortfall > 0 ? ` (needs ${h.shortfall} more)` : " ✓"}
              </Badge>
            ))}
          </CardContent>
        </Card>

        <h2 className="mb-3 font-serif text-lg" data-testid="text-aggregate-heading">
          Per-item statistics
        </h2>
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="grid-item-stats"
        >
          {stats.map((s) => (
            <Card key={s.itemId} data-testid={`card-item-stat-${s.itemId}`}>
              <CardContent className="space-y-1.5 p-4">
                <div className="truncate text-sm font-medium" title={s.name}>
                  {s.name}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {[s.room, s.category].filter(Boolean).join(" · ") || "Uncategorised"}
                </div>
                <div className="pt-1 text-xs" data-testid={`text-stat-count-${s.itemId}`}>
                  Ranked by {s.rankedBy} of {s.totalHeirs} heirs
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Badge variant="outline" data-testid={`text-stat-median-${s.itemId}`}>
                    median {s.median ?? "—"}
                  </Badge>
                  <Badge variant="outline" data-testid={`text-stat-spread-${s.itemId}`}>
                    {s.min === null ? "no ranks" : `ranks ${s.min}–${s.max}`}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="mt-6">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Your rankings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm" data-testid="list-own-rankings">
            {own.length === 0 ? (
              <p className="text-muted-foreground">
                You have not ranked anything yet. Open your own list at Ranking.
              </p>
            ) : (
              [...own]
                .sort((a, b) => a.rank - b.rank)
                .map((r) => (
                  <div
                    key={r.itemId}
                    className="flex items-baseline gap-3 border-b border-border/60 py-1.5 last:border-0"
                    data-testid={`row-own-rank-${r.itemId}`}
                  >
                    <span className="w-6 shrink-0 tabular-nums text-muted-foreground">
                      {r.rank}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{itemName(r.itemId)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {itemMeta(r.itemId)}
                      </span>
                    </span>
                  </div>
                ))
            )}
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Most contested</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm" data-testid="list-contested">
            {contestedStats.length === 0 ? (
              <p className="text-muted-foreground">
                No item sits in more than one heir's top five.
              </p>
            ) : (
              contestedStats.map((s) => (
                <div key={s.itemId} className="flex justify-between gap-2">
                  <span className="truncate">{s.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    top-5 for {s.topFive} heirs
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const label = (h: Participant, i: number) => (anonymize ? `Heir ${i + 1}` : h.name);

  return (
    <AppShell>
      <PageHeader
        title="Ranking overview"
        subtitle="Every heir's ranks, item by item. Rankings are otherwise private."
        actions={
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id="anonymize"
                checked={anonymize}
                onCheckedChange={setAnonymize}
                data-testid="switch-anonymize"
              />
              <Label htmlFor="anonymize" className="flex items-center gap-1 text-sm">
                <EyeOff className="h-3.5 w-3.5" /> Anonymize
              </Label>
            </div>
            <Button variant="outline" size="sm" onClick={downloadCsv} data-testid="button-export-rankings">
              <Download className="mr-1.5 h-4 w-4" /> Export CSV
            </Button>
          </div>
        }
      />

      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Progress</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {data.summary.heirs.map((h, i) => (
            <Badge
              key={h.participantId}
              variant={h.shortfall === 0 ? "secondary" : "outline"}
              data-testid={`badge-rank-progress-${h.participantId}`}
            >
              {anonymize ? `Heir ${i + 1}` : h.name}: {h.ranked}/{data.summary.required}
              {h.shortfall > 0 ? ` (needs ${h.shortfall} more)` : " ✓"}
            </Badge>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Item × heir matrix</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm" data-testid="table-rank-matrix">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Item</th>
                {heirs.map((h, i) => (
                  <th key={h.id} className="px-2 py-2 text-center font-medium">
                    {label(h, i)}
                  </th>
                ))}
                <th className="px-2 py-2 text-center font-medium">Median</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.item.id}
                  className="border-b border-border/60"
                  data-testid={`row-matrix-${r.item.id}`}
                >
                  <td className="py-1.5 pr-3">
                    <div className="font-medium">{r.item.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.item.status !== "available" && (
                        <Badge variant="outline" className="mr-1 text-[10px]">
                          {r.item.draftPhase ? `${r.item.draftPhase} draft` : r.item.status}
                        </Badge>
                      )}
                      {[r.item.room, r.item.category].filter(Boolean).join(" · ")}
                    </div>
                  </td>
                  {r.ranks.map((rank, i) => (
                    <td
                      key={i}
                      className={`px-2 py-1.5 text-center tabular-nums ${
                        rank !== null && rank <= 5 ? "font-semibold text-primary" : ""
                      }`}
                      data-testid={`cell-rank-${r.item.id}-${heirs[i].id}`}
                    >
                      {rank ?? "—"}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-center tabular-nums text-muted-foreground">
                    {r.median ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Most contested</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm" data-testid="list-contested">
            {contested.length === 0 && (
              <p className="text-muted-foreground">No item sits in more than one heir's top five.</p>
            )}
            {contested.map((r) => (
              <div key={r.item.id} className="flex justify-between gap-2">
                <span className="truncate">{r.item.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  top-5 for {r.topFive} heirs
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Nobody ranked these</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm" data-testid="list-nobody-ranked">
            {unrankedByNobody.length === 0 ? (
              <p className="text-muted-foreground">Every item has at least one rank.</p>
            ) : (
              unrankedByNobody.map((r) => <div key={r.item.id}>{r.item.name}</div>)
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
