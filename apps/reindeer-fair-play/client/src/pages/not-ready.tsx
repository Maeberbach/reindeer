import { useAppState, useUser } from "@/lib/app";
import { Logo, SignOutControl } from "@/components/shell";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Shown to an heir who signs in before the Captain has
 * finished setting the estate up.
 *
 * Without this screen the heir was routed straight into the estate-naming
 * wizard — a form only the captain is allowed to submit. She would have
 * typed a name, pressed the button, and been refused by the server with no
 * idea why. Waiting is the honest answer, so say so plainly and let her leave.
 */
export default function NotReadyYetPage() {
  const { participant } = useUser();
  const { data } = useAppState();

  const captain = (data?.participants ?? []).find((p) => p.isAdmin) ?? null;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      <div className="mb-8 flex items-center gap-3">
        <Logo className="h-8 w-8" />
        <div className="leading-tight">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Legacy</div>
          <div className="font-serif text-lg font-semibold">Reindeer: FairPlay</div>
        </div>
      </div>

      <Card className="w-full max-w-xl">
        <CardContent className="space-y-5 p-7">
          <h1 className="font-serif text-2xl font-semibold" data-testid="text-page-title">
            You&apos;re signed in. Nothing to do just yet.
          </h1>

          <p className="text-base leading-relaxed text-muted-foreground">
            {participant ? `You're signed in as ${participant.name}. ` : ""}
            {captain
              ? `${captain.name} is still getting the estate ready. `
              : "The person organising the estate is still getting things ready. "}
            When it&apos;s your turn, you&apos;ll be told what to do next.
          </p>

          <p className="text-base leading-relaxed text-muted-foreground">
            You can close this page. Come back to it later using the same link or code, and it
            will remember you.
          </p>

          <div className="pt-1">
            <SignOutControl />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
