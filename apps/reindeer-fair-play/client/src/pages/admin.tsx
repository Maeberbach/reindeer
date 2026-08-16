import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAppState, useUser, useCaptainRole, STATE_KEY, phaseLabel } from "@/lib/app";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { useTaxonomy, TAXONOMY_KEY } from "@/components/room-picker";
import { RankingAdminCards } from "@/components/ranking-admin";
import { RegistrationPanel, TransferCaptainPanel } from "@/components/registration";
import { SessionLifecycleCard } from "@/components/session-lifecycle-card";
import { TrusteeHandoffCard } from "@/components/trustee-handoff-card";
import {
  AutoDraftCard,
  CatalogingStatusCard,
  CategorizationCard,
  ClassificationActivityCard,
  RecordOfDecisionsCard,
  ReconciliationAdminBanner,
} from "@/components/admin-flow-cards";
import type { TaxonomyRow, PracticeResults } from "@shared/schema";
import {
  HEIR_CAPABILITIES,
  HEIRS_CAN_CATEGORIZE_CAPABILITY,
  PRACTICE_HEIR_COUNT_OPTIONS,
  parseHeirPermissions,
  registrationOpen,
  CAPTAIN_PASSPHRASE_MIN_LENGTH,
  CAPTAIN_PASSPHRASE_HELP,
  CAPTAIN_PASSPHRASE_INVITATION,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Download, FlaskConical, Merge, Plus, Trash2, Pencil } from "lucide-react";

const PHASES = [
  "welcome",
  "estate_name",
  "registration",
  "intake",
  "ranking",
  "groupings",
  "draft",
  "secondary_ranking",
  "secondary_draft",
  "complete",
] as const;

export const PRACTICE_RESULTS_KEY = ["/api/practice/results"];

