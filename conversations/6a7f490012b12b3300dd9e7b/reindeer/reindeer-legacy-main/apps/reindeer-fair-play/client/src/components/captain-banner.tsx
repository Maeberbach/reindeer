import { useMutation } from "@tanstack/react-query";
import { Scale, ArrowLeftRight } from "lucide-react";
import { useAppState, useUser, STATE_KEY } from "@/lib/app";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

/**
 * Persistent header strip shown when the current captain is anyone OTHER
 * than the heir-admin who ran welcome. Silent in the default state
 * (heir-admin is captain), because there is nothing worth telling anyone.
 *
 * Right now the only non-heir-admin captain is the trustee (after
 * /api/session/trustee/take-over). A later commit will add captain
 * transfer among heirs; when that lands, this banner will also handle
 * "another heir is running the session." Its structure is already generic
 * enough to accommodate that.
 *
 * The button to end the trustee's tenure ("Hand back to the heirs") is
 * only shown to the seated trustee — heirs cannot rescind the trustee's
 * authority from inside the app. The trustee is named by the owner in
 * the will or trust; their authority comes from that document, not from
 * anything the app can grant or take back.
 */
export function CaptainBanner() {
  const { data } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();

  const handBack = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/session/trustee/hand-back", {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({
        title: "Handed back to the heirs",
        description: "The heirs are running the session again.",
      });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not hand back",
        description: e.message.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      }),
  });

  if (!data) return null;
  const captainId = data.session.captainParticipantId;
  if (captainId == null) return null;

  const captain = data.participants.find((p) => p.id === captainId);
  if (!captain) return null;

  // Silent when the heir-admin is running things — that is the default,
  // and there is nothing to say.
  const heirAdmin = data.participants.find((p) => p.isAdmin && p.role === "heir");
  if (heirAdmin && captain.id === heirAdmin.id) return null;

  const iAmTheCaptain = userId === captain.id;
  const captainIsTrustee = captain.role === "trustee";
  const captainName = captain.name;

  const headline = captainIsTrustee
    ? iAmTheCaptain
      ? "You are running this session as the trustee."
      : `${captainName} is running this session as the trustee.`
    : iAmTheCaptain
      ? "You are running this session as captain."
      : `${captainName} is running this session as captain.`;

  const subline = captainIsTrustee
    ? "The trustee runs the phases and resolves disputes. They receive no items."
    : "The captain runs the phases and resolves disputes.";

  return (
    <div
      className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-700 dark:bg-amber-950/60"
      data-testid="banner-captain"
      role="status"
    >
      <div className="flex items-center gap-2.5 text-amber-900 dark:text-amber-100">
        <Scale className="h-5 w-5 shrink-0" aria-hidden />
        <div>
          <div className="font-medium leading-tight">{headline}</div>
          <div className="text-xs text-amber-800/80 dark:text-amber-200/80">
            {subline}
          </div>
        </div>
      </div>

      {iAmTheCaptain && captainIsTrustee && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (
              window.confirm(
                "Hand this session back to the heirs? They will run the phases from here.",
              )
            ) {
              handBack.mutate();
            }
          }}
          disabled={handBack.isPending}
          data-testid="button-trustee-hand-back"
          className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-50"
        >
          <ArrowLeftRight className="mr-1.5 h-4 w-4" aria-hidden />
          {handBack.isPending ? "Handing back…" : "Hand back to the heirs"}
        </Button>
      )}
    </div>
  );
}
