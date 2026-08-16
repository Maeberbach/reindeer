import { useQuery } from "@tanstack/react-query";
import { Check, HandHelping, Loader2, ShieldCheck, UserCircle2 } from "lucide-react";
import { useLocation } from "wouter";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useMutation } from "@tanstack/react-query";
import { useAppState, useUser, STATE_KEY } from "@/lib/app";
import { useToast } from "@/hooks/use-toast";

type AuditEntry = {
  id: string;
  itemName: string;
  oldRank: number | null;
  newRank: number | null;
  editedAt: number;
  editedByName: string;
  mode: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loose phone: any 10+ digits after stripping non-digits.
function digitsOnly(v: string): string {
  return (v ?? "").replace(/\D+/g, "");
}
function isValidPhone(v: string): boolean {
  return digitsOnly(v).length >= 10;
}
function isValidEmail(v: string): boolean {
  return EMAIL_RE.test(v.trim());
}

/**
 * Personal settings for whoever is signed in. Consent to captain assistance lives
 * here because it is the heir's decision alone to make or revoke.
 */
export default function ProfilePage() {
  const { data, isLoading } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const [, navigate] = useLocation();

  // Local editable copy of the three contact fields.
  const [name, setName] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [phone, setPhone] = useState<string>("");
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (me) {
      setName(me.name ?? "");
      setEmail(me.email ?? "");
      setPhone(me.phone ?? "");
    }
  }, [me?.id, me?.name, me?.email, me?.phone]);

  const nameOk = name.trim().length >= 1;
  const emailOk = isValidEmail(email);
  const phoneOk = isValidPhone(phone);
  const allOk = nameOk && emailOk && phoneOk;

  const nameError = attempted && !nameOk ? "Enter your full name." : null;
  const emailError = attempted && !emailOk ? "Enter a valid email address." : null;
  const phoneError = attempted && !phoneOk ? "Enter a phone with at least 10 digits." : null;

  const confirm = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("PATCH", `/api/participants/${userId}`, {
          participantId: userId,
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          profileConfirmedAt: Date.now(),
        })
      ).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Profile confirmed", description: "On to the next step." });
      navigate("/next");
    },
    onError: (e: any) =>
      toast({
        title: "Could not save",
        description: String(e?.message ?? e),
        variant: "destructive",
      }),
  });

  const audit = useQuery<{ entries: AuditEntry[] }>({
    queryKey: ["/api/rankings/audit", userId],
    enabled: userId !== null,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/rankings/${userId}/audit?participantId=${userId}`);
      return res.json();
    },
  });

  const setConsent = useMutation({
    mutationFn: async (allowsCaptainAssist: boolean) =>
      (
        await apiRequest("PATCH", `/api/participants/${userId}`, {
          participantId: userId,
          allowsCaptainAssist,
        })
      ).json(),
    onSuccess: (_r, allowsCaptainAssist) => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({
        title: allowsCaptainAssist ? "Captain assistance allowed" : "Captain assistance turned off",
        description: allowsCaptainAssist
          ? "The captain can now open and adjust your ranking. Every edit is logged."
          : "Only you can change your ranking from now on.",
      });
    },
    onError: (e: any) =>
      toast({ title: "Could not save", description: String(e?.message ?? e), variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <AppShell>
        <PageHeader title="Your profile" subtitle="Loading your settings…" />
        <LoadingRows />
      </AppShell>
    );
  }

  if (!me) {
    return (
      <AppShell>
        <PageHeader title="Your profile" subtitle="Sign in to manage your settings." />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Choose who you are on the Sign in page first.
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const assistEdits = (audit.data?.entries ?? []).filter((e) => e.mode === "assist");
  const isConfirmed = !!me.profileConfirmedAt;

  const handleConfirm = () => {
    setAttempted(true);
    if (!allOk) {
      toast({
        title: "Fill every field",
        description: "Name, email, and phone are all required before you continue.",
        variant: "destructive",
      });
      return;
    }
    confirm.mutate();
  };

  return (
    <AppShell>
      <PageHeader title="Your profile" subtitle={`Personal settings for ${me.name}.`} />

      {!me.administersOnly && (
        <Card className="mb-4" data-testid="card-confirm-profile">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <UserCircle2 className="h-4 w-4" />
              {isConfirmed ? "Profile confirmed" : "Confirm your contact details"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              These details go on the final distribution record. All three fields are required.
            </p>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <Label htmlFor="profile-name" className="text-xs uppercase tracking-wide">
                  Full name
                </Label>
                <Input
                  id="profile-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isConfirmed || confirm.isPending}
                  placeholder="e.g. Pat Rivera"
                  data-testid="input-profile-name"
                  aria-invalid={!!nameError}
                  className="mt-1"
                />
                {nameError && (
                  <p className="mt-1 text-xs text-destructive" data-testid="error-profile-name">
                    {nameError}
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="profile-email" className="text-xs uppercase tracking-wide">
                  Email
                </Label>
                <Input
                  id="profile-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isConfirmed || confirm.isPending}
                  placeholder="you@example.com"
                  data-testid="input-profile-email"
                  aria-invalid={!!emailError}
                  className="mt-1"
                />
                {emailError && (
                  <p className="mt-1 text-xs text-destructive" data-testid="error-profile-email">
                    {emailError}
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="profile-phone" className="text-xs uppercase tracking-wide">
                  Phone
                </Label>
                <Input
                  id="profile-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={isConfirmed || confirm.isPending}
                  placeholder="(555) 123-4567"
                  data-testid="input-profile-phone"
                  aria-invalid={!!phoneError}
                  className="mt-1"
                />
                {phoneError && (
                  <p className="mt-1 text-xs text-destructive" data-testid="error-profile-phone">
                    {phoneError}
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p className="text-xs text-muted-foreground">
                {isConfirmed
                  ? `Confirmed ${new Date(me.profileConfirmedAt!).toLocaleString()}.`
                  : "Confirming moves you on to review inventory."}
              </p>
              {isConfirmed ? (
                <Badge variant="secondary" data-testid="badge-profile-confirmed">
                  <Check className="mr-1 h-3 w-3" /> Confirmed
                </Badge>
              ) : (
                <Button
                  size="lg"
                  data-testid="button-confirm-profile"
                  disabled={confirm.isPending || (attempted && !allOk)}
                  onClick={handleConfirm}
                >
                  {confirm.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    "Confirm and continue"
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <HandHelping className="h-4 w-4" /> Help with ranking
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-start justify-between gap-4">
          <Label htmlFor="switch-allow-captain-assist" className="text-sm font-normal leading-relaxed">
            Allow the captain to assist me with ranking. When on, the captain can open and adjust your ranking. Every
            edit is logged and shown to you.
          </Label>
          <Switch
            id="switch-allow-captain-assist"
            checked={!!me.allowsCaptainAssist}
            onCheckedChange={(v) => setConsent.mutate(v)}
            disabled={setConsent.isPending}
            data-testid="switch-allow-captain-assist"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" /> Edits made on your behalf
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm" data-testid="list-profile-audit">
          {assistEdits.length === 0 ? (
            <p className="text-muted-foreground">
              Nobody has changed your ranking for you. Only your own edits are on record.
            </p>
          ) : (
            assistEdits.map((e) => (
              <div
                key={e.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 py-1.5 last:border-0"
                data-testid={`row-profile-audit-${e.id}`}
              >
                <span className="truncate">
                  <span className="font-medium">{e.itemName}</span>{" "}
                  <span className="text-muted-foreground">
                    {e.oldRank ?? "unranked"} → {e.newRank ?? "removed"}
                  </span>
                </span>
                <Badge variant="outline">
                  {e.editedByName} · {new Date(e.editedAt).toLocaleString()}
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
