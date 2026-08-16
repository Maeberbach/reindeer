import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/shell";

type Estate = {
  id: number;
  name: string;
  estateName: string | null;
  phase: string;
  createdAt: number;
};

type EstatesResponse = {
  enabled: boolean;
  estates: Estate[];
};

/**
 * Estate picker — shown on the login screen when multi-estate mode is ON.
 *
 * When multi-estate mode is OFF (default), this component renders nothing
 * and the app uses the single existing session. When ON, the user picks
 * which estate they belong to before entering their email/passphrase.
 *
 * The captain can create new estates from here.
 */
export function EstatePicker({
  onSelect,
}: {
  onSelect: (estateId: number) => void;
}) {
  const { data, isLoading } = useQuery<EstatesResponse>({
    queryKey: ["/api/estates"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/estates");
      return await res.json();
    },
  });

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const createEstate = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/estates", { name: newName.trim() });
      return await res.json();
    },
    onSuccess: () => {
      setNewName("");
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ["/api/estates"] });
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          Loading estates…
        </CardContent>
      </Card>
    );
  }

  if (!data?.enabled || data.estates.length === 0) {
    return null;
  }

  return (
    <div className="mb-6 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-primary">
          <Logo className="h-6 w-6" />
        </span>
        <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Choose an estate
        </span>
      </div>

      <div className="space-y-2">
        {data.estates.map((estate) => (
          <button
            key={estate.id}
            onClick={() => onSelect(estate.id)}
            className="flex w-full items-center justify-between rounded-md border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent"
            data-testid={`button-estate-${estate.id}`}
          >
            <div>
              <div className="font-medium text-foreground">
                {estate.estateName ?? estate.name}
              </div>
              <div className="text-xs text-muted-foreground">
                {estate.phase === "welcome"
                  ? "Not started"
                  : estate.phase === "done"
                    ? "Completed"
                    : `In progress: ${estate.phase}`}
              </div>
            </div>
            <span className="text-muted-foreground">→</span>
          </button>
        ))}
      </div>

      {creating ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <Label htmlFor="new-estate-name" className="text-sm font-medium">
              Estate name
            </Label>
            <Input
              id="new-estate-name"
              autoFocus
              placeholder="e.g. Smith Family Estate"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) createEstate.mutate();
              }}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!newName.trim() || createEstate.isPending}
                onClick={() => createEstate.mutate()}
              >
                Create
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => setCreating(true)}
          data-testid="button-create-estate"
        >
          + Create new estate
        </button>
      )}
    </div>
  );
}
