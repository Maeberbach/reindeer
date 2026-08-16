/* Reindeer: Registry client.
   Guided, one-decision-per-screen capture. Cropping happens here on a canvas
   so the server needs no image library and raw source photos are never kept. */

/* Where the server lives.

   Served by the app's own Express process, this is empty and every request
   below stays a plain relative path, exactly as before. When the client is
   hosted separately from the server (a preview deployment), the placeholder
   is rewritten at deploy time and the same paths are routed through to it.
   Nothing about local behaviour changes. */
const API = '__PORT_3210__'.startsWith('__') ? '' : '__PORT_3210__';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (url, opts = {}) => {
  const res = await fetch(API + url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
  return res.headers.get('content-type')?.includes('json') ? res.json() : res;
};
const toast = (msg, bad = false) => {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast${bad ? ' bad' : ''}`; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 3200);
};
const money = (c) => (c == null ? '' : `$${(c / 100).toLocaleString('en-US')}`);

let registry = { rooms: [], categories: [] };
let history = [];

// ------------------------------------------------------- duplicates (offered)
/**
 * Mention possible duplicates once, in plain language, and let the owner walk
 * away from it.
 *
 * The registry never compels a duplicate review. Getting things documented is
 * the whole point, and an owner halfway through a room should not be handed a
 * chore. Three honest choices: look now, look later, or leave it to the person
 * settling the estate — Reindeer: FairPlay runs the same check and shows it
 * to the personal representative.
 */
/*
 * While walking a room, duplicate warnings are counted quietly instead of shown.
 *
 * Keeping eight things out of one recording would otherwise raise the panel
 * eight times, each one covering the screen and standing between the owner and
 * the next room. Duplicates are never urgent here — the whole point of this app
 * is that a thing gets written down — so they are tallied and mentioned once, in
 * a sentence, when the owner comes back out of the room.
 */
let inRoomNaming = false;
let roomDupCount = 0;

function offerDuplicateCheck(count) {
  if (inRoomNaming) {
    roomDupCount += count;
    toast('Saved.');
    return;
  }
  const box = $('#dupOffer');
  if (!box) {
    toast('Saved.');
    return;
  }
  $('#dupOfferText').textContent =
    `Saved. ${count === 1 ? 'One item' : `${count} items`} may already be on your list. ` +
    `You do not have to sort this out now.`;
  box.hidden = false;
  box.dataset.count = String(count);
}

// Both buttons are wired once, at load, because the panel is permanent markup.
document.addEventListener('DOMContentLoaded', () => {
  $('#dupLook')?.addEventListener('click', runDuplicateCheck);
  // "Not now" is a complete answer. Nothing is queued, nothing is remembered as
  // owed, nothing is lost — the items are already saved.
  $('#dupLater')?.addEventListener('click', () => {
    $('#dupOffer').hidden = true;
    toast('Saved. Left as it is.');
  });
  $('#dupCheckBtn')?.addEventListener('click', runDuplicateCheck);
});

async function runDuplicateCheck() {
  $('#dupOffer').hidden = true;
  try {
    const { groups } = await api('/api/duplicates/scan');
    if (!groups.length) {
      toast('Nothing looks like a duplicate.');
      return;
    }
    go('list');
    toast(`${groups.length} to look at. They are marked in your list.`);
  } catch {
    toast('Could not check just now. Nothing was lost.', true);
  }
}

// ---------------------------------------------------------------- navigation
// The flow is keyed by name, never by position, so a step can be added or
// retired without silently rewiring the one after it.
/**
 * The short path is the whole point.
 *
 * An unrecorded item helps nobody, so the questions that must be answered to
 * get one onto the list are the only ones asked by default: a photograph, a
 * name, and who it is meant for. Naming the room, the maker, the story and the
 * category all make the record better, and none of them make it exist, so they
 * wait behind one optional detour rather than standing between the owner and a
 * saved item.
 *
 * 'Worth' was retired: what a thing is worth matters when the estate is
 * settled, not while an owner is photographing a sideboard, so it is asked at
 * distribution instead. Its markup is kept and marked data-retired so the next
 * person can see it was a decision.
 */
const CORE_STEPS = ['Photo', 'Name', 'For whom', 'Save'];
const DETAIL_STEPS = ['Room', 'Maker', 'Story', 'Kind'];
const FULL_STEPS = ['Photo', 'Name', 'For whom', ...DETAIL_STEPS, 'Save'];

/*
 * The gifting walk is shorter than the ordinary one, and deliberately so.
 *
 * When an owner already knows a thing is meant for a particular person, the
 * person is the whole point and the object's name is not: the photograph
 * identifies it, and a trustee reading the sheet is looking at the picture. So
 * this path asks for a photograph and a name of a PERSON, and never asks the
 * owner to caption their own belongings. Whatever the camera recognised fills
 * the title line by itself; if it recognised nothing, the line says so plainly
 * and points at the photograph.
 */
const PROMISE_STEPS = ['Photo', 'For whom', 'Save'];
const NO_TITLE = 'Unnamed item — see photograph';

/** What goes on the title line when the owner was never asked for one. */
const effectiveTitle = () =>
  cap.title || $('#capTitle')?.value.trim() || cap.ai?.label || NO_TITLE;

/** The sequence in play right now. Starts short; the owner may lengthen it. */
let STEP_LABELS = CORE_STEPS.slice();

function go(name, opts = {}) {
  if (!opts.back) history.push(currentScreen());
  $$('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
  $('#backBtn').hidden = name === 'home' || name === 'welcome';
  $('#appTitle').textContent = {
    welcome: 'Reindeer: Registry', home: 'Reindeer: Registry', capture: 'Add an item', batch: 'Add several',
    list: 'My items', detail: 'Item', print: 'Print', handoff: 'Finishing up', confirmsend: 'Confirm',
    signing: 'Making it official', people: 'My people',
    walk: 'Room by room', room: 'This room', promise: 'What you already know',
    helperinvite: 'Invite a helper',
  }[name] ?? 'Reindeer: Registry';
  window.scrollTo(0, 0);
  if (name === 'walk') loadWalk();
  if (name === 'promise') renderPromise();
  // Landing on the menu ends the gifting walk, so "Add one item" is never
  // silently shortened by a mode the owner has already left behind.
  if (name === 'home') { promiseMode = false; renderResume(); refreshQueueBadge(); renderCounters(); }
  if (name === 'batch') { const bi = $('#batchIntake'); if (bi) bi.hidden = false; }
  if (name === 'list') loadList();
  if (name === 'signing') loadExecution();
  if (name === 'people') loadPeople();
  if (name === 'capture') renderPersonChips();
  if (name === 'handoff') { verifyRecord(); refreshFinishScreen(); }
}
const currentScreen = () => $$('.screen').find((s) => !s.hidden)?.dataset.screen ?? 'home';

$('#backBtn').onclick = () => go(history.pop() || 'home', { back: true });
$$('[data-go]').forEach((b) => { b.onclick = () => { if (b.dataset.go === 'capture') resetCapture(); go(b.dataset.go); }; });

// ------------------------------------------------------------ guided capture
let cap = null;
let step = 0;

function resetCapture() {
  cap = { file: null, dataUrl: null, title: '', maker: '', marks: '', story: '', valueCents: null, valueBasis: 'unknown',
          room: '', category: '', recipient: '', relationship: '', note: '', ai: null,
          // Owner-set "this matters" mark. Both are OFF by default — the owner
          // must actively tick the box, and reason chips only apply once the
          // box is on. See docs/decisions/2026-08-06-important-flag.md.
          important: false, importantFeeling: false, importantMoney: false };
  STEP_LABELS = (promiseMode ? PROMISE_STEPS : CORE_STEPS).slice();
  step = 0;
  ['#capTitle', '#capMaker', '#capMarks', '#capStory', '#capValue', '#capRecipient', '#capRelationship', '#capOwnerNote', '#capRoomOther']
    .forEach((s) => { $(s).value = ''; });
  $('#capValueBasis').value = 'unknown';
  $('#capPreview').hidden = true; $('#aiNote').hidden = true; $('#capRoomOther').hidden = true;
  $$('#roomChips .chip, #catChips .chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  // Reset the Important control on the review step.
  $('#capImportant').checked = false;
  $('#capImportantChips').hidden = true;
  $$('#capImportantChips .chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  renderStep();
}

/*
 * The owner-set Important flag lives on the review step. Wired here rather
 * than at the top of the module because #capImportant only exists inside the
 * capture screen. The reason chips reveal only when the box is ticked; toggling
 * the box back off clears the chips so an unflagged item never carries a
 * reason. Whether the resulting reason serializes to 'feeling', 'money',
 * 'both', or '' is decided at save time in reasonFromCap().
 */
function wireImportantControl() {
  const box = $('#capImportant');
  const chipsWrap = $('#capImportantChips');
  if (!box || !chipsWrap) return;
  box.onchange = () => {
    cap.important = box.checked;
    chipsWrap.hidden = !box.checked;
    if (!box.checked) {
      cap.importantFeeling = false;
      cap.importantMoney = false;
      $$('#capImportantChips .chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
    }
  };
  $$('#capImportantChips .chip').forEach((chip) => {
    chip.onclick = () => {
      const now = chip.getAttribute('aria-pressed') !== 'true';
      chip.setAttribute('aria-pressed', String(now));
      const key = chip.dataset.reason === 'feeling' ? 'importantFeeling' : 'importantMoney';
      cap[key] = now;
    };
  });
}
wireImportantControl();

// Serializes the owner's chip selection to the four allowed backend values.
// Kept as one small function so the rule lives in exactly one place: reason is
// only meaningful on a flagged item, and both-off is not "unflagged", it is
// "flagged with no stated reason".
function reasonFromCap(c) {
  if (!c.important) return '';
  if (c.importantFeeling && c.importantMoney) return 'both';
  if (c.importantFeeling) return 'feeling';
  if (c.importantMoney) return 'money';
  return '';
}

function renderStep() {
  const here = STEP_LABELS[step];
  $$('.step').forEach((s) => { s.hidden = s.dataset.stepname !== here; });
  $('#stepDots').innerHTML = STEP_LABELS.map((_, i) => `<span class="dot${i <= step ? ' on' : ''}"></span>`).join('');
  $('#whereAmI').textContent = `Step ${step + 1} of ${STEP_LABELS.length} — ${STEP_LABELS[step]}`;
  $('#stepBack').textContent = step === 0 ? 'Cancel' : 'Back';
  $('#stepNext').textContent = step === STEP_LABELS.length - 1 ? 'Save item' : 'Next';
  if (step === STEP_LABELS.length - 1) renderSummary();
  // The recipient step is where the roster earns its keep.
  if (STEP_LABELS[step] === 'For whom') renderPersonChips();
}

/**
 * Lengthen the walk to include the optional questions.
 *
 * Anything already answered is kept — the owner is being offered more to say,
 * never asked to repeat themselves — and they land on the first of the extra
 * questions rather than back at the beginning.
 */
function addMoreDetail() {
  STEP_LABELS = FULL_STEPS.slice();
  step = STEP_LABELS.indexOf(DETAIL_STEPS[0]);
  renderStep();
}

$('#capMoreDetail').onclick = addMoreDetail;
$('#stepBack').onclick = () => { if (step === 0) return go(promiseMode ? 'promise' : 'home'); step--; renderStep(); };
$('#stepNext').onclick = async () => {
  const here = STEP_LABELS[step];
  if (here === 'Photo' && !cap.dataUrl) return toast('Please take a photo first.', true);
  if (here === 'Name') {
    cap.title = $('#capTitle').value.trim();
    if (!cap.title) return toast('Please give the item a short name.', true);
  }
  if (here === 'Maker') {
    cap.maker = $('#capMaker').value.trim();
    cap.marks = $('#capMarks').value.trim();
  }
  if (here === 'Story') cap.story = $('#capStory').value.trim();
  if (here === 'Room' && $('#capRoomOther').value.trim()) {
    cap.room = $('#capRoomOther').value.trim();
    // Keep it as a choice for next time rather than making them retype it.
    rememberTypedRoom(cap.room);
  }
  if (here === 'For whom') {
    // Only in promise mode is a name insisted upon, because a promise without a
    // person is not a promise. Everywhere else blank stays perfectly valid: an
    // owner must never be nudged into naming someone they have not chosen, or
    // the printed record stops being evidence of their wishes.
    if (promiseMode && !$('#capRecipient').value.trim()) {
      return toast('This one is for someone in particular — please put in their name. '
        + 'If you are not sure, press Back and add it as an ordinary item instead.', true);
    }
    cap.recipient = $('#capRecipient').value.trim();
    cap.relationship = $('#capRelationship').value.trim();
    cap.note = $('#capOwnerNote').value.trim();
  }
  if (step === STEP_LABELS.length - 1) return saveItem();
  step++; renderStep();
};

$('#capPhoto').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  cap.file = f;
  cap.dataUrl = await downscale(f, 1600);
  $('#capPreview').src = cap.dataUrl; $('#capPreview').hidden = false;

  // Recognition can take most of a minute. Saying so, on the screen and not in
  // a toast that vanishes, is the difference between waiting and concluding the
  // app is broken. The Next button is never blocked while this runs: the photo
  // is already safe, and typing the name by hand is always allowed.
  // Looked up fresh on every write, never held onto. Moving between steps can
  // rebuild this part of the screen, and a reference captured before the wait
  // would end up pointing at a discarded element — the answer would arrive and
  // be written somewhere nobody can see it. Since this very message invites the
  // owner to carry on while it thinks, that is exactly what would happen.
  const setNote = (html) => {
    const el = $('#aiNote');
    if (!el) return;
    el.hidden = false;
    el.innerHTML = html;
  };
  setNote('Looking at the photo… this can take up to a minute. '
    + 'You do not have to wait — carry on and type the name yourself if you prefer.');

  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), 75000);
  try {
    const { detections, vision_mode } = await api('/api/intake/detect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: giveUp.signal,
      body: JSON.stringify({ images: [{ data_url: cap.dataUrl, frame_index: 0 }] }),
    });
    // A stand-in model must not be dressed up as a real one. When no vision
    // service is configured the suggestion is meaningless, so say nothing
    // rather than putting an invented name in the person's own record.
    if (vision_mode === 'mock') {
      cap.ai = null;
      setNote('<b>Photo saved.</b> Automatic recognition is not switched on yet, '
        + 'so please type what this is. Nothing has been guessed for you.');
      return;
    }
    const best = detections.sort((a, b) => b.confidence - a.confidence)[0];
    if (best) {
      cap.ai = best;
      // Only fill the box if the owner has not already typed their own name for
      // it while waiting. Their words outrank the machine's, always.
      const box = $('#capTitle');
      if (box && !box.value.trim()) box.value = best.label;
      setNote(`This looks like: ${escapeHtml(best.label)}${best.category_hint ? ` (${escapeHtml(best.category_hint)})` : ''}. Change it if that is not right.`);
      if (best.category_hint) cap.category = best.category_hint;
    } else {
      setNote('<b>Photo saved.</b> Nothing was recognised in it, so please type what this is.');
    }
  } catch {
    // Recognition is a convenience and never a blocker — but failing in silence
    // leaves the owner staring at an empty box wondering what went wrong. Say
    // plainly that the photo is safe and that typing the name is all that is
    // needed. Never invent a name to fill the gap.
    cap.ai = null;
    setNote('<b>Photo saved.</b> Automatic recognition is not answering just now, '
      + 'so please type what this is. Nothing has been lost and nothing has been guessed for you.');
  } finally {
    clearTimeout(timer);
  }
};

/* ------------------------------------------------------------------ */
/* Money entered by hand or by voice.                                  */
/*                                                                     */
/* Speech recognition is inconsistent about numbers: "four hundred     */
/* fifty dollars" may come back as "450", "$450", or the words         */
/* themselves. All three have to work, or the person concludes the     */
/* microphone is broken and stops trusting it.                         */
/* ------------------------------------------------------------------ */
const NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUM_SCALES = { hundred: 100, thousand: 1000, million: 1000000 };

function wordsToNumber(text) {
  const tokens = text.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  let total = 0, current = 0, saw = false;
  for (const t of tokens) {
    if (t === 'and') continue;
    if (t in NUM_WORDS) { current += NUM_WORDS[t]; saw = true; continue; }
    if (t in NUM_SCALES) {
      const scale = NUM_SCALES[t];
      if (scale === 100) current = (current || 1) * 100;
      else { total += (current || 1) * scale; current = 0; }
      saw = true;
      continue;
    }
    return null; // an unexpected word — don't guess
  }
  if (!saw) return null;
  return total + current;
}

/** Returns whole cents, or null when the text is not a usable amount. */
function parseMoneyToCents(raw) {
  if (raw == null) return null;
  let t = String(raw).toLowerCase().trim();
  if (!t) return null;
  // Commas and currency symbols are removed outright, not turned into spaces:
  // "1,250.00" must stay one number rather than becoming "1 250.00".
  t = t.replace(/\b(dollars?|bucks|usd|about|around|roughly|maybe|worth)\b/g, ' ')
       .replace(/[$,]/g, '')
       .replace(/\s+/g, ' ')
       .trim();
  if (!t) return null;

  const digits = t.match(/^(\d+(?:\.\d{1,2})?)$/);
  if (digits) return Math.round(parseFloat(digits[1]) * 100);

  // "1200 50" from "twelve hundred and fifty" is ambiguous; require plain words.
  const asWords = wordsToNumber(t);
  if (asWords !== null && Number.isFinite(asWords)) return Math.round(asWords * 100);
  return null;
}

/* ------------------------------------------------------------------ */
/* Voice input, available on every field that takes free text.         */
/* Previously only the story box had a microphone, so anything spoken  */
/* about the maker or the value had nowhere to land.                   */
/* ------------------------------------------------------------------ */
function startDictation(targetId, btn) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('This device cannot listen. Please type instead.', true);
  const el = $('#' + targetId);
  const r = new SR();
  r.lang = 'en-US';
  r.interimResults = false;
  const original = btn.textContent;
  btn.textContent = '● Listening — tap when finished';
  btn.classList.add('listening');
  const restore = () => { btn.textContent = original; btn.classList.remove('listening'); };

  r.onresult = (e) => {
    const heard = e.results[0][0].transcript.trim();
    if (targetId === 'capValue') {
      const cents = parseMoneyToCents(heard);
      if (cents === null) {
        toast(`Heard "${heard}", which is not an amount. Please type it.`, true);
        return;
      }
      el.value = (cents / 100).toFixed(2).replace(/\.00$/, '');
      toast(`Recorded $${el.value}.`);
      return;
    }
    el.value += (el.value ? ' ' : '') + heard;
  };
  r.onerror = () => { restore(); toast('Could not hear that. Please type instead.', true); };
  r.onend = restore;
  r.start();
  toast('Listening…');
}

$$('[data-mic]').forEach((btn) => {
  btn.onclick = () => startDictation(btn.dataset.mic, btn);
});

/** "$1,250" rather than "$1250" — easier to read at a glance, and harder to misread by a factor of ten. */
function fmtMoney(cents) {
  const n = cents / 100;
  const whole = Number.isInteger(n);
  return '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

const BASIS_WORDS = {
  unknown: 'a guess',
  owner_estimate: 'your own estimate',
  appraisal: 'a written appraisal',
  receipt: 'a receipt',
  comparable_sale: 'a similar one you saw sell',
  insurance: 'your insurance listing',
};

function renderSummary() {
  const onFullPath = STEP_LABELS.length === FULL_STEPS.length;
  const row = (k, v) => `<div><b>${k}:</b> ${v || '<span style="color:#8a857c">not given</span>'}</div>`;
  $('#capSummary').innerHTML = `
    ${cap.dataUrl ? `<img src="${cap.dataUrl}" class="preview" alt="">` : ''}
    ${row('Name', escapeHtml(effectiveTitle()))}${row('Intended for', cap.recipient)}
    ${cap.recipient ? '<div style="color:#55504a;font-size:16px">Recorded as a wish, not a legal instruction.</div>' : ''}
    ${onFullPath ? `${row('Room', cap.room)}${row('Maker or artist', cap.maker)}${row('Marks', cap.marks)}
         ${row('Story', cap.story)}${row('Kind', cap.category)}` : ''}`;

  // Offered, never pressed. The button disappears once taken so the summary
  // does not keep asking for something the owner has already been given.
  $('#capMoreDetail').hidden = onFullPath;
  $('#capMoreDetailNote').hidden = onFullPath;
}

/**
 * Identifiers are things a person can point to on the object: a maker's name,
 * a signature, a stamped number. Only what the owner actually told us goes in
 * here — nothing inferred.
 */
function buildIdentifiers() {
  const out = {};
  if (cap.maker) out.maker = cap.maker;
  if (cap.marks) out.marks = cap.marks;
  return out;
}

async function saveItem() {
  try {
    const item = await api('/api/items', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: effectiveTitle(), story: cap.story,
        room_name: cap.room || null, category_name: cap.category || null,
        review_state: 'kept',
        // The value on an estate record is the OWNER'S, never the camera's.
        // This app previously saved the vision model's guess as though the
        // owner had stated it — a fabricated brand and dollar figure stamped
        // with a confidence score. On an inventory families rely on to divide
        // property, that is not a rough edge, it is a false record.
        value_basis: cap.valueCents != null ? cap.valueBasis : 'unknown',
        value_estimate_cents: cap.valueCents,
        // Owner-set Important mark. The API validates the reason enum and
        // coerces it back to '' if the box was left off, so a stale form
        // cannot attach a reason to an unflagged item.
        owner_high_value: cap.important === true,
        owner_high_value_reason: reasonFromCap(cap),
        ai_confidence: cap.ai?.confidence ?? null,
        identifiers: buildIdentifiers(),
        recipient_hint: cap.recipient
          ? { recipient_name: cap.recipient, relationship: cap.relationship, owner_note: cap.note }
          : null,
      }),
    });
    if (cap.dataUrl) await uploadPhoto(item.item_id, cap.dataUrl);
    // A name typed here joins the roster, so the next item is one tap. The
    // save must not fail because the address book did, hence the catch.
    if (cap.recipient) {
      try { await addPerson(cap.recipient, cap.relationship, 'from_item'); } catch { /* not worth stopping for */ }
    }
    toast('Saved. You can change it any time.');
    refreshCount();
    resetCapture();
    // In promise mode the owner is in the middle of emptying a list they already
    // carry in their head. Dropping them back on the menu after each one breaks
    // that thread; asking "anything else you already know?" keeps it.
    if (promiseMode) { promiseKept += 1; return go('promise'); }
    go('home');
  } catch (e) { toast(e.message, true); }
}

async function uploadPhoto(itemId, dataUrl, bbox = null) {
  const blob = await (await fetch(dataUrl)).blob();
  const q = bbox ? `?bbox=${encodeURIComponent(JSON.stringify(bbox))}` : '';
  await fetch(`${API}/api/items/${itemId}/photos${q}`, { method: 'POST', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob });
}

// ------------------------------------------------------------------- batch
// Two lanes arrive here and then share one path. Photos become frames; a video
// becomes frames too. Everything after that is identical, which is why the
// walkthrough needed no new endpoint — the detect route already accepts frames
// and already groups the same object seen from several angles.
let batchFiles = [];
const MAX_FRAMES = 10;

function showThumbs() {
  const thumbs = $('#batchThumbs'); thumbs.innerHTML = '';
  for (const f of batchFiles) { const img = new Image(); img.src = f._dataUrl; thumbs.append(img); }
  $('#batchGo').disabled = !batchFiles.length;
  $('#batchGo').textContent = batchFiles.length
    ? `Find items in these ${batchFiles.length} pictures`
    : 'Find items in these';
}

$('#batchPhotos').onchange = async (e) => {
  batchFiles = [];
  for (const f of [...e.target.files].slice(0, MAX_FRAMES)) {
    f._dataUrl = await downscale(f, 1600);
    batchFiles.push(f);
  }
  showThumbs();
};

/**
 * Pull still frames out of a video in the browser.
 *
 * Deliberately forgiving. Frame seeking is unreliable on older phones, so every
 * failure mode ends with the owner still able to continue: if we get some frames
 * we use them, and if we get none we say so plainly and point at the photo lane
 * rather than showing an error and stopping.
 */
async function framesFromVideo(file, want = 8) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.src = URL.createObjectURL(file);
  try {
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error('unreadable'));
      setTimeout(() => rej(new Error('timeout')), 15000);
    });
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    if (!dur) return { frames: [], duration_ms: null };

    // Skip the first and last moments — those are usually a hand or a doorway.
    const times = Array.from({ length: want }, (_, i) => dur * ((i + 0.5) / want));
    const canvas = document.createElement('canvas');
    const frames = [];
    for (const t of times) {
      const ok = await new Promise((res) => {
        let done = false;
        const finish = (val) => { if (!done) { done = true; res(val); } };
        v.onseeked = () => finish(true);
        setTimeout(() => finish(false), 4000);
        try { v.currentTime = t; } catch { finish(false); }
      });
      if (!ok || !v.videoWidth) continue;
      const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL('image/jpeg', 0.82));
    }
    return { frames, duration_ms: Math.round(dur * 1000) };
  } catch {
    return { frames: [], duration_ms: null };
  } finally {
    URL.revokeObjectURL(v.src);
  }
}

$('#batchVideo').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const state = $('#videoState');
  state.hidden = false;
  state.textContent = 'Looking through the recording… this can take a moment.';
  batchFiles = [];
  showThumbs();

  const { frames, duration_ms } = await framesFromVideo(file, MAX_FRAMES);

  if (!frames.length) {
    state.textContent = 'This phone could not read still pictures out of that video. '
      + 'Nothing was lost — please use “Choose photos” below instead.';
    return;
  }

  batchFiles = frames.map((dataUrl, i) => ({ _dataUrl: dataUrl, _frame: i }));
  showThumbs();
  state.textContent = `${frames.length} pictures taken from the recording. `
    + 'The recording itself is kept with your inventory.';

  // Keep the walkthrough itself. It is evidence of the room as it stood, and it
  // is worth more to a trustee than the frames we cut out of it.
  try {
    await fetch(`${API}/api/scope-media?title=${encodeURIComponent('Room walkthrough')}`
      + (duration_ms ? `&duration_ms=${duration_ms}` : ''), {
      method: 'POST', headers: { 'content-type': file.type || 'video/mp4' }, body: file,
    });
  } catch {
    state.textContent += ' (The recording itself could not be saved, but the pictures are here.)';
  }
};

/*
 * Render a set of guesses as keep-or-reject rows.
 *
 * Shared by the old "pick some photos" lane and the room-by-room naming pass, so
 * that keeping a thing behaves identically however the owner arrived at it.
 * Rows are appended into #namingRows when that container exists, which lets the
 * caller put its own explanation above them.
 */
function renderNamingRows(detections) {
  const host = $('#namingRows') ?? $('#batchResults');
  const rows = detections.map((d, i) => `
      <div class="card" data-det="${i}">
        <img src="${batchFiles[d.frame_index ?? 0]?._dataUrl ?? ''}" alt="">
        <div>
          <h3>${escapeHtml(d.label)}</h3>
          <div class="sub">${escapeHtml(d.category_hint ?? '')} ${d.quantity > 1 ? `· ${d.quantity} of them` : ''}</div>
          ${d.appraisal_suggested ? '<span class="badge hv">ASK SOMEONE ABOUT THIS ONE</span>' : ''}
          <div class="detrow">
            <button class="primary" data-keep="${i}">Keep</button>
            <button class="ghost" data-reject="${i}">Not a thing</button>
          </div>
        </div>
      </div>`).join('');
  if (host === $('#namingRows')) host.innerHTML = rows; else host.innerHTML += rows;

  $$('#batchResults [data-reject]').forEach((b) => { b.onclick = () => b.closest('.card').remove(); });
  $$('#batchResults [data-keep]').forEach((b) => {
    b.onclick = async () => {
      const d = detections[Number(b.dataset.keep)];
      const src = batchFiles[d.frame_index ?? 0];
      const crop = src ? await cropTo(src._dataUrl, d.bbox) : null;
      // Carry the room through, so a thing named during a walkthrough of the
      // dining room is filed in the dining room without being asked again.
      const { created, possible_duplicates } = await api('/api/intake/commit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ detections: [{ ...d, crop_data_url: crop, room: room?.name ?? d.room ?? null }] }),
      });
      b.closest('.card').remove();
      refreshCount();
      // Getting things written down is the goal. A possible duplicate is
      // worth mentioning once, plainly, and is never allowed to block saving
      // or to demand a review here. Sorting duplicates out can happen now,
      // later, or in Reindeer: FairPlay — the owner's choice.
      if (possible_duplicates > 0) {
        offerDuplicateCheck(possible_duplicates);
      } else {
        toast('Saved.');
      }
      if (created.length) await api(`/api/items/${created[0]}/keep`, { method: 'POST' });
    };
  });
  if ($('#keepAll')) {
    $('#keepAll').onclick = async () => {
      $('#keepAll').disabled = true;
      const buttons = $$('#batchResults [data-keep]');
      for (const b of buttons) { await b.onclick(); }
      toast(`${buttons.length} things added to your list.`);
    };
  }
}

$('#batchGo').onclick = async () => {
  $('#batchGo').disabled = true;
  toast('Looking through the photos…');
  try {
    const { detections, vision_mode } = await api('/api/intake/detect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images: batchFiles.map((f, i) => ({ data_url: f._dataUrl, frame_index: i, media_id: `m${i}` })) }),
    });
    // The aim of this lane is a complete list, so keeping everything is the
    // easy path and rejecting is the exception. No value is shown here: bulk
    // intake records what a thing is, and what it is worth is decided later.
    $('#batchResults').innerHTML = (vision_mode === 'mock'
        ? `<div class="mockwarn"><p><strong>These are examples, not real findings.</strong>
             The picture-reading service is not switched on yet, so the names below were
             made up by the app rather than read from your photos.</p></div>`
        : '')
      + `<h2>Found ${detections.length} thing${detections.length === 1 ? '' : 's'}</h2>
      <p class="reassure">Keep whatever looks right. You are not naming anyone here —
        these are simply logged. Rejecting one changes nothing else.</p>
      ${detections.length > 1 ? '<button class="primary wide" id="keepAll">Keep all of these</button>' : ''}
      <div id="namingRows"></div>`;
    renderNamingRows(detections);
  } catch (e) { toast(e.message, true); }
  $('#batchGo').disabled = false;
};

// -------------------------------------------------------------------- list
async function loadList() {
  const params = new URLSearchParams();
  if ($('#q').value) params.set('search', $('#q').value);
  if ($('#filterRoom').value) params.set('room_id', $('#filterRoom').value);
  if ($('#filterState').value) params.set('review_state', $('#filterState').value);
  const { items } = await api(`/api/items?${params}`);
  $('#itemList').innerHTML = items.length ? items.map(cardHtml).join('')
    : '<p class="lede">Nothing here yet. Add your first item from the home screen.</p>';
  $$('#itemList .card').forEach((c) => { c.onclick = () => openDetail(c.dataset.id); });
}
['#q', '#filterRoom', '#filterState'].forEach((s) => { $(s).oninput = loadList; });

const cardHtml = (i) => `
  <button class="card" data-id="${i.item_id}">
    ${i.photos?.[0] ? `<img src="${API}/api/photos/${i.photos[0].photo_id}" alt="">` : '<div class="noimg">no photo</div>'}
    <div>
      <h3>${escapeHtml(i.title)}</h3>
      <div class="sub">${escapeHtml(i.room?.name ?? 'No room')} · ${escapeHtml(i.category?.name ?? 'No kind')}${i.quantity > 1 ? ` · ${i.quantity}` : ''}</div>
      ${i.review_state === 'draft' ? '<span class="badge draft">needs review</span>' : '<span class="badge kept">confirmed</span>'}
      ${i.recipient_hint?.recipient_name ? `<span class="badge who">for ${escapeHtml(i.recipient_hint.recipient_name)}</span>` : ''}
      ${i.owner_high_value ? '<span class="badge important">Important</span>' : ''}
    </div>
  </button>`;

async function openDetail(id) {
  const i = await api(`/api/items/${id}`);
  // Pre-tick the two reason chips from what is already stored. 'both' ticks
  // both chips; 'feeling'/'money' ticks one; '' leaves them off. The chips
  // block only shows when the item is flagged.
  const isImportant = !!i.owner_high_value;
  const reason = i.owner_high_value_reason || '';
  const feelingOn = reason === 'feeling' || reason === 'both';
  const moneyOn = reason === 'money' || reason === 'both';
  $('#detailBody').innerHTML = `
    <h2>${escapeHtml(i.title)}</h2>
    <div class="thumbs">${(i.photos ?? []).map((p) => `<img src="${API}/api/photos/${p.photo_id}" alt="">`).join('') || '<div class="noimg">no photo</div>'}</div>
    <div class="summary">
      <div><b>Room:</b> ${escapeHtml(i.room?.name ?? '—')}</div>
      <div><b>Kind:</b> ${escapeHtml(i.category?.name ?? '—')}</div>
      <div><b>How many:</b> ${i.quantity}</div>
      <div><b>Story:</b> ${escapeHtml(i.story) || '—'}</div>
      <div><b>Intended for:</b> ${escapeHtml(i.recipient_hint?.recipient_name ?? '—')}</div>
      <div><b>Recorded:</b> ${new Date(i.created_at).toLocaleDateString()}</div>
    </div>

    <div class="important-block">
      <label class="important-check">
        <input type="checkbox" id="detailImportant"${isImportant ? ' checked' : ''}>
        <span class="important-lbl">This one is important</span>
      </label>
      <p class="important-hint">It matters, for whatever reason.</p>
      <div class="chips important-chips" id="detailImportantChips"${isImportant ? '' : ' hidden'}>
        <button type="button" class="chip" data-reason="feeling" aria-pressed="${feelingOn}">It means a lot</button>
        <button type="button" class="chip" data-reason="money" aria-pressed="${moneyOn}">It is worth money</button>
      </div>
    </div>

    <div class="detrow">
      <a class="primary" target="_blank" href="${API}/api/print/item/${i.item_id}?mark=true">Print this sheet</a>
      <button class="ghost" id="delBtn">Remove item</button>
    </div>`;

  // Wire the Important control on the detail screen. Each change PATCHes the
  // item so the mark survives without a save button — the owner ticks and
  // walks away, and the list card reflects it on next load.
  const patchImportant = async () => {
    const on = $('#detailImportant').checked;
    const feeling = $$('#detailImportantChips .chip').find((c) => c.dataset.reason === 'feeling').getAttribute('aria-pressed') === 'true';
    const money = $$('#detailImportantChips .chip').find((c) => c.dataset.reason === 'money').getAttribute('aria-pressed') === 'true';
    const reason = !on ? '' : (feeling && money ? 'both' : feeling ? 'feeling' : money ? 'money' : '');
    try {
      await api(`/api/items/${i.item_id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner_high_value: on, owner_high_value_reason: reason }),
      });
    } catch (e) { toast(e.message, true); }
  };
  $('#detailImportant').onchange = () => {
    const on = $('#detailImportant').checked;
    $('#detailImportantChips').hidden = !on;
    if (!on) {
      $$('#detailImportantChips .chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
    }
    patchImportant();
  };
  $$('#detailImportantChips .chip').forEach((chip) => {
    chip.onclick = () => {
      const now = chip.getAttribute('aria-pressed') !== 'true';
      chip.setAttribute('aria-pressed', String(now));
      patchImportant();
    };
  });

  $('#delBtn').onclick = async () => {
    if (!confirm(`Remove "${i.title}"? The removal is recorded in the history.`)) return;
    await api(`/api/items/${i.item_id}?reason=owner+removed`, { method: 'DELETE' });
    toast('Removed. The history keeps a record.'); refreshCount(); go('list', { back: true });
  };
  go('detail');
}

