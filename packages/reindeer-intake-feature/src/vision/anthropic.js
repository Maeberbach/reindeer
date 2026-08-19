import { VisionProvider } from '@reindeer-legacy/core-api';
import { groupAcrossFrames, screenHighValue } from './index.js';

/**
 * Real vision provider, speaking the Anthropic Messages wire format.
 *
 * Why this exists separately from HttpVisionProvider: that provider posts to a
 * bespoke `{model, instruction, images[]}` shape and expects `{detections:[]}`
 * back. No commercial vision service speaks that protocol, so it could never
 * have been switched on against a real endpoint. This one talks to an API that
 * actually exists.
 *
 * The design rule here is set by a real failure: the previous stand-in invented
 * "Hamilton, $450" for a wrought-iron sconce and the app wrote it into the
 * owner's permanent record as though it were fact. Everything below exists to
 * make that specific failure impossible:
 *
 *   1. Identification and valuation are separate questions with separate
 *      evidence requirements. A model may recognise an object confidently and
 *      still have no idea what it is worth.
 *   2. Identifiers must be *legible in the photograph*. Style, period and
 *      "looks like the work of" are explicitly not evidence of a maker.
 *   3. Values are returned as a range with stated reasoning, never a single
 *      authoritative-looking number, and never as the owner's own value.
 *   4. Abstaining is a valid, expected answer. Null beats a confident guess.
 */

const SCHEMA = {
  name: 'record_objects',
  description: 'Record each distinct physical object visible in the photographs.',
  input_schema: {
    type: 'object',
    required: ['detections'],
    properties: {
      detections: {
        type: 'array',
        items: {
          type: 'object',
          required: ['label', 'frame_index', 'confidence', 'maker_identified', 'value_known'],
          properties: {
            label: { type: 'string', description: 'Short plain-language name an older adult would use. No marketing words.' },
            category_hint: { type: 'string' },
            frame_index: { type: 'integer' },
            confidence: { type: 'number', description: '0-1, how sure you are of the label itself.' },
            bbox: {
              type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4,
              description: '[x, y, width, height] normalised 0-1.',
            },
            description: { type: 'string', description: 'One or two plain sentences describing what is actually visible.' },

            maker_identified: {
              type: 'boolean',
              description: 'True ONLY if a brand, signature, foundry mark, label or stamp is legible in the photograph.',
            },
            identifiers: {
              type: 'object',
              description: 'Only marks you can literally read. Empty object if maker_identified is false.',
              properties: {
                brand: { type: 'string' }, maker: { type: 'string' },
                model: { type: 'string' }, serial: { type: 'string' }, marks: { type: 'string' },
              },
            },
            maker_reasoning: {
              type: 'string',
              description: 'What you actually saw, or why you cannot tell. Never speculate about attribution from style.',
            },

            value_known: {
              type: 'boolean',
              description: 'True only if the visible evidence genuinely supports a resale range.',
            },
            value_low_cents: { type: ['integer', 'null'] },
            value_high_cents: { type: ['integer', 'null'] },
            value_reasoning: {
              type: 'string',
              description: 'Why that range, or plainly why you cannot say. Mention if an appraisal is warranted.',
            },
            appraisal_suggested: {
              type: 'boolean',
              description: 'True when the object may be significant enough to be worth a professional opinion.',
            },
          },
        },
      },
    },
  },
};

const INSTRUCTION = `You are helping an older adult record their belongings so their family is not left guessing. This record may be read years from now by people who cannot ask them what they meant.

Identify each distinct physical object in the photograph(s).

Two rules override everything else.

ATTRIBUTION. Set maker_identified true only when a brand name, signature, foundry mark, stamp, label or serial number is actually legible in the image. Recognising a style, a period, a region or a technique is NOT identification of a maker. If you think you recognise the hand behind a piece but cannot read a mark, set maker_identified false, leave identifiers empty, and say so in maker_reasoning — that is a useful and honest answer.

VALUATION. Set value_known true only when the visible evidence genuinely supports a secondary-market resale range. Mass-produced and unmarked objects usually do. Anything whose value depends on attribution, provenance, materials you cannot verify, or condition you cannot inspect usually does not — set value_known false, leave both figures null, explain why in value_reasoning, and set appraisal_suggested true where a professional opinion is warranted. Ranges are conservative resale values, in US cents, not insurance or replacement values.

Never invent a brand, a maker, a model number or a price. Leaving a field empty is always better than filling it with something plausible. Prefer one accurate object over several speculative ones.`;

export class AnthropicVisionProvider extends VisionProvider {
  // 90 seconds was enough for one photograph and not enough for a room. A
  // walkthrough now has room to write a longer answer, so it needs room to
  // finish writing it.
  constructor({ endpoint, apiKey, model, fetchImpl = globalThis.fetch, timeoutMs = 210000 } = {}) {
    super();
    Object.assign(this, {
      endpoint: endpoint || 'https://api.anthropic.com/v1/messages',
      apiKey,
      model: model || 'claude-sonnet-4-6',
      fetchImpl,
      timeoutMs,
    });
  }

