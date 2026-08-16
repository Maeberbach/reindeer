import { useAppState, useIsCaptain, heirsOf, money } from "@/lib/app";
import { AppShell, PageHeader, LoadingRows, Logo } from "@/components/shell";
import { useCsvExport } from "@/pages/inventory";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Download, Printer } from "lucide-react";


async function downloadSnapshot() {
  const res = await fetch("/api/fiduciary/snapshot");
  if (!res.ok) throw new Error("Could not fetch snapshot");
  const data = await res.json();
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fair-play-snapshot-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ResultsPage() {
  const { data, isLoading } = useAppState();
  const isCaptain = useIsCaptain();
  const csv = useCsvExport();
  const awarded = (data?.items ?? []).filter((i) => i.status === "awarded");
  const heirs = heirsOf(data?.participants ?? []);
  // Owner-assigned items sit in their own bucket — they never entered the
  // draft pool, so calling them "leftovers" would misrepresent both the
  // owner's decision and what the family did with the rest.
  const ownerAssigned = (data?.items ?? []).filter((i) => i.status === "owner_assigned");
  // Split the owner-assigned bucket into two visual groups:
  //   1) Memorandum-locked items — travelled with a frozen memorandum
  //      from Registry after the owner’s death. Recipient identity is not
  //      in FC on purpose; heirs see photo/name/room and a preamble note.
  //      Grouped by the deceased owner’s first name.
  //   2) Owner-assigned via Registry recipient_hint or comment detection
  //      — recipient IS shown here, as it was before commit 4.
  const memorandumLocked = ownerAssigned.filter((i) => i.lockedByMemorandum);
  const otherOwnerAssigned = ownerAssigned.filter((i) => !i.lockedByMemorandum);

  // Group memorandum-locked items by owner name for the greyed section.
  // "Unknown owner" is the fallback when the exporter could not resolve a
  // participant name at export time (see safeOwnerName in bundle.js).
  const memorandumGroups = memorandumLocked.reduce<Record<string, typeof memorandumLocked>>(
    (acc, i) => {
      const key = i.memorandumOwnerName || "Unknown owner";
      (acc[key] ??= []).push(i);
      return acc;
    },
    {},
  );
  const memorandumGroupNames = Object.keys(memorandumGroups).sort();
  // Anything still unawarded once the whole process is complete: nobody
  // ranked it. Owner-assigned items are excluded because they were never
  // eligible for ranking in the first place.
  const leftovers =
    data?.session.phase === "complete"
      ? (data?.items ?? []).filter(
          (i) => i.status !== "awarded" && i.status !== "owner_assigned",
        )
      : [];

  return (
    <AppShell>
      <PageHeader
        title="Awards ledger"
        subtitle="The complete record of who received what, and in which round. Print this page for the signed final record."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              data-testid="button-results-export-csv"
              disabled={csv.isPending}
              onClick={() => csv.mutate()}
            >
              <Download className="mr-1.5 h-4 w-4" />
              Export CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="button-results-save-snapshot"
              onClick={() =>
                downloadSnapshot().catch((e: Error) =>
                  console.error("Snapshot download failed:", e)
                )
              }
            >
              <Download className="mr-1.5 h-4 w-4" />
              Save to device
            </Button>
            <Button size="sm" data-testid="button-print-results" onClick={() => window.print()}>
              <Printer className="mr-1.5 h-4 w-4" />
              Print / save PDF
            </Button>
          </>
        }
      />

      {isLoading ? (
        <LoadingRows rows={5} />
      ) : (
        <div className="print-sheet space-y-8">
          <div className="hidden items-center gap-3 print:flex">
            <Logo className="h-8 w-8" />
            <div className="font-serif text-lg">Reindeer: FairPlay — Final Record</div>
          </div>

          <Card>
            <CardContent className="p-4">
              <div className="mb-3 font-serif text-lg" data-testid="text-counter-history-heading">
                Contested-loss history
              </div>
              <div className="flex flex-wrap gap-2">
                {heirs.map((h) => (
                  <Badge key={h.id} variant="outline" data-testid={`text-final-counter-${h.id}`}>
                    {h.name}: {h.contestedLossCounter} contested loss(es)
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>

          {awarded.length === 0 ? (
            <Card className="p-10 text-center" data-testid="text-empty-results">
              <p className="font-serif text-lg">Nothing has been awarded yet</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Awards appear here as each round is revealed.
              </p>
            </Card>
          ) : (
            <Table data-testid="table-results">
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Room</TableHead>
                  <TableHead>Received by</TableHead>
                  <TableHead>Round</TableHead>
                  {isCaptain && <TableHead className="text-right">Est. value</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {awarded.map((i) => {
                  const owner = data?.participants.find((p) => p.id === i.awardedToParticipantId);
                  const grouping = data?.groupings.find((g) => g.id === i.groupingId);
                  return (
                    <TableRow key={i.id} data-testid={`row-result-${i.id}`}>
                      <TableCell data-testid={`text-result-item-${i.id}`}>
                        {i.name}
                        {grouping && (
                          <Badge variant="secondary" className="ml-2">
                            {grouping.name}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{i.room || "—"}</TableCell>
                      <TableCell data-testid={`text-result-owner-${i.id}`}>
                        {owner?.name ?? "—"}
                      </TableCell>
                      <TableCell data-testid={`text-result-round-${i.id}`}>
                        {i.awardedInRound ?? "—"}
                        {i.draftPhase && (
                          <Badge
                            variant="outline"
                            className="ml-2 text-[10px] capitalize"
                            data-testid={`badge-draft-phase-${i.id}`}
                          >
                            {i.draftPhase}
                          </Badge>
                        )}
                      </TableCell>
                      {isCaptain && (
                        <TableCell className="text-right">{money(i.aiEstimatedValue)}</TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          {memorandumLocked.length > 0 && memorandumGroupNames.map((ownerName) => (
            <section
              key={`mem-${ownerName}`}
              className="mt-8"
              data-testid={`section-memorandum-${ownerName}`}
            >
              <h2
                className="font-serif text-lg"
                data-testid={`text-memorandum-heading-${ownerName}`}
              >
                Handled as special gifts under {ownerName}’s will
              </h2>
              {/*
                Preamble note (verbatim from the user’s commit 4 decision):
                the memorandum snapshot in FC was captured at Registry
                export time. Between then and now the paper document may
                have moved on. If it has, the paper governs — not this
                screen. The trustee sees the same list on their delivery
                bundle, so heirs and trustee have the same reference point
                for the conversation.
              */}
              <p
                className="mb-3 mt-1 max-w-3xl text-sm text-muted-foreground"
                data-testid={`text-memorandum-preamble-${ownerName}`}
              >
                A word before we begin. The list of special gifts you’ll see
                below was captured from Registry when the memorandum was
                last signed. Between that day and this one, {ownerName} may
                have signed a newer paper memorandum, added handwritten
                notes, or made changes their trustee is holding but Registry
                never saw. If something here doesn’t match what the trustee
                has on paper, the paper is what governs. Ask the trustee.
                We can’t plan for everything.
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {memorandumGroups[ownerName].map((i) => (
                  // Greyed, non-interactive: opacity + muted background +
                  // a caption that explains WHY the item is off the table.
                  // Deliberately NO recipient name — that is on the paper
                  // the trustee holds, and heirs learn it from the trustee,
                  // not from FairPlay.
                  <Card
                    key={i.id}
                    className="cursor-not-allowed border-dashed bg-muted/40 p-3 opacity-70"
                    data-testid={`card-memorandum-locked-${i.id}`}
                    aria-disabled="true"
                  >
                    <div className="text-sm font-medium">{i.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {[i.room].filter(Boolean).join(" · ")}
                    </div>
                    <div
                      className="mt-2 text-xs italic text-muted-foreground"
                      data-testid={`text-memorandum-caption-${i.id}`}
                    >
                      Handled as a special gift under the will.
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ))}

          {otherOwnerAssigned.length > 0 && (
            <section className="mt-8" data-testid="section-owner-assigned">
              <h2 className="font-serif text-lg" data-testid="text-owner-assigned-heading">
                Already assigned by the owner
              </h2>
              <p className="mb-3 mt-1 text-sm text-muted-foreground">
                The owner stated who should receive these items. They were kept
                out of the ranked draft and are recorded here for the trustee's
                records. This is a family-process record, not a legal
                instrument — the signed memorandum and will are the legal path.
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {otherOwnerAssigned.map((i) => (
                  <Card key={i.id} className="p-3" data-testid={`card-owner-assigned-${i.id}`}>
                    <div className="text-sm font-medium">{i.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {[
                        i.room,
                        i.ownerAssignedName ? `To: ${i.ownerAssignedName}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    {i.ownerImportantComment ? (
                      <div
                        className="mt-2 whitespace-pre-wrap border-l-2 border-amber-600 bg-amber-50 p-2 text-xs italic text-amber-900"
                        data-testid={`text-owner-assigned-comment-${i.id}`}
                      >
                        “{i.ownerImportantComment}”
                      </div>
                    ) : null}
                  </Card>
                ))}
              </div>
            </section>
          )}

          {leftovers.length > 0 && (
            <section className="mt-8" data-testid="section-final-leftovers">
              <h2 className="font-serif text-lg" data-testid="text-leftovers-heading">
                Final leftovers
              </h2>
              <p className="mb-3 mt-1 text-sm text-muted-foreground">
                No heir ranked these items. The captain records how they will be handled.
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {leftovers.map((i) => (
                  <Card key={i.id} className="p-3" data-testid={`card-leftover-${i.id}`}>
                    <div className="text-sm font-medium">{i.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {[i.room, isCaptain ? money(i.aiEstimatedValue) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}
