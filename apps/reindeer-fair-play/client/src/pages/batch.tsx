import { canHeirDo } from "@shared/schema";
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { STATE_KEY, money, useIsCaptain, useUser, useAppState } from "@/lib/app";
import { AppShell, PageHeader } from "@/components/shell";
import { RoomPicker, useTaxonomy, TAXONOMY_KEY } from "@/components/room-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useGeolocation } from "@/hooks/use-geolocation";
import { extractExifGps } from "@/lib/exif-gps";

import { Sparkles, Upload } from "lucide-react";

type Detection = {
  tempId: string;
  name: string;
  room: string;
  category: string;
  aiEstimatedValue: number;
  isHeirloomCandidate: boolean;
  duplicateOf: string | null;
  thumbnailUrl: string;
  photoUrl: string;
  confidence: number;
};

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** 1×1 pixel stand-in used by the "demo photo" button. */
const DEMO_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export default function BatchIntakePage() {
  const [detections, setDetections] = useState<Detection[]>([]);
  const [photoExifs, setPhotoExifs] = useState<Record<string, { lat: number; lon: number; takenAt: number | null } | null>>({});
  const { capture: captureLocation } = useGeolocation();
  const [engine, setEngine] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { userId } = useUser();
  const { data: appState } = useAppState();
  const isCaptain = useIsCaptain();
  const meB = appState?.participants.find((p) => p.id === userId) ?? null;
  const canIntake = !!meB?.isAdmin || canHeirDo(appState?.session ?? {}, "addItems");
  const { data: taxonomy } = useTaxonomy();
  const enabledCategories = (taxonomy ?? [])
    .filter((t) => t.kind === "category" && t.isEnabled)
    .map((t) => t.label);

  const intake = useMutation({
    mutationFn: async (images: string[]) => {
      const res = await apiRequest("POST", "/api/items/batch-intake", { images });
      return res.json() as Promise<{ engine: string; detections: Detection[] }>;
    },
    onSuccess: (d) => {
      setEngine(d.engine);
      setDetections((prev) => [...prev, ...d.detections]);
      toast({
        title: `${d.detections.length} item(s) detected`,
        description: "Review each card before it enters the catalog.",
      });
    },
    onError: (e: Error) =>
      toast({ title: "Intake failed", description: e.message, variant: "destructive" }),
  });

  const approve = useMutation({
    mutationFn: async (rows: Detection[]) => {
      const loc = await captureLocation();
      for (const d of rows) {
        const exif = photoExifs[d.tempId] ?? null;
        await apiRequest("POST", "/api/items", {
          participantId: userId,
          name: d.name,
          room: d.room,
          category: d.category,
          notes: "",
          aiEstimatedValue: d.aiEstimatedValue,
          estimateSource: "ai",
          photoUrl: d.photoUrl || null,
          thumbnailUrl: d.thumbnailUrl,
          isHeirloomCandidate: d.isHeirloomCandidate,
          lat: loc?.lat ?? null,
          lon: loc?.lon ?? null,
          photoLat: exif?.lat ?? null,
          photoLon: exif?.lon ?? null,
          photoTakenAt: exif?.takenAt ?? null,
        });
      }
      return rows.map((r) => r.tempId);
    },
    onSuccess: (ids) => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      queryClient.invalidateQueries({ queryKey: TAXONOMY_KEY });
      setDetections((prev) => prev.filter((d) => !ids.includes(d.tempId)));
      toast({ title: `${ids.length} item(s) added to the catalog` });
    },
  });

  const patch = (tempId: string, p: Partial<Detection>) =>
    setDetections((prev) => prev.map((d) => (d.tempId === tempId ? { ...d, ...p } : d)));

  if (!canIntake) {
    return (
      <AppShell>
        <PageHeader title="Batch intake" subtitle="Reserved while work-sharing is off." />
        <Card className="p-10 text-center" data-testid="text-batch-locked">
          <p className="font-serif text-lg">Only the captain may add items</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Ask the captain to switch on participant duplicate work-sharing in Administration if you
            should be helping with intake.
          </p>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Batch photo intake"
        subtitle="Upload photographs of a room or a tabletop. Each detection becomes a review card — approve, edit, or discard before anything enters the catalog."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              data-testid="input-batch-files"
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) {
                  const exifs = await Promise.all(files.map((f) => extractExifGps(f)));
                  const newExifs: Record<string, { lat: number; lon: number; takenAt: number | null } | null> = {};
                  for (let i = 0; i < exifs.length; i++) {
                    if (exifs[i]) newExifs[`file-${i}`] = exifs[i];
                  }
                  if (Object.keys(newExifs).length) setPhotoExifs((p) => ({ ...p, ...newExifs }));
                  const images = await Promise.all(files.map(readFile));
                  intake.mutate(images);
                }
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              data-testid="button-demo-photo"
              disabled={intake.isPending}
              onClick={() => intake.mutate([DEMO_IMAGE])}
            >
              <Sparkles className="mr-1.5 h-4 w-4" />
              Use demo photo
            </Button>
            <Button
              size="sm"
              data-testid="button-upload-photos"
              disabled={intake.isPending}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="mr-1.5 h-4 w-4" />
              {intake.isPending ? "Analysing…" : "Upload photos"}
            </Button>
          </>
        }
      />

      <Card className="mb-6 border-dashed p-4">
        <p className="text-sm text-muted-foreground" data-testid="text-ai-disclaimer">
          Detection engine: <strong data-testid="text-engine">{engine || "stub (development)"}</strong>. Values shown are{" "}
          <strong>AI estimates — not appraisals</strong>. Heirloom flags are suggestions only; the
          captain confirms every heirloom on the Groupings page.
        </p>
      </Card>

      {intake.isPending && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="loading-detections">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {detections.length > 0 && (
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-muted-foreground" data-testid="text-detection-count">
            {detections.length} detection(s) awaiting review
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="button-discard-all"
              onClick={() => setDetections([])}
            >
              Discard all
            </Button>
            <Button
              size="sm"
              data-testid="button-approve-all"
              disabled={approve.isPending}
              onClick={() => approve.mutate(detections)}
            >
              {approve.isPending ? "Adding…" : "Approve all"}
            </Button>
          </div>
        </div>
      )}

      {detections.length === 0 && !intake.isPending ? (
        <Card className="p-10 text-center" data-testid="text-empty-detections">
          <p className="font-serif text-lg">No detections waiting</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Upload one or more photographs — or use the demo photo — to see the review cards.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {detections.map((d) => (
            <Card key={d.tempId} data-testid={`card-detection-${d.tempId}`}>
              <CardContent className="space-y-3 p-4">
                <div className="flex gap-3">
                  <img
                    src={d.thumbnailUrl}
                    alt={d.name}
                    className="h-20 w-28 shrink-0 rounded-sm object-cover"
                    data-testid={`img-detection-${d.tempId}`}
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Input
                      value={d.name}
                      data-testid={`input-detection-name-${d.tempId}`}
                      onChange={(e) => patch(d.tempId, { name: e.target.value })}
                    />
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {isCaptain && (
                        <Badge variant="secondary" data-testid={`text-detection-estimate-${d.tempId}`}>
                          AI est — not an appraisal: {money(d.aiEstimatedValue)}
                        </Badge>
                      )}
                      <span>confidence {(d.confidence * 100).toFixed(0)}%</span>
                      {d.duplicateOf && (
                        <Badge variant="destructive" data-testid={`badge-detection-duplicate-${d.tempId}`}>
                          Possible duplicate of “{d.duplicateOf}”
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                <RoomPicker
                  value={d.room}
                  onChange={(room) => patch(d.tempId, { room })}
                  idPrefix={`det-${d.tempId}`}
                />

                <div className="flex flex-wrap items-center gap-3">
                  <Select value={d.category} onValueChange={(v) => patch(d.tempId, { category: v })}>
                    <SelectTrigger className="w-[180px]" data-testid={`select-detection-category-${d.tempId}`}>
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      {enabledCategories.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={d.isHeirloomCandidate}
                      data-testid={`switch-detection-heirloom-${d.tempId}`}
                      onCheckedChange={(v) => patch(d.tempId, { isHeirloomCandidate: v })}
                    />
                    <Label className="text-xs">Likely heirloom</Label>
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`button-discard-${d.tempId}`}
                    onClick={() => setDetections((prev) => prev.filter((x) => x.tempId !== d.tempId))}
                  >
                    Discard
                  </Button>
                  <Button
                    size="sm"
                    data-testid={`button-approve-${d.tempId}`}
                    disabled={approve.isPending}
                    onClick={() => approve.mutate([d])}
                  >
                    Approve
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </AppShell>
  );
}
