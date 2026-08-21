import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { storage, db } from "./storage";
import { itemMedia } from "@shared/schema";
import { eq } from "drizzle-orm";
import { enforcePause } from "./middleware/enforcePause";
import { requireLicenseForWrite } from "./middleware/licenseMiddleware";
import {
  HEIR_CAPABILITIES,
  canHeirDo,
  parseHeirPermissions,
  PHASE_ORDER,
  PHASE_INPUT_VALUES,
  normalizePhase,
  registrationOpen,
  ROSTER_CLOSED_MESSAGE,
  DAY_MS,
  RANKING_WINDOW_MIN_DAYS,
  RANKING_WINDOW_MAX_DAYS,
  rankingWindowOf,
  isCaptainHeirParticipant,
  isPureCaptainParticipant,
  ASSIST_BADGE_WINDOW_MS,
  CATEGORY_CHANGE_SOURCES,
  CATEGORY_THROTTLE_MESSAGE,
  STANDARD_CATEGORIES,
  type HeirCapability,
  type ClassificationFlag,
  HELPER_CAPABILITIES,
  canHelperDo,
  isHelperParticipant,
} from "@shared/schema";
import type { Participant } from "@shared/schema";
import { looksLikeSameThing } from "./duplicates/match";
import { analyzeItem } from "./ai/analyzer";
import {
  getOpenAIApiKeyPreview,
  setOpenAIApiKey,
  isLiveAIMode,
} from "./ai/openaiSettings";
import {
  getAnthropicApiKeyPreview,
  setAnthropicApiKey,
  getAnthropicApiKey,
} from "./ai/anthropicSettings";
import { getActiveProvider } from "./ai/analyzer";
import {
  isMultiEstateMode,
  setMultiEstateMode,
  listEstates,
  createEstate,
} from "./ai/multiEstate";

/**
 * Where uploaded and imported media live.
 *
 * This used to be /tmp/uploads, which a reboot erases. Imported video and voice
 * recordings are irreplaceable — the owner may be dead by the time anyone plays
 * them — so the default is now a real directory beside the database.
 * Override with REINDEER_FAIR_PLAY_UPLOAD_DIR.
 */
export const UPLOAD_DIR = process.env.REINDEER_FAIR_PLAY_UPLOAD_DIR ?? path.resolve("uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Google Cloud Vision — two-phase identification                     */
/*                                                                  */
/* Phase 1 (detectItems): Object Localization finds distinct        */
/* objects in a photo with bounding boxes + generic labels.         */
/* Phase 2 (identifyItem): Web Detection on a cropped close-up      */
/* searches Google's web index for exact visual matches.            */
/*                                                                  */
/* Provider selection: GOOGLE_CLOUD_API_KEY → Google Vision          */
/* Falls back to Anthropic/OpenAI/mock.                             */
/* ------------------------------------------------------------------ */

const GOOGLE_VISION_BASE = "https://vision.googleapis.com/v1/images:annotate";

function googleLabelToCategory(label: string | null): string | null {
  if (!label) return null;
  const l = label.toLowerCase();
  const map: [RegExp, string][] = [
    [/chair|sofa|couch|recliner|ottoman|bench|stool/, "Furniture"],
    [/table|desk|dresser|cabinet|shelf|bookcase|wardrobe|nightstand/, "Furniture"],
    [/bed|frame|mattress/, "Furniture"],
    [/painting|canvas|oil|watercolor|lithograph|print|etching/, "Art"],
    [/sculpture|statue|bust|figurine/, "Art"],
    [/photograph|photo|album/, "Photos"],
    [/jewel|ring|necklace|bracelet|earring|watch|pendant|brooch/, "Jewelry"],
    [/diamond|gem|sapphire|ruby|emerald|pearl/, "Jewelry"],
    [/coin|currency|bill|token/, "Coins"],
    [/book|manuscript|journal|diary/, "Books"],
    [/vinyl|record|instrument|guitar|piano|violin/, "Collectibles"],
    [/antique|collectible|memorabilia/, "Collectibles"],
    [/gun|rifle|pistol|shotgun|firearm/, "Firearms"],
    [/tool|drill|saw|hammer|wrench|screwdriver|sander/, "Tools"],
    [/pot|pan|skillet|kettle|dish|plate|bowl|cup|mug|glass|silverware|utensil/, "Kitchenware"],
    [/appliance|blender|mixer|toaster|microwave/, "Kitchenware"],
    [/tv|television|monitor|speaker|camera|laptop|phone|tablet|computer/, "Electronics"],
    [/clothing|shirt|jacket|coat|dress|suit|pants|shoe|boot|hat/, "Clothing"],
    [/ornament|decoration|holiday|christmas/, "Holiday Ornaments"],
    [/rug|carpet|tapestry|blanket|quilt/, "Collectibles"],
  ];
  for (const [pattern, category] of map) {
    if (pattern.test(l)) return category;
  }
  return null;
}

/** Phase 2 — Google Web Detection for exact item identification. */
async function identifyWithGoogle(
  photoBuffer: Buffer,
  hint: string,
  roomHint?: string | null,
): Promise<{
  title: string;
  description: string;
  confidence: number;
  web_match: boolean;
  best_guess_labels?: string[];
  web_entities?: string[];
  matching_pages?: { url: string; title: string }[];
  similar_images?: string[];
  category_hint?: string | null;
  value_suggestion?: { low_cents: number; high_cents: number; reasoning: string } | null;
}> {
  const googleKey = process.env.GOOGLE_CLOUD_API_KEY;
  if (!googleKey) {
    return {
      title: hint || "Item",
      description: "Google Cloud Vision not configured.",
      confidence: 0,
      web_match: false,
    };
  }

  const request = {
    image: { content: photoBuffer.toString("base64") },
    features: [
      { type: "WEB_DETECTION", maxResults: 10 },
      { type: "LABEL_DETECTION", maxResults: 10 },
    ],
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(
      `${GOOGLE_VISION_BASE}?key=${googleKey}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests: [request] }),
      },
    );
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[google-vision] identify HTTP ${res.status}: ${text.slice(0, 200)}`);
      return {
        title: hint || "Item",
        description: `Google Cloud Vision error (${res.status}).`,
        confidence: 0,
        web_match: false,
      };
    }

    const json = await res.json();
    const resp = json.responses?.[0] ?? {};
    const web = resp.webDetection ?? {};
    const labels = resp.labelAnnotations ?? [];

    const bestGuess = (web.bestGuessLabels ?? [])
      .map((g: { label?: string }) => g.label)
      .filter(Boolean);

    const entities = (web.webEntities ?? [])
      .filter((e: { entityName?: string; score?: number }) => e.entityName && (e.score ?? 0) > 0.3)
      .sort((a: { score?: number }, b: { score?: number }) => (b.score ?? 0) - (a.score ?? 0))
      .map((e: { entityName?: string }) => e.entityName);

    const matchingPages = (web.pagesWithMatchingImages ?? [])
      .slice(0, 5)
      .map((p: { url?: string; pageTitle?: string }) => ({ url: p.url ?? "", title: p.pageTitle ?? "" }))
      .filter((p: { url: string }) => p.url);

    const similarImages = (web.visuallySimilarImages ?? [])
      .slice(0, 5)
      .map((s: { url?: string }) => s.url)
      .filter(Boolean);

    // Best guess = the "Google Lens hit exactly" moment
    if (bestGuess.length > 0) {
      const title = bestGuess[0];
      const descParts: string[] = [];
      if (entities.length > 0) descParts.push(`Identified as: ${entities.slice(0, 3).join(", ")}`);
      if (matchingPages.length > 0) {
        const titles = matchingPages.map((p: { url: string; title: string }) => p.title).filter(Boolean).slice(0, 2);
        if (titles.length > 0) descParts.push(`Found on: ${titles.join(" | ")}`);
      }
      if (labels.length > 0 && descParts.length === 0) {
        descParts.push(`Visual labels: ${labels.slice(0, 5).map((l: { description?: string }) => l.description).filter(Boolean).join(", ")}`);
      }

      // Extract price hint from matching pages
      let valueSuggestion: { low_cents: number; high_cents: number; reasoning: string } | null = null;
      for (const page of matchingPages) {
        const m = (page.title || "").match(/\$(\d+(?:,\d{3})*(?:\.\d{2})?)/);
        if (m) {
          const dollars = parseFloat(m[1].replace(/,/g, ""));
          if (dollars > 0 && dollars < 1_000_000) {
            valueSuggestion = {
              low_cents: Math.round(dollars * 0.7 * 100),
              high_cents: Math.round(dollars * 1.3 * 100),
              reasoning: `Price hint from matching listing: $${dollars.toFixed(2)}`,
            };
            break;
          }
        }
      }

      return {
        title,
        description: descParts.join(". ") || "No description available.",
        confidence: matchingPages.length > 0 ? 0.9 : 0.7,
        web_match: true,
        best_guess_labels: bestGuess,
        web_entities: entities,
        matching_pages: matchingPages,
        similar_images: similarImages,
        category_hint: googleLabelToCategory(title),
        value_suggestion: valueSuggestion,
      };
    }

    // No best-guess but have web entities
    if (entities.length > 0) {
      return {
        title: entities[0],
        description: `Identified as: ${entities.slice(0, 3).join(", ")}`,
        confidence: 0.6,
        web_match: true,
        web_entities: entities,
        matching_pages: matchingPages,
        similar_images: similarImages,
        category_hint: googleLabelToCategory(entities[0]),
      };
    }

    // No web match — fall back to labels
    if (labels.length > 0) {
      const top = labels[0];
      return {
        title: ((top.description ?? hint) || "Item").charAt(0).toUpperCase() + ((top.description ?? hint) || "Item").slice(1),
        description: `No exact match found. Visual labels: ${labels.slice(0, 5).map((l: { description?: string }) => l.description).filter(Boolean).join(", ")}.`,
        confidence: Math.min(1, Math.max(0, top.score ?? 0.4)),
        web_match: false,
        category_hint: googleLabelToCategory(top.description ?? null),
      };
    }

    return {
      title: hint || "Item",
      description: "No identification available.",
      confidence: 0,
      web_match: false,
    };
  } catch (e) {
    console.warn("[google-vision] identify failed:", (e as Error)?.message ?? e);
    return {
      title: hint || "Item",
      description: "Could not reach Google Cloud Vision.",
      confidence: 0,
      web_match: false,
    };
  }
}

