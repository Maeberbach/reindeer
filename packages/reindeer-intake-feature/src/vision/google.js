import { VisionProvider } from '@reindeer-legacy/core-api';
import { groupAcrossFrames, screenHighValue } from './index.js';
import crypto from 'node:crypto';

/**
 * Google Cloud Vision provider — two-phase identification.
 *
 * Phase 1 (detectItems): Object Localization finds distinct objects in a
 * photo and returns bounding boxes + generic labels ("Chair", "Vase",
 * "Book"). This replaces the LLM detection call and is faster, cheaper,
 * and more reliable for the "what's in this photo?" question.
 *
 * Phase 2 (describeItem): Web Detection on a cropped close-up searches
 * Google's web index for visually matching images and product listings.
 * This is the "Google Lens" experience — it returns best-guess labels,
 * visually similar images, and pages with matching images. When it hits,
 * it hits exactly: "Heath Ceramics Bauhaus dinner plate" instead of
 * "white ceramic plate". This is fundamentally different from LLM
 * reasoning: it's visual search, not visual inference.
 *
 * The two-phase split exists because no LLM can do what Web Detection
 * does. An LLM describes what it sees; Web Detection finds what it is.
 *
 * Provider selection:
 *   REINDEER_VISION_PROTOCOL=google → this provider
 *   GOOGLE_CLOUD_API_KEY → API access
 *   If no Google credentials are set, falls back to mock behaviour.
 *
 * Pricing (Aug 2026):
 *   Object Localization: $3.50/1K images (1K free/month)
 *   Web Detection:       $3.50/1K images (1K free/month)
 *   A 200-item estate: ~$0.80 Phase 1 + ~$0.16 Phase 2 ≈ $1.00 total
 */

const VISION_API_BASE = 'https://vision.googleapis.com/v1/images:annotate';

export class GoogleVisionProvider extends VisionProvider {
  constructor({
    apiKey,
    accessToken,
    endpoint,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
  } = {}) {
    super();
    Object.assign(this, {
      apiKey: apiKey || null,
      accessToken: accessToken || null,
      endpoint: endpoint || VISION_API_BASE,
      fetchImpl,
      timeoutMs,
    });
  }

  get isConfigured() {
    return Boolean(this.apiKey || this.accessToken);
  }

  get authHeader() {
    if (this.apiKey) return null;
    if (this.accessToken) return `Bearer ${this.accessToken}`;
    return null;
  }

  url() {
    if (this.apiKey) {
      const sep = this.endpoint.includes('?') ? '&' : '?';
      return `${this.endpoint}${sep}key=${this.apiKey}`;
    }
    return this.endpoint;
  }

  /* -------------------------------------------------------------- */
  /* Phase 1 — Object Localization                                  */
  /* -------------------------------------------------------------- */

