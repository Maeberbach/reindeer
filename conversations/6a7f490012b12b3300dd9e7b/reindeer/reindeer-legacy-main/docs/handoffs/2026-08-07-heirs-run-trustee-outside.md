> **Superseded** — vocabulary in this document may use *PR*, *personal representative*, or *fiduciary* for what the current suite calls **trustee**, and may predate the three configurations and the heir-initiated end-trustee-mode endpoint. See [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md) for the current model. This document is kept as history and is not being rewritten.

# Heirs run the game, trustee sits outside — model and copy correction (2026-08-07)

The prior positioning pass this session over-claimed by describing FairPlay
as a "fiduciary-run" or "fiduciary-supervised" application. That was wrong.
Under the estate model this suite is built for:

- **The heirs run the family draft together.** In most estates the trustee has
  already delegated personal-property distribution to the heirs; the app is
  the way they do it.
- **Nobody inside the app is a fiduciary.** The heir who happens to run the
  session is not a fiduciary. The other heirs are not fiduciaries. There is
  no "PR" role and no "administrator" role that carries fiduciary weight.
- **The trustee (the fiduciary named by the trust or will) sits outside the
  app.** They do not log in. They retain responsibility for the **high-value
  items** and the **financial-balance-sheet fairness** of the estate.
- **The AI value estimate exists to protect the trustee.** Items whose value
  estimate crosses the high-value threshold are pulled out of the family
  draft into a segregated bucket the trustee handles: formal appraisal and
  equalization against other trust assets. This is where the app earns its
  keep — it prevents an inadvertent fiduciary breach on items the family
  might not have recognized as material.

## Three protections (new frame in every intro)

Every intro/positioning surface now names the three protections explicitly:

- **Protect the estate** — high-value items are flagged and set aside for
  the trustee, so nothing significant is quietly divided by mistake.
- **Protect the heirs** — a fair, agreed-in-advance process, private
  rankings, and a Record of Decisions every heir signs.
- **Protect the trustee** — the high-value flag prevents an inadvertent
  fiduciary mistake, and the Record of Decisions is a clean, signable audit
  trail for the trust file.

This frame is now a documentation rule: every future doc, welcome copy,
README, or handoff must lead with it.

## Files changed

### Schema

**`apps/reindeer-fair-play/server/migrations/init.ts`** — added
`trustee_name TEXT` to the `sessions` CREATE TABLE, with a comment
explaining that the trustee sits outside the app and this is a name capture
only for the Record of Decisions and the trustee packet.

**`apps/reindeer-fair-play/shared/schema.ts`** — added `trusteeName:
text("trustee_name")` to the Drizzle `sessions` model with matching JSDoc.
Nullable; no default; no data migration needed since v2.1 collapsed the
migration ladder into a single `initSchema()`.

### Storage + API

**`server/storage.ts`**

- `setEstateName` now accepts an optional `trusteeName?: string | null`
  argument. Empty/whitespace-only clears the field; `undefined` leaves it
  untouched.
- New `setTrusteeName(trusteeName: string | null)` sibling for later edits.

**`server/routes.ts`**

- `POST /api/session/estate-name` accepts an optional `trusteeName: string`
  in the body.
- New `POST /api/session/trustee-name` to set or clear the trustee name
  after setup.

Both routes remain behind `denyIfNotPR` — same access rules as everything
else on the setup surface.

### Client

**`client/src/pages/estate-name.tsx`** — added an optional Trustee's name
field beneath Estate name. Help text explains the trustee handles high-value
items and the financial side of the estate, and does not log in. Blank is
fine.

**`client/src/pages/welcome.tsx`** — rewritten:

- Removed the role picker entirely (the "PR only" vs "PR and heir"
  RadioGroup, its state, and the `RadioGroup`/`RadioGroupItem` imports).
- The submit always sends `administersOnly: false`; the flag remains on the
  wire and in the DB for schema stability but is no longer exposed.
- New copy leads with what the app is for (heirs dividing what was not
  specifically directed) and then presents the three-protections frame in a
  bordered callout: **The estate / The heirs / The trustee**.
- Removed the acronym "PR" and the word "fiduciary" from the visible copy on
  this page — the person setting up is described simply as "the heir who is
  setting this up for your family."

