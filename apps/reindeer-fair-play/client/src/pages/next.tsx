import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { useAppState, useGuidedSteps, useUser, phaseLabel } from "@/lib/app";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check, Circle, Lock } from "lucide-react";

/**
 * The heir's home. One clear next action, with the whole path visible above it
 * so nobody has to guess what the process expects of them.
 */
export default function NextStepPage() {
  const { data, isLoading } = useAppState();
  const { userId } = useUser();
  const [, navigate] = useLocation();
  const { steps, next } = useGuidedSteps();
  const me = data?.participants.find((p) => p.id === userId) ?? null;

  useEffect(() => {
    if (!isLoading && data && userId === null) navigate("/");
    // A pure administrator has no guided sequence — send them to their desk.
    if (me?.administersOnly) navigate("/administration");
  }, [isLoading, data, userId, me, navigate]);

  return (
    <AppShell>
      <PageHeader
        title={me ? `Welcome, ${me.name}` : "Your next step"}
        subtitle="Work through these in order. Nothing you choose is visible to the others until a round is revealed."
        actions={
          data ? (
            <Badge variant="outline" data-testid="status-guided-phase">
              {phaseLabel(data.session.phase)}
            </Badge>
          ) : undefined
        }
      />

      {isLoading && <LoadingRows rows={3} />}

      {!isLoading && next && (
        <Card className="mb-6 border-primary p-6" data-testid="card-next-step">
          <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
            Your next step
          </div>
          <h2 className="mt-2 font-serif text-xl font-semibold" data-testid="text-next-step-title">
            {next.title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{next.blurb}</p>
          <Button
            className="mt-4"
            data-testid="button-next-step"
            onClick={() => navigate(next.href)}
          >
            Continue
          </Button>
        </Card>
      )}

      {!isLoading && !next && steps.length > 0 && (
        <Card className="mb-6 p-6" data-testid="card-next-step-waiting">
          <h2 className="font-serif text-xl font-semibold">You are up to date</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything asked of you so far is done. The next step will appear here when the
            captain opens it.
          </p>
        </Card>
      )}

      <ol className="space-y-2" data-testid="list-guided-steps">
        {steps.map((s, i) => (
          <li key={s.key}>
            <Card
              className={`flex items-center gap-3 p-4 ${s.available ? "" : "opacity-55"}`}
              data-testid={`step-${s.key}`}
              data-done={s.done ? "true" : "false"}
              data-available={s.available ? "true" : "false"}
            >
              <span className="text-muted-foreground">
                {s.done ? (
                  <Check className="h-4 w-4 text-primary" />
                ) : s.available ? (
                  <Circle className="h-4 w-4" />
                ) : (
                  <Lock className="h-4 w-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {i + 1}. {s.title}
                </span>
                <span className="block text-xs text-muted-foreground">{s.blurb}</span>
              </span>
              {s.available && (
                <Link
                  href={s.href}
                  data-testid={`link-step-${s.key}`}
                  className="shrink-0 text-sm text-primary underline-offset-4 hover:underline"
                >
                  {s.done ? "Review" : "Open"}
                </Link>
              )}
            </Card>
          </li>
        ))}
      </ol>
    </AppShell>
  );
}
