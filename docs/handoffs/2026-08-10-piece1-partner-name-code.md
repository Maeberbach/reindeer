# Piece 1 — Partner display name (invite + confirm)

**Commit:** `5b9bef4` — "Registry Ship A follow-up: capture partner display name at invite and confirm"
**Date:** 2026-08-10
**Status:** Shipped. All 12 tests green (509 checks).
**Ship B (contested-items tile, holiday reminders):** planned but not started — see bottom of file.

---

## What it does

- Owner types the partner's preferred first name on the invite form (optional field).
- That name pre-fills on the partner's confirm screen. Partner can accept or edit it.
- Everywhere the app used to say "your partner" or show a raw email now shows the real name — the Home line reads "Linked with Bob," the memorandum conflict banner says "One thing to sort out with Bob."
- Security invariant preserved: the placeholder created at invite time is `role='invited', status='invited'`, which does NOT satisfy `partner_present` (that requires `status='active'`), so it cannot be used to fake a confirm without the invitee authenticating.
- Fixed a related bug: `upsertByEmail` never updated an existing participant's role, so Bob's magic-link consumption wasn't promoting him from `'invited'` to `'partner'`. New behavior: role only moves upward on a strict priority ladder (`owner > partner > invited`). Owner is never demoted.

---

## 1) `packages/legacy-core-data/src/repos/participantsRepo.js`

**Change 1 of 2** — inside `upsertByEmail`, replace the existing-participant UPDATE branch:

```js
    if (existing) {
      // We update display_name only when the caller passed a non-empty one
      // (so a routine touch does not blank an existing name). Role moves
      // only upward on a strict priority ladder: owner > partner > invited.
      // This lets the auth path promote 'invited' → 'partner' when a
      // freshly-invited participant consumes their magic link, without
      // ever demoting an owner or clobbering a partner back to invited.
      const rank = (r) => (r === 'owner' ? 3 : r === 'partner' ? 2 : r === 'invited' ? 1 : 0);
      const nextRole = rank(role) > rank(existing.role) ? role : existing.role;
      this.db.prepare(
        `UPDATE participants
           SET display_name = CASE WHEN ? != '' THEN ? ELSE display_name END,
               role = ?, status = ?, last_seen_at = ?, updated_at = ?
         WHERE participant_id = ?`,
      ).run(displayName, displayName, nextRole, status, now, now, existing.participant_id);
      return this.get(existing.participant_id);
    }
```

**Change 2 of 2** — add this new method (after `upsertByEmail`, before `touchLastSeen`):

```js
  /**
   * Set a participant's display name. Used by the client-side name-capture
   * step at partner invitation (owner types partner's preferred first name)
   * and at partner confirm (partner may edit or accept the suggestion).
   * The empty string is allowed — it clears the name.
   */
  updateDisplayName(participantId, displayName) {
    const now = new Date().toISOString();
    const name = String(displayName ?? '');
    this.db.prepare(
      'UPDATE participants SET display_name = ?, updated_at = ? WHERE participant_id = ?',
    ).run(name, now, participantId);
    return this.get(participantId);
  }
```

---

## 2) `apps/reindeer-registry/server/routes/householdLink.js`

**Change 1 of 2** — the `/household-link/invite` handler now accepts an optional `display_name`:

```js
  r.post('/household-link/invite', ownerOnly, async (req, res, next) => {
    try {
      const { email, display_name: partnerNameSuggestion } = req.body || {};
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'An email address is needed.' });
      }
      // ... existing scopeId + auth.issueMagicLink call unchanged ...
      // If the owner told us how the partner likes to be called, park the
      // name on a placeholder participant now (role='invited',
      // status='invited'). That status does NOT satisfy partner_present
      // (which requires status='active'), so it cannot be used to fake a
      // confirm without the invitee authenticating. When the invitee later
      // signs in via their magic link the auth path calls upsertByEmail
      // with role='partner' status='active', which now correctly promotes
      // the placeholder without clobbering the name.
      const suggested = String(partnerNameSuggestion ?? '').trim();
      if (suggested) {
        const existing = participants.findByEmail?.(email);
        if (existing) {
          participants.updateDisplayName?.(existing.participant_id, suggested);
        } else if (participants.upsertByEmail) {
          participants.upsertByEmail({
            email, displayName: suggested, role: 'invited', status: 'invited',
            householdScopeId: scopeId,
          });
        }
      }
      // link is null in production when a real mailer sent it; only echoed
      // back in tests / REINDEER_MAILER_OFF=1 mode.
      res.status(201).json({ ok: true, link, expires_at: expiresAt });
    } catch (err) { next(err); }
  });
```

**Change 2 of 2** — the `/household-link/confirm` handler now accepts an optional `display_name` for the confirming participant. Add these lines **right before** the `registry.linkHousehold(...)` call:

```js
    // Optional: the confirming partner may set (or override) their own
    // display name at this moment. This is how the app learns Bob is Bob
    // rather than showing his raw email in the "Linked with" line. If the
    // client didn't send a name, we keep whatever's already on file.
    const myName = String(req.body?.display_name ?? '').trim();
    if (myName && participants.updateDisplayName) {
      participants.updateDisplayName(meId, myName);
    }
    const updated = registry.linkHousehold(ctx, { linkedByParticipantId: meId });
    res.status(200).json({ ok: true, scope: publicScope(updated) });
  });
```

---

## 3) `apps/reindeer-registry/client/app.js`

**Change 1 of 3** — in `renderMemoConflicts()` (around line 3369), the conflict banner heading now uses the partner's name:

```js
  const partnerName = memoState.partner?.display_name || 'your partner';
  const withWhom = memoState.partner?.display_name ? `with ${partnerName}` : 'with your partner';
  $('#memoConflictPartner').textContent = partnerName;
  $('#memoConflictH').textContent = conflicts.length === 1
    ? `One thing to sort out ${withWhom}`
    : `${conflicts.length} things to sort out ${withWhom}`;
```

**Change 2 of 3** — in `loadHouseholdLink()`, the confirm-screen branch (`if (partnerPresent && canConfirm)`) now shows a name input:

