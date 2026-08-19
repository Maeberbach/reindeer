/**
 * v7 — photo categorisation with multi-provider support.
 *
 * The analyser is a convenience layer, never a gate. It answers with a
 * category only when it is confident; otherwise the item stays uncategorized
 * and a human decides later. Every failure path returns a null category
 * rather than throwing, so cataloguing never stalls on the model.
 *
 * Supports both Anthropic (Claude) and OpenAI providers. Provider selection:
 *   1. If REINDEER_VISION_PROTOCOL=anthropic and a key is available → Anthropic
 *   2. If ANTHROPIC_API_KEY is set → Anthropic
 *   3. If an OpenAI key is available → OpenAI
 *   4. Otherwise → Mock mode (deterministic, no API cost)
 *
 * Mock mode (`MOCK_AI=true`, or simply no key) returns a deterministic answer
 * derived from a hash of the item name, which lets the QA harnesses assert
 * exact outcomes without spending credits.
 */
import { AI_CATEGORY_CONFIDENCE_THRESHOLD, STANDARD_CATEGORIES } from "@shared/schema";
import { getOpenAIApiKey } from "./openaiSettings";
import { getAnthropicApiKey } from "./anthropicSettings";

export type AiSuggestion = { category: string; confidence: number };

export type AnalyzeResult = {
  /** Null whenever confidence sits below the threshold, or on any failure. */
  category: string | null;
  confidence: number;
  suggestions: AiSuggestion[];
  /**
   * Rough dollar estimate the model produced for this item. Never a real
   * appraisal — the model has no way to see the piece in person. The
   * trustee still commissions professional appraisals for anything that
   * matters. Null when the model didn't offer one or the parse failed.
   *
   * Consumed by the intake auto-flag path: an item whose estimate is at
   * least 85% of the session's appraisal threshold gets flagged for the
   * trustee automatically. The captain can undo the flag; the reason string
   * carries the estimate for their review.
   */
  estimatedValueUsd: number | null;
  highValue: boolean;
  highValueReason?: string;
  /** 'mock' | 'openai' | 'anthropic' | 'error' — recorded for the QA harness only. */
  mode: "mock" | "openai" | "anthropic" | "error";
};

export type AnalyzableItem = {
  name: string;
  notes?: string | null;
  room?: string | null;
  category?: string | null;
};

const TIMEOUT_MS = 15_000;
const OPENAI_MODEL = "gpt-4o-mini";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

/* ------------------------------------------------------------------ */
/* Provider selection                                                  */
/* ------------------------------------------------------------------ */

type Provider = "anthropic" | "openai" | "mock";

function pickProvider(): Provider {
  const flag = String(process.env.MOCK_AI ?? "").toLowerCase();
  if (flag === "true" || flag === "1" || flag === "yes") return "mock";

  const anthropicKey = getAnthropicApiKey();
  if (anthropicKey) return "anthropic";

  const openaiKey = getOpenAIApiKey();
  if (openaiKey) return "openai";

  return "mock";
}

/** True when no real call should be made. */
export function isMockMode(): boolean {
  return pickProvider() === "mock";
}

/** Returns the name of the active provider for logging/UI. */
export function getActiveProvider(): "anthropic" | "openai" | "mock" {
  return pickProvider();
}

/* ------------------------------------------------------------------ */
/* Mock mode                                                           */
/* ------------------------------------------------------------------ */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Deterministic canned answer.
 *
 * Two escape hatches make the harness readable: a name containing "mystery"
 * or "unknown" comes back under the threshold (so the item stays
 * uncategorized), and a name containing "diamond", "gold", "antique" or
 * "sterling" comes back flagged as possibly high value.
 */
