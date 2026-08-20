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
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, bad ? 8000 : 3200);
};

// --- Open the owner's own email app ---------------------------------------
// Instead of server-side SMTP (which requires storing passwords and gets
// wiped on restart), all emails go through the owner's device email app.
// For invites/links: mailto: opens their email client with the content
// pre-filled. For the delivery bundle: navigator.share() lets them send the
// .reindeer file as an attachment through their email app.

/**
 * Show an email-sending modal so the user can choose how to send.
 *
 * mailto: links only work if a desktop email client is configured. Many
 * people use Gmail in the browser and have no local client, so clicking
 * a mailto: link does nothing. This modal offers three paths that work
 * regardless of browser or OS configuration:
 *   1. Open in Gmail — builds a compose URL that works in any browser
 *   2. Open in email app — the classic mailto: link for those who do
 *      have Outlook, Apple Mail, etc.
 *   3. Copy link — copies the invite link to the clipboard so the user
 *      can paste it into any messaging app themselves.
 */
function openEmailApp({ to, subject = '', body = '' }) {
  const recipients = Array.isArray(to) ? to.join(',') : (to || '');
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1`
    + (recipients ? `&to=${encodeURIComponent(recipients)}` : '')
    + (subject ? `&su=${encodeURIComponent(subject)}` : '')
    + (body ? `&body=${encodeURIComponent(body)}` : '');
  const mailtoUrl = `mailto:${recipients}`
    + (subject || body
        ? '?' + [
            subject ? `subject=${encodeURIComponent(subject)}` : '',
            body ? `body=${encodeURIComponent(body)}` : '',
          ].filter(Boolean).join('&')
        : '');

  // Build the modal
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem';
  overlay.className = 'email-modal-overlay';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--card,#fff);border-radius:12px;padding:1.5rem;max-width:420px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);font-family:inherit';
  modal.className = 'email-modal';

  // Extract the invite link from the body for the copy-link button
  const linkMatch = body.match(/https?:\/\/[^\s]+/);
  const inviteLink = linkMatch ? linkMatch[0] : '';

  modal.innerHTML = `
    <h3 style="margin:0 0 0.75rem;font-size:1.1rem">Send the invitation</h3>
    <p style="margin:0 0 1.25rem;color:var(--muted,#666);font-size:0.875rem;line-height:1.4">
      Choose how you want to send it to ${escapeHtml(recipients || 'them')}:
    </p>
    <div style="display:flex;flex-direction:column;gap:0.625rem">
      <button class="primary wide" id="emGmail" style="cursor:pointer">
        Open in Gmail
      </button>
      <button class="wide" id="emMailto" style="cursor:pointer;padding:0.625rem 1rem;border:1px solid var(--border,#ccc);border-radius:8px;background:transparent;font-family:inherit;font-size:0.9375rem">
        Open in email app (Outlook, Apple Mail…)
      </button>
      ${inviteLink ? `
      <button class="wide" id="emCopy" style="cursor:pointer;padding:0.625rem 1rem;border:1px solid var(--border,#ccc);border-radius:8px;background:transparent;font-family:inherit;font-size:0.9375rem">
        Copy the link instead
      </button>` : ''}
    </div>
    <p style="margin:1rem 0 0;font-size:0.75rem;color:var(--muted,#999);text-align:center">
      The link expires in 20 minutes.
    </p>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  modal.querySelector('#emGmail').onclick = () => {
    window.open(gmailUrl, '_blank');
    close();
    toast('Opening Gmail compose…');
  };

  modal.querySelector('#emMailto').onclick = () => {
    window.location.href = mailtoUrl;
    close();
    toast('Choose how to send…');
  };

  if (inviteLink) {
    modal.querySelector('#emCopy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(inviteLink);
        close();
        toast('Link copied! Paste it into a message or email.');
      } catch {
        close();
        toast('Could not copy automatically. The link is: ' + inviteLink, true);
      }
    };
  }
}

/**
 * Share a file (the .reindeer bundle) through the owner's email app.
 * Uses navigator.share() on mobile (opens the share sheet — user picks
 * their email app, file gets attached). Falls back to mailto: with a
 * download link on desktop or browsers without the Share API.
 */
async function shareWithEmailApp({ to, subject, body, fileBlob, fileName, downloadUrl }) {
  // Try navigator.share() with the file — mobile opens the share sheet
  if (navigator.canShare && fileBlob && navigator.canShare({ files: [new File([fileBlob], fileName, { type: 'application/octet-stream' })] })) {
    try {
      await navigator.share({
        title: subject,
        text: body,
        files: [new File([fileBlob], fileName, { type: 'application/octet-stream' })],
      });
      return { ok: true, method: 'share' };
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, cancelled: true };
      // Fall through to mailto fallback
    }
  }

  // Fallback: mailto: with download link in the body
  const fullBody = downloadUrl
    ? `${body}\n\nDownload the package here:\n${downloadUrl}\n\nThis link expires in 14 days.`
    : body;
  openEmailApp({ to, subject, body: fullBody });
  return { ok: true, method: 'mailto' };
}

const money = (c) => (c == null ? '' : `$${(c / 100).toLocaleString('en-US')}`);

let registry = { rooms: [], categories: [] };
let myRole = 'owner';  // global: tracks current user role (owner/partner/assistant)
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
let autoDetectInFlight = false;
let roomSkippedDuplicates = null;

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
// The capture flow is now a single page: photo at top, all details below.
// No multi-step navigation — everything is visible at once after the photo.
// Promise mode (for specific gifts) just means the "who" field is required.
const NO_TITLE = 'Unnamed item — see photograph';

/** What goes on the title line when the owner was never asked for one. */
const effectiveTitle = () =>
  cap.title || $('#capTitle')?.value.trim() || cap.ai?.label || NO_TITLE;

/** The sequence in play right now. Starts short; the owner may lengthen it. */
// Step navigation removed — capture is now a single page.

function go(name, opts = {}) {
  if (!opts.back) history.push(currentScreen());
  $$('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
  $('#backBtn').hidden = name === 'home' || name === 'welcome' || name === 'recipientwelcome' || name === 'helperwelcome' || name === 'howto';
  $('#homeBtn').hidden = name === 'home' || name === 'welcome' || name === 'recipientwelcome' || name === 'helperwelcome' || name === 'howto';
  // Floating nav — Back + Home, visible on every screen except landing pages
  const fn = $('#floatingNav');
  if (fn) fn.hidden = name === 'home' || name === 'welcome' || name === 'recipientwelcome' || name === 'helperwelcome' || name === 'howto';
  // Show/hide Back individually — hidden on screens with no back destination
  const fb = $('#floatingBack');
  if (fb) fb.hidden = history.length === 0;
  $('#appTitle').textContent = {
    welcome: 'Reindeer: Registry', recipientwelcome: 'Welcome', helperwelcome: 'Welcome', howto: 'How to use', guidedpartner: 'Add someone', guidedphoto: 'Take a photo', whosdoing: "Who's doing this?", helptype: "Who's helping?", home: 'Reindeer: Registry', capture: 'Add an item', batch: 'Add several',
    list: 'My items', detail: 'Item', print: 'Print', handoff: 'Finishing up', confirmsend: 'Confirm',
    signing: 'Making it official', people: 'My people',
    walk: 'Room by room', room: 'This room', promise: 'Items already designated to a specific person',
    // The addendum \u2014 named recipients + memorandum + signed versions.
    gifts: 'Special gifts by name', giftperson: 'One person',
    giftsign: 'Confirm your choices', giftversions: 'Signed versions',
    // Slice B \u2014 memorandum writer. Uses the same tile label as the
    // old gifts screen because that tile now opens this new writer.
    memo: 'Specific gifts by name', memoentry: 'One gift',
    // Slice 4 \u2014 couple mode.
    householdlink: 'Send invite', helperinvite: 'Invite a helper',
    // Ship B \u2014 contested categories.
    contested: 'Things families fight over', reminders: 'Holiday reminders',
    admin: 'Estate license keys',
  }[name] ?? 'Reindeer: Registry';
  window.scrollTo(0, 0);
  if (name === 'walk') { loadWalk(); applyVideoFlag(); }
  if (name === 'batch') { const bi = $('#batchIntake'); if (bi) bi.hidden = false; applyVideoFlag(); }
  if (name === 'promise') renderPromise();
  // Landing on the menu ends the gifting walk, so "Add one item" is never
  // silently shortened by a mode the owner has already left behind.
  if (name === 'home') {
    promiseMode = false; renderResume(); refreshQueueBadge(); renderCounters(); renderPartnerCard(); showAdminTile();
    // Render site tiles (second home, vacation, storage)
    renderSites();
    // Apply video capture feature flag
    applyVideoFlag();
  }

  if (name === 'list') loadList();
  if (name === 'admin') loadFeatureFlags();
  if (name === 'signing') {
    api('/api/household-link').then((hl) => {
      const me = (hl?.participants || []).find((p) => p.is_me);
      if (me?.role === 'assistant') {
        toast('Only the owners can sign the memorandum.', true);
        go('home');
      } else { loadExecution(); }
    }).catch(() => loadExecution());
  }
  if (name === 'people') loadPeople();
  if (name === 'capture') {
    // Trigger geosyncing when entering capture — detect the device's
    // location and warn if the owner is adding items to a site they're
    // not physically at. Owners can override; helpers are blocked from
    // adding to a site they're not at.
    if (currentSite && currentSite.site_id !== activeSiteId) {
      activeSiteId = currentSite.site_id;
    }
    // Trigger geosyncing when entering capture — but show the location
    // notice first so the owner knows why the browser is about to ask.
    if (!cap.geoChecked) {
      const locNotice = $('#locNotice');
      if (locNotice && locNotice.hidden) {
        locNotice.hidden = false;
        const locBtn = $('#locNoticeContinue');
        const locSkip = $('#locNoticeSkip');
        if (locBtn) locBtn.onclick = () => {
          locNotice.hidden = true;
          loadSites().then(() => detectLocation());
        };
        if (locSkip) locSkip.onclick = () => {
          locNotice.hidden = true;
          cap.geoChecked = true;  // Mark as checked so we don't ask again this session
          syncSiteUI();
        };
      } else {
        loadSites().then(() => detectLocation());
      }
    }
    // Always update the site UI — breadcrumb shows even before geo check
    syncSiteUI();
  }
  if (name === 'handoff') {
    api('/api/household-link').then((hl) => {
      const me = (hl?.participants || []).find((p) => p.is_me);
      if (me?.role === 'assistant') {
        toast('Only the owners can send the final list.', true);
        go('home');
      } else { verifyRecord(); refreshFinishScreen(); }
    }).catch(() => { verifyRecord(); refreshFinishScreen(); });
  }
  if (name === 'admin') loadAdminLicenses();
  // The gifts family. Each mount refreshes its data so the roster/preview
  // reflect any items added or reassigned since the owner was last here.
  if (name === 'gifts') loadGifts();
  if (name === 'giftperson' && !opts.editing) resetGiftPerson();
  if (name === 'giftsign') loadGiftSign();
  if (name === 'giftversions') loadGiftVersions();
  // Slice B \u2014 the new memorandum writer. Each mount re-reads
  // /api/memorandum so entries, conflicts, and the version chip are
  // never stale relative to what the partner just did.
  if (name === 'memo') {
    // Only owners and co-owners can see the designated-items list.
    // Helpers are redirected home — they can't designate gifts.
    api('/api/household-link').then((hl) => {
      const me = (hl?.participants || []).find((p) => p.is_me);
      if (me?.role === 'assistant') {
        toast('Only the owners can designate specific gifts to people.', true);
        go('home');
      } else {
        loadMemo();
      }
    }).catch(() => loadMemo());
  }
  if (name === 'memoentry') {
    // Only owners and co-owners can add/edit designated gifts.
    api('/api/household-link').then((hl) => {
      const me = (hl?.participants || []).find((p) => p.is_me);
      if (me?.role === 'assistant') {
        toast('Only the owners can designate specific gifts to people.', true);
        go('home');
      } else {
        if (!opts.editing) resetMemoEntry();
      }
    }).catch(() => { if (!opts.editing) resetMemoEntry(); });
  }
  // Slice 4 \u2014 household-link screen. Refreshes its data on every mount
  // so link state stays fresh without an app-wide state store.
  if (name === 'householdlink') loadHouseholdLink();
  if (name === 'helperinvite') loadHelperInvite();
  // Ship B \u2014 contested-categories screen. Renders per-category cards
  // and re-fetches the participant's saved holiday picks each time.
  if (name === 'contested') { renderContestedCards(); }
  if (name === 'reminders') { loadReminderPicker(); }
}
const currentScreen = () => $$('.screen').find((s) => !s.hidden)?.dataset.screen ?? 'home';

$('#backBtn').onclick = () => go(history.pop() || 'home', { back: true });
$('#homeBtn').onclick = () => go('home');
// Event delegation for data-go buttons — works for static HTML AND
// dynamically-inserted buttons (e.g. "Back to home" in invite screens).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-go]');
  if (!btn) return;
  if (btn.dataset.go === 'capture') resetCapture();
  // The main "rooms in your house" tile resets to primary/home site.
  // Site tiles set activeSiteId themselves before calling go('walk').
  if (btn.dataset.go === 'walk' && !btn.dataset.siteId) {
    activeSiteId = null;
  }
  go(btn.dataset.go);
});

// Quick test — the "Start here" tile on the welcome screen. Takes a photo
// immediately as a low-friction entry point, then routes to onboarding.
let recipientPracticeMode = false;

// "Photograph your first item" on the home screen — opens the capture
// Recipient welcome — invited partner does one practice item, then lands on
// the room walkthrough page to start helping with the real inventory.
const rsb = $('#recipientStartBtn');
if (rsb) rsb.onclick = () => { recipientPracticeMode = true; resetCapture(); go('capture'); };

// Onboarding — "Who's doing this?" flow
$('#onboardWithHelp')?.addEventListener('click', () => go('helptype'));
$('#onboardAssistant')?.addEventListener('click', () => go('helperinvite'));

// -------------------------------------------------- GUIDED INTRODUCTION
// Three-step first-run flow: partner → photo → meaning → home.
// Each step can be skipped. The guidedPhoto button opens the standard
// capture flow; after the item saves, the owner lands on home
// (not home) so they see the "tell its story" prompt before landing.
let guidedIntroMode = false;
let roomImportantFlow = false;  // when set, post-save asks about assignment then returns to room
$('#guidedTakePhoto')?.addEventListener('click', () => {
  guidedIntroMode = true;
  resetCapture();
  go('capture');
});

// ------------------------------------------------------------ guided capture
let cap = null;


function resetCapture() {
  // Inherit the active site so items captured during a site walk
  // are tagged to that site automatically.
  const activeSite = sitesList.find((s) => s.site_id === activeSiteId);
  // Keep the room from the previous capture so "Take another photo" stays
  // in the same room without re-asking. The owner is photographing items
  // one after another in a single room — making them re-pick the room each
  // time is a step that earns nothing.
  const keepRoom = cap?.room || '';
  cap = { file: null, dataUrl: null, title: '', maker: '', marks: '', story: '', valueCents: null, valueBasis: 'unknown',
          room: keepRoom, category: '', recipient: '', relationship: '', note: '', ai: null,
          important: false, importantFeeling: false, importantMoney: false,
          siteId: activeSiteId || null, siteName: activeSite ? activeSite.name : '',
          capturedLat: null, capturedLon: null,
    photoExif: null,
          geoChecked: false, offsite: false };
  ['#capTitle', '#capMaker', '#capMarks', '#capStory', '#capValue', '#capRecipient', '#capRelationship', '#capOwnerNote', '#capRoomOther']
    .forEach((s) => { $(s).value = ''; });
  $('#capValueBasis').value = 'unknown';
  $('#capPreview').hidden = true; $('#aiNote').hidden = true; $('#capRoomOther').hidden = true;
  ($('#capPhotoLabel') || {}).hidden = false;
  ($('#capRetake') || {}).hidden = true;
  ($('#capPhotoHint') || {}).hidden = false;
  ($('#capDetails') || {}).hidden = true;
  ($('#capNav') || {}).hidden = true;
  $('#capPhoto').value = '';
  ($('#capAnother') || {}).hidden = true;
  ($('#capNav') || {}).hidden = false;
  $$('#roomChips .chip, #catChips .chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  $('#capImportant').checked = false;
  $('#capImportantChips').hidden = true;
  $$('#capImportantChips .chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  $('#capCloseupBlock').hidden = true;
  $('#capVoiceBlock').hidden = true;
  // Reset close-up and voice
  if ($('#capCloseupPreview')) { $('#capCloseupPreview').hidden = true; }
  if ($('#capCloseupRetake')) { $('#capCloseupRetake').hidden = true; }
  if ($('#capVoicePlayer')) { $('#capVoicePlayer').hidden = true; }
  if ($('#capVoiceRedo')) { $('#capVoiceRedo').hidden = true; }
}

// Show the details section after a photo is taken
function showCapDetails() {
  ($('#capPhotoLabel') || {}).hidden = true;
  ($('#capRetake') || {}).hidden = false;
  ($('#capPhotoHint') || {}).hidden = true;
  ($('#capDetails') || {}).hidden = false;
  ($('#capNav') || {}).hidden = false;
  // Show "Save & take another" when a room is locked — lets the owner rapid-fire
  // through items in the same room without going through the post-save screen.
  const anotherBtn = $('#stepNextAnother');
  if (anotherBtn) anotherBtn.hidden = !cap.room;
  // Populate person and room chips now that the detail area is visible
  renderPersonChips();
  renderRoomChips();
  renderCatChips();
  // If arriving from Special collections, sync the Important checkbox and
  // reveal the close-up / voice blocks the important flag unlocks.
  if (cap.preSetImportant) {
    const box = $('#capImportant');
    const chipsWrap = $('#capImportantChips');
    if (box) { box.checked = true; box.dispatchEvent(new Event('change')); }
    // Re-apply the feeling reason we pre-set
    if (cap.importantFeeling) {
      const feelingChip = $$('#capImportantChips .chip').find((c) => c.dataset.reason === 'feeling');
      if (feelingChip) { feelingChip.setAttribute('aria-pressed', 'true'); }
    }
    if (chipsWrap) chipsWrap.hidden = false;
    if ($('#capCloseupBlock')) $('#capCloseupBlock').hidden = false;
    if ($('#capVoiceBlock')) $('#capVoiceBlock').hidden = false;
    cap.preSetImportant = false; // one-shot
  }
  if (typeof updateGiftBlockVisibility === 'function') updateGiftBlockVisibility();
}

/*
 * The owner-set Important flag. The reason chips reveal only when the
 * box is ticked. Wire it once on load.
 */
function wireImportantControl() {
  const box = $('#capImportant');
  const chipsWrap = $('#capImportantChips');
  if (!box || !chipsWrap) return;
  box.onchange = () => {
    cap.important = box.checked;
    chipsWrap.hidden = !box.checked;
    $('#capCloseupBlock').hidden = !box.checked;
    $('#capVoiceBlock').hidden = !box.checked;
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

/*
 * Geosyncing: detect the device location when the capture flow starts and
 * match it to a registered site. If no site matches, show an offsite
 * warning so the owner can register the location or proceed.
 *
 * The owner can always add or delete items from any location — geosyncing
 * is about TAGGING where items were added, not restricting access.
 */

let sitesList = [];
let currentSite = null;

async function loadSites() {
  try {
    sitesList = await api('/api/sites');
    return sitesList;
  } catch (e) {
    console.warn('Could not load sites:', e.message);
    return [];
  }
}

function detectLocation() {
  if (!navigator.geolocation) {
    console.info('Geolocation not available — skipping site detection');
    cap.geoChecked = true;
    syncSiteUI();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      cap.capturedLat = pos.coords.latitude;
      cap.capturedLon = pos.coords.longitude;
      cap.geoChecked = true;
      await matchSite();
      syncSiteUI();
    },
    (err) => {
      console.info('Geolocation denied or unavailable:', err.message);
      cap.geoChecked = true;
      syncSiteUI();
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
}

async function matchSite() {
  if (cap.capturedLat == null || cap.capturedLon == null) return;
  try {
    const res = await api('/api/sites/match', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: cap.capturedLat, lon: cap.capturedLon }),
    });
    if (res.matched && res.site) {
      currentSite = res.site;
      cap.siteId = res.site.site_id;
      cap.siteName = res.site.name;
      cap.offsite = false;
    } else {
      currentSite = null;
      cap.siteId = null;
      cap.siteName = '';
      cap.offsite = true;
    }
  } catch (e) {
    console.warn('Site match failed:', e.message);
    cap.offsite = false; // don't block on API failure
  }
}

function syncSiteUI() {
  const section = $('#capSiteSection');
  const display = $('#capSiteDisplay');
  const warning = $('#capOffsiteWarning');
  if (!section || !display) return;
  // Update the site breadcrumb at the top of the capture screen
  const crumb = $('#capSiteBreadcrumb');
  if (crumb) {
    const site = sitesList.find((s) => s.site_id === (cap.siteId || activeSiteId));
    if (site && !site.is_primary) {
      crumb.hidden = false;
      crumb.textContent = `Adding to ${site.name}`;
    } else {
      crumb.hidden = true;
    }
  }

  // Show the site section
  section.hidden = false;

  if (currentSite) {
    display.innerHTML = `<span class="site-badge">${escapeHtml(currentSite.name)}</span>`;
    // Warn if the owner is physically at a different site than the
    // one they're adding items to. Owners can override; the warning
    // is advisory. Helpers are blocked from adding to a site they're
    // not at (handled in the save flow).
    if (activeSiteId && currentSite.site_id !== activeSiteId) {
      const activeSite = sitesList.find((s) => s.site_id === activeSiteId);
      const activeName = activeSite ? activeSite.name : 'the selected site';
      warning.hidden = false;
      const warnEl = warning.querySelector('.offsite-msg');
      if (warnEl) {
        warnEl.innerHTML = `You appear to be at <b>${escapeHtml(currentSite.name)}</b>, but you're adding items to <b>${escapeHtml(activeName)}</b>. Items should be captured at the location where they are.`;
      }
    } else {
      warning.hidden = true;
    }
  } else if (cap.offsite) {
    display.innerHTML = '<span class="site-badge site-unknown">Unknown location</span>';
    warning.hidden = false;
    const warnEl = warning.querySelector('.offsite-msg');
    if (warnEl) {
      warnEl.textContent = 'You are not at a registered location. You can still add items, but they will be tagged with your GPS coordinates. Register this location to group items by site.';
    }
  } else {
    // Geo not available or denied — don't block, just tag as unknown
    display.innerHTML = '<span class="site-badge site-unknown">Location not detected</span>';
    warning.hidden = true;
  }
}

// Wire the offsite warning buttons
function wireSiteControls() {
  const addBtn = $('#capAddSiteBtn');
  const skipBtn = $('#capSkipGeoBtn');
  const form = $('#capAddSiteForm');
  const saveBtn = $('#capSiteSaveBtn');
  if (!addBtn) return;

  addBtn.onclick = () => {
    form.hidden = !form.hidden;
  };

  skipBtn.onclick = () => {
    ($('#capOffsiteWarning') || {}).hidden = true;
    // Item will be saved with site_id = null and coordinates captured
  };

  if (saveBtn) {
    saveBtn.onclick = async () => {
      const name = $('#capSiteName').value.trim();
      const kind = $('#capSiteKind').value;
      if (!name) return;
      try {
        const site = await api('/api/sites', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name, kind,
            lat: cap.capturedLat, lon: cap.capturedLon,
            radius_m: 150,
          }),
        });
        sitesList.push(site);
        currentSite = site;
        cap.siteId = site.site_id;
        cap.siteName = site.name;
        cap.offsite = false;
        form.hidden = true;
        ($('#capOffsiteWarning') || {}).hidden = true;
        syncSiteUI();
      } catch (e) {
        alert('Could not save the site: ' + e.message);
      }
    };
  }
}
wireSiteControls();