/* ------------------------------------------------------------------ */
/* Finishing up.                                                       */
/*                                                                     */
/* Sending the list to Reindeer: FairPlay used to sit on the home     */
/* screen as a headline action, which implied the family division was  */
/* the point of the app. It is not, and for most people it is months   */
/* or years away. It now sits here as one option among four, chosen    */
/* when the list is actually finished.                                 */
/* ------------------------------------------------------------------ */
const FINISH_OPTS = ['#optEmail', '#optPrint', '#optSave', '#optSigned', '#optFairChoice'];

async function refreshFinishScreen() {
  try {
    const { items } = await api('/api/items');
    const n = items.length;
    $('#finishCount').textContent = n
      ? `You have recorded ${n} item${n === 1 ? '' : 's'}. Choose as many as you like — you can come back and do the others later.`
      : 'You have not recorded anything yet. Add an item first.';
  } catch { /* the count is a nicety, not a requirement */ }
  updateFinishButton();
}

function updateFinishButton() {
  const chosen = FINISH_OPTS.filter((id) => $(id).checked);
  const btn = $('#finishGo');
  btn.disabled = chosen.length === 0;
  btn.textContent = chosen.length === 0
    ? 'Choose at least one'
    : chosen.length === 1 ? 'Do this one thing' : `Do these ${chosen.length} things`;
  $('#emailFields').hidden = !$('#optEmail').checked;
}