/** Fetch the practice CSV through apiRequest so the deploy proxy base applies. */
async function downloadPracticeCsv() {
  const res = await apiRequest("GET", "/api/practice/results.csv");
  const text = await res.text();
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "practice-results.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ------------------------------------------------------------------ */
/* Rooms & Categories panel                                            */
/* ------------------------------------------------------------------ */
function TaxonomyPanel({
  kind,
  rows,
  actorId,
}: {
  kind: "room" | "category";
  rows: TaxonomyRow[];
  actorId: number | null;
}) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<number[]>([]);
  const [custom, setCustom] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const noun = kind === "room" ? "room" : "category";
  const plural = kind === "room" ? "Rooms" : "Categories";

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: TAXONOMY_KEY });
    queryClient.invalidateQueries({ queryKey: STATE_KEY });
  };

  const toggleEnabled = useMutation({
    mutationFn: async (v: { id: number; isEnabled: boolean }) =>
      (
        await apiRequest("PATCH", `/api/taxonomy/${v.id}`, {
          isEnabled: v.isEnabled,
          actorId,
        })
      ).json(),
    onSuccess: refresh,
    onError: (e: Error) =>
      toast({
        title: "Cannot disable",
        description: e.message.replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, ""),
        variant: "destructive",
      }),
  });

  const addCustom = useMutation({
    mutationFn: async (label: string) =>
      (await apiRequest("POST", "/api/taxonomy", { kind, label, isEnabled: true, actorId })).json(),
    onSuccess: () => {
      setCustom("");
      refresh();
      toast({ title: `Custom ${noun} added` });
    },
  });

  const merge = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/taxonomy/merge", { kind, sourceIds: selected, actorId })).json(),
    onSuccess: (r: { row: TaxonomyRow; reassigned: number }) => {
      setSelected([]);
      setConfirmOpen(false);
      refresh();
      toast({
        title: `Merged into “${r.row.label}”`,
        description: `${r.reassigned} item${r.reassigned === 1 ? "" : "s"} reassigned.`,
      });
    },
    onError: (e: Error) => {
      setConfirmOpen(false);
      toast({
        title: "Merge blocked",
        description: e.message.replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, ""),
        variant: "destructive",
      });
    },
  });

  const del = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("DELETE", `/api/taxonomy/${id}`)).json(),
    onSuccess: () => {
      refresh();
      toast({ title: `${noun === "room" ? "Room" : "Category"} deleted` });
    },
    onError: (e: Error) =>
      toast({
        title: "Cannot delete",
        description: e.message.replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, ""),
        variant: "destructive",
      }),
  });

  const [renameId, setRenameId] = useState<number | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const renameMut = useMutation({
    mutationFn: async ({ id, label }: { id: number; label: string }) =>
      (await apiRequest("PATCH", `/api/taxonomy/${id}`, { label, actorId })).json(),
    onSuccess: () => {
      setRenameId(null);
      refresh();
      toast({ title: `Renamed` });
    },
    onError: (e: Error) =>
      toast({
        title: "Cannot rename",
        description: e.message.replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, ""),
        variant: "destructive",
      }),
  });

  const chosen = rows.filter((r) => selected.includes(r.id));
  const newLabel = chosen.map((r) => r.label).join("-");
  const totalItems = chosen.reduce((n, r) => n + r.itemCount, 0);

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardContent className="min-w-0 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <Label className="text-sm font-medium">{plural} to enable</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Only the ticked {plural.toLowerCase()} appear as tap buttons anywhere in the app.
            </p>
          </div>
          <Badge variant="secondary" data-testid={`badge-${kind}-enabled-count`}>
            {rows.filter((r) => r.isEnabled).length}/{rows.length} on
          </Badge>
        </div>

        <div className="max-h-[420px] min-w-0 space-y-0.5 overflow-y-auto pr-1">
          {rows.map((r) => (
            <div
              key={r.id}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover-elevate"
              data-testid={`row-${kind}-${slug(r.label)}`}
            >
              <Checkbox
                aria-label={`Select ${r.label} for merging`}
                data-testid={`checkbox-select-${kind}-${slug(r.label)}`}
                checked={selected.includes(r.id)}
                onCheckedChange={(v) =>
                  setSelected((s) => (v ? [...s, r.id] : s.filter((x) => x !== r.id)))
                }
              />
              <span className="min-w-0 flex-1 truncate text-sm" data-testid={`text-${kind}-label-${slug(r.label)}`}>
                {r.label}
                {r.isCustom && (
                  <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    custom
                  </span>
                )}
              </span>
              <span
                className="text-xs tabular-nums text-muted-foreground"
                data-testid={`text-${kind}-count-${slug(r.label)}`}
              >
                {r.itemCount}
              </span>
              {renameId === r.id ? (
                <Input
                  className="h-7 w-28 px-1.5 text-xs"
                  value={renameVal}
                  data-testid={`input-rename-${kind}-${slug(r.label)}`}
                  autoFocus
                  onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && renameVal.trim()) {
                      renameMut.mutate({ id: r.id, label: renameVal.trim() });
                    }
                    if (e.key === "Escape") setRenameId(null);
                  }}
                  onBlur={() => {
                    if (renameVal.trim() && renameVal.trim() !== r.label) {
                      renameMut.mutate({ id: r.id, label: renameVal.trim() });
                    } else {
                      setRenameId(null);
                    }
                  }}
                />
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  data-testid={`button-rename-${kind}-${slug(r.label)}`}
                  title={`Rename ${r.label}`}
                  onClick={() => {
                    setRenameId(r.id);
                    setRenameVal(r.label);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
              <Switch
                aria-label={`Enable ${r.label}`}
                data-testid={`switch-enable-${kind}-${slug(r.label)}`}
                checked={r.isEnabled}
                disabled={toggleEnabled.isPending}
                onCheckedChange={(v) => toggleEnabled.mutate({ id: r.id, isEnabled: v })}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    data-testid={`button-delete-${kind}-${slug(r.label)}`}
                    title={`Delete ${r.label}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete “{r.label}”?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This removes “{r.label}” from the {plural.toLowerCase()} list.
                      {r.itemCount > 0
                        ? ` ${r.itemCount} item${r.itemCount === 1 ? "" : "s"} still use it — move or merge them first.`
                        : " No items use it, so it is safe to delete."}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      data-testid={`button-confirm-delete-${kind}-${slug(r.label)}`}
                      disabled={r.itemCount > 0 || del.isPending}
                      onClick={() => del.mutate(r.id)}
                    >
                      {del.isPending ? "Deleting…" : "Delete"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Input
            className="min-w-[160px] flex-1"
            placeholder={`Add custom ${noun}…`}
            value={custom}
            data-testid={`input-add-${kind}`}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && custom.trim()) addCustom.mutate(custom.trim());
            }}
          />
          <Button
            size="sm"
            variant="outline"
            data-testid={`button-add-${kind}`}
            disabled={!custom.trim() || addCustom.isPending}
            onClick={() => addCustom.mutate(custom.trim())}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Add
          </Button>
          <Button
            size="sm"
            data-testid={`button-merge-${kind}`}
            disabled={selected.length < 2}
            onClick={() => setConfirmOpen(true)}
          >
            <Merge className="mr-1.5 h-4 w-4" />
            Merge selected ({selected.length})
          </Button>
        </div>

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-serif">Merge {plural.toLowerCase()}?</DialogTitle>
              <DialogDescription data-testid={`text-merge-summary-${kind}`}>
                Merge {chosen.map((r) => `${r.label} (${r.itemCount})`).join(" + ")} → new label “
                {newLabel}” ({totalItems} item{totalItems === 1 ? "" : "s"}). This cannot be undone.
                Continue?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} data-testid={`button-cancel-merge-${kind}`}>
                Cancel
              </Button>
              <Button
                size="sm"
                data-testid={`button-confirm-merge-${kind}`}
                disabled={merge.isPending}
                onClick={() => merge.mutate()}
              >
                {merge.isPending ? "Merging…" : "Merge"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/**
 * States plainly whether the signed-in captain also drafts, because that single
 * fact decides how much of everyone else's ranking they are allowed to see.
 */
function RoleCard() {
  const { me, isCaptain, isPureCaptain, isCaptainHeir } = useCaptainRole();
  if (!isCaptain && me) return null;
  return (
    <Card data-testid="card-your-role">
      <CardContent className="space-y-2 p-4">
        <Label className="text-sm font-medium">Your role in this session</Label>
        <div className="flex items-center gap-2">
          <Badge variant={isCaptainHeir ? "outline" : "secondary"} data-testid="badge-your-role">
            {isCaptainHeir ? "Captain (heir)" : "Captain (helping run the session — does not receive items)"}
          </Badge>
          {me && <span className="text-xs text-muted-foreground">{me.name}</span>}
        </div>
        {isCaptainHeir ? (
          <p
            className="max-w-2xl rounded-md border border-[#c9a227]/60 bg-[#fdf3d0]/60 px-3 py-2 text-xs text-[#5a4409] dark:bg-[#3a3007]/60 dark:text-[#f4e2a1]"
            data-testid="text-role-explainer"
          >
            Because you are also an heir, individual heir rankings are hidden from you and CSV
            export is disabled. Aggregated stats are still visible so you can see contested items.
          </p>
        ) : (
          <p className="max-w-2xl text-xs text-muted-foreground" data-testid="text-role-explainer">
            {isPureCaptain
              ? "You are the captain but do not receive items, so you can see every heir's ranking and export the full matrix."
              : "Sign in as yourself to see how much of the ranking data you are entitled to."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * v12 — The Captain's passphrase.
 *
 * Setting up an estate never required email: the welcome screen signs the first
 * captain straight in. The gap was coming BACK — on a phone, or after the
 * cookie expired, the only door left was an emailed link. This card closes that
 * without weakening anything: heirs still sign in by emailed link only, and a
 * passphrase can only be set from inside an already-signed-in captain
 * session, so it cannot be used to take over an estate from outside.
 */
/** apiRequest() throws `"<status>: <raw body>"`; pull out the human sentence inside. */
function friendlyMessage(e: Error): string {
  const withoutStatus = e.message.replace(/^\d+:\s*/, "");
  try {
    const parsed = JSON.parse(withoutStatus);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON — fall through */
  }
  return withoutStatus;
}

function CaptainPassphraseCard() {
  const { isCaptain } = useCaptainRole();
  const { toast } = useToast();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  const state = useQuery<{ isSet: boolean; setAt: number | null; changedAt: number | null }>({
    queryKey: ["/api/auth/captain-passphrase"],
    enabled: isCaptain,
  });

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", "/api/auth/captain-passphrase", { passphrase });
      return (await res.json()) as { created: boolean; message: string };
    },
    onSuccess: async (data) => {
      setPassphrase("");
      setConfirm("");
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/captain-passphrase"] });
      toast({ title: data.message });
    },
    onError: (e: Error) =>
      toast({ title: "Could not save that passphrase", description: friendlyMessage(e), variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/auth/captain-passphrase", undefined);
      return (await res.json()) as { removed: boolean; message: string };
    },
    onSuccess: async (data) => {
      setConfirmingRemoval(false);
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/captain-passphrase"] });
      toast({ title: data.message });
    },
  });

  if (!isCaptain) return null;

  const isSet = state.data?.isSet ?? false;
  const tooShort = passphrase.trim().length > 0 && passphrase.trim().length < CAPTAIN_PASSPHRASE_MIN_LENGTH;
  const mismatch = confirm.length > 0 && passphrase.trim() !== confirm.trim();
  const canSave =
    passphrase.trim().length >= CAPTAIN_PASSPHRASE_MIN_LENGTH && !mismatch && confirm.length > 0 && !save.isPending;

  return (
    <Card data-testid="card-captain-passphrase">
      <CardContent className="space-y-4 p-4">
        <div className="space-y-1">
          <Label className="text-sm font-medium">Signing in on another device</Label>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {isSet
              ? "You have a passphrase set. You can use it to sign in on your phone or another computer without waiting for an email."
              : CAPTAIN_PASSPHRASE_INVITATION}
          </p>
          {isSet && (
            <p className="text-xs text-muted-foreground" data-testid="text-passphrase-when">
              {state.data?.changedAt
                ? `Last changed ${new Date(state.data.changedAt).toLocaleDateString()}.`
                : state.data?.setAt
                  ? `Set ${new Date(state.data.setAt).toLocaleDateString()}.`
                  : ""}
            </p>
          )}
        </div>

        {!editing ? (
          <div className="flex flex-wrap gap-3">
            <Button
              variant={isSet ? "outline" : "default"}
              className="h-12 text-base"
              data-testid="button-edit-passphrase"
              onClick={() => setEditing(true)}
            >
              {isSet ? "Change my passphrase" : "Set a passphrase"}
            </Button>
            {isSet && !confirmingRemoval && (
              <Button
                variant="ghost"
                className="h-12 text-base"
                data-testid="button-remove-passphrase"
                onClick={() => setConfirmingRemoval(true)}
              >
                Remove it
              </Button>
            )}
          </div>
        ) : (
          <div className="max-w-md space-y-4">
            <div className="space-y-2">
              <Label htmlFor="captain-passphrase" className="text-sm font-medium">
                New passphrase
              </Label>
              <Input
                id="captain-passphrase"
                type="password"
                autoComplete="new-password"
                className="h-12 text-base"
                value={passphrase}
                data-testid="input-new-passphrase"
                onChange={(e) => setPassphrase(e.target.value)}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">{CAPTAIN_PASSPHRASE_HELP}</p>
              {tooShort && (
                <p className="text-xs text-destructive" data-testid="text-passphrase-too-short">
                  That is {passphrase.trim().length} characters. Please use at least{" "}
                  {CAPTAIN_PASSPHRASE_MIN_LENGTH}.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="captain-passphrase-confirm" className="text-sm font-medium">
                Type it again
              </Label>
              <Input
                id="captain-passphrase-confirm"
                type="password"
                autoComplete="new-password"
                className="h-12 text-base"
                value={confirm}
                data-testid="input-confirm-passphrase"
                onChange={(e) => setConfirm(e.target.value)}
              />
              {mismatch && (
                <p className="text-xs text-destructive" data-testid="text-passphrase-mismatch">
                  These two do not match yet.
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                className="h-12 text-base"
                disabled={!canSave}
                data-testid="button-save-passphrase"
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : "Save passphrase"}
              </Button>
              <Button
                variant="ghost"
                className="h-12 text-base"
                data-testid="button-cancel-passphrase"
                onClick={() => {
                  setEditing(false);
                  setPassphrase("");
                  setConfirm("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {confirmingRemoval && (
          <div
            className="max-w-2xl space-y-3 rounded-md border border-[#c9a227]/60 bg-[#fdf3d0]/60 px-4 py-3 dark:bg-[#3a3007]/60"
            data-testid="panel-confirm-remove-passphrase"
          >
            <p className="text-sm leading-relaxed text-[#5a4409] dark:text-[#f4e2a1]">
              Remove your passphrase? After this, signing in on a new device will need a link
              emailed to you. Anyone already signed in stays signed in.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="destructive"
                className="h-12 text-base"
                disabled={remove.isPending}
                data-testid="button-confirm-remove-passphrase"
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? "Removing…" : "Yes, remove it"}
              </Button>
              <Button
                variant="ghost"
                className="h-12 text-base"
                data-testid="button-cancel-remove-passphrase"
                onClick={() => setConfirmingRemoval(false)}
              >
                Keep it
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * v8.2i — The Training walkthrough card is the first thing a new captain sees when
 * they open Administration. It frames the training arc so captains learn the flow
 * with sample data before touching the real estate.
 */
function TrainingWalkthroughCard() {
  return (
    <Card
      className="mb-6 border-primary/40 bg-primary/[0.03]"
      data-testid="card-training-walkthrough"
    >
      <CardContent className="p-5 md:p-6">
        <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-primary">
          <FlaskConical className="h-4 w-4" />
          Highly recommended before you begin
        </div>
        <h2 className="font-serif text-xl font-semibold md:text-2xl">
          Train yourself and the family first
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground md:text-base">
          The best way to make the real distribution go smoothly is to rehearse
          it once with sample data. The Practice tab spins up a full lifecycle
          on eight sample items so you can walk every screen — registration,
          inventory, ranking, the draft, results — without any real awards.
          When you end practice, the sample data is wiped and the real estate
          starts clean.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div
            className="rounded-md border border-border/70 bg-background p-4"
            data-testid="card-training-step-1"
          >
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Step 1
            </div>
            <div className="mt-1 font-serif text-base font-semibold">
              Solo demo
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Start a practice round on your own. Use the Swap user button on
              the top bar to jump between sample heirs and see every screen
              they will see. Do this first, alone, before inviting anyone.
            </p>
          </div>
          <div
            className="rounded-md border border-border/70 bg-background p-4"
            data-testid="card-training-step-2"
          >
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Step 2
            </div>
            <div className="mt-1 font-serif text-base font-semibold">
              Family rehearsal
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              After the solo demo, invite the real heirs into another practice
              round. Fake items, real flow. Everyone gets a full run-through
              before the real distribution begins.
            </p>
          </div>
          <div
            className="rounded-md border border-border/70 bg-background p-4"
            data-testid="card-training-step-3"
          >
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Step 3
            </div>
            <div className="mt-1 font-serif text-base font-semibold">
              Start the real estate
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              End practice, wipe the sample data, and begin the real
              distribution with confidence. Everyone will already know exactly
              how the process works.
            </p>
          </div>
        </div>
        <div className="mt-5">
          <Button
            size="sm"
            data-testid="button-open-training"
            onClick={() => {
              const trigger = document.querySelector<HTMLElement>(
                '[data-testid="tab-practice"]',
              );
              trigger?.click();
              trigger?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            <FlaskConical className="mr-1.5 h-4 w-4" />
            Open the Practice tab
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminPage() {
  const { data, isLoading } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const { data: taxonomy } = useTaxonomy();
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [heirCountChoice, setHeirCountChoice] = useState<number | null>(null);
  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !!me?.isAdmin;
  const rosterOpen = registrationOpen(data?.session.phase ?? "welcome");
  const practiceMode = data?.session.practiceMode ?? "off";
  const perms = parseHeirPermissions(data?.session.heirPermissions);

  const patchSession = useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      (await apiRequest("PATCH", "/api/session", { ...patch, actorId: userId })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Session updated" });
    },
  });

  const setHeirsCanCategorize = useMutation({
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
  });

  const reset = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/session/reset", { actorId: userId })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      queryClient.invalidateQueries({ queryKey: TAXONOMY_KEY });
      toast({ title: "Session reset", description: "All data has been cleared." });
    },
  });

  const startPractice = useMutation({
    mutationFn: async (v: { mode: "sample_items"; heirCount: number }) =>
      (
        await apiRequest("POST", "/api/practice/start", {
          mode: v.mode,
          heirCount: v.heirCount,
          actorId: userId,
        })
      ).json(),
    onSuccess: () => {
      setPracticeOpen(false);
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Practice round started", description: "Nothing here touches real data." });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not start practice",
        description: e.message.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      }),
  });

  const endPractice = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/practice/end", { actorId: userId })).json(),
    onSuccess: () => {
      setSummaryOpen(false);
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      queryClient.invalidateQueries({ queryKey: TAXONOMY_KEY });
      queryClient.removeQueries({ queryKey: PRACTICE_RESULTS_KEY });
      setHeirCountChoice(null);
      toast({ title: "Practice ended", description: "Practice data discarded; real data intact." });
    },
  });

  const results = useQuery<PracticeResults>({
    queryKey: PRACTICE_RESULTS_KEY,
    enabled: summaryOpen && practiceMode !== "off",
    staleTime: 0,
    gcTime: 0,
  });

  // Default the practice headcount to the real participating heirs (2–8).
  const realHeirCount = (data?.participants ?? []).filter((p) => !p.administersOnly).length;
  const heirCount = heirCountChoice ?? Math.max(2, Math.min(8, realHeirCount || 2));
  const setHeirCount = setHeirCountChoice;

  const rooms = (taxonomy ?? []).filter((t) => t.kind === "room");
  const categories = (taxonomy ?? []).filter((t) => t.kind === "category");

  return (
    <AppShell>
      <PageHeader
        title="Administration"
        subtitle="Controls reserved for the captain."
      />
      {!isLoading && isCaptain && practiceMode === "off" && <TrainingWalkthroughCard />}
      {isLoading ? (
        <LoadingRows rows={3} />
      ) : !isCaptain ? (
        <Card className="p-10 text-center" data-testid="text-admin-locked">
          <p className="font-serif text-lg">Reserved for the captain</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in as the captain from the Sign-in page to reach these controls.
          </p>
        </Card>
      ) : (
        <Tabs defaultValue={rosterOpen ? "registration" : "session"}>
          <TabsList className="h-auto flex-wrap justify-start" data-testid="tabs-admin">
            <TabsTrigger value="registration" data-testid="tab-registration">
              {rosterOpen ? "Registration" : "Roster"}
            </TabsTrigger>
            <TabsTrigger value="session" data-testid="tab-session">
              Session
            </TabsTrigger>
            <TabsTrigger value="taxonomy" data-testid="tab-taxonomy">
              Rooms &amp; Categories
            </TabsTrigger>
            <TabsTrigger value="practice" data-testid="tab-practice">
              Practice
            </TabsTrigger>
          </TabsList>

          {/* ---------------- Registration / Roster ---------------- */}
          <TabsContent value="registration" className="mt-4 space-y-4">
            <RegistrationPanel />
            {!rosterOpen && <TransferCaptainPanel />}
          </TabsContent>

          {/* ---------------- Session ---------------- */}
          <TabsContent value="session" className="mt-4 space-y-4">
            <SessionLifecycleCard />
            <TrusteeHandoffCard />
            <ReconciliationAdminBanner />
            <RoleCard />
            <CaptainPassphraseCard />
            <CatalogingStatusCard />
            <RecordOfDecisionsCard />
            <AutoDraftCard />
            <ClassificationActivityCard />
            <CategorizationCard />
            <Card>
              <CardContent className="p-4">
                <Label className="text-sm font-medium">Heir permissions</Label>
                <p className="mb-4 mt-1 max-w-2xl text-xs text-muted-foreground">
                  Each capability is granted separately and every one starts off. Anything not
                  listed here stays with the captain — merging labels, enabling rooms and categories,
                  resolving groupings, advancing the phase, running practice, and resetting the
                  session. Enforced on the server, not only in the interface.
                </p>
                <div className="divide-y divide-border rounded-md border border-border">
                  {HEIR_CAPABILITIES.map((cap) => (
                    <div
                      key={cap.key}
                      className="flex items-start justify-between gap-4 p-3"
                      data-testid={`row-permission-${cap.key}`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{cap.label}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{cap.help}</p>
                      </div>
                      <Switch
                        checked={!!perms[cap.key]}
                        data-testid={`switch-permission-${cap.key}`}
                        onCheckedChange={(v) =>
                          patchSession.mutate({ heirPermissions: { [cap.key]: v } })
                        }
                      />
                    </div>
                  ))}
                  {/* The ninth capability lives in its own column because it
                      starts on — see the Categorization card above. */}
                  <div
                    className="flex items-start justify-between gap-4 p-3"
                    data-testid={`row-permission-${HEIRS_CAN_CATEGORIZE_CAPABILITY.key}`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {HEIRS_CAN_CATEGORIZE_CAPABILITY.label}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {HEIRS_CAN_CATEGORIZE_CAPABILITY.help}
                      </p>
                    </div>
                    <Switch
                      checked={!!data?.session.heirsCanCategorize}
                      data-testid={`switch-permission-${HEIRS_CAN_CATEGORIZE_CAPABILITY.key}`}
                      onCheckedChange={(v) => setHeirsCanCategorize.mutate(v)}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <RankingAdminCards />

            <Card>
              <CardContent className="p-4">
                <Label className="text-sm font-medium">Force phase</Label>
                <p className="mb-3 mt-1 text-xs text-muted-foreground">
                  Current phase:{" "}
                  <strong data-testid="text-admin-phase">
                    {phaseLabel(data?.session.phase ?? "")}
                  </strong>
                </p>
                <div className="flex flex-wrap gap-2">
                  {PHASES.map((p) => (
                    <Button
                      key={p}
                      size="sm"
                      variant={data?.session.phase === p ? "default" : "outline"}
                      data-testid={`button-phase-${p}`}
                      disabled={patchSession.isPending || practiceMode !== "off"}
                      onClick={() => patchSession.mutate({ phase: p })}
                    >
                      {phaseLabel(p)}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div>
                  <Label className="text-sm font-medium">Reset the session</Label>
                  <p className="mt-1 max-w-lg text-xs text-muted-foreground">
                    Deletes every participant, item, grouping, nomination, and pick, and re-seeds the
                    standard rooms and categories. This cannot be undone.
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm" data-testid="button-open-reset">
                      Reset everything
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="font-serif">Reset the session?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Every record in this session will be permanently removed.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel data-testid="button-cancel-reset">Cancel</AlertDialogCancel>
                      <AlertDialogAction data-testid="button-confirm-reset" onClick={() => reset.mutate()}>
                        {reset.isPending ? "Resetting…" : "Yes, reset"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------- Rooms & Categories ---------------- */}
          <TabsContent value="taxonomy" className="mt-4">
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              <TaxonomyPanel kind="room" rows={rooms} actorId={userId} />
              <TaxonomyPanel kind="category" rows={categories} actorId={userId} />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Merging joins the selected labels with a hyphen (for example “Closet-Miscellaneous”),
              reassigns every item, and removes the originals. A label still in an in-flight
              groupings round or draft cannot be merged.
            </p>
          </TabsContent>

          {/* ---------------- Practice ---------------- */}
          <TabsContent value="practice" className="mt-4 space-y-4">
            {practiceMode === "off" ? (
              <Card>
                <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
                  <div>
                    <Label className="text-sm font-medium">Start a practice round</Label>
                    <p className="mt-1 max-w-xl text-xs text-muted-foreground">
                      A throwaway rehearsal of the draft. Picks, contested-loss counters and
                      priority rotation are kept in a separate practice state and discarded when you
                      end it — the real ledger is never touched.
                    </p>
                  </div>
                  <div className="text-right">
                    <Button
                      size="sm"
                      data-testid="button-open-practice"
                      onClick={() => setPracticeOpen(true)}
                    >
                      <FlaskConical className="mr-1.5 h-4 w-4" />
                      Start practice
                    </Button>
                    <p
                      className="mt-1.5 max-w-[16rem] text-[11px] text-muted-foreground"
                      data-testid="text-practice-start-subtitle"
                    >
                      Rehearse the draft without touching real awards or counters.
                    </p>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-[#c9a227]">
                <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
                  <div>
                    <Label className="text-sm font-medium" data-testid="text-practice-status">
                      Practice round running — sample items
                    </Label>
                    <p className="mt-1 max-w-xl text-xs text-muted-foreground">
                      Groupings and high-value nomination are disabled while practising. When you
                      end practice you will see a results summary first — nothing is discarded until
                      you confirm.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="destructive"
                    data-testid="button-end-practice"
                    onClick={() => setSummaryOpen(true)}
                  >
                    End practice
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* ---- mode picker ---- */}
            <Dialog open={practiceOpen} onOpenChange={setPracticeOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle className="font-serif">Practice mode</DialogTitle>
                  <DialogDescription data-testid="text-practice-modal-copy">
                    Practice mode is a throwaway rehearsal. No items will actually be awarded, no
                    contested-loss counters or priority order will change, and everything is wiped
                    when you end practice. Use it so heirs can learn the mechanics before the real
                    draft.
                  </DialogDescription>
                </DialogHeader>

                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                    Number of heirs in this practice
                  </Label>
                  <div className="mt-2 flex flex-wrap gap-1.5" data-testid="group-practice-heir-count">
                    {PRACTICE_HEIR_COUNT_OPTIONS.map((n) => (
                      <Button
                        key={n}
                        type="button"
                        size="sm"
                        variant={n === heirCount ? "default" : "outline"}
                        className="w-9 px-0"
                        data-testid={`button-practice-heirs-${n}`}
                        onClick={() => setHeirCount(n)}
                      >
                        {n}
                      </Button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    You can practice with a smaller or larger family than your real setup.
                    {heirCount > realHeirCount
                      ? ` ${heirCount - realHeirCount} placeholder heir(s) will be added (Practice Heir A, B…).`
                      : heirCount < realHeirCount
                        ? ` Only the first ${heirCount} real heirs take part; the rest are hidden until practice ends.`
                        : ""}
                  </p>
                </div>

                {/*
                  One button, because there is one right answer.
                  A rehearsal over the real estate would show heirs the actual
                  pocket watch going to a sibling and then throw the result away,
                  so the practice round always runs on ten pretend things.
                */}
                <div className="grid gap-3">
                  <button
                    type="button"
                    className="rounded-md border border-border p-3 text-left hover-elevate"
                    data-testid="button-practice-sample"
                    disabled={startPractice.isPending}
                    onClick={() => startPractice.mutate({ mode: "sample_items", heirCount })}
                  >
                    <div className="text-sm font-medium">Start the practice round</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Ten pretend items, made up for this rehearsal only. Nothing from the estate
                      takes part, so nobody sees a real heirloom go to anyone.
                    </div>
                  </button>
                </div>
              </DialogContent>
            </Dialog>

            {/* ---- practice results summary ---- */}
            <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
              <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
                <DialogHeader className="shrink-0">
                  <DialogTitle className="font-serif" data-testid="text-practice-summary-title">
                    Practice results
                  </DialogTitle>
                  <DialogDescription data-testid="text-practice-summary-header">
                    These results are for review only. Nothing has been awarded. Discuss with the
                    family, then run the real draft when ready.
                  </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                {results.isLoading ? (
                  <LoadingRows rows={3} />
                ) : (results.data?.awards.length ?? 0) === 0 ? (
                  <Card className="p-6 text-center" data-testid="text-practice-summary-empty">
                    <p className="font-serif text-base">No picks were resolved in this practice run</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Nothing to review — the rehearsal ended before any reveal resolved an item.
                    </p>
                  </Card>
                ) : (
                  <div className="space-y-5">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm" data-testid="table-practice-awards">
                        <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                          <tr>
                            <th className="py-1.5 pr-3 font-medium">Item</th>
                            <th className="py-1.5 pr-3 font-medium">Would-be owner</th>
                            <th className="py-1.5 pr-3 font-medium">Round</th>
                            <th className="py-1.5 font-medium">Contested</th>
                          </tr>
                        </thead>
                        <tbody>
                          {results.data?.awards.map((a) => (
                            <tr
                              key={`${a.itemId}-${a.round}`}
                              className="border-t border-border align-top"
                              data-testid={`row-practice-award-${a.itemId}`}
                            >
                              <td className="py-2 pr-3">
                                <div className="font-medium" data-testid={`text-practice-award-item-${a.itemId}`}>
                                  {a.itemName}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {[a.room, a.category].filter(Boolean).join(" · ") || "—"}
                                </div>
                              </td>
                              <td className="py-2 pr-3" data-testid={`text-practice-award-owner-${a.itemId}`}>
                                {a.participantName}
                              </td>
                              <td className="py-2 pr-3" data-testid={`text-practice-award-round-${a.itemId}`}>
                                {a.round}
                              </td>
                              <td className="py-2">
                                {a.wasContested ? (
                                  <div>
                                    <Badge variant="destructive" data-testid={`status-practice-award-contested-${a.itemId}`}>
                                      Contested
                                    </Badge>
                                    <div
                                      className="mt-1 text-xs text-muted-foreground"
                                      data-testid={`text-practice-award-losers-${a.itemId}`}
                                    >
                                      Lost: {a.losingParticipantNames.join(", ")}
                                    </div>
                                  </div>
                                ) : (
                                  <Badge variant="secondary" data-testid={`status-practice-award-contested-${a.itemId}`}>
                                    Uncontested
                                  </Badge>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Card>
                        <CardContent className="p-4">
                          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                            Ending contested-loss counters (practice only)
                          </Label>
                          <div className="mt-2 space-y-1.5">
                            {results.data?.counters.map((c) => (
                              <div
                                key={c.participantId}
                                className="flex items-center justify-between text-sm"
                                data-testid={`row-practice-counter-${c.participantId}`}
                              >
                                <span>
                                  {c.name}
                                  {c.isPlaceholder && (
                                    <Badge variant="outline" className="ml-1.5 text-[10px]">
                                      placeholder
                                    </Badge>
                                  )}
                                </span>
                                <span className="text-muted-foreground">
                                  <Badge variant="outline" data-testid={`text-practice-counter-${c.participantId}`}>
                                    {c.practiceContestedLosses}
                                  </Badge>
                                  <span className="ml-2 text-xs">
                                    real: {c.realContestedLossCounter}
                                  </span>
                                </span>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="p-4">
                          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                            Ending priority order
                          </Label>
                          <ol className="mt-2 space-y-1 text-sm" data-testid="list-practice-priority">
                            {results.data?.priorityOrder.map((p, idx) => (
                              <li key={p.participantId} data-testid={`row-practice-priority-${idx}`}>
                                P{idx + 1} · {p.name}
                              </li>
                            ))}
                          </ol>
                          <p className="mt-2 text-xs text-muted-foreground">
                            Practice round reached: {results.data?.currentRound}
                          </p>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                )}
                </div>

                <DialogFooter className="shrink-0 gap-2 border-t pt-4 sm:justify-between">
                  {(results.data?.awards.length ?? 0) > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="button-download-practice-csv"
                      onClick={() =>
                        downloadPracticeCsv().catch((e: Error) =>
                          toast({
                            title: "Download failed",
                            description: e.message,
                            variant: "destructive",
                          }),
                        )
                      }
                    >
                      <Download className="mr-1.5 h-4 w-4" />
                      Download practice results (CSV)
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    size="sm"
                    data-testid="button-confirm-end-practice"
                    disabled={endPractice.isPending}
                    onClick={() => endPractice.mutate()}
                  >
                    {endPractice.isPending
                      ? "Ending…"
                      : (results.data?.awards.length ?? 0) > 0
                        ? "End practice and discard"
                        : "End practice"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </TabsContent>
        </Tabs>
      )}
    </AppShell>
  );
}
