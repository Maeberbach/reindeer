/**
 * captain-facing tracker for the Method Agreement. Shows the roster of heirs and
 * whether each has signed the up-front buy-in. Ranking cannot open until
 * every heir has signed — the server enforces this in markInventoryComplete,
 * and this page is where the captain sees who is holding things up.
 *
 * Read-only. Signing is always done by the individual heir on their own
 * device — the server refuses to record another person's identity.
 */
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAppState, heirsOf } from "@/lib/app";
import {
  CURRENT_METHOD_AGREEMENT_VERSION,
  renderMethodAgreementText,
  type MethodAgreement,
  type Participant,
} from "@shared/schema";
import { CheckCircle2, Circle, ShieldCheck } from "lucide-react";

function formatAgreedAt(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type RosterRow = {
  heir: Participant;
  signed: MethodAgreement | null;
};

export default function MethodAgreementsPage() {
  const { data: state, isLoading: stateLoading } = useAppState();

  const agreementsQuery = useQuery<MethodAgreement[]>({
    queryKey: ["/api/fiduciary/method-agreements"],
    refetchInterval: 5000,
  });

  const heirs = heirsOf(state?.participants ?? []);
  // "Signed" for tracker purposes means signed FOR THE CURRENT CAPTAIN.
  // Signatures collected under a previous captain still exist in the
  // audit log but no longer unlock ranking; heirs are prompted to sign
  // afresh naming the new captain.
  const currentCaptainId = state?.session.captainParticipantId ?? null;
  const byParticipant = new Map<number, MethodAgreement>();
  for (const a of agreementsQuery.data ?? []) {
    if (currentCaptainId != null && a.captainParticipantId === currentCaptainId) {
      byParticipant.set(a.participantId, a);
    }
  }

  const roster: RosterRow[] = heirs.map((h) => ({
    heir: h,
    signed: byParticipant.get(h.id) ?? null,
  }));

  const captainName =
    (currentCaptainId != null &&
      state?.participants.find((p) => p.id === currentCaptainId)?.name) ||
    "the captain";
  const previewText = renderMethodAgreementText(captainName);

  const signedCount = roster.filter((r) => r.signed !== null).length;
  const total = roster.length;
  const allSigned = total > 0 && signedCount === total;
  const missing = roster.filter((r) => !r.signed);

  return (
    <AppShell>
      <PageHeader
        title="Method Agreement"
        subtitle="Every heir signs a short up-front statement before ranking opens. This is who has signed and who has not."
      />

      {stateLoading || agreementsQuery.isLoading ? (
        <LoadingRows rows={4} />
      ) : (
        <div className="space-y-6">
          <Card
            className={
              allSigned
                ? "border-2 border-emerald-500/50"
                : "border-2 border-amber-400/60"
            }
            data-testid="card-agreement-status"
          >
            <CardContent className="space-y-4 p-6 md:p-7">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <span
                    className={
                      allSigned
                        ? "mt-1 text-emerald-600 dark:text-emerald-400"
                        : "mt-1 text-amber-600 dark:text-amber-400"
                    }
                  >
                    <ShieldCheck className="h-7 w-7" />
                  </span>
                  <div>
                    <h2 className="font-serif text-xl font-semibold" data-testid="text-status-heading">
                      {allSigned
                        ? "Everyone has signed."
                        : `${signedCount} of ${total} heir${total === 1 ? "" : "s"} signed`}
                    </h2>
                    <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                      {allSigned
                        ? "You can close cataloging and open ranking whenever you're ready."
                        : "Ranking will not open until every heir has signed. Each heir signs on their own device."}
                    </p>
                  </div>
                </div>
                <Badge
                  variant={allSigned ? "default" : "outline"}
                  className="shrink-0 text-sm"
                  data-testid="badge-status-count"
                >
                  {signedCount}/{total}
                </Badge>
              </div>

              {!allSigned && missing.length > 0 && (
                <div
                  className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                  data-testid="text-missing-summary"
                >
                  <span className="font-medium">Still waiting on: </span>
                  {missing.map((r) => r.heir.name).join(", ")}
                </div>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-agreement-roster">
            <CardContent className="p-0">
              <ul className="divide-y divide-border" data-testid="list-agreement-roster">
                {roster.map((row) => (
                  <li
                    key={row.heir.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 md:px-6"
                    data-testid={`row-agreement-${row.heir.id}`}
                  >
                    <div className="flex items-start gap-3">
                      {row.signed ? (
                        <span className="mt-1 text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-5 w-5" />
                        </span>
                      ) : (
                        <span className="mt-1 text-muted-foreground">
                          <Circle className="h-5 w-5" />
                        </span>
                      )}
                      <div>
                        <p className="text-base font-medium" data-testid={`text-heir-name-${row.heir.id}`}>
                          {row.heir.name}
                        </p>
                        <p
                          className="mt-0.5 text-sm text-muted-foreground"
                          data-testid={`text-heir-status-${row.heir.id}`}
                        >
                          {row.signed
                            ? `Signed ${formatAgreedAt(row.signed.agreedAt)}`
                            : "Not signed yet"}
                        </p>
                      </div>
                    </div>
                    <Badge
                      variant={row.signed ? "default" : "secondary"}
                      className="shrink-0"
                      data-testid={`badge-heir-status-${row.heir.id}`}
                    >
                      {row.signed ? `v${row.signed.agreementVersion}` : "Waiting"}
                    </Badge>
                  </li>
                ))}
                {roster.length === 0 && (
                  <li className="px-4 py-6 text-sm text-muted-foreground md:px-6" data-testid="text-no-heirs">
                    There are no heirs on the roster yet. Add participants from the setup screen.
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>

          <Card data-testid="card-agreement-preview">
            <CardContent className="space-y-3 p-6 md:p-7">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-serif text-lg font-semibold" data-testid="text-preview-heading">
                  What every heir is agreeing to
                </h3>
                <Badge variant="outline">Version {CURRENT_METHOD_AGREEMENT_VERSION}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                This exact wording is snapshotted onto each heir's row when they sign, so future
                edits to this text never retroactively change what someone already agreed to.
              </p>
              <div
                className="rounded-lg border border-border bg-muted/40 p-5 text-base leading-[1.7] text-foreground md:text-lg"
                data-testid="text-preview-body"
              >
                {previewText}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
