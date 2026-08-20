import { parseHeirPermissions, isHelperParticipant, canHelperDo, type HeirCapability } from "@shared/schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAppState, useUser, STATE_KEY, money , useCanSeeValues } from "@/lib/app";
import { AppShell, PageHeader, LoadingRows } from "@/components/shell";
import { FlagToggles } from "@/components/classification-flags";
import { AskForAppraisalButton } from "@/components/ask-for-appraisal";
import { useSearch } from "wouter";
import { RoomPicker, TaxonomyPicker, useTaxonomy, TAXONOMY_KEY } from "@/components/room-picker";
import {
  CategoryChip,
  CategoryHistory,
  DiscussionBadge,
  HighValueSuggestion,
  useCanCategorize,
} from "@/components/category-chips";
import { UNCATEGORIZED_LABEL, type AiSuggestion } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
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

import type { Item } from "@shared/schema";
import {
  Camera,
  Copy,
  Download,
  Gem,
  Grid2X2,
  List,
  Mic,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";

const itemSchema = z.object({
  name: z.string().min(1, "A name is required"),
  room: z.string(),
  category: z.string(),  // "" means the item enters the pool uncategorized
  notes: z.string(),
  estimate: z.string(),
});
type ItemForm = z.infer<typeof itemSchema>;

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function useCsvExport() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/inventory/export.csv");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "estate-inventory.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: "Inventory exported", description: "estate-inventory.csv" }),
  });
}

function usePrintReport() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/print/report");
      const html = await res.text();
      const w = window.open("", "_blank");
      if (!w) {
        toast({ title: "Pop-up blocked", description: "Allow pop-ups to view the print report.", variant: "destructive" });
        return;
      }
      w.document.write(html);
      w.document.close();
    },
    onError: (e: Error) =>
      toast({ title: "Could not generate report", description: e.message, variant: "destructive" }),
  });
}

