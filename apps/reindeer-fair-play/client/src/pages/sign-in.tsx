import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { AUTH_ME_KEY, useUser } from "@/lib/app";
import { Logo } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { OpenAIKeyPanel } from "@/components/openai-key-panel";
import { EstatePicker } from "@/components/estate-picker";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Reads a query param from the current route, hash router included. */
function useQueryParam(name: string): string | null {
  const search = useSearch();
  return new URLSearchParams(search).get(name);
}

/** A quiet frame matching the welcome/first-run screens. */
function SignInFrame({ children }: { children: React.ReactNode }) {
  // Fetch OpenAI key status — not gated by auth, so it works on the sign-in page.
  // The route is requireCaptain, so it'll return 401 for non-captains, which
  // just means the panel shows "Enable AI" for heirs. That's fine — only the
  // captain can set the key anyway.
  const { data: keyStatus } = useQuery({
    queryKey: ["/api/settings/openai"],
    queryFn: async () => {
      try {
        const res = await apiRequest("GET", "/api/settings/openai");
        return await res.json();
      } catch {
        return null;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  return (
    <div className="min-h-screen bg-background px-4 py-12 text-foreground md:py-20">
      <div className="mx-auto w-full max-w-lg">
        <div className="mb-8 flex items-center gap-3">
          <span className="text-primary">
            <Logo className="h-9 w-9" />
          </span>
          <div className="leading-tight">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Legacy
            </div>
            <div className="font-serif text-base font-semibold">Reindeer: FairPlay</div>
          </div>
        </div>
        {multiEstate?.enabled && (
          <div className="mb-4">
            <EstatePicker onSelect={() => {}} />
          </div>
        )}
        {children}
        <OpenAIKeyPanel keyStatus={keyStatus ?? undefined} />
      </div>
    </div>
  );
}

type RedeemResult = { participant: import("@shared/schema").Participant };

/** apiRequest() throws `"<status>: <raw body>"`; the body is usually `{"message": "..."}`. */
function friendlyError(message: string): string {
  const withoutStatus = message.replace(/^\d+:\s*/, "");
  try {
    const parsed = JSON.parse(withoutStatus);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON — fall through to the plain text */
  }
  return withoutStatus;
}

/** Handles `?token=...`: redeem immediately, show progress, then land signed in. */
function TokenRedeemView({ token }: { token: string }) {
  const [, navigate] = useLocation();
  const { refreshMe } = useUser();
  const [failure, setFailure] = useState<string | null>(null);

  const redeem = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/redeem", { token });
      return (await res.json()) as RedeemResult;
    },
    onSuccess: (result) => {
      // Write the confirmed participant into the cache synchronously so the
      // app knows who is signed in the instant we navigate — an
      // invalidate-then-navigate would race the refetch and bounce back to
      // the sign-in screen because the old (signed-out) value is still what
      // useUser() reports at the moment AuthGate re-checks.
      queryClient.setQueryData(AUTH_ME_KEY, result.participant);
      navigate("/", { replace: true });
    },
    onError: (e: Error) => {
      setFailure(friendlyError(e.message));
    },
  });

  useEffect(() => {
    redeem.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (failure) {
    return (
      <Card data-testid="card-sign-in-link-failed">
        <CardContent className="space-y-5 p-6">
          <h1 className="font-serif text-xl font-semibold md:text-2xl" data-testid="text-page-title">
            That link didn&apos;t work
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground" data-testid="text-link-failure-message">
            {failure}
          </p>
          <Button
            className="w-full"
            size="lg"
            data-testid="button-request-new-link"
            onClick={() => navigate("/sign-in", { replace: true })}
          >
            Send me a new one
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-sign-in-link-progress">
      <CardContent className="space-y-4 p-6 text-center">
        <h1 className="font-serif text-xl font-semibold md:text-2xl" data-testid="text-page-title">
          Signing you in…
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Just a moment while we check your link.
        </p>
      </CardContent>
    </Card>
  );
}

/** Ask for an email address only. Always shows the same calm confirmation. */
function RequestLinkView({
  onUseCode,
  onUsePassphrase,
}: {
  onUseCode: () => void;
  onUsePassphrase: () => void;
}) {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const request = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/request", { email: email.trim() });
    },
    onSuccess: () => setSubmitted(true),
  });

  if (submitted) {
    return (
      <Card data-testid="card-check-your-email">
        <CardContent className="space-y-4 p-6">
          <h1 className="font-serif text-xl font-semibold md:text-2xl" data-testid="text-page-title">
            Check your email
          </h1>
          <p className="text-base leading-relaxed" data-testid="text-check-email-body">
            If that address is on the estate&apos;s list, a message is on its way. It will have a
            link to tap, and a short code you can type in instead if the link doesn&apos;t work.
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            It can take a minute or two to arrive. If it doesn&apos;t show up, check your spam
            folder, or ask the captain to send it again.
          </p>
          <Button
            variant="outline"
            className="w-full"
            size="lg"
            data-testid="button-use-code-instead"
            onClick={onUseCode}
          >
            I was given a code instead
          </Button>
        </CardContent>
      </Card>
    );
  }

  const disabled = email.trim().length === 0 || request.isPending;

  return (
    <Card data-testid="card-request-sign-in">
      <CardContent className="space-y-6 p-6">
        <div>
          <h1 className="font-serif text-2xl font-semibold md:text-3xl" data-testid="text-page-title">
            Sign in
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Enter your email address and we&apos;ll send you a link to sign in.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="sign-in-email" className="text-sm font-medium">
            Email address
          </Label>
          <Input
            id="sign-in-email"
            type="email"
            autoFocus
            autoComplete="email"
            inputMode="email"
            className="h-14 text-lg"
            placeholder="you@example.com"
            value={email}
            data-testid="input-sign-in-email"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !disabled) request.mutate();
            }}
          />
        </div>

        <Button
          className="h-14 w-full text-base"
          size="lg"
          disabled={disabled}
          data-testid="button-send-link"
          onClick={() => request.mutate()}
        >
          {request.isPending ? "Sending…" : "Send my sign-in link"}
        </Button>

        <div className="flex items-center gap-3 text-xs uppercase tracking-[0.14em] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          <span>Or</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <Button
          variant="outline"
          className="h-14 w-full text-base"
          size="lg"
          data-testid="button-use-code-instead"
          onClick={onUseCode}
        >
          I was given a code instead
        </Button>

        <Button
          variant="ghost"
          className="h-12 w-full text-base"
          data-testid="button-use-passphrase-instead"
          onClick={onUsePassphrase}
        >
          I&apos;m the captain with a passphrase
        </Button>
      </CardContent>
    </Card>
  );
}

