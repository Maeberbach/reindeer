import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { STATE_KEY, useAppState, useUser } from "@/lib/app";
import { Logo } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import type { Participant, Session } from "@shared/schema";

/**
 * A quiet frame for the two first-launch screens. No sidebar, no phase badge —
 * nothing to navigate to until the heir running the session has told us their name.
 */
export function FirstRunFrame({
  children,
  step,
}: {
  children: React.ReactNode;
  step: 1 | 2;
}) {
  return (
    <div className="min-h-screen bg-background px-4 py-12 text-foreground md:py-20">
      <div className="mx-auto w-full max-w-lg">
        <div className="mb-8 flex items-center gap-3">
          <span className="text-primary">
            <Logo className="h-9 w-9" />
          </span>
          <div className="leading-tight">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Reindeer
            </div>
            <div className="font-serif text-base font-semibold">Reindeer: FairPlay</div>
          </div>
          <span
            className="ml-auto text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
            data-testid="text-firstrun-step"
          >
            Step {step} of 2
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function WelcomePage() {
  const [, navigate] = useLocation();
  const { setUserId } = useUser();
  const { toast } = useToast();
  const { data } = useAppState();
  const [name, setName] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/session/welcome", {
        captainName: name.trim(),
        // The heir running the session always drafts. The `administersOnly`
        // flag is kept on the wire for schema stability and defaults to
        // false — no admin-only role is exposed in the UI.
        administersOnly: false,
      });
      return (await res.json()) as { session: Session; participant: Participant };
    },
    onSuccess: (r) => {
      setUserId(r.participant.id);
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      navigate("/setup/estate-name");
    },
    onError: (e: Error) =>
      toast({
        title: "Could not continue",
        description: e.message.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      }),
  });

  const disabled = name.trim().length === 0 || submit.isPending;

  return (
    <FirstRunFrame step={1}>
      <h1
        className="font-serif text-2xl font-semibold md:text-3xl"
        data-testid="text-page-title"
      >
        Welcome. Start here.
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        FairPlay is a family process for dividing the personal property of
        an estate — the tangible things that were not specifically given to
        someone by the will or trust. The heirs run it together, with one of
        them acting as captain. The person named by the will or trust to handle
        the financial side usually sits outside the app; if they prefer, they
        can also step in as captain to run the session for the family.
      </p>

      <div className="mt-6 rounded-md border border-border bg-muted/40 p-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          What this app protects
        </div>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-foreground">
          <li>
            <span className="font-medium">The estate.</span> Items that might be
            valuable are set aside for appraisal, so nothing significant is
            quietly divided by mistake.
          </li>
          <li>
            <span className="font-medium">The heirs.</span> Everyone agrees
            to a fair process before knowing who gets what — and there is a
            written record every heir has signed.
          </li>
          <li>
            <span className="font-medium">The family record.</span> Everything the
            family decides is written down in a single document they can print
            and sign — so there is no confusion later about who agreed to what.
          </li>
        </ul>
      </div>

      <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
        Start by telling us your name. You are the heir who is setting this
        up for your family — you will add the other heirs on the next screens.
      </p>

      <Card className="mt-6">
        <CardContent className="space-y-6 p-5">
          <div className="space-y-2">
            <Label htmlFor="captain-name" className="text-sm font-medium">
              Your name
            </Label>
            <Input
              id="captain-name"
              autoFocus
              value={name}
              placeholder="e.g. Pat"
              data-testid="input-captain-name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !disabled) submit.mutate();
              }}
            />
          </div>

          <Button
            className="w-full"
            disabled={disabled}
            data-testid="button-welcome-continue"
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "Setting up…" : "Continue"}
          </Button>
        </CardContent>
      </Card>

      {data && data.participants.length > 0 && (
        <p className="mt-4 text-xs text-muted-foreground" data-testid="text-welcome-existing">
          This estate is already set up.
        </p>
      )}
    </FirstRunFrame>
  );
}