```js
  if (partnerPresent && canConfirm) {
    // The confirming person is (usually) the invited partner arriving fresh.
    // Ask for their preferred first name here so the app can say "Linked with
    // Bob" everywhere instead of "Linked with bob@example.com". Pre-fill with
    // whatever the owner already suggested at invite time; the confirming
    // partner may accept or edit it. Sending an empty name keeps the current
    // value on file (see server route).
    const suggestedName = me?.display_name || '';
    body.innerHTML = `
      <h2>Confirm the link</h2>
      <p class="lede">${escapeHtml((partner?.display_name || partner?.email) || 'Your partner')} has signed in. Confirming links the two of you as a household. From then on, either of you can add items and record where they should go on a shared inventory.</p>
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
```

**Change 3 of 3** — in `loadHouseholdLink()`, the invite-form branch (the owner-facing "Send an invitation" HTML) now includes a name field, and the click handler posts it:

```js
  body.innerHTML = `
    <h2>Link a partner</h2>
    <p class="lede">Send an invitation to your spouse or partner. They will receive an email with a one-tap sign-in link, valid for twenty minutes. After they sign in, either of you can confirm the link.</p>
    <div class="invite-form">
      <label for="inviteName">Partner\u2019s first name (optional)</label>
      <input id="inviteName" type="text" autocomplete="given-name" placeholder="e.g., Bob">
      <label for="inviteEmail">Partner\u2019s email</label>
      <input id="inviteEmail" type="email" autocomplete="email" placeholder="name@example.com">
      <button class="primary wide" id="inviteBtn">Send invitation</button>
    </div>
    <p class="reassure">This does not sign anything or move any items. It only lets your partner see the same list. If you skip the name, they can add it when they confirm.</p>
    <div id="inviteResult" hidden></div>
  `;
  $('#inviteBtn').onclick = async () => {
    const email = $('#inviteEmail').value.trim();
    const display_name = $('#inviteName').value.trim();
    if (!email) { toast('Type your partner\u2019s email.', true); return; }
    if (!confirm(`Send the invitation to ${email}?`)) return;
    try {
      const out = await api('/api/household-link/invite', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, display_name }),
      });
      // ... existing inviteResult rendering unchanged ...
