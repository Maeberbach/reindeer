import { canHeirDo, estateTitle } from "@shared/schema";
import { Link, useLocation } from "wouter";
import { useAppState, useTheme, useUser, phaseLabel, RANKING_PAGE_PHASES, AUTH_ME_KEY } from "@/lib/app";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { RankingDeadlineBanner } from "@/components/ranking-banner";
import { StageIndicator } from "@/components/stage-indicator";
import { PausedBanner, CaptainPauseStrip } from "@/components/paused-banner";
import { CaptainBanner } from "@/components/captain-banner";
import { ResumeDialog } from "@/components/lifecycle-dialogs";
import { useSessionState } from "@/lib/app";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tags,
  Boxes,
  Camera,
  Gavel,
  Home,
  Layers,
  ListOrdered,
  Moon,
  ScrollText,
  FlaskConical,
  Settings,
  Sun,
  UserCog,
  Users,
  HandHelping,
  LogOut,
  Lock,
  Compass,
  UploadCloud,
  ClipboardCheck,
  Handshake,
  MonitorSmartphone,
} from "lucide-react";
import { NotificationBell } from "@/components/notifications";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageGuide } from "@/components/page-guide";
import { NextStepFooter } from "@/components/next-step-footer";
import type { GuideKey } from "@/lib/page-guides";
import type { ReactNode } from "react";

/**
 * v8.2i — map the current route + role to a page-guide key. Returning null
 * means "no guide on this route" (e.g. batch intake, groupings).
 */
function guideKeyFor(path: string, isCaptain: boolean): GuideKey | null {
  if (path === "/next") return isCaptain ? "welcome-captain" : "welcome-heir";
  if (path === "/profile") return "profile";
  if (path === "/inventory") return isCaptain ? "inventory-captain" : "inventory-heir";
  if (path === "/category-review") return "review-categories";
  if (path === "/rank" || path.startsWith("/rank/")) return "rank";
  if (path === "/draft") return "draft";
  if (path === "/results") return "results";
  if (path === "/administration") return "admin";
  if (path === "/participants") return "setup";
  // Import is a self-explanatory page with its own in-page instructions, so no
  // separate page-guide banner is needed.
  return null;
}