/** Short-code entry for someone whose email doesn't work. */
function ShortCodeView({ onBack }: { onBack: () => void }) {
  const [, navigate] = useLocation();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const redeem = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/redeem", { shortCode: code.trim() });
      return (await res.json()) as RedeemResult;
    },
    onSuccess: (result) => {
      setError(null);
      // See TokenRedeemView above: write the confirmed participant in
      // directly rather than invalidate-then-navigate, which races the
      // refetch and bounces back to the sign-in screen.
      queryClient.setQueryData(AUTH_ME_KEY, result.participant);
      navigate("/", { replace: true });
    },
    onError: (e: Error) => setError(friendlyError(e.message)),
  });

  const disabled = code.trim().length === 0 || redeem.isPending;

  return (
    <Card data-testid="card-short-code">
      <CardContent className="space-y-6 p-6">
        <div>
          <h1 className="font-serif text-2xl font-semibold md:text-3xl" data-testid="text-page-title">
            Enter your code
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Type the 6-character code the captain read out to you over the phone.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="short-code" className="text-sm font-medium">
            Code
          </Label>
          <Input
            id="short-code"
            autoFocus
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className="h-14 text-center text-2xl font-semibold uppercase tracking-[0.3em]"
            placeholder="ABC123"
            value={code}
            data-testid="input-short-code"
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/\s+/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !disabled) redeem.mutate();
            }}
          />
        </div>

        {error && (
          <p className="text-sm leading-relaxed text-destructive" data-testid="text-code-error">
            {error}
          </p>
        )}

        <Button
          className="h-14 w-full text-base"
          size="lg"
          disabled={disabled}
          data-testid="button-submit-code"
          onClick={() => redeem.mutate()}
        >
          {redeem.isPending ? "Checking…" : "Continue"}
        </Button>

        <Button variant="ghost" className="w-full" data-testid="button-back-to-email" onClick={onBack}>
          Use my email instead
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Passphrase sign-in, for the Captain only.
 *
 * Why this is here and not behind a link somewhere: the captain is the
 * one person who cannot afford to be locked out of the estate, and on a second
 * device the emailed link is a slow and fragile way back in. Heirs are not
 * offered this — they have no passphrase to enter — so the button that reaches
 * it is worded to make clear who it is for, rather than presenting two equal
 * choices that most people would have to guess between.
 */