FINISH_OPTS.forEach((id) => { $(id).onchange = updateFinishButton; });

$('#finishGo').onclick = async () => {
  const wantEmail = $('#optEmail').checked;
  if (wantEmail) {
    const name = $('#trusteeName').value.trim();
    const email = $('#trusteeEmail').value.trim();
    if (!name) return toast('Please write your trustee\u2019s name.', true);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('That email address does not look right. Please check it.', true);
    // Emailing cannot be undone, so it gets its own plain confirmation screen.
    $('#confirmDetail').innerHTML =
      `<b>To:</b> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;<br>`
      + '<b>What they receive:</b> your full list, every photo, every story, and your wishes about who gets what.';
    go('confirmsend');
    return;
  }
  await runFinishActions({ email: false });
};

$('#confirmSendCancel').onclick = () => go('handoff', { back: true });
$('#confirmSendGo').onclick = async () => { go('handoff', { back: true }); await runFinishActions({ email: true }); };

async function runFinishActions({ email }) {
  const done = [];
  const failed = [];
  const box = $('#finishResult');
  box.hidden = false;
  box.innerHTML = 'Working…';

  if (email) {
    try {
      const trustee = await api('/api/trustees', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: $('#trusteeName').value.trim(), email: $('#trusteeEmail').value.trim() }),
      });
      const prepared = await api('/api/delivery/prepare', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trustee_ids: [trustee.trustee_id ?? trustee.id] }),
      });
      await api(`/api/delivery/${prepared.delivery_id ?? prepared.id}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
      done.push(`Emailed to ${escapeHtml($('#trusteeName').value.trim())}`);
    } catch (e) {
      failed.push(`The email did not go out: ${escapeHtml(e.message)}`);
    }
  }

  if ($('#optPrint').checked) {
    window.open(`${API}/api/print/report`, '_blank');
    done.push('Opened the printable list');
  }

  if ($('#optSave').checked) {
    triggerDownload(`${API}/api/export/bundle`);
    setTimeout(() => triggerDownload(`${API}/api/export/csv`), 600);
    done.push('Saved a copy and a spreadsheet');
  }

  if ($('#optSigned').checked) {
    if (execution?.record) {
      window.open(`${API}/api/execution/scan/${execution.record.media_id}`, '_blank');
      done.push('Opened the photograph of your signed page — save it alongside the list when you send it');
    } else {
      failed.push('There is no signed page on file yet. Use <b>Make it official</b> on the home screen first.');
    }
  }

  if ($('#optFairChoice').checked) {
    triggerDownload(`${API}/api/export/bundle`);
    done.push('Downloaded the file for Reindeer: FairPlay — the captain opens it there, and every item lands in their review queue first');
  }

  box.innerHTML = [
    done.length ? `<b>Done:</b><ul>${done.map((d) => `<li>${d}</li>`).join('')}</ul>` : '',
    failed.length ? `<b>Not done:</b><ul>${failed.map((d) => `<li>${d}</li>`).join('')}</ul>` : '',
  ].join('');
  FINISH_OPTS.forEach((id) => { $(id).checked = false; });
  updateFinishButton();
}

function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url; a.download = '';
  document.body.append(a); a.click(); a.remove();
}

async function verifyRecord() {
  try {
    const v = await api('/api/audit/verify');
    $('#verifyBox').innerHTML = v.ok
      ? `<b>History intact.</b> ${v.count} recorded actions, none altered. This is what lets a printed list be trusted later.`
      : `<b>Warning:</b> the history could not be verified at entry ${v.brokenAt}.`;
  } catch { $('#verifyBox').textContent = ''; }
}

// -------------------------------------------------------------------- utils
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Downscale on the client so uploads stay small on cellular. */
function downscale(file, max) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.src = URL.createObjectURL(file);
  });
}

/** Crop to a normalized bbox with padding — the per-item thumbnail. */
function cropTo(dataUrl, bbox, pad = 0.06) {
  if (!bbox) return Promise.resolve(dataUrl);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const [x, y, w, h] = bbox;
      const sx = Math.max(0, (x - pad)) * img.width;
      const sy = Math.max(0, (y - pad)) * img.height;
      const sw = Math.min(1 - x + pad, w + pad * 2) * img.width;
      const sh = Math.min(1 - y + pad, h + pad * 2) * img.height;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(sw)); c.height = Math.max(1, Math.round(sh));
      c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.src = dataUrl;
  });
}

/* ------------------------------------------------------------------ signing

   The one part of this app that touches a document meant to have legal effect,
   and therefore the one part where the app's job is to say no. Electronic
   signature law carves wills out by name, and a memorandum of tangible personal
   property takes effect through the will that refers to it. So there is no
   signature control here and there never will be — it would look authoritative
   and fail at the only moment it was ever needed.

   What is left is worth having: print the page, sign it in ink, photograph the
   result, say where the paper went, say out loud that you meant it, and let a
   professional put their name to having seen it. */

let execution = null;
let signBlob = null;

async function loadExecution() {
  try {
    execution = await api('/api/execution');
  } catch { execution = null; return; }
  const rec = execution?.record;

  if (rec) {
    $('#signPreview').src = `${API}/api/execution/scan/${rec.media_id}`;
    $('#signPreview').hidden = false;
    if (rec.signed_on) $('#signDate').value = rec.signed_on;
    if (rec.original_location) $('#signPlace').value = rec.original_location;
    $('#stmtBox').hidden = false;
    if (rec.statement) {
      $('#stmtPlayer').src = `${API}/api/execution/statement/${rec.statement.media_id}`;
      $('#stmtPlayer').hidden = false;
      $('#stmtRecord').textContent = 'Record it again';
    }
    const box = $('#signResult');
    box.hidden = false;
    box.innerHTML = `<b>On file.</b> Your signed page was photographed on ${new Date(rec.captured_at).toLocaleDateString('en-US', { dateStyle: 'long' })}.`
      + (rec.original_location ? `<br>The original is kept: ${escapeHtml(rec.original_location)}` : '<br>Please say where you are keeping the signed original.');
  }

  renderAttestations();
  updateSignButton();
}

function updateSignButton() {
  const btn = $('#signSave');
  const has = !!signBlob;
  const already = !!execution?.record;
  btn.disabled = !has && !already;
  btn.textContent = has
    ? 'Save the signed page'
    : already ? 'Update where the original is kept' : 'Photograph the page first';
}

$('#signPrint').onclick = () => {
  window.open(`${API}/api/print/memorandum`, '_blank');
  toast('Print it, then sign it with a pen.');
};

$('#signScan').onchange = async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  // A signature has to stay legible, so this is downscaled far less than an
  // item photograph would be.
  const dataUrl = await downscale(f, 2400);
  signBlob = await (await fetch(dataUrl)).blob();
  $('#signPreview').src = dataUrl;
  $('#signPreview').hidden = false;
  if (!$('#signDate').value) $('#signDate').value = new Date().toISOString().slice(0, 10);
  updateSignButton();
};

$('#signSave').onclick = async () => {
  const place = $('#signPlace').value.trim();
  const when = $('#signDate').value;
  const btn = $('#signSave');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    if (signBlob) {
      const q = `?signed_on=${encodeURIComponent(when)}&original_location=${encodeURIComponent(place)}`;
      const res = await fetch(`${API}/api/execution/scan${q}`, {
        method: 'POST', headers: { 'content-type': signBlob.type || 'image/jpeg' }, body: signBlob,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'The signed page could not be saved.');
      signBlob = null;
      toast('Your signed page is on file.');
    } else if (execution?.record) {
      await api(`/api/execution/${execution.record.media_id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ original_location: place, signed_on: when }),
      });
      toast('Saved.');
    }
    await loadExecution();
  } catch (err) {
    toast(err.message, true);
    updateSignButton();
  }
};