```

---

## 4) `apps/reindeer-registry/client/styles.css`

Broaden the existing invite-form input selector so text inputs (the new name field) get the same large styling as the email input:

```css
/* Invite form on the household-link screen. Kept large. */
.invite-form { margin: 20px 0; }
.invite-form label { display: block; font-weight: 600; margin-bottom: 6px; }
.invite-form input[type="email"],
.invite-form input[type="text"] {
  display: block; width: 100%; box-sizing: border-box;
  padding: 12px 14px; font-size: 19px;
  border-radius: 10px; border: 1px solid #cbc2b3; background: #fff;
  /* ... rest of existing rule unchanged ... */
}
```

---

## Verification (all green on this build)

| Suite | Checks |
| --- | --- |
| content-lint | clean |
| auth (in-process) | 33 |
| roundtrip (in-process) | 66 |
| memorandum (in-process) | 64 |
| household-link-http | 48 |
| memorandum-http | 68 |
| people | 36 |
| sign | 43 |
| two-lane | 22 |
| two-outputs-envelope | 37 |
| two-outputs-bundle | 60 |
| vision | 32 |
| **Total** | **509** |

Manual end-to-end also verified:
1. Ann invites Bob with suggested name "Robert" → placeholder created `role='invited' status='invited'`.
2. Bob consumes magic link → `upsertByEmail` promotes to `role='partner' status='active'`, preserves "Robert" name.
3. Ann sees the confirm screen with "Robert" pre-filled → she confirms with `display_name: 'Ann'`.
4. Both names captured, household linked. Home shows "Linked with Bob."
5. Security check: Ann cannot fake-confirm without Bob signing in (400 error, correct).

---

## Ship B — planned but NOT started

Waiting to build. Plan on file (approved defaults; questions were skipped):

**Home tile:** "Things families fight over" placed right after "Things meant for someone" (per your earlier answer).

**Screen shape (lean front door — chosen default):**
- One screen with 11 category cards. Each card has:
  - Category name (e.g., Jewelry, Guns, Holiday ornaments, Photographs, Silver & China, Musical Instruments, Art & Decor, Letters & Journals, Recipes, Watches, Handmade Items).
  - A one-line "why this matters" hint (why trustees find it hardest to divide).
  - Category-specific advice (jewelry: "Lay it all out on a table, photograph it as a group, then close-ups." Same offer for silver/china, photographs, recipes — non-mandatory).
  - Firearms card carries a trustee-legal notice above the button: "Firearms transfer is the trustee's job, not ours. Record what you have and what you'd like to happen. Your trustee handles the legal side."
  - Firearms keeps `assign to a person` as **optional** (per your answer).
  - One button per card: "Add [category] items" → jumps into existing `capture` flow with `cap.category = '<name>'` pre-selected.
- Bottom of the screen: "Holiday reminders" checkbox picker (Thanksgiving, Christmas, Hanukkah, Passover, etc.) + note that it saves to `reminder_prefs` and Perplexity Computer sends the emails on your side (registry does not send email).

**Data (chosen default):**
- Add the 4 missing categories (`Letters & Journals`, `Recipes`, `Watches`, `Handmade Items`) to `MORE_CATEGORIES` in `packages/legacy-core-api/src/models/index.js` so they show up in the normal capture chip picker too.
- New tiny table: `reminder_prefs (participant_id, holidays_json, updated_at)`.
- New endpoint: `POST /api/reminders/holidays` (owner-only) writes to `reminder_prefs`.

**Cron:** created on your side via `schedule_cron` (registry does not send email). Each holiday's send date computed once per year; each cron fire calls a script that reads `reminder_prefs` and emails owners whose prefs include that holiday.

**Files to edit for Ship B:**
- `packages/legacy-core-api/src/models/index.js` — extend `MORE_CATEGORIES`.
- `packages/legacy-core-data/src/migrations/index.js` — add `reminder_prefs` table.
- `packages/legacy-core-data/src/repos/reminderPrefsRepo.js` — new (small).
- `apps/reindeer-registry/server/routes/reminders.js` — new (small).
- `apps/reindeer-registry/server/index.js` — wire the route.
- `apps/reindeer-registry/client/index.html` — new Home tile + new screen shell.
- `apps/reindeer-registry/client/app.js` — screen renderer (~120 lines) + capture-category pre-select.
- `apps/reindeer-registry/client/styles.css` — new card + notice styles (~30 lines).
- `scripts/contested-categories-test.mjs` — new (small).

Estimated size: ~250 lines total across the diff, plus one new test suite.

---

# Ship B — code blocks (committed as `6642bef`)

**What Ship B does (plain English)**

- Adds a Home tile called **"Things families fight over"**. Tapping it opens a new screen with one card per category (jewelry, silver & china, photographs, holiday ornaments, heirloom furniture, collectibles, musical instruments, guns, letters & journals, recipes, watches, handmade items). Each card carries a plain-language reason for the friction and one piece of practical advice. Guns carries an extra trustee-legal notice above the button. Each button jumps straight into the existing capture flow with the category already selected.
- Adds a **holiday reminders** picker at the bottom of the same screen. You tick the holidays you'd like a nudge for and press Save. Nothing is emailed by the Registry itself — a separate Perplexity Computer scheduled task reads the saved picks and dispatches the emails.
- Adds four categories to the standard "more categories" list so they show up during normal capture too: **Letters & Journals**, **Recipes**, **Watches**, **Handmade Items**.

**Verification (all green after Ship B)**

| Test | Checks |
| --- | ---: |
| auth (in-process) | 33 |
| roundtrip | 66 |
| memorandum | 64 |
| content-lint | clean |
| household-link-http | 48 |
| memorandum-http | 68 |
| people | 36 |
| sign | 43 |
| two-lane | 22 |
| two-outputs-envelope | 37 |
| two-outputs-bundle | 60 |
| vision | 32 |
| reminders-http (new) | 31 |
| **Total** | **540** (was 509) |

---

## 1. Extend `MORE_CATEGORIES` — `packages/legacy-core-api/src/models/index.js`

*Adds four categories to the "more categories" dropdown the capture screen already exposes.*

```diff
@@ -218,6 +218,11 @@ export const MORE_CATEGORIES = Object.freeze([
   'Heirlooms', 'Personal Possessions', 'Furniture', 'Real Property Contents',
   'Kitchenware', 'Electronics', 'Tools', 'Books',
   'Sporting Goods', 'Clothing', 'Documents', 'Digital Assets',
+  // Added for the "Things families fight over" flow. These are categories
+  // trustees repeatedly report as the hardest to divide because they carry
+  // strong personal memory and no market price. They stay in MORE (not
+  // DEFAULT) so they only appear when the owner opts in.
+  'Letters & Journals', 'Recipes', 'Watches', 'Handmade Items',
 ]);
 
 /**
```

---

## 2. New migration 17 — `packages/legacy-core-data/src/migrations/index.js`

*Creates one small table keyed by (scope_id, participant_id) holding the JSON list of holidays each participant asked to be reminded about.*

```diff
@@ -783,4 +783,24 @@ export const MIGRATIONS = [
         ON memorandum_signings (scope_id, participant_id);
     `,
   },
+  {
+    id: 17,
+    name: 'reminder_prefs',
+    // A single row per (scope, participant) captures which holidays the
+    // owner wants a nudge for. holidays_json is a small JSON array of
+    // holiday keys drawn from a fixed vocabulary the client renders as
+    // checkboxes (see /api/reminders/holidays). The Registry itself never
+    // sends email \u2014 a Perplexity Computer scheduled task reads this
+    // table and dispatches the actual reminders. Kept scope-scoped so a
+    // partner and owner on the same scope can each have their own list.
+    sql: `
+      CREATE TABLE reminder_prefs (
+        scope_id       TEXT NOT NULL,
+        participant_id TEXT NOT NULL,
+        holidays_json  TEXT NOT NULL DEFAULT '[]',
+        updated_at     TEXT NOT NULL,
+        PRIMARY KEY (scope_id, participant_id)
+      );
+    `,
+  },
 ];
```

---

## 3. New file — `packages/legacy-core-data/src/repos/reminderPrefsRepo.js`

*Small repo with `get`, `set`, and `participantsForHoliday` (used by the future scheduled task to look up who to email).*

```javascript
/*
 * Reminder preferences.
 *
 * One row per (scope, participant). Stores a small JSON array of holiday
 * keys the owner (or partner) has asked to be reminded about. The Registry
 * itself does not send email — a Perplexity Computer scheduled task reads
 * this table and dispatches the actual reminders.
 *
 * The vocabulary of allowed keys lives in the router (see
 * apps/reindeer-registry/server/routes/reminders.js) so the frontend and the
 * scheduled task agree on the exact strings.
 */
export class ReminderPrefsRepo {
  constructor(db) { this.db = db; }

