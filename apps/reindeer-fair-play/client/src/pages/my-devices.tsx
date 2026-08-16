import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useUser } from "@/lib/app";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { MonitorSmartphone } from "lucide-react";

type DeviceRow = {
  id: string;
  participantId?: number;
  participantName?: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
  userAgent: string | null;
  ip: string | null;
  isCurrent: boolean;
};

const MY_SESSIONS_KEY = ["/api/auth/sessions"];
const ALL_SESSIONS_KEY = ["/api/auth/sessions/all"];

/** Plain "3 days ago" style phrasing \u2014 no timestamps, no jargon. */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const future = diff < 0;
  let phrase: string;
  if (abs < minute) phrase = "just now";
  else if (abs < hour) {
    const n = Math.round(abs / minute);
    phrase = `${n} minute${n === 1 ? "" : "s"}`;
  } else if (abs < day) {
    const n = Math.round(abs / hour);
    phrase = `${n} hour${n === 1 ? "" : "s"}`;
  } else {
    const n = Math.round(abs / day);
    phrase = `${n} day${n === 1 ? "" : "s"}`;
  }
  if (phrase === "just now") return phrase;
  return future ? `in ${phrase}` : `${phrase} ago`;
}

/** A short, human description of the device from its user-agent, not the raw string. */
function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return "A device";
  const ua = userAgent.toLowerCase();
  if (ua.includes("iphone")) return "An iPhone";
  if (ua.includes("ipad")) return "An iPad";
  if (ua.includes("android")) return "An Android device";
  if (ua.includes("mac os")) return "A Mac";
  if (ua.includes("windows")) return "A Windows computer";
  if (ua.includes("linux")) return "A computer";
  return "A device";
}

function DeviceCard({
  row,
  onRevoke,
  revoking,
  showName,
}: {
  row: DeviceRow;
  onRevoke: () => void;
  revoking: boolean;
  showName: boolean;
}) {
  const ended = row.revokedAt !== null;
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <Card data-testid={`card-device-${row.id}`}>
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-muted-foreground">
            <MonitorSmartphone className="h-5 w-5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium" data-testid={`text-device-label-${row.id}`}>
                {deviceLabel(row.userAgent)}
              </span>
              {row.isCurrent && (
                <Badge variant="outline" data-testid={`badge-this-device-${row.id}`}>
                  Signed in on this device
                </Badge>
              )}
              {ended && (
                <Badge variant="secondary" data-testid={`badge-ended-${row.id}`}>
                  Ended {relativeTime(row.revokedAt!)}
                </Badge>
              )}
            </div>
            {showName && row.participantName && (
              <div className="mt-1 text-sm text-muted-foreground" data-testid={`text-device-owner-${row.id}`}>
                {row.participantName}
              </div>
            )}
            <div className="mt-1 text-sm text-muted-foreground">
              {ended ? "Last used" : "Last used"} {relativeTime(row.lastSeenAt)}
            </div>
          </div>
        </div>
        {!ended && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              data-testid={`button-end-session-${row.id}`}
              onClick={() => setConfirmOpen(true)}
            >
              End this session
            </Button>
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogContent data-testid={`dialog-confirm-end-${row.id}`}>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {row.isCurrent ? "End this session?" : "End this device's session?"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {row.isCurrent
                      ? "This is the device you're using right now. You'll need to sign in again to keep using it."
                      : `${row.participantName ?? "This person"} will need to sign in again on ${deviceLabel(row.userAgent).toLowerCase()}.`}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid={`button-cancel-end-${row.id}`}>
                    Never mind
                  </AlertDialogCancel>
                  <AlertDialogAction
                    data-testid={`button-confirm-end-${row.id}`}
                    disabled={revoking}
                    onClick={(e) => {
                      e.preventDefault();
                      onRevoke();
                      setConfirmOpen(false);
                    }}
                  >
                    {revoking ? "Ending\u2026" : "Yes, end it"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function MyDevicesPage() {
  const { participant } = useUser();
  const isCaptain = !!participant?.isAdmin;

  const mine = useQuery<DeviceRow[]>({
    queryKey: MY_SESSIONS_KEY,
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/auth/sessions");
      return res.json();
    },
  });

  const everyone = useQuery<DeviceRow[]>({
    queryKey: ALL_SESSIONS_KEY,
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/auth/sessions/all");
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error("The family device list isn't available right now.");
      }
      return res.json();
    },
    enabled: isCaptain,
    retry: false,
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/auth/sessions/${id}/revoke`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MY_SESSIONS_KEY });
      if (isCaptain) queryClient.invalidateQueries({ queryKey: ALL_SESSIONS_KEY });
    },
  });

  const isLoading = mine.isLoading || (isCaptain && everyone.isLoading);

  const myRows = (mine.data ?? []).slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const othersRows = isCaptain
    ? (everyone.data ?? []).filter((r) => r.participantId !== participant?.id)
    : [];

  return (
    <AppShell>
      <PageHeader
        title="Where I'm signed in"
        subtitle="See every device that's currently signed in, and end any you don't recognize."
      />
      {isLoading ? (
        <LoadingRows rows={3} />
      ) : (
        <div className="space-y-8">
          <div className="space-y-3">
            {myRows.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="text-no-own-devices">
                No signed-in devices found.
              </p>
            )}
            {myRows.map((row) => (
              <DeviceCard
                key={row.id}
                row={row}
                onRevoke={() => revoke.mutate(row.id)}
                revoking={revoke.isPending && revoke.variables === row.id}
                showName={false}
              />
            ))}
          </div>

          {isCaptain && (
            <div className="space-y-3">
              <h2 className="text-xs uppercase tracking-[0.16em] text-muted-foreground" data-testid="text-everyone-heading">
                Everyone else in the family
              </h2>
              {everyone.isError ? (
                <p className="text-sm text-muted-foreground" data-testid="text-devices-list-unavailable">
                  This list isn't available right now. You can still ask a family member which
                  device they're using if you need to end a session for them.
                </p>
              ) : othersRows.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="text-no-other-devices">
                  Nobody else is currently signed in.
                </p>
              ) : (
                othersRows.map((row) => (
                  <DeviceCard
                    key={row.id}
                    row={row}
                    onRevoke={() => revoke.mutate(row.id)}
                    revoking={revoke.isPending && revoke.variables === row.id}
                    showName
                  />
                ))
              )}
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}