/*
 * Home screen site tiles.
 *
 * Sites are a branching layer above rooms. The primary "Home" site is the
 * default and doesn't need a separate tile unless other sites exist. When
 * additional sites are added, each gets a tile that opens the walk screen
 * scoped to that site's rooms.
 *
 * Tapping "Add another site" creates a new site with its own room set —
 * the default rooms are seeded into it so the owner starts with the usual
 * living room, kitchen, bedroom, etc.
 */

let activeSiteId = null; // null = primary/home site

async function renderSites() {
  const section = $('#homeSitesSection');
  const tilesEl = $('#homeSitesTiles');
  if (!section || !tilesEl) return;

  let sites = [];
  try { sites = await api('/api/sites'); } catch { return; }

  // Show the section only if there are non-primary sites
  const extraSites = sites.filter((s) => !s.is_primary);
  section.hidden = extraSites.length === 0;

  if (extraSites.length === 0) return;

  tilesEl.innerHTML = extraSites.map((s) => {
    const ico = s.kind === 'vacation' ? '🏖️' : s.kind === 'storage' ? '📦' : s.kind === 'second_home' ? '🏡' : '📍';
    return `<div class="site-tile-wrap" data-site-id="${s.site_id}">
      <button class="tile" data-site-id="${s.site_id}">
        <span class="ico">${ico}</span>
        <span class="lbl">${escapeHtml(s.name)}</span>
        <span class="hint">Tap to walk through its rooms</span>
      </button>
      <button class="site-tile-del" data-site-id="${s.site_id}" data-site-name="${escapeHtml(s.name)}" title="Remove this site">&times;</button>
    </div>`;
  }).join('');

  $$('#homeSitesTiles [data-site-id]').forEach((b) => {
    if (b.classList.contains('site-tile-del')) {
      b.onclick = async (e) => {
        e.stopPropagation();
        const siteId = b.dataset.siteId;
        const siteName = b.dataset.siteName;
        // Count items at this site so the owner knows what they're dealing with
        let itemCount = 0;
        try {
          const { items } = await api('/api/items');
          itemCount = items.filter((i) => i.site_id === siteId).length;
        } catch {}
        // Build a richer confirmation that offers retag + add-site options
        const msg = itemCount > 0
          ? `"${siteName}" has ${itemCount} item${itemCount === 1 ? '' : 's'} recorded at it.\n\n` +
            'Choose what to do with those items:\n\n' +
            'OK — Move them to Home, then remove this site\n' +
            'Cancel — Keep this site for now\n\n' +
            'To add a different site instead, cancel and use the "Add a site" button.'
          : `Remove "${siteName}" from your estate?\n\nNo items are recorded at this site.\n\n` +
            'OK — Remove it\n' +
            'Cancel — Keep it';
        if (!confirm(msg)) return;
        try {
          if (itemCount > 0) {
            // Retag items to primary (home) site before deleting
            await api(`/api/sites/${siteId}/retag`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({}),
            });
          }
          await api(`/api/sites/${siteId}`, {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          sitesList = sitesList.filter((s) => s.site_id !== siteId);
          if (activeSiteId === siteId) activeSiteId = null;
          await renderSites();
          toast(itemCount > 0
            ? `Moved ${itemCount} item${itemCount === 1 ? '' : 's'} to Home and removed "${siteName}".`
            : `Removed "${siteName}".`);
        } catch (err) {
          toast('Could not remove the site: ' + (err.message || 'unknown error'), true);
        }
      };
    } else {
      b.onclick = () => {
        activeSiteId = b.dataset.siteId;
        go('walk');
      };
    }
  });
}

function wireHomeSiteControls() {
  const addBtn = $('#homeAddSite');
  const form = $('#homeAddSiteForm');
  const saveBtn = $('#homeSiteSaveBtn');
  if (!addBtn) return;
  let gpsCoords = null;

  addBtn.onclick = () => {
    form.hidden = !form.hidden;
    if (!form.hidden) $('#homeSiteName')?.focus();
  };

  // GPS button — detect current location for the new site
  const gpsBtn = $('#homeSiteGpsBtn');
  const gpsResult = $('#homeSiteGpsResult');
  if (gpsBtn) {
    gpsBtn.onclick = () => {
      if (!navigator.geolocation) {
        toast('GPS is not available on this device.', true);
        return;
      }
      gpsBtn.textContent = '📍 Detecting your location…';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          gpsCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          if (gpsResult) {
            gpsResult.hidden = false;
            gpsResult.textContent = `Location captured: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`;
          }
          gpsBtn.textContent = '📍 Location captured ✓';
        },
        (err) => {
          gpsBtn.textContent = '📍 Use my current location (GPS)';
          toast('Could not get your location: ' + err.message, true);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
      );
    };
  }

  if (saveBtn) {
    saveBtn.onclick = async () => {
      const name = $('#homeSiteName').value.trim();
      const kind = $('#homeSiteKind').value;
      const address = $('#homeSiteAddress')?.value.trim() || '';
      if (!name) return;
      try {
        // If GPS was captured, use it. If an address was typed but no GPS,
        // we still save (address is informational for now — geocoding is
        // a future enhancement). If neither, just save the name.
        const body = { name, kind };
        if (gpsCoords) {
          body.lat = gpsCoords.lat;
          body.lon = gpsCoords.lon;
          body.radius_m = 150;
        }
        if (address) body.address = address;
        await api('/api/sites', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        ($('#homeSiteName') || {}).value = '';
        if ($('#homeSiteAddress')) ($('#homeSiteAddress') || {}).value = '';
        gpsCoords = null;
        if (gpsBtn) gpsBtn.textContent = '📍 Use my current location (GPS)';
        if (gpsResult) gpsResult.hidden = true;
        form.hidden = true;
        await renderSites();
        toast(`Added "${name}" as a new site.`);
      } catch (e) {
        toast('Could not add the site: ' + e.message, true);
      }
    };
  }
}
wireHomeSiteControls();

// Print-by-room tile — opens the printable inventory anytime for review
// or sharing to Discovery. The full sign-and-send flow is only on the
// all-done (walk finished) page.
$('#homePrintTile')?.addEventListener('click', () => {
  window.open(`${API}/api/print/report`, '_blank');
  toast('Opening your printable list, organized by room.');
});

function reasonFromCap(c) {
  if (!c.important) return '';
  if (c.importantFeeling && c.importantMoney) return 'both';
  if (c.importantFeeling) return 'feeling';
  if (c.importantMoney) return 'money';
  return '';
}

// Retake photo — clears the current photo and goes back to camera
$('#capRetake')?.addEventListener('click', () => {
  cap.file = null;
  cap.dataUrl = null;
  resetCapture();
});

// "Take another photo" — reset and stay on capture screen for the next item
$('#capAnotherTake')?.addEventListener('click', () => {
  resetCapture();
});

// "Save & take another" — save the current item, then immediately reset for
// the next photo. The room stays locked so the owner can rapid-fire through
// items in the same room without re-selecting it each time.
$('#stepNextAnother')?.addEventListener('click', async () => {
  if (!cap.dataUrl) return toast('Please take a photo first.', true);
  // Collect fields same as stepNext
  cap.title = $('#capTitle').value.trim();
  cap.story = $('#capStory').value.trim();
  cap.maker = $('#capMaker')?.value.trim() || '';
  cap.marks = $('#capMarks')?.value.trim() || '';
  cap.recipient = $('#capRecipient').value.trim();
  cap.relationship = $('#capRelationship').value.trim();
  cap.note = $('#capOwnerNote')?.value.trim() || '';
  if ($('#capRoomOther')?.value.trim()) {
    cap.room = $('#capRoomOther').value.trim();
    rememberTypedRoom(cap.room);
  }
  const valStr = $('#capValue')?.value.trim() || '';
  if (valStr) {
    const v = parseFloat(valStr.replace(/[^0-9.]/g, ''));
    if (!isNaN(v)) { cap.valueCents = Math.round(v * 100); cap.valueBasis = $('#capValueBasis')?.value || 'unknown'; }
  }
  const makeGiftEl = $('#capMakeGift');
  cap.makeGift = !!(cap.recipient && makeGiftEl && makeGiftEl.checked);
  if (promiseMode && !cap.recipient) {
    return toast('This one is for someone in particular — please put in their name.', true);
  }
  // Save the item (without the post-save "take another" screen)
  try {
    const item = await api('/api/items', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: effectiveTitle(), story: cap.story,
        room_name: cap.room || null, category_name: cap.category || null,
        review_state: 'kept',
        value_basis: cap.valueCents != null ? cap.valueBasis : 'unknown',
        value_estimate_cents: cap.valueCents,
        owner_high_value: cap.important === true,
        owner_high_value_reason: reasonFromCap(cap),
        ai_confidence: cap.ai?.confidence ?? null,
        site_id: cap.siteId || null, site_name: cap.siteName || '',
        captured_lat: cap.capturedLat, captured_lon: cap.capturedLon,
        photo_lat: cap.photoExif?.lat ?? null, photo_lon: cap.photoExif?.lon ?? null,
        photo_taken_at: cap.photoExif?.takenAt ?? null,
        identifiers: buildIdentifiers(),
        recipient_hint: cap.recipient
          ? { recipient_name: cap.recipient, relationship: cap.relationship, owner_note: cap.note }
          : null,
      }),
    });
    if (cap.dataUrl) await uploadPhoto(item.item_id, cap.dataUrl);
    if (cap.closeupDataUrl) {
      try { await uploadCloseupPhoto(item.item_id, cap.closeupDataUrl); } catch (e) { console.warn('close-up skipped:', e.message); }
    }
    if (cap.voiceBlob) {
      try { await uploadVoiceMemo(item.item_id, cap.voiceBlob); } catch (e) { console.warn('voice skipped:', e.message); }
    }
    if (cap.recipient) {
      try { await addPerson(cap.recipient, cap.relationship, 'from_item'); } catch { }
    }
    if (cap.makeGift && cap.recipient) {
      try { await assignItemToNamedRecipient(item.item_id, cap.recipient, cap.relationship); }
      catch (e) { console.warn('gift assignment skipped:', e.message); }
    }
    toast('Saved. Take the next one.');
    refreshCount();
    // Reset the capture form but KEEP the room
    const keepRoom = cap.room;
    resetCapture();
    // resetCapture preserves cap.room, but the form needs to start fresh
    // with just the camera button visible
    $('#capPreview').hidden = true;
    ($('#capRetake') || {}).hidden = true;
    ($('#capPhotoLabel') || {}).hidden = false;
    ($('#capPhotoHint') || {}).hidden = false;
    $('#capPhoto').value = '';
    ($('#capDetails') || {}).hidden = true;
    ($('#capNav') || {}).hidden = true;
    ($('#capAnother') || {}).hidden = true;
    $('#aiNote').hidden = true;
  } catch (e) { toast(e.message, true); }
});

// "All done" — go back to where we came from
$('#capAnotherDone')?.addEventListener('click', () => {
  go('home');
});

// Cancel button
$('#stepBack').onclick = () => go(promiseMode ? 'memo' : 'home');

// Save button — collects all fields from the single page and saves
$('#stepNext').onclick = async () => {
  if (!cap.dataUrl) return toast('Please take a photo first.', true);

  // Collect all fields from the page
  cap.title = $('#capTitle').value.trim();
  cap.story = $('#capStory').value.trim();
  cap.maker = $('#capMaker').value.trim();
  cap.marks = $('#capMarks').value.trim();
  cap.recipient = $('#capRecipient').value.trim();
  cap.relationship = $('#capRelationship').value.trim();
  cap.note = $('#capOwnerNote').value.trim();
  if ($('#capRoomOther').value.trim()) {
    cap.room = $('#capRoomOther').value.trim();
    rememberTypedRoom(cap.room);
  }
  // Value
  const valStr = $('#capValue').value.trim();
  if (valStr) {
    const v = parseFloat(valStr.replace(/[^0-9.]/g, ''));
    if (!isNaN(v)) { cap.valueCents = Math.round(v * 100); cap.valueBasis = $('#capValueBasis').value; }
  }
  // Gift block
  const makeGiftEl = $('#capMakeGift');
  cap.makeGift = !!(cap.recipient && makeGiftEl && makeGiftEl.checked);

  // Promise mode requires a name
  if (promiseMode && !cap.recipient) {
    return toast('This one is for someone in particular — please put in their name.', true);
  }

  return saveItem();
};

$('#capPhoto').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  cap.file = f;
  cap.dataUrl = await downscale(f, 1600);
  $('#capPreview').src = cap.dataUrl; $('#capPreview').hidden = false;

  // Show the details section so the owner can type while AI thinks
  showCapDetails();

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
  const timer = setTimeout(() => giveUp.abort(), 150000);
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
    // In guided intro mode, even without AI detection, show the accept bar
    // so the owner can type a name and save in one go.
    if (guidedIntroMode) showAcceptBar('', null);
    const best = detections.sort((a, b) => b.confidence - a.confidence)[0];
    if (best) {
      cap.ai = best;
      // Only fill the box if the owner has not already typed their own name for
      // it while waiting. Their words outrank the machine's, always.
      const box = $('#capTitle');
      if (box && !box.value.trim()) box.value = best.label;
      setNote(`This looks like: ${escapeHtml(best.label)}${best.category_hint ? ` (${escapeHtml(best.category_hint)})` : ''}. Change it if that is not right.`);
      if (best.category_hint) cap.category = best.category_hint;
      // In guided intro mode, show the accept bar so the owner can confirm
      // the AI label and save in one tap without scrolling through details.
      if (guidedIntroMode) showAcceptBar(best.label, best.category_hint);
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

// ---- Guided intro: AI accept bar ----
// When the owner taps "Add your first item" and takes a photo, the AI
// identifies it. Instead of silently filling a form field, show a
// prominent bar: "AI suggests: [label]" with an Accept button that
// saves the item immediately and returns home. The full details form
// is still below for anyone who wants to add more.
function showAcceptBar(label, categoryHint) {
  let bar = $('#capAcceptBar');
  if (!bar) return; // element doesn't exist (shouldn't happen)
  bar.hidden = false;
  const labelText = label
    ? `AI suggests: <strong>${escapeHtml(label)}</strong>${categoryHint ? ` (${escapeHtml(categoryHint)})` : ''}`
    : 'Type a name for this item, or just save the photo.';
  ($('#capAcceptLabel') || {}).innerHTML = labelText;
  const input = $('#capAcceptName');
  if (input && label) input.value = label;
  if (input) input.placeholder = label ? 'Change the name if this is not right' : 'What is this?';
  // Focus the accept input so the owner can edit right away
  if (input) setTimeout(() => input.focus(), 100);
}

// Accept & Save button — saves the item with the AI label (or edited name)
// and returns home. Quick path for the "Add your first item" flow.
$('#capAcceptBtn')?.addEventListener('click', async () => {
  const acceptInput = $('#capAcceptName');
  if (acceptInput && acceptInput.value.trim()) {
    cap.title = acceptInput.value.trim();
    // Also sync the main title field so saveItem picks it up
    const mainTitle = $('#capTitle');
    if (mainTitle && !mainTitle.value.trim()) mainTitle.value = cap.title;
  }
  // Collect minimal fields and save
  cap.story = '';
  cap.recipient = '';
  cap.relationship = '';
  cap.note = '';
  return saveItem();
});

// "Edit details" button — hides the accept bar and reveals the full form
$('#capEditDetailsBtn')?.addEventListener('click', () => {
  const bar = $('#capAcceptBar');
  if (bar) bar.hidden = true;
  // Sync any typed name to the main title field
  const acceptInput = $('#capAcceptName');
  if (acceptInput && acceptInput.value.trim()) {
    const mainTitle = $('#capTitle');
    if (mainTitle && !mainTitle.value.trim()) mainTitle.value = acceptInput.value.trim();
  }
});

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
        site_id: cap.siteId || null,
        site_name: cap.siteName || '',
        captured_lat: cap.capturedLat,
        captured_lon: cap.capturedLon,
        photo_lat: cap.photoExif?.lat ?? null,
        photo_lon: cap.photoExif?.lon ?? null,
        photo_taken_at: cap.photoExif?.takenAt ?? null,
        identifiers: buildIdentifiers(),
        recipient_hint: cap.recipient
          ? { recipient_name: cap.recipient, relationship: cap.relationship, owner_note: cap.note }
          : null,
      }),
    });
    if (cap.dataUrl) await uploadPhoto(item.item_id, cap.dataUrl);
    // Close-up photo — only if the owner took one. Non-fatal: the item is
    // already saved; a failed close-up upload should not lose the item.
    if (cap.closeupDataUrl) {
      try { await uploadCloseupPhoto(item.item_id, cap.closeupDataUrl); }
      catch (e) { console.warn('close-up upload skipped:', e.message); }
    }
    // Voice memo — only if the owner recorded one. Never required.
    if (cap.voiceBlob) {
      try { await uploadVoiceMemo(item.item_id, cap.voiceBlob); }
      catch (e) { console.warn('voice memo upload skipped:', e.message); }
    }
    // A name typed here joins the roster, so the next item is one tap. The
    // save must not fail because the address book did, hence the catch.
    if (cap.recipient) {
      try { await addPerson(cap.recipient, cap.relationship, 'from_item'); } catch { /* not worth stopping for */ }
    }
    // Auto-populate the addendum roster from capture. If the owner ticked
    // "Add this to my special gifts", find-or-create an heir with this
    // name and link the item to it. Never a blocker for the save itself.
    if (cap.makeGift && cap.recipient) {
      try { await assignItemToNamedRecipient(item.item_id, cap.recipient, cap.relationship); }
      catch (e) { console.warn('gift assignment skipped:', e.message); }
    }
    toast('Saved. You can change it any time.');
    refreshCount();
    resetCapture();
    // In promise mode the owner is in the middle of emptying a list they already
    // carry in their head. Dropping them back on the menu after each one breaks
    // that thread; asking "anything else you already know?" keeps it.
    if (promiseMode) { promiseKept += 1; return go('memo'); }
    if (recipientPracticeMode) { recipientPracticeMode = false; return go('walk'); }
    if (guidedIntroMode) {
      guidedIntroMode = false;
      go('home');
      return;
    }
    if (roomImportantFlow) {
      roomImportantFlow = false;
      const savedItem = item;
      const savedRoom = room?.name;
      go('batch');
      const intake = $('#batchIntake'); if (intake) intake.hidden = true;
      $('#batchResults').innerHTML = `
        <h2>Saved as important</h2>
        <p class="reassure">${escapeHtml(cap.title || 'That item')} is on your list, flagged as important.</p>
        <div class="ask">
          <p class="askq">Should this be assigned to someone?</p>
          <button class="primary wide" id="assignYes">Yes — assign it</button>
          <button class="ghost wide" id="assignNo">No — just flag it as important</button>
        </div>`;
      $('#assignNo').onclick = async () => {
        await leaveNaming();
        renderRoomImportantAsk(savedRoom);
      };
      $('#assignYes').onclick = () => renderAssignForm(savedItem, savedRoom);
      return;
    }
    // Normal mode: offer to take another photo instead of going home
    ($('#capNav') || {}).hidden = true;
    ($('#capAnother') || {}).hidden = false;
  } catch (e) { toast(e.message, true); }
}

