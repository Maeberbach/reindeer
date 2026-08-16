import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TaxonomyRow } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const TAXONOMY_KEY = ["/api/taxonomy"];

/** All rooms + categories for the estate, with per-label item counts. */
export function useTaxonomy() {
  return useQuery<TaxonomyRow[]>({ queryKey: TAXONOMY_KEY });
}

export function useEnabledLabels(kind: "room" | "category") {
  const { data, isLoading } = useTaxonomy();
  return {
    labels: (data ?? []).filter((t) => t.kind === kind && t.isEnabled).map((t) => t.label),
    isLoading,
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Tap-button picker fed by the taxonomy table. Only labels the captain has enabled
 * in Administration appear; "Other…" remains as a free-text escape hatch.
 */
export function TaxonomyPicker({
  kind,
  value,
  onChange,
  idPrefix,
  label,
}: {
  kind: "room" | "category";
  value: string;
  onChange: (v: string) => void;
  idPrefix?: string;
  label?: string;
}) {
  const prefix = idPrefix ?? kind;
  const { labels, isLoading } = useEnabledLabels(kind);
  const isCustom = !!value && !labels.includes(value);
  const [other, setOther] = useState(isCustom);

  return (
    <div className="space-y-2" data-testid={`picker-${prefix}`}>
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">
        {label ?? (kind === "room" ? "Room" : "Category")}
      </Label>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : labels.length === 0 ? (
        <p
          className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
          data-testid={`text-empty-${prefix}`}
        >
          No {kind === "room" ? "rooms" : "categories"} enabled yet — ask the captain to enable some in
          Administration.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {labels.map((r) => (
          <Button
            key={r}
            type="button"
            size="sm"
            variant={value === r ? "default" : "outline"}
            data-testid={`button-${prefix}-${slug(r)}`}
            onClick={() => {
              setOther(false);
              onChange(r);
            }}
          >
            {r}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant={other ? "default" : "outline"}
          data-testid={`button-${prefix}-other`}
          onClick={() => setOther(true)}
        >
          Other…
        </Button>
      </div>
      {other && (
        <Input
          placeholder={kind === "room" ? "Custom room name" : "Custom category name"}
          value={isCustom ? value : ""}
          data-testid={`input-${prefix}-custom`}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

export function RoomPicker({
  value,
  onChange,
  idPrefix = "room",
}: {
  value: string;
  onChange: (room: string) => void;
  idPrefix?: string;
}) {
  return <TaxonomyPicker kind="room" value={value} onChange={onChange} idPrefix={idPrefix} />;
}

export function CategoryPicker({
  value,
  onChange,
  idPrefix = "category",
}: {
  value: string;
  onChange: (category: string) => void;
  idPrefix?: string;
}) {
  return (
    <TaxonomyPicker kind="category" value={value} onChange={onChange} idPrefix={idPrefix} />
  );
}
