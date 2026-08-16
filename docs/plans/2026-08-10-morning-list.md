# Morning list — plan for approval

**Date:** 2026-08-10 (morning)
**Status:** Ship A shipped 2026-08-10 morning. Ship B awaiting build.
**Decisions:** All five approved 2026-08-10 morning.

## What you asked for (in order)

1. **Partner button on Home.** First-time solo owners should see a clear "Add your partner" button on Home. When they tap it, the app opens the existing household-link flow. When linked, the button is replaced by a small confirmation. Also scrub every screen that assumes a partner exists when none is linked.
2. **Rename the pink tile.** Label = "Things meant for someone" (unchanged from today). Hint = "Add items and people you have already decided." (replaces today's longer hint).
3. **New tile: "Things families fight over"** with a guided flow through historically contested categories.
4. **Holiday reminders — Option B** (owner picks which holidays), delivered by **email**.
5. **Firearms:** captured normally, but the flow tells the owner clearly that legal transfer of firearms is the trustee's job, not the app's.

## Decisions locked in

- Partner button wording: **"Add your partner"**
- Tile hint: **"Add items and people you have already decided."**
- New tile name: **"Things families fight over"**
- Category list: **jewelry, holiday items, photographs, firearms, musical instruments, art, china/silver/crystal, letters/journals, recipes, watches, handmade items**
- Reminders: **Option B (owner picks) via email**
- Holiday capture prompt: **cheap version for now** — the app suggests recording holiday items when they are on display; no in-app scheduled reminders wired into the registry server itself
- Reminder scheduling mechanism: **Perplexity Computer's own scheduling** (approved) — no mailer/scheduler added to the registry server
- Jewelry (and offered on china/silver/crystal, photographs, recipes): **"Lay it all out" method offered, never mandatory.** Wide photo captures the collection; owner then uses the existing close-up single-item capture only for pieces they've already decided about
- Tile copy for "Things families fight over" **notes that these are the categories a trustee struggles with the most**

---

## Two ships, not one

I want to ship this in two commits, not one giant one, because item 3 is genuinely a new flow and I'd rather you see items 1 + 2 work in the app before I commit the bigger piece.

### Ship A (small, fast, low risk)

- Add the "Add your partner" button on Home. Visible only when no partner is linked.
- Rename the "Things meant for someone" tile's hint.
- Audit every screen for copy that says "your partner" / "you and your partner" / "your partner keeps a separate list" and make sure it appears only when a partner is actually linked.

Files touched: `apps/reindeer-registry/client/index.html` (tile + Home button), `apps/reindeer-registry/client/app.js` (show/hide partner button; audit calls), `apps/reindeer-registry/client/styles.css` (partner button style).

Cost: small. About a fifth of what Slice B step 4 cost.

Verification: screenshots of Home in both states (no partner / partner linked), plus the writer sub-line in solo mode. All 12 test suites stay green.

### Ship B (medium, new flow)

The "Things families fight over" tile + flow + firearms notice + holiday reminder mechanism.

Files touched (estimate): `apps/reindeer-registry/client/index.html` (new tile + new screen block), `apps/reindeer-registry/client/app.js` (~250 lines for the flow, category-specific prompts, and firearms notice), `apps/reindeer-registry/client/styles.css` (~40 lines), a new test suite `scripts/contested-categories-test.mjs` (~80 lines).

Cost: medium. Roughly one Slice B step 4 unit.

Verification: full test matrix green, plus new test for the flow, plus a walkthrough with screenshots of the new tile, the category picker, and one of the category-specific capture prompts.

---

## Design details you should approve

### Item 1 — "Add your partner" button

Where: a soft-colored button (or slim card) that sits directly under the top three tiles on Home, only visible when no partner is linked. Copy on the button: **"Add your partner"**. Small sub-line: "So both of you can keep separate lists." Tap → opens the existing household-link screen. After successful link, the button disappears and is replaced by a quiet line: **"Linked with <partner name>"**.

Copy audit — every place I find "your partner" in the app:
- **Writer sub-line** in couple mode: keep as-is (only shows when linked)
- **Writer conflict banner:** keep as-is (only shows when linked)
- **Anywhere else the codebase mentions partner in copy the owner might see:** I'll list them in the handoff.

### Item 2 — Tile hint rename

Just the hint text on the pink "Things meant for someone" tile. Label unchanged.

### Item 3 — Categories flow

The new tile opens a **category picker screen** that lists the eleven categories with an icon and a short line each. Owner taps one and enters a **guided capture** for that category. Guided capture = the standard photo/story capture plus a few category-specific questions.

Category-specific prompts (this is what I'd add on top of the standard photo + story):

- **Jewelry** — "Any story behind it?" "Someone specific in mind?" (optional voice memo affordance, if we build voice later)
- **Holiday items** — "Which holiday?" "How many pieces?" "Is this a set that should stay together?"
- **Photographs** — "Who is in it?" "Are there other copies?"
- **Firearms** — "Model" "Serial" plus a fixed notice (see below). No opinion on transfer.
- **Musical instruments** — "Who played it?" "Does it still work?"
- **Art originals and signed prints** — "Artist" "Any story?" "Is there a certificate of authenticity?"
- **China, silver, crystal** — "Is this the wedding set?" "How many pieces?" "Should the set stay together?"
- **Letters, journals, family papers** — "Whose handwriting?" "Would you like to scan or photograph them?"
- **Recipes** — "Whose recipe?" "In whose handwriting?"
- **Watches** — "Whose watch?" "Does it still run?"
- **Handmade / craft items** — "Who made it?" "Any story?"

Every item captured through this flow gets its `category_name` pre-filled, so it flows through the existing report / bundle infrastructure without changes.

### Item 3 (firearms) — Legal notice

At the top of the firearms sub-flow, a plain-language notice card:

> **Firearms transfer is the trustee's job, not ours.** Record what you have and what you would like to happen to each piece. Your trustee will handle the legal side (background checks, permits, and any state or federal rules) when it is time. If you have specific wishes, write them in the story field.

This mirrors the wording style from the "This app is not a fiduciary" line elsewhere. No functional gating — the owner can capture firearm items just like anything else; the notice is informational.

### Item 3 (holiday) — Capture prompt (cheap version)

When the owner picks "Holiday items" the flow shows:

> **These are easiest to record when they're actually out** — on the tree, on the table, on the mantel. Come back when they're on display and you'll capture them in half the time.

No in-app schedule. No JS timer. Just the suggestion. If they say "OK, remind me", we go to the reminder flow below.

### Item 4 — Reminders (Option B, email)

**The cheapest way to do this without adding new infrastructure to the registry server:**

The registry server does not have a scheduler or an outbound mail queue today. Adding both is real work. But **you already have Perplexity Computer scheduling tasks and sending you email** — that's what my scheduled tasks do. So the cheapest workable approach is:

- When the owner taps "Remind me for holidays" in the categories flow, the app shows a checkbox list of holidays (US default set: Christmas, Thanksgiving, Hanukkah, Passover, Easter, Halloween, Fourth of July) and asks for their email (pre-fill with the account email).
- The client posts the picks to a new endpoint on the registry server: `POST /api/reminders/holidays` which saves them to a `reminder_prefs` row on the participant.
- The registry server does **not** send the emails itself. Instead, I schedule a Perplexity Computer recurring task that, roughly two weeks before each selected holiday, sends the owner an email nudging them to open the app and capture what's on display.

Pros: no new infrastructure in the registry, ships fast, uses machinery you're already paying for.
Cons: the reminders live with me (Perplexity Computer), not inside the app. If you delete the scheduled task, the reminders stop even though the app still shows them as active.

**Alternative if you'd rather it live inside the app:** add a lightweight scheduler + mailer to the registry server. Real infrastructure — a scheduler process, an outbound mail queue, email templates, unsubscribe handling, tests. Probably three step-4-sized units of work. I do not recommend this until the app has real usage and the reminders prove valuable.

**My recommendation:** ship the cheap version (Computer-scheduled reminders) now. If you actively use them for a season, we build the in-app version.

---

## What I will not do without asking

- No dependency reinstalls
- No schema/wire changes (categories flow uses the existing `items` and `item_photos` tables plus one new `reminder_prefs` table that stores nothing more than checkbox picks and an email address)
- No changes to auth (magic-link, 20-min tokens, 30-day cookies, `req.body.participantId` still forbidden)
- No touching the sign flow, the memorandum writer, the trustee delivery bundle, or the print flow
- No changes to the pending voice-memo plan from last night — that's still waiting on your call

## Order of work if you approve

1. Ship A (partner button, tile hint) — one small commit, screenshots, all tests green
2. Ship B (categories flow, firearms notice, holiday-reminder wiring including the Computer-side scheduled task) — one bigger commit, screenshots, new test suite + full matrix green

## Questions for you

1. **Approve Ship A + Ship B as planned?**
2. **Reminder mechanism:** cheap version (Computer-scheduled emails) or full version (registry-server scheduler + mailer)? My strong recommendation is cheap first.
3. **Anything on the category list I should add or drop?**
4. **Anything else on the "families fight over" flow you want captured before I build?**

Answer these and I'll start with Ship A.