async function uploadPhoto(itemId, dataUrl, bbox = null) {
  const blob = await (await fetch(dataUrl)).blob();
  const q = bbox ? `?bbox=${encodeURIComponent(JSON.stringify(bbox))}` : '';
  await fetch(`${API}/api/items/${itemId}/photos${q}`, { method: 'POST', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob });
}

// Upload a close-up photo and link it as the item's designated close-up.
// The photo goes through the standard /items/:id/photos endpoint, then
// the photo_id is PATCHed to /items/:id/closeup to mark it as THE
// close-up (separate from the inventory photo).
async function uploadCloseupPhoto(itemId, dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const res = await fetch(`${API}/api/items/${itemId}/photos?role=closeup`, {
    method: 'POST', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Close-up could not be saved.');
  const saved = await res.json();
  await api(`/api/items/${itemId}/closeup`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ photo_id: saved.photo_id }),
  });
}

// Upload a voice memo for an item. Uses the /items/:id/recordings endpoint
// with content-type audio/webm. The server stores it as media_kind='audio'
// with role='item_story'.
async function uploadVoiceMemo(itemId, blob) {
  const res = await fetch(`${API}/api/items/${itemId}/recordings`, {
    method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Voice memo could not be saved.');
  return res.json();
}

// ---- capture close-up photo input ----
$('#capCloseupPhoto')?.addEventListener('change', (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    cap.closeupDataUrl = reader.result;
    const preview = $('#capCloseupPreview');
    preview.src = reader.result;
    preview.hidden = false;
    $('#capCloseupRetake').hidden = false;
    $('#capCloseupLabel').style.display = 'none';
  };
  reader.readAsDataURL(file);
});

$('#capCloseupRetake')?.addEventListener('click', () => {
  cap.closeupDataUrl = null;
  $('#capCloseupPreview').hidden = true;
  $('#capCloseupRetake').hidden = true;
  $('#capCloseupLabel').style.display = '';
  $('#capCloseupPhoto').value = '';
});

// ---- capture voice memo recorder ----
// Reuses the same MediaRecorder + getUserMedia pattern as the sign-flow
// statement recorder. 60-second cap enforced by setTimeout.
let capRecorder = null;
let capRecChunks = [];
let capRecTimer = null;

$('#capVoiceRecord')?.addEventListener('click', async () => {
  const btn = $('#capVoiceRecord');
  if (capRecorder && capRecorder.state === 'recording') { capRecorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return toast('This device will not let the app record sound.', true);
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    capRecChunks = [];
    capRecorder = new MediaRecorder(stream);
    capRecorder.ondataavailable = (ev) => { if (ev.data.size) capRecChunks.push(ev.data); };
    capRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearTimeout(capRecTimer);
      btn.classList.remove('listening');
      cap.voiceBlob = new Blob(capRecChunks, { type: capRecorder.mimeType || 'audio/webm' });
      const player = $('#capVoicePlayer');
      player.src = URL.createObjectURL(cap.voiceBlob);
      player.hidden = false;
      btn.textContent = 'Recording saved';
      $('#capVoiceRedo').hidden = false;
    };
    capRecorder.start();
    btn.classList.add('listening');
    btn.textContent = 'Recording — tap to stop';
    // 60-second cap
    capRecTimer = setTimeout(() => {
      if (capRecorder?.state === 'recording') capRecorder.stop();
    }, 60000);
  } catch {
    toast('The microphone could not be opened. Check the app is allowed to use it.', true);
  }
});

$('#capVoiceRedo')?.addEventListener('click', () => {
  cap.voiceBlob = null;
  $('#capVoicePlayer').hidden = true;
  $('#capVoicePlayer').src = '';
  $('#capVoiceRedo').hidden = true;
  $('#capVoiceRecord').textContent = '🎙 Record a voice memo';
});

// ------------------------------------------------------------------- batch
// Two lanes arrive here and then share one path. Photos become frames; a video
// becomes frames too. Everything after that is identical, which is why the
// walkthrough needed no new endpoint — the detect route already accepts frames
// and already groups the same object seen from several angles.
let batchFiles = [];
// Default 4 photos per room. The server can override this up to 8 via the
// admin settings endpoint — fetch it on startup and keep the value in sync.
let MAX_FRAMES = 4;
(async () => {
  try {
    const r = await fetch(`${API}/settings/max-frames`);
    if (r.ok) { const j = await r.json(); MAX_FRAMES = j.max_frames ?? 4; }
  } catch { /* server unreachable — use default */ }
})();

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
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), 150000);
    const { detections, vision_mode } = await api('/api/intake/detect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: giveUp.signal,
      body: JSON.stringify({ images: batchFiles.map((f, i) => ({ data_url: f._dataUrl, frame_index: i, media_id: `m${i}` })) }),
    });
    clearTimeout(timer);
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
  const [i, conflictRes] = await Promise.all([
    api(`/api/items/${id}`),
    api('/api/memorandum/conflicts').catch(() => ({ conflicts: [], partner: null })),
  ]);
  // Step 5: if this item has a memorandum conflict, show a gold banner
  const myConflict = (conflictRes.conflicts || []).find((c) => c.item_id === id);
  const partnerName = conflictRes.partner?.display_name || 'your partner';
  // Pre-tick the two reason chips from what is already stored. 'both' ticks
  // both chips; 'feeling'/'money' ticks one; '' leaves them off. The chips
  // block only shows when the item is flagged.
  const isImportant = !!i.owner_high_value;
  const reason = i.owner_high_value_reason || '';
  const feelingOn = reason === 'feeling' || reason === 'both';
  const moneyOn = reason === 'money' || reason === 'both';
  // The owner-authored comment is rendered verbatim, right below the story.
  // The registry does not paraphrase, summarize, or interpret the owner's own
  // words — it prints them and shows them. Owners were previously unable to
  // read back their own comment between recording it and printing the sheet,
  // which broke the app's promise that the owner's authorship is preserved.
  // See docs/decisions/2026-08-06-important-comment.md.
  const commentBlock = i.owner_important_comment
    ? `<div class="owner-comment">
         <div class="owner-comment-lbl">In your own words</div>
         <div class="owner-comment-body">${escapeHtml(i.owner_important_comment)}</div>
       </div>`
    : '';
  const conflictBanner = myConflict
    ? `<div class="memo-note memo-note-conflict detail-conflict-banner">
         <p class="memo-conflict-heading">⚠ This item has a conflict</p>
         <p class="memo-conflict-text">${
           myConflict.conflict_type === 'both_important_assigned'
             ? `You and ${escapeHtml(partnerName)} both marked this item as important and named someone for it. Talk it over before signing.`
             : `You and ${escapeHtml(partnerName)} named different people for this item. Sort it out together before signing — or sign anyway; the paper tells the truth.`
         }</p>
       </div>`
    : '';
  $('#detailBody').innerHTML = `
    ${conflictBanner}
    ${
      // AI conversion prompt: when the AI flagged this item as high-value
      // but the owner hasn't marked it important yet, offer a one-tap
      // conversion that sets owner_high_value=true and requests a close-up.
      (i.high_value_flag && !i.owner_high_value) ? `
    <div class="memo-note ai-convert-note">
      <p class="ai-convert-heading">📌 The app thinks this might be important</p>
      <p class="ai-convert-text">Based on the photo, this item may be worth special attention. Mark it as important to request a close-up photo.</p>
      <button class="primary" id="aiConvertBtn">Mark as important</button>
    </div>` : ''
    }
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
    ${commentBlock}

    ${
      // Close-up photo section — shown on important items. Displays the
      // existing close-up (if any) and offers to take or replace one.
      isImportant ? `
    <div class="closeup-section">
      <h3>Close-up photo</h3>
      ${i.closeup_photo_id ? `<img class="closeup-img" src="${API}/api/photos/${i.closeup_photo_id}" alt="Close-up of ${escapeHtml(i.title)}">` : '<p class="important-hint">No close-up yet. This helps make the item unmistakable.</p>'}
      <button class="ghost wide" id="detailCloseupBtn">${i.closeup_photo_id ? 'Replace close-up' : 'Take a close-up'}</button>
    </div>` : ''
    }

    ${
      // Voice memo section — shown on important items. Plays the existing
      // recording (if any) and offers to record or replace. Never required.
      isImportant ? `
    <div class="voice-section">
      <h3>Voice memo</h3>
      ${(i.recordings || []).filter((r) => r.media_kind === 'audio').map((r) =>
        `<audio class="voice-player" src="${API}/api/photos/${r.photo_id}" controls></audio>`
      ).join('') || '<p class="important-hint">No voice memo yet.</p>'}
      <button class="ghost wide" id="detailVoiceBtn">🎙 ${i.recordings?.some((r) => r.media_kind === 'audio') ? 'Record again' : 'Record a voice memo'}</button>
      <audio id="detailVoicePlayer" controls hidden></audio>
    </div>` : ''
    }

    <!--
      Assign-to-heir row. The item may already carry an assigned_to_heir_id
      from the capture flow's "Add to my special gifts" toggle, or from
      the Special gifts screen. The picker shows every person on the
      Special-gifts roster; "Nobody in particular" unassigns.
    -->
    <div class="assign-block">
      <label class="important-lbl" for="detailHeir">This is a special gift for</label>
      <select id="detailHeir" class="bigin" data-item="${escapeHtml(i.item_id)}">
        <option value="">— nobody in particular —</option>
      </select>
      <p class="important-hint" id="detailHeirHint">
        Adds this item to your list of special gifting for that person. Use
        “Special gifts by name” to add somebody new to the list.
      </p>
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

    <div class="ownership-block">
      <label class="fieldlabel">Whose is it?</label>
      <div class="chips ownership-chips" id="detailOwnershipChips">
        <button type="button" class="chip" data-tag="mine" aria-pressed="${i.ownership_tag === 'mine'}">Mine</button>
        <button type="button" class="chip" data-tag="theirs" aria-pressed="${i.ownership_tag === 'theirs'}">Theirs</button>
        <button type="button" class="chip" data-tag="ours" aria-pressed="${i.ownership_tag === 'ours'}">Ours</button>
      </div>
      <p class="important-hint">Guides whose memorandum this item belongs in for assignment.</p>
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

  // Populate the assign-to-heir picker with the current Special-gifts
  // roster, mark the currently-assigned heir as selected, and PATCH
  // /api/items/:id/assign on change. Failures are non-fatal; the item
  // itself is unchanged.
  (async () => {
    try {
      const list = await api('/api/two-outputs/heirs');
      const heirs = list.heirs || [];
      const sel = $('#detailHeir');
      if (!sel) return;
      const current = i.assigned_to_heir_id || '';
      const optionHtml = heirs.map((h) => {
        const kind = h.recipient_type === 'named_recipient' ? ' (someone else by name)' : '';
        const rel = h.relationship ? ' \u2014 ' + h.relationship : '';
        return `<option value="${escapeHtml(h.heir_id)}"${h.heir_id === current ? ' selected' : ''}>${escapeHtml(h.name)}${escapeHtml(rel)}${escapeHtml(kind)}</option>`;
      }).join('');
      sel.innerHTML = '<option value="">\u2014 nobody in particular \u2014</option>' + optionHtml;

      // Soft nudge: if the item is Important and unassigned, tell the
      // owner they can (but do not have to) name somebody.
      if (isImportant && !current) {
        const hint = $('#detailHeirHint');
        if (hint) {
          hint.innerHTML = `<b>This item is marked Important.</b> You do not have to name someone \u2014
            but if you already have somebody in mind, choose them here and it goes onto your list of special gifting.`;
        }
      }

      sel.onchange = async () => {
        const heirId = sel.value || null;
        try {
          await api(`/api/items/${i.item_id}/assign`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ heir_id: heirId }),
          });
          toast(heirId ? 'Added to their list.' : 'Not for anybody in particular.');
        } catch (e) { toast(e.message, true); }
      };
    } catch { /* the roster is optional \u2014 detail must still open */ }
  })();

  $('#delBtn').onclick = async () => {
    if (!confirm(`Remove "${i.title}"? The removal is recorded in the history.`)) return;
    await api(`/api/items/${i.item_id}?reason=owner+removed`, { method: 'DELETE' });
    toast('Removed. The history keeps a record.'); refreshCount(); go('list', { back: true });
  };

  // ---- AI conversion to important ----
  $('#aiConvertBtn')?.addEventListener('click', async () => {
    try {
      await api(`/api/items/${i.item_id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner_high_value: true, owner_high_value_reason: '' }),
      });
      toast('Marked as important. Consider adding a close-up photo.');
      await openDetail(i.item_id); // re-render with close-up section visible
    } catch (e) { toast(e.message, true); }
  });

  // ---- close-up photo handler on detail ----
  $('#detailCloseupBtn')?.addEventListener('click', () => {
    const modal = $('#closeupModal');
    const modalPhoto = $('#closeupModalPhoto');
    const modalPreview = $('#closeupModalPreview');
    const modalSave = $('#closeupModalSave');
    const modalLabel = $('#closeupModalLabel');
    let closeupDataUrl = null;
    modal.hidden = false;
    modalPreview.hidden = true;
    modalSave.disabled = true;
    modalLabel.style.display = '';
    modalPhoto.value = '';

    modalPhoto.onchange = (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        closeupDataUrl = reader.result;
        modalPreview.src = reader.result;
        modalPreview.hidden = false;
        modalSave.disabled = false;
        modalLabel.style.display = 'none';
      };
      reader.readAsDataURL(file);
    };

    modalSave.onclick = async () => {
      if (!closeupDataUrl) return;
      modalSave.disabled = true;
      modalSave.textContent = 'Saving…';
      try {
        await uploadCloseupPhoto(i.item_id, closeupDataUrl);
        toast('Close-up saved.');
        modal.hidden = true;
        await openDetail(i.item_id); // re-render detail
      } catch (e) {
        toast(e.message, true);
        modalSave.disabled = false;
        modalSave.textContent = 'Save close-up';
      }
    };

    $('#closeupModalCancel').onclick = () => { modal.hidden = true; };
  });

  // ---- voice memo handler on detail ----
  let detailRecorder = null;
  let detailRecChunks = [];
  $('#detailVoiceBtn')?.addEventListener('click', async () => {
    const btn = $('#detailVoiceBtn');
    if (detailRecorder && detailRecorder.state === 'recording') { detailRecorder.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return toast('This device will not let the app record sound.', true);
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      detailRecChunks = [];
      detailRecorder = new MediaRecorder(stream);
      detailRecorder.ondataavailable = (ev) => { if (ev.data.size) detailRecChunks.push(ev.data); };
      detailRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        btn.classList.remove('listening');
        btn.textContent = 'Saving…';
        const blob = new Blob(detailRecChunks, { type: detailRecorder.mimeType || 'audio/webm' });
        try {
          await uploadVoiceMemo(i.item_id, blob);
          toast('Voice memo saved.');
          await openDetail(i.item_id); // re-render detail
        } catch (e) {
          toast(e.message, true);
          btn.textContent = '🎙 Record a voice memo';
        }
      };
      detailRecorder.start();
      btn.classList.add('listening');
      btn.textContent = 'Recording — tap to stop';
      setTimeout(() => {
        if (detailRecorder?.state === 'recording') detailRecorder.stop();
      }, 60000);
    } catch {
      toast('The microphone could not be opened.', true);
    }
  });

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
const FINISH_OPTS = ['#optEmail', '#optSave', '#optSigned', '#optFairChoice', '#optDiscovery'];

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
  const chosen = FINISH_OPTS.filter((id) => $(id)?.checked);
  const btn = $('#finishGo');
  btn.disabled = chosen.length === 0;
  btn.textContent = chosen.length === 0
    ? 'Choose at least one'
    : chosen.length === 1 ? 'Do this one thing' : `Do these ${chosen.length} things`;
  $('#emailFields').hidden = !$('#optEmail').checked;
}

FINISH_OPTS.forEach((id) => { const el = $(id); if (el) el.onchange = updateFinishButton; });