// ---- the spoken statement
let recorder = null;
let chunks = [];

$('#stmtRecord').onclick = async () => {
  const btn = $('#stmtRecord');
  if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return toast('This device will not let the app record sound.', true);
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove('listening');
      btn.textContent = 'Saving…';
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      try {
        const res = await fetch(`${API}/api/execution/${execution.record.media_id}/statement`, {
          method: 'POST', headers: { 'content-type': blob.type }, body: blob,
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'The recording could not be saved.');
        toast('Your statement is saved with the signed page.');
        await loadExecution();
      } catch (err) {
        toast(err.message, true);
        btn.textContent = 'Start recording';
      }
    };
    recorder.start();
    btn.classList.add('listening');
    btn.textContent = 'Recording — tap to stop';
  } catch {
    toast('The microphone could not be opened. Check the app is allowed to use it.', true);
  }
};

// ---- the professional's confirmation
$('#attestOpen').onclick = () => {
  const box = $('#attestFields');
  box.hidden = !box.hidden;
  $('#attestOpen').textContent = box.hidden ? 'Record a confirmation' : 'Never mind';
};

$('#attSave').onclick = async () => {
  if (!execution?.record) return toast('Photograph the signed page first.', true);
  const name = $('#attName').value.trim();
  if (!name) return toast('Please write their name.', true);
  try {
    await api(`/api/execution/${execution.record.media_id}/attest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name, role: $('#attRole').value, firm: $('#attFirm').value.trim(),
        email: $('#attEmail').value.trim(), holds: $('#attHolds').value,
      }),
    });
    ['#attName', '#attFirm', '#attEmail'].forEach((s) => { $(s).value = ''; });
    $('#attestFields').hidden = true;
    $('#attestOpen').textContent = 'Record a confirmation';
    toast('Confirmation recorded.');
    await loadExecution();
  } catch (err) { toast(err.message, true); }
};

const ROLE_WORDS = {
  trustee: 'Trustee', personal_representative: 'Trustee (also called personal representative)',
  executor: 'Trustee (also called executor)', attorney: 'Attorney', other: 'Confirmed by',
};
const HOLDS_WORDS = {
  holds_original: 'is holding the signed original',
  seen_original: 'has seen the signed original',
  copy_only: 'has received a copy only',
};

function renderAttestations() {
  const list = execution?.record?.attestations ?? [];
  const box = $('#attList');
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<b>Confirmed by:</b><ul>' + list.map((a) => {
    const when = new Date(a.confirmed_at).toLocaleDateString('en-US', { dateStyle: 'long' });
    const who = [escapeHtml(a.name), a.firm ? `of ${escapeHtml(a.firm)}` : ''].filter(Boolean).join(' ');
    return `<li>${escapeHtml(ROLE_WORDS[a.role] || 'Confirmed by')} ${who} — ${escapeHtml(HOLDS_WORDS[a.holds] || '')}, on ${when}</li>`;
  }).join('') + '</ul>';
}

/* ------------------------------------------------------------------- people

   The names an owner is leaving things to.

   This was the single largest source of friction in the app. A recipient was a
   free-text box on every item, so somebody recording eighty belongings typed
   "Kathy" eighty times, and every slip — "Kathy M", "kathy", "my daughter
   Kathy" — became a separate heir by the time the file reached Reindeer: Fair
   Choice. Now the name is said once and tapped thereafter.

   Two ways in, because people work differently. Some want to declare the cast
   before they start; others discover it as they walk the house. Both work, and
   a name typed on an item is quietly added to the roster so the two never
   drift apart. */

let people = [];

async function loadPeople() {
  try {
    const data = await api('/api/people');
    people = data.people ?? [];
    renderPeopleList();
    renderUnlisted(data.unlisted ?? []);
    updatePeopleTileHint();
  } catch { /* the roster is a convenience, never a blocker */ }
}

function updatePeopleTileHint() {
  const hint = $('#peopleTileHint');
  if (!hint) return;
  hint.textContent = people.length
    ? people.slice(0, 4).map((p) => p.name).join(', ') + (people.length > 4 ? `, and ${people.length - 4} more` : '')
    : 'The names you are leaving things to';
}

function renderPeopleList() {
  const box = $('#peopleList');
  if (!people.length) {
    box.innerHTML = '<p class="reassure" style="margin:0">Nobody on the list yet. Add the first person below, '
      + 'or just start recording items and type names as they come to you.</p>';
    return;
  }
  box.innerHTML = people.map((p) => `
    <div class="personrow" data-person="${escapeHtml(p.person_id)}">
      <div class="personwho">
        <span class="personname">${escapeHtml(p.name)}</span>
        ${p.relationship ? `<span class="personrel">${escapeHtml(p.relationship)}</span>` : ''}
      </div>
      <span class="personcount">${p.item_count ? `${p.item_count} item${p.item_count === 1 ? '' : 's'}` : 'nothing yet'}</span>
      <button class="personx" data-remove="${escapeHtml(p.person_id)}" aria-label="Remove ${escapeHtml(p.name)} from the list">Remove</button>
    </div>`).join('');

  $$('#peopleList [data-remove]').forEach((b) => {
    b.onclick = async () => {
      const person = people.find((p) => p.person_id === b.dataset.remove);
      // Irreversible-looking actions get asked about first, in plain words.
      if (!confirm(`Take ${person?.name ?? 'this person'} off your list?\n\nItems you have already recorded for them keep their name. Nothing you have written is deleted.`)) return;
      try {
        await api(`/api/people/${b.dataset.remove}`, { method: 'DELETE' });
        toast('Taken off the list. Your items are unchanged.');
        await loadPeople();
      } catch (e) { toast(e.message, true); }
    };
  });
}

function renderUnlisted(unlisted) {
  const box = $('#peopleUnlisted');
  if (!unlisted.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<b>You have already named these people on your items.</b> Add them to your list so you can tap them next time.`
    + `<div class="chips" style="margin-top:12px">${unlisted.map((u) => `<button class="chip" data-adopt="${escapeHtml(u.name)}" data-rel="${escapeHtml(u.relationship)}">${escapeHtml(u.name)} <span class="chipn">${u.item_count}</span></button>`).join('')}</div>`
    + `<button class="ghost wide" id="adoptAll" style="margin-top:12px">Add all ${unlisted.length} of them</button>`;

  $$('#peopleUnlisted [data-adopt]').forEach((b) => {
    b.onclick = async () => {
      await addPerson(b.dataset.adopt, b.dataset.rel, 'from_item');
    };
  });
  $('#adoptAll').onclick = async () => {
    try {
      const res = await api('/api/people/bulk', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ people: unlisted.map((u) => ({ name: u.name, relationship: u.relationship, source: 'from_item' })) }),
      });
      toast(`Added ${res.added.length} ${res.added.length === 1 ? 'person' : 'people'}.`);
      await loadPeople();
    } catch (e) { toast(e.message, true); }
  };
}