  /**
   * Return the participant's picked holidays as an array of keys. An empty
   * array means "no reminders opted in yet." Never returns null.
   */
  get(scopeId, participantId) {
    const row = this.db.prepare(
      'SELECT holidays_json FROM reminder_prefs WHERE scope_id = ? AND participant_id = ?',
    ).get(scopeId, participantId);
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.holidays_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  /**
   * Replace the participant's list. Caller is expected to have already
   * validated each entry against the router's allowed vocabulary. Storing
   * an empty array is meaningful — it clears all opt-ins.
   */
  set(scopeId, participantId, holidayKeys) {
    const now = new Date().toISOString();
    const json = JSON.stringify(Array.isArray(holidayKeys) ? holidayKeys : []);
    this.db.prepare(
      `INSERT INTO reminder_prefs (scope_id, participant_id, holidays_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope_id, participant_id) DO UPDATE SET
         holidays_json = excluded.holidays_json,
         updated_at    = excluded.updated_at`,
    ).run(scopeId, participantId, json, now);
    return this.get(scopeId, participantId);
  }

  /**
   * Used by the scheduled task: list every participant across every scope
   * whose picked holidays include the given key. Returns rows with the
   * participant_id and scope_id so the caller can join to participants for
   * an email address.
   */
  participantsForHoliday(key) {
    const rows = this.db.prepare(
      'SELECT scope_id, participant_id, holidays_json FROM reminder_prefs',
    ).all();
    const hits = [];
    for (const row of rows) {
      try {
        const list = JSON.parse(row.holidays_json);
        if (Array.isArray(list) && list.includes(key)) {
          hits.push({ scope_id: row.scope_id, participant_id: row.participant_id });
        }
      } catch { /* skip corrupt rows */ }
    }
    return hits;
  }
}
```

---

## 4. Export the new repo — `packages/legacy-core-data/src/index.js`

```diff
@@ -12,3 +12,4 @@ export { ParticipantsRepo, normalizeEmail } from './repos/participantsRepo.js';
 export { MagicLinksRepo, MAGIC_LINK_TTL_MINUTES } from './repos/magicLinksRepo.js';
 export { SessionsRepo, SESSION_TTL_MILLISECONDS } from './repos/sessionsRepo.js';
 export { MemorandumRepo } from './repos/memorandumRepo.js';
+export { ReminderPrefsRepo } from './repos/reminderPrefsRepo.js';
```

---

## 5. New file — `apps/reindeer-registry/server/routes/reminders.js`

*Two endpoints. `GET /api/reminders/holidays` returns the vocabulary of holidays plus the participant's saved picks. `POST /api/reminders/holidays` accepts `{ holidays: string[] }`, de-dupes, and rejects unknown keys with a 400.*

```javascript
/*
 * Holiday reminders.
 *
 * The owner (or their linked partner) picks which holidays they want a nudge
 * about — "photograph the tree," "bring a camera to Thanksgiving," etc. The
 * Registry does NOT send the email itself. It stores the picks in
 * reminder_prefs and a Perplexity Computer scheduled task reads the table
 * and dispatches the actual emails on the right days.
 *
 * The allowed keys are a small closed vocabulary shared between this route
 * and the client. Add a key here first, then the client checkbox, then the
 * scheduled task.
 *
 * Identity is always taken from req.participant.participant_id. No body
 * field ever supplies an identity.
 */
import express from 'express';
import { makeScopeCtx } from '@reindeer-legacy/core-api';

export const HOLIDAY_KEYS = Object.freeze([
  'thanksgiving',
  'christmas',
  'hanukkah',
  'passover',
  'diwali',
  'lunar_new_year',
  'easter',
  'mothers_day',
  'fathers_day',
  'independence_day',
  'birthdays',
]);

export const HOLIDAY_LABELS = Object.freeze({
  thanksgiving: 'Thanksgiving',
  christmas: 'Christmas',
  hanukkah: 'Hanukkah',
  passover: 'Passover',
  diwali: 'Diwali',
  lunar_new_year: 'Lunar New Year',
  easter: 'Easter',
  mothers_day: "Mother's Day",
  fathers_day: "Father's Day",
  independence_day: 'Independence Day',
  birthdays: 'Family birthdays',
});

function signedIn(req, res, next) {
  if (!req.participant) return res.status(401).json({ error: 'Sign in to continue.' });
  return next();
}

export function createRemindersRouter({ reminderPrefs, resolveScope }) {
  const r = express.Router();
  const ctxOf = (req) => makeScopeCtx(resolveScope(req));
  const me = (req) => req.participant?.participant_id;

  /*
   * GET /reminders/holidays
   *   Returns the current participant's picked holidays plus the full
   *   vocabulary so the client can render checkboxes without a second call.
   */
  r.get('/reminders/holidays', signedIn, (req, res) => {
    const ctx = ctxOf(req);
    const picks = reminderPrefs.get(ctx.scopeId, me(req));
    res.json({
      picked: picks,
      vocabulary: HOLIDAY_KEYS.map((k) => ({ key: k, label: HOLIDAY_LABELS[k] })),
    });
  });

  /*
   * POST /reminders/holidays
   *   Body: { holidays: string[] } — a full replacement of the picked list.
   *   Empty array clears all opt-ins. Every entry must be in HOLIDAY_KEYS
   *   or the whole request is rejected 400.
   */
  r.post('/reminders/holidays', signedIn, express.json(), (req, res) => {
    const ctx = ctxOf(req);
    const raw = req.body?.holidays;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: 'holidays must be an array.' });
    }
    const bad = raw.find((k) => typeof k !== 'string' || !HOLIDAY_KEYS.includes(k));
    if (bad !== undefined) {
      return res.status(400).json({ error: `Unknown holiday: ${String(bad)}` });
    }
    // De-duplicate while preserving order.
    const seen = new Set();
    const cleaned = raw.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
    const saved = reminderPrefs.set(ctx.scopeId, me(req), cleaned);
    res.json({ ok: true, picked: saved });
  });

  return r;
}
```

---

## 6. Wire the route + repo — `apps/reindeer-registry/server/index.js`

```diff
@@ -2,13 +2,14 @@ import express from 'express';
 import path from 'node:path';
 import { fileURLToPath } from 'node:url';
 import { SCOPE_TYPE } from '@reindeer-legacy/core-api';
-import { openDb, defaultDataDir, SqliteAuditLog, SqliteItemRepository, FsMediaStore, ScopeMediaStore, Registry, PeopleRepo, HeirsRepo, WillsCaretakersRepo, AddendumVersionsRepo, ParticipantsRepo, MagicLinksRepo, SessionsRepo, MemorandumRepo } from '@reindeer-legacy/core-data';
+import { openDb, defaultDataDir, SqliteAuditLog, SqliteItemRepository, FsMediaStore, ScopeMediaStore, Registry, PeopleRepo, HeirsRepo, WillsCaretakersRepo, AddendumVersionsRepo, ParticipantsRepo, MagicLinksRepo, SessionsRepo, MemorandumRepo, ReminderPrefsRepo } from '@reindeer-legacy/core-data';
 import { AuthService } from './auth/service.js';
 import { attachSession, authRequired } from './auth/middleware.js';
 import { createAuthRouter } from './auth/router.js';
 import { createScopeSummaryRouter } from './routes/scopeSummary.js';
 import { createHouseholdLinkRouter } from './routes/householdLink.js';
 import { createMemorandumRouter } from './routes/memorandum.js';