$('#finishGo').onclick = async () => {
  const wantEmail = $('#optEmail').checked;
  if (wantEmail) {
    const name = $('#trusteeName').value.trim();
    const email = $('#trusteeEmail').value.trim();
    if (!name) return toast('Please write your trustee\u2019s name.', true);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('That email address does not look right. Please check it.', true);
    // Emailing cannot be undone, so it gets its own plain confirmation screen.
    // Every send requires a signed page on file. If there isn't one,
    // redirect to the signing page instead of sending.
    if (!execution?.record) {
      toast('You need to sign your list before sending it. Print it, sign it by hand, photograph the signed page.', true);
      go('signing');
      return;
    }
    $('#confirmDetail').innerHTML =
      `<b>To:</b> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;<br>`
      + '<b>What they receive:</b> your full list, every photo, every story, and your wishes about who gets what. Your email app will open with everything attached — just hit send.<br>'
      + `<br><b>⚠ Fresh signature required.</b> Your signed page on file was photographed on ${new Date(execution.record.captured_at).toLocaleDateString('en-US', { dateStyle: 'long' })}. Make sure you print a fresh copy, sign it by hand, and photograph the newly signed page before sending. Do not reuse an old signed page.`;
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
      const trusteeName = $('#trusteeName').value.trim();
      const trusteeEmail = $('#trusteeEmail').value.trim();
      const trustee = await api('/api/trustees', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trusteeName, email: trusteeEmail }),
      });
      const prepared = await api('/api/delivery/prepare', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trustee_ids: [trustee.trustee_id ?? trustee.id] }),
      });

      // Fetch the .reindeer bundle as a blob for sharing via the owner's email app
      const bundleRes = await fetch(`${API}/api/delivery/${prepared.delivery_id ?? prepared.id}/file`);
      const bundleBlob = await bundleRes.blob();
      const fileName = prepared.file_name || 'estate-package.reindeer';
      const ownerName = trusteeName || 'the estate owner';
      const bodyText = `Hello ${trusteeName},

${ownerName} has put together an inventory of their possessions and their wishes about who should receive each item. The attached file contains everything — the full list, every photo, and every story.

To open it, go to ${window.location.origin.replace('registry', 'fair-play')} and use the "Import from Registry" option. You will also need a license key from ${ownerName} — they will share it with you separately.

Keep this file with the estate planning documents. It is the personal property memorandum referenced by the will.

This package was prepared on ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}.`;

      const shareResult = await shareWithEmailApp({
        to: trusteeEmail,
        subject: `${ownerName}: estate inventory package`,
        body: bodyText,
        fileBlob: bundleBlob,
        fileName,
        downloadUrl: prepared.download_url,
      });

      if (shareResult.cancelled) {
        // User cancelled the share sheet — not an error
        done.push('Email was cancelled — the package is still saved, you can send it later.');
      } else if (shareResult.method === 'share') {
        done.push(`Shared with ${escapeHtml(trusteeName)} — your email app handled the delivery.`);
      } else {
        done.push(`Your email app is open — send the message to ${escapeHtml(trusteeName)}.`);
      }
    } catch (e) {
      failed.push(`The email could not be prepared: ${escapeHtml(e.message)}`);
    }
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

  if ($('#optDiscovery').checked) {
    triggerDownload(`${API}/api/export/bundle`);
    const discoveryUrl = window.location.origin.replace('registry', 'discovery');
    done.push(`Your inventory is ready in <a href="${discoveryUrl}" style="color:var(--primary);font-weight:600">Reindeer: Discovery</a> — open it to invite your family. They'll be able to browse the collection and privately mark what matters to them.`);
  }

  box.innerHTML = [
    done.length ? `<b>Done:</b><ul>${done.map((d) => `<li>${d}</li>`).join('')}</ul>` : '',
    failed.length ? `<b>Not done:</b><ul>${failed.map((d) => `<li>${d}</li>`).join('')}</ul>` : '',
  ].join('');
  FINISH_OPTS.forEach((id) => { const el = $(id); if (el) el.checked = false; });
  updateFinishButton();

  // Show the data access code + safe keeping instructions after actions complete
  if (done.length) {
    ($('#finalInstructions') || {}).hidden = false;
  }
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
  const generic = 'The rooms in your house, your family will have to work out between '
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
    return `The rooms in your house, ${list} will have to work out between themselves. `
      + 'Writing those down is what stops that becoming an argument.';
  } catch { return generic; }
}

/**
 * Partner invitation on Home. Shown only when the account is in solo mode
 * (no linked partner). Once linked, we hide the invite and show a small
 * quiet confirmation with the partner's name. This makes the couple flow
 * discoverable to owners who don't scroll to the quietrow at the bottom.
 *
 * Data source: /api/scope-summary returns { household_mode, partner? }.
 * Fail-silent: if the call errors, both elements stay hidden — no worse
 * than the app before this render function existed.
 */
async function renderPartnerCard() {
  const add = $('#homePartnerAdd');
  const linked = $('#homePartnerLinked');
  const nameSpan = $('#homePartnerName');
  if (!add || !linked) return;

  // Fetch household-link once — it has participants, pending invites, and roles.
  // We already need it for role checks and pending-invite detection.
  let hl = null;
  try { hl = await api('/api/household-link'); } catch {}

  // Helpers don't see the "add co-owner/helper" card or the quiet-row link.
  const me = (hl?.participants || []).find((p) => p.is_me);
  const myRoleHl = me?.role;
  if (myRoleHl === 'assistant') {
    add.hidden = true;
    linked.hidden = true;
    document.querySelectorAll('[data-go="householdlink"]').forEach(el => {
      if (el.closest('.quietrow')) el.style.display = 'none';
    });
    // Helpers cannot designate gifts, sign, or hand off — hide those tiles.
    document.querySelectorAll('[data-go="memo"], [data-go="signing"], [data-go="handoff"]').forEach(el => {
      el.style.display = 'none';
    });
    const cc = $('#homeConflictCounter');
    if (cc) cc.style.display = 'none';
    return;
  }

  // Check for pending co-owner invites (partner invited but not yet signed in).
  // Only two owners allowed — once an invite is sent, suppress the add tile.
  const pendingPartnerInvites = (hl?.pending_invites || []).filter(
    (p) => p.role === 'partner'
  );
  const hasPendingPartner = pendingPartnerInvites.length > 0;

  try {
    const s = await api('/api/scope-summary');
    if (s?.household_mode === 'couple') {
      // Already linked — show the linked card, hide the add tile
      add.hidden = true;
      linked.hidden = false;
      let partnerName = 'your partner';
      try {
        const others = (hl?.participants || []).filter((p) => !p.is_me);
        const other = others[0];
        partnerName = other?.display_name || other?.email || partnerName;
      } catch { /* keep generic label */ }
      if (nameSpan) nameSpan.textContent = partnerName;
    } else if (hasPendingPartner) {
      // Co-owner invite sent but not yet accepted — suppress the add tile,
      // show a "waiting" card instead of the linked card.
      add.hidden = true;
      linked.hidden = false;
      const inviteeName = pendingPartnerInvites[0]?.display_name || pendingPartnerInvites[0]?.email || 'your co-owner';
      if (nameSpan) nameSpan.textContent = inviteName + ' (invite sent)';
    } else {
      add.hidden = false;
      linked.hidden = true;
      // Restore the card label and quiet-row text in case they were changed
      add.querySelector('.lbl').textContent = 'Add a co-owner or helper';
      add.querySelector('.hint').textContent = 'Invite a co-owner to share your inventory, or a helper to assist with photos and documentation.';
      document.querySelectorAll('[data-go="householdlink"]').forEach(el => {
        if (el.closest('.quietrow')) el.textContent = 'Add a co-owner or helper';
        if (el.id === 'guidedAddPartner' || el.closest('.onboarding-tiles')) {
          el.style.display = '';
        }
      });
    }
  } catch {
    add.hidden = true;
    linked.hidden = true;
  }
}

async function renderCounters() {
  let items = [];
  try { ({ items } = await api('/api/items')); } catch { return; }
  const box = $('#homeCounters');
  if (!items.length) { box.hidden = true; return; }

  // Step 5: fetch memorandum conflicts so the Home counter can show them.
  const conflictRes = await api('/api/memorandum/conflicts').catch(() => ({ conflicts: [] }));
  const conflictCount = (conflictRes.conflicts || []).length;
  const conflictBox = $('#homeConflictCounter');
  if (conflictBox) {
    if (conflictCount > 0) {
      conflictBox.hidden = false;
      $('#cntConflict').textContent = String(conflictCount);
    } else {
      conflictBox.hidden = true;
    }
  }

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

  // Ship B \u2014 if the contested-categories screen pre-set cap.category
  // before jumping here, visually press the matching chip so the owner sees
  // it is already selected. If the chip is not on today's list yet (a
  // MORE_CATEGORIES entry), promote it now; addOfferedCategory selects it.
  if (cap && cap.category) {
    const match = $$('#catChips .chip').find((c) => c.dataset.cat === cap.category);
    if (match) match.setAttribute('aria-pressed', 'true');
    else if ((registry.more_categories ?? []).includes(cap.category)) {
      addOfferedCategory(cap.category);
    }
  }

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
/** When a room is already selected, hide the room picker and show a breadcrumb
 *  with a "Change room" link. The owner is photographing items one after another
 *  in the same room — they do not need to see the full room list each time. */
function updateRoomLockUI() {
  const chips = $('#roomChips');
  const other = $('#capRoomOther');
  const moreWrap = $('#roomMoreWrap');
  const section = chips?.closest('.cap-section');
  if (!section) return;
  const locked = !!cap.room;
  // Toggle "Save & take another" visibility based on room lock
  const anotherBtn = $('#stepNextAnother');
  if (anotherBtn) anotherBtn.hidden = !locked;
  if (locked) {
    // Show a breadcrumb instead of the full picker
    const label = section.querySelector('.fieldlabel');
    if (label) label.innerHTML = `Room: <strong>${escapeHtml(cap.room)}</strong> `
      + '<button class="linky" id="capChangeRoom" style="font-size:0.85rem">Change room</button>'
      + '<button class="linky" id="capRoomDone" style="font-size:0.85rem;margin-left:8px">This room is finished</button>';
    chips.hidden = true;
    if (other) other.hidden = true;
    if (moreWrap) moreWrap.hidden = true;
    $('#capChangeRoom')?.addEventListener('click', () => {
      cap.room = '';
      chips.hidden = false;
      if (other) other.hidden = false;
      renderRoomChips();
    });
    $('#capRoomDone')?.addEventListener('click', () => {
      cap.room = '';
      go('home');
    });
  } else {
    // Show the full picker
    const label = section.querySelector('.fieldlabel');
    if (label) label.textContent = 'Where is it kept?';
    chips.hidden = false;
  }
}

function renderRoomChips() {
  // Filter rooms by active site (null = primary/home)
  const siteRooms = registry.rooms.filter((r) => {
    if (activeSiteId) return r.site_id === activeSiteId || (r.site_id == null && activeSiteId === null);
    return r.site_id == null || r.site_id === undefined;
  });
  const mine = siteRooms.filter((r) => r.is_custom);
  const standard = siteRooms.filter((r) => !r.is_custom);
  const chip = (r) => `<button class="chip${r.is_custom ? ' chip-mine' : ''}" aria-pressed="false"`
    + ` data-room="${escapeHtml(r.name)}">${escapeHtml(r.name)}</button>`;
  $('#roomChips').innerHTML = [...mine, ...standard].map(chip).join('');

  $$('#roomChips .chip').forEach((b) => {
    b.onclick = () => {
      $$('#roomChips .chip').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      cap.room = b.dataset.room;
      updateRoomLockUI();
    };
  });
  // Pre-select the room carried over from a previous capture so "Take
  // another photo" stays in the same room without the owner re-picking it.
  if (cap?.room) {
    const pre = $$('#roomChips .chip').find((c) => c.dataset.room === cap.room);
    if (pre) pre.setAttribute('aria-pressed', 'true');
  }
  updateRoomLockUI();

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

// ---- ADMIN: LICENSE KEYS ----

async function loadAdminLicenses() {
  // Determine role from session
  let role = '';
  try {
    const hl = await api('/api/household-link');
    const me = (hl?.participants || []).find((p) => p.is_me);
    if (me) role = me.role;
  } catch {}
  // Only owners/co-owners see the admin tile and can generate keys
  const isOwner = role === 'owner' || role === 'bootstrap-owner' || role === 'partner';
  const adminTile = $('#adminTile');
  if (adminTile) adminTile.hidden = !isOwner;
  loadLicenseList();
}

async function showAdminTile() {
  let role = '';
  try {
    const hl = await api('/api/household-link');
    const me = (hl?.participants || []).find((p) => p.is_me);
    if (me) role = me.role;
  } catch {}
  const isOwner = role === 'owner' || role === 'bootstrap-owner' || role === 'partner';
  const adminTile = $('#adminTile');
  if (adminTile) adminTile.hidden = !isOwner;
}

// Video capture feature flag — fetched once on load, applied to all video tiles/lanes.
// When OFF (default), video tiles are hidden. When ON (admin-toggled), owners can
// record room walkthroughs and AI analyzes extracted frames.
let videoCaptureEnabled = false;

async function applyVideoFlag() {
  try {
    const data = await api('/api/admin/feature-flags');
    videoCaptureEnabled = data?.effective?.videoCapture === true;
  } catch {
    // If the call fails (e.g. not owner), leave video hidden
    videoCaptureEnabled = false;
  }
  document.querySelectorAll('[data-video-tile]').forEach((el) => { el.hidden = !videoCaptureEnabled; });
  document.querySelectorAll('[data-video-lane]').forEach((el) => { el.hidden = !videoCaptureEnabled; });
}

async function loadLicenseList() {
  const box = $('#licenseList');
  box.innerHTML = '<p style="color:var(--muted)">Loading...</p>';
  try {
    const data = await api('/api/admin/licenses');
    if (!data.licenses || data.licenses.length === 0) {
      box.innerHTML = '<p style="color:var(--muted)">No license keys generated yet. Use the form below to create one.</p>';
      return;
    }
    const rows = data.licenses.map((l) => {
      const exp = l.license_expires_at ? new Date(l.license_expires_at).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '—';
      const slots = l.license_pool_slots || 0;
      const created = l.created_at ? new Date(l.created_at).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '—';
      return '<div style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:12px">'
        + '<div style="font-family:monospace;font-size:12px;color:var(--primary);font-weight:600;word-break:break-all">' + escapeHtml(l.license_key || '') + '</div>'
        + '<div style="font-size:11px;color:var(--muted);margin-top:6px">'
        + '<span>Status: <b>' + escapeHtml(l.status || 'active') + '</b></span> · '
        + '<span>Expires: <b>' + exp + '</b></span>'
        + (slots > 0 ? ' · <span>Pool slots: <b>' + slots + '</b></span>' : '')
        + ' · <span>Created: ' + created + '</span>'
        + '</div></div>';
    }).join('');
    box.innerHTML = '<h3 style="margin:0 0 12px;font-size:1rem">Current keys</h3>' + rows;
  } catch (e) {
    box.innerHTML = '<p style="color:var(--destructive)">Could not load keys: ' + escapeHtml(e.message) + '</p>';
  }
}

async function loadFeatureFlags() {
  const box = $('#flagList');
  if (!box) return;
  box.innerHTML = '<p style="color:var(--muted)">Loading...</p>';
  try {
    const data = await api('/api/admin/feature-flags');
    const flags = data.flags || {};
    const toggleable = [
      { key: 'videoCapture', label: 'Video capture', hint: 'Let owners record room walkthroughs. AI analyzes frames to identify items.' },
      { key: 'heirVisibility', label: 'Heir visibility restrictions', hint: 'Hide private data (pricing, recipient, ownership) from heirs in Discovery and FairPlay.' },
    ];
    box.innerHTML = toggleable.map((f) => {
      const on = flags[f.key] === true;
      return '<div style="border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:12px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center">'
        + '<div><b>' + escapeHtml(f.label) + '</b><br><span style="font-size:12px;color:var(--muted)">' + escapeHtml(f.hint) + '</span></div>'
        + '<button class="' + (on ? 'primary' : 'ghost') + '" data-flag-toggle="' + f.key + '" style="min-width:80px">' + (on ? 'ON' : 'OFF') + '</button>'
        + '</div></div>';
    }).join('');
    $$('#flagList [data-flag-toggle]').forEach((btn) => {
      btn.onclick = async () => {
        const flag = btn.dataset.flagToggle;
        const current = flags[flag] === true;
        try {
          btn.disabled = true;
          const res = await api('/api/admin/feature-flags', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ flag, value: !current }),
          });
          toast(res.message || (flag + ' is now ' + (!current ? 'ON' : 'OFF')));
          await loadFeatureFlags();
          await applyVideoFlag();
        } catch (e) {
          toast(e.message, true);
        } finally {
          btn.disabled = false;
        }
      };
    });
  } catch (e) {
    box.innerHTML = '<p style="color:var(--muted)">Could not load feature flags.</p>';
  }
}

$('#generateLicenseBtn')?.addEventListener('click', async () => {
  const btn = $('#generateLicenseBtn');
  btn.disabled = true;
  btn.textContent = 'Generating...';
  const result = $('#licenseResult');
  result.hidden = false;
  result.innerHTML = 'Generating...';
  try {
    const duration = parseInt($('#licenseDuration').value, 10) || 90;
    const slots = parseInt($('#licenseSlots').value, 10) || 0;
    const data = await api('/api/admin/generate-license', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ duration_days: duration, license_pool_slots: slots }),
    });
    const exp = new Date(data.expires_at).toLocaleDateString('en-US', { dateStyle: 'long' });
    result.innerHTML = '<div style="border:1.5px solid var(--primary);border-radius:8px;padding:16px;background:var(--card)">'
      + '<p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)">License key generated</p>'
      + '<p style="margin:0 0 12px;font-family:monospace;font-size:14px;font-weight:bold;color:var(--primary);word-break:break-all">' + escapeHtml(data.license_key) + '</p>'
      + '<p style="margin:0 0 8px;font-size:13px">Valid through: <b>' + exp + '</b>' + (data.slots ? ' · Pool slots: <b>' + data.slots + '</b>' : '') + '</p>'
      + '<p style="margin:12px 0 0;font-size:13px;color:var(--muted)">Print the attorney/trustee letter to deliver this key with the estate documents. The letter is marked privileged and confidential — not for probate filing.</p>'
      + '</div>'
      + '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">'
      + '<button class="primary" onclick="window.open(\'' + API + '/api/admin/license-letter\', \'_blank\')">Print attorney/trustee letter</button>'
      + '<button class="ghost" onclick="navigator.clipboard.writeText(\'' + data.license_key + '\');this.textContent=\'Copied!\'">Copy key</button>'
      + '</div>';
    loadLicenseList();
  } catch (e) {
    result.innerHTML = '<p style="color:var(--destructive)">Failed to generate key: ' + escapeHtml(e.message) + '</p>';
  }
  btn.disabled = false;
  btn.textContent = 'Generate license key';
});

$('#adminBackBtn')?.addEventListener('click', () => go('home'));