async function addPerson(name, relationship, source = 'typed') {
  const clean = (name ?? '').trim();
  if (!clean) { toast('Please write their name first.', true); return null; }
  try {
    const person = await api('/api/people', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: clean, relationship: (relationship ?? '').trim(), source }),
    });
    await loadPeople();
    return person;
  } catch (e) { toast(e.message, true); return null; }
}

// Common relationships as one-tap chips. Typing "granddaughter" correctly on a
// phone keyboard is exactly the kind of small defeat that makes somebody put
// the app down.
const REL_SUGGESTIONS = ['daughter', 'son', 'wife', 'husband', 'sister', 'brother',
  'granddaughter', 'grandson', 'niece', 'nephew', 'friend', 'charity'];

function mountPeopleScreen() {
  $('#relChips').innerHTML = REL_SUGGESTIONS
    .map((r) => `<button class="chip" data-rel="${r}" aria-pressed="false">${r}</button>`).join('');
  $$('#relChips .chip').forEach((b) => {
    b.onclick = () => {
      $$('#relChips .chip').forEach((o) => o.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      $('#personRel').value = b.dataset.rel;
    };
  });

  $('#personAdd').onclick = async () => {
    const person = await addPerson($('#personName').value, $('#personRel').value);
    if (!person) return;
    toast(person.created === false ? `${person.name} was already on your list.` : `${person.name} added.`);
    $('#personName').value = ''; $('#personRel').value = '';
    $$('#relChips .chip').forEach((o) => o.setAttribute('aria-pressed', 'false'));
    $('#personName').focus();
  };

  // Enter on the name field should add, not reload the page.
  $('#personName').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#personAdd').click(); } };
  $('#personRel').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#personAdd').click(); } };
}

/* ---- the "who is it for?" step of the capture flow ---- */

function renderPersonChips() {
  const box = $('#personChips');
  if (!box) return;
  if (!people.length) { box.innerHTML = ''; return; }
  const chosen = (cap.recipient ?? '').trim().toLowerCase();
  box.innerHTML = people.map((p) => `<button class="chip" data-pick="${escapeHtml(p.name)}" data-rel="${escapeHtml(p.relationship)}" aria-pressed="${p.name.toLowerCase() === chosen}">${escapeHtml(p.name)}${p.relationship ? ` <span class="chiprel">${escapeHtml(p.relationship)}</span>` : ''}</button>`).join('')
    + '<button class="chip" data-pick="" aria-pressed="false">Somebody else</button>';

  $$('#personChips .chip').forEach((b) => {
    b.onclick = () => {
      const name = b.dataset.pick;
      $('#capRecipient').value = name;
      $('#capRelationship').value = name ? (b.dataset.rel || '') : '';
      $$('#personChips .chip').forEach((o) => o.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      if (!name) $('#capRecipient').focus();
      checkNewPerson();
    };
  });
  checkNewPerson();
}

/*
 * When a name is typed that is not on the roster yet, say so before the item
 * is saved rather than silently creating a near-duplicate heir. The name is
 * still accepted either way — this is a nudge, never a gate.
 */
function checkNewPerson() {
  const note = $('#newPersonNote');
  if (!note) return;
  const typed = $('#capRecipient').value.trim();
  // Keep the highlighted chip honest: if the box no longer says what the chip
  // says, nothing should look selected.
  $$('#personChips .chip').forEach((c) => {
    c.setAttribute('aria-pressed', String(!!c.dataset.pick && c.dataset.pick.toLowerCase() === typed.toLowerCase()));
  });
  const known = people.some((p) => p.name.toLowerCase() === typed.toLowerCase());
  if (!typed || known) { note.hidden = true; return; }
  const near = people.find((p) => p.name.toLowerCase().startsWith(typed.toLowerCase().slice(0, 3)) && typed.length >= 3);
  note.hidden = false;
  note.innerHTML = near
    ? `<b>${escapeHtml(typed)}</b> is new. Did you mean <b>${escapeHtml(near.name)}</b>? Two spellings of one person become two different people on the printed list.`
    : `<b>${escapeHtml(typed)}</b> is not on your list yet. They will be added to it when you save this item.`;
}

async function refreshCount() {
  const { items } = await api('/api/items');
  $('#countPill').textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------- what you already know
 *
 * The promise lane.
 *
 * Everything here exists to get one sentence out of the owner — "the clock goes
 * to Robert" — before the app has asked them for anything else. That sentence is
 * the whole product. A room is only a way of finding more of them.
 *
 * What this lane deliberately does NOT do: no streak, no countdown, no "most
 * people have finished by now", nothing withheld until a quota is met, and never
 * a suggested recipient. Pressure applied by an app to an elderly person is
 * attackable afterwards as undue influence, and any pressure that pushes toward
 * naming a person rather than toward writing things down would poison the very
 * document it was trying to produce. The only push here is the true one: what
 * happens to the things nobody is named for.
 */

let promiseMode = false;
let promiseKept = 0;

function renderPromise() {
  const first = promiseKept === 0;
  $('#promiseAsk').textContent = first
    ? 'Is there anything you already know should go to someone in particular?'
    : 'Anything else you already know?';
  $('#promiseWhy').textContent = first
    ? "A ring for your daughter. Your father's watch for your son. If a name comes to "
      + 'mind, start there. One photograph, one name, and it is written down.'
    : 'People usually remember two or three more once they start. Take them one at a time.';
  $('#promiseYes').textContent = first ? 'Yes — let me name one' : 'Yes — one more';
  $('#promiseNo').textContent = first ? 'Nothing comes to mind' : "That's everything I know";

  const tally = $('#promiseTally');
  tally.hidden = promiseKept === 0;
  if (promiseKept > 0) {
    tally.innerHTML = `<p><strong>${promiseKept === 1 ? 'One thing' : `${promiseKept} things`}</strong> `
      + 'now says who it is for. That is written down and it will print.</p>';
  }

  $('#promisePivot').hidden = true;
  $('#promiseYes').hidden = false;
  $('#promiseNo').hidden = false;
}

$('#promiseYes').onclick = () => {
  promiseMode = true;
  resetCapture();
  go('capture');
};

$('#promiseNo').onclick = async () => {
  $('#promiseYes').hidden = true;
  $('#promiseNo').hidden = true;
  $('#promisePivot').hidden = false;
  $('#promisePivotRest').textContent = await pivotSentence();
  $('#promisePivot').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

$('#promiseOnward').onclick = () => { promiseMode = false; promiseKept = 0; go('home'); };

/**
 * The consequence, said in the owner's own family's names where they are known.
 *
 * "Some items are unassigned" is a status. "Robert, Elena and Katherine will
 * decide it between them" is a picture, and a picture is what makes somebody
 * pick the phone back up. It is also simply true, which is why it is allowed.
 */
async function pivotSentence() {
  const generic = 'Everything else in the house, your family will have to work out between '
    + 'themselves. Writing those down is what stops that becoming an argument.';
  try {
    const { people = [] } = await api('/api/people');
    const names = people.filter((p) => !p.archived).map((p) => p.name).filter(Boolean);
    if (names.length < 2) return generic;
    // Three names is a picture. Six is a list, and a list reads as paperwork.
    const list = names.length === 2
      ? `${names[0]} and ${names[1]}`
      : names.length <= 3
        ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
        : `${names.slice(0, 3).join(', ')} and the others`;
    return `Everything else in the house, ${list} will have to work out between themselves. `
      + 'Writing those down is what stops that becoming an argument.';
  } catch { return generic; }
}

/**
 * Two counts on the menu, refreshed whenever the owner lands there.
 *
 * Never combined into a percentage — see the note in the markup.
 */
async function renderCounters() {
  let items = [];
  try { ({ items } = await api('/api/items')); } catch { return; }
  const box = $('#homeCounters');
  if (!items.length) { box.hidden = true; return; }

  const spoken = items.filter((i) => i.recipient_hint?.recipient_name).length;
  const open = items.length - spoken;
  box.hidden = false;
  $('#cntSpoken').textContent = String(spoken);
  $('#cntOpen').textContent = String(open);

  const note = $('#counterNote');
  if (open > 0) {
    note.hidden = false;
    // This line used to point at one of the owner's own possessions and say that
    // nobody was named for it. That is pressure to assign an heir to a specific
    // thing, which is not the app's business: an unnamed item is a finished,
    // correct record, and dividing those is exactly what FairPlay is for.
    // Persuasion here is only ever about getting the list DONE, never about who
    // gets what.
    note.textContent = open === 1
      ? 'One thing is written down with nobody named. That is perfectly normal — '
        + 'Reindeer: FairPlay can help your family divide anything left open.'
      : `${open} things are written down with nobody named. That is perfectly normal — `
        + 'Reindeer: FairPlay can help your family divide anything left open.';
  } else {
    note.hidden = true;
  }
}

/*
 * The kinds of thing on the capture screen.
 *
 * Shown, in order: the categories Registry seeds today, then anything the owner
 * has invented or pulled out of the dropdown. An inventory made before the
 * seeded list changed still holds its old names, and every item using one keeps
 * working — but those names are left off the buttons, because the point of a
 * short list is that it is short. They remain reachable in the item's own
 * screen and in every printout.
 */
function renderCatChips() {
  const starter = registry.starter_categories ?? [];
  const rank = new Map(starter.map((n, i) => [n.toLowerCase(), i]));
  const byName = new Map(registry.categories.map((c) => [c.name.toLowerCase(), c]));

  // Today's list first, in the order it is defined rather than by sort_order,
  // so the run of contested kinds reads top to bottom as intended.
  const seeded = starter.map((n) => byName.get(n.toLowerCase())).filter(Boolean);
  // Then the owner's own, and anything promoted out of the silent list.
  const theirs = registry.categories.filter((c) => !rank.has(c.name.toLowerCase())
    && (c.is_custom === 1 || c.sort_order === 500));

  const chip = (c) => `<button class="chip${c.is_custom ? ' chip-mine' : ''}" aria-pressed="false"`
    + ` data-cat="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>`;
  $('#catChips').innerHTML = [...seeded, ...theirs].map(chip).join('');

  $$('#catChips .chip').forEach((b) => {
    b.onclick = () => {
      $$('#catChips .chip').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      cap.category = b.dataset.cat;
    };
  });

  renderCatMore();
}

/*
 * The precise categories, kept silent until asked for.
 *
 * Every name here is a Reindeer: FairPlay category spelled exactly, so an
 * owner who would rather say "Coins & Stamps" than accept a coarse bucket can,
 * and that choice is treated as final downstream. It stays in a dropdown
 * because demanding that level of precision from everyone is how a person
 * stops recording their possessions altogether.
 */
function renderCatMore() {
  const wrap = $('#catMoreWrap');
  const sel = $('#catMore');
  if (!wrap || !sel) return;
  const left = registry.more_categories ?? [];
  wrap.hidden = left.length === 0;
  sel.innerHTML = '<option value="">Add another kind…</option>'
    + left.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  sel.onchange = () => {
    const name = sel.value;
    sel.value = '';
    if (name) addOfferedCategory(name);
  };
}

/** Promote a category from the dropdown to a button, and select it. */
async function addOfferedCategory(name) {
  try {
    const cat = await api('/api/categories', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, is_custom: false }),
    });
    registry.categories.push(cat);
    registry.more_categories = (registry.more_categories ?? [])
      .filter((n) => n.toLowerCase() !== cat.name.toLowerCase());
    renderCatChips();
    const made = $$('#catChips .chip').find((c) => c.dataset.cat === cat.name);
    if (made) made.setAttribute('aria-pressed', 'true');
    cap.category = cat.name;
    toast(`“${cat.name}” added to your list.`);
  } catch {
    // Offline. The name rides along with the item and the server creates the
    // category when it arrives, so nothing is lost by carrying on.
    cap.category = name;
  }
}

/*
 * Every room the owner has, not a curated handful.
 *
 * This used to filter the room list against a hardcoded set of seven "common"
 * names, which meant a room the owner added themselves — "Mother's Sewing
 * Room", "The Cabin" — was saved to the database correctly and then never shown
 * again. The owner had to retype it every single time, and reasonably concluded
 * the app had thrown it away. Their own room names are the ones they care most
 * about, so they are shown first and marked as theirs.
 */
function renderRoomChips() {
  const mine = registry.rooms.filter((r) => r.is_custom);
  const standard = registry.rooms.filter((r) => !r.is_custom && r.name !== 'Other');
  const other = registry.rooms.find((r) => r.name === 'Other');
  const chip = (r) => `<button class="chip${r.is_custom ? ' chip-mine' : ''}" aria-pressed="false"`
    + ` data-room="${escapeHtml(r.name)}">${escapeHtml(r.name)}</button>`;
  // "Somewhere else" always sits last: it is the escape hatch, not an option.
  $('#roomChips').innerHTML = [...mine, ...standard].map(chip).join('')
    + (other ? `<button class="chip chip-other" aria-pressed="false" data-room="Other">Somewhere else…</button>` : '');

  $$('#roomChips .chip').forEach((b) => {
    b.onclick = () => {
      $$('#roomChips .chip').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      cap.room = b.dataset.room;
      $('#capRoomOther').hidden = b.dataset.room !== 'Other';
      if (b.dataset.room === 'Other') $('#capRoomOther').focus();
    };
  });

  renderRoomMore();
}

/*
 * The rooms the owner does not have yet, kept out of the way.
 *
 * Registry seeds only the rooms nearly every home has. The rest live in this
 * dropdown so the buttons above stay a short, scannable list rather than a
 * wall of thirty. Choosing one promotes it to a permanent button, so the list
 * grows to match the house as the owner walks it, and never gets ahead of them.
 *
 * The whole control hides once every offered room has been taken, because a
 * dropdown holding nothing is a thing to read and be puzzled by.
 */
function renderRoomMore() {
  const wrap = $('#roomMoreWrap');
  const sel = $('#roomMore');
  if (!wrap || !sel) return;
  const left = registry.more_rooms ?? [];
  wrap.hidden = left.length === 0;
  sel.innerHTML = '<option value="">Add another room…</option>'
    + left.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  sel.onchange = () => {
    const name = sel.value;
    sel.value = '';
    if (name) addOfferedRoom(name);
  };
}

/*
 * Promote a room from the dropdown to a button, and select it.
 *
 * Selecting it matters: the owner opened that list because they are standing in
 * the attic, so making them find and press the new button afterwards is a step
 * that earns nothing.
 */
async function addOfferedRoom(name) {
  try {
    const room = await api('/api/rooms', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, is_custom: false }),
    });
    registry.rooms.push(room);
    registry.more_rooms = (registry.more_rooms ?? []).filter((n) => n.toLowerCase() !== room.name.toLowerCase());
    renderRoomChips();
    const made = $$('#roomChips .chip').find((c) => c.dataset.room === room.name);
    if (made) made.setAttribute('aria-pressed', 'true');
    $('#capRoomOther').hidden = true;
    cap.room = room.name;
    toast(`“${room.name}” added to your rooms.`);
  } catch {
    // Offline. The name still rides along with the item and the server creates
    // the room when it arrives, so nothing is lost by carrying on.
    cap.room = name;
  }
}

