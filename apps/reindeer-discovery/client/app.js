/* Reindeer: Discovery — heir review experience + owner dashboard
 * Explore → Discover → Save → Prioritize → Lock → Compare
 * Owner: invite heirs, track progress, compare results
 */

const API = '/api';
let heirToken = localStorage.getItem('discovery_token') || null;
let ownerToken = localStorage.getItem('discovery_owner_token') || null;
let currentHeir = null;
let reviewQueue = [];
let reviewIndex = 0;
let myInterests = {};

// ─── API helper ──────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...opts.headers };
  if (heirToken) headers['x-heir-token'] = heirToken;
  if (ownerToken) headers['x-owner-token'] = ownerToken;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ─── Screen navigation ────────────────────────────────────────
const screens = {
  join: $('#joinScreen'),
  ownerLogin: $('#ownerLoginScreen'),
  home: $('#homeScreen'),
  review: $('#reviewScreen'),
  prioritize: $('#prioritizeScreen'),
  lock: $('#lockScreen'),
  locked: $('#lockedScreen'),
  owner: $('#ownerScreen'),
};
function show(name) {
  Object.values(screens).forEach(s => s.hidden = true);
  if (screens[name]) screens[name].hidden = false;
  const isApp = name !== 'join' && name !== 'ownerLogin';
  $('#topbar').hidden = !isApp;
  window.scrollTo(0, 0);
}

// ─── Init ─────────────────────────────────────────────────────
async function init() {
  // Check URL params for invite token (deep link from owner)
  const params = new URLSearchParams(location.search);
  const inviteToken = params.get('invite');
  if (inviteToken) {
    $('#joinToken').value = inviteToken;
    $('#joinName').focus();
    history.replaceState(null, '', location.pathname);
  }

  if (heirToken) {
    try {
      const me = await api('/heirs/me');
      if (me.authenticated) {
        currentHeir = me;
        $('#heirBadge').textContent = me.name;
        if (me.review_state === 'locked') {
          loadLockedStats();
          show('locked');
        } else {
          show('home');
          loadHome();
        }
        return;
      }
    } catch {}
    heirToken = null;
    localStorage.removeItem('discovery_token');
  }

  if (ownerToken) {
    show('owner');
    loadOwnerDashboard();
    return;
  }

  show('join');
}

// ─── Join (heir) ──────────────────────────────────────────────
$('#joinBtn').onclick = async () => {
  const name = $('#joinName').value.trim();
  const token = $('#joinToken').value.trim();
  if (!name || !token) return toast('Enter your name and invite code');
  try {
    const res = await api('/heirs/join', {
      method: 'POST',
      body: JSON.stringify({ name, invite_token: token })
    });
    heirToken = res.session_token;
    localStorage.setItem('discovery_token', heirToken);
    currentHeir = { heir_id: res.heir_id, name: res.name, review_state: res.review_state };
    $('#heirBadge').textContent = res.name;
    show('home');
    loadHome();
  } catch (e) { toast(e.message, true); }
};

// ─── Owner login ──────────────────────────────────────────────
$('#ownerLinkBtn')?.onclick = () => { show('ownerLogin'); };
$('#ownerDirectBtn').onclick = () => { show('ownerLogin'); };
$('#ownerLoginBackBtn').onclick = () => { show('join'); };

$('#ownerLoginBtn').onclick = async () => {
  const code = $('#ownerCode').value.trim();
  if (!code) return toast('Enter the owner passcode');
  try {
    const res = await api('/owner/login', {
      method: 'POST',
      body: JSON.stringify({ code })
    });
    ownerToken = res.token;
    localStorage.setItem('discovery_owner_token', ownerToken);
    show('owner');
    loadOwnerDashboard();
  } catch (e) { toast(e.message, true); }
};

$('#ownerLogoutBtn').onclick = () => {
  ownerToken = null;
  localStorage.removeItem('discovery_owner_token');
  show('join');
};