// ------------------------------------------------------------------- boot
(async function boot() {
  try {
  registry = await api('/api/registry');
  resetCapture();
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

  // Determine the user's role so we can land them on the right page.
  // Owners and co-owners (partners) see the full welcome + onboarding flow.
  // Helpers (assistants) get a simpler landing page without owner options.
  myRole = 'owner';  // set global from boot
  try {
    const hl = await api('/api/household-link');
    const me = (hl?.participants || []).find((p) => p.is_me);
    if (me) myRole = me.role;
  } catch {}

  let landing;
  if (myRole === 'assistant') {
    // Helpers skip the owner welcome and onboarding — they go to a
    // simpler page or straight home if they already have items.
    landing = items.length === 0 ? 'helperwelcome' : 'home';
  } else if (myRole === 'partner') {
    // Co-owners (partners) get their own welcome that frames their role
    // — invited to help inventory and capture, with a practice item
    // before diving into the room walkthrough.
    landing = items.length === 0 ? 'recipientwelcome' : 'home';
  } else {
    // First-time owners see the "how it works" screen (take a practice
    // photo, see how AI identification works). Returning owners go
    // straight to the home screen — no need to re-explain the app.
    landing = items.length === 0 ? 'welcome' : 'home';
  }
  go(landing);
  } catch (e) {
    console.error('Boot failed:', e);
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="position:fixed;top:0;left:0;right:0;background:#c00;color:#fff;padding:16px;font-family:monospace;z-index:99999;white-space:pre-wrap">Boot error: ' + (e.stack || e.message || String(e)) + '</div>');
    go('welcome');
  }
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
  const siteQs = activeSiteId ? `?site_id=${encodeURIComponent(activeSiteId)}` : '';
  try {
    walk = await api('/api/walkthrough' + siteQs);
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

  // Show site name in the walk header if viewing a non-primary site
  const walkH = document.querySelector('.walkh');
  if (walkH) {
    const site = sitesList.find((s) => s.site_id === activeSiteId);
    walkH.textContent = site ? `${site.name} — your rooms` : 'Your rooms';
  }

  // Show the site bar with a "back to all places" button when in a non-primary site
  const siteBar = $('#walkSiteBar');
  if (siteBar) {
    const site = sitesList.find((s) => s.site_id === activeSiteId);
    if (site && !site.is_primary) {
      siteBar.hidden = false;
      const nameEl = $('#walkSiteName');
      if (nameEl) nameEl.textContent = site.name;
    } else {
      siteBar.hidden = true;
    }
  }
  $('#walkRooms').innerHTML = walk.rooms.map((r) => {
    const st = ROOM_STATUS[r.walkthrough_state] ?? ROOM_STATUS.not_started;
    const bits = [];
    if (r.item_count) bits.push(`${r.item_count} thing${r.item_count === 1 ? '' : 's'} named`);
    if (r.documented_at && !r.item_count) bits.push('recorded');
    return `<div class="roomrow-wrap ${st.cls}" data-room-id="${r.room_id}" data-room-name="${escapeHtml(r.name)}">
        <button class="roomrow ${st.cls}" data-room-id="${r.room_id}" data-room-name="${escapeHtml(r.name)}">
          <span class="roomrow-mark" aria-hidden="true">${st.mark}</span>
          <span class="roomrow-body">
            <span class="roomrow-name">${escapeHtml(r.name)}</span>
            <span class="roomrow-state">${st.word}${bits.length ? ` · ${bits.join(' · ')}` : ''}</span>
          </span>
        </button>
        <button class="roomrow-edit" data-room-id="${r.room_id}" data-room-name="${escapeHtml(r.name)}" title="Rename this room">&#9998;</button>
        <button class="roomrow-del" data-room-id="${r.room_id}" title="Remove this room">&times;</button>
      </div>`;
  }).join('');
  $$('#walkRooms .roomrow').forEach((b) => {
    b.onclick = () => openRoom(b.dataset.roomId, b.dataset.roomName);
  });
  $$('#walkRooms .roomrow-edit').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const roomId = btn.dataset.roomId;
      const oldName = btn.dataset.roomName;
      const wrap = btn.closest('.roomrow-wrap');
      // Replace the row with an inline edit field
      const nameEl = wrap.querySelector('.roomrow-name');
      nameEl.innerHTML = `<input type="text" class="roomrow-rename" value="${escapeHtml(oldName)}" style="font-size:20px;font-weight:650;border:1px solid var(--accent);border-radius:6px;padding:2px 6px;width:100%">`;
      const input = nameEl.querySelector('input');
      input.focus();
      input.select();
      const save = async () => {
        const newName = input.value.trim();
        if (!newName || newName === oldName) {
          nameEl.textContent = oldName;
          return;
        }
        try {
          await api(`/api/rooms/${roomId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: newName }) });
          wrap.dataset.roomName = newName;
          btn.dataset.roomName = newName;
          nameEl.textContent = newName;
          const r = walk.rooms.find((x) => x.room_id === roomId);
          if (r) r.name = newName;
          toast(`Renamed to "${newName}".`);
        } catch (err) {
          nameEl.textContent = oldName;
          toast(err.message || 'Could not rename room.', true);
        }
      };
      input.onblur = save;
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { nameEl.textContent = oldName; }
      };
    };
  });
  $$('#walkRooms .roomrow-del').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const roomId = btn.dataset.roomId;
      const row = btn.closest('.roomrow-wrap');
      const name = row.dataset.roomName;
      if (!confirm(`Remove "${name}" from your room list?`)) return;
      try {
        await api(`/api/rooms/${roomId}`, { method: 'DELETE' });
        row.remove();
        walk.rooms = walk.rooms.filter((r) => r.room_id !== roomId);
        toast(`Removed "${name}".`);
        renderWalk();
      } catch (err) {
        toast(err.message || 'Could not remove room — it may still have items in it.', true);
      }
    };
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
  const ask = $('#roomNextAsk'); if (ask) ask.hidden = true;
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
  // Show "Take more of the room" when photos have been taken and the room isn't finished
  const takeMore = $('#roomTakeMore');
  if (takeMore) takeMore.hidden = roomPending.length === 0 || room.finished;
  $('#roomCaptured').innerHTML = roomPending.map((p) => `
    <div class="capt">
      <p class="capt-line">${p.saved ? '✓ Saved' : '⏳ Held on this device'} — ${escapeHtml(p.label)}</p>
      ${autoDetectInFlight && !p.named ? '<p class="capt-note" style="margin:0">⏳ AI is looking through these photos… this can take a minute.</p>' : ''}
      ${p.frames?.length && !p.named && !autoDetectInFlight ? `<button class="ghost wide" data-name-these="${p.key}">Write down what is in it${p.frames.length ? ` (${p.frames.length} pictures)` : ''}</button>` : ''}
      ${p.named ? '<p class="capt-note" style="margin:0">✓ AI has named the items in these photos.</p>' : ''}
      ${p.saved ? '' : '<p class="capt-note">It will be sent when you next have internet.</p>'}
    </div>`).join('');
  // When items are already named in this room, show a hint to take close-ups
  if (named > 0 && roomPending.length === 0) {
    $('#roomCaptured').hidden = false;
    $('#roomCaptured').innerHTML += `
      <div class="capt" style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px">
        <p class="capt-note" style="margin:0">Want better detail? Take close-ups of individual things — AI will name them and skip anything already on your list.</p>
      </div>`;
  }
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
  roomSkippedDuplicates = null;
  try {
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), 150000);
    const { detections, vision_mode } = await api('/api/intake/detect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: giveUp.signal,
      body: JSON.stringify({
        images: entry.frames.map((dataUrl, i) => ({ data_url: dataUrl, frame_index: i, media_id: `${key}-${i}` })),
        room_hint: room.name,
      }),
    });
    clearTimeout(timer);
    batchFiles = entry.frames.map((dataUrl, i) => ({ _dataUrl: dataUrl, _frame: i }));
    entry.named = true;
    showNamingResults(detections, vision_mode);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * Auto-detect: runs AI identification automatically after room photos are captured,
 * without the owner needing to click "Write down what is in it." The photos are
 * already saved; this is the naming pass, started for them.
 */
async function autoDetectRoomPhotos(key) {
  if (autoDetectInFlight) return; // don't overlap two detection runs
  const entry = roomPending.find((p) => p.key === key);
  if (!entry?.frames?.length) return;
  if (!(await serverReachable())) {
    toast('Photos kept. AI naming will happen when you have internet.');
    showRoomNextAsk();
    return;
  }
  toast('Looking through your photos…');
  inRoomNaming = true;
  roomDupCount = 0;
  roomSkippedDuplicates = null;
  autoDetectInFlight = true;
  renderRoomState();
  try {
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), 150000);
    const { detections, vision_mode } = await api('/api/intake/detect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: giveUp.signal,
      body: JSON.stringify({
        images: entry.frames.map((dataUrl, i) => ({ data_url: dataUrl, frame_index: i, media_id: `${key}-${i}` })),
        room_hint: room.name,
      }),
    });
    clearTimeout(timer);
    batchFiles = entry.frames.map((dataUrl, i) => ({ _dataUrl: dataUrl, _frame: i }));
    entry.named = true;
    showNamingResults(detections, vision_mode);
  } catch (e) {
    toast('Photos are saved. AI naming did not work just now — try again later.', true);
    inRoomNaming = false;
    showRoomNextAsk();
  } finally {
    autoDetectInFlight = false;
    renderRoomState();
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
    $('#namingBack').onclick = () => { leaveNaming(); showRoomNextAsk(); };
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
    $('#namingBack').onclick = () => { leaveNaming(); showRoomNextAsk(); };
    return;
  }
  // If some items were skipped as duplicates, mention them before the gift ask
  if (roomSkippedDuplicates?.length) {
    const skippedList = roomSkippedDuplicates.map((s) => escapeHtml(s.label)).join(', ');
    $('#batchResults').innerHTML += `
      <div class="note" style="margin-top:1rem;padding:12px 16px;border:1px solid var(--border);border-radius:8px;background:var(--muted)">
        <p style="margin:0;font-size:13px;color:var(--muted)">
          <b>Skipped ${roomSkippedDuplicates.length} duplicate${roomSkippedDuplicates.length === 1 ? '' : 's'}:</b> ${skippedList}
          — already on your list.
        </p>
      </div>`;
    roomSkippedDuplicates = null;
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
  const { created, possible_duplicates, skipped_duplicates } = await api('/api/intake/commit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ detections: payload }),
  });
  // Mentioned once on the way out, as information. Never a task.
  if (possible_duplicates > 0) roomDupCount += possible_duplicates;
  // Track skipped duplicates for display in the results
  if (skipped_duplicates?.length) roomSkippedDuplicates = skipped_duplicates;
  // created is now [{item_id, detection_index}] — use the index to map back
  const createdIds = created.map((c) => c.item_id);
  await Promise.all(createdIds.map((id) => api(`/api/items/${id}/keep`, { method: 'POST' }).catch(() => {})));
  refreshCount();
  return created.map((c) => {
    const d = detections[c.detection_index] ?? {};
    return {
      item_id: c.item_id,
      label: d.label ?? 'Item',
      thumb: payload[c.detection_index]?.crop_data_url || batchFiles[d.frame_index ?? 0]?._dataUrl || '',
    };
  });
}

/** After photos are taken but AI didn't run (or found nothing), offer the owner
 *  the two paths Mark wants: add assigned items, or move to the next room. */
function showRoomNextAsk() {
  const ask = $('#roomNextAsk');
  if (!ask) return;
  ask.hidden = false;
  const assignBtn = $('#roomNextAssign');
  const nextRoomBtn = $('#roomNextRoom');
  if (assignBtn) assignBtn.onclick = () => {
    ask.hidden = true;
    // Enter the gift-designation flow — same path as the "Items already
    // designated" tile, but pre-filled with this room.
    promiseMode = true;
    resetCapture();
    go('capture');
    if (room?.name) {
      cap.room = room.name;
      const chip = $$('#roomChips .chip').find((c) => c.dataset.room === room.name);
      if (chip) chip.classList.add('sel');
    }
    renderCapture();
  };
  if (nextRoomBtn) nextRoomBtn.onclick = () => {
    ask.hidden = true;
    setRoomFinished('done');
  };
}

/** The one question. Asked about the room, once, and never repeated.
 *  Not about gift assignment — that is a separate flow. This is about the
 *  owner's eye: did anything in this room catch their attention as important?
 *  If yes, they take a close-up. The close-up makes it important by default,
 *  asks for details, and AI identifies the item from the close-up photo.
 */
function renderRoomGiftAsk(added, again = false) {
  const n = added.length;
  $('#batchResults').innerHTML = `
    ${again ? '' : `<h2>${n} thing${n === 1 ? '' : 's'} in the ${escapeHtml(room?.name ?? 'room')}
      ${n === 1 ? 'is' : 'are'} on your list</h2>
    <p class="reassure">That part is done. They are written down and they will print.</p>`}
    <div class="ask">
      <p class="askq">${again
        ? 'Did anything else catch your eye as important in this room?'
        : 'Did anything catch your eye as important in this room?'}</p>
      <p class="reassure" style="font-size:0.85rem;margin-top:4px">Take a close-up photo of it. That marks it as important, asks for details, and AI will help identify what it is.</p>
      <button class="primary wide" id="giftYes">Yes — something caught my eye</button>
      <button class="ghost wide" id="giftNo">${again ? 'No — that is everything' : 'No — on to the next room'}</button>
    </div>`;
  $('#giftNo').onclick = async () => { await leaveNaming(); setRoomFinished('done'); };
  $('#giftYes').onclick = () => {
    leaveNaming();
    resetCapture();
    if (room?.name) cap.room = room.name;
    cap.preSetImportant = true;
    roomImportantFlow = true;
    go('capture');
    toast('Take a close-up of the item that caught your eye. AI will help identify it.');
  };
}


/** Assignment form for an important item from the room flow. */
function renderAssignForm(savedItem, savedRoom) {
  $('#batchResults').innerHTML = `
    <h2>Who is this for?</h2>
    <div class="chips" id="assignChips"></div>
    <input type="text" id="assignName" class="bigin" placeholder="A name">
    <input type="text" id="assignRel" class="bigin" placeholder="Relationship, for example: daughter">
    <button class="primary wide" id="assignSave">Save this</button>
    <p class="reassure">This is a wish, not a legal instruction. You can change it any time.</p>
    <button class="ghost wide" id="assignCancel">Never mind — just flag as important</button>`;
  const chips = $('#assignChips');
  if (chips) {
    chips.innerHTML = people.filter((p) => !p.archived).map((p) =>
      `<button class="chip" data-pick="${escapeHtml(p.name)}" data-rel="${escapeHtml(p.relationship ?? '')}" aria-pressed="false">${escapeHtml(p.name)}${p.relationship ? ` <span class="chiprel">${escapeHtml(p.relationship)}</span>` : ''}</button>`).join('');
    $$('#assignChips .chip').forEach((c) => {
      c.onclick = () => {
        $$('#assignChips .chip').forEach((o) => o.setAttribute('aria-pressed', 'false'));
        c.setAttribute('aria-pressed', 'true');
        $('#assignName').value = c.dataset.pick;
        $('#assignRel').value = c.dataset.rel || '';
      };
    });
  }
  $('#assignCancel').onclick = async () => {
    await leaveNaming();
    renderRoomImportantAsk(savedRoom);
  };
  $('#assignSave').onclick = async () => {
    const name = $('#assignName').value.trim();
    if (!name) return toast('Please put in a name, or press Never mind.', true);
    const rel = $('#assignRel').value.trim();
    $('#assignSave').disabled = true;
    try {
      await api(`/api/items/${savedItem.item_id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipient_hint: { recipient_name: name, relationship: rel, owner_note: '' } }),
      });
      try { await addPerson(name, rel, 'from_item'); } catch {}
      toast(`That is for ${name}.`);
      await leaveNaming();
      renderRoomImportantAsk(savedRoom);
    } catch (e) {
      $('#assignSave').disabled = false;
      toast(e.message, true);
    }
  };
}

/** After saving an important item, ask if there is anything else important,
 *  or finish the room. */
function renderRoomImportantAsk(savedRoom) {
  go('batch');
  const intake = $('#batchIntake'); if (intake) intake.hidden = true;
  $('#batchResults').innerHTML = `
    <h2>Anything else in the ${escapeHtml(savedRoom ?? 'room')} that caught your eye?</h2>
    <div class="ask">
      <button class="primary wide" id="impYes">Yes — take another close-up</button>
      <button class="ghost wide" id="impNo">No — this room is done</button>
    </div>`;
  $('#impYes').onclick = () => {
    resetCapture();
    if (room?.name) cap.room = room.name;
    cap.preSetImportant = true;
    roomImportantFlow = true;
    go('capture');
    toast('Take a close-up of the next item.');
  };
  $('#impNo').onclick = async () => {
    await leaveNaming();
    setRoomFinished('done');
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
  roomSkippedDuplicates = null;
  if (roomDupCount > 0) {
    const n = roomDupCount;
    roomDupCount = 0;
    toast(`Saved. ${n === 1 ? 'One thing' : `${n} things`} may already be on your list — `
      + 'you can check that any time under My items, or leave it.');
  }
}

/* ------------------------------------------------------- finishing a room */

async function setRoomFinished(state) {
  const ask = $('#roomNextAsk'); if (ask) ask.hidden = true;
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
  const ask = $('#roomNextAsk'); if (ask) ask.hidden = true;
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

// "All places" button on the walk screen — returns to home and
// scrolls to the sites section so the owner can pick another site.
$('#walkSiteBack')?.addEventListener('click', () => {
  activeSiteId = null;
  go('home');
  // Scroll to the sites section after the home screen renders
  setTimeout(() => {
    const ss = $('#homeSitesSection');
    if (ss && !ss.hidden) ss.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
});

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
      body: JSON.stringify({ name, site_id: activeSiteId || null }),
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

// "Take more of the room" — re-opens the photo picker so the owner can add
// another batch without leaving the room screen.
$('#roomTakeMore')?.addEventListener('click', () => $('#roomPhotos').click());

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
  // Auto-trigger AI detection — the owner took photos to get things written down,
  // not to click another button. If offline or AI fails, the photos are still saved.
  if (entry.frames.length > 0) {
    autoDetectRoomPhotos(key);
  } else {
    toast('Photos kept. They will be named when you have internet.');
  }
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

/* =========================================================================
 * SPECIAL GIFTS BY NAME (the addendum family)
 *
 * State
 *   giftsState.heirs           full list from /api/two-outputs/heirs
 *   giftsState.preview         GET /api/two-outputs/addendum/preview
 *   giftsState.editing         null | heir_id being edited on giftperson screen
 *   giftsState.newKind         'heir' | 'named_recipient' when adding
 *   giftsState.trustees        for the trustee <select> on sign screen
 *
 * "Heirs" and "named_recipients" live in the same DB table because the app
 * has to reason about both as `recipient_type`. The UI shows them as two
 * lists to keep the mental model clean: heirs are the will's people;
 * named-recipients are everybody else the owner wants to name.
 * ========================================================================= */

// The Registry is a single-owner app. `resolveScope()` on the server sets
// actorId to 'owner', so the twoOutputsRouter accepts 'owner' as a stable
// owner_participant_id for a Registry install. FairPlay, by contrast,
// derives this from the signed-in administrator's participant record.
const REGISTRY_OWNER_PARTICIPANT_ID = 'owner';

const giftsState = {
  heirs: [],
  preview: null,
  editing: null,
  newKind: 'heir',
  trustees: [],
  allItems: [],
};

async function loadGifts() {
  try {
    const [heirsRes, previewRes, itemsRes] = await Promise.all([
      api('/api/two-outputs/heirs'),
      api(`/api/two-outputs/addendum/preview?owner_participant_id=${encodeURIComponent(REGISTRY_OWNER_PARTICIPANT_ID)}`).catch(() => null),
      // Item list is used to find important-but-unassigned items \u2014 the
      // "Still to decide" nudge on the roster and the sign screen.
      api('/api/items').catch(() => ({ items: [] })),
    ]);
    giftsState.heirs = heirsRes.heirs ?? [];
    giftsState.preview = previewRes ?? { items: [], gaps: [], counts: { assigned_items: 0 } };
    giftsState.allItems = itemsRes.items ?? [];
    renderGiftsRoster();
    renderGiftsStillToDecide();
    updateGiftsTileHint();
  } catch (e) {
    toast(`Could not load your list: ${e.message}`, true);
  }
}

function updateGiftsTileHint() {
  const hint = $('#giftsTileHint');
  if (!hint) return;
  const n = giftsState.heirs.length;
  const assigned = giftsState.preview?.counts?.assigned_items ?? 0;
  if (n === 0) hint.textContent = 'Say who a particular thing is for. Friends and charities count too, not only heirs';
  else if (assigned === 0) hint.textContent = `${n} ${n === 1 ? 'person' : 'people'} on the list, nothing given to them yet`;
  else hint.textContent = `${assigned} thing${assigned === 1 ? '' : 's'} promised to ${n} ${n === 1 ? 'person' : 'people'}`;
}

// Group items by the person they are assigned to. The preview endpoint
// already tells us who each item is going to; we group client-side so a
// stale bit of preview doesn't lose a freshly-edited assignment.
function itemsByHeir() {
  const buckets = new Map();
  for (const it of giftsState.preview?.items ?? []) {
    const id = it.assigned_to?.heir_id;
    if (!id) continue;
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(it);
  }
  return buckets;
}

function renderGiftsRoster() {
  const byHeir = itemsByHeir();

  const heirs = giftsState.heirs.filter((h) => (h.recipient_type || 'heir') === 'heir');
  const named = giftsState.heirs.filter((h) => h.recipient_type === 'named_recipient');

  const paint = (list, boxSel, emptyMsg) => {
    const box = $(boxSel);
    if (!list.length) {
      box.innerHTML = `<p class="reassure" style="margin:0">${emptyMsg}</p>`;
      return;
    }
    box.innerHTML = list.map((h) => {
      const items = byHeir.get(h.heir_id) ?? [];
      const rel = h.relationship ? ` <span class="personrel">${escapeHtml(h.relationship)}</span>` : '';
      const count = items.length
        ? `${items.length} thing${items.length === 1 ? '' : 's'}`
        : 'nothing yet';
      return `
        <button class="personrow giftrow" data-heir="${escapeHtml(h.heir_id)}">
          <span class="personwho">
            <span class="personname">${escapeHtml(h.name)}</span>${rel}
          </span>
          <span class="personcount">${count}</span>
        </button>`;
    }).join('');
    $$(`${boxSel} [data-heir]`).forEach((b) => {
      b.onclick = () => openGiftPerson(b.dataset.heir);
    });
  };

  paint(heirs, '#giftsHeirs',
    'Nobody added yet. Add the first heir with "Add somebody" above.');
  paint(named, '#giftsNamed',
    'Nobody added yet. Use "Add somebody" if you want to leave a specific item to a friend, a godchild, or a charity.');
}

// Items the owner has flagged Important but not yet assigned to anyone.
// A soft nudge, never a wall.
function renderGiftsStillToDecide() {
  const box = $('#giftsStillToDecide');
  if (!box) return;
  // We compute this from the item list itself, not preview.gaps. Gaps are
  // items that ARE assigned but had a missing closeup or dead heir_id;
  // "still to decide" is a different concept: important but unassigned.
  const importantUnassigned = (giftsState.allItems ?? [])
    .filter((it) => (it.important === 1 || it.important === true)
      && !it.assigned_to_heir_id
      && it.deleted_at == null);
  if (!importantUnassigned.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const rows = importantUnassigned.slice(0, 8).map((it) => `
    <li><button class="linky" data-decide="${escapeHtml(it.item_id)}">${escapeHtml(it.title || 'Untitled item')}</button></li>
  `).join('');
  const extra = importantUnassigned.length > 8 ? `<p class="reassure">\u2026 and ${importantUnassigned.length - 8} more.</p>` : '';
  box.innerHTML = `
    <h3>Still to decide</h3>
    <p class="reassure">You marked these Important but haven't said who they are for. That is fine \u2014 you can leave them for the game
    to decide, or come back and name someone later.</p>
    <ul class="still-list">${rows}</ul>
    ${extra}`;
  $$('#giftsStillToDecide [data-decide]').forEach((b) => {
    b.onclick = () => go('detail', { item_id: b.dataset.decide });
  });
}

/* ---- One-person editor ---- */

function resetGiftPerson() {
  giftsState.editing = null;
  giftsState.newKind = 'heir';
  $('#giftPersonHeading').textContent = 'Add somebody';
  $('#giftPersonName').value = '';
  $('#giftPersonRel').value = '';
  $('#giftPersonEmail').value = '';
  $('#giftPersonNotes').value = '';
  setGiftKind('heir');
  $('#giftPersonRemove').hidden = true;
  $('#giftPersonItems').hidden = true;
}

function openGiftPerson(heirId) {
  const h = giftsState.heirs.find((x) => x.heir_id === heirId);
  if (!h) return;
  giftsState.editing = heirId;
  $('#giftPersonHeading').textContent = h.name;
  $('#giftPersonName').value = h.name;
  $('#giftPersonRel').value = h.relationship || '';
  $('#giftPersonEmail').value = h.email || '';
  $('#giftPersonNotes').value = h.notes || '';
  setGiftKind(h.recipient_type || 'heir');
  $('#giftPersonRemove').hidden = false;
  renderGiftPersonItems(heirId);
  go('giftperson', { editing: true });
}

function setGiftKind(kind) {
  giftsState.newKind = kind;
  $$('#giftKindChips .chip').forEach((c) => {
    c.setAttribute('aria-pressed', c.dataset.kind === kind ? 'true' : 'false');
  });
}

function renderGiftPersonItems(heirId) {
  const items = (giftsState.preview?.items ?? []).filter((i) => i.assigned_to?.heir_id === heirId);
  const box = $('#giftPersonItems');
  const list = $('#giftPersonItemList');
  box.hidden = false;
  if (!items.length) {
    list.innerHTML = '<p class="reassure" style="margin:0">Nothing named for this person yet. '
      + 'Tap "Add items for this person" to pick some from your list.</p>';
    return;
  }
  list.innerHTML = items.map((it) => `
    <div class="giftitem">
      <div class="giftitem-title">${escapeHtml(it.title || 'Untitled item')}</div>
      ${it.room_name ? `<div class="giftitem-room">${escapeHtml(it.room_name)}</div>` : ''}
      <button class="linky" data-unassign="${escapeHtml(it.item_id)}">Not for them any more</button>
    </div>`).join('');
  $$('#giftPersonItemList [data-unassign]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Take this item off their list?\n\nThe item itself is not deleted, just unassigned.')) return;
      try {
        await api(`/api/items/${b.dataset.unassign}/assign`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ heir_id: null }),
        });
        await loadGifts();
        openGiftPerson(heirId);
        toast('Taken off their list.');
      } catch (e) { toast(e.message, true); }
    };
  });
}

