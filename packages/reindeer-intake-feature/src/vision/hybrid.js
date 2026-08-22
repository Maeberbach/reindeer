/**
 * HybridVisionProvider — Google-first, Anthropic-fallback.
 *
 * Sequence:
 *   Phase 1 (detectItems): Google Object Localization finds distinct objects
 *     in the photo with bounding boxes and generic labels ("Sculpture", "Vase").
 *     This is fast, cheap, and reliable for the "what's in this photo?" question.
 *
 *   Phase 2 (describeItem): Google Web Detection on a cropped close-up searches
 *     Google's web index for visually matching images and product listings —
 *     the "Google Lens" experience. When it hits, it hits exactly: "Steuben
 *     Glass Dome Sculpture" instead of "glass sculpture". No LLM can do this.
 *
 *     If Google Web Detection finds an exact match (bestGuessLabels or
 *     high-confidence web entities), we're done — no Anthropic call needed.
 *     The title, matching pages, and price hints from Google are already
 *     better than any LLM description.
 *
 *     If Google doesn't find a match, we fall back to Anthropic's describeItem
 *     for descriptive analysis: materials, condition, approximate value range,
 *     maker marks. This is where the LLM's reasoning actually adds value —
 *     on items that are too generic, too obscure, or too personal for web
 *     matching (e.g., a handmade quilt, a custom piece, a mass-produced
 *     item without distinctive markings).
 *
 * Provider selection in index.js:
 *   When both GOOGLE_CLOUD_API_KEY and REINDEER_VISION_KEY (or ANTHROPIC_API_KEY)
 *   are set, this hybrid is used. When only one is set, that provider is used
 *   alone (the current behaviour). When neither is set, MockVisionProvider.
 */

import { VisionProvider } from '@reindeer-legacy/core-api';
import { GoogleVisionProvider } from './google.js';
import { AnthropicVisionProvider } from './anthropic.js';
import { OpenAIVisionProvider } from './openai.js';

export class HybridVisionProvider extends VisionProvider {
  constructor({
    googleProvider,
    llmProvider,
    fetchImpl = globalThis.fetch,
  } = {}) {
    super();
    this.google = googleProvider;
    this.llm = llmProvider;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Phase 1: Google Object Localization.
   * Always uses Google — it's faster, cheaper, and better at finding
   * distinct objects in a wide shot than an LLM.
   */
  async detectItems(images, opts = {}) {
    return this.google.detectItems(images, opts);
  }

  /**
   * Phase 2: Google Web Detection first, Anthropic fallback.
   *
   * If Google finds an exact match (web_match=true with bestGuessLabels or
   * high-confidence entities), return it immediately. No Anthropic call.
   *
   * If Google doesn't find a match (web_match=false or low confidence),
   * fall back to the LLM for descriptive analysis. The LLM's result is
   * augmented with the Google labels so nothing is lost.
   */
  async describeItem(image, opts = {}) {
    // Try Google Web Detection first
    let googleResult = null;
    try {
      googleResult = await this.google.describeItem(image, opts);
    } catch (err) {
      console.warn('[hybrid-vision] Google describeItem failed:', err?.message ?? err);
    }

    // If Google found an exact match, use it — done.
    if (googleResult && googleResult.web_match === true) {
      const hasBestGuess = (googleResult.best_guess_labels ?? []).length > 0;
      const hasHighConfidence = (googleResult.confidence ?? 0) >= 0.7;
      if (hasBestGuess || hasHighConfidence) {
        return googleResult;
      }
    }

    // Google didn't find an exact match — fall back to the LLM.
    // The LLM provides descriptive analysis: materials, condition, value range,
    // maker marks. This is where Anthropic's reasoning actually adds value.
    let llmResult = null;
    try {
      llmResult = await this.llm.describeItem(image, opts);
    } catch (err) {
      console.warn('[hybrid-vision] LLM describeItem failed:', err?.message ?? err);
    }

    // If the LLM succeeded, merge Google's labels/pages as supplementary data.
    if (llmResult) {
      return {
        ...llmResult,
        // Carry Google's web data as supplementary info even when we're using
        // the LLM's title/description. The owner sees the LLM's analysis as
        // primary, but Google's matches (if any low-confidence ones) are
        // available for reference.
        google_web_match: googleResult?.web_match ?? false,
        google_best_guess: googleResult?.best_guess_labels ?? [],
        google_entities: googleResult?.web_entities ?? [],
        google_matching_pages: googleResult?.matching_pages ?? [],
        google_label_hints: googleResult?.label_hints ?? [],
        identification_phase: 2,
        provider: 'hybrid-llm-fallback',
      };
    }

    // Both failed — return Google's result (even if it was a no-match) since
    // it at least has label hints. Fall back to a bare minimum if Google also
    // returned nothing.
    if (googleResult) {
      return { ...googleResult, provider: 'hybrid-google-only' };
    }

    return {
      title: opts.hint ?? 'Item',
      description: 'Could not identify this item.',
      confidence: 0,
      identification_phase: 2,
      web_match: false,
      provider: 'hybrid-failed',
    };
  }
}