/*
 * A room typed by hand becomes a permanent choice.
 *
 * Registering it the moment they finish typing — rather than waiting for the
 * item to save — means it is already a chip if they add a second thing from the
 * same room, which is the common case when someone is standing in that room.
 */
async function rememberTypedRoom(name) {
  const clean = (name ?? '').trim();
  if (!clean || clean.toLowerCase() === 'other') return;
  if (registry.rooms.some((r) => r.name.toLowerCase() === clean.toLowerCase())) return;
  try {
    const room = await api('/api/rooms', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: clean }),
    });
    registry.rooms.push(room);
    renderRoomChips();
    // Keep the chip they just created selected, so nothing appears to reset.
    const made = $$('#roomChips .chip').find((c) => c.dataset.room === room.name);
    if (made) { made.setAttribute('aria-pressed', 'true'); $('#capRoomOther').hidden = true; }
    cap.room = room.name;
    toast(`“${room.name}” added to your rooms.`);
  } catch {
    // Offline, most likely. The name still rides along with the item and the
    // server will create the room when the item reaches it.
    cap.room = clean;
  }
}

// ------------------------------------------------------------------- boot
(async function boot() {
  registry = await api('/api/registry');
  renderRoomChips();
  renderCatChips();
  $('#filterRoom').innerHTML = '<option value="">All rooms</option>' +
    registry.rooms.map((r) => `<option value="${r.room_id}">${escapeHtml(r.name)}</option>`).join('');

  // The print and download links live in the markup as plain paths so they
  // stay readable; point them at the server wherever it happens to be.
  $$('[data-api-href]').forEach((a) => { a.href = API + a.dataset.apiHref; });

  mountPeopleScreen();
  $('#capRecipient').addEventListener('input', checkNewPerson);
  await loadPeople();

  resetCapture();

  /*
   * Where to land.
   *
   * Someone opening this for the first time has no idea why they should
   * bother, and a grid of buttons does not tell them. So a first-time visitor
   * gets the reason before the menu. Once there is anything in the list they
   * have clearly understood, and being lectured on every launch would be
   * patronising — they go straight to the menu, with the explanation still
   * one tap away.
   *
   * This is decided from the item count on the server rather than from
   * browser storage, so it survives a new phone, a cleared browser, or the
   * app being opened by a helping relative on their own device.
   */
  const { items } = await api('/api/items');
  $('#countPill').textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
  go(items.length === 0 ? 'welcome' : 'home');
})();

/* =====================================================================
 * WALKING THE HOUSE, ROOM BY ROOM
 *
 * The app's centre of gravity. Everything here follows three findings from
 * watching the old flow fail:
 *
 * 1. The unit of work is the room, not the object. "Do the dining room" is a
 *    task someone can start and finish; "catalogue your possessions" is not.
 *
 * 2. Recording and naming must come apart. A recording is documentation the
 *    instant it is taken. Naming what is in it needs a model, a network and a
 *    decision from the owner, and demanding all three before anything is saved
 *    is why a walkthrough could appear to add nothing at all.
 *
 * 3. Stopping must be free. This gets done over days, in a house, by someone who
 *    will be interrupted. Pausing is a first-class action, and coming back must
 *    never require remembering where you were.
 * ===================================================================== */

let walk = null;        // last known state of the whole walk
let room = null;        // { room_id, name } currently open
let roomPending = [];   // captures taken in this room this sitting

/* ------------------------------------------------------------ offline store
 *
 * The implementation lives in offline-queue.js so the preview build can swap it
 * for a stub — see the comment at the top of that file. Everything below is a
 * thin delegation, and every caller must cope with the queue being unavailable.
 */
function offlineQueue() {
  return (
    window.ReindeerOfflineQueue ?? {
      available: async () => false,
      add: async () => {
        throw new Error('no-idb');
      },
      all: async () => [],
      remove: async () => {},
    }
  );
}

const queueAdd = (record) => offlineQueue().add(record);
const queueAll = () => offlineQueue().all();
const queueRemove = (id) => offlineQueue().remove(id);
const queueAvailable = () => offlineQueue().available();

/** Is the server actually reachable, rather than merely "navigator says online"? */
async function serverReachable() {
  if (navigator.onLine === false) return false;
  try {
    const res = await fetch(`${API}/api/registry`, { method: 'GET', cache: 'no-store' });
    return res.ok;
  } catch { return false; }
}

/* ---------------------------------------------------------------- the walk */

async function loadWalk() {
  try {
    walk = await api('/api/walkthrough');
  } catch {
    // Offline: still show the rooms, from whatever the last load knew.
    walk = walk ?? { rooms: registry.rooms.map((r) => ({ ...r, walkthrough_state: 'not_started', item_count: 0 })),
      counts: { total: registry.rooms.length, done: 0, skipped: 0, in_progress: 0, not_started: registry.rooms.length, settled: 0 },
      next_room: registry.rooms[0] ? { room_id: registry.rooms[0].room_id, name: registry.rooms[0].name } : null,
      is_complete: false, unfinished: [] };
  }
  renderWalk();
}

