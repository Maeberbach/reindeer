/**
 * v8 — Inventory intake ("import"). captain-only screen for bringing a family
 * member's .reindeer export from Reindeer: Registry into this estate.
 *
 * Nothing here writes to the live item pool by itself. Every staged item
 * needs an explicit Approve before it becomes a real item — see
 * server/import/importService.ts, which this page's copy mirrors closely.
 */
import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useUser, useIsCaptain, STATE_KEY } from "@/lib/app";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import type { ImportBatch, StagedItem } from "@shared/schema";
import {
  AlertTriangle,
  Camera,
  ChevronDown,
  Film,
  Info,
  Mic,
  UploadCloud,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function bytesToSize(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function batchStateLabel(state: string): string {
  return (
    {
      staged: "Waiting for review",
      partially_applied: "Partly added to the estate",
      applied: "Fully added to the estate",
      discarded: "Discarded",
    }[state] ?? state
  );
}

function batchStateVariant(state: string): "default" | "secondary" | "outline" | "destructive" {
  if (state === "applied") return "default";
  if (state === "partially_applied") return "secondary";
  if (state === "discarded") return "outline";
  return "outline";
}

function arrivalKindLabel(kind: string): string {
  return (
    {
      new: "New item",
      updates_existing: "Updates an existing item",
      possible_duplicate: "Possible duplicate",
    }[kind] ?? kind
  );
}

/** The one place the recipient hint gets rendered. Always advisory, always labeled. */
function RecipientHint({ hint, note }: { hint: string; note?: string }) {
  if (!hint) {
    return <span className="text-xs text-muted-foreground">No wish recorded</span>;
  }
  return (
    <div
      className="rounded-md border border-dashed border-muted-foreground/40 bg-muted/40 px-2.5 py-1.5"
      data-testid="text-recipient-hint"
    >
      <div className="text-xs font-medium text-muted-foreground">
        Owner's wish
      </div>
      <div className="text-sm">{hint}</div>
      {note && <div className="mt-0.5 text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

function useImportRules() {
  return useQuery<{ rules: readonly string[] }>({
    queryKey: ["/api/import/rules"],
  });
}

function useBatches() {
  return useQuery<ImportBatch[]>({
    queryKey: ["/api/import/batches"],
    refetchInterval: 5000,
  });
}

function useStaged() {
  return useQuery<StagedItem[]>({
    queryKey: ["/api/import/staged"],
    refetchInterval: 5000,
  });
}

/* ------------------------------------------------------------------ */
/* Upload with real progress via XHR (fetch cannot report upload progress) */
/* ------------------------------------------------------------------ */

type UploadState = { progress: number; uploading: boolean };

function uploadBundle(
  file: File,
  participantId: number | null,
  onProgress: (pct: number) => void,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const params = new URLSearchParams();
    if (participantId !== null) params.set("participantId", String(participantId));
    params.set("fileName", file.name);
    xhr.open("POST", `/api/import/bundle?${params.toString()}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("x-file-name", file.name);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve(null);
        }
      } else {
        let message = xhr.statusText;
        try {
          message = JSON.parse(xhr.responseText)?.message ?? message;
        } catch {
          /* ignore */
        }
        reject(new Error(message || `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("The upload could not reach the server."));
    xhr.send(file);
  });
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function ImportPage() {
  const { userId } = useUser();
  const isCaptain = useIsCaptain();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<UploadState>({ progress: 0, uploading: false });
  const [lastResult, setLastResult] = useState<{
    batch: ImportBatch;
    unmatchedRooms: string[];
    unmatchedCategories: string[];
    problems: string[];
    arrivedDuringLockedRound: boolean;
  } | null>(null);
  const [rejectNoteFor, setRejectNoteFor] = useState<StagedItem | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [approveAllFor, setApproveAllFor] = useState<ImportBatch | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [expandedBatchId, setExpandedBatchId] = useState<number | null>(null);

  const { data: rulesData } = useImportRules();
  const { data: batches, isLoading: batchesLoading } = useBatches();
  const { data: staged, isLoading: stagedLoading } = useStaged();

  async function handleFile(file: File) {
    setUpload({ progress: 0, uploading: true });
    setLastResult(null);
    try {
      const result = await uploadBundle(file, userId, (pct) =>
        setUpload({ progress: pct, uploading: true }),
      );
      setUpload({ progress: 100, uploading: false });
      setLastResult(result);
      setExpandedBatchId(result?.batch?.id ?? null);
      queryClient.invalidateQueries({ queryKey: ["/api/import/batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/import/staged"] });
      toast({
        title: "Bundle received",
        description: `${result?.stagedItems?.length ?? 0} item(s) are waiting for your review.`,
      });
    } catch (e) {
      setUpload({ progress: 0, uploading: false });
      toast({
        title: "The upload did not finish",
        description: (e as Error).message,
        variant: "destructive",
      });
    }
  }

  const approveOne = useMutation({
    mutationFn: async (id: number) =>
      (
        await fetch(`/api/import/staged/${id}/approve?participantId=${userId ?? ""}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participantId: userId }),
          credentials: "include",
        })
      ).json(),
    onSuccess: (data) => {
      if (data?.message) {
        toast({ title: "Could not approve", description: data.message, variant: "destructive" });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["/api/import/staged"] });
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Item added to the estate" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not approve", description: e.message, variant: "destructive" }),
  });

  const rejectOne = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) =>
      (
        await fetch(`/api/import/staged/${id}/reject?participantId=${userId ?? ""}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participantId: userId, note }),
          credentials: "include",
        })
      ).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/import/staged"] });
      setRejectNoteFor(null);
      setRejectNote("");
      toast({ title: "Item set aside", description: "It will not enter the estate." });
    },
    onError: (e: Error) =>
      toast({ title: "Could not set aside", description: e.message, variant: "destructive" }),
  });

  const approveBatch = useMutation({
    mutationFn: async (id: number) =>
      (
        await fetch(`/api/import/batches/${id}/approve?participantId=${userId ?? ""}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participantId: userId }),
          credentials: "include",
        })
      ).json(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/import/staged"] });
      queryClient.invalidateQueries({ queryKey: ["/api/import/batches"] });
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      const failed = (data?.results ?? []).filter((r: any) => !r.ok).length;
      setApproveAllFor(null);
      toast({
        title: "Drafts approved",
        description: failed
          ? `${failed} item(s) could not be added — the round may be locked. Check the batch.`
          : "Every draft in this batch is now part of the estate.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Could not approve the batch", description: e.message, variant: "destructive" }),
  });

  const rules = rulesData?.rules ?? [];
  const stagedForBatch = (batchId: string) => (staged ?? []).filter((s) => s.batchId === batchId);
  const draftCount = (batchId: string) =>
    stagedForBatch(batchId).filter((s) => s.state === "draft").length;

  const sortedBatches = useMemo(
    () => [...(batches ?? [])].sort((a, b) => b.importedAt - a.importedAt),
    [batches],
  );

  if (!isCaptain) {
    return (
      <AppShell>
        <PageHeader
          title="Inventory intake"
          subtitle="Bringing in items catalogued in Reindeer: Registry."
        />
        <Card className="p-10 text-center" data-testid="text-import-not-captain">
          <p className="font-serif text-lg">This page is for the captain</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Importing changes what enters the estate's pool, so only the captain
            can review and approve it.
          </p>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Inventory intake"
        subtitle="Bring in a family member's export from Reindeer: Registry and decide what joins the estate."
      />

      {/* Upload */}
      <Card className="mb-6" data-testid="card-upload">
        <CardContent className="p-5 md:p-6">
          <div
            className="flex flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed border-border px-6 py-10 text-center"
            data-testid="dropzone-bundle"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) void handleFile(f);
            }}
          >
            <UploadCloud className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="font-serif text-lg">Drop a .reindeer file here</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Or choose the file from your computer. Large exports with lots of photos can take
                a few minutes.
              </p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".reindeer,application/octet-stream"
              className="hidden"
              data-testid="input-bundle-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void handleFile(f);
              }}
            />
            <Button
              variant="outline"
              disabled={upload.uploading}
              data-testid="button-choose-file"
              onClick={() => fileRef.current?.click()}
            >
              Choose a file
            </Button>
          </div>

          {upload.uploading && (
            <div className="mt-4 space-y-2" data-testid="progress-upload">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>Uploading…</span>
                <span>{upload.progress}%</span>
              </div>
              <Progress value={upload.progress} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Result of the most recent upload: batch summary + loud call-outs */}
      {lastResult && (
        <Card
          className="mb-6 border-primary/40"
          data-testid={`card-batch-summary-${lastResult.batch.id}`}
        >
          <CardContent className="p-5 md:p-6">
            <h2 className="font-serif text-lg font-semibold">
              {lastResult.batch.fileName || "Import received"}
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SummaryStat label="Items" value={lastResult.batch.itemCount} />
              <SummaryStat
                label="Photos"
                value={lastResult.batch.photoCount}
                icon={<Camera className="h-3.5 w-3.5" />}
              />
              <SummaryStat
                label="Videos"
                value={lastResult.batch.videoCount}
                icon={<Film className="h-3.5 w-3.5" />}
              />
              <SummaryStat
                label="Audio"
                value={lastResult.batch.audioCount}
                icon={<Mic className="h-3.5 w-3.5" />}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>Owner: {lastResult.batch.ownerName || "Not given"}</span>
              <span>Exported: {formatDate(lastResult.batch.exportedAt)}</span>
              <span>Size: {bytesToSize(lastResult.batch.byteSize)}</span>
            </div>

            <ImportCallouts
              problems={lastResult.problems}
              unmatchedRooms={lastResult.unmatchedRooms}
              unmatchedCategories={lastResult.unmatchedCategories}
              arrivedDuringLockedRound={lastResult.arrivedDuringLockedRound}
            />
          </CardContent>
        </Card>
      )}

      {/* How importing works */}
      <Collapsible open={rulesOpen} onOpenChange={setRulesOpen} className="mb-6">
        <Card data-testid="card-import-rules">
          <CollapsibleTrigger asChild>
            <button
              className="flex w-full items-center justify-between gap-2 p-5 text-left md:p-6"
              data-testid="button-toggle-rules"
            >
              <span className="flex items-center gap-2 font-serif text-lg font-semibold">
                <Info className="h-4 w-4 text-muted-foreground" />
                How importing works
              </span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                  rulesOpen ? "rotate-180" : ""
                }`}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0">
              <ul className="space-y-2 text-sm text-muted-foreground" data-testid="list-import-rules">
                {rules.map((rule, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-foreground/50">{i + 1}.</span>
                    <span>{rule}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Batch list */}
      <h2 className="mb-3 font-serif text-lg" data-testid="text-batches-heading">
        Prior imports
      </h2>
      {batchesLoading ? (
        <LoadingRows rows={3} />
      ) : sortedBatches.length === 0 ? (
        <Card className="mb-8 p-10 text-center" data-testid="text-empty-batches">
          <p className="font-serif text-lg">Nothing has been imported yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            When a family member sends you a .reindeer export, drop it above to bring it in.
          </p>
        </Card>
      ) : (
        <div className="mb-8 space-y-3" data-testid="list-batches">
          {sortedBatches.map((b) => {
            const items = stagedForBatch(b.batchId);
            const drafts = items.filter((s) => s.state === "draft");
            const expanded = expandedBatchId === b.id;
            return (
              <Card key={b.id} data-testid={`card-batch-${b.id}`}>
                <CardContent className="p-4 md:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium" data-testid={`text-batch-name-${b.id}`}>
                          {b.fileName || b.batchId}
                        </span>
                        <Badge variant={batchStateVariant(b.state)} data-testid={`badge-batch-state-${b.id}`}>
                          {batchStateLabel(b.state)}
                        </Badge>
                        {b.arrivedDuringLockedRound && (
                          <Badge variant="destructive" data-testid={`badge-batch-locked-${b.id}`}>
                            Arrived during a locked round
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {b.itemCount} item(s) · {formatDate(b.importedAt)} · {bytesToSize(b.byteSize)}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {drafts.length > 0 && (
                        <Button
                          size="sm"
                          data-testid={`button-approve-all-${b.id}`}
                          onClick={() => setApproveAllFor(b)}
                        >
                          Approve all drafts ({drafts.length})
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`button-expand-batch-${b.id}`}
                        onClick={() => setExpandedBatchId(expanded ? null : b.id)}
                      >
                        {expanded ? "Hide items" : "Review items"}
                      </Button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="mt-4">
                      <StagedItemsTable
                        items={items}
                        onApprove={(id) => approveOne.mutate(id)}
                        onReject={(item) => setRejectNoteFor(item)}
                        approvingId={approveOne.isPending ? approveOne.variables : null}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Reject dialog */}
      <AlertDialog
        open={!!rejectNoteFor}
        onOpenChange={(o) => {
          if (!o) {
            setRejectNoteFor(null);
            setRejectNote("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif">
              Set aside "{rejectNoteFor?.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This item will not enter the estate. You can add a short note explaining why, for
              your own records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            rows={3}
            placeholder="Optional note"
            value={rejectNote}
            data-testid="input-reject-note"
            onChange={(e) => setRejectNote(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-reject">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-reject"
              onClick={() =>
                rejectNoteFor && rejectOne.mutate({ id: rejectNoteFor.id, note: rejectNote })
              }
            >
              Set aside
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Approve-all confirm dialog */}
      <AlertDialog open={!!approveAllFor} onOpenChange={(o) => !o && setApproveAllFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif">Add these items to the estate?</AlertDialogTitle>
            <AlertDialogDescription>
              {approveAllFor &&
                `${draftCount(approveAllFor.batchId)} item(s) from "${
                  approveAllFor.fileName || approveAllFor.batchId
                }" will enter the estate's pool right now. This cannot be undone from here — you would need to remove them individually afterward.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-approve-all">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-approve-all"
              disabled={approveBatch.isPending}
              onClick={() => approveAllFor && approveBatch.mutate(approveAllFor.id)}
            >
              {approveBatch.isPending ? "Adding…" : "Yes, add them"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}

function SummaryStat({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function ImportCallouts({
  problems,
  unmatchedRooms,
  unmatchedCategories,
  arrivedDuringLockedRound,
}: {
  problems: string[];
  unmatchedRooms: string[];
  unmatchedCategories: string[];
  arrivedDuringLockedRound: boolean;
}) {
  const nothingToFlag =
    problems.length === 0 &&
    unmatchedRooms.length === 0 &&
    unmatchedCategories.length === 0 &&
    !arrivedDuringLockedRound;
  if (nothingToFlag) {
    return (
      <p className="mt-4 text-sm text-muted-foreground" data-testid="text-no-callouts">
        No problems, unmatched rooms, or unmatched categories were found.
      </p>
    );
  }
  return (
    <div className="mt-4 space-y-3">
      {arrivedDuringLockedRound && (
        <div
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm"
          data-testid="callout-locked-round"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <div className="font-medium text-destructive">Arrived during a locked round</div>
            <div className="text-muted-foreground">
              The estate was in the middle of a draft round when this arrived. These items stay in
              staging and cannot be approved until the round finishes.
            </div>
          </div>
        </div>
      )}
      {problems.length > 0 && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm"
          data-testid="callout-problems"
        >
          <div className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {problems.length} problem{problems.length === 1 ? "" : "s"} found while reading this file
          </div>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {unmatchedRooms.length > 0 && (
        <div
          className="rounded-md border border-[#c9a227]/50 bg-[#fdf3d0] px-3 py-2.5 text-sm dark:bg-[#3a3007]/40"
          data-testid="callout-unmatched-rooms"
        >
          <div className="font-medium text-[#5a4409] dark:text-[#f4e2a1]">
            {unmatchedRooms.length} room name{unmatchedRooms.length === 1 ? "" : "s"} this estate
            does not have yet
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {unmatchedRooms.map((r) => (
              <Badge key={r} variant="outline" data-testid={`badge-unmatched-room-${r}`}>
                {r}
              </Badge>
            ))}
          </div>
          <p className="mt-1.5 text-muted-foreground">
            Decide where each of these items should really go when you review them below. Nothing
            was invented or guessed on your behalf.
          </p>
        </div>
      )}
      {unmatchedCategories.length > 0 && (
        <div
          className="rounded-md border border-[#c9a227]/50 bg-[#fdf3d0] px-3 py-2.5 text-sm dark:bg-[#3a3007]/40"
          data-testid="callout-unmatched-categories"
        >
          <div className="font-medium text-[#5a4409] dark:text-[#f4e2a1]">
            {unmatchedCategories.length} category name{unmatchedCategories.length === 1 ? "" : "s"} this
            estate does not have yet
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {unmatchedCategories.map((c) => (
              <Badge key={c} variant="outline" data-testid={`badge-unmatched-category-${c}`}>
                {c}
              </Badge>
            ))}
          </div>
          <p className="mt-1.5 text-muted-foreground">
            Decide whether to use an existing category or create these when you review the items
            below.
          </p>
        </div>
      )}
    </div>
  );
}

function StagedItemsTable({
  items,
  onApprove,
  onReject,
  approvingId,
}: {
  items: StagedItem[];
  onApprove: (id: number) => void;
  onReject: (item: StagedItem) => void;
  approvingId: number | null | undefined;
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="text-empty-staged">
        Nothing was staged from this import.
      </p>
    );
  }
  return (
    <div className="rounded-md border border-border">
      <p
        className="border-b border-border bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground"
        data-testid="text-table-scroll-hint"
      >
        This table scrolls sideways — keep going right to reach Approve and Reject.
      </p>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm" data-testid="table-staged-items">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="whitespace-nowrap px-2.5 py-2">Item</th>
            <th className="whitespace-nowrap px-2.5 py-2">Room</th>
            <th className="whitespace-nowrap px-2.5 py-2">Category</th>
            <th className="whitespace-nowrap px-2.5 py-2">Qty</th>
            <th className="whitespace-nowrap px-2.5 py-2">Value</th>
            <th className="whitespace-nowrap px-2.5 py-2">Media</th>
            <th className="whitespace-nowrap px-2.5 py-2">Arrival</th>
            <th className="min-w-[140px] max-w-[160px] px-2.5 py-2">Owner's wish</th>
            <th className="whitespace-nowrap px-2.5 py-2">Status</th>
            <th className="whitespace-nowrap px-2.5 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id} className="border-b border-border last:border-0" data-testid={`row-staged-${it.id}`}>
              <td className="w-[200px] min-w-[180px] px-2.5 py-2.5">
                <div
                  className="whitespace-normal break-words font-medium leading-snug"
                  data-testid={`text-staged-name-${it.id}`}
                  title={it.name}
                >
                  {it.name}
                </div>
                {it.mappingNotes && it.mappingNotes !== "[]" && (
                  <div className="mt-0.5 text-xs text-muted-foreground">Needs a room/category decision</div>
                )}
              </td>
              <td className="whitespace-nowrap px-2.5 py-2.5 text-muted-foreground">{it.room || "—"}</td>
              <td className="whitespace-nowrap px-2.5 py-2.5 text-muted-foreground">
                {it.category || "—"}
              </td>
              <td className="whitespace-nowrap px-2.5 py-2.5">{it.quantity}</td>
              <td className="whitespace-nowrap px-2.5 py-2.5">
                {it.estimatedValue != null
                  ? `$${it.estimatedValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                  : "—"}
              </td>
              <td className="whitespace-nowrap px-2.5 py-2.5">
                <div className="flex gap-1.5">
                  {it.photoCount > 0 && (
                    <Badge variant="outline" className="gap-1" data-testid={`badge-media-photo-${it.id}`}>
                      <Camera className="h-3 w-3" />
                      {it.photoCount}
                    </Badge>
                  )}
                  {it.videoCount > 0 && (
                    <Badge variant="outline" className="gap-1" data-testid={`badge-media-video-${it.id}`}>
                      <Film className="h-3 w-3" />
                      {it.videoCount}
                    </Badge>
                  )}
                  {it.audioCount > 0 && (
                    <Badge variant="outline" className="gap-1" data-testid={`badge-media-audio-${it.id}`}>
                      <Mic className="h-3 w-3" />
                      {it.audioCount}
                    </Badge>
                  )}
                  {it.photoCount === 0 && it.videoCount === 0 && it.audioCount === 0 && (
                    <span className="text-xs text-muted-foreground">None</span>
                  )}
                </div>
              </td>
              <td className="whitespace-nowrap px-2.5 py-2.5">
                <Badge
                  variant={it.arrivalKind === "possible_duplicate" ? "destructive" : "outline"}
                  data-testid={`badge-arrival-kind-${it.id}`}
                >
                  {arrivalKindLabel(it.arrivalKind)}
                </Badge>
              </td>
              <td className="px-2.5 py-2.5">
                <RecipientHint hint={it.recipientHint} note={it.recipientHintNote} />
              </td>
              <td className="whitespace-nowrap px-2.5 py-2.5">
                <Badge
                  variant={
                    it.state === "draft"
                      ? "secondary"
                      : it.state === "approved"
                        ? "default"
                        : "outline"
                  }
                  data-testid={`badge-staged-state-${it.id}`}
                >
                  {it.state}
                </Badge>
              </td>
              <td className="sticky right-0 bg-card px-2.5 py-2.5 text-right shadow-[-6px_0_6px_-6px_rgba(0,0,0,0.15)]">
                {it.state === "draft" ? (
                  <div className="flex justify-end gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={approvingId === it.id}
                      data-testid={`button-reject-staged-${it.id}`}
                      onClick={() => onReject(it)}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      disabled={approvingId === it.id}
                      data-testid={`button-approve-staged-${it.id}`}
                      onClick={() => onApprove(it.id)}
                    >
                      {approvingId === it.id ? "Approving…" : "Approve"}
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {it.state === "approved" ? "Added" : it.state === "rejected" ? "Set aside" : "Replaced"}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