export default function InventoryPage() {
  const { data, isLoading } = useAppState();
  const { userId } = useUser();
  const { toast } = useToast();
  const [view, setView] = useState<"list" | "grid">("list");
  // Notifications deep-link here as /inventory?item=123.
  const searchString = useSearch();
  const focusItemId = Number(new URLSearchParams(searchString).get("item")) || null;
  useEffect(() => {
    if (!focusItemId) return;
    const el = document.getElementById(`item-${focusItemId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusItemId, isLoading]);
  const [search, setSearch] = useState("");
  const [roomFilter, setRoomFilter] = useState("all");
  const [catFilter, setCatFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [room, setRoom] = useState("");
  const quickRef = useRef<HTMLInputElement>(null);

  const me = data?.participants.find((p) => p.id === userId) ?? null;
  const isCaptain = !!me?.id && me.id === data?.session?.captainParticipantId;
  const canSeeValues = useCanSeeValues();
  // Every heir capability is its own toggle; the captain may always act.
  const perms = parseHeirPermissions(data?.session.heirPermissions);
  const isHelper = isHelperParticipant(me);
  const can = (c: HeirCapability) =>
    isCaptain || (isHelper && canHelperDo(c)) || !!perms[c];
  const inPractice = (data?.session.practiceMode ?? "off") !== "off";
  const { data: taxonomy } = useTaxonomy();
  const enabledCategories = (taxonomy ?? [])
    .filter((t) => t.kind === "category" && t.isEnabled)
    .map((t) => t.label);
  const [editCategoryFor, setEditCategoryFor] = useState<Item | null>(null);
  const [draftCategory, setDraftCategory] = useState("");
  const [editRoomFor, setEditRoomFor] = useState<Item | null>(null);
  const [draftRoom, setDraftRoom] = useState("");
  const [editTextFor, setEditTextFor] = useState<Item | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const [photoForId, setPhotoForId] = useState<number | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [voiceMemoForItem, setVoiceMemoForItem] = useState<Item | null>(null);
  const [voiceMemos, setVoiceMemos] = useState<Array<{ id: number; kind: string; url: string; label: string; durationMs: number | null; transcript: string }>>([]);
  const [loadingMemos, setLoadingMemos] = useState(false);
  const canCategorize = useCanCategorize();

  /* --- v6: the add form looks at the photograph before you save --- */
  const addPhotoRef = useRef<HTMLInputElement>(null);
  const [addPhotoUrl, setAddPhotoUrl] = useState<string | null>(null);
  const [addPhotoExif, setAddPhotoExif] = useState<{ lat: number; lon: number; takenAt: number | null } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiAssigned, setAiAssigned] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [aiHighValue, setAiHighValue] = useState<{ reason?: string } | null>(null);
  const [acceptHighValue, setAcceptHighValue] = useState(false);

  async function loadVoiceMemos(itemId: number) {
    setLoadingMemos(true);
    try {
      const res = await apiRequest("GET", `/api/items/${itemId}/media`);
      const all = await res.json();
      setVoiceMemos(all.filter((m: any) => m.kind === "audio"));
    } finally {
      setLoadingMemos(false);
    }
  }

  function resetAddAi() {
    setAddPhotoUrl(null);
    setAddPhotoExif(null);
    setAnalyzing(false);
    setAiAssigned(false);
    setAiSuggestions([]);
    setAiHighValue(null);
    setAcceptHighValue(false);
  }

  const form = useForm<ItemForm>({
    resolver: zodResolver(itemSchema),
    defaultValues: { name: "", room: "", category: "", notes: "", estimate: "" },
  });

  /**
   * Ask the analyser what it makes of the item as it currently stands. Safe to
   * call more than once — the last answer wins, and a failure just leaves the
   * item uncategorized.
   */
  async function runAddPreview(photoUrl: string | null) {
    setAnalyzing(true);
    try {
      const res = await apiRequest("POST", "/api/ai/analyze-preview", {
        name: form.getValues("name"),
        notes: form.getValues("notes"),
        room,
        photoUrl,
      });
      const a = (await res.json()) as {
        category: string | null;
        suggestions: AiSuggestion[];
        highValue: boolean;
        highValueReason?: string;
      };
      setAiSuggestions(a.suggestions ?? []);
      if (a.category) {
        form.setValue("category", a.category);
        setAiAssigned(true);
      } else {
        setAiAssigned(false);
      }
      setAiHighValue(a.highValue ? { reason: a.highValueReason } : null);
    } finally {
      setAnalyzing(false);
    }
  }

  const { capture: captureLocation } = useGeolocation();
  const addItem = useMutation({
    mutationFn: async (v: ItemForm & { photoUrl?: string | null; lat?: number | null; lon?: number | null; photoLat?: number | null; photoLon?: number | null; photoTakenAt?: number | null }) => {
      const res = await apiRequest("POST", "/api/items", {
        participantId: userId,
        name: v.name,
        room: v.room || room,
        category: v.category,
        notes: v.notes,
        aiEstimatedValue: v.estimate ? Number(v.estimate) : null,
        estimateSource: v.estimate ? "manual" : null,
        photoUrl: v.photoUrl ?? null,
        thumbnailUrl: v.photoUrl ?? null,
        lat: v.lat ?? null,
        lon: v.lon ?? null,
        photoLat: v.photoLat ?? null,
        photoLon: v.photoLon ?? null,
        photoTakenAt: v.photoTakenAt ?? null,
      });
      const created = await res.json();
      // The suggestion was accepted in the form, so make it stick on save.
      if (acceptHighValue && created?.id) {
        await apiRequest("POST", `/api/items/${created.id}/ai-high-value`, {
          accept: true,
          participantId: userId,
        });
      }
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      queryClient.invalidateQueries({ queryKey: TAXONOMY_KEY });
      toast({ title: "Item catalogued" });
      form.reset();
      setRoom("");
      resetAddAi();
      setAddOpen(false);
    },
    onError: (e: Error) =>
      toast({ title: "Could not add item", description: e.message, variant: "destructive" }),
  });

  const quickAdd = useMutation({
    mutationFn: async (file: File) => {
      const dataUrl = await readFile(file);
      const up = await apiRequest("POST", "/api/upload", { dataUrl });
      const { url } = await up.json();
      const loc = await captureLocation();
      const res = await apiRequest("POST", "/api/items", {
        participantId: userId,
        name: file.name.replace(/\.[a-z0-9]+$/i, "") || "Untitled item",
        room: room || "",
        category: "",
        notes: "Quick add — single photo",
        photoUrl: url,
        thumbnailUrl: url,
        lat: loc?.lat ?? null,
        lon: loc?.lon ?? null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Quick add complete", description: "Edit the details any time." });
    },
    onError: (e: Error) =>
      toast({ title: "Quick add failed", description: e.message, variant: "destructive" }),
  });

  const nominateHeirloom = useMutation({
    mutationFn: async (item: Item) => {
      const res = await apiRequest("PATCH", `/api/items/${item.id}`, {
        isHeirloomCandidate: !item.isHeirloomCandidate,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Heirloom nomination updated", description: "The captain confirms heirlooms on the Groupings page." });
    },
  });

  // Single-actor escalation. Optional reason; a hunch is enough.
  const flagForAppraisal = useMutation({
    mutationFn: async (input: { item: Item; reason?: string }) => {
      const res = await apiRequest("POST", "/api/appraisal/flag", {
        itemId: input.item.id,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({
        title: "Flagged for appraisal",
        description: "This item will be reviewed for professional appraisal before final numbers are settled.",
      });
    },
  });

  // Captain-only. Refused for owner-source rows.
  const unflagAppraisal = useMutation({
    mutationFn: async (nominationId: number) => {
      const res = await apiRequest("POST", `/api/appraisal/${nominationId}/revert`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Escalation undone" });
    },
  });

  const setCategory = useMutation({
    mutationFn: async (itemId: number) =>
      (
        await apiRequest("POST", `/api/items/${itemId}/category`, {
          category: draftCategory || null,
          participantId: userId,
        })
      ).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      queryClient.invalidateQueries({ queryKey: TAXONOMY_KEY });
      setEditCategoryFor(null);
      toast({ title: "Category updated" });
    },
    onError: (e: Error) =>
      toast({ title: "Not permitted", description: e.message, variant: "destructive" }),
  });

  const removeItem = useMutation({
    mutationFn: async (id: number) =>
      apiRequest("DELETE", `/api/items/${id}`, { participantId: userId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STATE_KEY }),
    onError: (e: Error) =>
      toast({ title: "Not permitted", description: e.message, variant: "destructive" }),
  });

  const saveRoom = useMutation({
    mutationFn: async (itemId: number) =>
      (
        await apiRequest("PATCH", `/api/items/${itemId}`, {
          room: draftRoom,
          participantId: userId,
        })
      ).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      queryClient.invalidateQueries({ queryKey: TAXONOMY_KEY });
      setEditRoomFor(null);
      toast({ title: "Room updated" });
    },
    onError: (e: Error) =>
      toast({ title: "Not permitted", description: e.message, variant: "destructive" }),
  });

  const setText = useMutation({
    mutationFn: async (itemId: number) =>
      (
        await apiRequest("PATCH", `/api/items/${itemId}`, {
          name: draftName,
          notes: draftNotes,
          participantId: userId,
        })
      ).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      setEditTextFor(null);
      toast({ title: "Item updated" });
    },
    onError: (e: Error) =>
      toast({ title: "Not permitted", description: e.message, variant: "destructive" }),
  });

  const setPhoto = useMutation({
    mutationFn: async ({ itemId, file }: { itemId: number; file: File }) => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const up = await apiRequest("POST", "/api/upload", {
        dataUrl,
        participantId: userId,
      });
      const { url } = (await up.json()) as { url: string };
      return (
        await apiRequest("PATCH", `/api/items/${itemId}/photo`, {
          photoUrl: url,
          participantId: userId,
        })
      ).json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Photograph saved" });
    },
    onError: (e: Error) =>
      toast({ title: "Not permitted", description: e.message, variant: "destructive" }),
  });

  const scanDupes = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/duplicates/scan", { participantId: userId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: STATE_KEY });
      toast({ title: "Duplicate scan complete" });
    },
    onError: (e: Error) =>
      toast({ title: "Scan blocked", description: e.message, variant: "destructive" }),
  });

  const csv = useCsvExport();

  const items = data?.items ?? [];
  const filtered = useMemo(
    () =>
      items.filter(
        (i) =>
          (roomFilter === "all" || i.room === roomFilter) &&
          (catFilter === "all" ||
            (catFilter === "__uncategorized__" ? !i.category : i.category === catFilter)) &&
          (search.trim() === "" || i.name.toLowerCase().includes(search.trim().toLowerCase())),
      ),
    [items, roomFilter, catFilter, search],
  );

  const rooms = Array.from(
    new Set([
      ...(taxonomy ?? []).filter((t) => t.kind === "room" && t.isEnabled).map((t) => t.label),
      ...items.map((i) => i.room),
    ]),
  ).filter(Boolean);
  const categoryOptions = Array.from(
    new Set([...enabledCategories, ...items.map((i) => i.category ?? "")]),
  ).filter(Boolean) as string[];
  const uncategorizedCount = items.filter((i) => !i.category).length;

  return (
    <AppShell>
      <PageHeader
        title="Inventory"
        subtitle="Everything tangible in the estate, room by room."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              data-testid="button-export-csv"
              disabled={csv.isPending}
              onClick={() => csv.mutate()}
            >
              <Download className="mr-1.5 h-4 w-4" />
              {csv.isPending ? "Preparing…" : "Export CSV"}
            </Button>
            {can("scanDuplicates") && (
            <Button
              variant="outline"
              size="sm"
              data-testid="button-scan-duplicates"
              disabled={scanDupes.isPending}
              onClick={() => scanDupes.mutate()}
            >
              <Copy className="mr-1.5 h-4 w-4" />
              {scanDupes.isPending ? "Scanning…" : "Scan duplicates"}
            </Button>
            )}
            {can("addItems") && (
            <>
            <Link href="/intake/batch" data-testid="link-batch-intake">
              <Button variant="outline" size="sm" data-testid="button-batch-intake" asChild>
                <span>
                  <Sparkles className="mr-1.5 h-4 w-4" />
                  Batch photo intake
                </span>
              </Button>
            </Link>
            <input
              ref={quickRef}
              type="file"
              accept="image/*"
              className="hidden"
              data-testid="input-quick-add-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) quickAdd.mutate(f);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              data-testid="button-quick-add"
              disabled={quickAdd.isPending}
              onClick={() => quickRef.current?.click()}
            >
              <Camera className="mr-1.5 h-4 w-4" />
              {quickAdd.isPending ? "Uploading…" : "Quick add"}
            </Button>
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <Button size="sm" data-testid="button-open-add-item">
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add item
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="font-serif">Add an item</DialogTitle>
                  <DialogDescription>
                    Record one piece of tangible property. Photographs and values are optional.
                  </DialogDescription>
                </DialogHeader>
                <Form {...form}>
                  <form
                    className="space-y-4"
                    data-testid="form-add-item"
                    onSubmit={form.handleSubmit(async (v) => {
                      const loc = await captureLocation();
                      addItem.mutate({ ...v, room: room || v.room, photoUrl: addPhotoUrl, lat: loc?.lat ?? null, lon: loc?.lon ?? null, photoLat: addPhotoExif?.lat ?? null, photoLon: addPhotoExif?.lon ?? null, photoTakenAt: addPhotoExif?.takenAt ?? null });
                    })}
                  >
                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Item</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="Walnut dining table"
                              data-testid="input-item-name"
                              {...field}
                              onBlur={(e) => {
                                field.onBlur();
                                // People often attach the photograph before
                                // typing a name; take a second look once the
                                // name arrives.
                                if (addPhotoUrl && !analyzing && e.target.value.trim()) {
                                  void runAddPreview(addPhotoUrl);
                                }
                              }}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <RoomPicker value={room} onChange={setRoom} idPrefix="add-room" />

                    {/* A photograph is optional, but it lets the app propose a
                        category before the form is even saved. */}
                    <div className="space-y-1.5">
                      <Label>Photograph (optional)</Label>
                      <div className="flex flex-wrap items-center gap-2">
                        {addPhotoUrl && (
                          <img
                            src={addPhotoUrl}
                            alt="Item"
                            className="h-14 w-20 rounded-sm object-cover"
                            data-testid="img-add-photo-preview"
                          />
                        )}
                        <input
                          ref={addPhotoRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          data-testid="input-add-photo"
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            e.target.value = "";
                            if (!f) return;
                            try {
                              const dataUrl = await readFile(f);
                              const up = await apiRequest("POST", "/api/upload", {
                                dataUrl,
                                participantId: userId,
                              });
                              const { url } = (await up.json()) as { url: string };
                              setAddPhotoUrl(url);
                              setAddPhotoExif(await extractExifGps(f));
                              await runAddPreview(url);
                            } catch (err) {
                              toast({
                                title: "Could not read the photograph",
                                description: (err as Error).message,
                                variant: "destructive",
                              });
                            } finally {
                              setAnalyzing(false);
                            }
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="button-add-photo"
                          onClick={() => addPhotoRef.current?.click()}
                        >
                          <Camera className="mr-1.5 h-4 w-4" />
                          {addPhotoUrl ? "Replace photograph" : "Attach a photograph"}
                        </Button>
                      </div>
                    </div>

                    <FormField
                      control={form.control}
                      name="category"
                      render={({ field }) => (
                        <FormItem>
                          <div className="flex items-center gap-2">
                            <TaxonomyPicker
                              kind="category"
                              value={field.value}
                              onChange={(v: string) => {
                                setAiAssigned(false);
                                field.onChange(v);
                              }}
                              idPrefix="add-category"
                            />
                          </div>
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            {analyzing && (
                              <span
                                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                                data-testid="text-ai-analyzing"
                              >
                                <Sparkles className="h-3.5 w-3.5 animate-pulse" />
                                AI analyzing…
                              </span>
                            )}
                            {!analyzing && aiAssigned && (
                              <Badge
                                variant="outline"
                                className="border-primary/50 text-primary"
                                data-testid="badge-ai-category"
                              >
                                <Sparkles className="mr-1 h-3 w-3" />
                                AI · {field.value || "no category"}
                              </Badge>
                            )}
                            {!analyzing && !field.value && (
                              <span
                                className="text-xs text-muted-foreground"
                                data-testid="text-add-uncategorized"
                              >
                                — uncategorized — (that is perfectly fine)
                              </span>
                            )}
                            {!analyzing &&
                              !aiAssigned &&
                              aiSuggestions.slice(0, 3).map((sug) => (
                                <button
                                  key={sug.category}
                                  type="button"
                                  data-testid={`chip-add-suggestion-${sug.category}`}
                                  className="rounded-full border border-border px-2 py-0.5 text-[11px] hover-elevate"
                                  onClick={() => field.onChange(sug.category)}
                                >
                                  {sug.category} {Math.round(sug.confidence * 100)}%
                                </button>
                              ))}
                          </div>
                          {aiHighValue && !acceptHighValue && (
                            <div
                              className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-[#c9a227]/50 bg-[#fdf3d0]/50 px-2.5 py-1.5 text-xs dark:bg-[#3a3007]/40"
                              data-testid="suggestion-add-high-value"
                            >
                              <span className="min-w-0 flex-1">
                                AI thinks this might be high value
                                {aiHighValue.reason ? `: ${aiHighValue.reason}` : "."} Mark as
                                high-value?
                              </span>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                data-testid="button-add-accept-high-value"
                                onClick={() => setAcceptHighValue(true)}
                              >
                                Yes
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                data-testid="button-add-dismiss-high-value"
                                onClick={() => setAiHighValue(null)}
                              >
                                Dismiss
                              </Button>
                            </div>
                          )}
                          {acceptHighValue && (
                            <p
                              className="mt-2 text-xs text-muted-foreground"
                              data-testid="text-add-high-value-accepted"
                            >
                              Will be marked high-value on save.
                            </p>
                          )}
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="estimate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Estimated value (optional)</FormLabel>
                          <FormControl>
                            <Input
                              inputMode="decimal"
                              placeholder="450"
                              data-testid="input-item-estimate"
                              {...field}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="notes"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Notes</FormLabel>
                          <FormControl>
                            <Textarea
                              rows={3}
                              placeholder="Condition, provenance, who gave it…"
                              data-testid="input-item-notes"
                              {...field}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <div className="flex justify-end">
                      <Button type="submit" disabled={addItem.isPending} data-testid="button-submit-item">
                        {addItem.isPending ? "Saving…" : "Add to inventory"}
                      </Button>
                    </div>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
            </>
            )}
          </>
        }
      />

      <Card className="mb-6 border-primary/30 bg-primary/[0.03]" data-testid="card-inventory-flag-guide">
        <CardContent className="p-5 md:p-6">
          <h2 className="font-serif text-lg font-semibold md:text-xl">
            Flag the items that matter most
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground md:text-base">
            As you catalogue and review items, mark each one as{" "}
            <span className="font-medium text-foreground">High value</span>,{" "}
            <span className="font-medium text-foreground">Heirloom</span>, or leave it as{" "}
            <span className="font-medium text-foreground">Other</span>. The three groups get their
            own draft rounds after the main draft, so anything special goes through its own
            fair-choice pass instead of getting swept up with everyday belongings.
          </p>
        </CardContent>
      </Card>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search items"
            value={search}
            data-testid="input-search"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={roomFilter} onValueChange={setRoomFilter}>
          <SelectTrigger className="w-[170px]" data-testid="select-filter-room">
            <SelectValue placeholder="All rooms" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All rooms</SelectItem>
            {rooms.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="w-[170px]" data-testid="select-filter-category">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            <SelectItem value="__uncategorized__" data-testid="option-filter-uncategorized">
              {UNCATEGORIZED_LABEL} ({uncategorizedCount})
            </SelectItem>
            {categoryOptions.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant={view === "list" ? "default" : "outline"}
            data-testid="button-view-list"
            onClick={() => setView("list")}
            aria-label="List view"
          >
            <List className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant={view === "grid" ? "default" : "outline"}
            data-testid="button-view-grid"
            onClick={() => setView("grid")}
            aria-label="Grid view"
          >
            <Grid2X2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <LoadingRows rows={5} />
      ) : filtered.length === 0 ? (
        <Card className="p-10 text-center" data-testid="text-empty-inventory">
          <p className="font-serif text-lg">Nothing catalogued yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Add an item by hand, snap a quick photo, or run a batch photo intake to begin.
          </p>
        </Card>
      ) : (
        <div
          className={view === "grid" ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3" : "space-y-2"}
          data-testid="list-items"
        >
          {filtered.map((i) => {
            // Escalation row (if any). "Active" = not reverted; reverted rows
            // stay in nominationsList for the audit trail but must not gate UI.
            const escalations = data?.nominations.filter((n) => n.itemId === i.id) ?? [];
            const activeEscalation = escalations.find((n) => n.revertedAt == null);
            const lastRevertedEscalation = [...escalations]
              .filter((n) => n.revertedAt != null)
              .sort((a, b) => (b.revertedAt ?? 0) - (a.revertedAt ?? 0))[0];
            const owner = data?.participants.find((p) => p.id === i.awardedToParticipantId);
            return (
              <Card
                key={i.id}
                id={`item-${i.id}`}
                data-testid={`card-item-${i.id}`}
                className={`scroll-mt-28 ${
                  focusItemId === i.id ? "border-primary ring-1 ring-primary" : ""
                }`}
              >
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                  {i.thumbnailUrl && (
                    <img
                      src={i.thumbnailUrl}
                      alt={i.name}
                      className="h-16 w-24 shrink-0 rounded-sm object-cover"
                      data-testid={`img-item-${i.id}`}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium" data-testid={`text-item-name-${i.id}`}>
                        {i.name}
                      </span>
                      {i.room && (
                        <Badge variant="secondary" data-testid={`badge-item-room-${i.id}`}>
                          {i.room}
                        </Badge>
                      )}
                      <CategoryChip item={i} idPrefix="inv" />
                      <DiscussionBadge item={i} />
                      {i.isHeirloomCandidate && (
                        <Badge
                          variant="outline"
                          className="border-primary text-primary"
                          data-testid={`badge-heirloom-${i.id}`}
                        >
                          {i.isHeirloomConfirmed ? "Heirloom ✓" : "Heirloom nominated"}
                        </Badge>
                      )}
                      {i.needsAppraisal && (
                        <Badge variant="destructive" data-testid={`badge-needs-appraisal-${i.id}`}>
                          Flagged for appraisal
                        </Badge>
                      )}
                      {i.isSentimental && (
                        <Badge variant="outline" data-testid={`badge-flag-sentimental-${i.id}`}>
                          Sentimental
                        </Badge>
                      )}
                      {i.status === "needs_appraisal" && (
                        <Badge data-testid={`badge-appraisal-pool-${i.id}`}>Appraisal review list</Badge>
                      )}
                      {i.status === "awarded" && (
                        <Badge variant="secondary" data-testid={`badge-awarded-${i.id}`}>
                          Awarded to {owner?.name ?? "—"} (round {i.awardedInRound})
                        </Badge>
                      )}
                      {i.duplicateGroupId && (
                        <Badge variant="destructive" data-testid={`badge-duplicate-${i.id}`}>
                          Possible duplicate
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {canSeeValues && (
                        <span data-testid={`text-item-value-${i.id}`}>
                          {i.estimateSource === "ai" ? "AI est — not an appraisal: " : "Est. value: "}
                          {money(i.aiEstimatedValue)}
                        </span>
                      )}
                      {i.notes && (
                        <span>
                          {canSeeValues ? " · " : ""}
                          {i.notes}
                        </span>
                      )}
                    </div>
                    {/* Owner's story and voice memo indicators — these come
                        from the Registry import and are visible to all
                        participants. They surface what the deceased owner
                        said about the item before death. */}
                    {i.inventoryStory && (
                      <div className="mt-1 text-xs text-muted-foreground italic" data-testid={`text-item-story-${i.id}`}>
                        <span className="font-medium not-italic">Owner's story: </span>
                        {i.inventoryStory}
                      </div>
                    )}
                    {i.ownerImportantComment && (
                      <div className="mt-1 text-xs text-muted-foreground italic" data-testid={`text-item-important-comment-${i.id}`}>
                        <span className="font-medium not-italic">Why it matters: </span>
                        {i.ownerImportantComment}
                      </div>
                    )}
                    {(i.audioCount > 0 || i.photoCount > 1) && (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {i.audioCount > 0 && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium hover:bg-accent cursor-pointer"
                            data-testid={`badge-voice-memo-${i.id}`}
                            onClick={() => {
                              setVoiceMemoForItem(i);
                              loadVoiceMemos(i.id);
                            }}
                          >
                            <Mic className="h-3 w-3" />
                            {i.audioCount} voice memo{i.audioCount > 1 ? "s" : ""}
                          </button>
                        )}
                        {i.photoCount > 1 && (
                          <Badge variant="outline" className="gap-1 text-xs" data-testid={`badge-photos-${i.id}`}>
                            <Camera className="h-3 w-3" />
                            {i.photoCount} photos
                          </Badge>
                        )}
                      </div>
                    )}
                    {activeEscalation && (activeEscalation.reason || activeEscalation.flaggedBySource === "ai") && (
                      <div
                        className="mt-1 text-xs text-muted-foreground"
                        data-testid={`text-appraisal-reason-${i.id}`}
                      >
                        <span className="font-medium">Flagged for appraisal: </span>
                        {activeEscalation.reason || "(no reason given)"}
                        {activeEscalation.flaggedBySource === "ai" && (
                          <span> — AI estimate, not an official appraisal.</span>
                        )}
                      </div>
                    )}
                    {lastRevertedEscalation && !activeEscalation && (
                      <div
                        className="mt-1 text-xs text-muted-foreground italic"
                        data-testid={`text-appraisal-reverted-${i.id}`}
                      >
                        Previously escalated, undone by captain.
                      </div>
                    )}
                    <HighValueSuggestion item={i} />
                    <div className="mt-2">
                      <FlagToggles item={i} compact />
                    </div>
                    <CategoryHistory itemId={i.id} />
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`button-nominate-heirloom-${i.id}`}
                      disabled={nominateHeirloom.isPending}
                      onClick={() => nominateHeirloom.mutate(i)}
                    >
                      <Gem className="mr-1.5 h-3.5 w-3.5" />
                      {i.isHeirloomCandidate ? "Withdraw" : "Heirloom"}
                    </Button>
                    {!activeEscalation ? (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`button-flag-appraisal-${i.id}`}
                        disabled={!userId || inPractice || flagForAppraisal.isPending}
                        onClick={() => flagForAppraisal.mutate({ item: i })}
                        title="Flag this item for a real appraisal. Your hunch is enough — no need to justify it."
                      >
                        I think this needs a look
                      </Button>
                    ) : (
                      isCaptain &&
                      activeEscalation.flaggedBySource !== "owner" && (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`button-unflag-appraisal-${i.id}`}
                          disabled={unflagAppraisal.isPending}
                          onClick={() => unflagAppraisal.mutate(activeEscalation.id)}
                          title="Take this off the appraisal list. The flag stays in the audit trail."
                        >
                          Undo appraisal flag
                        </Button>
                      )
                    )}
                    {userId && !inPractice && (
                      <AskForAppraisalButton item={i} />
                    )}
                    {can("changeCategory") && canCategorize && (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`button-edit-category-${i.id}`}
                        onClick={() => {
                          setEditCategoryFor(i);
                          setDraftCategory(i.category ?? "");
                        }}
                      >
                        {i.category ? "Category" : "Set category"}
                      </Button>
                    )}
                    {can("changeRoom") && (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`button-edit-room-${i.id}`}
                        onClick={() => {
                          setEditRoomFor(i);
                          setDraftRoom(i.room);
                        }}
                      >
                        {i.room ? "Room" : "Set room"}
                      </Button>
                    )}
                    {can("editItemNamesNotes") && (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`button-edit-text-${i.id}`}
                        onClick={() => {
                          setEditTextFor(i);
                          setDraftName(i.name);
                          setDraftNotes(i.notes);
                        }}
                      >
                        Edit
                      </Button>
                    )}
                    {can("uploadPhotos") && (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`button-photo-item-${i.id}`}
                        disabled={setPhoto.isPending && photoForId === i.id}
                        onClick={() => {
                          setPhotoForId(i.id);
                          photoRef.current?.click();
                        }}
                      >
                        <Camera className="mr-1.5 h-3.5 w-3.5" />
                        {i.photoUrl ? "Replace photo" : "Add photo"}
                      </Button>
                    )}
                    {(isCaptain ||
                      (can("deleteOwnItems") && i.createdByParticipantId === userId)) && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Remove item"
                        data-testid={`button-delete-item-${i.id}`}
                        onClick={() => removeItem.mutate(i.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {can("resolveDuplicates") &&
        (data?.duplicateGroups ?? []).filter((d) => d.status === "open").length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 font-serif text-lg" data-testid="text-duplicates-heading">
            Possible duplicates
          </h2>
          <div className="space-y-3">
            {(data?.duplicateGroups ?? [])
              .filter((d) => d.status === "open")
              .map((dg) => {
                const members = items.filter((i) => i.duplicateGroupId === dg.id);
                return (
                  <Card key={dg.id} className="p-4" data-testid={`card-duplicate-${dg.id}`}>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                      Keep one — nothing is deleted until you choose
                    </Label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {members.map((m) => (
                        <Button
                          key={m.id}
                          size="sm"
                          variant="outline"
                          data-testid={`button-keep-item-${m.id}`}
                          onClick={async () => {
                            await apiRequest("POST", `/api/duplicates/${dg.id}/resolve`, {
                              keepItemId: m.id,
                              participantId: userId,
                            });
                            queryClient.invalidateQueries({ queryKey: STATE_KEY });
                          }}
                        >
                          Keep “{m.name}” (#{m.id})
                        </Button>
                      ))}
                    </div>
                  </Card>
                );
              })}
          </div>
        </div>
      )}
      <Dialog
        open={!!editCategoryFor}
        onOpenChange={(o) => {
          if (!o) setEditCategoryFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-serif">Assign a category</DialogTitle>
            <DialogDescription>{editCategoryFor?.name}</DialogDescription>
          </DialogHeader>
          <TaxonomyPicker
            kind="category"
            value={draftCategory}
            onChange={setDraftCategory}
            idPrefix="edit-category"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              data-testid="button-save-category"
              disabled={setCategory.isPending}
              onClick={() => editCategoryFor && setCategory.mutate(editCategoryFor.id)}
            >
              {setCategory.isPending ? "Saving…" : "Save category"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Change an item's room */}
      <Dialog
        open={!!editRoomFor}
        onOpenChange={(o) => {
          if (!o) setEditRoomFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-serif">Assign a room</DialogTitle>
            <DialogDescription>{editRoomFor?.name}</DialogDescription>
          </DialogHeader>
          <TaxonomyPicker
            kind="room"
            value={draftRoom}
            onChange={setDraftRoom}
            idPrefix="edit-room"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              data-testid="button-save-room"
              disabled={saveRoom.isPending}
              onClick={() => editRoomFor && saveRoom.mutate(editRoomFor.id)}
            >
              {saveRoom.isPending ? "Saving…" : "Save room"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit an item's name and notes */}
      <Dialog
        open={!!editTextFor}
        onOpenChange={(o) => {
          if (!o) setEditTextFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-serif">Edit name and notes</DialogTitle>
            <DialogDescription>Corrections to the description only.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Name</Label>
              <Input
                className="mt-1"
                value={draftName}
                data-testid="input-edit-name"
                onChange={(e) => setDraftName(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Notes
              </Label>
              <Textarea
                className="mt-1"
                rows={3}
                value={draftNotes}
                data-testid="input-edit-notes"
                onChange={(e) => setDraftNotes(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              data-testid="button-save-text"
              disabled={setText.isPending || !draftName.trim()}
              onClick={() => editTextFor && setText.mutate(editTextFor.id)}
            >
              {setText.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Voice memo playback — heirs can listen to the deceased owner's
          voice memos that traveled from Registry. These are irreplaceable. */}
      <Dialog open={!!voiceMemoForItem} onOpenChange={(open) => { if (!open) { setVoiceMemoForItem(null); setVoiceMemos([]); } }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-serif">Voice memos</DialogTitle>
            <DialogDescription>
              {voiceMemoForItem ? `Recorded notes for "${voiceMemoForItem.name}"` : ""}
            </DialogDescription>
          </DialogHeader>
          {loadingMemos ? (
            <div className="py-8 text-center text-muted-foreground">Loading recordings…</div>
          ) : voiceMemos.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">No voice memos for this item.</div>
          ) : (
            <div className="space-y-4">
              {voiceMemos.map((m) => (
                <div key={m.id} className="rounded-lg border p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <Mic className="h-4 w-4 text-muted-foreground" />
                    {m.label || `Recording ${m.id}`}
                    {m.durationMs != null && (
                      <span className="text-xs text-muted-foreground">
                        ({Math.floor(m.durationMs / 1000)}s)
                      </span>
                    )}
                  </div>
                  <audio controls className="w-full" src={m.url} />
                  {m.transcript && (
                    <p className="mt-2 text-xs italic text-muted-foreground">{m.transcript}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <input
        ref={photoRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid="input-item-photo-file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && photoForId !== null) setPhoto.mutate({ itemId: photoForId, file: f });
          e.target.value = "";
        }}
      />
    </AppShell>
  );
}
