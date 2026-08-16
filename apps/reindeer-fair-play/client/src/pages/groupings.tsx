import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAppState, useUser, STATE_KEY, heirsOf } from "@/lib/app";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Check, Gem, Layers, X } from "lucide-react";

export default function GroupingsPage() {
  const { data, isLoading } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const [newName, setNewName] = useState("");
  const [addTo, setAddTo] = useState<Record<number, string>>({});
  const [log, setLog] = useState<string[]>([]);

  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !!me?.isAdmin;
  const heirs = heirsOf(data?.participants ?? []);

  const ensure = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/groupings/ensure-heirloom")).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STATE_KEY }),
  });

  const confirmHeirloom = useMutation({
    mutationFn: async (v: { itemId: number; confirmed: boolean }) =>
      (await apiRequest("POST", "/api/groupings/confirm-heirloom", v)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Heirloom list updated" });
    },
  });

  const createGrouping = useMutation({
    mutationFn: async (name: string) =>
      (await apiRequest("POST", "/api/groupings", { name, type: "custom" })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      setNewName("");
      toast({ title: "Grouping created" });
    },
  });

  const addItem = useMutation({
    mutationFn: async (v: { groupingId: number; itemId: number }) =>
      (await apiRequest("POST", `/api/groupings/${v.groupingId}/add-item`, { itemId: v.itemId })).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STATE_KEY }),
  });

  const optIn = useMutation({
    mutationFn: async (v: { groupingId: number; choice: "want" | "pass" }) =>
      (
        await apiRequest("POST", `/api/groupings/${v.groupingId}/opt-in`, {
          participantId: userId,
          choice: v.choice,
        })
      ).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STATE_KEY }),
  });

  const startRound = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/session/start-groupings-round")).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Groupings round is open" });
    },
  });

  const resolve = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("POST", `/api/groupings/${id}/resolve`)).json() as Promise<{
        message: string;
      }>,
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      setLog((l) => [r.message, ...l]);
      toast({ title: "Grouping resolved", description: r.message });
    },
  });

  const startDraft = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/session/start-draft")).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Cataloging locked — the draft has begun" });
    },
  });

  const candidates = (data?.items ?? []).filter(
    (i) => i.isHeirloomCandidate && !i.isHeirloomConfirmed,
  );
  const groupings = data?.groupings ?? [];
  const heirloomGrouping = groupings.find((g) => g.type === "heirloom");
  const availableItems = (data?.items ?? []).filter((i) => i.status === "available");

  const inPractice = (data?.session.practiceMode ?? "off") !== "off";

  if (inPractice) {
    return (
      <AppShell>
        <PageHeader title="Groupings" subtitle="Paused during practice." />
        <Card className="p-10 text-center" data-testid="text-groupings-practice-disabled">
          <p className="font-serif text-lg">Groupings are disabled during a practice round</p>
          <p className="mt-2 text-sm text-muted-foreground">
            End the practice round from Administration to work groupings and high-value
            nominations again.
          </p>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Groupings"
        subtitle="Related pieces are drafted as one unit. The Heirlooms grouping builds itself from heir nominations and AI flags; every heir then declares Want or Pass. If everyone passes, the bundle is broken up and its items return to the ordinary draft."
        actions={
          isCaptain ? (
            <>
              <Button
                variant="outline"
                size="sm"
                data-testid="button-start-groupings-round"
                disabled={startRound.isPending}
                onClick={() => startRound.mutate()}
              >
                {startRound.isPending ? "Opening…" : "Start groupings round"}
              </Button>
              <Button
                size="sm"
                data-testid="button-start-draft"
                disabled={startDraft.isPending}
                onClick={() => startDraft.mutate()}
              >
                {startDraft.isPending ? "Starting…" : "Start the draft"}
              </Button>
            </>
          ) : null
        }
      />

      {isLoading ? (
        <LoadingRows rows={4} />
      ) : (
        <div className="space-y-8">
          {/* Counters panel — useful for verifying tiebreak losses do not count */}
          <Card>
            <CardContent className="p-4">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Regular-draft contested-loss counters
              </Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {heirs.map((h) => (
                  <Badge key={h.id} variant="outline" data-testid={`counter-${h.id}`}>
                    {h.name}: {h.contestedLossCounter}
                  </Badge>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Losing a groupings tiebreak never changes these numbers.
              </p>
            </CardContent>
          </Card>

          {/* Heirloom confirmation — captain only */}
          <section>
            <h2 className="mb-3 flex items-center gap-2 font-serif text-lg" data-testid="text-heirloom-heading">
              <Gem className="h-4 w-4 text-primary" />
              Heirloom candidates
            </h2>
            {!heirloomGrouping && (
              <Button
                size="sm"
                variant="outline"
                className="mb-3"
                data-testid="button-ensure-heirloom"
                onClick={() => ensure.mutate()}
              >
                Create the Heirlooms grouping
              </Button>
            )}
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-candidates">
                No candidates awaiting confirmation. Heirs nominate heirlooms from the Inventory
                page; the AI also flags likely heirlooms during batch intake.
              </p>
            ) : (
              <div className="space-y-2">
                {candidates.map((i) => (
                  <Card key={i.id} data-testid={`card-candidate-${i.id}`}>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div>
                        <div className="font-medium" data-testid={`text-candidate-name-${i.id}`}>
                          {i.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {i.room || "Room not set"} · {i.category || "Uncategorised"}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          data-testid={`button-confirm-heirloom-${i.id}`}
                          disabled={!isCaptain || confirmHeirloom.isPending}
                          onClick={() => confirmHeirloom.mutate({ itemId: i.id, confirmed: true })}
                        >
                          <Check className="mr-1.5 h-3.5 w-3.5" />
                          Confirm
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`button-reject-heirloom-${i.id}`}
                          disabled={!isCaptain || confirmHeirloom.isPending}
                          onClick={() => confirmHeirloom.mutate({ itemId: i.id, confirmed: false })}
                        >
                          <X className="mr-1.5 h-3.5 w-3.5" />
                          Reject
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {!isCaptain && (
                  <p className="text-xs text-muted-foreground">
                    Only the captain may confirm heirlooms.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Groupings */}
          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-serif text-lg">
                <Layers className="h-4 w-4 text-primary" />
                Groupings
              </h2>
              {isCaptain && (
                <div className="flex gap-2">
                  <Input
                    className="w-56"
                    placeholder="New grouping name"
                    value={newName}
                    data-testid="input-new-grouping"
                    onChange={(e) => setNewName(e.target.value)}
                  />
                  <Button
                    size="sm"
                    data-testid="button-create-grouping"
                    disabled={!newName.trim() || createGrouping.isPending}
                    onClick={() => createGrouping.mutate(newName.trim())}
                  >
                    Create
                  </Button>
                </div>
              )}
            </div>

            {groupings.length === 0 ? (
              <Card className="p-8 text-center" data-testid="text-empty-groupings">
                <p className="font-serif text-lg">No groupings yet</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  The Heirlooms grouping appears as soon as an heirloom is confirmed.
                </p>
              </Card>
            ) : (
              <div className="space-y-4">
                {groupings.map((g) => {
                  const gItems = (data?.items ?? []).filter((i) => i.groupingId === g.id);
                  const gOptIns = (data?.optIns ?? []).filter((o) => o.groupingId === g.id);
                  const mine = gOptIns.find((o) => o.participantId === userId);
                  const winner = data?.participants.find((p) => p.id === g.awardedToParticipantId);
                  return (
                    <Card key={g.id} data-testid={`card-grouping-${g.id}`}>
                      <CardContent className="space-y-3 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-serif text-base font-medium" data-testid={`text-grouping-name-${g.id}`}>
                            {g.name}
                          </span>
                          <Badge variant={g.type === "heirloom" ? "default" : "secondary"}>
                            {g.type === "heirloom" ? "Automatic" : "Custom"}
                          </Badge>
                          <Badge variant="outline" data-testid={`status-grouping-${g.id}`}>
                            {g.status === "open"
                              ? "Open"
                              : g.status === "resolved_awarded"
                                ? `Awarded to ${winner?.name ?? "—"}`
                                : "Broken up — items returned to the pool"}
                          </Badge>
                        </div>

                        <div className="text-sm text-muted-foreground" data-testid={`text-grouping-items-${g.id}`}>
                          {gItems.length === 0
                            ? "No items in this grouping yet."
                            : gItems.map((i) => i.name).join(" · ")}
                        </div>

                        {isCaptain && g.status === "open" && availableItems.length > 0 && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Select
                              value={addTo[g.id] ?? ""}
                              onValueChange={(v) => setAddTo((s) => ({ ...s, [g.id]: v }))}
                            >
                              <SelectTrigger className="w-64" data-testid={`select-add-item-${g.id}`}>
                                <SelectValue placeholder="Add an item to this grouping" />
                              </SelectTrigger>
                              <SelectContent>
                                {availableItems.map((i) => (
                                  <SelectItem key={i.id} value={String(i.id)}>
                                    {i.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              size="sm"
                              variant="outline"
                              data-testid={`button-add-item-${g.id}`}
                              disabled={!addTo[g.id] || addItem.isPending}
                              onClick={() =>
                                addItem.mutate({ groupingId: g.id, itemId: Number(addTo[g.id]) })
                              }
                            >
                              Add
                            </Button>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-1.5">
                          {heirs.map((h) => {
                            const o = gOptIns.find((x) => x.participantId === h.id);
                            return (
                              <Badge
                                key={h.id}
                                variant={o?.choice === "want" ? "default" : "outline"}
                                data-testid={`optin-${g.id}-${h.id}`}
                              >
                                {h.name}: {o?.choice ? (o.choice === "want" ? "Want" : "Pass") : "—"}
                              </Badge>
                            );
                          })}
                        </div>

                        {g.status === "open" && (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant={mine?.choice === "want" ? "default" : "outline"}
                              data-testid={`button-want-${g.id}`}
                              disabled={!userId || optIn.isPending}
                              onClick={() => optIn.mutate({ groupingId: g.id, choice: "want" })}
                            >
                              Want
                            </Button>
                            <Button
                              size="sm"
                              variant={mine?.choice === "pass" ? "default" : "outline"}
                              data-testid={`button-pass-${g.id}`}
                              disabled={!userId || optIn.isPending}
                              onClick={() => optIn.mutate({ groupingId: g.id, choice: "pass" })}
                            >
                              Pass
                            </Button>
                            {isCaptain && (
                              <Button
                                size="sm"
                                variant="secondary"
                                data-testid={`button-resolve-grouping-${g.id}`}
                                disabled={resolve.isPending}
                                onClick={() => resolve.mutate(g.id)}
                              >
                                {resolve.isPending ? "Resolving…" : "Resolve grouping"}
                              </Button>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          {log.length > 0 && (
            <section>
              <h2 className="mb-2 font-serif text-lg">Resolution log</h2>
              <ul className="space-y-1 text-sm text-muted-foreground" data-testid="list-grouping-log">
                {log.map((l, i) => (
                  <li key={i} data-testid={`text-grouping-log-${i}`}>
                    · {l}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}