export function mockAnalyze(item: AnalyzableItem): AnalyzeResult {
  const name = String(item.name ?? "");
  const lower = name.toLowerCase();
  const h = hash(lower);
  const primary = STANDARD_CATEGORIES[h % STANDARD_CATEGORIES.length];
  const second = STANDARD_CATEGORIES[(h + 5) % STANDARD_CATEGORIES.length];
  const third = STANDARD_CATEGORIES[(h + 9) % STANDARD_CATEGORIES.length];

  const lowConfidence = /mystery|unknown|unclear|misc box/.test(lower);
  const confidence = lowConfidence ? 0.42 : 0.85;

  const highValue = /diamond|gold|antique|sterling|persian|first edition/.test(lower);

  // Deterministic mock estimate: 200 base + hash-derived jitter up to $4800.
  // "diamond|gold|antique|sterling" names get a bump so the auto-flag path
  // has something to test against the 85% threshold.
  const jitter = (h % 4600) + 200;
  const estimatedValueUsd = highValue ? jitter + 800 : Math.min(jitter, 900);

  const suggestions: AiSuggestion[] = [
    { category: primary, confidence },
    { category: second, confidence: Math.round((confidence - 0.25) * 100) / 100 },
    { category: third, confidence: Math.round((confidence - 0.4) * 100) / 100 },
  ].filter((s) => s.confidence > 0);

  return {
    category: confidence >= AI_CATEGORY_CONFIDENCE_THRESHOLD ? primary : null,
    confidence,
    suggestions,
    estimatedValueUsd,
    highValue,
    highValueReason: highValue
      ? `The description mentions materials that often carry appraisal value.`
      : undefined,
    mode: "mock",
  };
}

