/**
 * Tests for the real vision provider.
 *
 * These do not call a paid API. They stand a faithful fake of the Anthropic
 * Messages endpoint in front of the provider so the wire format, the honesty
 * rules and the failure paths can all be checked for free and deterministically.
 *
 * The rules under test are the ones that stop the original failure recurring:
 * a stand-in invented a brand and a price for an object it had never seen, and
 * the app wrote both into the owner's permanent record.
 */
import { AnthropicVisionProvider } from '../packages/reindeer-intake-feature/src/vision/anthropic.js';

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra ? `\n      ${extra}` : ''}`); }
};

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 7)]);

/** Build a fake endpoint that replays one canned tool_use answer. */
function fakeApi(detections, { status = 200, body = null, capture = {} } = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.headers = init.headers;
    capture.body = JSON.parse(init.body);
    if (status !== 200) {
      return { ok: false, status, text: async () => body ?? 'upstream said no', json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'tool_use', name: 'record_objects', input: { detections } }],
      }),
    };
  };
}

const provider = (fetchImpl, opts = {}) =>
  new AnthropicVisionProvider({ apiKey: 'test-key', fetchImpl, ...opts });

console.log('\nWire format');
{
  const cap = {};
  const p = provider(fakeApi([], { capture: cap }));
  await p.detectItems([{ media_id: 'a', frame_index: 0, buffer: JPEG }], { room_hint: 'Living Room' });
  ok(cap.url === 'https://api.anthropic.com/v1/messages', 'posts to the Anthropic messages endpoint');
  ok(cap.headers['x-api-key'] === 'test-key', 'sends the key as x-api-key, not a bearer token');
  ok(cap.headers['anthropic-version'] === '2023-06-01', 'sends the required API version header');
  ok(cap.body.tool_choice?.name === 'record_objects', 'forces the structured answer rather than hoping for JSON');
  const blocks = cap.body.messages[0].content;
  ok(blocks.some((b) => b.type === 'image' && b.source.media_type === 'image/jpeg'), 'sends the photo as a base64 image block');
  ok(blocks.at(-1).text.includes('Living Room'), 'passes the room through as a hint');
  ok(blocks.at(-1).text.includes('is NOT identification of a maker'), 'the attribution rule reaches the model');
}
{
  const cap = {};
  await provider(fakeApi([], { capture: cap })).detectItems([{ frame_index: 0, buffer: PNG }]);
  ok(cap.body.messages[0].content.find((b) => b.type === 'image').source.media_type === 'image/png',
    'detects PNG rather than mislabelling everything as JPEG');
}

console.log('\nAttribution honesty');
{
  const [d] = await provider(fakeApi([{
    label: 'Wall sconce', frame_index: 0, confidence: 0.9,
    maker_identified: false,
    identifiers: { brand: 'Ferro Studio', marks: 'looks like their work' },
    maker_reasoning: 'The style resembles a known workshop but no mark is legible.',
    value_known: false,
  }])).detectItems([{ frame_index: 0, buffer: JPEG }]);
  ok(Object.keys(d.identifiers).length === 0,
    'a maker guessed from style is discarded, even when the model volunteers one',
    `got ${JSON.stringify(d.identifiers)}`);
  ok(d.maker_identified === false, 'the record states plainly that the maker is unknown');
  ok(d.maker_reasoning.includes('no mark is legible'), 'the reason is kept so the owner can judge it');
}
{
  const [d] = await provider(fakeApi([{
    label: 'Pocket watch', frame_index: 0, confidence: 0.95,
    maker_identified: true,
    identifiers: { brand: 'Hamilton', serial: '  ', model: '992B' },
    value_known: false,
  }])).detectItems([{ frame_index: 0, buffer: JPEG }]);
  ok(d.identifiers.brand === 'Hamilton' && d.identifiers.model === '992B',
    'a mark that was actually read is kept');
  ok(!('serial' in d.identifiers), 'blank fields are dropped rather than stored as empty strings');
}

console.log('\nValuation honesty');
{
  const [d] = await provider(fakeApi([{
    label: 'Iron sconce', frame_index: 0, confidence: 0.88,
    maker_identified: false, value_known: false,
    value_reasoning: 'Worth depends on who made it, which cannot be seen here.',
    appraisal_suggested: true,
  }])).detectItems([{ frame_index: 0, buffer: JPEG }]);
  ok(d.value_estimate_cents === null, 'no figure is produced when the model abstains');
  ok(d.value_suggestion === null, 'and no suggestion is fabricated either');
  ok(d.value_unknown_reason.includes('cannot be seen'), 'the owner is told why there is no figure');
  ok(d.appraisal_suggested === true, 'an appraisal is recommended where it is warranted');
}
{
  const [d] = await provider(fakeApi([{
    label: 'Cast iron skillet', frame_index: 0, confidence: 0.9,
    maker_identified: true, identifiers: { brand: 'Griswold' },
    value_known: true, value_low_cents: 4000, value_high_cents: 9000,
    value_reasoning: 'Common mass-produced pattern with an active resale market.',
  }])).detectItems([{ frame_index: 0, buffer: JPEG }]);
  ok(d.value_estimate_cents === null,
    'even a confident model estimate never becomes the stored value of the object');
  ok(d.value_suggestion.low_cents === 4000 && d.value_suggestion.high_cents === 9000,
    'the estimate travels as a range the owner can accept or ignore');
  ok(d.value_suggestion.reasoning.length > 0, 'the range comes with its reasoning attached');
}
{
  const [d] = await provider(fakeApi([{
    label: 'Ring', frame_index: 0, confidence: 0.8,
    maker_identified: false, value_known: true,
    value_low_cents: 120000, value_high_cents: 400000,
  }])).detectItems([{ frame_index: 0, buffer: JPEG }]);
  // Design (see packages/reindeer-intake-feature/src/vision/index.js and
  // anthropic.js): the registry never asserts a value tier. `high_value_flag`
  // stays false at Registry regardless of the suggested range. Fair Choice
  // does the tiering later, using its own estimate and the PR-chosen
  // threshold. What the registry DOES do is (a) surface the suggested range
  // so the owner can accept or ignore it, and (b) recommend an appraisal
  // when the item text itself contains cue words. A bare 'Ring' with no
  // description hits no cue, so neither the range nor the label alone
  // triggers an appraisal_suggested here — the range is present, but the
  // registry does not overstate what it can conclude on its own.
  ok(d.high_value_flag === false,
    'a high suggested range does not flip Registry high_value_flag — FC does the tiering');
  ok(d.value_suggestion && d.value_suggestion.low_cents === 120000 && d.value_suggestion.high_cents === 400000,
    'the suggested range still travels for the owner to accept or ignore');
}
{
  const [d] = await provider(fakeApi([{
    label: 'Vase', frame_index: 0, confidence: 0.7,
    maker_identified: false, value_known: true,
    value_low_cents: null, value_high_cents: 5000,
  }])).detectItems([{ frame_index: 0, buffer: JPEG }]);
  ok(d.value_suggestion === null,
    'a half-filled range is treated as no range, not as a number to lean on');
}

console.log('\nMalformed and hostile answers');
{
  const noTool = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'I refuse.' }] }) });
  const out = await provider(noTool).detectItems([{ frame_index: 0, buffer: JPEG }]);
  ok(Array.isArray(out) && out.length === 0, 'a refusal yields nothing rather than crashing the capture');
}
{
  const [d] = await provider(fakeApi([{ frame_index: 0, maker_identified: false, value_known: false, confidence: 9 }]))
    .detectItems([{ frame_index: 0, buffer: JPEG }]);
  ok(d.confidence === 1, 'an out-of-range confidence is clamped instead of stored raw');
  ok(d.label === 'Unidentified object', 'a missing label degrades to plain language, not to undefined');
}
{
  const [d] = await provider(fakeApi([{
    label: 'Chair', frame_index: 0, confidence: 0.5, bbox: [0.1, 0.2, 0.3],
    maker_identified: false, value_known: false,
  }])).detectItems([{ frame_index: 0, buffer: JPEG }]);
  ok(d.bbox === null, 'a malformed bounding box is dropped rather than half-used');
}

console.log('\nFailure paths');
{
  let msg = '';
  try {
    await provider(fakeApi([], { status: 401, body: 'invalid x-api-key' })).detectItems([{ frame_index: 0, buffer: JPEG }]);
  } catch (e) { msg = e.message; }
  ok(msg.includes('401'), 'a rejected key surfaces as an error, never as an empty successful result');
}
{
  let msg = '';
  const hang = () => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), 20));
  try {
    await provider(hang, { timeoutMs: 10 }).detectItems([{ frame_index: 0, buffer: JPEG }]);
  } catch (e) { msg = e.message; }
  ok(msg.includes('please type what it is'),
    'a timeout tells the owner their photo is safe and what to do next');
}
{
  let msg = '';
  const dead = async () => { throw new Error('ECONNREFUSED'); };
  try { await provider(dead).detectItems([{ frame_index: 0, buffer: JPEG }]); } catch (e) { msg = e.message; }
  ok(msg.includes('could not be reached'), 'an unreachable service says so in plain words');
}

console.log('\nMulti-frame grouping');
{
  const out = await provider(fakeApi([
    { label: 'Oak chair', frame_index: 0, confidence: 0.7, maker_identified: false, value_known: false },
    { label: 'oak chair', frame_index: 1, confidence: 0.9, maker_identified: false, value_known: false },
  ])).detectItems([{ frame_index: 0, buffer: JPEG }, { frame_index: 1, buffer: JPEG }]);
  ok(out.length === 1, 'the same object across two frames is one item, not two');
  ok(out[0].confidence === 0.9, 'the clearest sighting wins');
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