**`client/src/pages/setup.tsx`** — the roster editor's inline "Administers
only vs Participates" radio was removed for the same reason. The PR/admin
checkbox stays but its label changed from *"Personal Representative /
Trustee / Administrator"* to *"Runs the session (admin)"*. Unused
`RadioGroup`/`RadioGroupItem` imports and the unused `isAdmin` local variable
were removed to keep tsc clean under `noUnusedLocals`.

### Documentation

**`README.md`** — the "Two perspectives" paragraph was rewritten to say the
heirs run FairPlay together and the trustee sits outside handling
high-value items and financial balance. The three-protections frame is
inline. The app-table row for FairPlay says "heir-run family distribution
process ... segregates high-value items to the trustee" instead of the
previous "fiduciary-supervised."

**`docs/SUITE-OVERVIEW.md`** —

- The "Two perspectives, one estate" section was rewritten: the heirs run
  FairPlay; the trustee is a *third* party watching over the top of both
  apps without being inside either.
- The comparison table row "Who uses it" now reads "The heirs, together,
  after" (was: "The heirs, guided by the fiduciary, after"), and a new row
  "The trustee's role" makes their outside-the-app position visible in the
  table itself.
- New "Three protections" section between the perspectives and the "Two
  failures" section, explaining each protection in one paragraph.
- The "Reindeer: FairPlay" section was rewritten: heirs run the draft,
  high-value items are segregated for the trustee, that segregation is the
  specific piece the software prevents families from doing informally
  because informality is where fiduciary breach happens.
- The "The handoff" section was retitled from *"owner's record to
  fiduciary's process"* to *"owner's record to the family's draft"* and
  reworded accordingly. Trustee name capture at setup is mentioned.

**`docs/DESC-FAIR-CHOICE.md`** —

- "Whose app this is" was rewritten: heirs run it; trustee sits outside;
  trustee retains fiduciary responsibility for high-value items and
  financial balance.
- New "The three protections" section between "Whose app this is" and
  "Purpose."
- The Purpose paragraph was reworded away from "under a fiduciary who is
  the one legally responsible for calling the distribution fair" to the
  softer, more accurate "while the trustee handles the pieces that carry
  fiduciary weight." Statistics section unchanged.

**`docs/DESC-REGISTRY.md`** — the closing sentence of "Whose app this is"
was changed from *"in FairPlay, under a fiduciary's supervision"* to
*"in FairPlay — which the heirs run together, with the trustee outside
the app handling the high-value bucket and the financial balance."*

## What was intentionally not changed

- **No rename of code identifiers.** `pr_only`, `pr_and_heir`,
  `administersOnly`, the `isAdmin` flag on participants, the "PR" prefix on
  API helpers, and the participant.role wire values all stay as they are.
  Renaming those would touch DB values, self-test fixtures, and 40+ files —
  it is a schema-adjacent change that costs a full retest cycle and no
  behavior improvement. The user-facing labels are all that changed.
- **`administersOnly` is not deleted.** It remains a nullable-defaults-false
  boolean on `participants`, and downstream filters like
  `draftParticipantCount`, `heirs.filter(p => !p.administersOnly)`, and the
  audit trail's admin-only branch still work correctly. Under the new UX
  nothing will ever set the flag true; those branches are effectively dead
  code that stays harmless. If we ever decide to bring back a non-drafting
  administrator role, the machinery is still there.
- **Trustee capture is one field, name only, and optional.** No email, no
  phone, no address. The Record of Decisions has a signature block where
  the trustee can hand-write anything else that is needed. This can be
  extended later if the estate workflow demands more.
- **The trustee does not log in.** No auth surface was added for them.

## Schema change warning (retroactive)

Because we just collapsed v1..v15 into `initSchema()` this session and
nothing has shipped, the `trustee_name` column was added directly to the
baseline init rather than as a v16 migration step. Existing local dev
databases need to be wiped (which the self-tests do automatically via
`../testing/scratchEnv`).

## Verification

From `apps/reindeer-fair-play/`:

```
npm run check                                                  tsc clean
npm run build                                                  clean (client + server)
npx tsx server/auth/selftest.mts                               47/47 checks
npx tsx server/fiduciary/selftest.mts                          51/51 checks
npx tsx server/import/selftest.mts                             45 checks
npx tsx server/import/detectOwnerAssignment.selftest.mts       13 checks
```

From checkout root:

```
node scripts/roundtrip-test.mjs                                66 checks
```

## Versions

Unchanged from the v2.1 clean build:

- `apps/reindeer-fair-play`: 2.1.0
- `apps/reindeer-registry`: 1.1.0
- ReindeerExchange wire version: 1.0
