import { useLocation } from "wouter";
import { estateTitle } from "@shared/schema";
import { useAppState, useUser, phaseLabel } from "@/lib/app";
import { AppShell, LoadingRows, Logo } from "@/components/shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const { data, isLoading } = useAppState();
  const { setUserId, userId } = useUser();
  const [, navigate] = useLocation();

  /** The captain always lands on their desk; everyone else on the guided sequence. */
  const landingFor = (p: { isAdmin: boolean }) => (p.isAdmin ? "/administration" : "/next");

  const heirs = (data?.participants ?? []).filter((p) => !p.administersOnly);
  const admins = (data?.participants ?? []).filter((p) => p.administersOnly);

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl text-center">
        <span className="mx-auto mb-5 inline-block text-primary">
          <Logo className="h-12 w-12" />
        </span>
        <h1 className="font-serif text-2xl font-semibold md:text-3xl" data-testid="text-page-title">
          {estateTitle(data?.session.estateName)}
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          A private record for dividing the tangible property of the estate, fairly and by rule.
          Tap your name to begin. Nothing you choose is visible to anyone else until the round is
          revealed.
        </p>
        {data && (
          <Badge variant="outline" className="mt-4" data-testid="status-session-phase">
            {phaseLabel(data.session.phase)}
            {data.session.currentRound > 0 ? ` · Round ${data.session.currentRound}` : ""}
          </Badge>
        )}
      </div>

      {!isLoading && data && (data.participants ?? []).length === 0 && (
        <div className="mx-auto mt-10 max-w-3xl">
          <Card className="p-6 md:p-8 border-primary/40 bg-primary/[0.03]">
            <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex-1">
                <h2 className="font-serif text-xl font-semibold" data-testid="text-firstrun-cta-title">
                  Set up this estate
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  No one is registered yet. Start by naming the captain — the heir who will run this session for the family. You can add heirs on the next screens.
                </p>
              </div>
              <Button
                size="lg"
                data-testid="button-start-setup"
                onClick={() => navigate("/welcome")}
              >
                Start setup
              </Button>
            </div>
          </Card>
        </div>
      )}

      <div className="mx-auto mt-10 max-w-3xl">
        {isLoading ? (
          <LoadingRows rows={3} />
        ) : (
          <>
            <h2 className="mb-3 text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Heirs
            </h2>
            {heirs.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="text-no-heirs">
                No heirs registered yet. The captain adds them on the
                Helping run the session page.
              </p>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {heirs.map((p) => (
                <Card
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  data-testid={`tile-heir-${p.id}`}
                  onClick={() => {
                    setUserId(p.id);
                    navigate(landingFor(p));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setUserId(p.id);
                      navigate(landingFor(p));
                    }
                  }}
                  className={`cursor-pointer p-5 text-left hover-elevate ${
                    userId === p.id ? "border-primary" : ""
                  }`}
                >
                  <div className="font-serif text-lg font-medium" data-testid={`text-heir-name-${p.id}`}>
                    {p.name}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span data-testid={`text-heir-losses-${p.id}`}>
                      Contested losses: {p.contestedLossCounter}
                    </span>
                    {p.isAdmin && <Badge variant="outline">Captain</Badge>}
                  </div>
                </Card>
              ))}
            </div>

            {admins.length > 0 && (
              <>
                <h2 className="mb-3 mt-8 text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Helping run the session
                </h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {admins.map((p) => (
                    <Card
                      key={p.id}
                      className="p-5"
                      data-testid={`tile-admin-${p.id}`}
                    >
                      <div className="font-serif text-lg font-medium">{p.name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Helps run the session — does not pick items
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-3"
                        data-testid={`button-signin-admin-${p.id}`}
                        onClick={() => {
                          setUserId(p.id);
                          navigate("/administration");
                        }}
                      >
                        Sign in to help
                      </Button>
                    </Card>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