// ─── Owner Dashboard ──────────────────────────────────────────
async function loadOwnerDashboard() {
  try {
    const [stats, heirsRes, lookingForRes] = await Promise.all([
      api('/owner/stats'),
      api('/heirs'),
      api('/looking-for'),
    ]);

    $('#ownerStats').innerHTML = `
      <div class="stat-tile"><div class="num">${stats.heirs}</div><div class="lbl">Heirs</div></div>
      <div class="stat-tile"><div class="num">${stats.locked}</div><div class="lbl">Locked</div></div>
      <div class="stat-tile"><div class="num">${stats.items}</div><div class="lbl">Items</div></div>
      <div class="stat-tile"><div class="num">${stats.contested}</div><div class="lbl">Contested</div></div>
      <div class="stat-tile"><div class="num">${stats.looking_for}</div><div class="lbl">Looking For</div></div>
    `;

    renderHeirList(heirsRes.heirs || []);
    renderLookingFor(lookingForRes.requests || []);
    loadCompareReport();
  } catch (e) {
    if (e.message.includes('authentication') || e.message.includes('Owner')) {
      toast('Owner session expired. Please log in again.', true);
      ownerToken = null;
      localStorage.removeItem('discovery_owner_token');
      show('ownerLogin');
    } else {
      toast(e.message, true);
    }
  }
}

function renderHeirList(heirs) {
  const el = $('#heirList');
  if (!heirs.length) {
    el.innerHTML = '<p class="reassure">No heirs invited yet. Use the form below to invite your first heir.</p>';
    return;
  }
  el.innerHTML = heirs.map(h => `
    <div class="card" style="margin-bottom:8px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <b>${esc(h.name)}</b>${h.relationship ? ` <span style="color:var(--muted)">· ${esc(h.relationship)}</span>` : ''}
        ${h.email ? ` <span style="color:var(--muted);font-size:0.85rem">${esc(h.email)}</span>` : ''}
        <br><span style="font-size:0.8rem;color:var(--muted)">${h.review_state === 'locked' ? '🔒 Locked' : '✏️ In progress'}</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="ghost" style="padding:6px 12px;font-size:0.85rem" onclick="copyInviteLink('${h.invite_token}')">Copy link</button>
        <button class="ghost" style="padding:6px 12px;font-size:0.85rem;color:var(--danger)" onclick="removeHeir('${h.heir_id}','${esc(h.name)}')">Remove</button>
      </div>
    </div>
  `).join('');
}

window.copyInviteLink = function(inviteToken) {
  const link = `${location.origin}/?invite=${inviteToken}`;
  navigator.clipboard.writeText(link).then(() => toast('Invite link copied to clipboard'));
};

window.removeHeir = async function(heirId, name) {
  if (!confirm(`Remove ${name}? Their reactions and rankings will be deleted.`)) return;
  try {
    await api(`/heirs/${heirId}`, { method: 'DELETE' });
    toast(`${name} removed`);
    loadOwnerDashboard();
  } catch (e) { toast(e.message, true); }
};

// ─── Owner: invite heir ──────────────────────────────────────
$('#inviteHeirBtn').onclick = async () => {
  const name = $('#newHeirName').value.trim();
  const relationship = $('#newHeirRelationship').value.trim();
  const email = $('#newHeirEmail').value.trim();
  if (!name) return toast('Heir name is required');
  try {
    const res = await api('/heirs/invite', {
      method: 'POST',
      body: JSON.stringify({ name, email, relationship })
    });

    const inviteLink = `${location.origin}/?invite=${res.invite_token}`;
    const box = $('#inviteResult');
    box.hidden = false;
    box.innerHTML = `
      <div class="card" style="border-color:var(--accent);margin-top:12px">
        <b>Invite link for ${esc(name)}:</b>
        <div style="margin-top:8px;padding:10px;background:var(--surface);border-radius:8px;font-family:monospace;font-size:0.85rem;word-break:break-all">${esc(inviteLink)}</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="primary" style="flex:1" onclick="navigator.clipboard.writeText('${inviteLink}').then(()=>toast('Link copied'))">Copy link</button>
          ${email ? `<button class="ghost" style="flex:1" onclick="window.location.href='mailto:${esc(email)}?subject=You%27re%20invited%20to%20review%20our%20family%20inventory&body=Hi%20${esc(name)}%2C%0A%0AYou%27ve%20been%20invited%20to%20explore%20our%20family%20estate%20inventory%20at%20this%20link%3A%0A%0A${encodeURIComponent(inviteLink)}%0A%0AEnter%20your%20name%20and%20the%20invite%20code%20is%20already%20filled%20in%20for%20you.%0A%0AThanks!'">Email link</button>` : ''}
        </div>
        ${email ? `<p style="font-size:0.85rem;color:var(--muted);margin-top:8px">Or send the link to ${esc(email)} manually.</p>` : ''}
      </div>
    `;

    $('#newHeirName').value = '';
    $('#newHeirRelationship').value = '';
    $('#newHeirEmail').value = '';

    loadOwnerDashboard();
  } catch (e) { toast(e.message, true); }
};

