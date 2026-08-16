/*
 * Trustee handoff card — Session tab of Administration.
 *
 * A trustee can step in to run the session for the family. Under the
 * language collapse (heir · trustee · captain), the captain is the person
 * running the session; the trustee is a separate role and can wear
 * the captain hat while the heirs stand back.
 *
 * The captain cannot flip the trustee-mode switch on someone else's behalf —
 * that would be an impersonation hole. Only the trustee, signed in on their
 * own device, can take over. So this card serves two jobs:
 *
 *   1. If no trustee is in the roster yet, let the captain invite one by
 *      name and email. That writes the trustee row and lets the trustee sign
 *      in via the ordinary magic-link path.
 *   2. If a trustee is already in the roster but trustee-mode is off, show
 *      the captain plain instructions: the trustee signs in at /sign-in and
 *      then clicks "Take over" from the trustee banner. There is nothing
 *      the captain needs to do beyond letting the trustee know.
 *
 * When trustee-mode is on, this card renders nothing — the sticky
 * CaptainBanner at the top of the screen tells the whole story.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAppState, STATE_KEY } from "@/lib/app";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

function clean(msg: string) {
  return msg.replace(/^\d+:\s*/, "");
}

export function TrusteeHandoffCard() {
  const { data } = useAppState();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const trusteeParticipant = data?.participants.find((p) => p.role === "trustee") ?? null;
  // Trustee-in-charge is derived from the captain seat: no separate boolean.
  const trusteeInCharge =
    !!trusteeParticipant &&
    data?.session?.captainParticipantId === trusteeParticipant.id;

  const invite = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/session/trustee/invite", {
          name: name.trim(),
          email: email.trim(),
        })
      ).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({
        title: "Trustee invited",
        description:
          "They can now sign in from /sign-in on their own device. Once they take over, the sticky banner at the top of the screen will say so.",
      });
      setName("");
      setEmail("");
    },
    onError: (e: Error) =>
      toast({ title: "Could not invite trustee", description: clean(e.message), variant: "destructive" }),
  });

  // Trustee is already in the driver's seat — nothing to do here. The
  // CaptainBanner is already telling everyone what's happening.
  if (trusteeInCharge) return null;

  // No trustee on the roster — offer the invite form.
  if (!trusteeParticipant) {
    return (
      <Card data-testid="card-trustee-handoff-invite">
        <CardContent className="space-y-3 p-4">
          <div>
            <Label className="text-sm font-medium">Hand this session to a trustee (optional)</Label>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              If the trust or will names a trustee and you would rather they run the session
              for the family, add them here. They will get a sign-in link at the email you
              give and can take over from their own device. You can keep running the session
              yourself in the meantime — nothing changes until the trustee signs in and clicks
              "Take over".
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <Label htmlFor="trustee-invite-name" className="text-xs">
                Trustee's full name
              </Label>
              <Input
                id="trustee-invite-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Anne Smith"
                data-testid="input-trustee-invite-name"
              />
            </div>
            <div>
              <Label htmlFor="trustee-invite-email" className="text-xs">
                Their email address
              </Label>
              <Input
                id="trustee-invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="anne@example.com"
                data-testid="input-trustee-invite-email"
              />
            </div>
          </div>
          <Button
            disabled={!name.trim() || !email.trim() || invite.isPending}
            onClick={() => invite.mutate()}
            data-testid="button-invite-trustee"
          >
            {invite.isPending ? "Adding trustee…" : "Add trustee and send sign-in link"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // A trustee is on the roster, but trustee-mode is off. Show a plain
  // instruction — the captain can't flip the switch, the trustee has to.
  return (
    <Card data-testid="card-trustee-handoff-ready">
      <CardContent className="space-y-2 p-4">
        <Label className="text-sm font-medium">Hand this session to the trustee</Label>
        <p className="max-w-2xl text-xs text-muted-foreground" data-testid="text-trustee-handoff-instructions">
          <strong>{trusteeParticipant.name}</strong> is listed as the trustee on this estate.
          When they are ready to take over, ask them to sign in at{" "}
          <span className="font-mono">/sign-in</span> from their own device using the link that
          was emailed to them, then click "Take over" from the banner that appears at the top
          of the screen. You will still be able to see everything; only the responsibility for
          moving the session forward changes hands. The trustee can hand it back at any time.
        </p>
      </CardContent>
    </Card>
  );
}
