import { useAppState, useIsCaptain } from "@/lib/app";
import { normalizePhase, type Phase } from "@shared/schema";
import { CircleDot } from "lucide-react";

/**
 * v8.2i — the "What happens next" strip that lives at the bottom of every
 * user-facing page. Reads the current phase and role and shows the next 1-2
 * steps in the journey so users never have to guess what comes next.
 *
 * Copy is intentionally short and second-person. If the phase advances, this
 * strip updates without the user reloading.
 */

type Step = { label: string; done: boolean; current: boolean };

const HEIR_JOURNEY: Array<{ phase: Phase; label: string }> = [
  { phase: "welcome", label: "Sign in" },
  { phase: "registration", label: "Confirm your profile" },
  { phase: "intake", label: "Review the inventory" },
  { phase: "ranking", label: "Rank your items" },
  { phase: "draft", label: "The draft" },
  { phase: "complete", label: "Final results" },
];

const CAPTAIN_JOURNEY: Array<{ phase: Phase; label: string }> = [
  { phase: "welcome", label: "Welcome" },
  { phase: "estate_name", label: "Name the estate" },
  { phase: "registration", label: "Register heirs" },
  { phase: "intake", label: "Add inventory" },
  { phase: "ranking", label: "Heirs rank items" },
  { phase: "draft", label: "Run the draft" },
  { phase: "complete", label: "Publish results" },
];

function buildSteps(currentPhase: Phase, journey: typeof HEIR_JOURNEY): Step[] {
  const currentIdx = journey.findIndex((s) => s.phase === currentPhase);
  return journey.map((s, i) => ({
    label: s.label,
    done: currentIdx >= 0 && i < currentIdx,
    current: i === currentIdx,
  }));
}

export function NextStepFooter() {
  const { data } = useAppState();
  const isCaptain = useIsCaptain();
  const phase = normalizePhase(data?.session?.phase ?? "welcome");
  const journey = isCaptain ? CAPTAIN_JOURNEY : HEIR_JOURNEY;
  const steps = buildSteps(phase, journey);
  const currentIdx = steps.findIndex((s) => s.current);
  const upcoming = currentIdx >= 0 ? steps.slice(currentIdx, currentIdx + 3) : steps.slice(0, 3);

  return (
    <div
      className="mt-8 border-t border-border/60 pt-4 text-xs text-muted-foreground md:text-sm"
      data-testid="next-step-footer"
    >
      <div className="mb-2 font-medium uppercase tracking-wide text-foreground/70">
        Where you are in the process
      </div>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {upcoming.map((s, i) => (
          <li
            key={s.label}
            className={`flex items-center gap-1.5 ${
              s.current ? "font-semibold text-primary" : ""
            }`}
          >
            <CircleDot
              className={`h-3 w-3 ${
                s.current ? "text-primary" : s.done ? "text-muted-foreground/40" : "text-muted-foreground/60"
              }`}
              aria-hidden="true"
            />
            <span>{s.label}</span>
            {i < upcoming.length - 1 && <span className="text-muted-foreground/50">&rarr;</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
