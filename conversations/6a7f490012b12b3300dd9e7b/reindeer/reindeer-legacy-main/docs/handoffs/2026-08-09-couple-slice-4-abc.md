# Reindeer Legacy — Couple Mode, Slice 4 parts a, b, c

*Handoff · 9 Aug 2026*

## Scope

The user asked for **4a, 4b, 4c only**, and to stop for review before 4d. This
slice adds the household-link ceremony, teaches the trustee cover sheet to talk
about couple-mode agreement, and gives the client three new touch points
(a link screen, a review tray, and a badge on the quiet row). Slice **4d** —
the couple-mode branch in `twoOutputs.js#collectAddendumItems`, which is the
one wire-format change in the family — is **deferred to a separate session**
because it needs its own schema review.

Everything here is **additive**. No renames, no schema changes, no
dependency reinstalls, no bundle wire-format changes. If any 4a/4b/4c code is
removed, the app degrades back to pre-Slice-4 behaviour by fall-through.

## 4a — Household link ceremony

Owner invites a partner by email → partner signs in via the existing magic-link
path → either partner confirms the link → mode flips from `solo` to `couple`.
Either partner can unlink at any time. Unlink preserves `linked_household_id`
so the trustee can still tell "was linked once" from "never linked".

### New endpoints

| Endpoint | Who | Behaviour |
| --- | --- | --- |
| `GET /api/household-link` | any signed-in participant | Summary of the household — mode, participants, `partner_present`, `can_confirm`, `can_unlink`, `linked_at`, `linked_by_participant_id`, `linked_household_id`. |
| `POST /api/household-link/invite` | **owner-only** (role='owner' or bootstrap-owner) | Body `{ email }`. Mints a magic-link invitation (`purpose='invite'`, `role='partner'`), 20-minute TTL. Returns the link only when `REINDEER_MAILER_OFF=1` (dev). |
| `POST /api/household-link/confirm` | either partner | Idempotent. Rejects with 400 when no partner participant exists yet, and rejects the bootstrap-owner (they must sign in with their own email first). |
| `POST /api/household-link/unlink` | either partner | Idempotent. Sets `household_mode='solo'`, clears `linked_at`/`linked_by_participant_id`, **preserves** `linked_household_id`. |

Identity is always `req.participant.participant_id`. Nothing reads from
`req.body.participantId`, `x-participant-id`, or `?participantId=` — the
Slice-2 impersonation invariant is preserved.

### New repo methods

`Registry.linkHousehold({ linkedByParticipantId, linkedHouseholdId })` and
`Registry.unlinkHousehold({ unlinkedByParticipantId })`. Both idempotent. Both
call `audit.append` with `scope.link` / `scope.unlink`.

### Test

`scripts/household-link-http-test.mjs` — **56 checks**. Covers: fresh-install
solo state, confirm-before-invite is rejected, invite mints a link, confirm
before partner signs in is still rejected, either partner can confirm, confirm
is idempotent, scope-summary agrees with mode, importance claims stop
auto-agreeing in couple mode, unlink is idempotent, agreed flags survive
unlink, re-linking works, auth guards on every route.

## 4b — Trustee cover-sheet Important sections

`packages/legacy-print-feature/src/templates/trusteePacket.js` now takes three
new optional args: `householdMode` (defaults to `'solo'`), `importanceClaims`,
and `participants`. When claims are supplied, the cover sheet adds:

- **Solo mode** — one section titled **"Items you marked Important"**, listing
  every `status='agreed'` claim (solo mode auto-agrees on insert). No proposer
  byline; the owner is the only one.
- **Couple mode** — two sections. **"Important items — agreed by both of you"**
  and **"Important items — proposed, not yet reviewed by the other partner"**.
  Each row shows the item title, the room, the proposer's display name or
  email, and the proposer's reason in quote marks.

If `importanceClaims` is `null` or empty, the cover sheet renders **exactly**
as it did before Slice 4. `sign-test.mjs`'s existing pre-Slice-4 caller path
continues to work.