// ─── Owner: comparison report ─────────────────────────────────
async function loadCompareReport() {
  try {
    const res = await api('/compare');
    const el = $('#compareReport');

    if (!res.ready) {
      const status = (res.heirs || []).map(h =>
        `${esc(h.name)}: ${h.locked ? '🔒' : '⏳'}`
      ).join(' · ');
      el.innerHTML = `
        <p class="reassure">${esc(res.message || 'Waiting for all heirs to lock.')}</p>
        <p style="font-size:0.85rem;color:var(--muted)">${status}</p>
        <button class="ghost" id="refreshCompareBtn" style="width:auto;margin-top:8px">Refresh</button>
      `;
      $('#refreshCompareBtn').onclick = loadCompareReport;
      return;
    }

    const s = res.summary;
    let html = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:16px">
        <div class="stat-tile"><div class="num">${s.items_with_interest}</div><div class="lbl">Items with interest</div></div>
        <div class="stat-tile"><div class="num">${s.no_competition}</div><div class="lbl">No competition</div></div>
        <div class="stat-tile"><div class="num">${s.some_competition}</div><div class="lbl">Some competition</div></div>
        <div class="stat-tile" style="border-color:var(--danger)"><div class="num">${s.high_competition}</div><div class="lbl">High competition</div></div>
      </div>
    `;

    const contested = (res.competitions || []).filter(c => c.contested);
    const others = (res.competitions || []).filter(c => !c.contested);

    if (contested.length) {
      html += `<div class="section-label" style="color:var(--danger)">⚠️ Contested (2+ want)</div>`;
      html += contested.map(c => `
        <div class="card" style="margin-bottom:8px;border-color:var(--danger)">
          <b>${esc(c.title)}</b> ${c.room ? `<span style="color:var(--muted)">· ${esc(c.room)}</span>` : ''}
          <br><span style="font-size:0.85rem">${c.heirs.map(h => `${esc(h.name)}: ${h.reaction === 'high' ? '🔴 Want' : '🟡 Interested'}`).join(' · ')}</span>
        </div>
      `).join('');
    }

    if (others.length) {
      html += `<div class="section-label">Other items with interest</div>`;
      html += others.slice(0, 20).map(c => `
        <div class="card" style="margin-bottom:8px">
          <b>${esc(c.title)}</b> ${c.room ? `<span style="color:var(--muted)">· ${esc(c.room)}</span>` : ''}
          <br><span style="font-size:0.85rem">${c.heirs.map(h => `${esc(h.name)}: ${h.reaction === 'high' ? '🔴 Want' : '🟡 Interested'}`).join(' · ')}</span>
        </div>
      `).join('');
      if (others.length > 20) {
        html += `<p class="reassure">...and ${others.length - 20} more</p>`;
      }
    }

    if (!contested.length && !others.length) {
      html += '<p class="reassure">No items had any interest marked.</p>';
    }

    el.innerHTML = html;
  } catch (e) {
    if (!e.message.includes('authentication') && !e.message.includes('Owner')) {
      $('#compareReport').innerHTML = `<p class="reassure">Unable to load comparison: ${esc(e.message)}</p>`;
    }
  }
}

// ─── Owner: looking for requests ──────────────────────────────
function renderLookingFor(requests) {
  const el = $('#lookingForList');
  if (!requests.length) {
    el.innerHTML = '<p class="reassure">No "looking for" requests yet.</p>';
    return;
  }
  el.innerHTML = requests.map(r => `
    <div class="card" style="margin-bottom:8px">
      <b>${esc(r.heir_name)}</b> is looking for:
      <br><span style="font-size:0.9rem">${esc(r.description)}</span>
      <br><span style="font-size:0.8rem;color:var(--muted)">
        ${r.status === 'found' ? '✓ Found in inventory' : '⚠ Not in inventory'}
      </span>
    </div>
  `).join('');
}

// ─── Home / Explore ──────────────────────────────────────────
async function loadHome() {
  try {
    const [stats, itemsRes] = await Promise.all([
      api('/stats'),
      api('/items?limit=200')
    ]);

    const items = itemsRes.items || [];
    $('#homeLede').textContent = `${stats.items} items in the collection. ${stats.photos} photos. Browse, search, or start a quick review.`;

    renderGrid(items);
    updateFunnel(currentHeir?.review_state || 'exploring');
  } catch (e) { toast(e.message, true); }
}

function renderGrid(items) {
  const grid = $('#itemGrid');
  if (!items.length) {
    grid.innerHTML = '<p class="reassure">No items found.</p>';
    return;
  }
  grid.innerHTML = items.map(item => `
    <div class="item-card" style="position:relative" onclick="openDetail('${item.item_id}')">
      ${item.photo_url ? `<img src="${item.photo_url}" alt="" loading="lazy">` : `<div style="width:100%;height:140px;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:2rem;color:var(--muted)">📷</div>`}
      <div class="info">
        <div class="title">${esc(item.title)}</div>
        <div class="room">${item.room_name ? esc(item.room_name) : ''}</div>
      </div>
    </div>
  `).join('');
}

// ─── Search ────────────────────────────────────────────────────
$('#searchBtn').onclick = async () => {
  const q = $('#searchInput').value.trim();
  if (!q) return loadHome();
  try {
    const res = await api('/search', {
      method: 'POST',
      body: JSON.stringify({ query: q })
    });
    $('#gridLabel').textContent = `Search results for "${q}" (${res.items.length})`;
    renderGrid(res.items);
  } catch (e) { toast(e.message, true); }
};

// ─── Quick Review (Tinder-like) ──────────────────────────────
$('#quickReviewBtn').onclick = async () => {
  try {
    const res = await api('/items');
    reviewQueue = res.items || [];
    reviewIndex = 0;
    show('review');
    renderReviewCard();
  } catch (e) { toast(e.message, true); }
};

function renderReviewCard() {
  if (reviewIndex >= reviewQueue.length) {
    toast('You\'ve reviewed everything! Go to prioritize to rank your favorites.');
    show('home');
    loadHome();
    return;
  }
  const item = reviewQueue[reviewIndex];
  $('#reviewCount').textContent = `${reviewIndex + 1} of ${reviewQueue.length}`;
  $('#reviewPhoto').src = item.photo_url || '';
  $('#reviewTitle').textContent = item.title || 'Unnamed item';
  $('#reviewRoom').textContent = item.room_name || '';
  $('#reviewStory').textContent = item.story || item.description || '';
  const reaction = myInterests[item.item_id];
  $$('#reviewButtons .swipe-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.reaction === reaction);
  });
}

$$('#reviewButtons .swipe-btn').forEach(btn => {
  btn.onclick = async () => {
    const reaction = btn.dataset.reaction;
    const item = reviewQueue[reviewIndex];
    try {
      await api('/interest', {
        method: 'POST',
        body: JSON.stringify({ item_id: item.item_id, reaction })
      });
      myInterests[item.item_id] = reaction;
      reviewIndex++;
      renderReviewCard();
    } catch (e) { toast(e.message, true); }
  };
});

$('#reviewDetailBtn').onclick = () => {
  const item = reviewQueue[reviewIndex];
  if (item) openDetail(item.item_id);
};

$('#reviewDoneBtn').onclick = () => { show('home'); loadHome(); };

// ─── Item Detail ──────────────────────────────────────────────
async function openDetail(itemId) {
  try {
    const { item } = await api(`/items/${itemId}`);
    $('#detailPhoto').src = item.photos?.[0]?.url || '';
    $('#detailPhoto').hidden = !item.photos?.length;
    $('#detailTitle').textContent = item.title || 'Unnamed item';
    const meta = [];
    if (item.room_name) meta.push(`<span class="chip">🏠 ${esc(item.room_name)}</span>`);
    if (item.category_name) meta.push(`<span class="chip">📦 ${esc(item.category_name)}</span>`);
    $('#detailMeta').innerHTML = meta.join('');

    let html = '';
    if (item.story) html += `<div class="field-label">Story</div><div class="field-value story" style="font-size:0.95rem;line-height:1.6">${esc(item.story)}</div>`;
    if (item.description) html += `<div class="field-label">Description</div><div class="field-value">${esc(item.description)}</div>`;
    if (item.owner_important_comment) html += `<div class="field-label">Owner's note</div><div class="field-value" style="font-style:italic">${esc(item.owner_important_comment)}</div>`;
    $('#detailFields').innerHTML = html;

    $('#detailOverlay').style.display = 'flex';
    $('#detailOverlay').hidden = false;
  } catch (e) { toast(e.message, true); }
}
window.openDetail = openDetail;
function closeDetail() {
  $('#detailOverlay').style.display = 'none';
  $('#detailOverlay').hidden = true;
}
window.closeDetail = closeDetail;