$$('#giftKindChips .chip').forEach((c) => { c.onclick = () => setGiftKind(c.dataset.kind); });

$('#giftAddBtn').onclick = () => { resetGiftPerson(); go('giftperson'); };
$('#giftSignBtn').onclick = () => go('giftsign');
$('#giftVersionsBtn').onclick = () => go('giftversions');
$('#giftPersonCancel').onclick = () => go('gifts');

$('#giftPersonSave').onclick = async () => {
  const name = $('#giftPersonName').value.trim();
  if (!name) { toast('Please write their name first.', true); return; }
  const body = {
    name,
    relationship: $('#giftPersonRel').value.trim(),
    email: $('#giftPersonEmail').value.trim(),
    notes: $('#giftPersonNotes').value.trim(),
    recipient_type: giftsState.newKind,
  };
  try {
    if (giftsState.editing) {
      await api(`/api/two-outputs/heirs/${giftsState.editing}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      toast('Saved.');
    } else {
      await api('/api/two-outputs/heirs', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      toast('Added to your list.');
    }
    await loadGifts();
    go('gifts');
  } catch (e) { toast(e.message, true); }
};

$('#giftPersonRemove').onclick = async () => {
  if (!giftsState.editing) return;
  const h = giftsState.heirs.find((x) => x.heir_id === giftsState.editing);
  if (!h) return;
  if (!confirm(`Take ${h.name} off your list?\n\nYou can only remove someone with no items assigned to them. If they have items, unassign those first.`)) return;
  try {
    await api(`/api/two-outputs/heirs/${giftsState.editing}`, { method: 'DELETE' });
    toast('Removed.');
    await loadGifts();
    go('gifts');
  } catch (e) { toast(e.message, true); }
};

/* ---- Confirm your choices (was: Sign the memorandum) ---- */

async function loadGiftSign() {
  $('#giftSignError').hidden = true;
  // The single confirmation input. There used to be a separate "your full
  // legal name" input here \u2014 it was removed when we collapsed the sign
  // screen to one box, because the app already knows the owner's name
  // from their account and the printed paper carries the handwritten
  // signature. See docs/handoffs/2026-08-09-sign-copy-v3.md.
  $('#giftSignerAck').value = '';
  await loadTrusteesForSign();
  try {
    const preview = await api(`/api/two-outputs/addendum/preview?owner_participant_id=${encodeURIComponent(REGISTRY_OWNER_PARTICIPANT_ID)}`);
    giftsState.preview = preview;
    renderGiftSignSummary(preview);
    renderGiftSignItems(preview);
    renderGiftsStillToDecide();
  } catch (e) {
    // The two most common blockers are "no items assigned yet" and
    // "no wills caretaker or trustee on file". Surface both plainly
    // instead of the raw error, and keep the trustee picker visible so
    // the owner has somewhere to go next.
    giftsState.preview = null;
    const msg = String(e.message || '');
    const noRecip = /caretaker or trustee/i.test(msg);
    const noItems = /no items assigned/i.test(msg);
    const detail = noRecip
      ? 'You need one wills caretaker or trustee on file before you can confirm your list. Add one in the Trustee section, then come back.'
      : noItems
        ? 'You have not added anything to your list of special gifting yet. Go back and assign at least one thing to a person on your list.'
        : msg;
    $('#giftSignSummary').innerHTML = `<div class="sign-box" style="border-color:#c68a2b;background:#fff7e6"><div class="sign-line">${escapeHtml(detail)}</div></div>`;
    $('#giftSignItems').innerHTML = '';
    renderGiftsStillToDecide();
  }
}

async function loadTrusteesForSign() {
  try {
    const res = await api('/api/two-outputs/wills-caretakers');
    giftsState.trustees = res.wills_caretakers ?? res.people ?? [];
    const sel = $('#giftSignerTrustee');
    sel.innerHTML = '<option value="">\u2014 choose or leave blank \u2014</option>'
      + giftsState.trustees.map((t) => `<option value="${escapeHtml(t.wills_caretaker_id ?? t.person_id ?? '')}">${escapeHtml(t.name)}${t.relationship ? ' \u2014 ' + escapeHtml(t.relationship) : ''}</option>`).join('');
  } catch { /* trustee list is optional context */ }
}

function renderGiftSignSummary(preview) {
  // The server returns { envelope, nextVersion, supersedesVersion, gaps }.
  // Items live under envelope.items.
  const items = preview?.envelope?.items ?? [];
  const heirIds = new Set(items.map((i) => i.assigned_to?.heir_id).filter(Boolean));
  $('#giftSignSummary').innerHTML = `
    <div class="sign-box">
      <div class="sign-line"><b>${items.length}</b> item${items.length === 1 ? '' : 's'} going to
        <b>${heirIds.size}</b> ${heirIds.size === 1 ? 'person' : 'people'}</div>
      <div class="sign-line reassure">If you confirm now, that is what your trustee will see.</div>
    </div>`;
}

function renderGiftSignItems(preview) {
  const items = preview?.envelope?.items ?? [];
  const box = $('#giftSignItems');
  if (!items.length) {
    box.innerHTML = `<p class="reassure" style="margin:0">
      There is nothing to sign yet. Go back and assign at least one thing to a person on your list, then come back.</p>`;
    return;
  }
  // Group by recipient for readability.
  const byId = new Map();
  for (const it of items) {
    const id = it.assigned_to?.heir_id;
    if (!byId.has(id)) byId.set(id, { name: it.assigned_to?.name || 'Someone', rel: it.assigned_to?.relationship, kind: it.assigned_to?.recipient_type || 'heir', rows: [] });
    byId.get(id).rows.push(it);
  }
  const groups = [...byId.values()];
  box.innerHTML = groups.map((g) => {
    const kindLabel = g.kind === 'named_recipient' ? ' <span class="kind-badge">Named recipient</span>' : '';
    return `
      <div class="sign-group">
        <div class="sign-group-h">${escapeHtml(g.name)}${g.rel ? ` <span class="personrel">${escapeHtml(g.rel)}</span>` : ''}${kindLabel}</div>
        <ol class="sign-list">
          ${g.rows.map((it) => {
            // The envelope emits items as { id, name, room, ... }. The
            // registry's item list endpoint uses { title, room_name }.
            // Support both so the sign screen renders correctly whether
            // it is fed a preview or a raw list.
            const label = it.name || it.title || 'Untitled item';
            const roomName = it.room?.name || it.room_name || '';
            return `<li>${escapeHtml(label)}${roomName ? ` <span class="personrel">${escapeHtml(roomName)}</span>` : ''}</li>`;
          }).join('')}
        </ol>
      </div>`;
  }).join('');
}

$('#giftSignCancel').onclick = () => go('gifts');

$('#giftSignGo').onclick = async () => {
  const ack = $('#giftSignerAck').value.trim();
  // The dropdown labelled "Who is holding your will?" is populated from
  // the wills_caretakers endpoint. Send it as caretaker_ids, not
  // trustee_id \u2014 the server treats those as different tables.
  const caretakerId = $('#giftSignerTrustee').value.trim();
  $('#giftSignError').hidden = true;

  // Validate the "type the phrase" evidence. We accept any case so the
  // owner is not blocked by a stray shift-key, but the words themselves
  // must match \u2014 that is the whole point of the acknowledgement.
  // One box, not two: the typed phrase itself is the confirmation.
  // The owner's identity is already established by the account; the
  // printed paper carries their handwritten name.
  if (ack.toLowerCase() !== 'these are my wishes today') {
    setSignError('Please type the phrase exactly: These are my wishes today');
    return;
  }
  const items = giftsState.preview?.envelope?.items ?? [];
  if (!items.length) { setSignError('There is nothing to confirm yet.'); return; }

  // A confirmation before an irreversible action, in plain words.
  if (!confirm(`Confirm your list of special gifting with these ${items.length} item${items.length === 1 ? '' : 's'}?\n\nA new version will be filed with today's date. You can always come back and confirm a new version \u2014 the newest one is the one that counts.`)) return;

  try {
    // The server route expects a structured `signature` object; the
    // typed-in acknowledgement is our evidence field.
    const res = await api('/api/two-outputs/addendum/sign', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner_participant_id: REGISTRY_OWNER_PARTICIPANT_ID,
        caretaker_ids: caretakerId ? [caretakerId] : [],
        signature: {
          // `device` is what the server requires as its minimum piece of
          // wet-ink evidence. We pass the browser user agent, so the
          // signed record shows what the owner was confirming on.
          device: navigator.userAgent || 'unknown',
          acknowledgement: ack,
          signed_at: new Date().toISOString(),
        },
      }),
    });
    toast(`Confirmed. Version ${res.version_number ?? 1} is on file.`);
    await loadGifts();
    go('giftversions');
  } catch (e) {
    setSignError(e.message);
  }
};

function setSignError(msg) {
  const el = $('#giftSignError');
  el.textContent = msg;
  el.hidden = false;
}

/* ---- Version history ---- */

async function loadGiftVersions() {
  try {
    const res = await api(`/api/two-outputs/addendum/versions?owner_participant_id=${encodeURIComponent(REGISTRY_OWNER_PARTICIPANT_ID)}`);
    const versions = res.versions ?? [];
    const empty = $('#giftVersionsEmpty');
    const list = $('#giftVersionsList');
    const offer = $('#emailPreviewOffer');
    if (!versions.length) {
      empty.hidden = false;
      list.innerHTML = '';
      if (offer) offer.hidden = true;
      return;
    }
    empty.hidden = true;
    await renderEmailPreviewOffer(versions);
    // Newest first; the current one is the newest that isn't superseded.
    // The store returns versions in some order; we sort newest-first by
    // signed_at and treat the highest version_number as current.
    const sorted = versions.slice().sort((a, b) =>
      (b.signed_at || '').localeCompare(a.signed_at || ''));
    const highest = Math.max(...sorted.map((v) => Number(v.version_number || 0)));
    list.innerHTML = sorted.map((v) => {
      const isCurrent = Number(v.version_number) === highest;
      const when = v.signed_at ? new Date(v.signed_at).toLocaleString() : 'unknown date';
      // Signed versions carry the item list under items_snapshot. There is
      // no separate "counts" block on version rows; we derive item count
      // from the snapshot length. The typed acknowledgement lives under
      // signature_evidence.acknowledgement ("These are my wishes today") \u2014
      // that is what the owner typed, and it is what stands in for a
      // handwritten signature at the moment of confirmation.
      const count = Array.isArray(v.items_snapshot) ? v.items_snapshot.length : (v.item_count ?? '\u2014');
      return `
        <div class="version-row ${isCurrent ? 'current' : 'superseded'}">
          <div class="version-h">
            <span class="version-v">Version ${escapeHtml(String(v.version_number || '?'))}</span>
            ${isCurrent ? '<span class="badge current">Current</span>' : '<span class="badge superseded">Superseded</span>'}
          </div>
          <div class="version-meta">Confirmed ${escapeHtml(when)}</div>
          <div class="version-meta">${count} item${count === 1 ? '' : 's'} covered</div>
          <button class="ghost wide" data-download="${escapeHtml(v.version_id || '')}">Download this version</button>
        </div>`;
    }).join('');
    $$('#giftVersionsList [data-download]').forEach((b) => {
      b.onclick = () => window.open(`/api/two-outputs/addendum/versions/${encodeURIComponent(b.dataset.download)}/file`, '_blank');
    });
  } catch (e) {
    toast(`Could not load past versions: ${e.message}`, true);
  }
}

/**
 * Populate the "Send an unsigned preview by email" offer block on the
 * versions screen.
 *
 * We only show the offer when:
 *   1. There is a current signed version that is not frozen (a frozen
 *      version means the trustee has already been handed the memorandum;
 *      re-sending a preview after that would confuse everyone).
 *   2. There is at least one wills caretaker on file with an email address
 *      AND delivery_method === 'email'. Caretakers set to signed_link or
 *      print_mail do not appear \u2014 they haven't asked for email delivery.
 *
 * The server also enforces both of those rules; this UI branch is just so
 * an elderly user is not offered a button that will refuse them.
 */
async function renderEmailPreviewOffer(versions) {
  const offer = $('#emailPreviewOffer');
  if (!offer) return;
  const highest = Math.max(...versions.map((v) => Number(v.version_number || 0)));
  const current = versions.find((v) => Number(v.version_number) === highest);
  if (!current || current.frozen_at) { offer.hidden = true; return; }
  let caretakers = [];
  try {
    const res = await api('/api/two-outputs/wills-caretakers');
    caretakers = (res.wills_caretakers ?? []).filter((c) =>
      c.delivery_method === 'email' && String(c.email || '').trim());
  } catch { caretakers = []; }
  if (!caretakers.length) { offer.hidden = true; return; }
  const sel = $('#emailPreviewRecipient');
  sel.innerHTML = caretakers.map((c) => {
    const label = c.firm ? `${c.name} (${c.firm}) \u2014 ${c.email}` : `${c.name} \u2014 ${c.email}`;
    return `<option value="${escapeHtml(c.caretaker_id)}">${escapeHtml(label)}</option>`;
  }).join('');
  offer.hidden = false;
  const btn = $('#emailPreviewSend');
  btn.onclick = async () => {
    const caretakerId = sel.value;
    if (!caretakerId) return;
    const chosen = caretakers.find((c) => c.caretaker_id === caretakerId);
    const label = chosen ? (chosen.firm ? `${chosen.name} (${chosen.firm})` : chosen.name) : 'this recipient';
    // Confirm because this is an outbound email \u2014 not irreversible in
    // any real sense, but the user should mean it.
    const okToSend = confirm(
      `Send an UNSIGNED PREVIEW of version ${current.version_number} to ${label}?\n\n` +
      `This is a courtesy, not a filing. The paper you sign by hand and get to them is what carries the weight.`
    );
    if (!okToSend) return;
    btn.disabled = true;
    try {
      const out = await api('/api/two-outputs/addendum/email-preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner_participant_id: REGISTRY_OWNER_PARTICIPANT_ID,
          caretaker_id: caretakerId,
        }),
      });
      toast(`Unsigned preview sent to ${out.recipient?.name || label}.`);
    } catch (e) {
      toast(`Could not send preview: ${e.message}`, true);
    } finally {
      btn.disabled = false;
    }
  };
}

/**
 * Find-or-create an heir by name, then assign the item to that heir.
 * Called from the capture flow when the owner ticks "Add this to my
 * special gifts". Falls back gracefully if the roster call fails \u2014
 * a broken addendum lookup must never break the item save.
 *
 * NOTE: this always creates the recipient as recipient_type='heir'.
 * The owner can promote to 'named_recipient' from the Special gifts
 * screen later. Doing it that way keeps the capture flow simple: one
 * screen, one question.
 */
async function assignItemToNamedRecipient(itemId, name, relationship) {
  const clean = String(name || '').trim();
  if (!clean) return;
  // Look for an existing heir by (case-insensitive) name.
  const list = await api('/api/two-outputs/heirs');
  const existing = (list.heirs || []).find(
    (h) => h.name.toLowerCase() === clean.toLowerCase(),
  );
  let heirId = existing?.heir_id;
  if (!heirId) {
    const created = await api('/api/two-outputs/heirs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: clean,
        relationship: (relationship || '').trim(),
        recipient_type: 'heir',
      }),
    });
    heirId = created.heir_id;
  }
  await api(`/api/items/${itemId}/assign`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ heir_id: heirId }),
  });
}

/**
 * Show/hide the "Add to my special gifts" block based on whether the
 * owner has typed or picked a name. Also updates the inline "puts <who>
 * and this item onto the memorandum" hint so the phrasing is concrete.
 */
function updateGiftBlockVisibility() {
  const block = $('#capGiftBlock');
  const who = $('#capGiftWho');
  const nameEl = $('#capRecipient');
  if (!block || !nameEl) return;
  const name = nameEl.value.trim();
  block.hidden = !name;
  if (who) who.textContent = name || 'this person';
}