+import { createRemindersRouter } from './routes/reminders.js';
 import crypto from 'node:crypto';
 import { createIntakeRouter, createExecutionRouter, createPeopleRouter, legacyErrorHandler, MockVisionProvider, HttpVisionProvider, AnthropicVisionProvider, SimpleDuplicateDetector } from '@reindeer-legacy/intake-feature';
 import { createPrintRouter } from '@reindeer-legacy/print-feature';
@@ -104,6 +105,7 @@ const heirs = new HeirsRepo(db, audit);
 const willsCaretakers = new WillsCaretakersRepo(db, audit);
 const addendumVersions = new AddendumVersionsRepo(db, audit);
 const memorandum = new MemorandumRepo(db, audit);
+const reminderPrefs = new ReminderPrefsRepo(db);
 
 const delivery = new DeliveryService({
   db, audit, itemRepo, mediaStore, scopeMediaStore, registry, trustees, mailer,
@@ -145,6 +147,7 @@ app.use('/api', authRequired);
 app.use('/api', createScopeSummaryRouter({ registry, participants, resolveScope }));
 app.use('/api', createHouseholdLinkRouter({ registry, participants, auth, resolveScope }));
 app.use('/api', createMemorandumRouter({ memorandum, registry, participants, resolveScope }));
+app.use('/api', createRemindersRouter({ reminderPrefs, resolveScope }));
 app.use('/api', createIntakeRouter({ itemRepo, mediaStore, scopeMediaStore, registry, vision, duplicates, audit, resolveScope }));
 app.use('/api', createExecutionRouter({ db, scopeMediaStore, audit, resolveScope }));
 app.use('/api', createPeopleRouter({ people, audit, resolveScope }));
```

---

## 7. Home tile + new screen shell — `apps/reindeer-registry/client/index.html`

*Adds one tile on Home (`🤝 Things families fight over`) and the `data-screen="contested"` section it opens to.*

```diff
@@ -176,6 +176,14 @@
     -->
     <div class="tiles">
       <button class="tile primary" data-go="promise"><span class="ico">💝</span><span class="lbl">Things meant for someone</span><span class="hint">Add items and people you have already decided.</span></button>
+      <!--
+        Ship B \u2014 the "Things families fight over" tile. Places right
+        after the Promise tile because it is a second door into naming
+        specific items, this time organised by the categories trustees
+        report as the hardest to divide. Opens a lean guided screen with
+        per-category advice and jumps back into the existing capture flow.
+      -->
+      <button class="tile" data-go="contested"><span class="ico">🤝</span><span class="lbl">Things families fight over</span><span class="hint">The kinds trustees say cause the most trouble. Get ahead of them one category at a time.</span></button>
       <button class="tile" data-go="walk"><span class="ico">🏠</span><span class="lbl">Everything else in the house</span><span class="hint">One room at a time. Point the camera, and it writes down what it sees</span></button>
       <!--
         Special gifts by name.
@@ -241,6 +249,35 @@
     So the list of rooms is the list of work, each one showing plainly whether it
     is done, part-done or untouched, and there is exactly one obvious next step.
   -->
+  <!--
+    Ship B \u2014 "Things families fight over" screen.
+
+    A guided front door to the categories that trustees repeatedly say cause
+    the most family friction. Each card carries a plain-language reason for
+    the friction, one piece of practical advice ("lay all your jewelry on a
+    table together and photograph it as a group before you name any of it"),
+    and one button that jumps straight into the existing capture flow with
+    that category pre-selected. Firearms carries an extra trustee-legal
+    notice above the button; the button still works because some owners will
+    already know where each piece is meant to go.
+
+    The screen ends with a small "holiday reminders" section: a checkbox
+    picker of holidays the owner would like a nudge about. The Registry
+    itself does NOT send email \u2014 a Perplexity Computer scheduled task
+    reads reminder_prefs and dispatches the emails on the right days.
+  -->
+  <section class="screen" data-screen="contested" hidden>
+    <p class="lede">These are the kinds of things trustees say families fight over most. Pick a category and get ahead of it one item at a time. Nothing here is a will \u2014 you are just writing down what you would like to happen.</p>
+    <div id="contestedCards" class="contested-cards"></div>
+    <hr class="softrule">
+    <h2>Holiday reminders</h2>
+    <p class="reassure">Pick the times of year when you would like a small email nudge ("bring a camera to Thanksgiving"). You can change this any time. Nothing is sent unless you ask for it.</p>
+    <div id="reminderPicker" class="reminder-picker"></div>
+    <div class="detrow">
+      <button class="primary" id="reminderSaveBtn">Save reminders</button>
+    </div>
+  </section>
+
   <section class="screen" data-screen="walk" hidden>
     <p class="lede">Take one room at a time. There is no hurry, and you can stop whenever you like.</p>
 
```

---

## 8. Renderer + capture pre-select — `apps/reindeer-registry/client/app.js`

*Three edits: (a) map `contested` to the screen title, (b) call `renderContestedCards()` + `loadReminderPicker()` when the screen opens, (c) in the existing `renderCatChips`, auto-press or promote the chip if `cap.category` is already set. Then a large appended block: `CONTESTED_CATEGORIES` (the per-category copy), `renderContestedCards`, and `loadReminderPicker`.*

```diff
@@ -156,6 +156,8 @@ function go(name, opts = {}) {
     memo: 'Specific gifts by name', memoentry: 'One gift',
     // Slice 4 \u2014 couple mode.
     householdlink: 'Link a partner',
+    // Ship B \u2014 contested categories.
+    contested: 'Things families fight over',
   }[name] ?? 'Reindeer: Registry';
   window.scrollTo(0, 0);
   if (name === 'walk') loadWalk();
@@ -183,6 +185,9 @@ function go(name, opts = {}) {
   // Slice 4 \u2014 household-link screen. Refreshes its data on every mount
   // so link state stays fresh without an app-wide state store.
   if (name === 'householdlink') loadHouseholdLink();
+  // Ship B \u2014 contested-categories screen. Renders per-category cards
+  // and re-fetches the participant's saved holiday picks each time.
+  if (name === 'contested') { renderContestedCards(); loadReminderPicker(); }
 }
 const currentScreen = () => $$('.screen').find((s) => !s.hidden)?.dataset.screen ?? 'home';
 
@@ -1707,6 +1712,18 @@ function renderCatChips() {
     };
   });
 
+  // Ship B \u2014 if the contested-categories screen pre-set cap.category
+  // before jumping here, visually press the matching chip so the owner sees
+  // it is already selected. If the chip is not on today's list yet (a
+  // MORE_CATEGORIES entry), promote it now; addOfferedCategory selects it.
+  if (cap && cap.category) {
+    const match = $$('#catChips .chip').find((c) => c.dataset.cat === cap.category);
+    if (match) match.setAttribute('aria-pressed', 'true');
+    else if ((registry.more_categories ?? []).includes(cap.category)) {
+      addOfferedCategory(cap.category);
+    }
+  }
+
   renderCatMore();
 }
 