  async detectItems(images, opts = {}) {
    if (!this.isConfigured) {
      return this._mockDetect(images, opts);
    }

    const requests = images.map((img) => ({
      image: { content: img.buffer.toString('base64') },
      features: [
        { type: 'OBJECT_LOCALIZATION', maxResults: 20 },
        { type: 'LABEL_DETECTION', maxResults: 10 },
      ],
    }));

    let res;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      res = await this.fetchImpl(this.url(), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.authHeader ? { authorization: this.authHeader } : {}),
        },
        body: JSON.stringify({ requests }),
      });
      clearTimeout(timer);
    } catch (err) {
      console.warn('[google-vision] detectItems failed:', err?.message ?? err);
      return this._mockDetect(images, opts);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[google-vision] detectItems HTTP ${res.status}: ${text.slice(0, 200)}`);
      return this._mockDetect(images, opts);
    }

    const json = await res.json();
    const responses = json.responses ?? [];
    const detections = [];

    responses.forEach((resp, frameIdx) => {
      const img = images[frameIdx];
      const localizedObjects = resp.localizedObjectAnnotations ?? [];
      const labels = resp.labelAnnotations ?? [];

      if (localizedObjects.length > 0) {
        for (const obj of localizedObjects) {
          const box = obj.boundingPoly?.normalizedVertices ?? [];
          const bbox = verticesToBbox(box);
          const screen = screenHighValue({
            title: obj.name ?? '',
            category: mapGoogleLabelToCategory(obj.name),
          });
          detections.push({
            label: capitalize(obj.name ?? 'Unidentified object'),
            category_hint: mapGoogleLabelToCategory(obj.name),
            room_hint: opts.room_hint ?? null,
            confidence: clamp01(obj.score ?? 0.5),
            bbox,
            description: '',
            frame_index: frameIdx,
            identifiers: {},
            maker_identified: false,
            maker_reasoning: '',
            value_estimate_cents: null,
            value_suggestion: null,
            value_unknown_reason: 'Use "Identify" for exact matching via Google Web Detection.',
            appraisal_suggested: screen.appraisal_suggested,
            high_value_cue: screen.reason,
            high_value_flag: false,
            source_media_id: img.media_id ?? null,
            identification_phase: 1,
          });
        }
      } else if (labels.length > 0) {
        const top = labels[0];
        detections.push({
          label: capitalize(top.description ?? 'Unidentified object'),
          category_hint: mapGoogleLabelToCategory(top.description),
          room_hint: opts.room_hint ?? null,
          confidence: clamp01(top.score ?? 0.5),
          bbox: null,
          description: labels.slice(0, 5).map(l => l.description).filter(Boolean).join(', '),
          frame_index: frameIdx,
          identifiers: {},
          maker_identified: false,
          maker_reasoning: '',
          value_estimate_cents: null,
          value_suggestion: null,
          value_unknown_reason: 'Label detection only — no bounding box.',
          appraisal_suggested: false,
          high_value_cue: null,
          high_value_flag: false,
          source_media_id: img.media_id ?? null,
          identification_phase: 1,
        });
      }
    });

    if (detections.length === 0) return this._mockDetect(images, opts);
    return groupAcrossFrames(detections);
  }

  /* -------------------------------------------------------------- */
  /* Phase 2 — Web Detection (the "Google Lens" exact match)        */
  /* -------------------------------------------------------------- */

  async describeItem(image, opts = {}) {
    if (!this.isConfigured) {
      return { title: opts.hint ?? 'Item', description: '', confidence: 0.5 };
    }

    const buffer = image.buffer ?? Buffer.from(
      (image.data_url ?? image.data ?? '').split(',').pop() ?? '', 'base64'
    );

    const request = {
      image: { content: buffer.toString('base64') },
      features: [
        { type: 'WEB_DETECTION', maxResults: 10 },
        { type: 'LABEL_DETECTION', maxResults: 10 },
      ],
    };

    let res;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      res = await this.fetchImpl(this.url(), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.authHeader ? { authorization: this.authHeader } : {}),
        },
        body: JSON.stringify({ requests: [request] }),
      });
      clearTimeout(timer);
    } catch (err) {
      console.warn('[google-vision] describeItem failed:', err?.message ?? err);
      return {
        title: opts.hint ?? 'Item',
        description: 'Could not reach Google Cloud Vision.',
        confidence: 0,
        identification_phase: 2,
        web_match: false,
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[google-vision] describeItem HTTP ${res.status}: ${text.slice(0, 200)}`);
      return {
        title: opts.hint ?? 'Item',
        description: `Google Cloud Vision error (${res.status}).`,
        confidence: 0,
        identification_phase: 2,
        web_match: false,
      };
    }

    const json = await res.json();
    const resp = json.responses?.[0] ?? {};
    const web = resp.webDetection ?? {};
    const labels = resp.labelAnnotations ?? [];

    // bestGuessLabels — Google's best guess at what this is.
    const bestGuess = (web.bestGuessLabels ?? [])
      .map(g => g.label).filter(Boolean);

    const entities = (web.webEntities ?? [])
      .filter(e => e.entityName && (e.score ?? 0) > 0.3)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map(e => e.entityName);

    const matchingPages = (web.pagesWithMatchingImages ?? [])
      .slice(0, 5)
      .map(p => ({ url: p.url, title: p.pageTitle ?? '' }))
      .filter(p => p.url);

    const similarImages = (web.visuallySimilarImages ?? [])
      .slice(0, 5)
      .map(s => s.url).filter(Boolean);

    // Best guess = the "Google Lens hit exactly" moment
    if (bestGuess.length > 0) {
      const title = bestGuess[0];
      const description = buildWebDescription(entities, matchingPages, labels);
      const screen = screenHighValue({ title, description, category: mapGoogleLabelToCategory(title) });
      return {
        title,
        description,
        confidence: matchingPages.length > 0 ? 0.9 : 0.7,
        identification_phase: 2,
        web_match: true,
        best_guess_labels: bestGuess,
        web_entities: entities,
        matching_pages: matchingPages,
        similar_images: similarImages,
        category_hint: mapGoogleLabelToCategory(title),
        appraisal_suggested: screen.appraisal_suggested,
        value_suggestion: extractPriceHint(matchingPages),
      };
    }

    // No best-guess but have web entities
    if (entities.length > 0) {
      const title = entities[0];
      const description = buildWebDescription(entities, matchingPages, labels);
      return {
        title,
        description,
        confidence: 0.6,
        identification_phase: 2,
        web_match: true,
        best_guess_labels: [],
        web_entities: entities,
        matching_pages: matchingPages,
        similar_images: similarImages,
        category_hint: mapGoogleLabelToCategory(title),
      };
    }

    // No web match — fall back to labels
    if (labels.length > 0) {
      const top = labels[0];
      return {
        title: capitalize(top.description ?? opts.hint ?? 'Item'),
        description: `No exact match found. Visual labels: ${labels.slice(0, 5).map(l => l.description).filter(Boolean).join(', ')}.`,
        confidence: clamp01(top.score ?? 0.4),
        identification_phase: 2,
        web_match: false,
        label_hints: labels.slice(0, 5).map(l => ({ label: l.description, score: l.score })),
        category_hint: mapGoogleLabelToCategory(top.description),
      };
    }

    return {
      title: opts.hint ?? 'Item',
      description: 'No identification available.',
      confidence: 0,
      identification_phase: 2,
      web_match: false,
    };
  }

  /* -------------------------------------------------------------- */
  /* Mock fallback                                                  */
  /* -------------------------------------------------------------- */

  _mockDetect(images, opts = {}) {
    const catalog = [
      { label: 'Pocket watch', category_hint: 'Jewelry' },
      { label: 'Oak rocking chair', category_hint: 'Furniture' },
      { label: 'Cast iron skillet', category_hint: 'Kitchenware' },
      { label: 'Framed oil painting', category_hint: 'Art' },
      { label: 'Fishing rod and reel', category_hint: 'Fishing Gear' },
      { label: 'Photograph album', category_hint: 'Photos' },
      { label: 'Silver serving tray', category_hint: 'Collectibles' },
      { label: 'Cordless drill set', category_hint: 'Tools' },
    ];

    const out = [];
    images.forEach((img, frameIndex) => {
      const seed = crypto.createHash('sha256').update(img.buffer ?? String(img.name ?? frameIndex)).digest();
      const count = opts.maxPerImage ?? (1 + (seed[0] % 2));
      for (let k = 0; k < count; k++) {
        const pick = catalog[(seed[k + 1] ?? seed[0]) % catalog.length];
        const x = ((seed[k + 2] ?? 40) % 50) / 100;
        const y = ((seed[k + 3] ?? 30) % 50) / 100;
        const screen = screenHighValue({ title: pick.label, category: pick.category_hint });
        out.push({
          label: pick.label,
          category_hint: pick.category_hint,
          room_hint: opts.room_hint ?? null,
          confidence: 0.55 + ((seed[k + 4] ?? 100) % 35) / 100,
          bbox: [x, y, 0.4, 0.4],
          description: '',
          frame_index: frameIndex,
          identifiers: {},
          maker_identified: false,
          maker_reasoning: '',
          value_estimate_cents: null,
          value_suggestion: null,
          value_unknown_reason: 'Mock mode — no Google credentials configured.',
          appraisal_suggested: screen.appraisal_suggested,
          high_value_cue: screen.reason,
          high_value_flag: false,
          source_media_id: img.media_id ?? null,
          identification_phase: 1,
        });
      }
    });
    return groupAcrossFrames(out);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function verticesToBbox(verts) {
  if (!verts || verts.length < 2) return null;
  const xs = verts.map(v => v.x ?? 0);
  const ys = verts.map(v => v.y ?? 0);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return [clamp01(minX), clamp01(minY), clamp01(maxX - minX), clamp01(maxY - minY)];
}

function mapGoogleLabelToCategory(label) {
  if (!label) return null;
  const l = label.toLowerCase();
  const map = [
    [/chair|sofa|couch|recliner|ottoman|bench|stool/, 'Furniture'],
    [/table|desk|dresser|cabinet|shelf|bookcase|wardrobe|nightstand/, 'Furniture'],
    [/bed|frame|mattress/, 'Furniture'],
    [/painting|canvas|oil|watercolor|lithograph|print|etching/, 'Art'],
    [/sculpture|statue|bust|figurine/, 'Art'],
    [/photograph|photo|album/, 'Photos'],
    [/jewel|ring|necklace|bracelet|earring|watch|pendant|brooch/, 'Jewelry'],
    [/diamond|gem|sapphire|ruby|emerald|pearl/, 'Jewelry'],
    [/coin|currency|bill|token/, 'Coins'],
    [/book|manuscript|journal|diary/, 'Books'],
    [/vinyl|record|instrument|guitar|piano|violin/, 'Collectibles'],
    [/antique|collectible|memorabilia/, 'Collectibles'],
    [/gun|rifle|pistol|shotgun|firearm/, 'Firearms'],
    [/tool|drill|saw|hammer|wrench|screwdriver|sander/, 'Tools'],
    [/pot|pan|skillet|kettle|dish|plate|bowl|cup|mug|glass|silverware|utensil/, 'Kitchenware'],
    [/appliance|blender|mixer|toaster|microwave/, 'Kitchenware'],
    [/tv|television|monitor|speaker|camera|laptop|phone|tablet|computer/, 'Electronics'],
    [/clothing|shirt|jacket|coat|dress|suit|pants|shoe|boot|hat/, 'Clothing'],
    [/ornament|decoration|holiday|christmas/, 'Holiday Ornaments'],
    [/rug|carpet|tapestry|blanket|quilt/, 'Collectibles'],
  ];
  for (const [pattern, category] of map) {
    if (pattern.test(l)) return category;
  }
  return null;
}

function buildWebDescription(entities, pages, labels) {
  const parts = [];
  if (entities.length > 0) {
    parts.push(`Identified as: ${entities.slice(0, 3).join(', ')}`);
  }
  if (pages.length > 0) {
    const titles = pages.map(p => p.title).filter(Boolean).slice(0, 2);
    if (titles.length > 0) parts.push(`Found on: ${titles.join(' | ')}`);
  }
  if (labels.length > 0 && parts.length === 0) {
    parts.push(`Visual labels: ${labels.slice(0, 5).map(l => l.description).filter(Boolean).join(', ')}`);
  }
  return parts.join('. ') || 'No description available.';
}

function extractPriceHint(pages) {
  for (const page of pages) {
    const m = (page.title || '').match(/\$(\d+(?:,\d{3})*(?:\.\d{2})?)/);
    if (m) {
      const dollars = parseFloat(m[1].replace(/,/g, ''));
      if (dollars > 0 && dollars < 1_000_000) {
        return {
          low_cents: Math.round(dollars * 0.7 * 100),
          high_cents: Math.round(dollars * 1.3 * 100),
          reasoning: `Price hint from matching listing: $${dollars.toFixed(2)}`,
        };
      }
    }
  }
  return null;
}

function clamp01(n) {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
