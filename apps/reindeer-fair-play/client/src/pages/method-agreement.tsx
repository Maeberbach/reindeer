/**
 * The Method Agreement is the up-front buy-in every heir signs before ranking
 * opens. It records that the heir agrees to divide personal property using
 * FairPlay's ranked-draft method — knowing that dollar totals inside Fair
 * Choice do not need to be equal because the trustee balances the money side
 * externally, using other estate assets, according to the will and trust.
 *
 * Signing is immutable, so this page follows the elderly-user rule of
 * confirming before an irreversible action:
 *   1. Show the exact text plainly, at large type.
 *   2. Reveal a checkbox — "Yes, I've read this and I agree."
 *   3. Only then enable the big green "Sign the Method Agreement" button.
 *   4. On success, replace the whole card with a printable receipt showing
 *      the date, version, and the language that was signed.
 *
 * The current agreement text and version live in shared/schema.ts as
 * CURRENT_METHOD_AGREEMENT_TEXT / CURRENT_METHOD_AGREEMENT_VERSION. We import
 * them directly rather than fetching, because the server snapshots the same
 * constant onto the row at sign time — the two cannot drift.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppState, useUser, useIsCaptain } from "@/lib/app";
import {
  CURRENT_METHOD_AGREEMENT_VERSION,
  renderMethodAgreementText,
  type MethodAgreement,
} from "@shared/schema";
import { CheckCircle2, Printer, ShieldCheck } from "lucide-react";

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

async function postSign(): Promise<MethodAgreement> {
  const res = await fetch("/api/fiduciary/method-agreements", {
    method: "POST",
    // Identity comes from the server session cookie. Deliberately no body:
    // the server MUST NOT read participantId from the request.
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data && typeof data === "object" && "message" in data && (data as { message?: string }).message) ||
        `Could not save your agreement (${res.status}).`,
    );
  }
  return data as MethodAgreement;
}

export default function MethodAgreementPage() {
  const { data: state, isLoading: stateLoading } = useAppState();
  const { userId, participant } = useUser();
  const isCaptain = useIsCaptain();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const agreementsQuery = useQuery<MethodAgreement[]>({
    queryKey: ["/api/fiduciary/method-agreements"],
    enabled: userId !== null,
  });

  // "Already signed" means the heir has a signature on record for the
  // CURRENT captain. A captain change invalidates old signatures for
  // the purpose of unlocking ranking; the heir will see the signing card
  // again with the new captain's name in the text.
  const currentCaptainId = state?.session.captainParticipantId ?? null;
  const mine =
    currentCaptainId == null
      ? null
      : (agreementsQuery.data ?? []).find(
          (a) =>
            a.participantId === userId &&
            a.captainParticipantId === currentCaptainId,
        ) ?? null;
  const alreadySigned = mine !== null;

  const sign = useMutation({
    mutationFn: postSign,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/fiduciary/method-agreements"] });
      // Refresh app state — an heir's own signing may unblock the captain's ability
      // to close cataloging, and the guided step for this heir is now done.
      queryClient.invalidateQueries({ queryKey: ["/api/state"] });
      toast({
        title: "Thank you — your agreement is saved.",
        description: "You can print this page for your records at any time.",
      });
      setConfirming(false);
    },
    onError: (e: Error) => {
      toast({
        title: "We couldn't save your agreement",
        description: e.message,
        variant: "destructive",
      });
      setConfirming(false);
    },
  });

  const meName =
    participant?.name ??
    state?.participants.find((p) => p.id === userId)?.name ??
    "You";

  // The captain's name gets spliced into the agreement text so every heir
  // sees exactly who they are agreeing to let run the session. If the
  // captain later changes, this template resolves to a new string and the
  // server writes a fresh row on the next signing.
  const captainName =
    (currentCaptainId != null &&
      state?.participants.find((p) => p.id === currentCaptainId)?.name) ||
    "the captain";
  const agreementText = renderMethodAgreementText(captainName);

  return (
    <AppShell>
      <PageHeader
        title="The Method Agreement"
        subtitle="A short statement everyone signs before ranking opens. It says how we will divide things — and how the money side is handled separately."
      />

      {stateLoading || agreementsQuery.isLoading ? (
        <LoadingRows rows={3} />
      ) : alreadySigned && mine ? (
        <SignedReceipt agreement={mine} name={meName} />
      ) : (
        <Card data-testid="card-method-agreement">
          <CardContent className="space-y-6 p-6 md:p-8">
            <div className="flex items-start gap-3">
              <span className="mt-1 text-primary">
                <ShieldCheck className="h-6 w-6" />
              </span>
              <div>
                <h2 className="font-serif text-2xl font-semibold" data-testid="text-agreement-heading">
                  Please read this, then sign.
                </h2>
                <p className="mt-2 text-base leading-relaxed text-muted-foreground">
                  This is the one thing we ask everyone to agree to before any picking begins.
                  It is short and in plain language. Read it once and, if you agree, tick the
                  box and press the button.
                </p>
              </div>
            </div>

            <div
              className="rounded-lg border-2 border-primary/20 bg-primary/5 p-6 text-lg leading-[1.7] text-foreground md:text-xl md:leading-[1.7]"
              data-testid="text-agreement-body"
            >
              {agreementText}
            </div>

            <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-4">
              <Checkbox
                id="ack-agreement"
                checked={acknowledged}
                onCheckedChange={(v) => setAcknowledged(v === true)}
                data-testid="checkbox-acknowledge"
                className="mt-1 h-6 w-6"
              />
              <Label htmlFor="ack-agreement" className="cursor-pointer text-base leading-relaxed">
                Yes — I have read the statement above and I agree to it.
              </Label>
            </div>

            {isCaptain && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                You are the captain. If you are also an heir, you may sign for
                yourself here. Otherwise, each heir needs to sign on their own device.
              </p>
            )}

            <div className="flex flex-col gap-3 border-t border-border pt-5 md:flex-row md:items-center md:justify-between">
              <p className="text-sm text-muted-foreground">
                Signed as{" "}
                <span className="font-medium text-foreground" data-testid="text-signing-as">
                  {meName}
                </span>
                . Version {CURRENT_METHOD_AGREEMENT_VERSION}.
              </p>

              {!confirming ? (
                <Button
                  size="lg"
                  className="min-h-[52px] px-6 text-base"
                  data-testid="button-sign-agreement"
                  disabled={!acknowledged || sign.isPending}
                  onClick={() => setConfirming(true)}
                >
                  Sign the Method Agreement
                </Button>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    size="lg"
                    variant="outline"
                    className="min-h-[52px] text-base"
                    data-testid="button-cancel-confirm"
                    disabled={sign.isPending}
                    onClick={() => setConfirming(false)}
                  >
                    Not yet
                  </Button>
                  <Button
                    size="lg"
                    className="min-h-[52px] px-6 text-base"
                    data-testid="button-confirm-sign"
                    disabled={sign.isPending}
                    onClick={() => sign.mutate()}
                  >
                    {sign.isPending ? "Saving your signature…" : "Yes, sign it now"}
                  </Button>
                </div>
              )}
            </div>

            {confirming && (
              <p className="rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">
                Once you sign, this cannot be undone — the exact wording above will be kept
                with the estate's record.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {alreadySigned && (
        <div className="mt-6 flex flex-wrap gap-3">
          <Button
            variant="outline"
            size="lg"
            className="min-h-[48px] text-base"
            data-testid="button-back-to-next"
            onClick={() => navigate("/next")}
          >
            Continue to the next step
          </Button>
        </div>
      )}
    </AppShell>
  );
}

function SignedReceipt({
  agreement,
  name,
}: {
  agreement: MethodAgreement;
  name: string;
}) {
  return (
    <Card className="border-2 border-emerald-500/40" data-testid="card-agreement-receipt">
      <CardContent className="space-y-5 p-6 md:p-8">
        <div className="flex items-start gap-3">
          <span className="mt-1 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-7 w-7" />
          </span>
          <div>
            <h2 className="font-serif text-2xl font-semibold" data-testid="text-receipt-heading">
              Signed — thank you.
            </h2>
            <p className="mt-2 text-base leading-relaxed text-muted-foreground">
              Your agreement is saved with the estate's record. You can print this page for your
              own records at any time.
            </p>
          </div>
        </div>

        <dl className="grid gap-3 rounded-md border border-border bg-muted/40 p-4 text-base sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted-foreground">Signed by</dt>
            <dd className="mt-1 font-medium" data-testid="text-receipt-name">
              {name}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">When</dt>
            <dd className="mt-1 font-medium" data-testid="text-receipt-when">
              {formatAgreedAt(agreement.agreedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Version</dt>
            <dd className="mt-1 font-medium" data-testid="text-receipt-version">
              <Badge variant="outline">{agreement.agreementVersion}</Badge>
            </dd>
          </div>
        </dl>

        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">
            The exact language you agreed to:
          </p>
          <div
            className="rounded-lg border border-border bg-background p-5 text-base leading-[1.7] text-foreground md:text-lg"
            data-testid="text-receipt-snapshot"
          >
            {agreement.agreementTextSnapshot}
          </div>
        </div>

        <div className="no-print flex justify-end pt-1">
          <Button
            variant="outline"
            size="lg"
            className="min-h-[48px] text-base"
            data-testid="button-print-receipt"
            onClick={() => window.print()}
          >
            <Printer className="mr-2 h-4 w-4" />
            Print this page
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