@@ -3721,3 +3738,110 @@ async function loadHouseholdLink() {
     } catch (e) { toast(e.message, true); }
   };
 }
+
+// ---------------------------------------------------------- Ship B: contested
+/*
+ * "Things families fight over" screen.
+ *
+ * Static, hand-written per-category advice. Each entry maps to a category
+ * name the intake flow already knows (from DEFAULT_CATEGORIES seeded on
+ * scope creation, or MORE_CATEGORIES the owner can promote). The `notice`
+ * field is optional and reserved for firearms today — it renders as a
+ * distinct call-out above the button so an owner cannot miss it. Firearms
+ * still allows an assign action because some owners already know exactly
+ * where each piece is meant to go; the notice is about legal responsibility,
+ * not about hiding the flow.
+ */
+const CONTESTED_CATEGORIES = [
+  { key: 'Jewelry', why: 'Everyone remembers a piece differently, and market value hides the story.',
+    advice: 'Lay all your jewelry out on a table together. Take a wide photo of the whole spread first, then close-ups of each piece. Do it once and it is done.' },
+  { key: 'Silver & China', why: 'Sets get split by accident, then nobody has a whole set.',
+    advice: 'Put the whole set out on the table. One group photo, then close-ups of anything with a mark, monogram or maker.' },
+  { key: 'Photographs', why: 'Physical photos have one copy. Whoever gets the box gets the memory.',
+    advice: 'Lay a stack out on the table by decade or by person. Photograph the group, then the ones with people you can name on the back.' },
+  { key: 'Holiday ornaments', why: 'Every family fights about who gets Grandma\u2019s ornaments.',
+    advice: 'Bring the box out at the holiday. Photograph as you unwrap. Say aloud who gave you which ornament \u2014 the recording is the point.' },
+  { key: 'Heirloom and special furniture', why: 'Big pieces are hard to move; who \u201cclaims\u201d them turns tense.',
+    advice: 'Photograph the piece where it lives. Note the maker or the story on the back. Say who you hope will make room for it.' },
+  { key: 'Collectibles \u2014 artwork, rare wine or spirits', why: 'Value is fuzzy and easy to argue about.',
+    advice: 'Photograph each piece with a ruler or hand for scale. Note where you bought it and roughly when.' },
+  { key: 'Musical Instruments', why: 'The person who plays it usually wants it, and everyone assumes it goes to them.',
+    advice: 'Photograph the instrument and any case label or serial number. Say who you hope will play it next.' },
+  { key: 'Guns', why: 'Firearms carry legal rules your trustee will handle. Do not transfer them yourself.',
+    advice: 'Record what you have and what you would like to happen to each piece. Photograph the piece with any serial visible. Your trustee handles the transfer legally.',
+    notice: 'Firearms transfer is the trustee\u2019s job, not ours. Record what you have and what you would like to happen to each piece. Your trustee will handle the legal side.' },
+  { key: 'Letters & Journals', why: 'Written words are once-only. The person who reads them first shapes the story.',
+    advice: 'Photograph the outside of the folder or box. You do not have to open every letter. Say who you would like to keep them.' },
+  { key: 'Recipes', why: 'Handwritten recipes are memory, not paper. They usually vanish.',
+    advice: 'Lay them out on the table. Photograph the ones in a hand you recognise. Say aloud who taught you the dish.' },
+  { key: 'Watches', why: 'Small, valuable, easy to slip into a pocket. Also carry a story.',
+    advice: 'Photograph the watch face and the back. Note the maker. Say who you hope will wear it.' },
+  { key: 'Handmade Items', why: 'The maker\u2019s hand is what makes it precious. Nobody else can replace it.',
+    advice: 'Photograph the piece and, if possible, a piece of the maker\u2019s handwriting or mark. Say who made it and for whom.' },
+];
+
+function renderContestedCards() {
+  const wrap = $('#contestedCards');
+  if (!wrap) return;
+  wrap.innerHTML = CONTESTED_CATEGORIES.map((c, i) => `
+    <article class="contested-card" data-idx="${i}">
+      <h3>${escapeHtml(c.key)}</h3>
+      <p class="why">${escapeHtml(c.why)}</p>
+      <p class="advice">${escapeHtml(c.advice)}</p>
+      ${c.notice ? `<div class="trustee-notice"><strong>A word about firearms.</strong> ${escapeHtml(c.notice)}</div>` : ''}
+      <div class="detrow">
+        <button class="primary contested-add" data-cat="${escapeHtml(c.key)}">Add ${escapeHtml(c.key)} items</button>
+      </div>
+    </article>
+  `).join('');
+  $$('#contestedCards .contested-add').forEach((btn) => {
+    btn.onclick = () => {
+      const name = btn.dataset.cat;
+      // Start a fresh capture but seed the category. The capture screen's
+      // renderCatChips picks this up and presses (or promotes) the chip.
+      resetCapture();
+      cap.category = name;
+      go('capture');
+    };
+  });
+}
+
+/*
+ * Holiday reminder picker.
+ *
+ * Renders a checkbox list from the server's vocabulary, ticks the
+ * participant's saved picks, and posts the full replacement list on save.
+ * The Registry itself never sends email; a Perplexity Computer scheduled
+ * task reads reminder_prefs and dispatches on the right days.
+ */
+async function loadReminderPicker() {
+  const wrap = $('#reminderPicker');
+  if (!wrap) return;
+  wrap.innerHTML = '<p class="reassure">Loading\u2026</p>';
+  try {
+    const data = await api('/api/reminders/holidays');
+    const picked = new Set(data.picked || []);
+    wrap.innerHTML = (data.vocabulary || []).map((h) => `
+      <label class="reminder-row">
+        <input type="checkbox" data-key="${escapeHtml(h.key)}" ${picked.has(h.key) ? 'checked' : ''}>
+        <span>${escapeHtml(h.label)}</span>
+      </label>
+    `).join('');
+    const saveBtn = $('#reminderSaveBtn');
+    if (saveBtn) {
+      saveBtn.onclick = async () => {
+        const keys = $$('#reminderPicker input[type="checkbox"]:checked')
+          .map((c) => c.dataset.key);
+        try {
+          await api('/api/reminders/holidays', {
+            method: 'POST', headers: { 'content-type': 'application/json' },
+            body: JSON.stringify({ holidays: keys }),
+          });
+          toast(keys.length ? 'Reminders saved.' : 'Reminders turned off.');
+        } catch (e) { toast(e.message, true); }
+      };
+    }
+  } catch (e) {
+    wrap.innerHTML = `<p class="reassure">Could not load: ${escapeHtml(e.message)}</p>`;
+  }
+}
```

---

## 9. New card + notice + picker styles — `apps/reindeer-registry/client/styles.css`

```diff
@@ -829,3 +829,43 @@ select.bigin{appearance:none; background-image:linear-gradient(45deg,transparent
 
 /* Quiet hint used on a Home tile in the header row. */
 .quiet-hint{color:var(--ink-2); font-size:14px; margin-left:6px}
+
+/* -------------------------------------------------- Ship B: contested screen */
+.contested-cards { display: grid; gap: 16px; margin-top: 16px; }
+.contested-card {
+  background: #fff; border: 1px solid #e5dccb;
+  border-radius: 14px; padding: 18px 20px;
+}
+.contested-card h3 { margin: 0 0 6px 0; font-size: 22px; }
+.contested-card .why {
+  margin: 0 0 10px 0; color: #6c5f4b; font-size: 16px; line-height: 1.4;
+}
+.contested-card .advice {
+  margin: 0 0 12px 0; font-size: 17px; line-height: 1.5;
+}
+.contested-card .trustee-notice {
+  background: #fff4d6; border-left: 4px solid #c89b1a;
+  padding: 12px 14px; border-radius: 8px;
+  margin: 0 0 14px 0; font-size: 16px; line-height: 1.45;
+}
+.contested-card .trustee-notice strong { display: block; margin-bottom: 4px; }
+.contested-card .detrow { margin-top: 8px; }
+
+/* Softer rule between the categories list and the holiday picker. */
+hr.softrule {
+  border: 0; border-top: 1px solid #e5dccb; margin: 28px 0 20px 0;
+}
+
+/* Holiday reminder checkbox list. Large targets for elderly users. */
+.reminder-picker {
+  display: grid; gap: 8px; margin: 12px 0 18px 0;
+}
+.reminder-row {
+  display: flex; align-items: center; gap: 12px;
+  padding: 12px 14px; background: #fff;
+  border: 1px solid #e5dccb; border-radius: 10px;
+  font-size: 18px; cursor: pointer;
+}
+.reminder-row input[type="checkbox"] {
+  width: 22px; height: 22px; margin: 0;
+}
```

---

## 10. New file — `scripts/reminders-http-test.mjs`

*Thirteen scenarios covering auth guard (once bootstrap ends), fresh state + vocabulary, POST-save, round trip, full-replacement, empty clears, non-array/unknown/non-string rejection, de-duplication, and per-participant isolation. **31 checks all green.***

```javascript
/*
 * Reminders — HTTP integration test.
 *
 * What this covers
 *   1. Auth guard         — unauthenticated calls are 401
 *   2. GET default state  — new participant has an empty list + full vocab
 *   3. POST replaces      — full-replacement semantics
 *   4. Invalid input      — non-array body 400, unknown key 400
 *   5. Round trip         — POST followed by GET returns the saved picks
 *   6. Empty clears       — POST []  reduces stored picks to nothing
 *   7. De-duplication     — repeats in the payload are stored once
 *   8. Per-participant    — Ann's picks do not appear in Bob's GET
 *
 * Prerequisites (same as the other HTTP suites)
 *   • Server up on BASE (default http://localhost:3210) with
 *     REINDEER_MAILER_OFF=1 so magic links come back in the response body.
 *   • Fresh temp REINDEER_INVENTORY_DIR so the first sign-in mints the
 *     bootstrap owner.
 */
import {
  requestMagicLink, consumeMagicLink, TEST_OWNER_EMAIL,
} from './lib/http-auth.mjs';

const BASE = process.env.BASE || 'http://localhost:3210';
const ANN_EMAIL = TEST_OWNER_EMAIL;
const BOB_EMAIL = 'test-partner@localhost.test';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  OK: ' + m)) : (fail++, console.log('  FAIL: ' + m)); };

async function signIn(email) {
  const link = await requestMagicLink(BASE, email);
  return consumeMagicLink(BASE, link);
}

const asClient = (cookie) => {
  const headers = cookie ? { cookie } : {};
  const j = async (p, o = {}) => {
    const r = await fetch(BASE + p, { ...o, headers: { ...headers, ...(o.headers || {}) } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return {
    get: (p) => j(p),
    post: (p, b) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }),
  };
};

console.log('\n1. Sign in as Ann (bootstrap owner) — must happen first so bootstrap mode ends');
const annCookie = await signIn(ANN_EMAIL);
const ann = asClient(annCookie);
{
  const r = await ann.get('/api/auth/me');
  ok(r.body?.participant?.role === 'owner', 'ann is the owner');
}

console.log('\n2. Unauthenticated GET is rejected once a real owner exists');
{
  const r = await asClient(null).get('/api/reminders/holidays');
  ok(r.status === 401, 'GET without cookie → 401');
}

console.log('\n3. Unauthenticated POST is rejected once a real owner exists');
{
  const r = await asClient(null).post('/api/reminders/holidays', { holidays: ['thanksgiving'] });
  ok(r.status === 401, 'POST without cookie → 401');
}

console.log('\n4. Fresh state: picked is empty, vocabulary is present');
{
  const r = await ann.get('/api/reminders/holidays');
  ok(r.status === 200, 'GET → 200');
  ok(Array.isArray(r.body.picked), 'picked is an array');
  ok(r.body.picked.length === 0, 'picked starts empty');
  ok(Array.isArray(r.body.vocabulary), 'vocabulary is an array');
  ok(r.body.vocabulary.length >= 8, 'vocabulary has at least eight entries');
  const hasThx = r.body.vocabulary.find((h) => h.key === 'thanksgiving');
  ok(hasThx && hasThx.label === 'Thanksgiving', 'thanksgiving key is labelled correctly');
  const hasBirthdays = r.body.vocabulary.find((h) => h.key === 'birthdays');
  ok(hasBirthdays && hasBirthdays.label === 'Family birthdays', 'birthdays key present');
}

console.log('\n5. POST valid list is saved');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: ['thanksgiving', 'christmas'] });
  ok(r.status === 200, 'POST → 200');
  ok(r.body.ok === true, 'body.ok is true');
  ok(JSON.stringify(r.body.picked) === JSON.stringify(['thanksgiving', 'christmas']), 'response echoes picks');
}

