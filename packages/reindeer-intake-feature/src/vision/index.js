import crypto from 'node:crypto';
import { VisionProvider } from '@reindeer-legacy/core-api';

/**
 * "Worth a professional look" screening.
 *
 * Reindeer: Registry does NOT value anything and does not decide what is
 * "high value". Valuation and high-value flagging belong to Reindeer: FairPlay
 * Choice, which has AI value estimates and a threshold the personal
 * representative sets. The registry's only job is to get things DOCUMENTED.
 *
 * What survives here is a purely descriptive cue check: words in the item's own
 * title and description that suggest a professional opinion would be worth
 * getting later. It never produces a dollar figure and never asserts a value
 * tier. There is deliberately no dollar threshold in this file.
 */

const UNIVERSAL_CUES = ['antique', 'signed', 'numbered', 'limited edition', 'sterling', 'solid gold', 'certificate'];
const CATEGORY_CUES = {
  Jewelry: ['diamond', 'karat', 'kt', '14k', '18k', 'platinum', 'gemstone'],
  Art: ['original', 'oil on canvas', 'lithograph', 'provenance'],
  Coins: ['graded', 'pcgs', 'ngc', 'proof', 'bullion'],
  Firearms: ['engraved', 'commemorative', 'matched pair'],
};

/**
 * Returns whether the item's own words suggest a professional look later.
 *
 * `high_value_flag` is retained in the return shape only because the exchange
 * envelope carries the field, and is now ALWAYS false from the registry: the
 * registry makes no value claim. FairPlay sets it from its own estimate and
 * its own captain-chosen threshold.
 */
export function screenHighValue({ title = '', description = '', category = '' }) {
  const hay = `${title} ${description}`.toLowerCase();
  const cues = [...UNIVERSAL_CUES, ...(CATEGORY_CUES[category] ?? [])];
  const hit = cues.find((c) => hay.includes(c));
  return {
    appraisal_suggested: Boolean(hit),
    // The registry never asserts a value tier. This is FairPlay's call.
    high_value_flag: false,
    reason: hit ? `cue:${hit}` : null,
  };
}

/**
 * Deterministic stand-in for the real vision model. Same output shape as the
 * production provider, so the whole intake path can be developed and tested
 * with no API key and no cost.
 */
export class MockVisionProvider extends VisionProvider {
  async detectItems(images, opts = {}) {
    const catalog = [
      { label: 'Pocket watch', category_hint: 'Jewelry', ids: { brand: 'Hamilton' } },
      { label: 'Oak rocking chair', category_hint: 'Furniture', ids: {} },
      { label: 'Cast iron skillet', category_hint: 'Kitchenware', ids: { brand: 'Griswold' } },
      { label: 'Framed oil painting, original', category_hint: 'Art', ids: {} },
      { label: 'Fishing rod and reel', category_hint: 'Fishing Gear', ids: {} },
      { label: 'Photograph album', category_hint: 'Photos', ids: {} },
      { label: 'Silver serving tray, sterling', category_hint: 'Collectibles', ids: {} },
      { label: 'Cordless drill set', category_hint: 'Tools', ids: { brand: 'DeWalt' } },
    ];

    const out = [];
    images.forEach((img, frameIndex) => {
      const seed = crypto.createHash('sha256').update(img.buffer ?? String(img.name ?? frameIndex)).digest();
      const count = opts.maxPerImage ?? (1 + (seed[0] % 3));
      for (let k = 0; k < count; k++) {
        const pick = catalog[(seed[k + 1] ?? seed[0]) % catalog.length];
        const x = ((seed[k + 2] ?? 40) % 50) / 100;
        const y = ((seed[k + 3] ?? 30) % 50) / 100;
        const screen = screenHighValue({ title: pick.label, category: pick.category_hint });
        out.push({
          label: pick.label,
          category_hint: pick.category_hint,
          room_hint: opts.room_hint ?? null,
          confidence: 0.55 + ((seed[k + 4] ?? 100) % 45) / 100,
          bbox: [x, y, Math.min(0.9 - x, 0.4), Math.min(0.9 - y, 0.4)],
          // Never a figure. The mock stands in for the real provider, and the
          // real provider deliberately returns null here: what a thing is worth
          // is settled at distribution, by a person, not guessed at capture.
          value_estimate_cents: null,
          value_suggestion: null,
          identifiers: pick.ids,
          high_value_cue: screen.reason,
          // Always false from the registry — see screenHighValue above.
          high_value_flag: false,
          appraisal_suggested: screen.appraisal_suggested,
          frame_index: frameIndex,
          source_media_id: img.media_id ?? null,
        });
      }
    });
    return groupAcrossFrames(out);
  }

  async describeItem(_image, opts = {}) {
    return { title: opts.hint ?? 'Item', description: '', confidence: 0.6 };
  }
}

/** Real provider: posts frames to a configurable endpoint. */
export class HttpVisionProvider extends VisionProvider {
  constructor({ endpoint, apiKey, model, fetchImpl = globalThis.fetch }) {
    super();
    Object.assign(this, { endpoint, apiKey, model, fetchImpl });
  }

  async detectItems(images, opts = {}) {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        // Resale-anchored valuation instruction, matching the calibrated prompt.
        instruction: 'Identify each distinct physical object. Return bounding boxes normalized 0-1, '
          + 'a short plain-language label, a category, visible identifiers (brand, model, serial, marks), '
          + 'and a conservative secondary-market resale estimate in USD cents. Use low-end category anchors '
          + 'and require visible evidence before assigning a high value.',
        images: images.map((i) => ({ media_id: i.media_id, data: i.buffer.toString('base64'), frame_index: i.frame_index })),
        options: opts,
      }),
    });
    if (!res.ok) throw new Error(`Vision provider returned ${res.status}`);
    const json = await res.json();
    return groupAcrossFrames(json.detections ?? []);
  }
}

/**
 * Cross-frame grouping: the same object seen in several video keyframes
 * becomes one draft item with a quantity, not five near-duplicate drafts.
 */
export function groupAcrossFrames(detections) {
  const byLabel = new Map();
  for (const d of detections) {
    const key = `${(d.label || '').toLowerCase().trim()}|${d.category_hint ?? ''}`;
    const existing = byLabel.get(key);
    if (!existing) {
      byLabel.set(key, { ...d, quantity: 1, frames: [d.frame_index ?? 0] });
      continue;
    }
    // Same label in a *different* frame is the same object moving through the
    // walkthrough. Same label in the *same* frame is genuinely two objects.
    if (existing.frames.includes(d.frame_index ?? 0)) {
      existing.quantity += 1;
    }
    existing.frames.push(d.frame_index ?? 0);
    if ((d.confidence ?? 0) > (existing.confidence ?? 0)) {
      existing.confidence = d.confidence;
      existing.bbox = d.bbox;
      existing.frame_index = d.frame_index;
    }
  }
  return [...byLabel.values()];
}