// Wire up on load. The step becomes visible only when the owner reaches
// step 7, but the input is always in the DOM so `input` fires anywhere.
document.addEventListener('DOMContentLoaded', () => {
  const el = $('#capRecipient');
  if (el) el.addEventListener('input', updateGiftBlockVisibility);
}, { once: true });

/* ================================================================== */
/* Slice B \u2014 the memorandum writer.                                  */
/*                                                                     */
/* One place per partner to say who-gets-what. In couple mode each     */
/* partner has their own memorandum; this screen shows the caller     */
/* their own, and surfaces conflicts against the partner's latest.    */
/* The server does the heavy lifting \u2014 identity, versioning, and       */
/* conflict detection. This client only paints and gathers input.     */
/* ================================================================== */

/*
 * All memorandum-related state in one object so it's easy to reset
 * and easy to reason about while stepping through the screen. The
 * roster and item list are cached across mounts so the entry editor
 * opens instantly; loadMemo() refreshes them.
 */
const memoState = {
  draft: null,           // { participant_id, version, is_signed, entries: [...] }
  versions: [],          // list of my past signed versions
  partner: null,         // { participant_id, display_name } or null
  partnerLatest: null,   // partner's most recent signed version or null
  conflicts: [],         // raw conflicts array from /api/memorandum
  householdMode: 'solo',
  heirs: [],             // shared roster (heirs + named recipients)
  items: [],             // /api/items list, used by the item picker
  editing: null,         // in-flight entry being edited, or null for add
  pickedItemId: null,    // selection in the item picker
  pickedHeirId: null,    // selection in the heir chips
};

/*
 * Load everything the screen needs in parallel. Three independent GETs:
 *   \u2022 /api/memorandum          my draft, my versions, partner info, conflicts
 *   \u2022 /api/two-outputs/heirs   the roster (heirs + named recipients)
 *   \u2022 /api/items               the item list, for titles + the picker
 *
 * Each fetch tolerates its own failure so a slow items query does not
 * blank the whole screen. Errors are surfaced as toasts, not modals
 * \u2014 an elderly owner should never see a blocking dialog on mount.
 */
async function loadMemo() {
  try {
    const [memoRes, heirsRes, itemsRes] = await Promise.all([
      api('/api/memorandum'),
      api('/api/two-outputs/heirs').catch(() => ({ heirs: [] })),
      api('/api/items').catch(() => ({ items: [] })),
    ]);
    memoState.draft = memoRes.my_draft;
    memoState.versions = memoRes.my_versions ?? [];
    memoState.partner = memoRes.partner;
    memoState.partnerLatest = memoRes.partner_latest_signed;
    memoState.conflicts = memoRes.conflicts ?? [];
    memoState.householdMode = memoRes.household_mode || 'solo';
    memoState.heirs = heirsRes.heirs ?? [];
    memoState.items = itemsRes.items ?? [];
    renderMemo();
  } catch (e) {
    toast(`Could not open your memorandum: ${e.message}`, true);
  }
}

/*
 * Format the version chip.
 *   \u2022 v1 empty draft   \u2192 "Draft v1"
 *   \u2022 v2 signed        \u2192 "Signed v2 \u00b7 Aug 9, 2026"
 *   \u2022 vN unsigned      \u2192 "Draft v{N} \u2014 not yet signed"
 */
function memoVersionLabel() {
  const d = memoState.draft;
  if (!d) return '';
  if (d.is_signed) {
    const when = d.signed_at ? new Date(d.signed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    return `Signed v${d.version}${when ? ' \u00b7 ' + when : ''}`;
  }
  if (d.version > 1) return `Draft v${d.version} \u2014 not yet signed`;
  return 'Draft \u2014 not yet signed';
}

/*
 * Look up an item title by id from the cached items list. Falls back to a
 * short placeholder if the item was removed since the memorandum was written.
 */
function memoItemLabel(itemId) {
  const it = memoState.items.find((i) => i.item_id === itemId);
  if (!it) return '(item no longer on your list)';
  return it.title || NO_TITLE;
}

function memoItemRoomLabel(itemId) {
  const it = memoState.items.find((i) => i.item_id === itemId);
  return it?.room?.name || '';
}

/*
 * Look up a heir/named recipient by heir_id. Returns the name only.
 * Used both for entry rows and the conflict banner.
 */
function memoHeirLabel(heirId) {
  const h = memoState.heirs.find((x) => x.heir_id === heirId);
  if (!h) return '(person removed)';
  return h.name || '(unnamed)';
}

/*
 * Paint the whole writer screen from memoState. Called after every mount
 * and after every save/delete. Keep this idempotent so re-render is safe.
 */
function renderMemo() {
  const d = memoState.draft;
  // Page title uses the same plain-language label in both modes; the sub
  // line changes to reflect the couple-mode reality that partners keep
  // separate lists.
  $('#memoTitle').textContent = 'Specific gifts by name';
  $('#memoSub').textContent = memoState.householdMode === 'couple'
    ? 'Your personal list of who gets what. Your partner keeps a separate list.'
    : 'Tell your family which things go to particular people.';
  $('#memoVersion').textContent = memoVersionLabel();

  // Post-signing-edit banner \u2014 shown only when we're on v2+ AND the
  // current draft is unsigned. Owner's own words, locked copy.
  const showEdit = d && !d.is_signed && d.version > 1;
  $('#memoEditNotice').hidden = !showEdit;

  // Conflict banner. Only shown when there are real conflicts against the
  // partner's LATEST SIGNED version. If the partner hasn't signed yet,
  // conflicts is empty by construction on the server.
  renderMemoConflicts();

  // The rows. Empty state uses a soft dashed card, never an error.
  const box = $('#memoList');
  const entries = d?.entries ?? [];
  if (!entries.length) {
    box.innerHTML = `<div class="memo-empty">Nothing on your list yet. Tap <b>Add specific gift by name</b> above to name the first one.</div>`;
  } else {
    // Build a set of item_ids in conflict for quick lookup on each row.
    const conflictItemIds = new Set(memoState.conflicts.map((c) => c.item_id));
    box.innerHTML = entries.map((e) => {
      const inConflict = conflictItemIds.has(e.item_id);
      const heirName = e.assigned_to_heir_id ? memoHeirLabel(e.assigned_to_heir_id) : '(nobody named)';
      const room = memoItemRoomLabel(e.item_id);
      return `
        <button class="memo-row${inConflict ? ' conflict' : ''}" data-entry="${escapeHtml(e.entry_id)}">
          <span class="memo-row-item">${escapeHtml(memoItemLabel(e.item_id))}</span>
          <span class="memo-row-heir">For ${escapeHtml(heirName)}${room ? ` \u00b7 ${escapeHtml(room)}` : ''}</span>
          ${e.note ? `<span class="memo-row-note">\u201c${escapeHtml(e.note)}\u201d</span>` : ''}
          ${inConflict ? `<span class="memo-row-flag">Sort out</span>` : `<span class="memo-row-arrow">\u203a</span>`}
        </button>`;
    }).join('');
    $$('#memoList .memo-row').forEach((b) => {
      b.onclick = () => openMemoEntry(b.dataset.entry);
    });
  }

}

/*
 * Paint the gold conflict banner from memoState.conflicts. Copy is firm
 * but soft \u2014 the app never blocks signing; the trustee and the will
 * reading can still resolve everything. This banner only strongly
 * advises resolution before printing.
 */
function renderMemoConflicts() {
  const banner = $('#memoConflictBanner');
  const list = $('#memoConflictList');
  const conflicts = memoState.conflicts;
  if (!conflicts.length) { banner.hidden = true; return; }
  banner.hidden = false;
  const partnerName = memoState.partner?.display_name || 'your partner';
  const withWhom = memoState.partner?.display_name ? `with ${partnerName}` : 'with your partner';
  $('#memoConflictPartner').textContent = partnerName;
  $('#memoConflictH').textContent = conflicts.length === 1
    ? `One thing to sort out ${withWhom}`
    : `${conflicts.length} things to sort out ${withWhom}`;
  list.innerHTML = conflicts.map((c) => {
    const itemLabel = memoItemLabel(c.item_id);
    const myHeir = memoHeirLabel(c.participant_a_heir_id);
    const theirHeir = memoHeirLabel(c.participant_b_heir_id);
    return `<li><b>${escapeHtml(itemLabel)}</b> \u2014 you named <b>${escapeHtml(myHeir)}</b>, ${escapeHtml(partnerName)} named <b>${escapeHtml(theirHeir)}</b>.</li>`;
  }).join('');
}

/* ---------------------------- entry editor ----------------------- */

/*
 * Fresh-slate the entry editor. Called by go('memoentry') on a plain
 * navigation \u2014 the \`editing\` flag is set by openMemoEntry() when we
 * come in for an edit, and go() honours it by skipping this reset.
 */
function resetMemoEntry() {
  memoState.editing = null;
  memoState.pickedItemId = null;
  memoState.pickedHeirId = null;
  $('#memoEntryHeading').textContent = 'Add specific gift by name';
  $('#memoEntryItemSearch').value = '';
  $('#memoEntryItemPicked').hidden = true;
  $('#memoEntryNote').value = '';
  $('#memoEntryNoteCount').textContent = '0';
  // The Remove button is only meaningful when editing an existing row.
  // hidden=true on a button with an explicit inline style set elsewhere
  // will not always suffice, so wipe display too.
  const removeBtn = $('#memoEntryRemove');
  removeBtn.hidden = true;
  removeBtn.style.display = 'none';
  $('#memoEntryError').hidden = true;
  renderMemoEntryPickers();
}

/*
 * Open the editor for an existing entry. Looks the entry up from the
 * cached draft, fills the fields, shows the Remove button, and jumps
 * to the memoentry screen with the editing flag so go() doesn't reset.
 */
function openMemoEntry(entryId) {
  const entry = (memoState.draft?.entries ?? []).find((e) => e.entry_id === entryId);
  if (!entry) { toast('Could not find that entry \u2014 it may have been removed.', true); return; }
  memoState.editing = entry;
  memoState.pickedItemId = entry.item_id;
  memoState.pickedHeirId = entry.assigned_to_heir_id;
  go('memoentry', { editing: true });
  $('#memoEntryHeading').textContent = 'Edit this promise';
  $('#memoEntryItemSearch').value = '';
  $('#memoEntryNote').value = entry.note || '';
  $('#memoEntryNoteCount').textContent = String((entry.note || '').length);
  const removeBtn = $('#memoEntryRemove');
  removeBtn.hidden = false;
  removeBtn.style.display = '';
  $('#memoEntryError').hidden = true;
  renderMemoEntryPickers();
}

/*
 * Render both pickers: the item list (filtered by the search box) and
 * the heir chips. Also paints the "already picked" summary card once
 * the owner has chosen an item so the picker can scroll away.
 */
function renderMemoEntryPickers() {
  const search = ($('#memoEntryItemSearch').value || '').trim().toLowerCase();
  const box = $('#memoEntryItemList');
  const picked = memoState.pickedItemId;

  // Filter items. We include only "kept" items \u2014 the ones the owner has
  // decided to record. Rejected items should never show up in a promise.
  const kept = memoState.items.filter((i) => (i.review_state || 'kept') !== 'rejected');
  const list = search
    ? kept.filter((i) => (i.title || '').toLowerCase().includes(search))
    : kept;

  if (picked) {
    const it = memoState.items.find((i) => i.item_id === picked);
    const label = it?.title || memoItemLabel(picked);
    const room = it?.room?.name || '';
    $('#memoEntryItemPicked').hidden = false;
    $('#memoEntryItemPicked').innerHTML =
      `<b>${escapeHtml(label)}</b>${room ? ` \u00b7 ${escapeHtml(room)}` : ''}<button class="linky change" id="memoEntryChangeItem" type="button">Change</button>`;
    box.hidden = true;
    $('#memoEntryItemSearch').hidden = true;
    const changeBtn = $('#memoEntryChangeItem');
    if (changeBtn) changeBtn.onclick = () => {
      memoState.pickedItemId = null;
      renderMemoEntryPickers();
    };
  } else {
    $('#memoEntryItemPicked').hidden = true;
    box.hidden = false;
    $('#memoEntryItemSearch').hidden = false;
    if (!list.length) {
      box.innerHTML = `<div class="pickrow" style="cursor:default">No items match. Try a different word, or add the item first from the Home screen.</div>`;
    } else {
      box.innerHTML = list.slice(0, 40).map((i) => `
        <button type="button" class="pickrow" data-item="${escapeHtml(i.item_id)}">
          ${escapeHtml(i.title || NO_TITLE)}
          <span class="pickrow-sub">${escapeHtml(i.room?.name || 'No room')}${i.category?.name ? ` \u00b7 ${escapeHtml(i.category.name)}` : ''}</span>
        </button>`).join('');
      $$('#memoEntryItemList .pickrow[data-item]').forEach((b) => {
        b.onclick = () => {
          memoState.pickedItemId = b.dataset.item;
          renderMemoEntryPickers();
        };
      });
    }
  }

  // Heir chips. Same roster shape as the old gifts screen \u2014 heirs and
  // named recipients side by side. Named recipients get a small tag so
  // the owner can tell friends apart from will-heirs at a glance.
  const chipsBox = $('#memoEntryHeirChips');
  const emptyMsg = $('#memoEntryHeirEmpty');
  if (!memoState.heirs.length) {
    chipsBox.innerHTML = '';
    emptyMsg.hidden = false;
    const addBtn = $('#memoEntryHeirsAdd');
    if (addBtn) addBtn.onclick = () => go('gifts');
  } else {
    emptyMsg.hidden = true;
    chipsBox.innerHTML = memoState.heirs.map((h) => {
      const selected = h.heir_id === memoState.pickedHeirId;
      const kind = (h.recipient_type || 'heir') === 'heir' ? '' : ' \u00b7 named';
      return `<button type="button" class="chip" aria-pressed="${selected ? 'true' : 'false'}" data-heir="${escapeHtml(h.heir_id)}">${escapeHtml(h.name)}${escapeHtml(kind)}</button>`;
    }).join('');
    $$('#memoEntryHeirChips [data-heir]').forEach((b) => {
      b.onclick = () => {
        memoState.pickedHeirId = b.dataset.heir;
        renderMemoEntryPickers();
      };
    });
  }
}

/*
 * Save the currently-being-edited entry. Upserts against
 * /api/memorandum/entries and re-loads the whole screen so version
 * bumps and conflict changes are reflected immediately.
 */
async function saveMemoEntry() {
  const err = $('#memoEntryError');
  err.hidden = true;
  if (!memoState.pickedItemId) {
    err.textContent = 'Please pick which item this is about.';
    err.hidden = false;
    return;
  }
  const note = ($('#memoEntryNote').value || '').trim();
  const body = {
    item_id: memoState.pickedItemId,
    assigned_to_heir_id: memoState.pickedHeirId || null,
    note,
  };
  try {
    await api('/api/memorandum/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    toast('Saved.');
    await loadMemo();
    go('memo', { back: true });
  } catch (e) {
    err.textContent = e.message || 'Could not save just now. Nothing was changed.';
    err.hidden = false;
  }
}

/*
 * Delete the entry the owner is editing. No confirm dialog on the
 * detail screen itself \u2014 there is a big Remove button; if that was
 * a slip they can add it back in ten seconds. We only confirm
 * on sign because signing is the irreversible step.
 */
async function removeMemoEntry() {
  const editing = memoState.editing;
  if (!editing) return;
  try {
    await api(`/api/memorandum/entries/${encodeURIComponent(editing.entry_id)}`, { method: 'DELETE' });
    toast('Taken off your list.');
    await loadMemo();
    go('memo', { back: true });
  } catch (e) {
    const err = $('#memoEntryError');
    err.textContent = e.message || 'Could not remove that just now.';
    err.hidden = false;
  }
}

/* ---------------------------- wiring ----------------------------- */

$('#memoAddBtn').onclick = () => go('memoentry');
$('#memoPhotoBtn')?.addEventListener('click', () => { promiseMode = true; promiseKept = 0; resetCapture(); go('capture'); });
$('#signVersionsBtn')?.addEventListener('click', () => go('giftversions'));
$('#memoEntrySave').onclick = saveMemoEntry;
$('#memoEntryCancel').onclick = () => go('memo', { back: true });
$('#memoEntryRemove').onclick = removeMemoEntry;
$('#memoEntryItemSearch').addEventListener('input', renderMemoEntryPickers);
$('#memoEntryNote').addEventListener('input', (e) => {
  $('#memoEntryNoteCount').textContent = String((e.target.value || '').length);
});

/*
 * "Print and sign" and "Past signed versions" are placeholders in Slice B \u2014
 * step 6 (sign flow with modified confirm dialog) and step 7 (PDF template)
 * will wire the real destinations. For now they route to the existing
 * giftsign / giftversions screens so the buttons don't dead-end mid-slice.
 */


/* ================================================================== */
/* Slice 4 \u2014 household link screen.                                 */
/*                                                                     */
/* The screen does its own fetch on mount rather than subscribing to a */
/* shared cache. Household state is small; a re-fetch on every screen  */
/* open costs nothing and avoids stale UI after either partner acts    */
/* from a different tab.                                               */
/* ================================================================== */

/**
 * The household-link screen. Renders one of three states based on the
 * /household-link summary. Copy stays plain-language because the audience is
 * an elderly owner or their co-owner; every action confirms first.
 */
/**
 * The helper-invite screen. Simpler than the partner-link ceremony: an owner
 * sends a secure invite with role 'assistant'. Helpers can take photos and
 * document items but do not get their own memorandum and are not part of
 * conflict detection. There is no confirm/unlink step here — the owner can
 * revoke a helper's access from this same screen.
 */
async function loadHelperInvite() {
  const body = $('#helperInviteBody');
  if (!body) return;
  body.innerHTML = '<p class="reassure">Loading\u2026</p>';
  let s;
  try { s = await api('/api/household-link'); }
  catch (e) { body.innerHTML = `<p class="reassure">Could not load: ${escapeHtml(e.message)}</p>`; return; }

  const me = (s.participants || []).find((p) => p.is_me);
  const isOwner = me && (me.role === 'owner' || me.role === 'bootstrap-owner');
  const isPartner = me && me.role === 'partner';
  const canManageHelpers = isOwner || isPartner;
  const assistants = s.assistants || [];

  if (!canManageHelpers) {
    body.innerHTML = `
      <h2>Invite a helper</h2>
      <p class="lede">Only the owner or a co-owner can invite a helper. Ask them to send you the invitation.</p>
    `;
    return;
  }

  // Show existing helpers + invite form
  const helperList = assistants.length
    ? `<div class="link-card" style="margin-bottom:20px">
        <div><b>Helpers with access</b></div>
        <ul class="plain-list">
          ${assistants.map((a) => `<li>${escapeHtml(a.display_name || a.email)}</li>`).join('')}
        </ul>
      </div>`
    : '';

  body.innerHTML = `
    <h2>Invite a helper</h2>
    <p class="lede">A helper can take photos and document items for you. They do not have their own gift list and are not part of any conflict checks. Your email app will open with a secure, one-time sign-in link for them. Just hit send — the link works once and expires in twenty minutes.</p>
    ${helperList}
    <div class="invite-form">
      <label for="helperName">Their first name (optional)</label>
      <input id="helperName" type="text" autocomplete="given-name" placeholder="e.g., Sarah">
      <label for="helperEmail">Their email</label>
      <input id="helperEmail" type="email" autocomplete="email" placeholder="name@example.com">
      <button class="primary wide" id="helperInviteBtn">Send invite to helper</button>
    </div>
    <div id="helperInviteResult" hidden></div>
    <p class="reassure">This only gives them access to help document your items. You can revoke access anytime. Nothing here is a will.</p>
    <button class="ghost wide" data-go="home">Back to home</button>
  `;

  $('#helperInviteBtn').onclick = async () => {
    const email = $('#helperEmail').value.trim();
    const display_name = $('#helperName').value.trim();
    if (!email) { toast('Type their email.', true); return; }
    if (!confirm(`Send the helper invite to ${email}?`)) return;
    try {
      const out = await api('/api/household-link/invite', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, display_name, role: 'assistant' }),
      });
      const box = $('#helperInviteResult');
      box.hidden = false;
      if (out.link) {
        openEmailApp({
          to: email,
          subject: 'Your sign-in link for Reindeer Registry',
          body: `You have been invited to participate with an Estate Inventory.\n\nClick the link to join.\n${out.link}\n`,
        });
        box.innerHTML = `<p class="reassure">Choose how to send the invitation to ${escapeHtml(email)}. Send it and ask them to check their inbox; the link expires in twenty minutes.</p>`;
        toast('Choose how to send…');
      } else {
        box.innerHTML = `<p class="reassure">Invitation sent to ${escapeHtml(email)}. Ask them to check their inbox; the link expires in twenty minutes.</p>`;
        toast('Helper invite sent.');
      }
      // Refresh the helper list
      loadHelperInvite();
    } catch (e) { toast(e.message, true); }
  };
}