/* ------------------------------------------------------------------ */
/* Shared prompt + parsing                                             */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You sort household objects from a deceased person's estate into categories so a family can divide them fairly.
Reply with JSON only, in this exact shape:
{"suggestions":[{"category":"<one of the allowed categories>","confidence":0.0}],"estimated_value_usd":0,"high_value":false,"high_value_reason":""}
Rules:
- Give at most three suggestions, most likely first.
- "category" must be one of: ${STANDARD_CATEGORIES.join(", ")}.
- "confidence" is 0 to 1. Be honest: a blurry or ambiguous photo deserves a low number.
- "estimated_value_usd" is a rough dollar estimate for this single item, in US dollars, as a number (no currency symbol, no commas). This is NOT a professional appraisal — the family will still commission real appraisals for anything that matters. Give your best honest guess based on the description and photo. Use 0 when you truly cannot guess.
- Set "high_value" true only when the object plausibly warrants a separate appraisal (precious metals, gemstones, signed art, antiques, collectible instruments).
- "high_value_reason" is one short sentence, empty when high_value is false.`;

function normalizeCategory(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const want = raw.trim().toLowerCase();
  const hit = STANDARD_CATEGORIES.find((c) => c.toLowerCase() === want);
  return hit ?? (raw.trim() ? raw.trim() : null);
}

interface ParsedResult {
  suggestions?: { category?: string; confidence?: number }[];
  estimated_value_usd?: number;
  high_value?: boolean;
  high_value_reason?: string;
}

function buildResult(parsed: ParsedResult, mode: AnalyzeResult["mode"]): AnalyzeResult {
  const suggestions: AiSuggestion[] = (parsed.suggestions ?? [])
    .map((s) => ({
      category: normalizeCategory(s?.category),
      confidence: Math.max(0, Math.min(1, Number(s?.confidence) || 0)),
    }))
    .filter((s): s is AiSuggestion => !!s.category)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  const top = suggestions[0];
  const confidence = top?.confidence ?? 0;
  const highValue = !!parsed.high_value;

  const rawEstimate = Number(parsed.estimated_value_usd);
  const estimatedValueUsd =
    Number.isFinite(rawEstimate) && rawEstimate > 0
      ? Math.min(Math.round(rawEstimate), 10_000_000)
      : null;

  return {
    category:
      top && confidence >= AI_CATEGORY_CONFIDENCE_THRESHOLD ? top.category : null,
    confidence,
    suggestions,
    estimatedValueUsd,
    highValue,
    highValueReason: highValue ? parsed.high_value_reason || undefined : undefined,
    mode,
  };
}

function buildUserContent(item: AnalyzableItem, photoBase64?: string): string {
  return [
    `Name: ${item.name}`,
    item.room ? `Room: ${item.room}` : null,
    item.notes ? `Description: ${item.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* OpenAI provider                                                     */
/* ------------------------------------------------------------------ */

async function openaiAnalyze(
  item: AnalyzableItem,
  photoBase64?: string,
): Promise<AnalyzeResult> {
  const { default: OpenAI } = await import("openai");
  const apiKey = getOpenAIApiKey();
  if (!apiKey) throw new Error("No OpenAI API key configured");
  const client = new OpenAI({ apiKey });

  const described = buildUserContent(item);
  const content: any[] = [{ type: "text", text: described }];
  if (photoBase64) {
    const url = photoBase64.startsWith("data:")
      ? photoBase64
      : `data:image/jpeg;base64,${photoBase64}`;
    content.push({ type: "image_url", image_url: { url, detail: "low" } });
  }

  const completion = await client.chat.completions.create(
    {
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      max_tokens: 300,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
    },
    { timeout: TIMEOUT_MS },
  );

  const text = completion.choices?.[0]?.message?.content ?? "{}";
  return buildResult(JSON.parse(text), "openai");
}

/* ------------------------------------------------------------------ */
/* Anthropic provider                                                  */
/* ------------------------------------------------------------------ */

async function anthropicAnalyze(
  item: AnalyzableItem,
  photoBase64?: string,
): Promise<AnalyzeResult> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) throw new Error("No Anthropic API key configured");

  const described = buildUserContent(item);

  // Build the content blocks for the user message.
  // Anthropic Messages API uses a different image format than OpenAI.
  const content: any[] = [{ type: "text", text: described }];
  if (photoBase64) {
    // Strip data: prefix if present to get raw base64
    const base64Data = photoBase64.startsWith("data:")
      ? photoBase64.split(",")[1] ?? ""
      : photoBase64;
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: base64Data,
      },
    });
  }

  // Anthropic doesn't have response_format: json_object, so we instruct
  // the model to return JSON and parse it from the text response.
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT + "\n\nRespond with ONLY valid JSON, no markdown, no explanation.",
      messages: [
        { role: "user", content },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`Anthropic API returned ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const json = await response.json() as {
    content?: { type: string; text?: string }[];
  };

  // Extract text from the response blocks
  const textBlocks = (json.content ?? []).filter((b) => b.type === "text" && b.text);
  const text = textBlocks.map((b) => b.text!).join("").trim() || "{}";

  // Strip any markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();

  return buildResult(JSON.parse(cleaned), "anthropic");
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

const EMPTY_FAILURE: AnalyzeResult = {
  category: null,
  confidence: 0,
  suggestions: [],
  estimatedValueUsd: null,
  highValue: false,
  mode: "error",
};

/**
 * Look at one item and propose a category. Never throws; a model outage
 * simply leaves the item uncategorized.
 */
export async function analyzeItem(
  item: AnalyzableItem,
  photoBase64?: string,
): Promise<AnalyzeResult> {
  if (!item || !item.name) return { ...EMPTY_FAILURE };

  const provider = pickProvider();
  if (provider === "mock") return mockAnalyze(item);

  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("analyzeItem timed out")), TIMEOUT_MS),
    );

    const promise =
      provider === "anthropic"
        ? anthropicAnalyze(item, photoBase64)
        : openaiAnalyze(item, photoBase64);

    return await Promise.race([promise, timeout]);
  } catch (e) {
    console.warn(`[ai] analyzeItem failed (${provider}):`, (e as Error)?.message ?? e);
    return { ...EMPTY_FAILURE };
  }
}
