import { useEffect, useState } from "react";
import { useAppState, useSessionState, useUser } from "@/lib/app";
import { formatRemaining } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { PauseCircle, ChevronDown } from "lucide-react";

function useLiveDuration(sinceMs: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sinceMs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sinceMs]);
  if (!sinceMs) return null;
  return formatRemaining(Math.max(0, now - sinceMs));
}

/**
 * Full-page overlay shown to heirs (non-captain participants) whenever the estate
 * is paused. The sidebar stays visible but visually deemphasized underneath —
 * nothing is actually unmounted, so no navigation state is lost — but this
 * overlay sits above the main content and blocks interaction with it.
 */
export function PausedBanner() {
  const { data } = useAppState();
  const { data: lifecycle } = useSessionState();
  const { userId } = useUser();
  const [reasonOpen, setReasonOpen] = useState(false);

  const state = lifecycle?.state ?? data?.session.state ?? "active";
  const pausedAt = lifecycle?.pausedAt ?? data?.session.pausedAt ?? null;
  // Hook must run unconditionally (Rules of Hooks) — feed it null when not
  // applicable so the interval never gets scheduled.
  const duration = useLiveDuration(state === "paused" ? pausedAt : null);

  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !me || !!me.isAdmin;
  if (!data || state !== "paused" || isCaptain) return null;

  const pausedByName =
    data.participants.find((p) => p.id === (lifecycle?.pausedBy ?? data.session.pausedBy))?.name ??
    "The captain";
  const reason = lifecycle?.pauseReason ?? data.session.pauseReason ?? null;

  return (
    <div
      className="fixed inset-0 z-40 flex min-h-screen flex-col items-center justify-center gap-4 bg-[#fdf3d0]/95 px-6 text-center backdrop-blur-sm dark:bg-[#3a3007]/95"
      data-testid="banner-estate-paused"
      role="status"
    >
      <PauseCircle className="h-10 w-10 text-[#5a4409] dark:text-[#f4e2a1]" />
      <h1 className="font-serif text-2xl font-semibold text-[#5a4409] dark:text-[#f4e2a1]" data-testid="text-paused-by">
        Paused by {pausedByName}
      </h1>
      {duration && (
        <p className="text-lg text-[#5a4409]/90 dark:text-[#f4e2a1]/90" data-testid="text-paused-duration-banner">
          Paused for {duration}
        </p>
      )}
      {reason && (
        <div className="max-w-md">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-[#5a4409] hover:bg-[#5a4409]/10 dark:text-[#f4e2a1]"
            data-testid="button-toggle-pause-reason"
            onClick={() => setReasonOpen((o) => !o)}
          >
            Why? <ChevronDown className={`h-3.5 w-3.5 transition-transform ${reasonOpen ? "rotate-180" : ""}`} />
          </Button>
          {reasonOpen && (
            <p className="mt-1 text-sm text-[#5a4409]/90 dark:text-[#f4e2a1]/90" data-testid="text-pause-reason-banner">
              {reason}
            </p>
          )}
        </div>
      )}
      <p className="max-w-sm text-sm text-[#5a4409]/80 dark:text-[#f4e2a1]/80">
        You'll get a notification when {pausedByName} resumes.
      </p>
    </div>
  );
}

/** Small persistent strip shown to the captain on every page while paused. */
export function CaptainPauseStrip({ onResume }: { onResume: () => void }) {
  const { data } = useAppState();
  const { data: lifecycle } = useSessionState();
  const { userId } = useUser();

  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !me || !!me.isAdmin;
  const state = lifecycle?.state ?? data?.session.state ?? "active";
  if (!data || state !== "paused" || !isCaptain) return null;

  return (
    <div
      className="no-print flex items-center justify-center gap-2 border-b border-[#c9a227]/50 bg-[#fdf3d0] px-4 py-2 text-center text-sm font-medium text-[#5a4409] dark:bg-[#3a3007] dark:text-[#f4e2a1]"
      data-testid="banner-captain-pause-strip"
      role="status"
    >
      <PauseCircle className="h-4 w-4" />
      <span>Estate is paused.</span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 border-[#c9a227]/60 bg-transparent px-2 text-xs text-[#5a4409] hover:bg-[#c9a227]/10 dark:text-[#f4e2a1]"
        data-testid="button-resume-strip"
        onClick={onResume}
      >
        Resume
      </Button>
    </div>
  );
}
