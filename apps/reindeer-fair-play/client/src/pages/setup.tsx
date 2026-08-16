import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAppState, STATE_KEY, useUser } from "@/lib/app";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { MAX_PARTICIPANTS, type Participant } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { Copy, Check, Send, Clock } from "lucide-react";

const rowSchema = z.object({
  name: z.string(),
  isAdmin: z.boolean(),
  administersOnly: z.boolean(),
});
const formSchema = z
  .object({ rows: z.array(rowSchema).length(MAX_PARTICIPANTS) })
  .refine(
    (v) => {
      const names = v.rows.map((r) => r.name.trim()).filter(Boolean);
      return names.length >= 2 && names.length <= MAX_PARTICIPANTS;
    },
    { message: "Enter between 2 and 10 names.", path: ["rows"] },
  )
  .refine(
    (v) => {
      const names = v.rows.map((r) => r.name.trim().toLowerCase()).filter(Boolean);
      return new Set(names).size === names.length;
    },
    { message: "Names must be unique.", path: ["rows"] },
  );

type FormValues = z.infer<typeof formSchema>;

type InviteResult = {
  participantId: number;
  shortCode: string;
  linkUrl: string;
  emailSent: boolean;
  expiresAt: number;
};

/** Minutes remaining until a code stops working, phrased plainly. */
function minutesLeft(expiresAt: number): number {
  return Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
}

/**
 * One heir's invite control: a button that asks the server for a fresh
 * sign-in link, then shows the short code big and clear so the captain can read
 * it aloud over the phone, plus a copy button for the link itself. Every
 * invite is temporary — that is called out right on the result.
 */
