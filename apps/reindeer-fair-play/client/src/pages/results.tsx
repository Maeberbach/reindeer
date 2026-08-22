import { useAppState, useIsCaptain, useCanSeeValues, heirsOf, money } from "@/lib/app";
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
import { Download, Printer, FileText, Store } from "lucide-react";

export default function ResultsPage() {
  const { data, isLoading } = useAppState();
  const isCaptain = useIsCaptain();
  const canSeeValues = useCanSeeValues();
  const csv = useCsvExport();
  const awarded = (data?.items ?? []).filter((i) => i.status === "awarded");
  const heirs = heirsOf(data?.participants ?? []);
  // Owner-assigned items sit in their own bucket — they never entered the
  // draft pool, so calling them "leftovers" would misrepresent both the
  // owner's decision and what the family did with the rest.
  const ownerAssigned = (data?.items ?? []).filter((i) => i.status === "owner_assigned");
  // Split the owner-assigned bucket into two visual groups:
  //   1) Memorandum-locked items — travelled with a frozen memorandum
  //      from Reindeer Wishes after the owner’s death. Recipient identity is not
  //      in FC on purpose; heirs see photo/name/room and a preamble note.
  //      Grouped by the deceased owner’s first name.
  //   2) Owner-assigned via Wishes recipient_hint or comment detection
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
                      {canSeeValues && (
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
                the memorandum snapshot in FC was captured at Wishes
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
                below was captured from Reindeer Wishes when the memorandum was
                last signed. Between that day and this one, {ownerName} may
                have signed a newer paper memorandum, added handwritten
                notes, or made changes their trustee is holding but Wishes
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
            <section className="mt-12 print-sheet" data-testid="section-estate-sale">
              <div className="flex items-center gap-2">
                <Store className="h-5 w-5 text-muted-foreground" />
                <h2 className="font-serif text-lg" data-testid="text-estate-sale-heading">
                  Estate sale preparation
                </h2>
              </div>
              <p className="mb-3 mt-1 max-w-3xl text-sm text-muted-foreground">
                {leftovers.length} {leftovers.length === 1 ? "item" : "items"} no heir selected
                during the distribution. Curated for handoff to an estate sale specialist.
              </p>

              {/* Summary stats */}
              <Card className="mb-4">
                <CardContent className="flex flex-wrap gap-6 p-4">
                  <div>
                    <div className="text-2xl font-bold text-primary">{leftovers.length}</div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Items for sale</div>
                  </div>
                  {canSeeValues && (() => {
                    const totalVal = leftovers.reduce(
                      (s, i) => s + (i.estimatedValue ?? i.aiEstimatedValue ?? 0), 0
                    );
                    return totalVal > 0 ? (
                      <div>
                        <div className="text-2xl font-bold text-primary">
                          {money(totalVal)}
                        </div>
                        <div className="text-xs text-muted-foreground uppercase tracking-wide">Total est. value</div>
                      </div>
                    ) : null;
                  })()}
                  <div>
                    <div className="text-2xl font-bold text-primary">
                      {new Set(leftovers.map((i) => i.room || "Unspecified")).size}
                    </div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wide">Rooms</div>
                  </div>
                </CardContent>
              </Card>

              {/* Captain-only action buttons for estate sale report handoff */}
              {isCaptain && (
                <div className="mb-4 flex gap-2 print:hidden">
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="button-estate-sale-print"
                    onClick={() =>
                      window.open("/api/print/estate-sale", "_blank")
                    }
                  >
                    <FileText className="mr-1.5 h-4 w-4" />
                    Print specialist report
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="button-estate-sale-csv"
                    onClick={async () => {
                      const res = await fetch("/api/estate-sale/export.csv", { credentials: "include" });
                      if (!res.ok) return;
                      const blob = await res.blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "estate-sale-preparation.csv";
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Download className="mr-1.5 h-4 w-4" />
                    Export CSV
                  </Button>
                </div>
              )}

              {/* Items grouped by room */}
              {Object.entries(
                leftovers.reduce<Record<string, typeof leftovers>>((acc, i) => {
                  const key = i.room || "Unspecified room";
                  (acc[key] ??= []).push(i);
                  return acc;
                }, {}),
              ).sort(([a], [b]) => a.localeCompare(b)).map(([room, items]) => (
                <div key={room} className="mb-6">
                  <h3 className="mb-2 font-serif text-base text-muted-foreground">
                    {room} <span className="text-xs">({items.length})</span>
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((i) => {
                      // Parse identifiers (maker marks, serial numbers)
                      let idents: string[] = [];
                      try {
                        const ids = JSON.parse(i.identifiers || "{}");
                        idents = Object.entries(ids)
                          .filter(([, v]) => v)
                          .map(([k, v]) => `${k}: ${String(v)}`);
                      } catch { /* empty */ }
                      return (
                        <Card
                          key={i.id}
                          className="overflow-hidden p-0"
                          data-testid={`card-estate-sale-${i.id}`}
                        >
                          {/* Photo */}
                          {(i.photoUrl || i.thumbnailUrl) && (
                            <img
                              src={(i.photoUrl || i.thumbnailUrl) ?? ""}
                              alt={i.name}
                              className="h-32 w-full object-cover"
                            />
                          )}
                          <div className="p-3">
                            <div className="flex items-baseline justify-between gap-2">
                              <div className="text-sm font-medium">{i.name}</div>
                              {i.quantity > 1 && (
                                <Badge variant="outline" className="shrink-0 text-[10px]">
                                  ×{i.quantity}
                                </Badge>
                              )}
                            </div>
                            {i.category && (
                              <div className="mt-0.5 text-xs text-muted-foreground">
                                {i.category}
                              </div>
                            )}
                            {i.conditionNote && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                <span className="font-medium">Condition:</span> {i.conditionNote}
                              </div>
                            )}
                            {idents.length > 0 && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                <span className="font-medium">Identifiers:</span>{" "}
                                {idents.join(" · ")}
                              </div>
                            )}
                            {canSeeValues && (i.estimatedValue || i.aiEstimatedValue) && (
                              <div className="mt-1 text-xs font-medium text-primary">
                                {money(i.estimatedValue ?? i.aiEstimatedValue ?? 0)}
                              </div>
                            )}
                            {i.inventoryStory && (
                              <div className="mt-2 text-xs italic text-muted-foreground line-clamp-2">
                                {i.inventoryStory}
                              </div>
                            )}
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}