// ─── Prioritize (drag-and-drop) ────────────────────────────────
$('#menuBtn').onclick = () => {
  if (currentHeir?.review_state === 'locked') { show('locked'); loadLockedStats(); return; }
  show('prioritize');
  loadRanking();
};

async function loadRanking() {
  try {
    const [interestsRes, rankingsRes] = await Promise.all([
      api('/interests'),
      api('/rankings')
    ]);
    const items = interestsRes.interests || [];
    if (!items.length) {
      $('#rankList').innerHTML = '<p class="reassure">You haven\'t marked any items as "interested" or "want" yet. Go to Quick Review or Explore first.</p>';
      return;
    }
    const ranked = rankingsRes.rankings || [];
    const rankedIds = ranked.map(r => r.item_id);
    const sorted = [...items].sort((a, b) => {
      const aIdx = rankedIds.indexOf(a.item_id);
      const bIdx = rankedIds.indexOf(b.item_id);
      if (aIdx === -1 && bIdx === -1) return 0;
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
    renderRankList(sorted);
  } catch (e) { toast(e.message, true); }
}

function renderRankList(items) {
  const list = $('#rankList');
  list.innerHTML = items.map((item, idx) => `
    <li class="rank-item" draggable="true" data-item-id="${item.item_id}" data-idx="${idx}">
      <span class="handle">⣿</span>
      <span class="pos">${idx + 1}</span>
      <img class="thumb" src="/api/items/${item.item_id}/photo" onerror="this.style.display='none'" alt="">
      <span class="name">${esc(item.title)}<span class="room"></span></span>
    </li>
  `).join('');
  wireDragDrop();
}

function wireDragDrop() {
  let dragEl = null, dragIdx = null;
  const items = [...$$('#rankList .rank-item')];
  items.forEach(el => {
    el.addEventListener('dragstart', (e) => {
      dragEl = el; dragIdx = +el.dataset.idx;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      reorderPositions();
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragEl || dragEl === el) return;
      const list = $('#rankList');
      const rect = el.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) list.insertBefore(dragEl, el);
      else list.insertBefore(dragEl, el.nextSibling);
    });
  });
}