export function Logo({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      aria-label="Reindeer: FairPlay"
      role="img"
      data-testid="img-logo"
    >
      <rect x="2.5" y="2.5" width="27" height="27" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8" y="8" width="16" height="16" stroke="currentColor" strokeWidth="1.4" />
      <rect x="13.5" y="13.5" width="5" height="5" fill="currentColor" />
      <path d="M2.5 16h5.5M24 16h5.5M16 2.5V8M16 24v5.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

type NavItem = {
  href: string;
  label: string;
  icon: typeof Home;
  testid: string;
  /** Who is allowed to see the link at all. */
  audience: "all" | "captain" | "heir";
};

/**
 * The order is deliberate. A heir opens on "Next step" and walks the guided
 * sequence; the captain opens on Administration and works outward from there.
 */
const NAV: NavItem[] = [
  { href: "/", label: "Sign in", icon: Home, testid: "link-nav-login", audience: "all" },
  { href: "/next", label: "Next step", icon: Compass, testid: "link-nav-next", audience: "heir" },
  {
    href: "/administration",
    label: "Administration",
    icon: Settings,
    testid: "link-nav-admin",
    audience: "captain",
  },
  {
    href: "/participants",
    label: "Participants",
    icon: Users,
    testid: "link-nav-setup",
    audience: "captain",
  },
  {
    href: "/category-review",
    label: "Review categories",
    icon: Tags,
    testid: "link-nav-category-review",
    audience: "all",
  },
  { href: "/inventory", label: "Inventory", icon: Boxes, testid: "link-nav-inventory", audience: "all" },
  {
    href: "/intake/batch",
    label: "Batch intake",
    icon: Camera,
    testid: "link-nav-batch",
    audience: "all",
  },
  { href: "/rank", label: "Ranking", icon: ListOrdered, testid: "link-nav-rank", audience: "all" },
  {
    href: "/rank/all",
    label: "Ranking overview",
    icon: ListOrdered,
    testid: "link-nav-rank-all",
    audience: "captain",
  },
  { href: "/groupings", label: "Groupings", icon: Layers, testid: "link-nav-groupings", audience: "all" },
  { href: "/draft", label: "Draft", icon: Gavel, testid: "link-nav-draft", audience: "all" },
  { href: "/results", label: "Results", icon: ScrollText, testid: "link-nav-results", audience: "all" },
  { href: "/profile", label: "Your profile", icon: UserCog, testid: "link-nav-profile", audience: "heir" },
  {
    href: "/import",
    label: "Inventory intake",
    icon: UploadCloud,
    testid: "link-nav-import",
    audience: "captain",
  },
  {
    href: "/method-agreements",
    label: "Method Agreement",
    icon: ClipboardCheck,
    testid: "link-nav-method-agreements",
    audience: "captain",
  },
  {
    href: "/method-agreement",
    label: "My agreement",
    icon: Handshake,
    testid: "link-nav-method-agreement",
    audience: "heir",
  },
  {
    href: "/my-devices",
    label: "Where I'm signed in",
    icon: MonitorSmartphone,
    testid: "link-nav-my-devices",
    audience: "all",
  },
];

/** Persistent parchment banner shown on every page while practice is running. */
export function PracticeBanner({ mode }: { mode: string }) {
  if (!mode || mode === "off") return null;
  return (
    <div
      className="no-print flex flex-wrap items-center justify-center gap-2 border-b border-[#c9a227]/50 bg-[#fdf3d0] px-4 py-2 text-center text-sm font-medium text-[#5a4409] dark:bg-[#3a3007] dark:text-[#f4e2a1]"
      data-testid="banner-practice-mode"
      role="status"
    >
      <FlaskConical className="h-4 w-4" />
      <span className="uppercase tracking-[0.14em]">Practice mode</span>
      <span className="font-normal">
        — this is a rehearsal. Nothing you do here will award items or affect the real draft.
      </span>
      <span className="font-normal opacity-70">(sample items)</span>
    </div>
  );
}

/**
 * The signed-in person's name is already shown next to this button, so the
 * button itself only needs to offer the one thing it does: end the session.
 * Confirms first — signing out is disruptive for someone who may not
 * remember how to get back in.
 */
export function SignOutControl() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);

  const signOut = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/sign-out");
    },
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(AUTH_ME_KEY, null);
      setOpen(false);
      navigate("/sign-in", { replace: true });
    },
  });

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid="button-sign-out"
        onClick={() => setOpen(true)}
      >
        <LogOut className="mr-1.5 h-3.5 w-3.5" />
        Sign out
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent data-testid="dialog-confirm-sign-out">
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of this device?</AlertDialogTitle>
            <AlertDialogDescription>
              You&apos;ll need to sign in again next time — either with a new emailed link, or with a
              code from the captain. Nothing you&apos;ve entered will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-sign-out">Stay signed in</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-sign-out"
              disabled={signOut.isPending}
              onClick={(e) => {
                e.preventDefault();
                signOut.mutate();
              }}
            >
              {signOut.isPending ? "Signing out…" : "Yes, sign out"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { theme, toggle } = useTheme();
  const { userId, setUserId } = useUser();
  const { data, isLoading } = useAppState();
  const { data: lifecycle } = useSessionState();
  const [resumeOpen, setResumeOpen] = useState(false);
  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const practiceMode = data?.session.practiceMode ?? "off";
  // Batch photo intake creates items, so it follows the "add items" permission.
  const canDoDuplicateWork = !!me?.isAdmin || canHeirDo(data?.session ?? {}, "addItems");
  const phase = data?.session.phase ?? "welcome";
  // Ranking only appears once the captain has opened it, and stays reachable through
  // both drafts so heirs can re-order what is still unawarded.
  const rankingVisible = RANKING_PAGE_PHASES.includes(phase);
  const isCaptain = !me || !!me.isAdmin;
  // Heirs only see Inventory once the captain has invited contributions, or once the
  // catalogue is settled and there is something worth reading.
  const inventoryVisibleToHeirs =
    !!data?.session.heirsCanAddInventory || !["welcome", "estate_name", "registration", "intake"].includes(phase);
  const groupingsVisibleToHeirs =
    !!data?.session.heirsCanProposeGroupings || phase === "groupings";
  // Before the roster is closed there is nothing to catalogue, rank, or draft.
  const preRegistration = phase === "welcome" || phase === "estate_name";
  const registering = phase === "registration";
  const heirCount = (data?.participants ?? []).filter((p) => !p.administersOnly).length;
  /** Which links survive the pre-cataloging phases. */
  const phaseAllows = (href: string) => {
    // A person's own signed-in devices are theirs to manage regardless of
    // what phase the estate is in.
    if (href === "/my-devices") return true;
    if (preRegistration) return false;
    if (!registering) return true;
    if (href === "/") return heirCount > 0;
    return href === "/administration" || href === "/participants";
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PausedBanner />
      <CaptainBanner />
      <ResumeDialog
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        pausedAt={lifecycle?.pausedAt ?? data?.session.pausedAt ?? null}
      />
      <div className="flex min-h-screen w-full min-w-0 flex-col md:flex-row">
        {/* Sidebar */}
        <aside className="no-print min-w-0 max-w-full border-b border-sidebar-border bg-sidebar md:w-60 md:shrink-0 md:border-b-0 md:border-r">
          <div className="flex items-center gap-2.5 px-4 py-4">
            <span className="text-primary">
              <Logo />
            </span>
            <div className="leading-tight">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Legacy
              </div>
              <div className="font-serif text-base font-semibold" data-testid="text-app-name">
                Reindeer: FairPlay
              </div>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col md:overflow-visible">
            {NAV.filter((n) => phaseAllows(n.href))
              .filter((n) => n.audience === "all" || (n.audience === "captain" ? isCaptain : !isCaptain && !!me))
              .filter((n) => n.href !== "/intake/batch" || (canDoDuplicateWork && !!me?.isAdmin))
              .filter((n) => n.href !== "/rank" || (rankingVisible && !me?.administersOnly))
              .filter((n) => n.href !== "/groupings" || isCaptain || groupingsVisibleToHeirs)
              .filter((n) => n.href !== "/inventory" || isCaptain || inventoryVisibleToHeirs)
              // Reviewing categories is optional work: the captain always sees it,
              // heirs only while they are allowed to file things.
              .filter(
                (n) =>
                  n.href !== "/category-review" ||
                  isCaptain ||
                  !!data?.session.heirsCanCategorize,
              )
              .map((n) => {
              const active = location === n.href;
              const Icon = n.icon;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  data-testid={n.testid}
                  className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm hover-elevate ${
                    active
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{n.label}</span>
                </Link>
              );
            })}

            {/* Assist an heir — only for the captain, and only with that heir's consent. */}
            {!!me?.isAdmin && rankingVisible && (
              <div className="mt-1 shrink-0 md:mt-2" data-testid="nav-assist-submenu">
                <div className="px-3 pb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Assist an heir
                </div>
                {(data?.participants ?? [])
                  .filter((p) => !p.administersOnly && p.id !== userId)
                  .map((p) => {
                    const consented = !!p.allowsCaptainAssist;
                    const href = `/rank/assist/${p.id}`;
                    const active = location === href;
                    const label = (
                      <span className="flex items-center gap-2">
                        {consented ? (
                          <HandHelping className="h-4 w-4" />
                        ) : (
                          <Lock className="h-4 w-4" />
                        )}
                        <span>{p.name}</span>
                      </span>
                    );
                    if (!consented) {
                      return (
                        <Tooltip key={p.id}>
                          <TooltipTrigger asChild>
                            <span
                              aria-disabled="true"
                              data-testid={`link-assist-${p.id}`}
                              data-consent="false"
                              className="flex shrink-0 cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground/50"
                            >
                              {label}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Consent required</TooltipContent>
                        </Tooltip>
                      );
                    }
                    return (
                      <Link
                        key={p.id}
                        href={href}
                        data-testid={`link-assist-${p.id}`}
                        data-consent="true"
                        className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm hover-elevate ${
                          active
                            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {label}
                      </Link>
                    );
                  })}
              </div>
            )}
          </nav>
        </aside>

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
          <PracticeBanner mode={practiceMode} />
          <CaptainPauseStrip onResume={() => setResumeOpen(true)} />
          <RankingDeadlineBanner />
          <StageIndicator />
          <header className="no-print flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 md:px-8">
            <div className="flex items-center gap-2">
              {isLoading ? (
                <Skeleton className="h-5 w-32" />
              ) : (
                <>
                  <span
                    className="font-serif text-sm font-semibold"
                    data-testid="text-estate-name"
                  >
                    {estateTitle(data?.session.estateName)}
                  </span>
                  <Badge variant="secondary" data-testid="status-phase">
                    Phase: {phaseLabel(data?.session.phase ?? "welcome")}
                  </Badge>
                </>
              )}
              {data && data.session.currentRound > 0 && (
                <Badge variant="outline" data-testid="status-round">
                  Round {data.session.currentRound}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {me ? (
                <>
                  <span
                    className="flex items-center gap-1.5 text-sm text-muted-foreground"
                    data-testid="text-current-user"
                  >
                    <UserCog className="h-4 w-4" />
                    {me.name}
                    {me.isAdmin && (
                      <Badge variant="outline" className="ml-1" data-testid="badge-user-role">
                        Captain
                      </Badge>
                    )}
                  </span>
                  <SignOutControl />
                </>
              ) : (
                <span className="text-sm text-muted-foreground" data-testid="text-current-user">
                  Not signed in
                </span>
              )}
              <NotificationBell />
              <Button
                size="icon"
                variant="ghost"
                aria-label="Toggle dark mode"
                data-testid="button-theme-toggle"
                onClick={toggle}
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </div>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-10">
            {(() => {
              const key = guideKeyFor(location, isCaptain);
              return key ? <PageGuide guideKey={key} /> : null;
            })()}
            {children}
            {guideKeyFor(location, isCaptain) && <NextStepFooter />}
          </main>
        </div>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-serif text-xl font-semibold" data-testid="text-page-title">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground" data-testid="text-page-subtitle">
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="no-print flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" data-testid="loading-skeleton">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}
