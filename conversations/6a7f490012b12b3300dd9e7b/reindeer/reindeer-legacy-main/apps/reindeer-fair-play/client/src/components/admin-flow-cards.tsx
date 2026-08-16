import { useMutation, useQuery } from "@tanstack/react-query";
import type { MethodAgreement } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { STATE_KEY, useAppState, useUser, heirsOf } from "@/lib/app";
import { FLAG_LABEL } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { BellRing, Undo2, ClipboardCheck, CheckCircle2, ScrollText, Printer, ExternalLink, AlertTriangle } from "lucide-react";
import { Link, useLocation } from "wouter";

/* ------------------------------------------------------------------ */
/* Shared mutation helper                                              */
/* ------------------------------------------------------------------ */
function useSettings() {
  const { userId } = useUser();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      (
        await apiRequest("PATCH", "/api/session/settings", { ...patch, participantId: userId })
      ).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Setting saved" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });
}

/* ------------------------------------------------------------------ */
/* Cataloging status                                                   */
/* ------------------------------------------------------------------ */
export function CatalogingStatusCard() {
  const { data } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const settings = useSettings();
  const status = data?.cataloging;
  const phase = data?.session.phase ?? "welcome";
  const [, navigate] = useLocation();

  // The button no longer closes cataloging directly — that would skip the
  // captain's appraisal review, which the user's rules require as a stop
  // ("required stop, no skip"). Instead it navigates to the review screen,
  // which is where the actual mark-inventory-complete call now happens.
  const goToAppraisalReview = () => navigate("/appraisal-review");

  const reopen = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/session/reopen-inventory", { participantId: userId })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Inventory reopened", description: "The table is back in cataloging." });
    },
    onError: (e: Error) =>
      toast({ title: "Could not reopen", description: e.message, variant: "destructive" }),
  });

  // Method Agreement gate. Ranking cannot open until every heir has signed.
  // The server enforces this in mark-inventory-complete; we surface it here so
  // the captain does not press the button and get a 409.
  const agreements = useQuery<MethodAgreement[]>({
    queryKey: ["/api/fiduciary/method-agreements"],
    enabled: phase === "intake",
    refetchInterval: phase === "intake" ? 5000 : false,
  });
  const heirs = heirsOf(data?.participants ?? []);
  const signedIds = new Set((agreements.data ?? []).map((a) => a.participantId));
  const unsignedHeirs = heirs.filter((h) => !signedIds.has(h.id));
  const allHeirsSigned = heirs.length > 0 && unsignedHeirs.length === 0;
  const methodAgreementGateBlocking = phase === "intake" && !allHeirsSigned;

  if (!status) return null;

  return (
    <Card data-testid="card-cataloging-status">
      <CardContent className="space-y-3 p-4">
        {phase === "intake" && (
          <div
            className={
              allHeirsSigned
                ? "flex flex-wrap items-start justify-between gap-3 rounded-md border border-emerald-400/60 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-800 dark:bg-emerald-950/30"
                : "flex flex-wrap items-start justify-between gap-3 rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/30"
            }
            data-testid="row-method-agreement-gate"
          >
            <div className="flex items-start gap-2">
              <span
                className={
                  allHeirsSigned
                    ? "mt-0.5 text-emerald-700 dark:text-emerald-300"
                    : "mt-0.5 text-amber-700 dark:text-amber-300"
                }
              >
                {allHeirsSigned ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <ClipboardCheck className="h-4 w-4" />
                )}
              </span>
              <div>
                <p
                  className="font-medium"
                  data-testid="text-method-agreement-gate-title"
                >
                  Method Agreement — {signedIds.size} of {heirs.length} signed
                </p>
                <p
                  className="mt-0.5 text-xs text-muted-foreground"
                  data-testid="text-method-agreement-gate-detail"
                >
                  {allHeirsSigned
                    ? "Every heir has signed. You can close cataloging when the inventory is ready."
                    : unsignedHeirs.length > 0
                    ? `Waiting on: ${unsignedHeirs.map((h) => h.name).join(", ")}`
                    : "No heirs on the roster yet."}
                </p>
              </div>
            </div>
            <Link
              href="/method-agreements"
              className="self-center text-xs font-medium text-primary underline-offset-2 hover:underline"
              data-testid="link-method-agreements"
            >
              Open tracker →
            </Link>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Label className="text-sm font-medium">Cataloging</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {status.total} item{status.total === 1 ? "" : "s"} catalogued
              {status.complete ? " · inventory closed" : " · inventory open"}
            </p>
          </div>
          <div className="flex gap-2">
            {phase === "intake" && (
              <Button
                size="sm"
                data-testid="button-mark-inventory-complete"
                disabled={status.total === 0 || methodAgreementGateBlocking}
                title={
                  methodAgreementGateBlocking
                    ? `Waiting on Method Agreement from: ${unsignedHeirs
                        .map((h) => h.name)
                        .join(", ")}`
                    : undefined
                }
                onClick={goToAppraisalReview}
              >
                Ready for the game
              </Button>
            )}
            {(phase === "intake" || phase === "ranking") && (
              <Button
                size="sm"
                variant="outline"
                data-testid="button-open-appraisal-review"
                onClick={goToAppraisalReview}
                title="Look over what will and won't be appraised"
              >
                Appraisal review
              </Button>
            )}
            {phase === "ranking" && (
              <Button
                size="sm"
                variant="outline"
                data-testid="button-reopen-inventory"
                disabled={reopen.isPending}
                onClick={() => reopen.mutate()}
              >
                Reopen inventory
              </Button>
            )}
          </div>
        </div>

        <ul className="divide-y divide-border rounded-md border border-border" data-testid="list-contributors">
          {status.contributors.map((c) => (
            <li
              key={`${c.participantId ?? "captain"}`}
              className="flex items-center justify-between px-3 py-2 text-sm"
              data-testid={`row-contributor-${c.participantId ?? "captain"}`}
            >
              <span className="flex items-center gap-2">
                {c.name}
                {c.isCaptain && (
                  <Badge variant="outline" className="text-[10px]">
                    Captain
                  </Badge>
                )}
              </span>
              <span className="tabular-nums text-muted-foreground">{c.count}</span>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
          <div>
            <Label htmlFor="switch-heirs-add-inventory" className="text-sm">
              Heirs may add inventory
            </Label>
            <p className="text-xs text-muted-foreground">
              Adds an Inventory step to each heir's guided sequence during cataloging.
            </p>
          </div>
          <Switch
            id="switch-heirs-add-inventory"
            data-testid="switch-heirs-add-inventory"
            checked={!!data?.session.heirsCanAddInventory}
            onCheckedChange={(v) => settings.mutate({ heirsCanAddInventory: v })}
          />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
          <div>
            <Label htmlFor="switch-heirs-groupings" className="text-sm">
              Heirs may propose groupings
            </Label>
            <p className="text-xs text-muted-foreground">
              Lets heirs suggest sets of items that should stay together.
            </p>
          </div>
          <Switch
            id="switch-heirs-groupings"
            data-testid="switch-heirs-propose-groupings"
            checked={!!data?.session.heirsCanProposeGroupings}
            onCheckedChange={(v) => settings.mutate({ heirsCanProposeGroupings: v })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Record of Decisions (Trustee Handoff document)                      */
/* ------------------------------------------------------------------ */

type RecordOfDecisions = {
  session: { id: number; name: string; estateName: string | null };
  captain: { id: number | null; name: string | null };
  heirs: Array<{ id: number; name: string; methodAgreedAt: number | null }>;
  items: Array<{
    id: number;
    name: string;
    room: string | null;
    category: string | null;
    awardedToParticipantId: number | null;
    awardedToName: string | null;
    needsAppraisal: boolean;
    appraisedValue: number | null;
    valueSource: string | null;
    valuationDate: number | null;
    pendingAppraisal: boolean;
    escalatingParticipantId: number | null;
    escalatingParticipantName: string | null;
  }>;
  totals: {
    itemCount: number;
    appraisedCount: number;
    pendingAppraisalCount: number;
    totalAppraisedValue: number;
  };
  generatedAt: number;
};

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Preview + print of the family's final Record of Decisions when Fair
 * Choice ends. Read-only: the document is fully assembled server-side; this
 * card only fetches the JSON view and offers a print action that opens the
 * server-rendered HTML in a new tab, where the browser's own Print dialog
 * takes over. Same-origin so the session cookie authenticates the print
 * request — no participantId in the URL.
 */
export function RecordOfDecisionsCard() {
  const record = useQuery<RecordOfDecisions>({
    queryKey: ["/api/fiduciary/record-of-decisions"],
    refetchInterval: 15000,
  });

  const totals = record.data?.totals;
  const items = record.data?.items ?? [];
  const pending = items.filter((i) => i.pendingAppraisal);
  const awarded = items.filter((i) => i.awardedToParticipantId !== null);

  return (
    <Card data-testid="card-record-of-decisions">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-primary">
              <ScrollText className="h-5 w-5" />
            </span>
            <div>
              <Label className="text-sm font-medium">Record of Decisions</Label>
              <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                The family's final record — who received what, which items need
                appraisal, and every heir's signed agreement. Always up to date;
                opens in a new tab for printing.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="min-h-[44px]"
              data-testid="button-record-of-decisions-open"
              onClick={() =>
                window.open("/api/fiduciary/record-of-decisions/print", "_blank", "noopener")
              }
            >
              <ExternalLink className="mr-1.5 h-4 w-4" />
              Open printable view
            </Button>
            <Button
              className="min-h-[44px]"
              data-testid="button-record-of-decisions-print"
              onClick={() => {
                const w = window.open(
                  "/api/fiduciary/record-of-decisions/print",
                  "_blank",
                  "noopener",
                );
                // Give the browser a beat to load the HTML before invoking print.
                if (w) w.addEventListener("load", () => w.print());
              }}
            >
              <Printer className="mr-1.5 h-4 w-4" />
              Print for the family record
            </Button>
          </div>
        </div>

        {record.isLoading ? (
          <p className="text-xs text-muted-foreground" data-testid="text-rod-loading">
            Loading the record…
          </p>
        ) : record.isError ? (
          <p
            className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive"
            data-testid="text-rod-error"
          >
            We couldn't load the record right now. Try again in a moment.
          </p>
        ) : record.data ? (
          <div className="space-y-3">
            <dl className="grid gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Items</dt>
                <dd className="mt-0.5 font-medium tabular-nums" data-testid="text-rod-item-count">
                  {totals?.itemCount ?? 0}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Awarded</dt>
                <dd className="mt-0.5 font-medium tabular-nums" data-testid="text-rod-awarded-count">
                  {awarded.length}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Appraised</dt>
                <dd className="mt-0.5 font-medium tabular-nums" data-testid="text-rod-appraised-count">
                  {totals?.appraisedCount ?? 0}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Pending appraisal</dt>
                <dd
                  className={`mt-0.5 font-medium tabular-nums ${
                    (totals?.pendingAppraisalCount ?? 0) > 0
                      ? "text-amber-700 dark:text-amber-300"
                      : ""
                  }`}
                  data-testid="text-rod-pending-count"
                >
                  {totals?.pendingAppraisalCount ?? 0}
                </dd>
              </div>
            </dl>

            {pending.length > 0 && (
              <div
                className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950/30"
                data-testid="box-rod-pending"
              >
                <p className="font-medium text-amber-900 dark:text-amber-200">
                  {pending.length} item{pending.length === 1 ? "" : "s"} flagged for
                  appraisal:
                </p>
                <ul className="mt-1.5 space-y-0.5 text-amber-900 dark:text-amber-200">
                  {pending.slice(0, 6).map((p) => (
                    <li key={p.id} data-testid={`text-rod-pending-item-${p.id}`}>
                      · {p.name}
                      {p.awardedToName ? ` → ${p.awardedToName}` : ""}
                      {p.escalatingParticipantName
                        ? ` (escalated by ${p.escalatingParticipantName})`
                        : ""}
                    </li>
                  ))}
                  {pending.length > 6 && (
                    <li className="italic opacity-75">… and {pending.length - 6} more</li>
                  )}
                </ul>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground" data-testid="text-rod-generated-at">
              Snapshot generated {formatWhen(record.data.generatedAt)}.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Automatic draft                                                     */
/* ------------------------------------------------------------------ */
export function AutoDraftCard() {
  const { data } = useAppState();
  const { userId } = useUser();
  const settings = useSettings();
  const { toast } = useToast();
  const rec = data?.reconciliation;

  const resume = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/session/resume-auto", { participantId: userId })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Automatic draft resumed" });
    },
  });

  return (
    <Card data-testid="card-auto-draft">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="switch-auto-draft" className="text-sm font-medium">
              Automatic rounds
            </Label>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              When every heir's next choice is different, the round resolves itself from their
              ranked lists. A contested round pauses the automation, runs the usual reveal and
              second choice, then hands back.
            </p>
          </div>
          <Switch
            id="switch-auto-draft"
            data-testid="switch-auto-draft"
            checked={!!data?.session.autoDraftEnabled}
            onCheckedChange={(v) => settings.mutate({ autoDraftEnabled: v })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" data-testid="badge-auto-streak">
            Streak {rec?.streak ?? 0}/{rec?.interval ?? 5}
          </Badge>
          {rec?.paused && (
            <Badge variant="destructive" data-testid="badge-auto-paused">
              Paused
            </Badge>
          )}
          {rec?.paused && (
            <Button
              size="sm"
              data-testid="button-resume-auto"
              disabled={resume.isPending}
              onClick={() => resume.mutate()}
            >
              Resume automatic draft
            </Button>
          )}
        </div>
        <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
          <div>
            <Label htmlFor="input-nudge-ms" className="text-sm">
              Check-in reminder after
            </Label>
            <p className="text-xs text-muted-foreground">
              Minutes to wait before an unanswered check-in raises a banner for you.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="input-nudge-ms"
              data-testid="input-nudge-ms"
              type="number"
              min={1}
              step={1}
              className="h-8 w-20"
              defaultValue={Math.max(1, Math.round((rec?.nudgeMs ?? 300000) / 60000))}
              onBlur={(e) => {
                const minutes = Number(e.target.value);
                if (Number.isFinite(minutes) && minutes >= 1)
                  settings.mutate({ reconciliationNudgeMs: Math.round(minutes * 60000) });
              }}
            />
            <span className="text-xs text-muted-foreground">min</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Reconciliation banner (captain)                                          */
/* ------------------------------------------------------------------ */
export function ReconciliationAdminBanner() {
  const { data } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const rec = data?.reconciliation;

  const nudge = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/reconciliation/nudge", { participantId: userId })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Reminder sent" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not send", description: e.message, variant: "destructive" }),
  });

  if (!rec?.active) return null;

  return (
    <div
      className={`mb-4 flex flex-wrap items-center gap-3 rounded-md border px-4 py-3 text-sm ${
        rec.stalled
          ? "border-[#c9a227] bg-[#fdf3d0] text-[#5a4409] dark:bg-[#3a3007] dark:text-[#f4e2a1]"
          : "border-border bg-muted/40"
      }`}
      data-testid="banner-reconciliation-captain"
      data-stalled={rec.stalled ? "true" : "false"}
    >
      {rec.stalled ? <AlertTriangle className="h-4 w-4" /> : <BellRing className="h-4 w-4" />}
      <span>
        Check-in after round {rec.round}: {rec.responded.length} of{" "}
        {rec.responded.length + rec.pending.length} answered.
        {rec.pending.length > 0 && (
          <> Waiting on {rec.pending.map((p) => p.name).join(", ")}.</>
        )}
      </span>
      {rec.pending.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          data-testid="button-send-reminder"
          disabled={nudge.isPending}
          onClick={() => nudge.mutate()}
        >
          Send reminder
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Classification activity                                             */
/* ------------------------------------------------------------------ */
type ChangeRow = {
  id: number;
  itemId: number;
  itemName: string;
  flagName: string;
  oldValue: boolean;
  newValue: boolean;
  changedByName: string;
  changedAt: number;
  reason: string;
  phase: string;
  isRevert: boolean;
  revertedAt: number | null;
};

export function ClassificationActivityCard() {
  const { userId } = useUser();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ changes: ChangeRow[] }>({
    queryKey: ["/api/classification-changes", userId],
    refetchInterval: 5000,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/classification-changes?participantId=${userId ?? ""}`,
      );
      return res.json();
    },
  });

  const revert = useMutation({
    mutationFn: async (row: ChangeRow) =>
      (
        await apiRequest("POST", `/api/items/${row.itemId}/flags/${row.id}/revert`, {
          participantId: userId,
        })
      ).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/classification-changes"] });
      // A high-value flag strips the item from everyone's ranking, so the
      // ranking panes have to be refetched, not only the shared state.
      queryClient.invalidateQueries({ queryKey: ["/api/rankings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications/mine"] });
      toast({ title: "Change reverted" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not revert", description: e.message, variant: "destructive" }),
  });

  const rows = (data?.changes ?? []).filter((c) => !c.isRevert);

  return (
    <Card data-testid="card-classification-activity">
      <CardContent className="p-4">
        <Label className="text-sm font-medium">Classification activity</Label>
        <p className="mb-3 mt-1 max-w-2xl text-xs text-muted-foreground">
          Every heirloom, high-value and sentimental flag set by the family, newest first. Reverting
          restores the item — and any rankings a high-value flag removed.
        </p>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-no-classification-activity">
            No classification changes yet.
          </p>
        )}
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
              data-testid={`row-classification-change-${c.id}`}
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{c.itemName}</span>{" "}
                <span className="text-muted-foreground">
                  — {c.changedByName} {c.newValue ? "set" : "cleared"}{" "}
                  {FLAG_LABEL[c.flagName as keyof typeof FLAG_LABEL] ?? c.flagName}
                  {c.reason ? ` · “${c.reason}”` : ""}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {new Date(c.changedAt).toLocaleTimeString()} · {c.phase}
                </span>
              </span>
              {c.revertedAt ? (
                <Badge variant="outline" data-testid={`badge-reverted-${c.id}`}>
                  Reverted
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`button-revert-change-${c.id}`}
                  disabled={revert.isPending}
                  onClick={() => revert.mutate(c)}
                >
                  <Undo2 className="mr-1 h-3 w-3" />
                  Revert
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Categorization (v6)                                                 */
/* ------------------------------------------------------------------ */

/**
 * Categories are optional in v6, so this card never nags. It reports how many
 * things are still unfiled, offers a one-tap sweep through the analyser, and
 * carries the toggle that decides whether heirs may file things themselves.
 */
export function CategorizationCard() {
  const { data } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const status = data?.categorization;

  const setToggle = useMutation({
    mutationFn: async (enabled: boolean) =>
      (
        await apiRequest("POST", "/api/session/heirs-can-categorize", {
          enabled,
          participantId: userId,
        })
      ).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Categorising permission saved" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const bulk = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/session/bulk-analyze", { participantId: userId })).json(),
    onSuccess: (out: { examined: number; assigned: number; stillUncategorized: number }) => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({
        title: "Bulk analysis complete",
        description: `${out.assigned} of ${out.examined} filed automatically; ${out.stillUncategorized} left for a person.`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "Bulk analysis failed", description: e.message, variant: "destructive" }),
  });

  if (!status) return null;

  return (
    <Card data-testid="card-categorization">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-sm font-medium">Categorization</Label>
          <Badge variant="outline" data-testid="badge-ai-mode">
            {status.aiMode === "mock" ? "Offline sorting" : "Live model"}
          </Badge>
        </div>
        <p className="mb-3 mt-1 max-w-2xl text-xs text-muted-foreground">
          Categories are optional. Nothing waits on them — an unfiled item still enters the
          rankings and the draft. Automatic sorting only files what it is confident about.
        </p>

        <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Heirs can categorize items</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Lets any heir add or correct a category from Inventory, Ranking, or the review
              queue. On by default.
            </p>
          </div>
          <Switch
            checked={!!status.heirsCanCategorize}
            data-testid="switch-heirs-can-categorize"
            disabled={setToggle.isPending}
            onCheckedChange={(v) => setToggle.mutate(v)}
          />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border border-border p-3">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
              Uncategorized
            </p>
            <p className="mt-1 text-xl font-semibold" data-testid="text-uncategorized-count">
              {status.uncategorized}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              data-testid="button-bulk-analyze"
              disabled={bulk.isPending || status.uncategorized === 0}
              onClick={() => bulk.mutate()}
            >
              {bulk.isPending ? "Analysing…" : "Run bulk AI analyze"}
            </Button>
          </div>
          <div className="rounded-md border border-border p-3">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
              Discussion needed
            </p>
            <p className="mt-1 text-xl font-semibold" data-testid="text-discussion-count">
              {status.needsDiscussion}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              data-testid="button-view-discussion-items"
              onClick={() => navigate("/category-review")}
            >
              Review categories
            </Button>
          </div>
        </div>

        {status.collaborators.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground" data-testid="text-category-collaborators">
            {status.collaborators.map((c) => `${c.name} ${c.count}`).join(" · ")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