const ROOM_STATUS = {
  done: { word: 'Finished', cls: 'st-done', mark: '✓' },
  skipped: { word: 'Nothing to record', cls: 'st-skip', mark: '—' },
  started: { word: 'Part way through', cls: 'st-part', mark: '…' },
  not_started: { word: 'Not started', cls: 'st-none', mark: '' },
};

function renderWalk() {
  const c = walk.counts;
  $('#walkProgress').hidden = c.total === 0;
  const pct = c.total ? Math.round((c.settled / c.total) * 100) : 0;
  $('#walkBarFill').style.width = `${pct}%`;
  $('#walkCount').textContent = c.settled === 0
    ? `${c.total} rooms on your list.`
    : `${c.settled} of ${c.total} rooms finished.`;

  $('#walkRooms').innerHTML = walk.rooms.map((r) => {
    const st = ROOM_STATUS[r.walkthrough_state] ?? ROOM_STATUS.not_started;
    const bits = [];
    if (r.item_count) bits.push(`${r.item_count} thing${r.item_count === 1 ? '' : 's'} named`);
    if (r.documented_at && !r.item_count) bits.push('recorded');
    return `<button class="roomrow ${st.cls}" data-room-id="${r.room_id}" data-room-name="${escapeHtml(r.name)}">
        <span class="roomrow-mark" aria-hidden="true">${st.mark}</span>
        <span class="roomrow-body">
          <span class="roomrow-name">${escapeHtml(r.name)}</span>
          <span class="roomrow-state">${st.word}${bits.length ? ` · ${bits.join(' · ')}` : ''}</span>
        </span>
      </button>`;
  }).join('');
  $$('#walkRooms .roomrow').forEach((b) => {
    b.onclick = () => openRoom(b.dataset.roomId, b.dataset.roomName);
  });

  const next = walk.next_room;
  $('#walkNext').hidden = !next || walk.is_complete;
  if (next) {
    $('#walkNextBtn').textContent = `Start the ${next.name}`;
    $('#walkNextBtn').onclick = () => openRoom(next.room_id, next.name);
  }
  $('#walkDone').hidden = !walk.is_complete;
}

/* --------------------------------------------------------- inside one room */

async function openRoom(roomId, name) {
  room = { room_id: roomId, name };
  roomPending = [];
  go('room');
  $('#roomTitle').textContent = name;
  renderRoomState();
  // Opening a room is itself progress worth remembering, so a pause right after
  // this still brings them back to the right place.
  try {
    const res = await api(`/api/rooms/${roomId}/state`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'started' }),
    });
    walk = res.walkthrough;
  } catch { /* offline: the room is open locally regardless */ }
}

function renderRoomState() {
  const known = walk?.rooms?.find((r) => r.room_id === room.room_id);
  const named = known?.item_count ?? 0;
  const recorded = !!known?.documented_at || roomPending.length > 0;
  const parts = [];
  if (recorded) parts.push('This room has been recorded.');
  if (named) parts.push(`${named} thing${named === 1 ? '' : 's'} named here.`);
  $('#roomStats').innerHTML = parts.length
    ? `<p class="roomstat-ok">${parts.join(' ')}</p>`
    : '<p class="roomstat-todo">Nothing recorded in here yet.</p>';

  $('#roomCaptured').hidden = roomPending.length === 0;
  $('#roomCaptured').innerHTML = roomPending.map((p) => `
    <div class="capt">
      <p class="capt-line">${p.saved ? '✓ Saved' : '⏳ Held on this device'} — ${escapeHtml(p.label)}</p>
      ${p.frames?.length ? `<button class="ghost wide" data-name-these="${p.key}">Write down what is in it${p.frames.length ? ` (${p.frames.length} pictures)` : ''}</button>` : ''}
      ${p.saved ? '' : '<p class="capt-note">It will be sent when you next have internet.</p>'}
    </div>`).join('');
  $$('#roomCaptured [data-name-these]').forEach((b) => {
    b.onclick = () => offerNaming(b.dataset.nameThese);
  });
}

/* --------------------------------------------- record first, name afterwards */

/**
 * Take the recording in. Documenting comes first and never depends on the model
 * or the network; naming is offered afterwards and may be declined or deferred
 * indefinitely without anything being lost.
 */
async function captureRoomMedia(file, kind) {
  const key = `c${Date.now()}`;
  const label = kind === 'video' ? 'Video walkthrough' : `${file.length ?? 1} photo(s)`;
  const entry = { key, label, saved: false, frames: [], kind };
  roomPending.push(entry);
  renderRoomState();
  toast('Keeping the recording…');

  // Pull stills out of a video so a later naming pass has something to look at
  // without needing the whole file again. Failure here is not fatal: the
  // recording itself is the record, and the frames are only a convenience.
  if (kind === 'video') {
    try {
      const { frames } = await framesFromVideo(file, MAX_FRAMES);
      entry.frames = frames;
    } catch { entry.frames = []; }
  }

  const online = await serverReachable();
  if (online) {
    try {
      await fetch(`${API}/api/scope-media?title=${encodeURIComponent(`${room.name} — walkthrough`)}`
        + `&room=${encodeURIComponent(room.name)}`, {
        method: 'POST', headers: { 'content-type': file.type || 'video/mp4' }, body: file,
      });
      entry.saved = true;
      await api(`/api/rooms/${room.room_id}/state`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'started', documented: true }),
      }).then((r) => { walk = r.walkthrough; }).catch(() => {});
      toast('Recorded and saved.');
    } catch {
      entry.saved = false;
    }
  }

  if (!entry.saved) {
    try {
      await queueAdd({ room_id: room.room_id, room_name: room.name, kind, blob: file, type: file.type || '' });
      toast('Saved on this phone. It will be sent when you have internet.');
    } catch {
      toast('This device could not hold the recording. Please try again with internet.', true);
      roomPending = roomPending.filter((p) => p.key !== key);
    }
  }
  renderRoomState();
  await refreshQueueBadge();
}

/**
 * The optional naming pass.
 *
 * Never automatic. The owner asked for the room to be documented and that is
 * done; putting names to things is a separate offer, and it says plainly when
 * the guesses are not coming from a real model so nothing invented is mistaken
 * for a finding.
 */
async function offerNaming(key) {
  const entry = roomPending.find((p) => p.key === key);
  if (!entry?.frames?.length) return;
  if (!(await serverReachable())) {
    toast('Naming needs internet. The recording is safe until then.', true);
    return;
  }
  toast('Looking through the recording…');
  inRoomNaming = true;
  roomDupCount = 0;
  try {
    const { detections, vision_mode } = await api('/api/intake/detect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        images: entry.frames.map((dataUrl, i) => ({ data_url: dataUrl, frame_index: i, media_id: `${key}-${i}` })),
        room_hint: room.name,
      }),
    });
    batchFiles = entry.frames.map((dataUrl, i) => ({ _dataUrl: dataUrl, _frame: i }));
    showNamingResults(detections, vision_mode);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * What happens after a room has been read.
 *
 * The owner is not asked to approve the camera's work item by item. The purpose
 * of this registry is to document that things EXIST, so a lower standard of
 * precision is the right one here: everything found goes straight onto the list,
 * confirmed, and a wrong entry costs nothing because the scrutiny happens later
 * in Reindeer: FairPlay, where it matters and where the tools for it live.
 *
 * Then exactly one question is asked, about the room and never about an item.
 * "No" is a complete answer that is never asked again. The app does not point at
 * a possession and ask who should have it — naming an heir is always the owner
 * reaching for it, never the app requesting it.
 */
async function showNamingResults(detections, mode) {
  go('batch');
  const intake = $('#batchIntake');
  if (intake) intake.hidden = true;
  const warn = mode === 'mock'
    ? `<div class="mockwarn"><p><strong>These are examples, not real findings.</strong>
         The picture-reading service is not switched on yet, so the names below were
         made up by the app rather than read from your recording.</p></div>`
    : '';
  const n = detections.length;
  if (!n) {
    $('#batchResults').innerHTML = `${warn}
      <h2>Nothing was recognised in that recording</h2>
      <p class="reassure">The recording itself is saved with your inventory either way.
        A shorter walk through one room, pausing on each thing, usually reads better.</p>
      <button class="ghost wide" id="namingBack">Back to the room</button>`;
    $('#namingBack').onclick = () => leaveNaming();
    return;
  }

  $('#batchResults').innerHTML = `${warn}
    <h2>Writing down ${n} thing${n === 1 ? '' : 's'}…</h2>
    <p class="reassure">There is nothing for you to check. They are going on your list as they are.</p>`;

  let added = [];
  try {
    added = await commitEverything(detections);
  } catch (e) {
    $('#batchResults').innerHTML = `${warn}
      <h2>Those could not be saved</h2>
      <p class="reassure">${escapeHtml(e.message)} The recording is still safe.</p>
      <button class="ghost wide" id="namingBack">Back to the room</button>`;
    $('#namingBack').onclick = () => leaveNaming();
    return;
  }
  renderRoomGiftAsk(added);
}

/**
 * Save every detection, confirmed, in one request.
 *
 * The room is passed as room_hint because that is the field the commit route
 * reads; sending 'room' left a whole walkthrough's items filed under no room at
 * all. Items land confirmed rather than as drafts, so nothing on the list ever
 * wears a mark implying the owner still owes it a decision.
 */
async function commitEverything(detections) {
  const payload = [];
  for (const d of detections) {
    const src = batchFiles[d.frame_index ?? 0];
    const crop = src ? await cropTo(src._dataUrl, d.bbox) : null;
    payload.push({ ...d, crop_data_url: crop, room_hint: room?.name ?? d.room_hint ?? d.room ?? null });
  }
  const { created, possible_duplicates } = await api('/api/intake/commit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ detections: payload }),
  });
  // Mentioned once on the way out, as information. Never a task.
  if (possible_duplicates > 0) roomDupCount += possible_duplicates;
  await Promise.all(created.map((id) => api(`/api/items/${id}/keep`, { method: 'POST' }).catch(() => {})));
  refreshCount();
  return created.map((id, i) => ({
    item_id: id,
    label: detections[i]?.label ?? 'Item',
    thumb: payload[i]?.crop_data_url || batchFiles[detections[i]?.frame_index ?? 0]?._dataUrl || '',
  }));
}

/** The one question. Asked about the room, once, and never repeated. */
function renderRoomGiftAsk(added, again = false) {
  const n = added.length;
  $('#batchResults').innerHTML = `
    ${again ? '' : `<h2>${n} thing${n === 1 ? '' : 's'} in the ${escapeHtml(room?.name ?? 'room')}
      ${n === 1 ? 'is' : 'are'} on your list</h2>
    <p class="reassure">That part is done. They are written down and they will print.</p>`}
    <div class="ask">
      <p class="askq">${again
        ? 'Anything else in here meant for someone in particular?'
        : 'Did you see anything in here that is meant for someone in particular?'}</p>
      <button class="primary wide" id="giftYes">Yes — let me point ${again ? 'more' : 'them'} out</button>
      <button class="ghost wide" id="giftNo">${again ? 'No — that is everything' : 'No — on to the next room'}</button>
    </div>`;
  $('#giftNo').onclick = () => leaveNaming();
  $('#giftYes').onclick = () => renderGiftPicker(added);
}

/**
 * Point at several things, then say one name.
 *
 * More than one item at a time on purpose: a set of dining chairs, a pair of
 * lamps, or three pieces of one grandmother's china are one decision to the
 * owner and should not cost three passes through a form.
 */