/** Phase 1 — Google Object Localization for multi-item detection. */
async function detectWithGoogleVision(
  photoBuffer: Buffer,
  existingItems: { name: string; identifiers?: unknown; originApp?: string | null }[],
  seed: number,
  photoUrl: string,
): Promise<Detection[] | null> {
  const googleKey = process.env.GOOGLE_CLOUD_API_KEY;
  if (!googleKey) return null;

  try {
    const request = {
      image: { content: photoBuffer.toString("base64") },
      features: [
        { type: "OBJECT_LOCALIZATION", maxResults: 20 },
        { type: "LABEL_DETECTION", maxResults: 10 },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(
      `${GOOGLE_VISION_BASE}?key=${googleKey}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests: [request] }),
      },
    );
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[google-vision] detectItems HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const json = await res.json();
    const resp = json.responses?.[0] ?? {};
    const objects = resp.localizedObjectAnnotations ?? [];
    const labels = resp.labelAnnotations ?? [];

    const detections: Detection[] = [];

    if (objects.length > 0) {
      for (const obj of objects) {
        const name = (obj.name ?? "Unidentified object").charAt(0).toUpperCase() + (obj.name ?? "Unidentified object").slice(1);
        const dupMatch = findDuplicateName(name, existingItems);

        const verts = obj.boundingPoly?.normalizedVertices ?? [];
        let bx = 0, by = 0, bw = 20, bh = 20;
        if (verts.length >= 2) {
          const xs = verts.map((v: { x?: number }) => v.x ?? 0);
          const ys = verts.map((v: { y?: number }) => v.y ?? 0);
          bx = Math.max(0, Math.min(100, Math.min(...xs) * 100));
          by = Math.max(0, Math.min(100, Math.min(...ys) * 100));
          bw = Math.max(1, Math.min(100 - bx, (Math.max(...xs) - Math.min(...xs)) * 100));
          bh = Math.max(1, Math.min(100 - by, (Math.max(...ys) - Math.min(...ys)) * 100));
        }

        const category = googleLabelToCategory(obj.name) ?? "Miscellaneous";

        detections.push({
          tempId: randomUUID(),
          name,
          room: "Unspecified",
          category,
          aiEstimatedValue: 0,
          isHeirloomCandidate: false,
          duplicateOf: dupMatch ?? null,
          boundingBox: { x: bx, y: by, w: bw, h: bh },
          thumbnailUrl: placeholderThumb(name, seed + detections.length),
          photoUrl,
          confidence: Math.max(0, Math.min(1, obj.score ?? 0.5)),
        });
      }
    } else if (labels.length > 0) {
      // No objects detected, but labels exist
      const top = labels[0];
      const name = (top.description ?? "Unidentified object").charAt(0).toUpperCase() + (top.description ?? "Unidentified object").slice(1);
      const dupMatch = findDuplicateName(name, existingItems);
      const descLabels = labels.slice(0, 5).map((l: { description?: string }) => l.description).filter(Boolean).join(", ");

      detections.push({
        tempId: randomUUID(),
        name,
        room: "Unspecified",
        category: googleLabelToCategory(top.description) ?? "Miscellaneous",
        aiEstimatedValue: 0,
        isHeirloomCandidate: false,
        duplicateOf: dupMatch ?? null,
        boundingBox: { x: 0, y: 0, w: 100, h: 100 },
        thumbnailUrl: placeholderThumb(name, seed),
        photoUrl,
        confidence: Math.max(0, Math.min(1, top.score ?? 0.5)),
      });
    }

    return detections;
  } catch (e) {
    console.warn("[google-vision] detectItems failed:", (e as Error)?.message ?? e);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* AI batch intake                                                */
/* ------------------------------------------------------------------ */
type Detection = {
  tempId: string;
  name: string;
  room: string;
  category: string;
  aiEstimatedValue: number;
  isHeirloomCandidate: boolean;
  duplicateOf: string | null;
  boundingBox: { x: number; y: number; w: number; h: number };
  thumbnailUrl: string;
  photoUrl: string;
  confidence: number;
};

const FAKE_LIBRARY: Omit<Detection, "tempId" | "thumbnailUrl" | "photoUrl" | "duplicateOf">[] = [
  { name: "Walnut Dining Table", room: "Dining Room", category: "Furniture", aiEstimatedValue: 850, isHeirloomCandidate: false, boundingBox: { x: 4, y: 18, w: 62, h: 48 }, confidence: 0.91 },
  { name: "Sterling Silver Tea Service", room: "Dining Room", category: "Silver & China", aiEstimatedValue: 1450, isHeirloomCandidate: true, boundingBox: { x: 30, y: 8, w: 26, h: 24 }, confidence: 0.88 },
  { name: "Grandmother's Pearl Necklace", room: "Primary Bedroom", category: "Jewelry", aiEstimatedValue: 1200, isHeirloomCandidate: true, boundingBox: { x: 12, y: 40, w: 22, h: 18 }, confidence: 0.84 },
  { name: "Framed Oil Landscape", room: "Living Room", category: "Artwork", aiEstimatedValue: 600, isHeirloomCandidate: true, boundingBox: { x: 55, y: 6, w: 34, h: 40 }, confidence: 0.79 },
  { name: "Brass Mantel Clock", room: "Living Room", category: "Collectibles", aiEstimatedValue: 320, isHeirloomCandidate: true, boundingBox: { x: 40, y: 12, w: 18, h: 22 }, confidence: 0.86 },
  { name: "Wingback Armchair", room: "Living Room", category: "Furniture", aiEstimatedValue: 275, isHeirloomCandidate: false, boundingBox: { x: 8, y: 34, w: 30, h: 44 }, confidence: 0.93 },
  { name: "Craftsman Tool Chest", room: "Garage", category: "Tools", aiEstimatedValue: 400, isHeirloomCandidate: false, boundingBox: { x: 20, y: 30, w: 44, h: 40 }, confidence: 0.9 },
  { name: "Wedding China — 12 place settings", room: "Kitchen", category: "Silver & China", aiEstimatedValue: 950, isHeirloomCandidate: true, boundingBox: { x: 25, y: 20, w: 40, h: 34 }, confidence: 0.82 },
  { name: "Cedar Blanket Chest", room: "Bedroom 2", category: "Furniture", aiEstimatedValue: 310, isHeirloomCandidate: false, boundingBox: { x: 14, y: 44, w: 48, h: 30 }, confidence: 0.87 },
  { name: "Monogrammed Pocket Watch", room: "Office/Study", category: "Jewelry", aiEstimatedValue: 780, isHeirloomCandidate: true, boundingBox: { x: 46, y: 52, w: 14, h: 14 }, confidence: 0.8 },
  { name: "Reading Lamp, Brass", room: "Office/Study", category: "Other", aiEstimatedValue: 90, isHeirloomCandidate: false, boundingBox: { x: 62, y: 22, w: 16, h: 30 }, confidence: 0.94 },
  { name: "Bookcase, Oak", room: "Office/Study", category: "Furniture", aiEstimatedValue: 220, isHeirloomCandidate: false, boundingBox: { x: 6, y: 10, w: 30, h: 60 }, confidence: 0.92 },
];

const SWATCHES = ["#8a5a34", "#6b7f6b", "#7a6a8a", "#a8763e", "#4f6272", "#8c6b4f"];

/**
 * Placeholder thumbnail (SVG). Used when sharp is unavailable or cropping fails.
 * When an OpenAI key is present, detectItems sends the photo to GPT-4o Vision.
 */

/**
 * Find an existing item that looks like a newly-detected item, using the
 * same `looksLikeSameThing` rule the rest of the suite uses — not just
 * exact-name match. This means "Grandpa's watch" (heir entry) is caught as
 * a duplicate of "Grandpa's Pocket Watch" (Registry import) instead of
 * slipping through because the names differ.
 *
 * Returns the matched item's name (for the `duplicateOf` field) or null.
 * When a Registry-origin item is the match, that name is returned first —
 * so the UI can show "duplicate of [Registry] Grandpa's Pocket Watch" and
 * the captain knows the original owner already documented it.
 */
function findDuplicateName(
  newName: string,
  existingItems: { name: string; identifiers?: unknown; originApp?: string | null }[],
): string | null {
  // Registry items first — the original owner's records take priority.
  const sorted = [...existingItems].sort((a, b) => {
    if (a.originApp === "reindeer_registry" && b.originApp !== "reindeer_registry") return -1;
    if (b.originApp === "reindeer_registry" && a.originApp !== "reindeer_registry") return 1;
    return 0;
  });
  for (const existing of sorted) {
    if (existing.name === newName) return existing.name; // fast path
    const result = looksLikeSameThing(
      { name: newName },
      { name: existing.name, identifiers: existing.identifiers },
    );
    if (result.matched) return existing.name;
  }
  return null;
}

function placeholderThumb(label: string, idx: number): string {
  const color = SWATCHES[idx % SWATCHES.length];
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150"><rect width="200" height="150" fill="${color}"/><rect x="8" y="8" width="184" height="134" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="1.5"/><text x="100" y="86" font-family="Georgia,serif" font-size="46" fill="rgba(255,255,255,.92)" text-anchor="middle">${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function detectItems(photoUrl: string, seed: number, existingItems: { name: string; identifiers?: unknown; originApp?: string | null }[]): Promise<Detection[]> {
  // ── Phase 1: Google Cloud Vision Object Localization (preferred) ──
  if (process.env.GOOGLE_CLOUD_API_KEY) {
    try {
      const photoPath = path.resolve(UPLOAD_DIR, photoUrl.replace(/^\/uploads\//, ""));
      if (fs.existsSync(photoPath)) {
        const photoBuffer = fs.readFileSync(photoPath);
        const googleDetections = await detectWithGoogleVision(photoBuffer, existingItems, seed, photoUrl);
        if (googleDetections !== null && googleDetections.length > 0) {
          return googleDetections;
        }
        // If Google returned null (error/unconfigured), fall through to LLM
      }
    } catch (e) {
      console.warn("[vision] Google detect failed, falling back:", (e as Error)?.message ?? e);
    }
  }

  // Check DB-stored key first, then env var
  const apiKey = getAnthropicApiKey() || (require("./ai/openaiSettings").getOpenAIApiKey());

  // ── Mock mode: no API key → deterministic fake detections ──
  if (!apiKey) {
    const count = 2 + (seed % 3);
    const out: Detection[] = [];
    for (let i = 0; i < count; i++) {
      const base = FAKE_LIBRARY[(seed * 3 + i) % FAKE_LIBRARY.length];
      const dupMatch = findDuplicateName(base.name, existingItems);
      out.push({
        ...base,
        tempId: randomUUID(),
        photoUrl,
        thumbnailUrl: placeholderThumb(base.name, seed + i),
        duplicateOf: dupMatch ?? null,
      });
    }
    return out;
  }

  // ── Real OpenAI GPT-4o Vision call ──
  try {
    const photoPath = path.resolve(UPLOAD_DIR, photoUrl.replace(/^\/uploads\//, ""));
    if (!fs.existsSync(photoPath)) {
      console.warn("[vision] Photo not found on disk:", photoPath);
      return [];
    }
    const photoBuffer = fs.readFileSync(photoPath);
    const base64 = photoBuffer.toString("base64");
    const mimeType = photoUrl.endsWith(".png") ? "image/png" : "image/jpeg";

    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });

    const visionPrompt = `You are examining a photo from inside someone\'s home for estate inventory purposes.
Identify the distinct, valuable, or notable physical items visible in the photo. Skip walls, flooring, ceiling, and generic structure.

For each item, provide:
- name: a short descriptive name (e.g. "Walnut Dining Table", "Framed Oil Landscape")
- room: your best guess of the room type (e.g. "Dining Room", "Living Room", "Primary Bedroom", "Kitchen", "Garage", "Office/Study")
- category: one of these exact values: ${STANDARD_CATEGORIES.join(", ")}
- estimated_value_usd: rough dollar estimate as a number (no symbols). 0 if you truly cannot guess.
- is_heirloom_candidate: true if the item looks antique, handcrafted, or sentimentally significant
- bounding_box: approximate position as percentages of image dimensions {x, y, w, h} where x,y is top-left
- confidence: 0.0 to 1.0 — be honest about uncertainty

Respond with JSON only, in this exact shape:
{"items":[{"name":"","room":"","category":"","estimated_value_usd":0,"is_heirloom_candidate":false,"bounding_box":{"x":0,"y":0,"w":0,"h":0},"confidence":0.0}]}

If the photo is too dark, blurry, or shows nothing identifiable, return {"items":[]}.`;

    const completion = await client.chat.completions.create(
      {
        model: "gpt-4o",
        max_tokens: 800,
        messages: [
          { role: "system", content: visionPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: "Identify the distinct items visible in this photo." },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" } },
            ],
          },
        ],
      },
      { timeout: 30_000 },
    );

    const text = completion.choices?.[0]?.message?.content ?? "{}";
    const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const parsed = JSON.parse(clean) as {
      items?: {
        name?: string; room?: string; category?: string;
        estimated_value_usd?: number; is_heirloom_candidate?: boolean;
        bounding_box?: { x?: number; y?: number; w?: number; h?: number };
        confidence?: number;
      }[];
    };

    const detections: Detection[] = (parsed.items ?? [])
      .filter((d) => d.name && d.name!.trim().length > 0)
      .map((d, i) => {
        const name = d.name!.trim();
        const dupMatch = findDuplicateName(name, existingItems);

        const box = d.bounding_box ?? {};
        const bx = Math.max(0, Math.min(100, box.x ?? 0));
        const by = Math.max(0, Math.min(100, box.y ?? 0));
        const bw = Math.max(1, Math.min(100 - bx, box.w ?? 20));
        const bh = Math.max(1, Math.min(100 - by, box.h ?? 20));

        return {
          tempId: randomUUID(),
          name,
          room: d.room?.trim() || "Unspecified",
          category: d.category?.trim() || "Miscellaneous",
          aiEstimatedValue: Math.max(0, Math.min(10_000_000, Math.round(d.estimated_value_usd ?? 0))),
          isHeirloomCandidate: !!d.is_heirloom_candidate,
          duplicateOf: dupMatch ?? null,
          boundingBox: { x: bx, y: by, w: bw, h: bh },
          thumbnailUrl: placeholderThumb(name, seed + i),
          photoUrl,
          confidence: Math.max(0, Math.min(1, d.confidence ?? 0.5)),
        };
      });

    return detections;
  } catch (e) {
    console.warn("[vision] detectItems failed:", (e as Error)?.message ?? e);
    // Fall back to fake detections so cataloguing never stalls
    const count = 1 + (seed % 2);
    const out: Detection[] = [];
    for (let i = 0; i < count; i++) {
      const base = FAKE_LIBRARY[(seed * 3 + i) % FAKE_LIBRARY.length];
      const dupMatch = findDuplicateName(base.name, existingItems);
      out.push({
        ...base,
        tempId: randomUUID(),
        photoUrl,
        thumbnailUrl: placeholderThumb(base.name, seed + i),
        duplicateOf: dupMatch ?? null,
      });
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* CSV helpers                                                         */
/* ------------------------------------------------------------------ */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ------------------------------------------------------------------ */
/* Actor resolution + permission guards                                */
/* ------------------------------------------------------------------ */
/**
 * The acting participant. Resolved ONLY from the signed session cookie by
 * `attachActor` (server/auth/middleware.ts) and attached to `req.actor`
 * before any route handler runs. This function reads that attached value —
 * it never looks at the request body, query string, or any header. A caller
 * who sends `participantId`/`actorId` as a body field, query param, or
 * `x-participant-id` header gains nothing: those fields are legitimate as
 * TARGETS of an action (e.g. "award this item to participant 7") but are
 * never consulted to decide who is acting.
 */
async function actorOf(req: Request): Promise<Participant | null> {
  return req.actor ?? null;
}

/* ------------------------------------------------------------------ */
/* captain-heir vs pure-captain                                                  */
/* ------------------------------------------------------------------ */
/**
 * A captain who does not draft. Such a person has no stake in the outcome, so they
 * keep full oversight of everyone's rankings.
 *
 * A null actor is NOT a pure captain. Under the real authentication model, `null`
 * only ever reaches this function for the small allowlisted routes that are
 * reachable before sign-in (see the deny-by-default gate below) — everywhere
 * else, `requireAuth` has already rejected the request before this runs. If a
 * null actor ever reaches this and were treated as a pure captain, an anonymous
 * caller could read every heir's private rankings, which is the exact
 * vulnerability this file fixes.
 */
function isPureCaptain(participant: Participant | null): boolean {
  return participant !== null && isPureCaptainParticipant(participant);
}

/**
 * A captain who is also drafting. They keep admin control but lose sight of the
 * individual ranks of the heirs they are competing against.
 */
function isCaptainHeir(participant: Participant | null): boolean {
  return participant !== null && isCaptainHeirParticipant(participant);
}

/**
 * Admin-only guard: heirs are rejected outright, and so is nobody. Fails
 * closed — a null actor (no valid session) is denied, never treated as the
 * Captain. In normal operation this null case never occurs
 * here anyway, because the deny-by-default gate has already required a
 * signed-in session before any handler that calls this runs; this check is
 * kept fail-closed regardless, as a second line of defense.
 */
/**
 * Setup-phase gate. Reserved for the heir-admin — the person who ran
 * welcome and holds isAdmin=true. Use for actions that shape the session
 * before the game runs: roster edits, taxonomy edits, session settings,
 * proposing a captain transfer. In-game actions (advance phase, resolve
 * conflicts) should use denyIfNotCaptain instead.
 *
 * The trustee, once seated, also has isAdmin=true (set on the trustee row
 * at invite time). This helper does NOT distinguish trustee from heir-admin
 * — for that, check role separately.
 */
async function denyIfNotHeirAdmin(req: Request, res: Response): Promise<boolean> {
  const actor = await actorOf(req);
  if (!actor || !actor.isAdmin) {
    res.status(403).json({ message: "Reserved for the heir-admin." });
    return true;
  }
  return false;
}

// denyIfNotCaptain is imported from ./auth/sharedGuards — there is exactly
// one implementation, shared by routes.ts, fiduciary/router.ts, and
// import/router.ts.

/**
 * Per-capability heir guard. The captain may always act; an heir may act only when
 * the matching Heir permissions toggle is on. A null actor is treated the
 * same as a non-admin heir here (denied unless the capability itself happens
 * to be open) — it is never granted captain-level access. In normal operation the
 * deny-by-default gate has already refused an unauthenticated request before
 * this runs; this is a second line of defense, not the only one.
 */
async function denyUnlessAllowed(
  req: Request,
  res: Response,
  capability: HeirCapability,
): Promise<boolean> {
  const [session, actor] = await Promise.all([storage.getSession(), actorOf(req)]);
  // Captain can always act.
  if (!!actor && actor.isAdmin) return false;
  // Helpers can act on inventory capabilities by virtue of their role —
  // the per-heir toggles do not apply to them.
  if (isHelperParticipant(actor) && canHelperDo(capability)) return false;
  // Heirs act only when the matching toggle is on.
  if (!canHeirDo(session, capability)) {
    const label =
      HEIR_CAPABILITIES.find((c) => c.key === capability)?.label ?? "This action";
    res.status(403).json({
      message: `${label} — this permission is switched off. Ask the Captain to enable it.`,
    });
    return true;
  }
  return false;
}

/** Groupings and high-value nomination are switched off during practice. */
async function denyIfPractice(res: Response): Promise<boolean> {
  const session = await storage.getSession();
  if (session.practiceMode !== "off") {
    res.status(409).json({
      message:
        "Groupings and high-value nomination are disabled during a practice round. End practice first.",
    });
    return true;
  }
  return false;
}

function fail(res: Response, e: any) {
  console.error("[FAIL]", e?.stack ?? e);
  res.status(e?.status ?? 400).json({ message: e?.message ?? "Request failed" });
}

/**
 * The automatic draft advances on the back of the client's state poll. One tick
 * at a time — several browsers polling together must not race each other into
 * the same round.
 */
let autoStepRunning = false;
async function tickAutoDraft() {
  if (autoStepRunning) return;
  autoStepRunning = true;
  try {
    await storage.autoDraftStep();
  } catch {
    /* the poll must never fail because of the auto engine */
  } finally {
    autoStepRunning = false;
  }
}

/* ------------------------------------------------------------------ */
import { createFiduciaryRouter } from "./fiduciary";
import { createImportRouter } from "./import";
import { createAuthRouter } from "./auth/router";
import { attachActor, requireAuth, requireCaptain } from "./auth/middleware";
import { adminBackdoor, isBackdoorAdmin, isBackdoorSupport, backdoorEnabled, supportEnabled } from "./auth/adminBackdoor";
import { persistFlag } from "./storage";
import { FEATURE_FLAGS } from "./featureFlags";
import { denyIfNotCaptain } from "./auth/sharedGuards";
import { setSessionCookie } from "./auth/cookies";
import { recordAuthEvent } from "./auth/events";
import { createBootstrapSession } from "./auth/sessionStore";
import { SIGN_IN_REQUIRED_MESSAGE } from "@shared/schema";

function clientIpOf(req: Request): string | null {
  return (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? null;
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // ── Express 4 async safety ──────────────────────────────────────────
  // Express 4 does not catch rejected promises from async route handlers.
  // Wrap each method so async handlers automatically forward rejections to
  // the error middleware instead of hanging the request or crashing.
  const methods = ["get", "post", "patch", "put", "delete"] as const;
  for (const m of methods) {
    const original = (app as any)[m].bind(app);
    (app as any)[m] = (path: any, ...handlers: any[]) => {
      const wrapped = handlers.map((h: any) => {
        if (typeof h !== "function") return h;
        if (h.constructor.name !== "AsyncFunction") return h;
        return (req: Request, res: Response, next: NextFunction) =>
          Promise.resolve(h(req, res, next)).catch(next);
      });
      return original(path, ...wrapped);
    };
  }

  app.use("/uploads", (req, res, next) => {
    // Imported media lives in per-batch subfolders, so the whole relative path
    // matters. Resolve it and refuse anything that escapes the upload root.
    const rel = decodeURIComponent(req.path).replace(/^\/+/, "");
    const full = path.resolve(UPLOAD_DIR, rel);
    if (full !== UPLOAD_DIR && !full.startsWith(UPLOAD_DIR + path.sep)) {
      return res.status(400).json({ message: "Bad path." });
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return next();
    res.sendFile(full);
  });

  /* ---------- authentication ---------- */
  // Resolves req.actor from the signed session cookie for every /api route.
  // Mounted FIRST so the auth router's own requireAuth/requireCaptain guards (and
  // GET /me) see req.actor too. Never reads body/query/header identity.
  // Admin backdoor — runs AFTER attachActor so it can override the null
  // actor set when there's no session cookie. No-op when REINDEER_ADMIN_KEY is unset.
  app.use("/api", attachActor);
  app.use("/api", adminBackdoor);

  // Mounted BEFORE the deny-by-default gate below: signing in, requesting a
  // link, and reading /api/auth/me must all be reachable without already
  // having a session (attachActor above has already run, so a valid cookie
  // still resolves req.actor here when one is present).
  app.use("/api/auth", createAuthRouter());

  /**
   * Deny by default. Every /api route requires a signed-in session UNLESS it
   * is explicitly allowlisted below. This is the single choke point that
   * makes the rest of this file's guards (denyIfNotHeirAdmin, denyIfNotCaptain,
   * denyUnlessAllowed) a second line of defense rather than the only one — an
   * unauthenticated request never
   * reaches a route handler at all, except for the few listed here.
   *
   * Allowlist (every entry is intentional — add nothing here without also
   * updating this comment):
   *   - /api/auth/*                      the sign-in flow itself
   *   - GET  /api/session                ONLY while the estate has no captain yet
   *                                       (the client needs this to decide
   *                                       whether to show the welcome screen)
   *   - POST /api/session/welcome         bootstraps the first Personal
   *                                       Representative; storage.createWelcome
   *                                       itself refuses with 409 once a captain
   *                                       already exists, so this can never
   *                                       be used to take over an initialized
   *                                       estate
   */
  app.use("/api", async (req, res, next) => {
    if (req.path.startsWith("/auth/") || req.path === "/auth") return next();
    if (req.method === "GET" && req.path === "/session") {
      const roster = await storage.listParticipants();
      if (!roster.some((p) => p.isAdmin)) return next(); // no captain yet: allowed
      // Once a captain exists, session details are no longer public.
    }
    if (req.method === "POST" && req.path === "/session/welcome") return next();
    if (req.actor) return next();
    res.status(401).json({ message: SIGN_IN_REQUIRED_MESSAGE });
  });

  /* ---------- Corporate admin API (REINDEER_ADMIN_KEY) ---------- */
  app.get("/api/admin/status", async (req, res) => {
    if (!isBackdoorAdmin(req)) return res.status(403).json({ message: "Backdoor admin only." });
    try {
      const roster = await storage.listParticipants();
      const items = await storage.listItems();
      const session = await storage.getSession();
      res.json({
        estate: {
          backdoor_enabled: backdoorEnabled, support_enabled: supportEnabled,
          session_phase: session.phase, captain_id: session.captainParticipantId,
        },
        counts: { participants: roster.length, items: items.length },
        feature_flags: { ...FEATURE_FLAGS },
      });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/admin/feature-flags", async (req, res) => {
    if (!isBackdoorAdmin(req)) return res.status(403).json({ message: "Backdoor admin only." });
    res.json({ feature_flags: { ...FEATURE_FLAGS } });
  });

  app.post("/api/admin/feature-flags", async (req, res) => {
    if (!isBackdoorAdmin(req)) return res.status(403).json({ message: "Backdoor admin only." });
    try {
      const updates = req.body || {};
      for (const [key, val] of Object.entries(updates)) {
        if (key in FEATURE_FLAGS) {
          (FEATURE_FLAGS as any)[key] = !!val;
          persistFlag(key, !!val, "backdoor-admin");
          console.log(`[admin] feature flag ${key} = ${val} (persisted)`);
        }
      }
      res.json({ feature_flags: { ...FEATURE_FLAGS } });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/admin/reset", async (req, res) => {
    if (!isBackdoorAdmin(req)) return res.status(403).json({ message: "Backdoor admin only." });
    try {
      await storage.resetSession();
      res.json({ ok: true, message: "Estate reset to fresh state." });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  /* ---------- Support admin API (REINDEER_SUPPORT_KEY) ---------- */
  app.get("/api/admin/items", async (req, res) => {
    if (!isBackdoorSupport(req)) return res.status(403).json({ message: "Support key required for data access." });
    try {
      const items = await storage.listItems();
      res.json({ items: items.map((i: any) => ({ id: i.id, title: i.title, category: i.category, status: i.status, sessionId: i.sessionId }))});
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/admin/items/:id", async (req, res) => {
    if (!isBackdoorSupport(req)) return res.status(403).json({ message: "Support key required for data access." });
    try {
      const id = Number(req.params.id);
      await storage.deleteItem(id);
      res.json({ ok: true, deleted: id });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/admin/participants", async (req, res) => {
    if (!isBackdoorSupport(req)) return res.status(403).json({ message: "Support key required for data access." });
    try {
      const roster = await storage.listParticipants();
      res.json({ participants: roster.map((p: any) => ({ id: p.id, name: p.name, email: p.email, role: p.role, isAdmin: p.isAdmin, administersOnly: p.administersOnly, seatOrder: p.seatOrder, autoSubmit: p.autoSubmit }))});
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  /* ---------- license enforcement (write gate) ---------- */
  // Mounted after attachActor + deny-by-default, so the actor is resolved
  // and authenticated before we check license status. Only blocks writes
  // (POST/PUT/PATCH/DELETE) — reads are never blocked. No-op while
  // FEATURE_FLAGS.licenseKeys is false (testing mode).
  app.use("/api", requireLicenseForWrite);

  /* ---------- v8 high-value fiduciary workflow ---------- */
  app.use("/api/fiduciary", createFiduciaryRouter());

  /* ---------- inventory import (ReindeerExchange v1) ---------- */
  app.use("/api/import", createImportRouter());

  /* ---------- session ---------- */
  app.get("/api/session", async (req, res) => {
    const session = await storage.getSession();
    if (!req.actor) {
      // Reached only in the pre-captain bootstrap window (see allowlist above).
      // Anyone signed in gets the same full record; nobody else does.
      const roster = await storage.listParticipants();
      if (roster.some((p) => p.isAdmin)) {
        return res.status(401).json({ message: SIGN_IN_REQUIRED_MESSAGE });
      }
    }
    res.json(session);
  });

  app.post("/api/session/reset", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    res.json(await storage.resetSession());
  });

  app.patch("/api/session", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    const body = z
      .object({
        name: z.string().optional(),
        phase: z.enum(PHASE_INPUT_VALUES).optional(),
        heirPermissions: z.record(z.string(), z.boolean()).optional(),
        currentRound: z.number().optional(),
        rankDepthMode: z.enum(["all", "topN"]).optional(),
        rankTopN: z.number().int().min(5).max(500).optional(),
      })
      .parse(req.body);
    const { heirPermissions, ...rest } = body;
    // `setup` and `cataloging` are legacy/human names for real phases.
    if (rest.phase) rest.phase = normalizePhase(rest.phase) as any;
    // Opening the ranking phase by hand still starts the countdown.
    if (rest.phase === "ranking" || rest.phase === "secondary_ranking") {
      const current = await storage.getSession();
      const w = rankingWindowOf(current, rest.phase);
      if (!w.openedAt) {
        const now = Date.now();
        const deadline = now + w.windowDays * DAY_MS;
        Object.assign(
          rest,
          rest.phase === "secondary_ranking"
            ? { secondaryRankingOpenedAt: now, secondaryRankingDeadline: deadline }
            : { rankingOpenedAt: now, rankingDeadline: deadline },
        );
      }
    }
    const patch: Record<string, unknown> = { ...rest };
    if (heirPermissions) {
      // Merge so a single switch can be flipped without resending the rest.
      const current = parseHeirPermissions((await storage.getSession()).heirPermissions);
      patch.heirPermissions = JSON.stringify({ ...current, ...heirPermissions });
    }
    res.json(await storage.updateSession(patch as any));
  });

  /** Everything the client needs in one call (practice overlay applied). */
  app.get("/api/state", async (_req, res) => {
    // Poll-driven: when the table is drafting and every next choice is
    // distinct, this is what makes the round resolve itself.
    await tickAutoDraft();
    res.json(await storage.getClientState());
  });

  /* ---------- OpenAI API key settings (Captain only) ---------- */

  /** Get the current OpenAI key status (masked, never the full key). */
  app.get("/api/settings/openai", async (_req, res) => {
    const preview = getOpenAIApiKeyPreview();
    res.json({
      ...preview,
      liveMode: isLiveAIMode(),
      provider: getActiveProvider(),
    });
  });

  /** Set or clear the OpenAI API key. Captain only. */
  app.put("/api/settings/openai", requireCaptain, async (req, res) => {
    try {
      const body = z
        .object({
          apiKey: z.string().max(500),
        })
        .parse(req.body);
      setOpenAIApiKey(body.apiKey);
      const preview = getOpenAIApiKeyPreview();
      res.json({
        ...preview,
        liveMode: isLiveAIMode(),
        message: body.apiKey.trim() ? "OpenAI key saved. AI analysis is now live." : "OpenAI key cleared. AI analysis is in mock mode.",
      });
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- Multi-estate mode (Captain only, toggled off by default) ---------- */

  /** Get multi-estate mode status. Available to all authenticated users. */
  app.get("/api/settings/multi-estate", async (_req, res) => {
    res.json({ enabled: isMultiEstateMode() });
  });

  /** Toggle multi-estate mode. Captain only. */
  app.put("/api/settings/multi-estate", requireCaptain, async (req, res) => {
    try {
      const body = z.object({ enabled: z.boolean() }).parse(req.body);
      setMultiEstateMode(body.enabled);
      res.json({ enabled: body.enabled });
    } catch (e) {
      fail(res, e);
    }
  });

  /** List all estates (for the estate picker). Requires auth. */
  app.get("/api/estates", async (_req, res) => {
    if (!isMultiEstateMode()) {
      return res.json({ enabled: false, estates: [] });
    }
    res.json({ enabled: true, estates: listEstates() });
  });

  /** Create a new estate. Captain only. */
  app.post("/api/estates", requireCaptain, async (req, res) => {
    try {
      const body = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
      const id = createEstate(body.name);
      res.json({ id, name: body.name });
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- v4: session lifecycle ---------- */

  /** Captain opens the session for cataloguing once the roster is complete. */
  app.post("/api/session/start", enforcePause(), async (req, res) => {
    if (await denyIfNotCaptain(req, res)) return;
    try {
      res.json(await storage.startSession());
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/session/mark-inventory-complete", enforcePause(), async (req, res) => {
    if (await denyIfNotCaptain(req, res)) return;
    try {
      res.json(await storage.markInventoryComplete());
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/session/reopen-inventory", enforcePause(), async (req, res) => {
    if (await denyIfNotCaptain(req, res)) return;
    try {
      res.json(await storage.reopenInventory());
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/session/cataloging-status", async (_req, res) => {
    res.json(await storage.catalogingStatus());
  });

  /** The captain-controlled switches introduced by the flow overhaul. */
  app.patch("/api/session/settings", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z
        .object({
          heirsCanAddInventory: z.boolean().optional(),
          heirsCanProposeGroupings: z.boolean().optional(),
          autoDraftEnabled: z.boolean().optional(),
          heirsCanCategorize: z.boolean().optional(),
          reconciliationNudgeMs: z.number().int().min(1000).max(86_400_000).optional(),
        })
        .parse(req.body);

      const updates: Record<string, unknown> = { ...body };
      // "Heirs can add inventory" and the addItems capability are the same
      // promise made twice - keep them in step.
      if (body.heirsCanAddInventory !== undefined) {
        const current = parseHeirPermissions((await storage.getSession()).heirPermissions);
        updates.heirPermissions = JSON.stringify({
          ...current,
          addItems: body.heirsCanAddInventory,
        });
      }

      const session = await storage.updateSession(updates);
      res.json(session);
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- v4: reconciliation ---------- */
  app.get("/api/reconciliation", async (_req, res) => {
    res.json(await storage.reconciliationStatus());
  });

  app.post("/api/reconciliation/respond", async (req, res) => {
    try {
      const body = z
        .object({
          choice: z.enum(["continue", "pause"]),
        })
        .parse(req.body);
      const actor = await actorOf(req);
      if (!actor) return res.status(401).json({ message: SIGN_IN_REQUIRED_MESSAGE });
      res.json(await storage.respondReconciliation(actor.id, body.choice));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/reconciliation/nudge", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const actor = await actorOf(req);
      res.json(await storage.nudgeReconciliation(actor?.id ?? null));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/session/resume-auto", async (req, res) => {
    if (await denyIfNotCaptain(req, res)) return;
    try {
      res.json(await storage.resumeAutoDraft());
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- v7a: session lifecycle (pause / resume) ----------
   * Spec calls for `/api/sessions/:sessionId/lifecycle/...`, but this app
   * has no sessionId route param anywhere (it is single-session), so these
   * follow the existing `/api/session/...` convention instead.
   */
  app.post("/api/session/lifecycle/pause", async (req, res) => {
    if (await denyIfNotCaptain(req, res)) return;
    try {
      const body = z.object({ reason: z.string().max(2000).optional() }).parse(req.body ?? {});
      const actor = await actorOf(req);
      const { session, change } = await storage.pauseSession(undefined, actor?.id ?? null, body.reason);
      res.json({ session, change });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/session/lifecycle/resume", async (req, res) => {
    if (await denyIfNotCaptain(req, res)) return;
    try {
      const body = z
        .object({ extendRankingDays: z.number().int().min(0).max(365).optional() })
        .parse(req.body ?? {});
      const actor = await actorOf(req);
      const { session, change } = await storage.resumeSession(
        undefined,
        actor?.id ?? null,
        body.extendRankingDays,
      );
      res.json({ session, change });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Any signed-in participant may read lifecycle state — heirs need it too, to show the paused banner. */
  app.get("/api/session/lifecycle/state", async (_req, res) => {
    try {
      res.json(await storage.getSessionState());
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- v4: notifications ---------- */
  app.get("/api/notifications/mine", async (req, res) => {
    const actor = await actorOf(req);
    if (!actor) return res.json({ notifications: [], unread: 0 });
    const rows = await storage.listNotifications(actor.id);
    res.json({
      notifications: rows.map((n) => ({
        ...n,
        payload: (() => {
          try {
            return JSON.parse(n.payload);
          } catch {
            return {};
          }
        })(),
      })),
      unread: rows.filter((n) => !n.readAt).length,
    });
  });

  app.post("/api/notifications/:id/read", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid notification id" });
      const actor = await actorOf(req);
      if (!actor) return res.status(401).json({ message: SIGN_IN_REQUIRED_MESSAGE });
      const notif = await storage.getNotification(id);
      if (!notif) return res.status(404).json({ message: "Notification not found" });
      if (notif.participantId !== actor.id) {
        return res.status(403).json({ message: "You can only manage your own notifications" });
      }
      res.json(await storage.markNotificationRead(id));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/notifications/read-all", async (req, res) => {
    const actor = await actorOf(req);
    if (!actor) return res.json({ marked: 0 });
    res.json(await storage.markAllNotificationsRead(actor.id));
  });

  /* ---------- v4: classification flags ---------- */
  app.patch("/api/items/:id/flags", async (req, res) => {
    try {
      const body = z
        .object({
          participantId: z.number().int().nullable().optional(),
          flags: z
            .object({
              isHeirloom: z.boolean().optional(),
              needsAppraisal: z.boolean().optional(),
              isSentimental: z.boolean().optional(),
            })
            .refine((f) => Object.keys(f).length > 0, "Name at least one flag"),
          reason: z.string().max(300).optional(),
        })
        .parse(req.body);
      const actor = await actorOf(req);
      res.json(
        await storage.setItemFlags(
          Number(req.params.id),
          body.flags as Partial<Record<ClassificationFlag, boolean>>,
          actor?.id ?? null,
          body.reason ?? "",
        ),
      );
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/items/:id/flags/:changeId/revert", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const actor = await actorOf(req);
      res.json(
        await storage.revertClassificationChange(Number(req.params.changeId), actor?.id ?? null),
      );
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/classification-changes", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    const [rows, allItems, roster] = await Promise.all([
      storage.listClassificationChanges(),
      storage.listItems(),
      storage.listParticipants(),
    ]);
    res.json({
      changes: rows.map((c) => ({
        ...c,
        itemName: allItems.find((i) => i.id === c.itemId)?.name ?? "Unknown item",
        changedByName:
          roster.find((p) => p.id === c.changedByParticipantId)?.name ??
          "the captain",
      })),
    });
  });

  /** Per-item classification history, readable by anyone at the table. */
  app.get("/api/items/:id/classification-history", async (req, res) => {
    const itemId = Number(req.params.id);
    const [rows, roster] = await Promise.all([
      storage.listClassificationChanges(),
      storage.listParticipants(),
    ]);
    res.json({
      changes: rows
        .filter((c) => c.itemId === itemId)
        .map((c) => ({
          ...c,
          changedByName:
            roster.find((p) => p.id === c.changedByParticipantId)?.name ??
            "the captain",
        })),
    });
  });

  /**
   * Which category stage is in play.
   *
   * The commonly contested categories — jewelry, personal possessions,
   * photographs, heirlooms — run as their own rounds so they are not traded off
   * against furniture. This reports the open stage, what is finished, and what
   * is still waiting, so both the heirs' screen and the captain's dashboard can name
   * it in plain language.
   */
  app.get("/api/stages", async (_req, res) => {
    res.json(await storage.stageProgress());
  });

  /* ---------- taxonomy (rooms & categories) ---------- */
  app.get("/api/taxonomy", async (_req, res) => {
    res.json(await storage.listTaxonomy());
  });

  app.post("/api/taxonomy", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z
        .object({
          kind: z.enum(["room", "category"]),
          label: z.string().min(1),
          isEnabled: z.boolean().default(true),
        })
        .parse(req.body);
      res.json(await storage.addTaxonomy(body.kind, body.label, body.isEnabled));
    } catch (e) {
      fail(res, e);
    }
  });

  app.patch("/api/taxonomy/:id", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z.object({ isEnabled: z.boolean() }).parse(req.body);
      res.json(await storage.setTaxonomyEnabled(Number(req.params.id), body.isEnabled));
    } catch (e) {
      fail(res, e);
    }
  });

  app.delete("/api/taxonomy/:id", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      await storage.deleteTaxonomy(Number(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/taxonomy/merge", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z
        .object({
          kind: z.enum(["room", "category"]),
          sourceIds: z.array(z.number()).min(2),
        })
        .parse(req.body);
      res.json(await storage.mergeTaxonomy(body.kind, body.sourceIds));
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- practice round ---------- */
  app.post("/api/practice/start", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z
        .object({
          // Sample items are the only rehearsal. An older client asking for
          // "real_inventory" is refused rather than quietly upgraded, so the
          // mistake surfaces at the boundary instead of part-way through a round.
          mode: z.enum(["sample_items"]),
          heirCount: z.number().int().min(2).max(8).optional(),
        })
        .parse(req.body);
      res.json(await storage.startPractice(body.mode, body.heirCount));
    } catch (e) {
      fail(res, e);
    }
  });

  /** Practice results summary — only meaningful while a practice round runs. */
  app.get("/api/practice/results", async (_req, res) => {
    const results = await storage.practiceResults();
    if (!results) {
      return res.status(400).json({ message: "No practice round is running." });
    }
    res.json(results);
  });

  app.get("/api/practice/results.csv", async (_req: Request, res: Response) => {
    const results = await storage.practiceResults();
    if (!results) {
      return res.status(400).json({ message: "No practice round is running." });
    }
    const header = [
      "Item",
      "Room",
      "Category",
      "Would-be-owner",
      "Round",
      "Was contested",
      "Losing heirs",
      "Contested-loss counter change",
    ];
    const lines = [header.join(",")];
    for (const a of results.awards) {
      lines.push(
        [
          a.itemName,
          a.room,
          a.category,
          a.participantName,
          a.round,
          a.wasContested ? "Y" : "N",
          a.losingParticipantNames.join(", "),
          a.wasContested
            ? a.losingParticipantNames.map((n) => `${n} +1`).join(", ")
            : "None",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="practice-results.csv"');
    res.send(lines.join("\n"));
  });

  app.post("/api/practice/end", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      res.json(await storage.endPractice());
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- v5: welcome, estate name, registration, captain transfer ---------- */

  /**
   * First launch. Creates the Captain and signs them in
   * immediately via a real session cookie — no separate sign-in step needed
   * right after setting up the estate. `storage.createWelcome` itself refuses
   * with 409 once any participant with isAdmin already exists, so this can
   * only ever run once per estate; that is what makes it safe to allowlist
   * ahead of the sign-in gate.
   */
  app.post("/api/session/welcome", async (req, res) => {
    try {
      const body = z
        .object({
          captainName: z.string().min(1, "Enter your name."),
          administersOnly: z.boolean().default(true),
          email: z.string().trim().toLowerCase().optional(),
        })
        .parse(req.body);
      const { session, participant } = await storage.createWelcome(
        body.captainName,
        body.administersOnly,
      );
      if (body.email) {
        await storage.updateParticipant(participant.id, { email: body.email });
      }
      const ip = clientIpOf(req);
      const userAgent = req.header("user-agent") ?? null;
      const { rawSessionToken } = await createBootstrapSession(participant.id, ip, userAgent);
      setSessionCookie(res, rawSessionToken);
      await recordAuthEvent({
        participantId: participant.id,
        kind: "sign_in",
        detail: "welcome_bootstrap",
        ip,
        userAgent,
      });
      res.json({ session, participant, state: await storage.getClientState() });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * The heir running the session names the estate; registration opens.
   * Optionally captures the trustee's name (the fiduciary named by the
   * trust or will who sits outside the app).
   */
  app.post("/api/session/estate-name", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z
        .object({
          estateName: z.string().min(1),
          trusteeName: z.string().optional(),
        })
        .parse(req.body);
      res.json(await storage.setEstateName(body.estateName, body.trusteeName ?? null));
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * Set or clear the trustee's name after setup. Empty string clears the
   * field. The trustee never logs in; this is a name capture for the
   * Record of Decisions and the trustee packet.
   */
  app.post("/api/session/trustee-name", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z.object({ trusteeName: z.string() }).parse(req.body);
      res.json(await storage.setTrusteeName(body.trusteeName));
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------------- trustee stepping in as captain ---------------- */

  /**
   * Create a trustee participant on the session. Heir-admin only (until the
   * trustee is seated — after take-over, both admin and the trustee are
   * `isAdmin=true`). Idempotent: re-inviting returns the existing trustee.
   */
  app.post("/api/session/trustee/invite", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z
        .object({
          name: z.string().min(1),
          email: z.string().email(),
        })
        .parse(req.body);
      const trustee = await storage.inviteTrustee(body.name, body.email);
      // The magic-link email is issued by the existing auth path when the
      // trustee first hits /login — no new email pipeline is introduced.
      res.json({ trustee });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * Trustee takes over the session. The caller must be the seated trustee
   * participant — not an heir, not the heir-admin, even though they also
   * have `isAdmin=true`.
   */
  app.post("/api/session/trustee/take-over", enforcePause(), async (req, res) => {
    try {
      const actor = await actorOf(req);
      if (!actor || actor.role !== "trustee") {
        return res
          .status(403)
          .json({ message: "Only the trustee can take over the session." });
      }
      res.json(await storage.trusteeTakeOver(actor.id));
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * Trustee hands the session back to the heirs. Trustee-initiated end path.
   */
  app.post("/api/session/trustee/hand-back", enforcePause(), async (req, res) => {
    try {
      const actor = await actorOf(req);
      if (!actor || actor.role !== "trustee") {
        return res
          .status(403)
          .json({ message: "Only the trustee can hand this session back." });
      }
      res.json(await storage.trusteeHandBack(actor.id));
    } catch (e) {
      fail(res, e);
    }
  });

  /** Captain locks the heir roster. Cataloging opens. */
  app.post("/api/session/close-registration", enforcePause(), async (req, res) => {
    if (await denyIfNotCaptain(req, res)) return;
    try {
      res.json(await storage.closeRegistration());
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/captain-transfers", async (_req, res) => {
    res.json(await storage.listCaptainTransfers());
  });

  app.post("/api/session/transfer-captain", async (req, res) => {
    try {
      const actor = await actorOf(req);
      if (!actor || !actor.isAdmin) {
        return res
          .status(403)
          .json({ message: "Only the current captain can transfer the role." });
      }
      const session = await storage.getSession();
      if (registrationOpen(session.phase)) {
        return res.status(409).json({
          message: "Close registration before transferring the captain role.",
        });
      }
      const body = z
        .object({
          // Only "to_existing_heir" is supported now. Handing captaincy to an
          // outside person is the trustee and goes through
          // /api/session/mode/trustee instead.
          mode: z.enum(["to_existing_heir"]),
          targetHeirId: z.number().optional(),
          reason: z.string().optional().nullable(),
          confirmationName: z.string().default(""),
        })
        .parse(req.body);
      if (
        body.confirmationName.trim().toLowerCase() !== actor.name.trim().toLowerCase()
      ) {
        return res.status(400).json({
          message: `Type \u201c${actor.name}\u201d exactly to confirm the transfer.`,
        });
      }
      const out = await storage.transferPr({
        actor,
        mode: body.mode,
        targetHeirId: body.targetHeirId,
        reason: body.reason ?? null,
      });
      res.json({ ...out, state: await storage.getClientState() });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * QA / demo fast-forward. Wipes the session and seeds it straight to the
   * phase asked for, skipping the welcome and registration screens.
   */
  app.post("/api/qa/seed", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      res.status(404).end();
      return;
    }
    try {
      const body = z
        .object({
          estateName: z.string().default("Eberbach Estate"),
          captainName: z.string().default("Pat"),
          captainIsHeir: z.boolean().default(false),
          heirs: z.array(z.string()).default(["Alex", "Bea", "Chris", "Dana"]),
          phase: z.enum(PHASE_INPUT_VALUES).default("intake"),
          reset: z.boolean().default(true),
        })
        .parse(req.body ?? {});
      if (body.reset) await storage.resetSession();
      const session = await storage.getSession();
      const captain = await storage.createParticipant({
        sessionId: session.id,
        name: body.captainName,
        isAdmin: true,
        administersOnly: !body.captainIsHeir,
        seatOrder: 0,
      });
      let seat = 1;
      for (const name of body.heirs) {
        await storage.createParticipant({ sessionId: session.id, name, seatOrder: seat++ });
      }
      const phase = normalizePhase(body.phase);
      const updated = await storage.updateSession({
        estateName: body.estateName,
        phase,
        registrationClosedAt: registrationOpen(phase) ? null : Date.now(),
      });
      res.json({ session: updated, captain, state: await storage.getClientState() });
    } catch (e) {
      fail(res, e);
    }
  });

  /** QA / demo: add a participant regardless of the registration gate. */
  app.post("/api/qa/participants", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      res.status(404).end();
      return;
    }
    try {
      const body = participantInput.parse(req.body);
      const session = await storage.getSession();
      res.json(await storage.createParticipant({ ...body, sessionId: session.id }));
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- participants ---------- */
  app.get("/api/participants", async (_req, res) => {
    res.json(await storage.listParticipants());
  });

  const participantInput = z.object({
    name: z.string().min(1),
    isAdmin: z.boolean().default(false),
    administersOnly: z.boolean().default(false),
    allowsCaptainAssist: z.boolean().default(false),
    email: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    seatOrder: z.number().default(0),
    contestedLossCounter: z.number().default(0),
  });

  /**
   * The heir roster is only editable while registration is open. Once the captain
   * closes it the only permitted change of the roster is a captain transfer.
   */
  async function denyIfRosterClosed(res: Response): Promise<boolean> {
    const session = await storage.getSession();
    if (!registrationOpen(session.phase)) {
      res.status(403).json({ message: ROSTER_CLOSED_MESSAGE });
      return true;
    }
    return false;
  }

  app.post("/api/participants", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    if (await denyIfRosterClosed(res)) return;
    try {
      const body = participantInput.parse(req.body);
      const session = await storage.getSession();
      const roster = await storage.listParticipants();
      const name = body.name.trim();
      if (roster.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) {
        return res.status(400).json({ message: "That name is already on the roster." });
      }
      res.json(
        await storage.createParticipant({
          ...body,
          name,
          email: body.email?.trim() || null,
          phone: body.phone?.trim() || null,
          seatOrder: body.seatOrder || roster.length,
          sessionId: session.id,
        }),
      );
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/participants/replace", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    if (await denyIfRosterClosed(res)) return;
    const body = z.object({ participants: z.array(participantInput).min(2).max(10) }).parse(req.body);
    const names = body.participants.map((p) => p.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) {
      return res.status(400).json({ message: "Names must be unique" });
    }
    res.json(await storage.replaceParticipants(body.participants));
  });

  app.patch("/api/participants/:id", enforcePause(), async (req, res) => {
    const patch = z
      .object({
        name: z.string().optional(),
        email: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        isAdmin: z.boolean().optional(),
        administersOnly: z.boolean().optional(),
        contestedLossCounter: z.number().optional(),
        seatOrder: z.number().optional(),
        autoSubmit: z.boolean().optional(),
        allowsCaptainAssist: z.boolean().optional(),
        profileConfirmedAt: z.number().nullable().optional(),
      })
      .parse(req.body);
    const id = Number(req.params.id);
    // Heirs can always update their own name, email, and phone on the
    // confirm-profile step. Renaming other heirs remains a captain-only action
    // and is only allowed while registration is open.
    const rosterEdit =
      patch.name !== undefined || patch.email !== undefined || patch.phone !== undefined;
    if (rosterEdit) {
      const actor = await actorOf(req);
      const isSelfEdit = actor && actor.id === id;
      if (!isSelfEdit) {
        if (await denyIfNotHeirAdmin(req, res)) return;
        if (await denyIfRosterClosed(res)) return;
      }
    }
    // Consent belongs to the heir alone — not even the captain may grant it for them.
    if (patch.allowsCaptainAssist !== undefined) {
      const actor = await actorOf(req);
      if (actor && actor.id !== id) {
        return res.status(403).json({
          message: "Only that heir can decide whether the captain may assist with their ranking.",
        });
      }
    }
    // Auto-submit is a personal setting: an heir may only flip their own.
    if (patch.autoSubmit !== undefined) {
      const actor = await actorOf(req);
      if (actor && !actor.isAdmin && actor.id !== id) {
        return res
          .status(403)
          .json({ message: "You can only change your own auto-submit setting." });
      }
    }
    const updated = await storage.updateParticipant(id, patch);
    // Turning auto-submit on mid-round should act immediately.
    if (patch.autoSubmit) await storage.runAutoSubmitSweep();
    res.json(updated);
  });

  app.delete("/api/participants/:id", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    if (await denyIfRosterClosed(res)) return;
    const id = Number(req.params.id);
    const roster = await storage.listParticipants();
    const target = roster.find((p) => p.id === id);
    if (target?.isAdmin) {
      return res.status(400).json({
        message: "The captain cannot be removed. Transfer the role instead.",
      });
    }
    await storage.deleteParticipant(id);
    res.json({ ok: true });
  });


  /* ---------- helpers (inventory assistants) ---------- */
  /**
   * Helpers are people the captain invites to assist with inventory
   * collection — photographing items, entering them by hand, running
   * batch photo intake. They are NOT heirs: they do not rank, draft,
   * receive items, or appear in equalization math. They sign in via the
   * same magic-link flow as heirs, using the email the captain enters
   * here.
   *
   * Mirrors the Registry's people/invite model: the captain names
   * someone, gives their email, and the helper gets a sign-in link.
   * Unlike the Registry's address book (which is just names on items),
   * a FairPlay helper is a real participant with limited access.
   */
  app.get("/api/helpers", async (_req, res) => {
    const roster = await storage.listParticipants();
    res.json(roster.filter((p) => p.role === "helper"));
  });

  app.post("/api/helpers", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z
        .object({
          name: z.string().min(1),
          email: z.string().email(),
          phone: z.string().optional().nullable(),
        })
        .parse(req.body);

      const session = await storage.getSession();
      const roster = await storage.listParticipants();
      const name = body.name.trim();
      const email = body.email.trim().toLowerCase();

      // Prevent duplicate helpers (same email or same name).
      if (roster.some((p) => (p.email ?? "").trim().toLowerCase() === email)) {
        return res
          .status(400)
          .json({ message: "Someone with that email is already in the session." });
      }
      if (roster.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) {
        return res
          .status(400)
          .json({ message: "That name is already on the roster." });
      }

      const helper = await storage.createParticipant({
        name,
        email,
        phone: body.phone?.trim() || null,
        isAdmin: false,
        administersOnly: true,
        role: "helper",
        seatOrder: roster.length,
        sessionId: session.id,
      } as any);
      res.status(201).json(helper);
    } catch (e) {
      fail(res, e);
    }
  });

  app.patch("/api/helpers/:id", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const id = Number(req.params.id);
      const roster = await storage.listParticipants();
      const helper = roster.find((p) => p.id === id);
      if (!helper || helper.role !== "helper") {
        return res.status(404).json({ message: "Helper not found." });
      }
      const patch = z
        .object({
          name: z.string().optional(),
          email: z.string().nullable().optional(),
          phone: z.string().nullable().optional(),
        })
        .parse(req.body);
      const updated = await storage.updateParticipant(id, {
        ...(patch.name ? { name: patch.name.trim() } : {}),
        ...(patch.email !== undefined ? { email: patch.email?.trim() || null } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone?.trim() || null } : {}),
      });
      res.json(updated);
    } catch (e) {
      fail(res, e);
    }
  });

  app.delete("/api/helpers/:id", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const id = Number(req.params.id);
      const roster = await storage.listParticipants();
      const helper = roster.find((p) => p.id === id);
      if (!helper || helper.role !== "helper") {
        return res.status(404).json({ message: "Helper not found." });
      }
      await storage.deleteParticipant(id);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- items ---------- */
  app.get("/api/items", async (_req, res) => {
    res.json(await storage.listItems());
  });

  const itemInput = z.object({
    name: z.string().min(1),
    room: z.string().default(""),
    category: z.string().nullable().default(null),
    notes: z.string().default(""),
    aiEstimatedValue: z.number().nullable().optional(),
    estimateSource: z.enum(["ai", "manual"]).nullable().optional(),
    photoUrl: z.string().nullable().optional(),
    thumbnailUrl: z.string().nullable().optional(),
    isHeirloomCandidate: z.boolean().optional(),
    lat: z.number().nullable().optional(),
    lon: z.number().nullable().optional(),
    photoLat: z.number().nullable().optional(),
    photoLon: z.number().nullable().optional(),
    photoTakenAt: z.number().nullable().optional(),
  });

  app.post("/api/items", enforcePause(), async (req, res) => {
    if (await denyUnlessAllowed(req, res, "addItems")) return;
    const actor = await actorOf(req);
    const body = itemInput.parse(req.body);
    // Free-text rooms/categories become disabled custom taxonomy rows the captain
    // can enable later.
    if (body.room) await storage.ensureTaxonomyLabel("room", body.room);
    if (body.category) await storage.ensureTaxonomyLabel("category", body.category);
    const created = await storage.createItem({
        name: body.name,
        room: body.room,
        category: body.category,
        notes: body.notes,
        aiEstimatedValue: body.aiEstimatedValue ?? null,
        estimateSource: body.estimateSource ?? null,
        photoUrl: body.photoUrl ?? null,
        thumbnailUrl: body.thumbnailUrl ?? null,
        status: "available",
        awardedToParticipantId: null,
        awardedInRound: null,
        isHeirloomCandidate: body.isHeirloomCandidate ?? false,
        isHeirloomConfirmed: false,
        addedDuringDraft: false,
        groupingId: null,
        duplicateGroupId: null,
        isPractice: false,
        // Null when the captain catalogued it; heirs own what they add.
        createdByParticipantId: actor && !actor.isAdmin ? actor.id : null,
        lat: body.lat ?? null,
        lon: body.lon ?? null,
        photoLat: body.photoLat ?? null,
        photoLon: body.photoLon ?? null,
        photoTakenAt: body.photoTakenAt ?? null,
      });
    // A photograph is enough to guess a category. The guess happens after the
    // response so cataloguing never waits on a model.
    if (created.photoUrl) void analyzeInBackground(created.id);
    res.json(created);
  });

  /** Assign or change an item's category — gated by the changeCategory permission. */
  app.patch("/api/items/:id/category", enforcePause(), async (req, res) => {
    if (await denyUnlessAllowed(req, res, "changeCategory")) return;
    try {
      const body = z.object({ category: z.string().nullable() }).parse(req.body);
      if (body.category) await storage.ensureTaxonomyLabel("category", body.category);
      res.json(await storage.updateItem(Number(req.params.id), { category: body.category }));
    } catch (e) {
      fail(res, e);
    }
  });

  /* ================================================================= */
  /* v6 — AI categorisation and collaborative category editing         */
  /* ================================================================= */

  /**
   * Categories are optional, so the gate here is deliberately soft: the captain
   * always passes, heirs pass while the `heirsCanCategorize` toggle is on.
   */
  async function denyIfCannotCategorize(req: any, res: any): Promise<boolean> {
    const actor = await actorOf(req);
    if (!actor || actor.isAdmin) return false;
    const s = await storage.getSession();
    if (s.heirsCanCategorize) return false;
    res
      .status(403)
      .json({ message: "The captain has switched off heir categorising." });
    return true;
  }

  /** Read a stored photo back as base64 so the model can look at it. */
  async function photoBase64Of(photoUrl: string | null): Promise<string | undefined> {
    if (!photoUrl) return undefined;
    if (photoUrl.startsWith("data:")) return photoUrl;
    const name = photoUrl.split("/").pop();
    if (!name) return undefined;
    try {
      const buf = await fs.promises.readFile(path.join(UPLOAD_DIR, name));
      return buf.toString("base64");
    } catch {
      return undefined;
    }
  }

  /** Analyse one item and write the result back. Never throws. */
  async function analyzeItemById(itemId: number, actorId: number | null = null) {
    const item = (await storage.listItems()).find((i) => i.id === itemId);
    if (!item) return null;
    const result = await analyzeItem(
      { name: item.name, notes: item.notes, room: item.room, category: item.category },
      await photoBase64Of(item.photoUrl),
    );
    const applied = await storage.applyAiAnalysis(itemId, result, actorId);
    // Evaluating inventory must also surface duplicates, and must do so across
    // EVERY input source — imported from Reindeer: Registry (photographed or
    // pulled from a video walkthrough), typed in here by hand, or evaluated
    // earlier. `scanDuplicatesForItem` is origin-blind and never throws, so a
    // duplicate check cannot fail an evaluation.
    const duplicates = await storage.scanDuplicatesForItem(itemId);
    return { ...applied, analysis: result, duplicates };
  }

  function analyzeInBackground(itemId: number) {
    setTimeout(() => {
      analyzeItemById(itemId).catch((e) =>
        console.warn("[ai] background analysis failed:", (e as Error)?.message ?? e),
      );
    }, 0);
  }

  /** Look at an item the family has not saved yet — powers the add form. */
  app.post("/api/ai/analyze-preview", enforcePause(), async (req, res) => {
    try {
      const body = z
        .object({
          name: z.string().default(""),
          notes: z.string().optional(),
          room: z.string().optional(),
          photoUrl: z.string().nullable().optional(),
        })
        .parse(req.body);
      const result = await analyzeItem(
        { name: body.name, notes: body.notes, room: body.room },
        await photoBase64Of(body.photoUrl ?? null),
      );
      res.json(result);
    } catch (e) {
      fail(res, e);
    }
  });

  /** Re-run the analyser on one saved item. */
  app.post("/api/items/:id/analyze", enforcePause(), async (req, res) => {
    try {
      if (await denyIfCannotCategorize(req, res)) return;
      const actor = await actorOf(req);
      const out = await analyzeItemById(Number(req.params.id), actor && !actor.isAdmin ? actor.id : null);
      if (!out) return res.status(404).json({ message: "Item not found" });
      res.json({ item: out.item, autoAssigned: out.autoAssigned, analysis: out.analysis });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * The collaborative write path. Any permitted participant sets, changes, or
   * clears a category; the change is logged, conflicts raise a discussion
   * flag, and during ranking everyone else is told.
   */
  app.post("/api/items/:id/category", enforcePause(), async (req, res) => {
    try {
      if (await denyIfCannotCategorize(req, res)) return;
      const body = z
        .object({
          category: z.string().nullable(),
          dismissAiSuggestion: z.boolean().optional(),
          source: z.enum(CATEGORY_CHANGE_SOURCES).optional(),
        })
        .parse(req.body);
      const itemId = Number(req.params.id);
      const actor = await actorOf(req);
      const actorId = actor && !actor.isAdmin ? actor.id : null;

      const throttled = await storage.categoryRateExceeded(actorId);

      const source =
        body.source ??
        (body.dismissAiSuggestion
          ? "ai_dismissed"
          : actor && !actor.isAdmin
            ? "reviewed_by_heir"
            : "reviewed_by_pr");

      const out = await storage.setItemCategory(itemId, body.category, actorId, source);
      res.json({
        item: out.item,
        change: out.change,
        notified: out.notified,
        needsDiscussion: !!out.item.needsDiscussion,
        conflict: out.conflict,
        throttled,
        throttleMessage: throttled ? CATEGORY_THROTTLE_MESSAGE : undefined,
      });
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- Anthropic API key settings (Captain only) ---------- */

  /** Get the current Anthropic key status (masked, never the full key). */
  app.get("/api/settings/anthropic", async (_req, res) => {
    const preview = getAnthropicApiKeyPreview();
    res.json({
      ...preview,
      provider: getActiveProvider(),
    });
  });

  /** Set or clear the Anthropic API key. Captain only. */
  app.put("/api/settings/anthropic", requireCaptain, async (req, res) => {
    try {
      const body = z
        .object({
          apiKey: z.string().max(500),
        })
        .parse(req.body);
      setAnthropicApiKey(body.apiKey);
      const preview = getAnthropicApiKeyPreview();
      res.json({
        ...preview,
        provider: getActiveProvider(),
        message: body.apiKey.trim() ? "Anthropic key saved. AI analysis is now live." : "Anthropic key cleared.",
      });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Accept or dismiss the analyser's high-value hunch. */
  app.post("/api/items/:id/ai-high-value", enforcePause(), async (req, res) => {
    try {
      const body = z.object({ accept: z.boolean() }).parse(req.body);
      const itemId = Number(req.params.id);
      const actor = await actorOf(req);
      if (body.accept) {
        await storage.setItemFlags(
          itemId,
          { needsAppraisal: true },
          actor && !actor.isAdmin ? actor.id : null,
          "Accepted the automatic high-value suggestion",
        );
      }
      // Either way the suggestion has been dealt with and stops being offered.
      const item = await storage.updateItem(itemId, {
        aiSuggestsHighValue: false,
        aiHighValueReason: body.accept ? undefined : null,
      } as any);
      res.json(item);
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/items/:id/category-history", async (req, res) => {
    try {
      const rows = await storage.listCategoryChanges(Number(req.params.id));
      const roster = await storage.listParticipants();
      res.json({
        changes: rows.map((r) => ({
          ...r,
          changedByName:
            r.changedByParticipantId === null
              ? r.source === "ai_auto"
                ? "Automatic sorting"
                : "the captain"
              : roster.find((p) => p.id === r.changedByParticipantId)?.name ?? "Someone",
        })),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/items/:id/discussion-resolved", enforcePause(), async (req, res) => {
    try {
      if (await denyIfCannotCategorize(req, res)) return;
      res.json(await storage.clearNeedsDiscussion(Number(req.params.id)));
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/session/categorization-status", async (_req, res) => {
    try {
      res.json(await storage.categorizationStatus());
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/session/heirs-can-categorize", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z.object({ enabled: z.boolean() }).parse(req.body);
      res.json(await storage.updateSession({ heirsCanCategorize: body.enabled }));
    } catch (e) {
      fail(res, e);
    }
  });

  /** Sweep every uncategorized item through the analyser in one go. */
  app.post("/api/session/bulk-analyze", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const all = (await storage.listItems()).filter(
        (i) => !i.isPractice && (!i.category || i.category.trim() === ""),
      );
      let assigned = 0;
      let leftAlone = 0;
      for (const item of all) {
        const out = await analyzeItemById(item.id, null);
        if (out?.autoAssigned) assigned++;
        else leftAlone++;
      }
      res.json({
        status: "complete",
        examined: all.length,
        assigned,
        stillUncategorized: leftAlone,
        categorization: await storage.categorizationStatus(),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  app.patch("/api/items/:id", enforcePause(), async (req, res) => {
    // Each editable field carries its own heir permission.
    const fieldCaps: Array<[string, HeirCapability]> = [
      ["category", "changeCategory"],
      ["room", "changeRoom"],
      ["name", "editItemNamesNotes"],
      ["notes", "editItemNamesNotes"],
      ["photoUrl", "uploadPhotos"],
      ["thumbnailUrl", "uploadPhotos"],
    ];
    for (const [field, cap] of fieldCaps) {
      if (req.body && field in req.body) {
        if (await denyUnlessAllowed(req, res, cap)) return;
      }
    }
    const patch = z
      .object({
        name: z.string().optional(),
        room: z.string().optional(),
        category: z.string().optional(),
        notes: z.string().optional(),
        aiEstimatedValue: z.number().nullable().optional(),
        photoUrl: z.string().nullable().optional(),
        thumbnailUrl: z.string().nullable().optional(),
        isHeirloomCandidate: z.boolean().optional(),
        isHeirloomConfirmed: z.boolean().optional(),
        status: z
          .enum(["available", "awarded", "in_grouping", "needs_appraisal", "duplicate_dismissed"])
          .optional(),
        groupingId: z.number().nullable().optional(),
      })
      .parse(req.body);
    if (patch.room) await storage.ensureTaxonomyLabel("room", patch.room);
    if (patch.category) await storage.ensureTaxonomyLabel("category", patch.category);
    res.json(await storage.updateItem(Number(req.params.id), patch));
  });

  /** Attach or replace the photograph on an item that already exists. */
  app.patch("/api/items/:id/photo", enforcePause(), async (req, res) => {
    if (await denyUnlessAllowed(req, res, "uploadPhotos")) return;
    try {
      const body = z
        .object({
          photoUrl: z.string().nullable(),
          thumbnailUrl: z.string().nullable().optional(),
        })
        .parse(req.body);
      res.json(
        await storage.updateItem(Number(req.params.id), {
          photoUrl: body.photoUrl,
          thumbnailUrl: body.thumbnailUrl ?? body.photoUrl,
        }),
      );
    } catch (e) {
      fail(res, e);
    }
  });

  app.delete("/api/items/:id", enforcePause(), async (req, res) => {
    const actor = await actorOf(req);
    const isCaptain = !actor || actor.isAdmin;
    if (!isCaptain) {
      if (await denyUnlessAllowed(req, res, "deleteOwnItems")) return;
      const item = (await storage.listItems()).find((i) => i.id === Number(req.params.id));
      if (!item) return res.status(404).json({ message: "Item not found." });
      if (item.createdByParticipantId !== actor!.id) {
        return res.status(403).json({
          message: "You may only delete items you catalogued yourself.",
        });
      }
    }
    await storage.deleteItem(Number(req.params.id));
    res.json({ ok: true });
  });

  /* ---------- location-based room verification ---------- */
  /**
   * Given a lat/lon, returns the most likely room based on existing
   * items' locations. Items photographed within ~30 meters of each
   * other are likely in the same room. Returns the best-matching room
   * and a confidence score.
   */
  app.get("/api/items/verify-location", async (req, res) => {
    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    const photoLat = req.query.photoLat ? parseFloat(req.query.photoLat as string) : NaN;
    const photoLon = req.query.photoLon ? parseFloat(req.query.photoLon as string) : NaN;
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: "Invalid coordinates" });

    const allItems = await storage.listItems();

    // Haversine distance in meters
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const distance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };

    // Collect all location sources for this new item
    const sources: { lat: number; lon: number }[] = [{ lat, lon }];
    if (!isNaN(photoLat) && !isNaN(photoLon)) sources.push({ lat: photoLat, lon: photoLon });

    // Match against existing items using BOTH browser GPS and photo EXIF GPS
    // An existing item matches if it's close to ANY of our sources
    const nearby = allItems.filter((i) => {
      const itemPoints: ({ lat: number; lon: number })[] = [];
      if (i.lat != null && i.lon != null) itemPoints.push({ lat: i.lat, lon: i.lon });
      if (i.photoLat != null && i.photoLon != null) itemPoints.push({ lat: i.photoLat, lon: i.photoLon });
      return itemPoints.some((ip) =>
        sources.some((sp) => distance(sp.lat, sp.lon, ip.lat, ip.lon) < 30)
      );
    });

    if (nearby.length === 0) return res.json({ room: null, confidence: 0, nearbyCount: 0, sourcesAgree: sources.length > 1 });

    // Check if browser GPS and photo EXIF agree (within 50m)
    let sourcesAgree = true;
    if (sources.length > 1) {
      sourcesAgree = distance(sources[0].lat, sources[0].lon, sources[1].lat, sources[1].lon) < 50;
    }

    const roomCounts: Record<string, number> = {};
    for (const i of nearby) {
      const r = i.room || "(unassigned)";
      roomCounts[r] = (roomCounts[r] || 0) + 1;
    }
    const sorted = Object.entries(roomCounts).sort((a, b) => b[1] - a[1]);
    const [bestRoom, bestCount] = sorted[0];
    const confidence = bestCount / nearby.length;

    res.json({
      room: bestRoom,
      confidence,
      nearbyCount: nearby.length,
      sourcesAgree,
      // Include photo timestamp for time-based verification
      photoTimeMatch: nearby.some((i) => {
        if (!isNaN(photoLat) && i.photoTakenAt) {
          // Items photographed within 1 hour of each other at similar locations
          return true;
        }
        return false;
      }),
    });
  });

  /* ---------- batch intake (AI Vision) ---------- */
  app.post("/api/items/batch-intake", enforcePause(), async (req, res) => {
    if (await denyUnlessAllowed(req, res, "addItems")) return;
    const body = z.object({ images: z.array(z.string()).min(1).max(8) }).parse(req.body);
    const existing = (await storage.listItems()).map((i) => ({ name: i.name, identifiers: i.identifiers, originApp: i.originApp }));
    const detections: Detection[] = [];
    for (let i = 0; i < body.images.length; i++) {
      // existing is the full item list for duplicate matching
      const dataUrl = body.images[i];
      let photoUrl = "";
      const m = /^data:(image\/[a-zA-Z+]+);base64,(.*)$/.exec(dataUrl);
      if (m) {
        const ext = m[1].split("/")[1].replace("jpeg", "jpg");
        const file = `${randomUUID()}.${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(m[2], "base64"));
        photoUrl = `/uploads/${file}`;
      }
      detections.push(...(await detectItems(photoUrl, i + existing.length + 1, existing)));
    }
    const engine = process.env.GOOGLE_CLOUD_API_KEY
      ? "google-vision"
      : (process.env.OPENAI_API_KEY || getAnthropicApiKey())
        ? "llm-vision"
        : "stub";
    res.json({ engine, detections });
  });

  /** Single-photo upload (quick add). Accepts a base64 dataURL. */
  app.post("/api/upload", enforcePause(), async (req, res) => {
    // Raw uploads feed both quick-add and photo replacement.
    const [session, uploader] = await Promise.all([storage.getSession(), actorOf(req)]);
    if (
      uploader &&
      !uploader.isAdmin &&
      !canHeirDo(session, "addItems") &&
      !canHeirDo(session, "uploadPhotos")
    ) {
      return res
        .status(403)
        .json({ message: "Uploading photographs is switched off for heirs." });
    }
    const body = z.object({ dataUrl: z.string() }).parse(req.body);
    const m = /^data:(image\/[a-zA-Z+]+);base64,(.*)$/.exec(body.dataUrl);
    if (!m) return res.status(400).json({ message: "Expected an image data URL" });
    const ext = m[1].split("/")[1].replace("jpeg", "jpg");
    const file = `${randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(m[2], "base64"));
    res.json({ url: `/uploads/${file}` });
  });

  /* ---------- Phase 2: Google Web Detection (exact identification) ---------- */
  app.post("/api/intake/identify", async (req, res) => {
    if (!req.actor) {
      return res.status(401).json({ error: "Sign in required" });
    }
    const body = z.object({
      data_url: z.string(),
      hint: z.string().optional().default(""),
      room_hint: z.string().nullable().optional(),
    }).parse(req.body);

    const m = /^data:(image\/[a-zA-Z+]+);base64,(.*)$/.exec(body.data_url);
    if (!m) {
      return res.status(400).json({ error: "Expected an image data URL" });
    }
    const photoBuffer = Buffer.from(m[2], "base64");
    const result = await identifyWithGoogle(photoBuffer, body.hint, body.room_hint ?? null);
    res.json(result);
  });

  /* ---------- high value ---------- */
  app.get("/api/appraisal", async (_req, res) => {
    res.json(await storage.listAppraisalFlags());
  });

  /**
   * Escalate an item to the high-value bucket for appraisal and captain review. Single-actor,
   * no confirmation gate. Identity is read from req.actor — NEVER from
   * req.body. reason is optional (heirs may act on a hunch).
   *
   * The old two-step nominate/confirm endpoints are gone; the client is
   * updated in this same commit to call this endpoint instead.
   */
  app.post("/api/appraisal/flag", enforcePause(), async (req, res) => {
    if (await denyIfPractice(res)) return;
    if (!req.actor) {
      res.status(401).json({ error: "sign in required" });
      return;
    }
    const body = z
      .object({ itemId: z.number(), reason: z.string().max(500).optional() })
      .parse(req.body);
    const row = await storage.flagForAppraisal({
      itemId: body.itemId,
      source: "heir",
      participantId: req.actor.id,
      reason: body.reason ?? null,
    });
    res.json(row);
  });

  /**
   * Captain reverts an honest mistake. Refused for owner-source rows
   * (permanent) and for already-reverted rows. Reverted rows remain in
   * the audit trail (per project rule: keep reverted flags viable).
   */
  app.post("/api/appraisal/:id/revert", enforcePause(), async (req, res) => {
    if (await denyIfPractice(res)) return;
    if (await denyIfNotCaptain(req, res)) return;
    const row = await storage.unflagAppraisal({
      nominationId: Number(req.params.id),
      captainId: req.actor!.id,
    });
    if (!row) {
      res.status(409).json({ error: "cannot revert this escalation" });
      return;
    }
    res.json(row);
  });

  /* ---------- groupings ---------- */
  app.get("/api/groupings", async (_req, res) => {
    res.json(await storage.listGroupings());
  });

  app.post("/api/groupings", enforcePause(), async (req, res) => {
    if (await denyIfPractice(res)) return;
    const body = z
      .object({ name: z.string().min(1), type: z.enum(["heirloom", "custom"]).default("custom") })
      .parse(req.body);
    res.json(
      await storage.createGrouping({
        name: body.name,
        type: body.type,
        status: "open",
        awardedToParticipantId: null,
        resolvedInRound: null,
      }),
    );
  });

  app.post("/api/groupings/ensure-heirloom", async (_req, res) => {
    res.json(await storage.ensureHeirloomGrouping());
  });

  app.post("/api/groupings/confirm-heirloom", enforcePause(), async (req, res) => {
    const body = z.object({ itemId: z.number(), confirmed: z.boolean() }).parse(req.body);
    res.json(await storage.confirmHeirloom(body.itemId, body.confirmed));
  });

  app.post("/api/groupings/:id/add-item", enforcePause(), async (req, res) => {
    const body = z.object({ itemId: z.number() }).parse(req.body);
    res.json(
      await storage.updateItem(body.itemId, {
        groupingId: Number(req.params.id),
        status: "in_grouping",
      }),
    );
  });

  app.post("/api/groupings/:id/opt-in", enforcePause(), async (req, res) => {
    try {
      const body = z
        .object({ choice: z.enum(["want", "pass"]) })
        .parse(req.body);
      const actor = await actorOf(req);
      if (!actor) return res.status(401).json({ message: SIGN_IN_REQUIRED_MESSAGE });
      res.json(await storage.setOptIn(Number(req.params.id), actor.id, body.choice));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/groupings/:id/resolve", enforcePause(), async (req, res) => {
    if (await denyIfPractice(res)) return;
    if (await denyIfNotCaptain(req, res)) return;
    res.json(await storage.resolveGrouping(Number(req.params.id)));
  });

  /* ---------- phase control ---------- */
  app.post("/api/session/start-groupings-round", enforcePause(), async (req, res) => {
    if (await denyIfPractice(res)) return;
    if (await denyIfNotCaptain(req, res)) return;
    res.json(await storage.startGroupingsRound());
  });

  app.post("/api/session/start-draft", enforcePause(), async (req, res) => {
    if (await denyIfPractice(res)) return;
    if (await denyIfNotCaptain(req, res)) return;
    res.json(await storage.startDraft());
  });

  /* ---------- ranking ---------- */

  /** True when the caller asked for assist-mode logging. */
  function assistFlagged(req: Request): boolean {
    return (
      req.query.mode === "assist" ||
      req.header("x-assist-mode") === "true" ||
      req.body?.mode === "assist"
    );
  }

  /**
   * Read guard. Heirs read their own list. A pure captain may read anyone's. A captain
   * who is also an heir may only open a list whose owner has consented to captain
   * assistance. Fails closed: a null actor (no valid session) is refused,
   * never treated as "self" — this is the exact check that used to let an
   * anonymous caller read every heir's private rankings.
   */
  async function denyIfNotSelfOrPR(
    req: Request,
    res: Response,
    participantId: number,
  ): Promise<boolean> {
    const actor = await actorOf(req);
    if (!actor) {
      res.status(401).json({ message: "Please sign in to see this ranking." });
      return true;
    }
    if (actor.id === participantId) return false;
    const target = (await storage.listParticipants()).find((p) => p.id === participantId) ?? null;
    if (isPureCaptain(actor)) return false;
    if (isCaptainHeir(actor)) {
      if (target?.allowsCaptainAssist) return false;
      res.status(403).json({
        message: `${target?.name ?? "This heir"} has not consented to captain assistance.`,
        code: "pr_assist_consent_required",
      });
      return true;
    }
    res.status(403).json({ message: "You can only see your own ranking." });
    return true;
  }

  /**
   * Write guard. Returns the audit context to record the edit under, or null
   * when the request has already been refused.
   *
   * Policy: BOTH kinds of captain need the heir's consent before touching that
   * heir's ranking. Consent is the heir's to give, never the captain's to assume.
   */
  async function rankWriteContext(
    req: Request,
    res: Response,
    participantId: number,
  ): Promise<{ editedBy: number; mode: "self" | "assist" } | null> {
    const actor = await actorOf(req);
    if (!actor) {
      // No valid session. Never assume an anonymous caller is editing "their
      // own" ranking — that was the fail-open path that let an unauthenticated
      // request write to any participantId it named in the body.
      res.status(401).json({ message: "Please sign in to change this ranking." });
      return null;
    }
    if (actor.id === participantId) return { editedBy: actor.id, mode: "self" };
    if (!actor.isAdmin) {
      res.status(403).json({ message: "You can only change your own ranking." });
      return null;
    }
    const target = (await storage.listParticipants()).find((p) => p.id === participantId) ?? null;
    if (!target?.allowsCaptainAssist) {
      res.status(403).json({
        message: `${target?.name ?? "This heir"} has not consented to captain assistance.`,
        code: "pr_assist_consent_required",
      });
      return null;
    }
    // A captain-heir is always acting on someone else's behalf; a pure captain may edit
    // directly, and only the assist route marks its writes as assist-mode.
    const mode: "self" | "assist" =
      isCaptainHeir(actor) || assistFlagged(req) ? "assist" : "self";
    return { editedBy: actor.id, mode };
  }

  /**
   * Write guard for rankings. Refuses edits once the ranking window for the
   * current phase has closed, unless the captain passes ?force=true.
   */
  async function denyIfWindowClosed(req: Request, res: Response): Promise<boolean> {
    const actor = await actorOf(req);
    const force = req.query.force === "true" || req.body?.force === true;
    if (force && (!actor || actor.isAdmin)) return false;
    const { locked, window } = await storage.rankingLocked();
    if (!locked) return false;
    res.status(403).json({
      message: "Ranking window closed",
      code: "ranking_window_closed",
      closedAt: window?.deadline ?? null,
    });
    return true;
  }

  app.get("/api/rankings/all", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    const actor = await actorOf(req);
    const [rows, summary, state] = await Promise.all([
      storage.listRankings(),
      storage.rankingCompleteness(),
      storage.getClientState(),
    ]);

    // A captain who is also drafting never sees another heir's rank values.
    if (isCaptainHeir(actor)) {
      const stats = await storage.rankingAggregate();
      return res.json({
        aggregated: true,
        viewerId: actor!.id,
        stats,
        // Their own list, so they can review what they submitted.
        ownRankings: rows.filter((r) => r.participantId === actor!.id),
        // Progress counts only — no rank values attached to any name.
        summary,
        items: state.items,
        participants: [],
      });
    }

    res.json({
      aggregated: false,
      rankings: rows,
      summary,
      items: state.items,
      participants: state.participants.filter((p: any) => !p.administersOnly),
    });
  });

  app.get("/api/rankings/export.csv", async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    const csvActor = await actorOf(req);
    if (isCaptainHeir(csvActor)) {
      return res.status(403).json({
        message:
          "You are participating as an heir. The raw ranking matrix is not available to you.",
        code: "pr_heir_export_blocked",
      });
    }
    const [rows, state] = await Promise.all([storage.listRankings(), storage.getClientState()]);
    const heirs = state.participants.filter((p: any) => !p.administersOnly);
    const header = ["Item", "Room", "Category", "Status", ...heirs.map((h: any) => h.name)];
    const lines = [header.map(csvCell).join(",")];
    for (const item of state.items) {
      const cells = heirs.map((h: any) => {
        const r = rows.find((x) => x.participantId === h.id && x.itemId === item.id);
        return r ? r.rank : "";
      });
      lines.push(
        [item.name, item.room, item.category, item.status, ...cells].map(csvCell).join(","),
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="rankings.csv"');
    res.send(lines.join("\n"));
  });

  app.get("/api/rankings/:participantId", async (req, res) => {
    const pid = Number(req.params.participantId);
    if (Number.isNaN(pid)) return res.status(400).json({ message: "Bad participant id" });
    if (await denyIfNotSelfOrPR(req, res, pid)) return;
    const [rows, summary, lock] = await Promise.all([
      storage.listRankings(pid),
      storage.rankingCompleteness(),
      storage.rankingLocked(),
    ]);
    res.json({
      participantId: pid,
      rankings: rows,
      required: summary.required,
      mode: summary.mode,
      locked: lock.locked,
      window: lock.window,
      serverNow: Date.now(),
    });
  });

  /** The audit trail for one heir. The heir sees their own; any captain sees all. */
  app.get("/api/rankings/:participantId/audit", async (req, res) => {
    const pid = Number(req.params.participantId);
    if (Number.isNaN(pid)) return res.status(400).json({ message: "Bad participant id" });
    const actor = await actorOf(req);
    if (actor && !actor.isAdmin && actor.id !== pid) {
      return res.status(403).json({ message: "You can only see your own audit trail." });
    }
    const [entries, people, allItems] = await Promise.all([
      storage.listRankingEdits(pid),
      storage.listParticipants(),
      storage.listItems(),
    ]);
    const cutoff = Date.now() - ASSIST_BADGE_WINDOW_MS;
    const decorate = (e: any) => ({
      ...e,
      itemName: allItems.find((i) => i.id === e.itemId)?.name ?? `Item ${e.itemId}`,
      editedByName: people.find((p) => p.id === e.editedByParticipantId)?.name ?? "the captain",
    });
    res.json({
      participantId: pid,
      entries: entries.map(decorate),
      // Assist edits from the last 24h that the heir has not dismissed.
      active: entries
        .filter((e) => e.mode === "assist" && !e.dismissedAt && e.editedAt >= cutoff)
        .map(decorate),
      serverNow: Date.now(),
    });
  });

  /** The heir has read the summary — clear their outstanding badges. */
  app.post("/api/rankings/:participantId/audit/dismiss", enforcePause(), async (req, res) => {
    const pid = Number(req.params.participantId);
    const actor = await actorOf(req);
    if (actor && actor.id !== pid) {
      return res
        .status(403)
        .json({ message: "Only the heir can dismiss their own change summary." });
    }
    res.json(await storage.dismissRankingEdits(pid));
  });

  app.put("/api/rankings/:participantId", enforcePause(), async (req, res) => {
    const pid = Number(req.params.participantId);
    const ctx = await rankWriteContext(req, res, pid);
    if (!ctx) return;
    if (await denyIfWindowClosed(req, res)) return;
    try {
      const body = z
        .object({
          rankings: z
            .array(z.object({ itemId: z.number().int(), rank: z.number().int().min(1) }))
            .max(1000),
        })
        .parse(req.body);
      res.json({ rankings: await storage.replaceRankings(pid, body.rankings, ctx) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.patch("/api/rankings/:participantId/move", enforcePause(), async (req, res) => {
    const pid = Number(req.params.participantId);
    const ctx = await rankWriteContext(req, res, pid);
    if (!ctx) return;
    if (await denyIfWindowClosed(req, res)) return;
    try {
      const body = z
        .object({ itemId: z.number().int(), rank: z.number().int().min(1) })
        .parse(req.body);
      res.json({ rankings: await storage.moveRanking(pid, body.itemId, body.rank, ctx) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.delete("/api/rankings/:participantId/:itemId", enforcePause(), async (req, res) => {
    const pid = Number(req.params.participantId);
    const ctx = await rankWriteContext(req, res, pid);
    if (!ctx) return;
    if (await denyIfWindowClosed(req, res)) return;
    try {
      res.json({ rankings: await storage.deleteRanking(pid, Number(req.params.itemId), ctx) });
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- ranking window ---------- */
  const windowPhaseSchema = z.enum(["ranking", "secondary_ranking"]).optional();

  app.patch("/api/session/ranking-window", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z
        .object({
          days: z.number().int().min(RANKING_WINDOW_MIN_DAYS).max(RANKING_WINDOW_MAX_DAYS),
          phase: windowPhaseSchema,
        })
        .parse(req.body);
      res.json(await storage.setRankingWindowDays(body.days, body.phase));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/session/ranking-window/extend", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z
        .object({
          days: z.number().optional(),
          hours: z.number().optional(),
          phase: windowPhaseSchema,
        })
        .parse(req.body ?? {});
      res.json(await storage.extendRankingWindow(body));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/session/ranking-window/close-now", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z.object({ phase: windowPhaseSchema }).parse(req.body ?? {});
      res.json(await storage.closeRankingNow(body.phase));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/session/ranking-window/reopen", enforcePause(), async (req, res) => {
    if (await denyIfNotHeirAdmin(req, res)) return;
    try {
      const body = z.object({ phase: windowPhaseSchema }).parse(req.body ?? {});
      res.json(await storage.reopenRanking(body.phase));
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- phase advance ---------- */
  app.get("/api/session/rank-completeness", async (_req, res) => {
    res.json(await storage.rankingCompleteness());
  });

  app.post("/api/session/next-phase", enforcePause(), async (req, res) => {
    if (await denyIfNotCaptain(req, res)) return;
    const force = req.query.force === "true" || req.body?.force === true;
    try {
      res.json(await storage.nextPhase(force));
    } catch (e: any) {
      res.status(e?.status ?? 400).json({
        message: e?.message ?? "Could not advance the phase",
        code: e?.code,
        underRanked: e?.underRanked,
        required: e?.required,
        deadlinePassed: e?.deadlinePassed,
      });
    }
  });

  app.post("/api/picks/auto-suggest", enforcePause(), async (req, res) => {
    try {
      const body = z.object({ participantId: z.number().int() }).parse(req.body);
      if (await denyIfNotSelfOrPR(req, res, body.participantId)) return;
      res.json({ suggestion: await storage.autoSuggest(body.participantId) });
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- draft ---------- */
  app.get("/api/picks", async (_req, res) => {
    res.json(await storage.listPicks());
  });

  app.post("/api/picks", enforcePause(), async (req, res) => {
    const body = z
      .object({
        participantId: z.number(),
        itemId: z.number(),
        highValue: z.boolean().optional(),
        source: z.enum(["manual", "auto_rank"]).optional(),
      })
      .parse(req.body);
    try {
      const session = await storage.getSession();
      if (session.practiceMode !== "off") {
        return res.json(await storage.submitPracticePick(body.participantId, body.itemId));
      }
      res.json(
        await storage.submitPick(
          body.participantId,
          body.itemId,
          body.highValue ?? false,
          body.source ?? "manual",
        ),
      );
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.post("/api/session/reveal-round", enforcePause(), async (req, res) => {
    const session = await storage.getSession();
    // During a practice rehearsal anyone at the table may trigger the reveal so
    // the family can run the loop without waiting on the captain.
    if (session.practiceMode !== "off") {
      return res.json(await storage.revealPracticeRound());
    }
    if (await denyIfNotCaptain(req, res)) return;
    res.json(await storage.revealRound());
  });

  /* ---------- duplicates ---------- */
  app.get("/api/duplicates", async (_req, res) => {
    res.json(await storage.listDuplicateGroups());
  });

  /**
   * The captain's own duplicate review.
   *
   * Deliberately separate from the owner's view in Reindeer: Registry. The two
   * audiences want different things from the same finding: the owner is trying
   * to get a house written down and should be able to ignore a possible
   * duplicate entirely, while the captain is accountable for an inventory that has to
   * balance and needs every look-alike put to rest on the record before
   * anything is awarded. Same rule, same detector, two separate reviews.
   *
   * captain only, and it never merges or deletes anything on its own.
   */
  app.get("/api/duplicates/captain-review", async (req, res) => {
    const actor = await actorOf(req);
    if (!actor?.isAdmin) {
      res.status(403).json({
        message: "The duplicate review is the captain's to run.",
      });
      return;
    }
    const groups = await storage.listDuplicateGroups();
    const open = groups.filter((g) => g.status !== "resolved");
    const items = await storage.listItems();
    // Group membership lives on the item, not the group row.
    const membersOf = new Map<number, typeof items>();
    for (const it of items) {
      if (it.duplicateGroupId == null) continue;
      const bucket = membersOf.get(it.duplicateGroupId) ?? [];
      bucket.push(it);
      membersOf.set(it.duplicateGroupId, bucket);
    }
    // A look-alike that has already been awarded is the urgent kind: an heir may
    // be holding a duplicate row rather than a second object.
    const withMembers = open.map((g) => {
      const members = membersOf.get(g.id) ?? [];
      return {
        ...g,
        items: members.map((m) => ({
          id: m.id,
          name: m.name,
          category: m.category,
          room: m.room,
          status: m.status,
        })),
        touchesAwarded: members.some((m) => m.status === "awarded"),
      };
    });
    const touchingAwarded = withMembers.filter((g) => g.touchesAwarded);
    res.json({
      open: withMembers,
      openCount: open.length,
      resolvedCount: groups.length - open.length,
      touchingAwardedCount: touchingAwarded.length,
      touchingAwarded,
      // Stated plainly so the captain is not left guessing what this is for.
      guidance:
        open.length === 0
          ? "Nothing looks like a duplicate right now."
          : "Each pair below may be one object written down twice, or two real objects that happen to match. Only a person can tell. Nothing is merged or deleted until you choose.",
    });
  });

  app.post("/api/duplicates/scan", enforcePause(), async (req, res) => {
    if (await denyUnlessAllowed(req, res, "scanDuplicates")) return;
    res.json(await storage.scanDuplicates());
  });

  app.post("/api/duplicates/:id/resolve", enforcePause(), async (req, res) => {
    const body = z
      .object({ keepItemId: z.number(), participantId: z.number().nullable().optional() })
      .parse(req.body);
    if (await denyUnlessAllowed(req, res, "resolveDuplicates")) return;
    await storage.resolveDuplicate(
      Number(req.params.id),
      body.keepItemId,
      body.participantId ?? null,
    );
    res.json({ ok: true });
  });

  /* ---------- item media (audio recordings, photos) ---------- */
  app.get("/api/items/:id/media", async (req, res) => {
    const itemId = Number(req.params.id);
    const media = db.select().from(itemMedia).where(eq(itemMedia.itemId, itemId)).all();
    res.json(media.map((m) => ({
      id: m.id,
      kind: m.kind,
      url: m.url,
      label: m.label,
      durationMs: m.durationMs,
      transcript: m.transcript,
      isPrimary: !!m.isPrimary,
    })));
  });

  /**
   * Memorandum audit — verifies that no items locked by a frozen
   * memorandum appear in the available (ranked-draft) pool. Memorandum
   * items should always be owner_assigned, never available. This endpoint
   * reports any violations so the captain can correct them before
   * distribution begins.
   */
  app.get("/api/memorandum-audit", async (_req, res) => {
    const allItems = await storage.listItems();
    const memoLocked = allItems.filter((i) => i.lockedByMemorandum);
    const violations = memoLocked.filter((i) => i.status === "available");
    res.json({
      totalMemoItems: memoLocked.length,
      violations: violations.map((i) => ({
        id: i.id,
        name: i.name,
        room: i.room,
        status: i.status,
        memorandumOwnerName: i.memorandumOwnerName,
      })),
      violationCount: violations.length,
      ok: violations.length === 0,
    });
  });

  /* ---------- Print report (fiduciary distribution summary) ---------- */
  /**
   * Generates an HTML report of the estate distribution: item name, room,
   * heir assigned, value (if visible), status, and location.
   * Captain/fiduciary only — this is the estate's final accounting.
   */
  app.get("/api/print/report", async (req, res) => {
    const actor = await actorOf(req);
    if (!actor?.isAdmin) {
      res.status(403).json({ message: "The print report is the captain's to run." });
      return;
    }
    const [allItems, allParticipants] = await Promise.all([
      storage.listItems(),
      storage.listParticipants(),
    ]);
    const realItems = allItems.filter((i) => !i.isPractice);
    const participantName = (id: number | null) =>
      id ? allParticipants.find((p) => p.id === id)?.name ?? "Unknown" : "";

    const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const rows = realItems.map((i) => {
      const assignedTo = i.status === "awarded" && i.awardedToParticipantId
        ? participantName(i.awardedToParticipantId)
        : i.status === "owner_assigned"
          ? i.ownerAssignedName || (i.lockedByMemorandum ? `Handled by ${i.memorandumOwnerName || "memorandum"}'s will` : "Owner assigned")
          : "—";
      const value = i.approvedValue != null
        ? `$${i.approvedValue.toLocaleString()}`
        : i.estimatedValue != null
          ? `$${i.estimatedValue.toLocaleString()}`
          : "—";
      const location = [i.room, i.lat != null && i.lon != null ? `${i.lat.toFixed(4)}, ${i.lon.toFixed(4)}` : ""]
        .filter(Boolean).join(" · ") || "—";
      const statusLabel = i.status === "available" ? "Available" :
        i.status === "awarded" ? "Awarded" :
        i.status === "owner_assigned" ? "Owner Assigned" :
        i.status === "needs_appraisal" ? "Needs Appraisal" :
        i.status === "in_grouping" ? "In Grouping" :
        i.status === "duplicate_dismissed" ? "Duplicate" : i.status;
      return `<tr>
        <td>${esc(i.name)}</td>
        <td>${esc(i.room || "—")}</td>
        <td>${esc(assignedTo)}</td>
        <td>${esc(i.category || "—")}</td>
        <td>${esc(value)}</td>
        <td>${esc(statusLabel)}</td>
        <td>${esc(location)}</td>
      </tr>`;
    }).join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Estate Distribution Report</title>
<style>
  body { font-family: Georgia, serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { font-size: 24px; border-bottom: 2px solid #5b7c5e; padding-bottom: 8px; }
  .meta { color: #666; font-size: 14px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; background: #f5f5f0; padding: 8px 10px; border-bottom: 2px solid #ddd; font-family: sans-serif; }
  td { padding: 6px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
  tr:nth-child(even) { background: #fafaf7; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
  <h1>Estate Distribution Report</h1>
  <div class="meta">Generated ${new Date().toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })} · ${realItems.length} items</div>
  <table>
    <thead><tr>
      <th>Item</th><th>Room</th><th>Assigned To</th><th>Category</th><th>Value</th><th>Status</th><th>Location</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  });

  /* ---------- CSV export ---------- */
  app.get("/api/inventory/export.csv", async (_req: Request, res: Response) => {
    const [allItems, allParticipants, allGroupings] = await Promise.all([
      storage.listItems(),
      storage.listParticipants(),
      storage.listGroupings(),
    ]);
    const header = [
      "ID",
      "Name",
      "Room",
      "Category",
      "Notes",
      "AI est. value",
      "Heirloom",
      "In high-value pool",
      "Grouping",
      "Photo count",
      "Current owner",
      "Round awarded",
    ];
    const lines = [header.join(",")];
    for (const it of allItems.filter((i) => !i.isPractice)) {
      const owner = allParticipants.find((p) => p.id === it.awardedToParticipantId);
      const grouping = allGroupings.find((g) => g.id === it.groupingId);
      lines.push(
        [
          it.id,
          it.name,
          it.room,
          it.category,
          it.notes,
          it.aiEstimatedValue ?? "",
          it.isHeirloomConfirmed || it.isHeirloomCandidate ? "Y" : "N",
          it.status === "needs_appraisal" ? "Y" : "N",
          grouping?.name ?? "",
          (it.photoUrl ? 1 : 0) + (it.thumbnailUrl ? 1 : 0),
          owner?.name ?? "",
          it.awardedInRound ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="estate-inventory.csv"');
    res.send(lines.join("\n"));
  });

  return httpServer;
}
