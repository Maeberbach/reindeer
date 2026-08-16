import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, ChevronDown } from "lucide-react";
import {
  useNotifications,
  useNewNotifications,
  useUser,
  type AppNotificationView,
} from "@/lib/app";
import { categorySentence, classificationSentence, FLAG_LABEL } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/** One line of plain English for any notification row. */
export function notificationSentence(n: AppNotificationView): string {
  const p = n.payload ?? {};
  switch (n.type) {
    case "classification_changed":
      return classificationSentence(p as any);
    case "ranking_affected":
      return `“${p.itemName}” was flagged high-value by ${p.changedByParticipantName} and removed from your ranking.`;
    case "item_returned":
      return `“${p.itemName}” was returned to available inventory and restored to your ranking.`;
    case "reconciliation_requested":
      return `Check-in after round ${p.round ?? ""} — continue the automatic draft, or pause it?`;
    case "reconciliation_reminder":
      return `Reminder: the table is waiting on your check-in answer.`;
    case "reconciliation_stalled":
      return `${(p.pending ?? []).map((x: any) => x.name).join(", ") || "Someone"} has not answered the check-in yet.`;
    case "auto_draft_paused":
      return `${p.byName ?? "An heir"} paused the automatic draft.`;
    case "category_changed":
      return categorySentence(p as any);
    default:
      return n.type.replace(/_/g, " ");
  }
}

/** Amber for high-value movement, neutral for everything else. */
export function notificationTone(n: AppNotificationView): "amber" | "neutral" {
  if (n.type === "ranking_affected") return "amber";
  if (n.type === "classification_changed" && n.payload?.flagName === "needsAppraisal") return "amber";
  return "neutral";
}

function relative(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/* ------------------------------------------------------------------ */
/* Digest grouping                                                     */
/* ------------------------------------------------------------------ */
type Entry =
  | { kind: "single"; row: AppNotificationView }
  | { kind: "digest"; rows: AppNotificationView[]; source: string };

const DIGEST_WINDOW_MS = 60_000;
const DIGEST_MIN = 3;

/**
 * Three or more classification changes from the same person inside a minute
 * collapse into one expandable entry so the bell does not become a firehose.
 */
export function digest(rows: AppNotificationView[]): Entry[] {
  const out: Entry[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type !== "classification_changed") {
      out.push({ kind: "single", row });
      i += 1;
      continue;
    }
    const source = String(row.payload?.changedByParticipantName ?? "");
    let j = i;
    const run: AppNotificationView[] = [];
    while (
      j < rows.length &&
      rows[j].type === "classification_changed" &&
      String(rows[j].payload?.changedByParticipantName ?? "") === source &&
      Math.abs(row.createdAt - rows[j].createdAt) <= DIGEST_WINDOW_MS
    ) {
      run.push(rows[j]);
      j += 1;
    }
    if (run.length >= DIGEST_MIN) {
      out.push({ kind: "digest", rows: run, source });
      i = j;
    } else {
      out.push({ kind: "single", row });
      i += 1;
    }
  }
  return out;
}

/** A short heading that suits the kind of news being delivered. */
export function notificationTitle(n: AppNotificationView): string {
  switch (n.type) {
    case "classification_changed":
      return notificationTone(n) === "amber" ? "High-value change" : "Classification update";
    case "ranking_affected":
      return "Your ranking changed";
    case "item_returned":
      return "Item returned";
    case "reconciliation_requested":
      return "Check-in";
    case "reconciliation_reminder":
      return "Reminder";
    case "reconciliation_stalled":
      return "Check-in waiting";
    case "auto_draft_paused":
      return "Automatic rounds paused";
    case "category_changed":
      return "Category update";
    default:
      return "Update";
  }
}

