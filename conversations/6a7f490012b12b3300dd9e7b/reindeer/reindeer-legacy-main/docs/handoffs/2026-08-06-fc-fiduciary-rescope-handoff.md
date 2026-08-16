> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# FairPlay v8 Fiduciary Rescope — Handoff

**Date:** 2026-08-06 (evening)
**Baseline commit:** `eeebf99` — "FairPlay honors owner's Registry Important mark, and owner comments travel through as legacy content." Clean tree. All tests green (roundtrip 66, FC auth 47, FC fiduciary 40, FC import 38, tsc clean, db:push applied).
**Status:** Planning complete, product model locked with owner, spec not yet written, no code touched.

---

## Owner's product vision (the whole point of the rescope)

The owner articulated a sharper product philosophy across this session. Every design choice below flows from these principles — read them first, refer back to them often.

### 1. "FairPlay, not Equal Choice"
> "To avoid excessive conflict it is expected that the goal is Fair choice not precisely 'equal' choice. There is a difference between emotional and financial. One heir may be comfortable with less mine for more memories. My expectation is for up front buy in. The fiduciary requirement is to evaluate items over $3000 but a family may choose a lower threshold. The fights are more about everyday items not a few thousand dollars."

The product's job is **emotional distribution**, not dollar-equal distribution. Families agree up front that outcomes won't be dollar-equal and that this is the point.

### 2. The trustee handles the money; FairPlay handles the memories
> "In my vision, the estates in my market have plenty of other assets to equalize an estate financially. So the issue of fiduciary responsibility is moot. This focus is on emotion and special things. The high value items are appraised. All heirs can escalate any item to that level. Individual items not 'high value' are small change really. No formal appraisal would be done for a couch."

Personal property is a small slice of a larger estate that already has cash, real property, brokerage, and retirement accounts. The trustee balances the financial totals externally using those other assets. **FairPlay does not do dollar equalization, and it does not need to.**

### 3. High-value items STAY in the FairPlay draft
> "Nope. The high value items are still assigned by fair choice. They have emotional value too. The assignment to an heir still occurs in FC. The trust then balances the numbers to their fiduciary limits of fair/equal with other assets. It is a hand off to the trustee to balance it not assign it."

This is the correction that reframed the whole runtime. Earlier in the session the agent had proposed "hold high-value items out of the draft, let the trustee assign them." That is **wrong**. The correct model:

- **Every item — including high-value ones — is drafted and assigned by FairPlay's ranked-draft engine.** A diamond ring is emotionally weighted just like a cookbook.
- **The only thing "high-value" changes is that the item gets an appraised value recorded** (any heir can escalate any item to that tier).
- **FairPlay hands the trustee a Record of Decisions: every item, who got it, and appraised values where recorded.** The trustee then does the financial balancing externally by adjusting distributions from cash / real property / brokerage / retirement.

### 4. Threshold philosophy
- **No aggregate personal-property dollar threshold.** The "total personal property > $X triggers strict fiduciary mode" gate should be moot and generally ignored.
- **Per-item escalation is the mechanism.** Any heir can flag any item for appraisal, at any point before final signing. That flagged item still stays in the draft.
- **The couch is not appraised. The cookbook is not appraised.** No dollar figure is attached to below-threshold items because none is needed — they never enter the trustee's balancing math.

### 5. The one mechanical decision owner made explicitly this session
**Finalization gate on pending appraisals:** Finalization CAN complete while some escalated items are still awaiting appraised value. Those items appear on the trustee's Record of Decisions marked "pending appraisal" with the escalating heir named. Trustee resolves them downstream. (Rationale: finalization is a family milestone, not an appraisal deadline; the appraiser and the trustee are the same class of professional and can hand off directly.)

---

## Positioning story the owner endorsed