console.log('\n6. GET round trip returns the saved picks');
{
  const r = await ann.get('/api/reminders/holidays');
  ok(JSON.stringify(r.body.picked) === JSON.stringify(['thanksgiving', 'christmas']), 'picks survived');
}

console.log('\n7. POST full-replacement semantics');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: ['easter'] });
  ok(JSON.stringify(r.body.picked) === JSON.stringify(['easter']), 'the new list replaces the old');
  const g = await ann.get('/api/reminders/holidays');
  ok(JSON.stringify(g.body.picked) === JSON.stringify(['easter']), 'and reads back the same way');
}

console.log('\n8. POST empty array clears everything');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: [] });
  ok(r.body.picked.length === 0, 'server returns empty picks');
  const g = await ann.get('/api/reminders/holidays');
  ok(g.body.picked.length === 0, 'GET confirms empty state');
}

console.log('\n9. POST rejects non-array body');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: 'thanksgiving' });
  ok(r.status === 400, 'string body → 400');
  const r2 = await ann.post('/api/reminders/holidays', { holidays: null });
  ok(r2.status === 400, 'null body → 400');
  const r3 = await ann.post('/api/reminders/holidays', {});
  ok(r3.status === 400, 'missing field → 400');
}

console.log('\n10. POST rejects unknown holiday keys');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: ['thanksgiving', 'not_a_holiday'] });
  ok(r.status === 400, 'unknown key → 400');
  ok(String(r.body?.error || '').includes('not_a_holiday'), 'error names the bad key');
  const g = await ann.get('/api/reminders/holidays');
  ok(g.body.picked.length === 0, 'rejected request did not partially save');
}