function InviteRow({ person }: { person: Participant }) {
  const { toast } = useToast();
  const [result, setResult] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/auth/participants/${person.id}/invite`);
      return (await res.json()) as InviteResult;
    },
    onSuccess: (data) => {
      setResult(data);
      setCopied(false);
    },
    onError: (e: Error) =>
      toast({
        title: "Could not send an invite",
        description: e.message.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      }),
  });

  const copyLink = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.linkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast({ title: "Could not copy", description: "Please copy the link by hand." });
    }
  };

  return (
    <Card data-testid={`card-invite-${person.id}`}>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium" data-testid={`text-invite-name-${person.id}`}>
              {person.name}
            </div>
            <div className="text-sm text-muted-foreground">
              {person.email ? person.email : "No email on file — use the code below instead."}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={invite.isPending}
            data-testid={`button-invite-${person.id}`}
            onClick={() => invite.mutate()}
          >
            <Send className="mr-1.5 h-3.5 w-3.5" />
            {invite.isPending
              ? "Sending…"
              : result
                ? "Send a new link"
                : "Send sign-in link"}
          </Button>
        </div>

        {result && result.participantId === person.id && (
          <div
            className="space-y-2 rounded-md border bg-muted/40 p-3"
            data-testid={`panel-invite-result-${person.id}`}
          >
            {result.emailSent && (
              <p className="text-sm">
                An email is on its way to {person.email}. If that doesn't work for them, read them
                this code over the phone instead:
              </p>
            )}
            {!result.emailSent && (
              <p className="text-sm">Read this code to {person.name} over the phone:</p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <span
                className="rounded-md bg-background px-4 py-2 font-mono text-2xl font-semibold tracking-[0.2em]"
                data-testid={`text-invite-code-${person.id}`}
              >
                {result.shortCode}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={copyLink}
                data-testid={`button-copy-invite-link-${person.id}`}
              >
                {copied ? (
                  <>
                    <Check className="mr-1.5 h-3.5 w-3.5" /> Link copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy the link instead
                  </>
                )}
              </Button>
            </div>
            <p
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              data-testid={`text-invite-expiry-${person.id}`}
            >
              <Clock className="h-3.5 w-3.5" />
              This code stops working in about {minutesLeft(result.expiresAt)} minutes. Send a new
              one anytime.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** captain-only: send each heir their own sign-in link or a short code to read aloud. */
function InvitePanel({ heirs }: { heirs: Participant[] }) {
  if (heirs.length === 0) return null;
  return (
    <div className="space-y-3 pt-6" data-testid="panel-invites">
      <div>
        <h2 className="font-serif text-xl">Invite the family to sign in</h2>
        <p className="text-sm text-muted-foreground">
          Send each person their own sign-in link, or give them the code to type in by hand.
        </p>
      </div>
      {heirs.map((p) => (
        <InviteRow key={p.id} person={p} />
      ))}
    </div>
  );
}

const emptyRows = Array.from({ length: MAX_PARTICIPANTS }, () => ({
  name: "",
  isAdmin: false,
  administersOnly: false,
}));

export default function SetupPage() {
  const { data, isLoading } = useAppState();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { userId } = useUser();
  const bootstrap = data?.bootstrapIncomplete;
  const phase = data?.session.phase ?? "welcome";
  const started = !["welcome", "estate_name", "registration"].includes(phase);
  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !!me?.isAdmin;
  const invitable = (data?.participants ?? []).filter((p) => p.id !== userId);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { rows: emptyRows },
  });
  const { fields } = useFieldArray({ control: form.control, name: "rows" });

  useEffect(() => {
    if (!data) return;
    if (data.participants.length === 0) return;
    const rows = [...emptyRows.map((r) => ({ ...r }))];
    data.participants
      .slice()
      .sort((a, b) => a.seatOrder - b.seatOrder)
      .forEach((p, i) => {
        if (i < MAX_PARTICIPANTS)
          rows[i] = { name: p.name, isAdmin: p.isAdmin, administersOnly: p.administersOnly };
      });
    form.reset({ rows });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.participants.length]);

  const save = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload = values.rows
        .map((r, i) => ({ ...r, name: r.name.trim(), seatOrder: i, contestedLossCounter: 0 }))
        .filter((r) => r.name.length > 0);
      const res = await apiRequest("POST", "/api/participants/replace", {
        participants: payload,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({
        title: "Participants saved",
        description: "Start the session when the roster is right.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const start = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/session/start", { participantId: userId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Session started", description: "Cataloging is now open." });
      navigate("/administration");
    },
    onError: (e: Error) =>
      toast({ title: "Could not start", description: e.message, variant: "destructive" }),
  });

  return (
    <AppShell>
      <PageHeader
        title="Participants"
        subtitle="Enter between two and ten names. Mark whoever will be the captain — the heir who runs the session for the family. If a trustee should run the session instead, add them from Administration after setup. Sign-in is by tapping a name or using a short code."
      />
      {isLoading ? (
        <LoadingRows rows={6} />
      ) : (
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => save.mutate(v))}
            className="space-y-3"
            data-testid="form-setup"
          >
            {fields.map((f, i) => {
              return (
                <Card key={f.id} data-testid={`row-participant-${i}`}>
                  <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
                    <div className="w-6 shrink-0 font-serif text-sm text-muted-foreground">
                      {i + 1}
                    </div>
                    <FormField
                      control={form.control}
                      name={`rows.${i}.name`}
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          <FormControl>
                            <Input
                              placeholder={`Participant ${i + 1} name`}
                              data-testid={`input-name-${i}`}
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`rows.${i}.isAdmin`}
                      render={({ field }) => (
                        <FormItem className="flex items-center gap-2 space-y-0">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              data-testid={`checkbox-captain-${i}`}
                              onCheckedChange={(c) => {
                                field.onChange(!!c);
                                if (!c) form.setValue(`rows.${i}.administersOnly`, false);
                              }}
                            />
                          </FormControl>
                          <Label className="text-xs leading-snug text-muted-foreground">
                            Runs the session (admin)
                          </Label>
                        </FormItem>
                      )}
                    />
                    {/*
                     * The prior "Administers only vs Participates" radio was
                     * removed: everyone in the app is an heir who drafts.
                     * The person handling the financial side sits outside the app and is
                     * captured by name on the estate-name screen, not here.
                     * The `administersOnly` field remains in the form
                     * default (false) for wire-format stability.
                     */}
                  </CardContent>
                </Card>
              );
            })}
            {form.formState.errors.rows?.root && (
              <p className="text-sm text-destructive" data-testid="text-setup-error">
                {form.formState.errors.rows.root.message}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              {bootstrap?.incomplete && (
                <p
                  className="mr-auto text-sm text-muted-foreground"
                  data-testid="text-bootstrap-reason"
                >
                  {bootstrap.reasons.join(" · ")}
                </p>
              )}
              {started && (
                <Badge variant="outline" data-testid="badge-session-started">
                  Session started
                </Badge>
              )}
              <Button
                type="submit"
                variant={started ? "default" : "outline"}
                disabled={save.isPending}
                data-testid="button-save-participants"
              >
                {save.isPending ? "Saving…" : "Save participants"}
              </Button>
              {!started && (
                <Button
                  type="button"
                  disabled={start.isPending || !!bootstrap?.incomplete}
                  data-testid="button-start-session"
                  onClick={() => start.mutate()}
                >
                  {start.isPending ? "Starting…" : "Start session"}
                </Button>
              )}
            </div>
          </form>
        </Form>
      )}
      {!isLoading && isCaptain && <InvitePanel heirs={invitable} />}
    </AppShell>
  );
}
