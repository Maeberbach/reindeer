import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, queryClient as globalQueryClient } from "@/lib/queryClient";
import {
  parseHeirPermissions,
  isCaptainHeirParticipant,
  isPureCaptainParticipant,
  countdownTone,
  formatRemaining,
  windowPhaseOf,
  type HeirCapability,
  type RankingWindow,
} from "@shared/schema";
import type {
  Session,
  Participant,
  Item,
  Grouping,
  GroupingOptIn,
  AppraisalFlag,
  MethodAgreement,
  Pick as DraftPick,
  DuplicateGroup,
} from "@shared/schema";

/* ------------------------------------------------------------------ */
/* Theme (no localStorage — blocked in the sandboxed iframe)           */
/* ------------------------------------------------------------------ */
type ThemeCtx = { theme: "light" | "dark"; toggle: () => void };
const ThemeContext = createContext<ThemeCtx>({ theme: "light", toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  const value = useMemo(
    () => ({ theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }),
    [theme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);

/* ------------------------------------------------------------------ */
/* Real identity — resolved ONLY from GET /api/auth/me (session cookie) */
/* ------------------------------------------------------------------ */
/**
 * A gentle, plain-language reason the app is about to send someone back to
 * the sign-in screen. Never technical jargon — see the tone rules.
 */
export type SignOutReason = "ended" | null;

export const AUTH_ME_KEY = ["/api/auth/me"];

type MeResponse = { participant: Participant };

/**
 * Fetches the signed-in participant from the server. A 401 here just means
 * "nobody is signed in" — it is not thrown as an error, so this hook never
 * flashes an error state; callers look at `data` being null instead.
 */
function useMe() {
  return useQuery<Participant | null>({
    queryKey: AUTH_ME_KEY,
    queryFn: async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const body = (await res.json()) as MeResponse;
      return body.participant;
    },
    staleTime: 30_000,
    retry: false,
  });
}

type UserCtx = {
  /** The signed-in participant's id, or null while signed out. */
  userId: number | null;
  /** The signed-in participant, or null while signed out. */
  participant: Participant | null;
  /** True only while the very first GET /api/auth/me is in flight. */
  isLoadingAuth: boolean;
  /**
   * Deprecated no-op kept so existing call sites compile: identity can no
   * longer be declared by the client. Calling this simply asks the server
   * for the current signed-in participant again (useful right after a role
   * change such as a captain handing off their role).
   */
  setUserId: (id: number | null) => void;
  /** Re-check who is signed in (e.g. right after redeeming a link). */
  refreshMe: () => void;
  /** Gentle, non-technical reason the app is showing the sign-in screen, if any. */
  signOutReason: SignOutReason;
  /** Send the person to the sign-in screen with a plain-language reason. */
  requireSignIn: (reason: SignOutReason) => void;
  /** Clear a shown sign-out reason once it has been read. */
  clearSignOutReason: () => void;
};
const UserContext = createContext<UserCtx>({
  userId: null,
  participant: null,
  isLoadingAuth: true,
  setUserId: () => {},
  refreshMe: () => {},
  signOutReason: null,
  requireSignIn: () => {},
  clearSignOutReason: () => {},
});

export function UserProvider({ children }: { children: ReactNode }) {
  const meQuery = useMe();
  const qc = useQueryClient();
  const [signOutReason, setSignOutReason] = useState<SignOutReason>(null);

  const participant = meQuery.data ?? null;
  const userId = participant?.id ?? null;

  const refreshMe = () => {
    qc.invalidateQueries({ queryKey: AUTH_ME_KEY });
  };

  const requireSignIn = (reason: SignOutReason) => {
    setSignOutReason(reason);
    qc.setQueryData(AUTH_ME_KEY, null);
    window.location.hash = "#/sign-in";
  };

  const value = useMemo(
    () => ({
      userId,
      participant,
      isLoadingAuth: meQuery.isLoading,
      setUserId: () => refreshMe(),
      refreshMe,
      signOutReason,
      requireSignIn,
      clearSignOutReason: () => setSignOutReason(null),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, participant, meQuery.isLoading, signOutReason],
  );
  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}
export const useUser = () => useContext(UserContext);

/**
 * Registers a global 401 handler so ANY API call that comes back
 * unauthorized mid-session sends the person to sign-in with a gentle
 * message, instead of crashing or showing a blank page. Call once near the
 * app root.
 */
export function useGlobalSessionGuard() {
  const { requireSignIn } = useUser();
  useEffect(() => {
    const qc = globalQueryClient;
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const query = event.query;
      if (query.queryKey === AUTH_ME_KEY || (Array.isArray(query.queryKey) && query.queryKey[0] === "/api/auth/me")) {
        return;
      }
      const error = query.state.error as any;
      if (error && typeof error.message === "string" && error.message.startsWith("401")) {
        requireSignIn("ended");
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/* ------------------------------------------------------------------ */
/* Global app state                                                    */
/* ------------------------------------------------------------------ */
export type AppState = {
  session: Session;
  participants: Participant[];
  items: Item[];
  groupings: Grouping[];
  optIns: GroupingOptIn[];
  nominations: AppraisalFlag[];
  picks: DraftPick[];
  duplicateGroups: DuplicateGroup[];
  rankSummary: RankSummary;
  rankingWindow: RankingWindow;
  secondaryRankingWindow: RankingWindow;
  reconciliation: ReconciliationStatus;
  cataloging: CatalogingStatus;
  categorization: CategorizationStatus;
  bootstrapIncomplete: BootstrapStatus;
  serverNow: number;
};

/** v6 — how far the family has got with filing things into categories. */
export type CategorizationStatus = {
  total: number;
  categorized: number;
  uncategorized: number;
  needsDiscussion: number;
  heirsCanCategorize: boolean;
  aiMode: "mock" | "live";
  collaborators: { participantId: number | null; name: string; count: number }[];
};

export type ReconciliationStatus = {
  active: boolean;
  round: number | null;
  openedAt: number | null;
  responses: Record<string, "continue" | "pause">;
  nudgedAt: number | null;
  resolvedAt: number | null;
  outcome: "continue" | "pause" | null;
  streak: number;
  interval: number;
  paused: boolean;
  autoEnabled: boolean;
  nudgeMs: number;
  elapsedMs: number;
  pending: { participantId: number; name: string }[];
  responded: { participantId: number; name: string; choice: string }[];
  stalled: boolean;
};

export type CatalogingStatus = {
  total: number;
  complete: boolean;
  completedAt: number | null;
  heirsCanAddInventory: boolean;
  contributors: { participantId: number | null; name: string; count: number; isCaptain: boolean }[];
};

export type CaptainTransferRow = {
  id: string;
  sessionId: number;
  previousCaptainParticipantId: number;
  newCaptainParticipantId: number;
  transferredAt: number;
  previousCaptainDisposition: "became_heir" | "removed";
  reason: string | null;
  previousCaptainName: string;
  newCaptainName: string;
};

export type BootstrapStatus = {
  incomplete: boolean;
  participants: number;
  admins: number;
  reasons: string[];
};

export type RankSummary = {
  required: number;
  mode: string;
  totalAvailable: number;
  heirs: {
    participantId: number;
    name: string;
    ranked: number;
    shortfall: number;
    complete: boolean;
  }[];
  allComplete: boolean;
  underRanked: { participantId: number; name: string; shortfall: number }[];
};

export function useAppState() {
  // Several people work the same session at once, so the shared picture is
  // refreshed on a slow poll rather than only on mutation. /api/state
  // requires a signed-in session, so this only actually polls once someone
  // is signed in — otherwise it would just be a steady stream of sign-ins-
  // required responses.
  const { userId, isLoadingAuth } = useUser();
  const enabled = !isLoadingAuth && userId !== null;
  return useQuery<AppState>({
    queryKey: ["/api/state"],
    refetchInterval: enabled ? 5000 : false,
    staleTime: 2000,
    enabled,
  });
}

export const STATE_KEY = ["/api/state"];

/**
 * The one call the client is allowed to make before anyone is signed in:
 * whether the estate has been set up yet at all. `GET /api/session` is
 * reachable without a session ONLY while no Captain exists
 * yet; it starts refusing (401) the moment one does. That refusal itself is
 * the signal this hook exists to read — used only to choose between the
 * welcome/bootstrap screen and the sign-in screen.
 */
export function useEstateExists() {
  return useQuery<boolean>({
    queryKey: ["/api/session", "estate-exists-check"],
    queryFn: async () => {
      const res = await fetch("/api/session", { credentials: "include" });
      if (res.status === 401) return true; // a captain already exists
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return false; // reachable pre-bootstrap: no captain yet
    },
    retry: false,
    staleTime: 10_000,
  });
}

/* ------------------------------------------------------------------ */
/* v7a — session lifecycle (pause / resume)                           */
/* ------------------------------------------------------------------ */
export type SessionStateChangeView = {
  id: string;
  sessionId: number;
  fromState: string;
  toState: string;
  changedByParticipantId: number | null;
  changedAt: number;
  reason: string | null;
  metadata: string | null;
};

export type SessionLifecycleView = {
  state: "active" | "paused" | "archived";
  pausedAt: number | null;
  pausedBy: number | null;
  pauseReason: string | null;
  pauseCount: number;
  totalPausedMs: number;
  stateChanges: SessionStateChangeView[];
};

export const SESSION_LIFECYCLE_KEY = ["/api/session/lifecycle/state"];

/**
 * The app already polls `/api/state` every 5s and that payload carries the
 * session's lifecycle columns, so this hook does not need its own network
 * round trip on that cadence — it piggybacks on `useAppState()` for the
 * lightweight fields and polls the richer `/api/session/lifecycle/state`
 * endpoint (which also returns the audit history) on a slower 30s cadence,
 * per spec.
 */
export function useSessionState() {
  return useQuery<SessionLifecycleView>({
    queryKey: SESSION_LIFECYCLE_KEY,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function heirsOf(participants: Participant[]) {
  return participants.filter((p) => !p.administersOnly);
}

export function phaseLabel(phase: string) {
  return (
    {
      welcome: "Welcome",
      estate_name: "Estate name",
      registration: "Registration",
      setup: "Registration",
      intake: "Cataloging",
      ranking: "Ranking",
      groupings: "Groupings Round",
      draft: "Draft",
      secondary_ranking: "Secondary Ranking",
      secondary_draft: "Secondary Draft",
      complete: "Complete",
    }[phase] ?? phase
  );
}

/* ------------------------------------------------------------------ */
/* Ranking phase helpers                                               */
/* ------------------------------------------------------------------ */

/** Phases in which heirs may open and edit the Ranking page. */
export const RANKING_PAGE_PHASES = [
  "ranking",
  "groupings",
  "draft",
  "secondary_ranking",
  "secondary_draft",
];

/** The deadline window that applies right now, or null outside ranking phases. */
export function activeWindowOf(state?: AppState | null): RankingWindow | null {
  if (!state) return null;
  const wp = windowPhaseOf(state.session.phase);
  if (!wp) return null;
  return wp === "secondary_ranking" ? state.secondaryRankingWindow : state.rankingWindow;
}

/**
 * Live countdown that re-renders every minute. Returns null when there is no
 * deadline to count down to.
 */
export function useCountdown(deadline: number | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    // Flip to the closed state the moment the deadline passes rather than at
    // the next minute tick.
    const untilDeadline = deadline - Date.now();
    const at =
      untilDeadline > 0 && untilDeadline < 60_000
        ? setTimeout(() => setNow(Date.now()), untilDeadline + 250)
        : null;
    return () => {
      clearInterval(id);
      if (at) clearTimeout(at);
    };
  }, [deadline]);
  return useMemo(() => {
    if (!deadline) return null;
    const msRemaining = deadline - now;
    return {
      msRemaining,
      closed: msRemaining <= 0,
      tone: countdownTone(msRemaining),
      label: formatRemaining(msRemaining),
      deadlineText: new Date(deadline).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
      deadlineDate: new Date(deadline).toLocaleDateString(undefined, { dateStyle: "long" }),
    };
  }, [deadline, now]);
}

/* ------------------------------------------------------------------ */
/* captain-heir vs pure-captain                                                  */
/* ------------------------------------------------------------------ */
/**
 * Which kind of Captain the signed-in user is, if any.
 * A pure captain administers but does not draft, so they keep full oversight.
 * A captain-heir drafts too, so individual rankings are hidden from them.
 */
export function useCaptainRole() {
  const { data } = useAppState();
  const { userId } = useUser();
  const me = data?.participants.find((p) => p.id === userId) ?? null;
  return {
    me,
    isCaptain: !!me?.isAdmin,
    isPureCaptain: isPureCaptainParticipant(me),
    isCaptainHeir: isCaptainHeirParticipant(me),
  };
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */
export type AppNotificationView = {
  id: number;
  type: string;
  createdAt: number;
  readAt: number | null;
  payload: Record<string, any>;
};

export const NOTIFICATIONS_KEY = ["/api/notifications/mine"];

/** Poll the signed-in participant's notification feed. */
export function useNotifications(pollMs = 3000) {
  const { userId } = useUser();
  return useQuery<{ notifications: AppNotificationView[]; unread: number }>({
    queryKey: [...NOTIFICATIONS_KEY, userId],
    enabled: userId !== null,
    refetchInterval: userId === null ? false : pollMs,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/notifications/mine?participantId=${userId}`);
      return res.json();
    },
  });
}

/**
 * Fires `onNew` once for every notification id that has not been seen before.
 * The first load is treated as already-seen so a page refresh does not replay
 * the whole history as toasts.
 */
export function useNewNotifications(
  rows: AppNotificationView[] | undefined,
  onNew: (rows: AppNotificationView[]) => void,
) {
  const seen = useRef<Set<number> | null>(null);
  const handler = useRef(onNew);
  handler.current = onNew;
  useEffect(() => {
    if (!rows) return;
    if (seen.current === null) {
      seen.current = new Set(rows.map((r) => r.id));
      return;
    }
    const fresh = rows.filter((r) => !seen.current!.has(r.id));
    fresh.forEach((r) => seen.current!.add(r.id));
    if (fresh.length) handler.current(fresh);
  }, [rows]);
}

/* ------------------------------------------------------------------ */
/* Guided sequence (heirs)                                             */
/* ------------------------------------------------------------------ */
export type GuidedStep = {
  key: string;
  href: string;
  title: string;
  blurb: string;
  done: boolean;
  available: boolean;
};

/**
 * The ordered path an heir walks: profile, then inventory when the captain has
 * opened contributions, then ranking, then the draft itself.
 */
export function useGuidedSteps(): { steps: GuidedStep[]; next: GuidedStep | null } {
  const { data } = useAppState();
  const { userId } = useUser();
  const me = data?.participants.find((p) => p.id === userId) ?? null;
  // Heirs must sign the Method Agreement before ranking opens. We fetch the
  // list of agreements for the session so the guided sequence can show a
  // "Sign the Method Agreement" step that goes green the moment this heir
  // signs — no page reload required.
  const agreements = useQuery<MethodAgreement[]>({
    queryKey: ["/api/fiduciary/method-agreements"],
    enabled: userId !== null,
  });
  return useMemo(() => {
    if (!data || !me) return { steps: [], next: null };
    const phase = data.session.phase;
    const inventoryOpen = !!data.session.heirsCanAddInventory && phase === "intake";
    const mine = data.items.filter((i) => i.createdByParticipantId === me.id).length;
    const summary = data.rankSummary?.heirs?.find((h) => h.participantId === me.id);
    const rankingReached = RANKING_PAGE_PHASES.includes(phase);
    // The captain is not on the heir roster and does not need to sign as an heir.
    // The Method Agreement step only appears for heirs, and only while ranking
    // has not yet opened — once ranking is running there is nothing left to
    // gate.
    const iAmHeir = !me.isAdmin && !me.administersOnly;
    const alreadySigned =
      (agreements.data ?? []).some((a) => a.participantId === me.id);
    const showMethodAgreement = iAmHeir && !rankingReached;
    const steps: GuidedStep[] = [
      {
        key: "profile",
        href: "/profile",
        title: "Confirm your profile",
        blurb: "Check your name and decide whether the captain may help with your ranking.",
        done: !!me.profileConfirmedAt,
        available: true,
      },
      ...(showMethodAgreement
        ? [
            {
              key: "method-agreement",
              href: "/method-agreement",
              title: "Sign the Method Agreement",
              blurb:
                "A short statement about how we will divide things — read it once and, if you agree, sign it. Ranking opens once everyone has signed.",
              done: alreadySigned,
              available: true,
            },
          ]
        : []),
      ...(inventoryOpen
        ? [
            {
              key: "inventory",
              href: "/inventory",
              title: "Add anything that is missing",
              blurb: "The captain has opened cataloguing to the family.",
              done: mine > 0,
              available: true,
            },
          ]
        : []),
      {
        key: "ranking",
        href: "/rank",
        title: "Rank what matters to you",
        blurb: `Put your choices in order — ${data.rankSummary?.required ?? 0} required. Escalate anything special to Heirloom or High value.`,
        done: !!summary?.complete,
        available: rankingReached,
      },
      {
        key: "draft",
        href: "/draft",
        title: "Time to move to the draft of items",
        blurb: "Each round advances as everyone locks in their pick.",
        done: phase === "complete",
        available: phase === "draft" || phase === "secondary_draft" || phase === "complete",
      },
    ];
    const next = steps.find((s) => s.available && !s.done) ?? null;
    return { steps, next };
  }, [data, me, agreements.data]);
}

export function money(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * True when the current signed-in participant is the captain (or a captain-heir). Only
 * The captain sees monetary estimates — heirs see the "High value" badge alone.
 */
export function useIsCaptain(): boolean {
  const { data } = useAppState();
  const { userId } = useUser();
  const me = data?.participants.find((p) => p.id === userId) ?? null;
  return !!me?.isAdmin;
}

/** Money display gated by captain role. Heirs see a placeholder, captain sees the figure. */
export function moneyForRole(v: number | null | undefined, isCaptain: boolean): string {
  if (!isCaptain) return "";
  return money(v);
}

/** Pick level a participant still owes in the current round (0 = nothing owed). */
export function owedLevel(participantId: number, picks: DraftPick[], round: number) {
  const mine = picks
    .filter((p) => p.participantId === participantId && p.round === round && !p.isTiebreak)
    .sort((a, b) => a.pickOrder - b.pickOrder);
  if (mine.length === 0) return 1;
  const last = mine[mine.length - 1];
  if (last.outcome === "lost_contest" && last.pickOrder < 3) return last.pickOrder + 1;
  return 0;
}

export function priorityList(session: Session): number[] {
  try {
    return JSON.parse(session.priorityOrder || "[]");
  } catch {
    return [];
  }
}

/**
 * Heir permissions for the signed-in user. `can(capability)` is true for the
 * captain always, and for an heir only when the captain has switched that toggle on.
 */
export function usePermissions() {
  const { data } = useAppState();
  const { userId } = useUser();
  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !!me?.isAdmin;
  const isHelper = isHelperParticipant(me);
  const perms = parseHeirPermissions(data?.session.heirPermissions);
  return {
    isCaptain,
    isHelper,
    me,
    perms,
    // Captain can always act. Helpers get their inherent capabilities
    // (addItems, uploadPhotos, editItemNamesNotes, scanDuplicates) regardless
    // of per-heir toggles. Heirs act only when the matching toggle is on.
    can: (capability: HeirCapability) =>
      isCaptain || (isHelper && canHelperDo(capability)) || !!perms[capability],
  };
}