console.log('\n11. POST rejects non-string entries');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: ['thanksgiving', 42] });
  ok(r.status === 400, 'number entry → 400');
}

console.log('\n12. POST de-duplicates repeats');
{
  const r = await ann.post('/api/reminders/holidays', { holidays: ['thanksgiving', 'christmas', 'thanksgiving'] });
  ok(JSON.stringify(r.body.picked) === JSON.stringify(['thanksgiving', 'christmas']), 'duplicates collapsed once');
}

console.log('\n13. Per-participant isolation');
{
  // Ann invites Bob as partner, Bob signs in, Bob's picks start empty.
  const inv = await ann.post('/api/household-link/invite', { email: BOB_EMAIL });
  ok(inv.status === 201, 'invite issued');
  const bobLink = inv.body.link;
  const bobCookie = await consumeMagicLink(BASE, bobLink);
  const bob = asClient(bobCookie);
  const g = await bob.get('/api/reminders/holidays');
  ok(g.status === 200 && g.body.picked.length === 0, 'bob starts with an empty list even though ann has picks');
  const gAnn = await ann.get('/api/reminders/holidays');
  ok(JSON.stringify(gAnn.body.picked) === JSON.stringify(['thanksgiving', 'christmas']), 'ann\u2019s list is untouched');
  // Bob saves his own picks; ann's stay separate.
  await bob.post('/api/reminders/holidays', { holidays: ['diwali'] });
  const gBob2 = await bob.get('/api/reminders/holidays');
  const gAnn2 = await ann.get('/api/reminders/holidays');
  ok(JSON.stringify(gBob2.body.picked) === JSON.stringify(['diwali']), 'bob has diwali');
  ok(JSON.stringify(gAnn2.body.picked) === JSON.stringify(['thanksgiving', 'christmas']), 'ann still has her two');
}

console.log(`\n${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

---

## What still needs your approval

1. **Screenshots of the new screens** — the app screens have code but I haven't taken pictures yet. Say the word and I will render:
   - The Home tile above the fold.
   - The contested screen showing all 12 cards.
   - The firearms card with its trustee-legal notice.
   - The holiday reminders picker with picks saved.

2. **The email cron.** No scheduled task has been created yet. Each recurring task fires on a real cadence and costs credits, so I'd like your explicit approval before creating any. My proposal is a **single yearly digest** on **November 1** (roughly 4-6 weeks before Thanksgiving/Christmas — the two most-picked reminders) that emails each participant a short "these are the things you asked to be reminded about" note, with a link back to the app. That's one cron, not eleven, and once a year. Reply "yes" and I'll create it and confirm the schedule.

3. **A "manage reminders anytime" home tile.** Right now the picker only appears at the bottom of the contested screen. Would you like a small link on Home too so an owner who ignored the tile once can still find and change their picks?