function reorderPositions() {
  $$('#rankList .rank-item').forEach((el, idx) => {
    el.querySelector('.pos').textContent = idx + 1;
    el.dataset.idx = idx;
  });
}

$('#saveRankBtn').onclick = async () => {
  const ids = $$('#rankList .rank-item').map(el => el.dataset.itemId);
  if (!ids.length) return toast('Nothing to save');
  try {
    await api('/rankings', { method: 'POST', body: JSON.stringify({ rankings: ids }) });
    toast('Ranking saved');
    show('lock');
    loadLockScreen();
  } catch (e) { toast(e.message, true); }
};

// ─── Lock choices ─────────────────────────────────────────────
async function loadLockScreen() {
  try {
    const [stats, interests] = await Promise.all([api('/stats'), api('/interests')]);
    const wantCount = (interests.interests || []).filter(i => i.reaction === 'high').length;
    const interestedCount = (interests.interests || []).filter(i => i.reaction === 'medium').length;

    $('#lockStats').innerHTML = `
      <div class="stat-tile"><div class="num">${wantCount}</div><div class="lbl">Want</div></div>
      <div class="stat-tile"><div class="num">${interestedCount}</div><div class="lbl">Interested</div></div>
      <div class="stat-tile"><div class="num">${stats.items}</div><div class="lbl">Total items</div></div>
    `;
  } catch (e) { toast(e.message, true); }
}