function renderGiftPicker(added) {
  const picked = new Set();
  $('#batchResults').innerHTML = `
    <h2>Which ones?</h2>
    <p class="reassure">Tap as many as you like. They can all go to the same person.</p>
    <div class="picks">
      ${added.map((a) => `
        <button class="pick" data-pick-id="${a.item_id}" aria-pressed="false">
          ${a.thumb ? `<img src="${a.thumb}" alt="">` : '<span class="noimg">no picture</span>'}
          <span class="picklbl">${escapeHtml(a.label)}</span>
        </button>`).join('')}
    </div>
    <div id="giftWhoBox" hidden>
      <h3>Who are they for?</h3>
      <div class="chips" id="giftChips"></div>
      <input type="text" id="giftName" class="bigin" placeholder="A name">
      <input type="text" id="giftRel" class="bigin" placeholder="Relationship, for example: daughter">
      <button class="primary wide" id="giftSave">Save this</button>
      <p class="reassure">This is a wish, not a legal instruction. You can change it any time.</p>
    </div>
    <button class="ghost wide" id="giftCancel">Never mind</button>`;

  const box = $('#giftWhoBox');
  $$('.picks .pick').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.pickId;
      const on = b.getAttribute('aria-pressed') === 'true';
      b.setAttribute('aria-pressed', on ? 'false' : 'true');
      if (on) picked.delete(id); else picked.add(id);
      box.hidden = picked.size === 0;
      $('#giftSave').textContent = picked.size > 1 ? `Save these ${picked.size}` : 'Save this';
    };
  });

  // The roster, so the second and third gift are one tap each.
  const chips = $('#giftChips');
  chips.innerHTML = people.filter((p) => !p.archived).map((p) =>
    `<button class="chip" data-gift-pick="${escapeHtml(p.name)}" data-rel="${escapeHtml(p.relationship ?? '')}" aria-pressed="false">${escapeHtml(p.name)}${p.relationship ? ` <span class="chiprel">${escapeHtml(p.relationship)}</span>` : ''}</button>`).join('');
  $$('#giftChips .chip').forEach((c) => {
    c.onclick = () => {
      $$('#giftChips .chip').forEach((o) => o.setAttribute('aria-pressed', 'false'));
      c.setAttribute('aria-pressed', 'true');
      $('#giftName').value = c.dataset.giftPick;
      $('#giftRel').value = c.dataset.rel || '';
    };
  });

  $('#giftCancel').onclick = () => renderRoomGiftAsk(added, true);
  $('#giftSave').onclick = async () => {
    const name = $('#giftName').value.trim();
    if (!name) return toast('Please put in a name, or press Never mind.', true);
    const rel = $('#giftRel').value.trim();
    $('#giftSave').disabled = true;
    const ids = [...picked];
    try {
      for (const id of ids) {
        await api(`/api/items/${id}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ recipient_hint: { recipient_name: name, relationship: rel, owner_note: '' } }),
        });
      }
      try { await addPerson(name, rel, 'from_item'); } catch { /* not worth stopping for */ }
      toast(`${ids.length === 1 ? 'That one is' : `Those ${ids.length} are`} for ${name}.`);
      const left = added.filter((a) => !picked.has(a.item_id));
      if (!left.length) return leaveNaming();
      renderRoomGiftAsk(left, true);
    } catch (e) {
      $('#giftSave').disabled = false;
      toast(e.message, true);
    }
  };
}

/**
 * Coming back out of the naming pass. This is where the duplicate tally is
 * finally spoken, once, and only as information — never as a task.
 */
async function leaveNaming() {
  inRoomNaming = false;
  go('room');
  // Re-read the walk so the room's own tally reflects what was just kept,
  // rather than the count from before the naming pass.
  try { walk = await api('/api/walkthrough'); } catch { /* keep what we have */ }
  renderRoomState();
  if (roomDupCount > 0) {
    const n = roomDupCount;
    roomDupCount = 0;
    toast(`Saved. ${n === 1 ? 'One thing' : `${n} things`} may already be on your list — `
      + 'you can check that any time under My items, or leave it.');
  }
}

/* ------------------------------------------------------- finishing a room */

async function setRoomFinished(state) {
  inRoomNaming = false;
  const word = state === 'skipped' ? 'Nothing to record here' : 'Finished';
  try {
    const res = await api(`/api/rooms/${room.room_id}/state`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    walk = res.walkthrough;
    toast(`${room.name}: ${word.toLowerCase()}.`);
  } catch {
    toast('Saved on this device. It will catch up when you have internet.');
  }
  // Straight to the next room, because that is almost always what they want.
  go('walk');
  renderWalk();
  if (walk.is_complete) return;
  const next = walk.next_room;
  if (next) toast(`Next: the ${next.name}. Or stop here — it will keep.`);
}

/* ---------------------------------------------------------------- pausing */

/**
 * Stopping is a real choice, so it gets a real answer: what is done, what is
 * left, and an explicit promise that nothing needs finishing today.
 */
function pauseWalk() {
  const left = walk?.unfinished?.length ?? 0;
  go('home');
  renderResume();
  toast(left
    ? `Stopped. ${left} room${left === 1 ? '' : 's'} still to do, waiting for you.`
    : 'Stopped. Everything is saved.');
}

async function renderResume() {
  // On a cold start nothing has been loaded yet, and this panel is the first
  // thing a returning owner should see — so fetch it here rather than making
  // them find the room list to be reminded where they were.
  if (!walk) {
    try { walk = await api('/api/walkthrough'); } catch { $('#resumePanel').hidden = true; return; }
  }
  const c = walk?.counts;
  if (!c || c.total === 0 || c.settled === 0 || walk.is_complete) {
    $('#resumePanel').hidden = true;
    return;
  }
  $('#resumePanel').hidden = false;
  const next = walk.next_room;

  // Say honestly whether the next room was already begun or has not been opened
  // yet. "You were up to the Living Room" told a room that was never started the
  // same story as one left half-done, and an owner who cannot remember which is
  // which is precisely the person this app is for.
  const nextRow = next ? walk.unfinished.find((r) => r.room_id === next.room_id) : null;
  const alreadyBegun = nextRow?.state === 'started';
  $('#resumeLine').textContent =
    `You have finished ${c.settled} of ${c.total} rooms.` +
    (next
      ? alreadyBegun
        ? ` You were part-way through the ${next.name}.`
        : ` The ${next.name} is next.`
      : '');
  $('#resumeBtn').textContent = next ? `Carry on with the ${next.name}` : 'Carry on';
  $('#resumeBtn').onclick = () => (next ? openRoom(next.room_id, next.name) : go('walk'));

  // The room they are about to walk into does not belong in the list of rooms
  // still waiting. Naming it in both places read as a contradiction: told they
  // were in the Living Room, then told the Living Room was still to do.
  const later = walk.unfinished.filter((r) => r.room_id !== next?.room_id);
  const rest = later.slice(0, 6).map((r) => r.name);
  $('#resumeRest').textContent = later.length
    ? `After that: ${rest.join(', ')}${later.length > rest.length ? `, and ${later.length - rest.length} more` : ''}.`
    : next
      ? 'That is the last room.'
      : '';
}

/* ------------------------------------------------------- the upload queue */

async function refreshQueueBadge() {
  const pending = await queueAll();
  const el = $('#queueBadge');
  if (!el) return;

  // If this device cannot hold anything back, say so before a room is recorded
  // rather than after. Finding out at the end of a walk through the house, with
  // the recording already made and about to be lost, would be the cruellest
  // possible moment to mention it.
  if (!pending.length && !(await queueAvailable())) {
    el.hidden = false;
    // Quiet, not alarming. Nothing is wrong and nothing is lost: the app works
    // normally, it just needs a connection. A full-width red panel above the
    // menu made a footnote look like a fault, so this states it in one line and
    // gets out of the way.
    el.className = 'queuebadge quiet';
    el.innerHTML = '<p class="qb-quiet">This device needs internet while you work — '
      + 'it cannot hold recordings to send later. A phone or tablet can.</p>';
    return;
  }

  // Recordings actually waiting on the device are a different matter: that is
  // unsent work, and it stays prominent until it is sent.
  el.className = 'queuebadge';
  el.hidden = pending.length === 0;
  if (pending.length) {
    el.innerHTML = `<p class="qb-line"><strong>${pending.length} recording${pending.length === 1 ? '' : 's'}</strong>
        waiting on this device.</p>
      <p class="qb-note">They are safe here. Send them when you next have internet &mdash;
        at a family member's house, or at your trust or solicitor's office.</p>
      <button class="primary wide" id="queueSendBtn">Send them now</button>`;
    $('#queueSendBtn').onclick = uploadQueue;
  }
}

async function uploadQueue() {
  const pending = await queueAll();
  if (!pending.length) return;
  if (!(await serverReachable())) {
    toast('Still no internet. Nothing was lost — try again later.', true);
    return;
  }
  const btn = $('#queueSendBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  let sent = 0;
  for (const rec of pending) {
    try {
      await fetch(`${API}/api/scope-media?title=${encodeURIComponent(`${rec.room_name} — walkthrough`)}`
        + `&room=${encodeURIComponent(rec.room_name)}`, {
        method: 'POST', headers: { 'content-type': rec.type || 'video/mp4' }, body: rec.blob,
      });
      await api(`/api/rooms/${rec.room_id}/state`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'started', documented: true }),
      }).catch(() => {});
      await queueRemove(rec.id);
      sent += 1;
    } catch { /* leave it queued and try again next time */ }
  }
  toast(sent === pending.length
    ? `All ${sent} recording${sent === 1 ? '' : 's'} sent.`
    : `${sent} of ${pending.length} sent. The rest are still safe here.`);
  await refreshQueueBadge();
  await loadWalk();
  if (btn) { btn.disabled = false; btn.textContent = 'Send them now'; }
}

/* ------------------------------------------------- wiring the walk screens */
$('#walkNewRoom')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#walkAddRoom').click(); });

$('#walkAddRoom').onclick = async () => {
  const name = $('#walkNewRoom').value.trim();
  if (!name) { toast('Type a name for the room first.', true); return; }
  if (registry.rooms.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    toast('That room is already on your list.', true);
    $('#walkNewRoom').value = '';
    return;
  }
  try {
    const created = await api('/api/rooms', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    registry.rooms.push(created);
    renderRoomChips();
    $('#walkNewRoom').value = '';
    await loadWalk();
    toast(`“${created.name}” added. It stays on your list.`);
  } catch (e) {
    toast('Could not add that room right now. Please try again when you have internet.', true);
  }
};

$('#roomVideo').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) await captureRoomMedia(file, 'video');
};

$('#roomPhotos').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  // Photos are already stills, so they go straight to naming as frames while the
  // originals are kept exactly as the video path keeps its recording.
  const key = `p${Date.now()}`;
  const entry = { key, label: `${files.length} photo${files.length === 1 ? '' : 's'}`, saved: false, frames: [], kind: 'photos' };
  roomPending.push(entry);
  renderRoomState();
  for (const f of files.slice(0, MAX_FRAMES)) {
    entry.frames.push(await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(f);
    }));
  }
  const online = await serverReachable();
  if (online) {
    try {
      await api(`/api/rooms/${room.room_id}/state`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'started', documented: true }),
      }).then((r) => { walk = r.walkthrough; });
      entry.saved = true;
    } catch { entry.saved = false; }
  }
  if (!entry.saved) {
    try { await queueAdd({ room_id: room.room_id, room_name: room.name, kind: 'photos', blob: files[0], type: files[0].type || '' }); }
    catch { /* the frames are still in memory for naming right now */ }
  }
  renderRoomState();
  await refreshQueueBadge();
  toast('Photos kept. You can name what is in them now, or later.');
};

// "Add one thing carefully" hands over to the guided capture, pre-filled with
// the room so the owner is not asked where they are standing.
$('#roomOneItem').onclick = () => {
  resetCapture();
  go('capture');
  if (room?.name) {
    cap.room = room.name;
    const chip = $$('#roomChips .chip').find((c) => c.dataset.room === room.name);
    if (chip) chip.setAttribute('aria-pressed', 'true');
  }
};

$('#roomDoneBtn').onclick = () => setRoomFinished('done');
$('#roomSkipBtn').onclick = () => setRoomFinished('skipped');
$('#roomPauseBtn').onclick = () => pauseWalk();

// If the phone regains a connection mid-walk, say so once rather than silently
// changing behaviour, and never upload without being asked.
window.addEventListener('online', async () => {
  const pending = await queueAll();
  if (pending.length) {
    await refreshQueueBadge();
    toast(`Internet is back. ${pending.length} recording${pending.length === 1 ? '' : 's'} ready to send.`);
  }
});
