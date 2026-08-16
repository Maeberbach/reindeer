import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { STATE_KEY, useAppState, useUser } from "@/lib/app";
import { FirstRunFrame } from "@/pages/welcome";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";

export default function EstateNamePage() {
  const { data } = useAppState();
  const { participant } = useUser();
  const { toast } = useToast();
  const [name, setName] = useState(data?.session.estateName ?? "");
  const [trustee, setTrustee] = useState(data?.session.trusteeName ?? "");
  const [trusteeWillRun, setTrusteeWillRun] = useState(false);
  const [trusteeEmail, setTrusteeEmail] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/session/estate-name", {
        estateName: name.trim(),
        trusteeName: trustee.trim(),
      });
      const session = await res.json();
      // If the family said the trustee will run this session, seat the
      // trustee now. This creates their participant row (role='trustee',
      // administersOnly=true) and lets the captain send them a magic link next.
      if (trusteeWillRun && trustee.trim() && trusteeEmail.trim()) {
        await apiRequest("POST", "/api/session/trustee/invite", {
          name: trustee.trim(),
          email: trusteeEmail.trim(),
        });
      }
      return session;
    },
    onSuccess: () => {
      // PhaseGuard forwards to Administration once the phase moves on.
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not save",
        description: e.message.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      }),
  });

  const disabled =
    name.trim().length === 0 ||
    submit.isPending ||
    (trusteeWillRun && (trustee.trim().length === 0 || trusteeEmail.trim().length === 0));

  return (
    <FirstRunFrame step={2}>
      <h1
        className="font-serif text-2xl font-semibold md:text-3xl"
        data-testid="text-page-title"
      >
        Name this estate
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Whatever the family calls it. This name heads every screen and every export.
        {participant ? ` Signed in as ${participant.name}.` : ""}
      </p>

      <Card className="mt-8">
        <CardContent className="space-y-6 p-5">
          <div className="space-y-2">
            <Label htmlFor="estate-name" className="text-sm font-medium">
              Estate name
            </Label>
            <Input
              id="estate-name"
              autoFocus
              value={name}
              placeholder="e.g. Eberbach Estate"
              data-testid="input-estate-name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !disabled) submit.mutate();
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="trustee-name" className="text-sm font-medium">
              Trustee’s name{" "}
              <span className="text-xs font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Input
              id="trustee-name"
              value={trustee}
              placeholder="e.g. Wells Fargo Trust, or Jane Smith"
              data-testid="input-trustee-name"
              onChange={(e) => setTrustee(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !disabled) submit.mutate();
              }}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              The person named by the will or trust to handle the financial side.
              Their name goes on the final document. Normally they don’t
              log in here — you can leave this blank and add it later.
            </p>
          </div>

          {trustee.trim().length > 0 && (
            <div className="rounded-lg border border-muted bg-muted/30 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="trustee-will-run"
                  checked={trusteeWillRun}
                  data-testid="checkbox-trustee-will-run"
                  onCheckedChange={(v) => setTrusteeWillRun(v === true)}
                  className="mt-0.5"
                />
                <div className="space-y-1">
                  <Label htmlFor="trustee-will-run" className="text-sm font-medium leading-none">
                    The trustee will be running this session
                  </Label>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Rare, but real. Check this only if that person has agreed to run the
                    family draft directly — usually because the heirs prefer someone
                    outside the family at the wheel. They manage the game; they
                    don’t receive items.
                  </p>
                </div>
              </div>
              {trusteeWillRun && (
                <div className="space-y-2 pl-8">
                  <Label htmlFor="trustee-email" className="text-sm font-medium">
                    Trustee’s email
                  </Label>
                  <Input
                    id="trustee-email"
                    type="email"
                    value={trusteeEmail}
                    placeholder="tiana@trustee-firm.com"
                    data-testid="input-trustee-email"
                    onChange={(e) => setTrusteeEmail(e.target.value)}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    We’ll send them a one-time link to sign in.
                  </p>
                </div>
              )}
            </div>
          )}

          <Button
            className="w-full"
            disabled={disabled}
            data-testid="button-estate-name-continue"
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? "Saving…" : "Continue to registration"}
          </Button>
        </CardContent>
      </Card>
    </FirstRunFrame>
  );
}
