import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { STATE_KEY, useAppState, useUser, type CaptainTransferRow } from "@/lib/app";
import {
  CLOSE_REGISTRATION_WARNING,
  ROSTER_CLOSED_MESSAGE,
  registrationOpen,
} from "@shared/schema";
import type { Participant } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { Lock, Pencil, Plus, Trash2, UserCog } from "lucide-react";

const clean = (m: string) =>
  m.replace(/^\d+:\s*/, "").replace(/^\{"message":"/, "").replace(/"\}$/, "");

export const CAPTAIN_TRANSFERS_KEY = ["/api/captain-transfers"];

/* ------------------------------------------------------------------ */
/* Registration — add, rename, and remove heirs while the roster is open */
/* ------------------------------------------------------------------ */
function HeirRow({
  heir,
  actorId,
  editable,
}: {
  heir: Participant;
  actorId: number | null;
  editable: boolean;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(heir.name);
  const [email, setEmail] = useState(heir.email ?? "");
  const [phone, setPhone] = useState(heir.phone ?? "");

  const refresh = () => queryClient.invalidateQueries({ queryKey: STATE_KEY });

  const save = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("PATCH", `/api/participants/${heir.id}`, {
          actorId,
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
        })
      ).json(),
    onSuccess: () => {
      setEditing(false);
      refresh();
      toast({ title: "Saved" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not save", description: clean(e.message), variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () =>
      (await apiRequest("DELETE", `/api/participants/${heir.id}?participantId=${actorId}`)).json(),
    onSuccess: () => {
      refresh();
      toast({ title: `${heir.name} removed` });
    },
    onError: (e: Error) =>
      toast({ title: "Could not remove", description: clean(e.message), variant: "destructive" }),
  });

  return (
    <div
      className="flex flex-col gap-3 p-3 md:flex-row md:items-center"
      data-testid={`row-heir-${heir.id}`}
    >
      {editing ? (
        <div className="grid flex-1 gap-2 md:grid-cols-3">
          <Input
            value={name}
            data-testid={`input-heir-name-${heir.id}`}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
          />
          <Input
            value={email}
            data-testid={`input-heir-email-${heir.id}`}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email (optional)"
          />
          <Input
            value={phone}
            data-testid={`input-heir-phone-${heir.id}`}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone (optional)"
          />
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <p className="font-serif text-base" data-testid={`text-heir-name-${heir.id}`}>
            {heir.name}
            {heir.isAdmin && (
              <Badge variant="outline" className="ml-2 align-middle">
                Captain
              </Badge>
            )}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {[heir.email, heir.phone].filter(Boolean).join(" · ") || "No contact details"}
          </p>
        </div>
      )}
      <div className="flex shrink-0 gap-2">
        {editing ? (
          <>
            <Button
              size="sm"
              disabled={!name.trim() || save.isPending}
              data-testid={`button-save-heir-${heir.id}`}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`button-cancel-heir-${heir.id}`}
              onClick={() => {
                setEditing(false);
                setName(heir.name);
                setEmail(heir.email ?? "");
                setPhone(heir.phone ?? "");
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!editable}
              data-testid={`button-edit-heir-${heir.id}`}
              onClick={() => setEditing(true)}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!editable || heir.isAdmin || remove.isPending}
              data-testid={`button-remove-heir-${heir.id}`}
              onClick={() => remove.mutate()}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Remove
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function RegistrationPanel() {
  const { data } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const session = data?.session;
  const open = registrationOpen(session?.phase ?? "welcome");
  const roster = (data?.participants ?? []).slice().sort((a, b) => a.seatOrder - b.seatOrder);
  const heirs = roster.filter((p) => !p.isAdmin);
  const captainHeir = roster.find((p) => p.isAdmin && !p.administersOnly) ?? null;
  const drafters = roster.filter((p) => !p.administersOnly).length;

  const refresh = () => queryClient.invalidateQueries({ queryKey: STATE_KEY });

  const add = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/participants", {
          actorId: userId,
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
        })
      ).json(),
    onSuccess: () => {
      setName("");
      setEmail("");
      setPhone("");
      setError(null);
      refresh();
    },
    onError: (e: Error) => {
      setError(clean(e.message));
      toast({ title: "Could not add", description: clean(e.message), variant: "destructive" });
    },
  });

  const close = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/session/close-registration", { actorId: userId })).json(),
    onSuccess: () => {
      setConfirmOpen(false);
      setError(null);
      refresh();
      toast({ title: "Registration closed", description: "Cataloging is now open." });
    },
    onError: (e: Error) => {
      setConfirmOpen(false);
      setError(clean(e.message));
      toast({ title: "Could not close", description: clean(e.message), variant: "destructive" });
    },
  });

  const closedOn = session?.registrationClosedAt
    ? new Date(session.registrationClosedAt).toLocaleDateString(undefined, { dateStyle: "long" })
    : null;

  return (
    <div className="space-y-4" data-testid="panel-registration">
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">
                {open ? "Register the heirs" : `Roster (closed on ${closedOn ?? "—"})`}
              </Label>
              <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                {open
                  ? "Add everyone who will take part in the draft. Names can be changed or removed freely until you close registration."
                  : "Everyone who will take part in the draft, as registered."}
              </p>
            </div>
            <Badge variant="outline" data-testid="badge-drafter-count">
              {drafters} draft participant{drafters === 1 ? "" : "s"}
            </Badge>
          </div>

          {!open && (
            <p
              className="mt-3 flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm"
              data-testid="text-roster-closed"
            >
              <Lock className="h-4 w-4 shrink-0" />
              {ROSTER_CLOSED_MESSAGE}
            </p>
          )}

          {open && (
            <div className="mt-4 grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
              <Input
                value={name}
                placeholder="Heir name"
                data-testid="input-new-heir-name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim()) add.mutate();
                }}
              />
              <Input
                value={email}
                placeholder="Email (optional)"
                data-testid="input-new-heir-email"
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                value={phone}
                placeholder="Phone (optional)"
                data-testid="input-new-heir-phone"
                onChange={(e) => setPhone(e.target.value)}
              />
              <Button
                disabled={!name.trim() || add.isPending}
                data-testid="button-add-heir"
                onClick={() => add.mutate()}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Add heir
              </Button>
            </div>
          )}

          <div className="mt-4 divide-y divide-border rounded-md border border-border">
            {captainHeir && (
              <div
                className="flex items-center gap-2 bg-muted/30 p-3 text-sm"
                data-testid={`row-captain-heir-${captainHeir.id}`}
              >
                <UserCog className="h-4 w-4" />
                <span className="font-serif text-base">{captainHeir.name}</span>
                <Badge variant="outline">Captain (heir)</Badge>
                <span className="text-xs text-muted-foreground">
                  Counts as a draft participant.
                </span>
              </div>
            )}
            {heirs.length === 0 && !captainHeir ? (
              <p className="p-4 text-sm text-muted-foreground" data-testid="text-no-heirs-yet">
                No heirs registered yet.
              </p>
            ) : (
              heirs.map((h) => (
                <HeirRow key={h.id} heir={h} actorId={userId} editable={open} />
              ))
            )}
          </div>

          {error && (
            <p className="mt-3 text-sm text-destructive" data-testid="text-registration-error">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {open && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
            <div>
              <Label className="text-sm font-medium">Close registration</Label>
              <p className="mt-1 max-w-lg text-xs text-muted-foreground">
                Locks the roster and opens cataloging. At least two people must be taking part in
                the draft.
              </p>
            </div>
            <Button
              disabled={close.isPending}
              data-testid="button-close-registration"
              onClick={() => setConfirmOpen(true)}
            >
              {close.isPending ? "Closing…" : "Close registration"}
            </Button>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif">Close registration?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-close-registration-warning">
              {CLOSE_REGISTRATION_WARNING}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-close-registration">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-close-registration"
              onClick={(e) => {
                e.preventDefault();
                close.mutate();
              }}
            >
              Yes, close registration
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Transfer captain role                                                    */
/* ------------------------------------------------------------------ */
export function TransferCaptainPanel() {
  const { data } = useAppState();
  const { userId, setUserId } = useUser();
  const { toast } = useToast();
  const [targetHeirId, setTargetHeirId] = useState<string>("");
  const [reason, setReason] = useState("");
  const [confirmationName, setConfirmationName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const roster = data?.participants ?? [];
  const me = roster.find((p) => p.id === userId) ?? null;
  const currentCaptain = me?.isAdmin ? me : (roster.find((p) => p.isAdmin) ?? null);
  const heirs = roster.filter((p) => !p.isAdmin);

  const transfers = useQuery<CaptainTransferRow[]>({ queryKey: CAPTAIN_TRANSFERS_KEY });

  const submit = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/session/transfer-captain", {
          actorId: userId,
          mode: "to_existing_heir",
          targetHeirId: Number(targetHeirId),
          reason: reason.trim() || null,
          confirmationName,
        })
      ).json(),
    onSuccess: (r: { newCaptain: Participant }) => {
      setError(null);
      setConfirmationName("");
      setReason("");
      setTargetHeirId("");
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      queryClient.invalidateQueries({ queryKey: CAPTAIN_TRANSFERS_KEY });
      // The person at the keyboard just gave the role away — sign them out of it.
      setUserId(null);
      toast({
        title: "Captain role transferred",
        description: `${r.newCaptain.name} is now the captain.`,
      });
    },
    onError: (e: Error) => {
      setError(clean(e.message));
      toast({ title: "Transfer refused", description: clean(e.message), variant: "destructive" });
    },
  });

  const ready = confirmationName.trim().length > 0 && targetHeirId !== "";

  return (
    <Card data-testid="panel-transfer-captain">
      <CardContent className="space-y-4 p-4">
        <div>
          <Label className="text-sm font-medium">Transfer the captain role</Label>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            The roster is locked, but the captain can still change. Hand the
            role to another heir. If the person named by the will to handle the
            financial side should run the session instead, add them from
            Administration rather than transferring here.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="select-target-heir" className="text-xs">
            Choose which heir takes over
          </Label>
          <select
            id="select-target-heir"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="select-target-heir"
            value={targetHeirId}
            onChange={(e) => setTargetHeirId(e.target.value)}
          >
            <option value="">Choose an heir…</option>
            {heirs.map((h) => (
              <option key={h.id} value={String(h.id)}>
                {h.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="transfer-confirm" className="text-xs">
              Type “{currentCaptain?.name ?? "your name"}” to confirm the transfer.
            </Label>
            <Input
              id="transfer-confirm"
              value={confirmationName}
              placeholder={currentCaptain?.name ?? ""}
              data-testid="input-transfer-confirmation"
              onChange={(e) => setConfirmationName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="transfer-reason" className="text-xs">
              Reason (optional)
            </Label>
            <Input
              id="transfer-reason"
              value={reason}
              data-testid="input-transfer-reason"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <p className="text-sm text-destructive" data-testid="text-transfer-error">
            {error}
          </p>
        )}

        <Button
          disabled={!ready || submit.isPending}
          data-testid="button-transfer-captain"
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Transferring…" : "Transfer the captain role"}
        </Button>

        {(transfers.data?.length ?? 0) > 0 && (
          <div className="rounded-md border border-border" data-testid="list-captain-transfers">
            <p className="border-b border-border p-3 text-xs uppercase tracking-[0.14em] text-muted-foreground">
              Transfer history
            </p>
            {transfers.data!
              .slice()
              .sort((a, b) => b.transferredAt - a.transferredAt)
              .map((t) => (
                <p key={t.id} className="p-3 text-sm" data-testid={`row-captain-transfer-${t.id}`}>
                  {t.previousCaptainName} → {t.newCaptainName}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {new Date(t.transferredAt).toLocaleString()} ·{" "}
                    {t.previousCaptainDisposition === "became_heir"
                      ? "previous captain became an heir"
                      : "previous captain removed"}
                    {t.reason ? ` · ${t.reason}` : ""}
                  </span>
                </p>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