/* ------------------------------------------------------------------ */
/* Bell                                                                */
/* ------------------------------------------------------------------ */
export function NotificationBell() {
  const { userId } = useUser();
  const { data } = useNotifications();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const rows = data?.notifications ?? [];
  const unread = data?.unread ?? 0;

  // Every arrival raises a toast the moment the poll picks it up.
  useNewNotifications(rows, (fresh) => {
    // Someone else changed the shared picture: refetch what the arrival implies.
    if (fresh.some((n) => n.type === "ranking_affected" || n.type === "item_returned")) {
      qc.invalidateQueries({ queryKey: ["/api/rankings"] });
    }
    if (fresh.some((n) => n.type === "classification_changed" || n.type === "category_changed")) {
      qc.invalidateQueries({ queryKey: ["/api/state"] });
    }
    fresh.slice(0, 3).forEach((n) => {
      toast({
        title: notificationTitle(n),
        description: notificationSentence(n),
        className:
          notificationTone(n) === "amber"
            ? "border-[#c9a227] bg-[#fdf3d0] text-[#5a4409] dark:bg-[#3a3007] dark:text-[#f4e2a1]"
            : undefined,
      });
    });
  });

  const entries = useMemo(() => digest(rows), [rows]);

  if (userId === null) return null;

  async function markRead(id: number) {
    await apiRequest("POST", `/api/notifications/${id}/read`);
    qc.invalidateQueries({ queryKey: ["/api/notifications/mine", userId] });
  }

  async function markAll() {
    await apiRequest("POST", "/api/notifications/read-all", { participantId: userId });
    qc.invalidateQueries({ queryKey: ["/api/notifications/mine", userId] });
  }

  function openItem(n: AppNotificationView) {
    const itemId = n.payload?.itemId;
    void markRead(n.id);
    setOpen(false);
    if (itemId) navigate(`/inventory?item=${itemId}`);
  }

  const line = (n: AppNotificationView) => (
    <button
      key={n.id}
      type="button"
      data-testid={`notification-${n.id}`}
      data-notification-type={n.type}
      onClick={() => openItem(n)}
      className={`flex w-full flex-col items-start gap-1 rounded-md px-3 py-2 text-left text-sm hover-elevate ${
        n.readAt ? "opacity-60" : ""
      }`}
    >
      <span className="flex items-start gap-2">
        {!n.readAt && (
          <span
            className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
              notificationTone(n) === "amber" ? "bg-[#c9a227]" : "bg-primary"
            }`}
          />
        )}
        <span>{notificationSentence(n)}</span>
      </span>
      <span className="flex items-center gap-2 pl-3.5 text-xs text-muted-foreground">
        <span>{relative(n.createdAt)}</span>
        {n.payload?.flagName && (
          <Badge variant="outline" className="text-[10px]">
            {FLAG_LABEL[n.payload.flagName as keyof typeof FLAG_LABEL] ?? n.payload.flagName}
          </Badge>
        )}
        {n.payload?.reason ? <span className="italic">“{n.payload.reason}”</span> : null}
      </span>
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="relative"
          aria-label="Notifications"
          data-testid="button-notifications"
        >
          {unread > 0 ? <BellRing className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
          {unread > 0 && (
            <span
              data-testid="badge-notification-count"
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
            >
              {unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0" data-testid="panel-notifications">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
            Notifications
          </span>
          <Button
            size="sm"
            variant="ghost"
            data-testid="button-mark-all-read"
            onClick={() => void markAll()}
          >
            Mark all read
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto p-1">
          {entries.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground" data-testid="text-no-notifications">
              Nothing yet.
            </p>
          )}
          {entries.map((e) => {
            if (e.kind === "single") return line(e.row);
            const key = `digest-${e.rows[0].id}`;
            const isOpen = !!expanded[key];
            return (
              <div key={key} data-testid={`notification-digest-${e.rows[0].id}`}>
                <button
                  type="button"
                  data-testid={`button-digest-${e.rows[0].id}`}
                  onClick={() => setExpanded((s) => ({ ...s, [key]: !isOpen }))}
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover-elevate"
                >
                  <span>
                    {e.rows.length} classification changes
                    {e.source ? ` from ${e.source}` : ""}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {isOpen && <div className="pl-3">{e.rows.map(line)}</div>}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Inline banner for the Ranking page                                  */
/* ------------------------------------------------------------------ */

/**
 * A quiet line above the ranking panes: how many classification changes have
 * landed since this heir last looked, with a per-item history behind it.
 */
export function ClassificationChangeBanner() {
  const { data } = useNotifications();
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [, navigate] = useLocation();

  const rows = (data?.notifications ?? []).filter(
    (n) =>
      !n.readAt &&
      (n.type === "classification_changed" ||
        n.type === "ranking_affected" ||
        n.type === "category_changed"),
  );
  if (dismissed || rows.length === 0) return null;

  return (
    <div
      className="mb-4 rounded-md border border-border bg-muted/40 px-4 py-2 text-sm"
      data-testid="banner-classification-changes"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="text-classification-change-count">
          {rows.length} change{rows.length === 1 ? "" : "s"} to the shared picture since you last
          visited
        </span>
        <Button
          size="sm"
          variant="ghost"
          data-testid="button-view-classification-changes"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide" : "View"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          data-testid="button-dismiss-classification-banner"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </Button>
      </div>
      {expanded && (
        <ul className="mt-2 space-y-1" data-testid="list-classification-changes">
          {rows.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                data-testid={`link-classification-change-${n.id}`}
                className="text-left text-xs text-muted-foreground underline-offset-4 hover:underline"
                onClick={() => navigate(`/inventory?item=${n.payload?.itemId ?? ""}`)}
              >
                {notificationSentence(n)} · {relative(n.createdAt)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