- **"Fair, not Equal — because families aren't calculators"**
- **"Your estate attorney handles the money. We handle what's in the house."**
- Attorneys become distribution channel, not competitors.
- Narrower scope than [FairSplit](https://www.fairsplit.com/) but deeper on the one thing that actually causes family fights: the everyday emotional items, not the appraised high-dollar ones.

---

## Critical correction the next session needs to internalize

**In this session I told the owner "the v8 fiduciary tables have zero runtime code." That was wrong.** I was quoting a stale audit document (`docs/fair-choice-audit.md`) without verifying against the current tree. The truth on disk at `eeebf99`:

- `apps/reindeer-fair-play/server/fiduciary/fiduciaryStorage.ts` — **856 lines, substantially wired**
- `apps/reindeer-fair-play/server/fiduciary/router.ts` — **420 lines, ~14 endpoints**
- `apps/reindeer-fair-play/server/fiduciary/selftest.mts` — **283 lines, 40 passing self-tests**
- `apps/reindeer-fair-play/server/fiduciary/index.ts` — 11-line entry point

**The scope is therefore RESHAPE, not BUILD.** The delta is:
- Removing / dormantizing the equalization-payments-and-threshold-gates behavior
- Preserving the valuations + audit-log + ranked-draft-participation behavior
- Adding a Method Agreement (up-front buy-in) table
- Adding a Record of Decisions handoff document generator
- Substantially rewriting the 40 self-tests to match the new behavior (they currently assert threshold-gated finalization, which the new vision says never happens)

**The stale audit doc `docs/fair-choice-audit.md` should be updated or deprecated as part of this work.** It misled me and will mislead the next session too if left as-is.

---

## What exists today (verified by reading fiduciaryStorage.ts and grep on router.ts)

### Fiduciary storage methods (all in `fiduciaryStorage.ts`)

**Keep as-is (aligns with new vision):**
- `audit()` — writes highValueAuditLog row on every mutation. Universal audit trail. Keep.
- `roleOf()` — resolves participant role for audit. Keep.
- `requireItem()` — item lookup helper. Keep.
- `listValuations()`, `addValuation()`, `approveValuation()`, `disputeValuation()` — the appraisal recording pipeline. **Core to the new vision.** Keep with minor changes (see below).
- `listHighValueItems()` — read model for the high-value dashboard UI. Keep, reshape response shape.

**Reshape (behavior changes under new vision):**
- `addValuation()` — currently transitions `highValueState` from `normal`/`flagged_high_value` → `awaiting_value_review`. New vision: item should stay in the draft; the state transition is fine but must not imply the item is "held out." Confirm no consumer treats `awaiting_value_review` as "not draftable."
- `approveValuation()` — currently sets `items.approvedValue` and writes `valueStatus='approved'`. Keep this. Currently this is the input to threshold breach math — under new vision, no threshold math runs, so approval simply becomes "value is on the record."

**Dormantize (present in code, unused under new vision, do NOT remove — keep the tables and code paths but stop calling from routes and stop referencing in the dashboard):**
- `listDecisions()`, `latestDecision()`, `decide()`, `setDecisionState()` — equalization-decision lifecycle. New vision has no equalization decisions in FC.
- `listConsents()`, `requestConsents()`, `respondConsent()` — consent-to-value flow. New vision has no consent-against-stated-value; the Method Agreement replaces this and is a different shape (per-heir, up-front, one-time, blanket).
- `finalizationStatus()` — the threshold-breach + blockers computation. New vision has no threshold breaches. This method continues to run for backwards compatibility but the blockers list will be empty or only contain "no approved value AND was escalated" for pending-appraisal items.
- `targetEqualShare()` — computes per-heir equal share. Not used by new vision. Keep the helper; nothing calls it.
- `finalize()` — currently refuses if `finalizationStatus.canFinalize === false`. Under new vision, the only remaining blocker is escalated-without-appraisal, and per owner's answer that also does NOT block finalization (item just goes to trustee marked pending). So this method's guard collapses to "no blockers" as a general property.

**Add (new methods needed):**
- `flagForAppraisal(itemId, actorId, reason)` — any heir can call. Sets item's `isHighValue = true` and `highValueState = 'flagged_high_value'` if not already. Item stays in draft. Writes audit row.
- `recordMethodAgreement(participantId, ...)` — writes to new `methodAgreements` table. One per heir. Immutable. See table shape below.
- `listMethodAgreements(sessionId)` — read all agreements for the session.
- `generateRecordOfDecisions(sessionId)` — produces the Trustee Handoff artifact. Every item, who it was awarded to, appraised value if any, source, escalating heir if any and still pending. Returns a structured object; a separate printable renders it.

### Fiduciary router endpoints (all in `router.ts`)

**Keep:**
- `GET /items` — list high-value items (dashboard).
- `GET /items/:itemId/valuations` — list valuations.
- `POST /items/:itemId/valuations` — add valuation.
- `POST /items/:itemId/valuations/:id/approve` — approve valuation (PR-only).
- `POST /items/:itemId/valuations/:id/dispute` — dispute valuation.

**Dormantize (leave in code but don't advertise in UI; consider removing after a release):**
- `GET/POST/PATCH /items/:itemId/equalization` — equalization-decision routes.
- `GET/POST /items/:itemId/consents`, `POST /consents/:id/respond` — consent routes.
- `GET /items/:itemId/finalization`, `POST /items/:itemId/finalize` — finalization gate.
- `GET/PATCH /thresholds` — threshold configuration.

**Add:**
- `POST /items/:itemId/flag-high-value` — any authenticated heir flags an item for appraisal. Item stays in draft.
- `POST /method-agreements` — record one heir's Method Agreement signature.
- `GET /method-agreements` — list all agreements for the session.
- `GET /record-of-decisions` — return the structured Record of Decisions.
- `GET /record-of-decisions/print` — server-rendered printable HTML for the trustee.

### Schema changes required

**New table `methodAgreements` (v14 migration):**
```
id                          integer PK autoincrement
sessionId                   integer NOT NULL (session FK)
participantId               integer NOT NULL (heir FK)
agreedAt                    integer NOT NULL (epoch ms)
agreementVersion            text    NOT NULL (e.g. "1.0" — copy of the agreement text hash / version stored elsewhere)
agreementTextSnapshot       text    NOT NULL (immutable copy of the exact language the heir agreed to)
signatureMethod             text    NOT NULL ('magic_link' | 'in_person')
magicLinkTokenId            integer NULL (auth token FK if signed via magic link)
clientIp                    text    NULL
clientUserAgent             text    NULL

UNIQUE (sessionId, participantId)  -- one agreement per heir per session
```

**Ranking phase gate:** the FC phase machine transition into `ranking` from `intake` must check every non-admin participant has a row in `methodAgreements`. Location: probably `apps/reindeer-fair-play/server/storage.ts` phase-transition code — needs verification.

**No other schema changes required.** All the tables the new vision uses (`items.isHighValue`, `items.highValueState`, `items.approvedValue`, `itemValuations`, `highValueAuditLog`) already exist.

### Self-tests

The 40 fiduciary self-tests in `selftest.mts` will need substantial rewrites. **Read them carefully before writing new ones** — they lock in the current threshold-gate semantics that the new vision explicitly removes. The next session should:

1. Run the current suite to see what passes at baseline (`npx tsx server/fiduciary/selftest.mts` from `apps/reindeer-fair-play/`).
2. Read each test and classify: keeps working under new vision / needs update / obsolete.
3. Add new tests for: flag-for-appraisal (any heir, any time), method-agreement gate on ranking phase, Record of Decisions generation with pending-appraisal items included, appraised items still appear in draft assignment output.

Expected new test count: ~55 (the current 40 minus obsolete threshold tests plus new coverage).

---

## Recommended next-session workflow

1. **Sync the checkout.** `pplx project files sync` from `/home/user/workspace/projects/legacy-suite-XPjy0RsrSMGTV_3ok2A05g/files`. Baseline is `eeebf99`, clean.

2. **Read this handoff.** Then read, in order:
   - `apps/reindeer-fair-play/server/fiduciary/fiduciaryStorage.ts` (856 lines) — get ground truth.
   - `apps/reindeer-fair-play/server/fiduciary/router.ts` (420 lines) — see actual endpoint behavior.
   - `apps/reindeer-fair-play/server/fiduciary/selftest.mts` (283 lines) — see what current behavior is asserted.
   - `apps/reindeer-fair-play/shared/schema.ts` fiduciary sections — verify table shapes and item state machine.
   - `docs/fair-choice-audit.md` — the stale audit doc; note it needs correction.

3. **Write the delta spec.** File-and-line references. What's kept, what's dormantized, what's added, what's removed. Include:
   - The `methodAgreements` schema and v14 migration
   - The new endpoints and their exact request/response shapes
   - The Record of Decisions structured shape
   - The self-test rewrite plan (which tests survive, which get replaced)
   - Honest scope estimate (agent's rough guess before reading was 2–6 hours; probably closer to 2–3 hours of focused work now that the code exists and mostly just needs reshape)

4. **Get owner approval on the spec.** Then execute the build as one atomic commit. Same clean workflow as `eeebf99`.

5. **Update or deprecate `docs/fair-choice-audit.md`.** Do not leave stale docs to mislead the next agent.

6. **Then, after the runtime lands, produce the product positioning comparison** — FairPlay vs FairSplit, with the "Fair, not Equal" positioning baked in. Owner asked for this earlier in the session; agent did partial research (saved at `/home/user/.pplx/search/pplx_sdk_2026-08-07T00-43-46.764177Z_7983997d.json` and `/home/user/.pplx/search/pplx_sdk_2026-08-07T00-50-05.113608Z_58ea79e1.json`), didn't produce the final deliverable.

---

## Standing project rules the next session MUST follow

From project instructions and reinforced across this session:

- **Warn the owner BEFORE any rename, sweeping find-and-replace, dependency reinstall, or schema/wire-format change, stating exactly what could break.** The Method Agreement table and the phase-gate change both qualify — warn explicitly before implementing.
- **Never reintroduce identity read from `req.body.participantId`, `x-participant-id` header, or `?participantId=` query.** All auth is real magic-link sessions.
- **UI must stay legible and forgiving for elderly users.** The Method Agreement signing UI in particular needs plain language, big targets, one screen.
- **Every item must be printable.** The Record of Decisions must produce a physical-ready printable.
- **Test invocations** (from project instructions):
  - Roundtrip: `node scripts/roundtrip-test.mjs` from repo root — expect 66.
  - FC auth self-test: `cd apps/reindeer-fair-play && npx tsx server/auth/selftest.mts` — expect 47.
  - FC fiduciary self-test: `cd apps/reindeer-fair-play && npx tsx server/fiduciary/selftest.mts` — expect 40 at baseline, ~55 after rescope.
  - FC import self-test: `cd apps/reindeer-fair-play && npx tsx server/import/selftest.mts` — expect 38.
  - tsc: `cd apps/reindeer-fair-play && npm run check`.
  - Migration: `cd apps/reindeer-fair-play && npm run db:push` after schema changes.
- **A root-level `npm install` prunes `apps/reindeer-fair-play`'s dependencies.** Reinstall inside `apps/reindeer-fair-play/` afterwards.
- **Self-tests must import `../testing/scratchEnv` as their FIRST import.** ESM imports are hoisted; setting env vars inline runs too late and hits real `data.db`.

---

## Session context to preserve

- **Latest commit:** `eeebf99`
- **Working tree:** clean
- **Windows Surface Pro 8 (Markslaptop)** is the online device. No Mac. Some Apple-only tooling (Spotlight, osascript, mail) isn't available.
- **Project checkout:** `/home/user/workspace/projects/legacy-suite-XPjy0RsrSMGTV_3ok2A05g/files/`
- **Credentials for `pplx project files` calls:** `api_credentials=["pplx-sdk"]`
- **Owner's answers to design questions this session** (all binding for the next session):
  - App scope: FairPlay only, not Registry.
  - Draft mechanism: existing ranked-draft engine, unchanged; high-value items participate in it.
  - Escalation: any heir, any item, any time before final signing.
  - Appraisal value source: entered by PR or by appraiser through the PR; source noted (self-estimate / appraiser+firm / federal rule / state requirement / PR judgment); immutable on `itemValuations`.
  - Method Agreement: per-heir, immutable, magic-link signed, gates ranking phase transition.
  - Threshold: none. No aggregate personal-property dollar gate.
  - Finalization gate: CAN complete with pending appraisals; those items go to trustee as "pending appraisal" with escalating heir named. Owner's explicit choice.

## Do NOT

- Do NOT touch code without spec approval — the owner explicitly said "commit to the complete process" (spec + positioning first, build after approval).
- Do NOT remove the dormantized tables (`equalizationDecisions`, `consents`, `finalizationEvents`) — leave the schema in place for a possible future release. Only stop calling into them.
- Do NOT proceed with the build if the 40 existing fiduciary tests haven't been read carefully. They encode assumptions the new vision explicitly reverses; that's the risky delta.
- Do NOT claim "the runtime is not wired" — it is. Say instead "the runtime is wired for the old model and needs to be reshaped for the new one."
