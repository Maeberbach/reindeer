# Couple Mode — Slice 3 (claim routes) handoff

**Date:** 2026-08-09
**Depends on:** Slice 1 (schema + repos, migration 13) and Slice 2 (auth,
migration 14).
**Migration count:** unchanged. Slice 3 adds no schema — the claim tables
already exist from migration 13.

## What landed

Three new Express routers, mounted under `/api` **after** the
`authRequired` gate, so every endpoint requires a real session (or the
bootstrap-owner shortcut on a fresh install):

| Router | Endpoints | File |
| ------ | --------- | ---- |
| Scope summary   | `GET /api/scope-summary` | `apps/reindeer-registry/server/routes/scopeSummary.js` |
| Memorandum-claims | 8 endpoints (`GET` list, for-item, for-owner/addendum-preview, single; `POST` create, agree, contest, withdraw) | `apps/reindeer-registry/server/routes/memorandumClaims.js` |
| Importance-claims | 8 endpoints (`GET` list, for-item, summary, single; `POST` propose, agree, decline, withdraw) | `apps/reindeer-registry/server/routes/importanceClaims.js` |

Plus one small addition to `Registry`: `getScope(ctx)` returns the current
`scopes` row so callers can read `household_mode` without duplicating SQL.

## Design choices worth remembering

- **Identity always comes from `req.participant.participant_id`.** Every
  claim route derives `taggedByParticipantId`, `agreedByParticipantId`,
  etc. from the session cookie. The body is only for routable targets —
  `finalOwnerParticipantId` says "put this on the OTHER spouse's
  memorandum", not "I am that spouse". Slice 2's impersonation hole
  stays closed.
- **One-per-owner-per-item invariant** for importance is enforced in the
  router, not the repo. A proposer cannot have two live (proposed or
  agreed) flags on the same item. Withdrawn or declined flags do not
  block a fresh proposal.
- **Household mode is still `'solo'` for every scope.** Importance
  proposals in solo mode auto-agree at insert time (`mode='solo'` passed
  to the repo). The couple-link ceremony that flips `household_mode` to
  `'couple'` ships in a later slice; nothing in Slice 3 requires a scope
  to be in couple mode.
- **twoOutputs.js was NOT modified.** The couple-mode fold of memorandum
  claims into the addendum bundle stays a later-slice decision so the
  signed-bundle wire format is untouched. The `addendum-preview` under
  `/api/memorandum-claims/for-owner/:ownerParticipantId/addendum-preview`
  is a *client-facing* preview route that reads the claim repo directly
  and does not compose an envelope. The delivery-side
  `/api/two-outputs/addendum/preview` is unchanged.
- **Only the tagger can withdraw a memorandum claim** (repo rule; router
  simply forwards the participant id and the 400 error). For importance,
  either spouse can withdraw a household flag (repo comment says the flag
  is annotation on shared property, not per-spouse intent).

## Test matrix

| Suite | Checks | Notes |
| ----- | ------ | ----- |
| content-lint | clean | |
| auth-test (DB) | 33 | Slice 2 |
| couple-claims-test (DB) | 49 | Slice 1 |
| roundtrip-test | 66 | |
| two-outputs-envelope-test | 37 | |
| two-outputs-bundle-test | 60 | |
| two-lane-test | 22 | |
| vision-test | 32 | |
| people-test (HTTP) | 36 | |
| sign-test (HTTP) | 43 | |
| **couple-claims-http-test (HTTP, NEW)** | **86** | Slice 3 |

**Total: 464 checks green** across 10 suites plus content-lint clean.

Each HTTP suite boots its own server against a fresh
`mktemp -d /tmp/registry-*-XXXXX` `REINDEER_INVENTORY_DIR` on port 3260
with `REINDEER_MAILER_OFF=1` and `REINDEER_SESSION_SECRET=slice3-test-secret`
so magic links are echoed back and the session secret is deterministic.

## What Slice 4 should tackle

1. **Household link ceremony.** The one screen that flips
   `scopes.household_mode` from `'solo'` to `'couple'` and writes
   `linked_household_id`, `linked_at`, `linked_by_participant_id`. Solo
   users see nothing; the invited partner has to accept.
2. **Couple-mode branch inside twoOutputs.js.** Once household_mode can
   really be `'couple'`, `#collectAddendumItems` needs to fold in
   memorandum claims: iterate `memorandumClaimsRepo.addendumPreview(ownerParticipantId)`,
   resolve each `final_heir_id`, and produce the same shape as the
   existing `assigned_to_heir_id` path. This is a wire-format touch —
   warn user first.
3. **Client wiring.** The Registry client currently has no UI for
   claim proposal, agreement, or the review-together tray. Slice 3 gave
   it the endpoints; Slice 4 wires the screens.
4. **Trustee cover-sheet annotations.** The trustee cover sheet needs
   sections for "Important items (agreed by household)" vs "proposed,
   not yet reviewed" — the counts come from `importanceClaims.summary()`
   which is already reachable at `GET /api/importance-claims/summary`.

## Files added

```
apps/reindeer-registry/server/routes/scopeSummary.js       (new)
apps/reindeer-registry/server/routes/memorandumClaims.js   (new)
apps/reindeer-registry/server/routes/importanceClaims.js   (new)
scripts/couple-claims-http-test.mjs                       (new)
docs/handoffs/2026-08-09-couple-slice-3-claim-routes.md   (new — this file)
```

## Files changed

```
apps/reindeer-registry/server/index.js       imports + router mounts (all after authRequired)
packages/legacy-core-data/src/registry.js  + getScope(ctx)
```

No other files touched. No schema changes. No dependency changes.