  /** Anthropic requires a declared media type; sniff it from the magic bytes. */
  static mediaType(buffer) {
    if (!buffer || buffer.length < 4) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
    if (buffer.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return 'image/jpeg';
  }

  async detectItems(images, opts = {}) {
    const content = [];
    images.forEach((img, i) => {
      content.push({ type: 'text', text: `Photograph ${i} (frame_index ${img.frame_index ?? i}):` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: AnthropicVisionProvider.mediaType(img.buffer),
          data: img.buffer.toString('base64'),
        },
      });
    });
    content.push({
      type: 'text',
      text: opts.room_hint
        ? `${INSTRUCTION}\n\nThe owner says these are in: ${opts.room_hint}. Use that only as a hint; it is not evidence of a maker or a value.`
        : INSTRUCTION,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          // Scaled to the number of photographs, not fixed.
          //
          // A single photograph needs very little room. A room walkthrough sends
          // eight frames, each holding a dozen objects, and every object carries
          // a description plus reasoning for both attribution and value. At a
          // flat 4,000 the answer was cut off mid-sentence; a truncated tool call
          // arrives with nothing usable in it, so a walkthrough full of obvious
          // furniture came back as "nothing found" with no error anywhere. The
          // room was never the problem — the ceiling was.
          max_tokens: Math.min(16000, 2500 + 1600 * images.length),
          tools: [SCHEMA],
          tool_choice: { type: 'tool', name: 'record_objects' },
          messages: [{ role: 'user', content }],
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      // A failure here must never be dressed up as a result.
      throw new Error(err.name === 'AbortError'
        ? 'The photograph could not be looked at in time. Your photo is saved — please type what it is.'
        : `The recognition service could not be reached: ${err.message}`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`The recognition service returned ${res.status}. ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    const block = (json.content ?? []).find((c) => c.type === 'tool_use' && c.name === 'record_objects');
    if (!block) return [];

    const raw = block.input?.detections;

    // An answer that ran out of room is not an answer of "nothing here". Saying
    // so out loud matters: the silent version of this told an owner their living
    // room contained no objects, which is worse than any error message, because
    // they would have believed the app and moved on.
    if (!Array.isArray(raw) && json.stop_reason === 'max_tokens') {
      throw new Error('There was too much in the recording to look at in one go. '
        + 'Nothing has been lost — try a shorter recording, or take photographs instead.');
    }

    return groupAcrossFrames((raw ?? []).map((d, i) => normalise(d, i, opts)));
  }

  async describeItem(image, opts = {}) {
    const [first] = await this.detectItems([{ ...image, frame_index: 0 }], opts);
    return first
      ? { title: first.label, description: first.description ?? '', confidence: first.confidence ?? 0 }
      : { title: opts.hint ?? '', description: '', confidence: 0 };
  }
}

/**
 * Convert a model answer into a stored detection.
 *
 * The important line is `value_estimate_cents: null`. Even when the model gives
 * a range, no single number is handed downstream as though it were the value of
 * the object. The range travels separately, clearly labelled as a suggestion,
 * so the owner is the only one who can ever set what a thing is worth.
 */
function normalise(d, i, opts) {
  const identified = d.maker_identified === true;
  const identifiers = identified && d.identifiers ? stripEmpty(d.identifiers) : {};
  const known = d.value_known === true
    && Number.isFinite(d.value_low_cents) && Number.isFinite(d.value_high_cents);

  const screen = screenHighValue({
    title: d.label ?? '',
    description: d.description ?? '',
    category: d.category_hint ?? '',
    value_estimate_cents: known ? d.value_high_cents : null,
  });

  return {
    label: d.label ?? 'Unidentified object',
    category_hint: d.category_hint || null,
    room_hint: opts.room_hint ?? null,
    confidence: clamp01(d.confidence),
    bbox: Array.isArray(d.bbox) && d.bbox.length === 4 ? d.bbox.map(clamp01) : null,
    description: d.description ?? '',
    frame_index: Number.isInteger(d.frame_index) ? d.frame_index : i,

    identifiers,
    maker_identified: identified,
    maker_reasoning: d.maker_reasoning ?? '',

    // Deliberately never populated from the model. Only the owner sets a value.
    value_estimate_cents: null,
    value_suggestion: known
      ? { low_cents: d.value_low_cents, high_cents: d.value_high_cents, reasoning: d.value_reasoning ?? '' }
      : null,
    value_unknown_reason: known ? null : (d.value_reasoning || 'There is not enough visible evidence to put a figure on this.'),
    appraisal_suggested: d.appraisal_suggested === true || screen.appraisal_suggested,

    high_value_cue: screen.reason,
    // The registry never asserts a value tier; FairPlay does, from its own
    // estimate and the captain's threshold.
    high_value_flag: false,
    source_media_id: d.source_media_id ?? null,
  };
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function stripEmpty(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
  );
}