function PassphraseView({ onBack }: { onBack: () => void }) {
  const [, navigate] = useLocation();
  const { refreshMe } = useUser();
  const [passphrase, setPassphrase] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const signIn = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/rep-sign-in", { passphrase });
      return (await res.json()) as RedeemResult;
    },
    onSuccess: async () => {
      setFailure(null);
      await queryClient.invalidateQueries({ queryKey: AUTH_ME_KEY });
      await refreshMe();
      navigate("/");
    },
    onError: (e: Error) => setFailure(friendlyError(e.message)),
  });

  const disabled = passphrase.trim().length === 0 || signIn.isPending;

  return (
    <Card data-testid="card-passphrase-sign-in">
      <CardContent className="space-y-6 p-6">
        <div>
          <h1 className="font-serif text-2xl font-semibold md:text-3xl" data-testid="text-page-title">
            Sign in with your passphrase
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            This is for the captain. If you are an heir, go back and ask for a
            sign-in link instead.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="sign-in-passphrase" className="text-sm font-medium">
            Passphrase
          </Label>
          <Input
            id="sign-in-passphrase"
            type="password"
            autoFocus
            autoComplete="current-password"
            className="h-14 text-lg"
            value={passphrase}
            data-testid="input-passphrase"
            onChange={(e) => {
              setPassphrase(e.target.value);
              setFailure(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !disabled) signIn.mutate();
            }}
          />
        </div>

        {failure && (
          <p
            className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm leading-relaxed"
            data-testid="text-passphrase-error"
            role="alert"
          >
            {failure}
          </p>
        )}

        <Button
          className="h-14 w-full text-base"
          size="lg"
          disabled={disabled}
          data-testid="button-passphrase-sign-in"
          onClick={() => signIn.mutate()}
        >
          {signIn.isPending ? "Checking…" : "Sign in"}
        </Button>

        <Button variant="ghost" className="w-full" data-testid="button-back-from-passphrase" onClick={onBack}>
          Back
        </Button>
      </CardContent>
    </Card>
  );
}

export default function SignInPage() {
  const token = useQueryParam("token");
  const { signOutReason, clearSignOutReason } = useUser();
  const [mode, setMode] = useState<"email" | "code" | "passphrase">("email");

  if (token) {
    return (
      <SignInFrame>
        <TokenRedeemView token={token} />
      </SignInFrame>
    );
  }

  return (
    <SignInFrame>
      {signOutReason === "ended" && (
        <div
          className="mb-4 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm leading-relaxed"
          data-testid="banner-signed-out-notice"
        >
          You&apos;ll need to sign in again.
          <button
            type="button"
            className="ml-2 underline underline-offset-2"
            data-testid="button-dismiss-signed-out-notice"
            onClick={clearSignOutReason}
          >
            Got it
          </button>
        </div>
      )}
      {mode === "email" && (
        <RequestLinkView
          onUseCode={() => setMode("code")}
          onUsePassphrase={() => setMode("passphrase")}
        />
      )}
      {mode === "code" && <ShortCodeView onBack={() => setMode("email")} />}
      {mode === "passphrase" && <PassphraseView onBack={() => setMode("email")} />}
    </SignInFrame>
  );
}