async function loadHouseholdLink() {
  const body = $('#householdLinkBody');
  if (!body) return;
  body.innerHTML = '<p class="reassure">Loading\u2026</p>';
  let s;
  try { s = await api('/api/household-link'); }
  catch (e) { body.innerHTML = `<p class="reassure">Could not load: ${escapeHtml(e.message)}</p>`; return; }

  const isCouple = s.household_mode === 'couple';
  const partnerPresent = !!s.partner_present;
  const canConfirm = !!s.can_confirm;
  const canUnlink = !!s.can_unlink;
  const me = (s.participants || []).find((p) => p.is_me);
  const isOwner = me && (me.role === 'owner' || me.role === 'bootstrap-owner');
  const partner = (s.participants || []).find((p) => !p.is_me);
  const assistants = s.assistants || [];
  const partners = s.partners || [];
  const pendingInvites = s.pending_invites || [];

  if (isCouple) {
    body.innerHTML = `
      <h2>Linked</h2>
      <p class="lede">You and ${escapeHtml((partner?.display_name || partner?.email) || 'your co-owner')} are linked. You share one inventory. Either of you can add items, tag them Important, and record where they should go.</p>
      <div class="link-card">
        <div><b>Linked on</b> ${s.linked_at ? new Date(s.linked_at).toLocaleDateString() : '\u2014'}</div>
        <div><b>Participants</b></div>
        <ul class="plain-list">
          ${(s.participants || []).map((p) => `<li>${escapeHtml(p.display_name || p.email || '')}${p.is_me ? ' <span class="badge who">you</span>' : ''}${p.role === 'owner' || p.role === 'bootstrap-owner' ? ' <span class="badge kept">owner</span>' : ''}</li>`).join('')}
        </ul>
      </div>
      <div class="detrow">
        ${canUnlink ? '<button class="ghost" id="unlinkBtn">Unlink</button>' : ''}
      </div>
      <p class="reassure">Unlinking goes back to a one-person view. Everything you recorded together stays on record.</p>
      ${assistants.length ? `
      <div class="link-card" style="margin-top:20px">
        <div><b>Helpers (${assistants.length}/10)</b></div>
        <ul class="plain-list">
          ${assistants.map((a) => `<li>${escapeHtml(a.display_name || a.email)} <button class="linky" data-revoke="${a.participant_id}" style="font-size:0.85em;margin-left:8px">remove</button></li>`).join('')}
        </ul>
      </div>` : ''}
      ${pendingInvites.length ? `
      <div class="link-card" style="margin-top:20px">
        <div><b>Pending invites (${pendingInvites.length})</b></div>
        <ul class="plain-list">
          ${pendingInvites.map((p) => `<li>${escapeHtml(p.display_name || p.email)} <span class="badge">waiting to sign in</span> <button class="linky" data-revoke="${p.participant_id}" style="font-size:0.85em;margin-left:8px">revoke</button></li>`).join('')}
        </ul>
      </div>` : ''}
      ${isOwner || me?.role === 'partner' ? `
      <div class="invite-form" style="margin-top:20px">
        <h3>Add a helper</h3>
        <label for="helperName2">Their first name (optional)</label>
        <input id="helperName2" type="text" autocomplete="given-name" placeholder="e.g., Sarah">
        <label for="helperEmail2">Their email</label>
        <input id="helperEmail2" type="email" autocomplete="email" placeholder="name@example.com">
        <button class="primary wide" id="helperInviteBtn2">Send helper invite</button>
      </div>
      <div id="helperResult2" hidden></div>` : ''}
      <button class="ghost wide" data-go="home" style="margin-top:16px">Back to home</button>
    `;
    const unlink = $('#unlinkBtn');
    if (unlink) unlink.onclick = async () => {
      if (!confirm('Unlink? You can link again later. Everything you recorded together stays on record.')) return;
      try { await api('/api/household-link/unlink', { method: 'POST' }); toast('Unlinked.'); loadHouseholdLink(); }
      catch (e) { toast(e.message, true); }
    };
    const hBtn = $('#helperInviteBtn2');
    if (hBtn) hBtn.onclick = async () => {
      const email = $('#helperEmail2').value.trim();
      const display_name = $('#helperName2').value.trim();
      if (!email) { toast('Type their email.', true); return; }
      if (!confirm(`Send the helper invite to ${email}?`)) return;
      try {
        const out = await api('/api/household-link/invite', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, display_name, role: 'assistant' }),
        });
        const box = $('#helperResult2');
        box.hidden = false;
        if (out.link) {
          openEmailApp({
            to: email,
            subject: 'Your sign-in link for Reindeer Registry',
            body: `You have been invited to participate with an Estate Inventory.\n\nClick the link to join.\n${out.link}\n`,
          });
          box.innerHTML = `<p class="reassure">Choose how to send the invitation to ${escapeHtml(email)}. Send it and ask them to check their inbox; the link expires in twenty minutes.</p>`;
          toast('Choose how to send…');
        } else {
          box.innerHTML = `<p class="reassure">Invitation sent to ${escapeHtml(email)}. Ask them to check their inbox; the link expires in twenty minutes.</p>`;
          toast('Helper invite sent.');
        }
        // Ask if they want to invite another helper
        if (confirm('Would you like to invite another helper?')) {
          $('#helperName2').value = '';
          $('#helperEmail2').value = '';
          $('#helperName2').focus();
          box.hidden = true;
        } else {
          loadHouseholdLink();
        }
      } catch (e) { toast(e.message, true); }
    };
    return;
  }

  if (partnerPresent && canConfirm) {
    const suggestedName = me?.display_name || '';
    body.innerHTML = `
      <h2>Confirm the link</h2>
      <p class="lede">${escapeHtml((partner?.display_name || partner?.email) || 'Your co-owner')} has signed in. Confirming links the two of you. From then on, either of you can add items and record where they should go on a shared inventory.</p>
      <div class="invite-form">
        <label for="confirmName">Your first name (how you want to appear on this list)</label>
        <input id="confirmName" type="text" autocomplete="given-name" placeholder="e.g., Bob" value="${escapeHtml(suggestedName)}">
      </div>
      <div class="detrow">
        <button class="primary" id="confirmBtn">Confirm we are linked</button>
      </div>
      <p class="reassure">You can change your name later. You can also unlink later. Nothing here is a will.</p>
    `;
    $('#confirmBtn').onclick = async () => {
      if (!confirm('Confirm the link now? You can unlink later.')) return;
      const display_name = $('#confirmName').value.trim();
      try {
        await api('/api/household-link/confirm', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ display_name }),
        });
        toast('Linked.'); loadHouseholdLink();
      } catch (e) { toast(e.message, true); }
    };
    return;
  }

  if (!isOwner) {
    body.innerHTML = `
      <h2>Not yet linked</h2>
      <p class="lede">Only the account owner can invite a co-owner. Ask them to open Reindeer Registry and send you the invitation email.</p>
    `;
    return;
  }

  // Solo mode, owner. Show unified invite page: co-owner + helpers.
  // When a co-owner invite is pending, suppress the co-owner invite form —
  // only two owners allowed, and the slot is taken (pending acceptance).
  const pendingPartner = pendingInvites.find((p) => p.role === 'partner');
  const coOwnerSlotTaken = partners.length > 0 || !!pendingPartner;

  body.innerHTML = `
    <h2>${coOwnerSlotTaken ? 'There can only be one co-owner' : 'Add a co-owner or helper'}</h2>
    <p class="lede">${coOwnerSlotTaken ? 'There can only be one co-owner. Would you like to add a helper?' : 'Invite someone to join your Registry. A co-owner shares your inventory and keeps their own gift list. A helper can take photos and document items for you.'}</p>

    ${partners.length ? `
    <div class="link-card" style="margin-bottom:16px">
      <div><b>Co-owner (${partners.length}/1)</b></div>
      <ul class="plain-list">
        ${partners.map((p) => `<li>${escapeHtml(p.display_name || p.email)}</li>`).join('')}
      </ul>
    </div>` : ''}

    ${assistants.length ? `
    <div class="link-card" style="margin-bottom:16px">
      <div><b>Helpers (${assistants.length}/10)</b></div>
      <ul class="plain-list">
        ${assistants.map((a) => `<li>${escapeHtml(a.display_name || a.email)} <button class="linky" data-revoke="${a.participant_id}" style="font-size:0.85em;margin-left:8px">remove</button></li>`).join('')}
      </ul>
    </div>` : ''}

    ${pendingInvites.length ? `
    <div class="link-card" style="margin-bottom:20px">
      <div><b>Pending invites (${pendingInvites.length})</b></div>
      <ul class="plain-list">
        ${pendingInvites.map((p) => `<li>${escapeHtml(p.display_name || p.email)} <span class="badge">${p.role === 'assistant' ? 'helper' : 'co-owner'} · waiting to sign in</span> <button class="linky" data-revoke="${p.participant_id}" style="font-size:0.85em;margin-left:8px">revoke</button></li>`).join('')}
      </ul>
    </div>` : ''}

    ${!coOwnerSlotTaken ? `
    <div class="invite-form">
      <h3>Invite a co-owner</h3>
      <p class="reassure" style="margin-bottom:8px">Your legally bound partner. They will see everything you record and keep their own gift list. One co-owner maximum.</p>
      <label for="inviteName">Their first name (optional)</label>
      <input id="inviteName" type="text" autocomplete="given-name" placeholder="e.g., Bob">
      <label for="inviteEmail">Their email</label>
      <input id="inviteEmail" type="email" autocomplete="email" placeholder="name@example.com">
      <button class="primary wide" id="inviteBtn">Send co-owner invite</button>
    </div>
    <div id="inviteResult" hidden></div>` : ''}

    <div class="invite-form" style="margin-top:24px">
      <h3>Invite a helper</h3>
      <p class="reassure" style="margin-bottom:8px">A helper can take photos and document items for you. They do not have their own gift list and are not part of any conflict checks. Up to 10 helpers.</p>
      <label for="helperName3">Their first name (optional)</label>
      <input id="helperName3" type="text" autocomplete="given-name" placeholder="e.g., Sarah">
      <label for="helperEmail3">Their email</label>
      <input id="helperEmail3" type="email" autocomplete="email" placeholder="name@example.com">
      <button class="primary wide" id="helperInviteBtn3">Send helper invite</button>
    </div>
    <div id="helperResult3" hidden></div>

    ${coOwnerSlotTaken ? `<button class="primary wide" data-go="home" style="margin-top:16px">No thanks — back to home</button>` : `<button class="ghost wide" data-go="home" style="margin-top:8px">Back to home</button>`}
  `;

  const inviteBtn = $('#inviteBtn');
  if (inviteBtn) inviteBtn.onclick = async () => {
    const email = $('#inviteEmail').value.trim();
    const display_name = $('#inviteName').value.trim();
    if (!email) { toast('Type their email.', true); return; }
    if (!confirm(`Send the co-owner invite to ${email}?`)) return;
    try {
      const out = await api('/api/household-link/invite', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, display_name, role: 'partner' }),
      });
      const box = $('#inviteResult');
      box.hidden = false;
      if (out.link) {
        openEmailApp({
          to: email,
          subject: 'Your co-owner sign-in link for Reindeer Registry',
          body: `You have been invited to participate with an Estate Inventory.\n\nClick the link to join.\n${out.link}\n`,
        });
        box.innerHTML = `<p class="reassure">Choose how to send the co-owner invitation to ${escapeHtml(email)}. Send it and ask them to check their inbox; the link expires in twenty minutes.</p>`;
        toast('Choose how to send…');
      } else {
        box.innerHTML = `<p class="reassure">Co-owner invite sent to ${escapeHtml(email)}. Ask them to check their inbox; the link expires in twenty minutes.</p>`;
        toast('Co-owner invite sent.');
      }
      loadHouseholdLink();
    } catch (e) { toast(e.message, true); }
  };

  const helperBtn3 = $('#helperInviteBtn3');
  if (helperBtn3) helperBtn3.onclick = async () => {
    const email = $('#helperEmail3').value.trim();
    const display_name = $('#helperName3').value.trim();
    if (!email) { toast('Type their email.', true); return; }
    if (!confirm(`Send the helper invite to ${email}?`)) return;
    try {
      const out = await api('/api/household-link/invite', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, display_name, role: 'assistant' }),
      });
      const box = $('#helperResult3');
      box.hidden = false;
      if (out.link) {
        openEmailApp({
          to: email,
          subject: 'Your sign-in link for Reindeer Registry',
          body: `You have been invited to participate with an Estate Inventory.\n\nClick the link to join.\n${out.link}\n`,
        });
        box.innerHTML = `<p class="reassure">Choose how to send the invitation to ${escapeHtml(email)}. Send it and ask them to check their inbox; the link expires in twenty minutes.</p>`;
        toast('Choose how to send…');
      } else {
        box.innerHTML = `<p class="reassure">Helper invite sent to ${escapeHtml(email)}. Ask them to check their inbox; the link expires in twenty minutes.</p>`;
        toast('Helper invite sent.');
      }
      // Ask if they want to invite another helper
      if (confirm('Would you like to invite another helper?')) {
        $('#helperName3').value = '';
        $('#helperEmail3').value = '';
        $('#helperName3').focus();
        box.hidden = true;
      } else {
        loadHouseholdLink();
      }
    } catch (e) { toast(e.message, true); }
  };

  // Wire up revoke/remove buttons for pending invites and active helpers
  body.querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.onclick = async () => {
      const pid = btn.dataset.revoke;
      const isRemove = btn.textContent.trim() === 'remove';
      const msg = isRemove
        ? 'Remove this helper? Their access will be revoked but any photos they took stay on record.'
        : 'Revoke this invite? They will not be able to sign in with the old link.';
      if (!confirm(msg)) return;
      try {
        await api('/api/household-link/revoke', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ participant_id: pid }),
        });
        toast(isRemove ? 'Helper removed.' : 'Invite revoked.');
        loadHouseholdLink();
      } catch (e) { toast(e.message, true); }
    };
  });
}

// ---------------------------------------------------------- Ship B: contested
/*
 * "Things families fight over" screen.
 *
 * Static, hand-written per-category advice. Each entry maps to a category
 * name the intake flow already knows (from DEFAULT_CATEGORIES seeded on
 * scope creation, or MORE_CATEGORIES the owner can promote). The `notice`
 * field is optional and reserved for firearms today — it renders as a
 * distinct call-out above the button so an owner cannot miss it. Firearms
 * still allows an assign action because some owners already know exactly
 * where each piece is meant to go; the notice is about legal responsibility,
 * not about hiding the flow.
 */
const CONTESTED_CATEGORIES = [
  { key: 'Jewelry', why: 'Everyone remembers a piece differently, and market value hides the story.',
    advice: 'Take a wide photo of the whole spread first, then close-ups of each piece. Do it once and it is done.' },
  { key: 'Holiday ornaments', why: 'Every family fights about who gets Grandma\u2019s ornaments.',
    advice: 'Bring the box out at the holiday. Photograph as you unwrap. Say aloud who gave you which ornament \u2014 the recording is the point.' },
  { key: 'Heirloom and special furniture', why: 'Big pieces are hard to move; who \u201cclaims\u201d them turns tense.',
    advice: 'Photograph the piece where it lives. Note the maker or the story on the back. Say who you hope will make room for it. This includes musical instruments and handmade pieces.' },
  { key: 'Collectibles \u2014 artwork, rare wine or spirits, vintage cars', why: 'Value is fuzzy and easy to argue about.',
    advice: 'Photograph each piece with a ruler or hand for scale. Note where you bought it and roughly when.' },
  { key: 'Guns', why: 'Firearms carry legal rules that vary by state. Document what you have \u2014 the transfer itself is outside this app.',
    advice: 'Record what you have and what you would like to happen to each piece. Photograph the piece with any serial visible.',
    notice: 'The legal transfer happens outside this app. Record what you have and what you would like to happen to each piece. Your attorney or trustee will handle the legal side.' },
  { key: 'Letters, Journals & Recipes', why: 'Written words are once-only. The person who reads them first shapes the story.',
    advice: 'Photograph the outside of the folder or box. You do not have to open every letter. Lay recipes out and photograph the ones in a hand you recognise. Say who you would like to keep them.' },
  { key: 'Photographs', why: 'Physical photos have one copy. Whoever gets the box gets the memory.',
    advice: 'Lay a stack out on the table by decade or by person. Photograph the group, then the ones with people you can name on the back. Digital copies prevent the old cruelty of fighting over a single print.' },
];

function renderContestedCards() {
  const wrap = $('#contestedCards');
  if (!wrap) return;
  wrap.innerHTML = CONTESTED_CATEGORIES.map((c, i) => `
    <article class="contested-card" data-idx="${i}">
      <div class="contested-card-head">
        <h3>${escapeHtml(c.key)}</h3>
      </div>
      <p class="why">${escapeHtml(c.why)}</p>
      <p class="advice">${escapeHtml(c.advice)}</p>
      ${c.notice ? `<div class="trustee-notice">${escapeHtml(c.notice)}</div>` : ''}
      <button class="primary wide contested-add" data-cat="${escapeHtml(c.key)}">Add ${escapeHtml(c.key)} items</button>
    </article>
  `).join('');
  $$('#contestedCards .contested-add').forEach((btn) => {
    btn.onclick = () => {
      const name = btn.dataset.cat;
      // Start a fresh capture but seed the category. The capture screen's
      // renderCatChips picks this up and presses (or promotes) the chip.
      resetCapture();
      cap.category = name;
      go('capture');
    };
  });

  // Special collections — items are pre-flagged as important so they
  // migrate to FairPlay flagged for resolution.
  const scBtn = $('#specialCollectionsBtn');
  if (scBtn) {
    scBtn.onclick = () => {
      resetCapture();
      cap.category = 'Special collections';
      cap.important = true;
      cap.importantFeeling = true;
      cap.preSetImportant = true; // signal to showCapDetails to sync the UI
      go('capture');
    };
  }
}

/*
 * Holiday reminder picker.
 *
 * Renders a checkbox list from the server's vocabulary, ticks the
 * participant's saved picks, and posts the full replacement list on save.
 * The Registry itself never sends email; a Perplexity Computer scheduled
 * task reads reminder_prefs and dispatches on the right days.
 */
async function loadReminderPicker() {
  const wrap = $('#reminderPicker');
  if (!wrap) return;
  wrap.innerHTML = '<p class="reassure">Loading\u2026</p>';
  try {
    const data = await api('/api/reminders/holidays');
    const picked = new Set(data.picked || []);
    wrap.innerHTML = (data.vocabulary || []).map((h) => `
      <label class="reminder-row">
        <input type="checkbox" data-key="${escapeHtml(h.key)}" ${picked.has(h.key) ? 'checked' : ''}>
        <span>${escapeHtml(h.label)}</span>
      </label>
    `).join('');
    const saveBtn = $('#reminderSaveBtn');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const keys = $$('#reminderPicker input[type="checkbox"]:checked')
          .map((c) => c.dataset.key);
        try {
          await api('/api/reminders/holidays', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ holidays: keys }),
          });
          toast(keys.length ? 'Reminders saved.' : 'Reminders turned off.');
        } catch (e) { toast(e.message, true); }
      };
    }
  } catch (e) {
    wrap.innerHTML = `<p class="reassure">Could not load: ${escapeHtml(e.message)}</p>`;
  }
}


