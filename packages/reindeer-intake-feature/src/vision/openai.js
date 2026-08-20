import { VisionProvider } from '@reindeer-legacy/core-api';
import { groupAcrossFrames, screenHighValue } from './index.js';

/**
 * OpenAI Vision provider — uses GPT-4o to identify items in photos.
 *
 * The Registry's vision job is identification only: what is this thing, what
 * category, what brand/model marks are legible in the photo. It deliberately
 * does NOT produce a dollar value — valuation is FairPlay's job.
 *
 * The prompt is tuned for honesty: the model is told to only report what it
 * can actually see, to say "unknown" when it cannot tell, and to never guess
 * at a maker from style alone. Confidence reflects how sure the model is that
 * the object exists in the frame, not how sure it is about the name.
 *
 * Why this exists alongside AnthropicVisionProvider: Mark's standing
 * instruction is to use OpenAI, with the key entered at login. This provider
 * speaks the OpenAI Chat Completions API with image input.
 */
export class OpenAIVisionProvider extends VisionProvider {
  constructor({ apiKey, model = 'gpt-4o', endpoint = 'https://api.openai.com/v1/chat/completions', fetchImpl = globalThis.fetch }) {
    super();
    Object.assign(this, { apiKey, model, endpoint, fetchImpl });
  }

  async detectItems(images, opts = {}) {
    // Build image content blocks for the OpenAI vision API
    const imageContent = images.map((img, i) => ({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${img.buffer.toString('base64')}`,
        detail: 'high',
      },
    }));

    const systemPrompt = `You are an inventory assistant helping someone document their home for estate planning.
Your job: identify distinct physical objects visible in the photos — things the owner considers their belongings and would list in a household inventory.
For each object, return:
- label: a short, plain-language name (e.g., "Oak rocking chair", "Cast iron skillet")
- category: one of: Jewelry, Furniture, Kitchenware, Art, Collectibles, Tools, Photos, Firearms, Clothing, Books, Electronics, Holiday Ornaments, Other
- confidence: how sure you are the object exists in the frame (0.0 to 1.0)
- identifiers: any brand, model, serial number, or maker's mark you can READ in the photo. If you cannot read any, return empty object.
- bbox: approximate location as [x, y, width, height] normalized 0-1

RULES:
- SCOPE: Report movable, ownable objects — furniture, art, tools, kitchenware, jewelry, collectibles, electronics, books, clothing. Do NOT report the setting: rooms, walls, floors, pools, decks, patios, lawns, staircases, fireplaces, countertops, or built-in fixtures. A surface is not an object — if a photo shows things on a table or shelf, report the things, not the table or shelf. An architectural feature is not an object — if a photo shows furniture near a pool or fireplace, report the furniture, not the pool or fireplace. The room_hint tells you where the photo was taken, not what the object is.
- Only report objects you can actually SEE. Do not invent items.
- Only report identifiers that are LEGIBLE in the photograph. Never guess a brand from style.
- Never estimate a dollar value. That is not your job.
- If you cannot identify something, label it "Unidentified object" with low confidence.
- A single photo may contain multiple objects. Report each one separately.
- If the same object appears in multiple frames, it will be merged later — just report what you see in each frame.
- Be specific in the label: "wrought iron patio table with glass top" is better than "table". This record may be the only description a family has.

Return a JSON array of detections. Format:
[{"label":"...","category":"...","confidence":0.85,"identifiers":{},"bbox":[0.1,0.2,0.3,0.4]}]`;

    const userPrompt = opts.room_hint
      ? `These photos are from the ${opts.room_hint}. Identify every distinct object you can see.`
      : 'Identify every distinct object you can see in these photos.';

    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: userPrompt },
            ...imageContent,
          ]},
        ],
        max_tokens: 2000,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI Vision returned ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = await res.json();
    const text = json.choices?.[0]?.message?.content ?? '{}';

    // Parse the response — the model returns a JSON object with a key
    // containing the array. Handle both {detections:[]} and bare [] shapes.
    let detections;
    try {
      const parsed = JSON.parse(text);
      detections = Array.isArray(parsed) ? parsed : (parsed.detections ?? parsed.items ?? parsed.objects ?? []);
    } catch {
      // If the model didn't return valid JSON, return empty — no items
      // identified. Better to miss items than to write garbage.
      detections = [];
    }

    // Normalize each detection to the internal shape, then run the
    // descriptive cue screening (the same screenHighValue that the mock
    // and Anthropic providers use).
    const normalized = detections.map((d, i) => {
      const label = String(d.label ?? d.name ?? 'Unidentified object');
      const category = String(d.category ?? d.category_hint ?? 'Other');
      const screen = screenHighValue({ title: label, category });
      return {
        label,
        category_hint: category,
        room_hint: opts.room_hint ?? null,
        confidence: Math.min(1, Math.max(0, Number(d.confidence ?? 0.5))),
        bbox: Array.isArray(d.bbox) ? d.bbox.slice(0, 4).map(Number) : [0, 0, 0.5, 0.5],
        value_estimate_cents: null,
        value_suggestion: null,
        identifiers: d.identifiers ?? d.ids ?? {},
        high_value_cue: screen.reason,
        high_value_flag: false,
        appraisal_suggested: screen.appraisal_suggested,
        frame_index: d.frame_index ?? Math.min(i, images.length - 1),
        source_media_id: images[d.frame_index ?? i]?.media_id ?? null,
      };
    });

    return groupAcrossFrames(normalized);
  }

  async describeItem(image, opts = {}) {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are an inventory assistant. Describe this object in one sentence. State only what you can see. Do not estimate value.' },
          { role: 'user', content: [
            { type: 'text', text: opts.hint ? `Someone called this "${opts.hint}". Is that right? Describe what you see.` : 'What is this object?' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.buffer.toString('base64')}`, detail: 'high' } },
          ]},
        ],
        max_tokens: 300,
        temperature: 0.1,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI returned ${res.status}`);
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content ?? '';
    return { title: opts.hint ?? 'Item', description: text, confidence: 0.7 };
  }
}