`DeliveryService` now accepts `importanceClaims` and `participants` in its
constructor bag (both optional; nulls are safe). `server/index.js` wires the
real repos in — the order of construction was reshuffled so both are defined
before `new DeliveryService()`.

### Test

`scripts/trustee-important-test.mjs` — **31 checks** across seven cases:
pre-Slice-4 call unchanged, solo with two agreed flags, couple with a mix of
statuses (withdrawn and declined stay out), empty array renders nothing, all
withdrawn/declined renders nothing, email fallback when `display_name` is
empty, orphan claim (item deleted) shows a placeholder instead of crashing.

## 4c — Client UI

Kept small: two new screens, one badge, no changes to any existing screen.

### New screens

| Screen | Notes |
| --- | --- |
| `householdlink` | Three states: solo + no partner → owner sees an invite form; solo + partner has signed in → either partner sees a big Confirm button; couple → both see a Linked card with an Unlink option. Every action confirms first. |
| `claimreview` | Lists claims with `status='proposed'`. In couple mode the signed-in partner can Agree, Decline, or Withdraw their own. In solo mode it's an empty state explaining that review-together is for households of two. Both importance-claims and memorandum-claims show up here. |

### Quiet-row entries and badge

Added two entries to the home quiet-row: **Link a partner** and **Review
together**, the second carrying a small `<span class="linky-badge">` that
shows the count of pending claims. The badge refresh is fire-and-forget on
boot and after every claim action; errors are silent.

### What was NOT changed on 4c

Per your decision to keep the legacy Important toggle on the detail screen
untouched, the detail-screen Important control still writes
`owner_high_value`/`owner_high_value_reason` exactly as before. The
household-agreement path lives only in the review tray. This kept the slice
narrow and avoided touching a well-tested surface.

## Files changed this slice

**New**
- `apps/reindeer-registry/server/routes/householdLink.js`
- `scripts/household-link-http-test.mjs`
- `scripts/trustee-important-test.mjs`
- `docs/handoffs/2026-08-09-couple-slice-4-abc.md` (this file)

**Modified**
- `packages/legacy-core-data/src/registry.js` — `linkHousehold` / `unlinkHousehold`
- `packages/legacy-print-feature/src/templates/trusteePacket.js` — `renderImportanceSections`
- `packages/legacy-delivery/src/delivery.js` — plumbs `importanceClaims` + `participants` through
- `apps/reindeer-registry/server/index.js` — wires the new router + delivery deps
- `apps/reindeer-registry/client/index.html` — two screens, quiet-row entries
- `apps/reindeer-registry/client/app.js` — `loadHouseholdLink`, `loadClaimReview`, `claimAction`, `refreshReviewBadge`, router hooks
- `apps/reindeer-registry/client/styles.css` — link-card, invite-form, claim-list, linky-badge

## Test matrix

All suites pass with no regressions.

| Suite | Checks |
| --- | ---: |
| content-lint | clean |
| roundtrip-test | 66 |
| trustee-important-test *(new)* | 31 |
| auth-test | 33 |
| couple-claims-test | 49 |
| two-outputs-envelope-test | 37 |
| two-outputs-bundle-test | 60 |
| two-lane-test | 22 |
| vision-test | 32 |
| people-test | 36 |
| sign-test | 43 |
| couple-claims-http-test | 86 |
| household-link-http-test *(new)* | 56 |
| **Total** | **551** |

## Next steps (Slice 4d — deferred)

`packages/legacy-two-outputs/src/twoOutputs.js#collectAddendumItems` needs a
couple-mode branch that reads from `importanceClaims` (agreed only) and
`memorandumClaims` (agreed only) instead of the legacy owner fields. **This is
a wire-format change to the addendum bundle** and needs its own session with
schema review — versioning, back-compat with signed versions frozen under the
old shape, and a matching update to `scripts/two-outputs-bundle-test.mjs`.

Warn the user before starting 4d: signed versions frozen before the change
will still round-trip because the addendum bundle stores its own snapshot,
but any test that inspects the *unsigned* preview will need updated fixtures.
