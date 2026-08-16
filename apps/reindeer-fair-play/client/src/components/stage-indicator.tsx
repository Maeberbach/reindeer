import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, CircleDot, Lock } from "lucide-react";
import type { StageProgress, StageLine } from "@shared/schema";
import { useAppState } from "@/lib/app";

/**
 * Which round is being divided right now.
 *
 * The contested categories — jewelry, photographs, heirlooms — run as their own
 * rounds so an heir who cares about jewelry is not made to spend picks against
 * garden tools. That design is invisible unless the screen says so, and an heir
 * who does not know a jewelry round is coming will rank badly in the round they
 * are in. So this strip names the open round, what is already done, and what is
 * still ahead, in the order it will happen.
 *
 * It reads /api/stages, which is the same shape the captain's dashboard
 * reads, so the two screens can never disagree about what is happening.
 */

/** Phases where "which round are we in" is a live question. */
const DIVIDING_PHASES = new Set([
  "ranking",
  "groupings",
  "draft",
  "secondary_ranking",
  "secondary_draft",
]);

export function StageIndicator() {
  const { data: state } = useAppState();
  const phase = state?.session.phase ?? "welcome";
  const dividing = DIVIDING_PHASES.has(phase);

  const { data } = useQuery<StageProgress>({
    queryKey: ["/api/stages"],
    enabled: dividing,
    refetchInterval: 30_000,
  });

  if (!dividing || !data) return null;
  // A practice round has its own banner already; two strips stacked is noise.
  if (state?.session.practiceMode !== "off") return null;
  // No stages switched on means one pool. The headline would only restate the
  // obvious, so say nothing rather than add furniture to the screen.
  if (!data.usingStages) return null;

  const done = data.finished;
  const ahead = [...data.waiting, ...(data.general.remaining > 0 ? [data.general] : [])];

  return (
    <section
      className="no-print border-b border-border bg-muted/60 px-4 py-3 md:px-8"
      aria-label="Which round is being divided now"
      data-testid="strip-stage-indicator"
    >
      <p
        className="text-base font-semibold leading-snug text-foreground md:text-lg"
        data-testid="text-stage-headline"
      >
        {data.headline}
      </p>

      {data.open && data.open.heldBack > 0 && (
        <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span data-testid="text-stage-held-back">
            {data.open.heldBack === 1
              ? "One thing in this round is set aside as high value and is not being chosen yet."
              : `${data.open.heldBack} things in this round are set aside as high value and are not being chosen yet.`}
          </span>
        </p>
      )}

      <ol
        className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5"
        data-testid="list-stage-order"
      >
        {done.map((s) => (
          <StageChip key={`d-${s.label}`} line={s} kind="done" />
        ))}
        {data.open && <StageChip line={data.open} kind="open" />}
        {ahead.map((s) => (
          <StageChip key={`a-${s.label}`} line={s} kind="ahead" />
        ))}
      </ol>
    </section>
  );
}

/**
 * One round in the running order.
 *
 * Never colour alone: each state carries its own icon and its own wording, so
 * the strip still reads correctly in black and white on a printed page or to
 * someone who cannot separate the two greens.
 */
function StageChip({ line, kind }: { line: StageLine; kind: "done" | "open" | "ahead" }) {
  const Icon = kind === "done" ? CheckCircle2 : kind === "open" ? CircleDot : Circle;
  const tone =
    kind === "done"
      ? "text-muted-foreground"
      : kind === "open"
        ? "font-semibold text-foreground"
        : "text-muted-foreground";
  const suffix =
    kind === "done"
      ? "finished"
      : kind === "open"
        ? `${line.remaining} to choose`
        : `${line.remaining} waiting`;

  return (
    <li
      className={`flex items-center gap-1.5 text-sm md:text-base ${tone}`}
      data-testid={`chip-stage-${kind}`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        {line.label} <span className="font-normal text-muted-foreground">— {suffix}</span>
      </span>
    </li>
  );
}
