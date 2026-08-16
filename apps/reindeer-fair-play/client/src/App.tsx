import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation, useHashSearch } from "@/lib/hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider, UserProvider, useGlobalSessionGuard } from "@/lib/app";
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/login";
import SignInPage from "@/pages/sign-in";
import WelcomePage from "@/pages/welcome";
import EstateNamePage from "@/pages/estate-name";
import SetupPage from "@/pages/setup";
import InventoryPage from "@/pages/inventory";
import CategoryReviewPage from "@/pages/CategoryReview";
import BatchIntakePage from "@/pages/batch";
import GroupingsPage from "@/pages/groupings";
import DraftPage from "@/pages/draft";
import ResultsPage from "@/pages/results";
import AdminPage from "@/pages/admin";
import ImportPage from "@/pages/import";
import MethodAgreementPage from "@/pages/method-agreement";
import MethodAgreementsPage from "@/pages/method-agreements";
import AppraisalReviewPage from "@/pages/appraisal-review";
import MyDevicesPage from "@/pages/my-devices";
import NotReadyYetPage from "@/pages/not-ready";
import RankPage from "@/pages/rank";
import RankAllPage from "@/pages/rank-all";
import ProfilePage from "@/pages/profile";
import NextStepPage from "@/pages/next";
import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAppState, useUser, useEstateExists } from "@/lib/app";
import { Logo } from "@/components/shell";

const FIRST_RUN_ROUTES = ["/welcome", "/setup/estate-name"];

/**
 * A quiet, unhurried loading state — shown only for the brief moment while
 * we ask the server who is signed in. Never flash the sign-in screen at
 * someone who is already signed in, and never flash the app at someone who
 * is not.
 */
function QuietLoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="flex flex-col items-center gap-3">
        <span className="animate-pulse text-primary">
          <Logo className="h-10 w-10" />
        </span>
        <p className="text-sm text-muted-foreground">Just a moment…</p>
      </div>
    </div>
  );
}

/**
 * The gate that decides what the whole app shows before routing even runs:
 *   - while we don't yet know who (if anyone) is signed in: a quiet loader.
 *   - signed in: the normal app.
 *   - signed out, no estate set up yet: the welcome/bootstrap flow (the
 *     only unauthenticated path).
 *   - signed out, estate already exists: the sign-in screen.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { userId, isLoadingAuth } = useUser();
  const estateExists = useEstateExists();
  const [location, navigate] = useLocation();

  const signedIn = userId !== null;
  const stillDeciding = isLoadingAuth || (!signedIn && estateExists.isLoading);
  // wouter's hash router folds any `?query` into `location` itself (e.g.
  // "/sign-in?token=..."), so compare only the path portion — otherwise a
  // freshly-opened magic link gets its token stripped before the sign-in
  // page ever reads it.
  const pathOnly = location.split("?")[0];

  useEffect(() => {
    if (stillDeciding) return;
    if (signedIn) return;
    if (estateExists.data) {
      // Estate already set up, nobody signed in: only the sign-in screen (and
      // a redeemed link on it) is reachable.
      if (pathOnly !== "/sign-in") navigate("/sign-in", { replace: true });
    } else {
      // No estate yet: the welcome/bootstrap flow is the only unauthenticated path.
      if (!FIRST_RUN_ROUTES.includes(pathOnly)) navigate("/welcome", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stillDeciding, signedIn, estateExists.data, pathOnly]);

  if (stillDeciding) return <QuietLoadingScreen />;
  return <>{children}</>;
}

/**
 * First run: the estate needs a Captain and a name before any
 * other screen means anything, so those two phases own the whole window.
 */
function PhaseGuard() {
  const { data } = useAppState();
  const { userId } = useUser();
  const [location, navigate] = useLocation();
  const phase = data?.session.phase;
  const isCaptain = !!data?.participants.find((p) => p.id === userId)?.isAdmin;
  useEffect(() => {
    if (!phase) return;

    // Naming the estate and finishing the welcome are the administrator's
    // jobs. An heir who signs in early must not be walked through them — she
    // would be filling in a form the server will refuse to accept. Show her a
    // plain "not ready yet" screen instead of a wizard she cannot complete.
    const inFirstRun = phase === "welcome" || phase === "estate_name";
    if (inFirstRun && userId !== null && !isCaptain) {
      if (location !== "/not-ready") navigate("/not-ready", { replace: true });
      return;
    }

    if (phase === "welcome") {
      if (location !== "/welcome") navigate("/welcome", { replace: true });
      return;
    }
    if (phase === "estate_name") {
      if (location !== "/setup/estate-name") navigate("/setup/estate-name", { replace: true });
      return;
    }

    // Once the estate is set up there is nothing to wait for.
    if (location === "/not-ready") {
      navigate(isCaptain ? "/administration" : "/", { replace: true });
      return;
    }
    // Past first run those two screens have nothing left to ask. The captain goes
    // straight on to registration; anyone else lands on the sign-in page.
    if (FIRST_RUN_ROUTES.includes(location)) {
      navigate(isCaptain ? "/administration" : "/", { replace: true });
    }
  }, [phase, location, navigate, isCaptain, userId]);
  return null;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/sign-in" component={SignInPage} />
      <Route path="/" component={LoginPage} />
      <Route path="/welcome" component={WelcomePage} />
      <Route path="/setup/estate-name" component={EstateNamePage} />
      <Route path="/setup" component={SetupPage} />
      <Route path="/participants" component={SetupPage} />
      <Route path="/next" component={NextStepPage} />
      <Route path="/inventory" component={InventoryPage} />
      <Route path="/category-review" component={CategoryReviewPage} />
      <Route path="/intake/batch" component={BatchIntakePage} />
      <Route path="/rank">{() => <RankPage />}</Route>
      <Route path="/rank/assist/:participantId">
        {(params) => <RankPage assistParticipantId={Number(params.participantId)} />}
      </Route>
      <Route path="/profile" component={ProfilePage} />
      <Route path="/rank/all" component={RankAllPage} />
      <Route path="/groupings" component={GroupingsPage} />
      <Route path="/draft" component={DraftPage} />
      <Route path="/results" component={ResultsPage} />
      <Route path="/admin" component={AdminPage} />
      <Route path="/administration" component={AdminPage} />
      <Route path="/import" component={ImportPage} />
      <Route path="/fiduciary">
        <Redirect to="/admin" />
      </Route>
      <Route path="/method-agreement" component={MethodAgreementPage} />
      <Route path="/method-agreements" component={MethodAgreementsPage} />
      <Route path="/appraisal-review" component={AppraisalReviewPage} />
      <Route path="/my-devices" component={MyDevicesPage} />
      <Route path="/not-ready" component={NotReadyYetPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function SessionGuard() {
  useGlobalSessionGuard();
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <UserProvider>
          <TooltipProvider>
            <Toaster />
            <Router hook={useHashLocation} searchHook={useHashSearch}>
              <SessionGuard />
              <AuthGate>
                <PhaseGuard />
                <AppRouter />
              </AuthGate>
            </Router>
          </TooltipProvider>
        </UserProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