$('#lockBtn').onclick = async () => {
  if (!confirm('Once you lock, you cannot change your reactions. Are you sure?')) return;
  try {
    await api('/lock', { method: 'POST' });
    currentHeir.review_state = 'locked';
    toast('Your choices are locked');
    loadLockedStats();
    show('locked');
  } catch (e) { toast(e.message, true); }
};

// ─── Locked / Waiting ─────────────────────────────────────────
async function loadLockedStats() {
  try {
    const interests = await api('/interests');
    const count = (interests.interests || []).length;
    $('#lockedInterestedCount').textContent = count;
    const wantCount = (interests.interests || []).filter(i => i.reaction === 'high').length;
    $('#lockedStats').innerHTML = `
      <div class="stat-tile"><div class="num">${count}</div><div class="lbl">Items marked</div></div>
      <div class="stat-tile"><div class="num">${wantCount}</div><div class="lbl">Want</div></div>
    `;
    $('#lockedCompetitionSummary').textContent = `Competition details will be revealed once all heirs have locked their choices.`;
  } catch (e) {}
}

$('#lockedHomeBtn').onclick = () => { show('home'); loadHome(); };

// ─── Looking For (heir) ────────────────────────────────────────
$('#lookingForBtn').onclick = async () => {
  const desc = $('#lookingForInput').value.trim();
  if (!desc) return;
  try {
    const res = await api('/looking-for', {
      method: 'POST',
      body: JSON.stringify({ description: desc })
    });
    const el = $('#lookingForResult');
    el.hidden = false;
    if (res.status === 'found') {
      el.innerHTML = `<div class="card" style="border-color:var(--success)">✓ We found a match in the inventory. <a href="#" onclick="openDetail('${res.matched_item_id}');return false">View item</a></div>`;
    } else {
      el.innerHTML = `<div class="card" style="border-color:var(--accent)">Your request has been noted. The owner will be informed that this item is being looked for.</div>`;
    }
    $('#lookingForInput').value = '';
  } catch (e) { toast(e.message, true); }
};

// ─── Funnel indicator ─────────────────────────────────────────
function updateFunnel(stage) {
  const stages = ['exploring', 'saving', 'prioritizing', 'locked'];
  const idx = stages.indexOf(stage);
  $$('#funnelBar .step-dot').forEach((dot, i) => {
    dot.classList.remove('active', 'done');
    if (i < idx) dot.classList.add('done');
    else if (i === idx) dot.classList.add('active');
  });
}

// ─── Helpers ──────────────────────────────────────────────────
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return [...document.querySelectorAll(sel)]; }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

let toastTimer;
function toast(msg, isError) {
  const t = document.createElement('div');
  t.className = 'toast';
  if (isError) t.style.background = 'var(--danger)';
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3000);
}

// Start
init();
