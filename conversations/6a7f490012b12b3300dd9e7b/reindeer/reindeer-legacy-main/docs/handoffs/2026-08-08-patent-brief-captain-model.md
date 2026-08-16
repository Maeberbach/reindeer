# Reindeer Legacy — Patent brief update, captain-model reshape (2026-08-08)

**Supersedes:** [`docs/handoffs/2026-08-08-patent-brief-update.md`](2026-08-08-patent-brief-update.md).
That brief was written earlier the same day, before the captain-model reshape. The **F11 (heir-revocable in-app fiduciary mode) candidate dependent claim is withdrawn** by this document. Reasons for withdrawal are below.

**Base document remains:** [`docs/handoffs/2026-08-07-competitive-patent-landscape.md`](2026-08-07-competitive-patent-landscape.md) — the 21-product landscape and 38-record patent scan. This update relies on that prior-art baseline; nothing new was fetched today.

**Purpose of this update:** state what the captain-model reshape shifts on the patent posture, withdraw the F11 candidate that the reshape invalidated, and propose two smaller candidate dependent claims that survive.

Same disclaimers as the prior briefs — screening scan, not counsel's opinion, not an FTO opinion, business-method §101 questions unresolved.

---

## What actually changed today (captain-model reshape)

The following commits landed on top of the earlier same-day `88c4022` / `6cae093` state:

- `e251792` — captain-model target-state spec
- `a82806a` — heir-initiated `end-mode` endpoint **removed**
- `6ebf456` / `0f99407` — captain as first-class first-order concept: `session.captainParticipantId` column, `denyIfNotCaptain` guard split from the setup-time `denyIfNotHeirAdmin` guard, banner rewrite
- `92b7b48` — representative role type + `representsParticipantId`
- `6d4619a` — method agreement names the current captain via `${captainName}` template; composite unique `(session_id, participant_id, captain_participant_id)`; every heir re-signs when the captain changes
- `9b49422` — snapshot export available in every phase (`GET /api/fiduciary/snapshot` + `/snapshot/print`), read-only, no captain gate
- HEAD — SUITE-OVERVIEW rewritten around the four kinds of person who can wear the captain hat (heir, trustee, trustee's representative, heir's representative) and around the method-agreement re-sign

Concurrent test baselines from a clean `data.db`: tsc clean; auth 47/47; fiduciary **103/103** (up from 44 → 63 → 95 → 103 across the reshape); trustee 45/45; import 45/45; roundtrip 66/66.

The reshape did **not** touch: the AI photo pipeline, the offline sync, the ranked draft algorithm, the finalization-with-pending-appraisals path, the cross-app envelope, the printed record, or the Registry "Important" flag.

---

## Withdrawal: F11 (heir-revocable in-app fiduciary mode)

The earlier brief's candidate dependent claim, F11 — "any heir may end trustee mode; the trustee cannot use that path" — is **withdrawn**.

**Why it is withdrawn:**

1. **The endpoint no longer exists.** `POST /api/session/trustee/end-mode` was removed in `a82806a`. The specific state transition F11 claimed is not implemented anywhere in the system. A patent claim that recites machinery the product intentionally does not have is not defensible on written description under §112, and the app is not going back on this — the target-state spec (`docs/specs/2026-08-08-captain-model.md`) treats "no fallback state" as a first principle.
2. **The underlying framing was wrong.** F11 rested on a "trustee mode" being a bounded state that heirs could revoke. The captain model rejects that framing: **captain is a role, not a mode**. There is no thing to revoke. Any heir who no longer accepts the current captain does not end a mode — they either negotiate a captain change (which every heir then re-signs the method agreement for) or they use the snapshot export and walk away from the app entirely.
3. **In the real world the heirs cannot compel the trustee anyway.** Per the user's own statement of the domain: "I'm not sure a Trustee fiduciary could compel the use of the fair choice app." The reverse is also true: the app cannot compel the trustee. F11 asserted a one-way heir-over-trustee ACL that overstated what the app is actually for. The app is a tool for the family to reach voluntary buy-in, not a tool for one side to unilaterally reduce the other's participation. Filing on F11 would have documented a false theory of control.

**Prior-art posture is unaffected by the withdrawal.** F11's novelty argument on the 38-record fetched set does not carry over to any other claim; there is nothing to salvage.

---

## Two candidate dependent claims that survive the reshape

Both sit under the two-application system independent claim in §0.5 / §3 (Part B, B.2) of the base brief. Both were checked against the same 38-record fetched set.

### C1 — Captain-mandate re-sign on captain transfer

**Shape of the limitation:**

> ...the division application further comprising a method-agreement gate wherein each heir-participant's signed acceptance is scoped to a named session-captain identifier stored on the agreement record; wherein a transfer of the session-captain assignment to a different participant identifier invalidates prior signatures for the ranking-gate purpose; wherein the ranking-gate remains open only when every heir-participant holds an unsuperseded signed agreement naming the current session-captain identifier; and wherein a subsequent return of the session-captain assignment to a prior participant identifier reactivates the corresponding prior signatures without requiring a further re-sign.

**Why this looks novel on the fetched record:**

- **The signing-ceremony family** — [US9286596B2](https://patents.google.com/patent/US9286596B2/en), [US20190050587A1](https://patents.google.com/patent/US20190050587A1/en), [US20240104299A1](https://patents.google.com/patent/US20240104299A1/en) — recites multi-party signature ceremonies producing a signed document. None of them binds a signature to the identity of a *session operator* who may change mid-session, and none of them treats operator change as an event that invalidates prior signatures for a downstream gate.
- **The dispute-resolution family** — [US6850918B1](https://patents.google.com/patent/US6850918B1/en), [US20140379589A1](https://patents.google.com/patent/US20140379589A1), [US11625727B2](https://patents.google.com/patent/US11625727B2/en) — has a neutral third party running rounds, but the neutral's identity is fixed at session setup; there is no mechanism for changing the neutral mid-session and re-collecting party consent.
- **The prior brief's F1 (signed versioned method-agreement gate)** covered the general shape of "sign before ranking opens." C1 is strictly narrower: it says the signature is scoped to a named operator, and operator change is a durable event on the record. That narrowing is the novel part.
- **No fetched product does this.** FairSplit, Estate Divvy, Nemu, and Heirly all treat the person running the process as static — either a permanent operator or an unstated implicit "whoever is logged in." None recite a re-signing event triggered by operator change.

**Why it is dependent, not independent:**

- Alone, "the signature names the operator" is a small data-model limitation. It gains its weight from sitting inside the two-audience architecture where the operator is a role the heirs can grant, revoke, or transfer. C1 is only interesting because C's assignee has already granted C the mandate; without the two-audience system the identity of the operator is unremarkable.
- §101 hook for C1 specifically: the invariant is enforced at the storage layer through a **composite database uniqueness constraint** `(session_id, participant_id, captain_participant_id)` on the method-agreement table and a downstream gate query that filters the same three-tuple. That is concrete server machinery, not just a workflow rule. See `apps/reindeer-fair-play/shared/schema.ts` (`methodAgreements` table, `CURRENT_METHOD_AGREEMENT_VERSION="2.0"`, `renderMethodAgreementText(captainName)` helper), `apps/reindeer-fair-play/server/migrations/init.ts` (composite unique index), and `apps/reindeer-fair-play/server/fiduciary/fiduciaryStorage.ts` (`recordMethodAgreement`, `allHeirsHaveMethodAgreement`).

**Corroborating test coverage:** the "captain-change block" in `server/fiduciary/selftest.mts` (10 checks, §6 of that file) walks the gate through captain flip → single-heir sign → not-yet-open → all-heirs sign → gate flips true → hand-back → prior signatures reactivate. The reactivation-without-re-sign case is what makes this different from a naive versioning scheme.

---

### C2 — Representative as first-class distinguishable roster role

**Shape of the limitation:**

> ...the roster of the division application further comprising participant records typed by one of an enumerated set of roles including at least an heir role, a fiduciary-trustee role, and a representative role; wherein a representative-role record additionally stores a references-participant identifier binding the representative record to the roster record it represents; wherein the representative-role record is administers-only, is excluded from the participant count used by draft, ranking, and equalization computations, and does not appear as a recipient in any output allocation; wherein a representative-role record may be assigned as session-captain; and wherein the audit trail records actions taken by a representative-role record under the role of the referenced represented participant.

**Why this looks novel on the fetched record:**

- **No fetched record types "representative" as a first-class distinguishable role tied to the represented party.** The nearest fiduciary-focused record, [US20050203815A1](https://patents.google.com/patent/US20050203815A1/en), is abandoned and does not distinguish a fiduciary from a fiduciary's delegate.
- **The dispute-resolution and signing-ceremony families do not model delegation of the operator role at all.** Where they discuss delegation, it is delegation of signing authority (which the disputed instrument then authenticates), not delegation of session operation.
- **No fetched product does this.** FairSplit, Estate Divvy, Nemu, and Heirly have "admin," "user," and occasionally "executor" as roles. None enumerate a delegate role that is bound by a database reference to the delegator and that appears in an audit trail under the delegator's role.

**Why it is dependent, not independent:**

- The pattern "an actor can act on behalf of another" is a familiar authorization construct. What is unusual here is (a) the reference is on the roster row itself, not on a separate ACL, (b) the represented-role attribution flows through the audit trail, and (c) the represented-role attribution is what determines the heir-vs-trustee categorization in downstream checks such as the draft-participant count and the equalization math. Those three together are worth a dependent claim under the two-application system claim; standing alone they read as a general access-control pattern.
- §101 hook for C2 specifically: the role attribution is enforced by a server-side function (`roleOf(actorId)` at `apps/reindeer-fair-play/server/fiduciary/fiduciaryStorage.ts` line ~223) that reads the participant's declared role, follows `representsParticipantId` when the declared role is `representative`, and returns the represented participant's role. Every fiduciary storage write branches on that return value. That is concrete server code, not just a UI convention.

**Corroborating test coverage:** the "representative role" section in `server/fiduciary/selftest.mts` (8 checks, §8 of that file) proves: a trustee's representative persists tied to the trustee; an heir's representative persists tied to the heir; both are administers-only; a representative can be assigned as captain; and the snapshot names the representative as captain and shows the representative role in the roster.

---

## Rescoring the four "strong on their own" mechanics with the reshape

Same table shape as the base brief §0. Nothing moves — the reshape is a specification-strength change, not a claim-list change. C1 and C2 above are additions to the "only patentable as combinations or dependent limitations" bucket, not replacements for the strong mechanics.

| # | Mechanic | Status | Effect of the captain-model reshape |
|---|---|---|---|
| **R2 + R3 + R4** | Owner-authored "Important" with three signals; comment prints verbatim; reason chip suppressed from paper | Still strong | Unchanged. Registry was not touched. |
| **F1** | Signed, versioned method-agreement gate before ranking opens | Still strong | Unchanged in shape. **Strengthened in specification**: the gate is now the vehicle for C1 (captain-mandate re-sign). The independent claim itself does not need to be rewritten. |
| **F6** | Finalization with pending appraisals; printed record names the escalating heir | Still strong | Unchanged. |
| **F3 + F7** | Cross-app import as null-participant audit row; reverts preserved as two rows | Still strong | Unchanged. |

---

## Updated bucket table for the "only patentable as combinations" list

Replacing the F11 row from the earlier same-day brief with C1 and C2:

| # | Mechanic | The problem alone, the value in combination |
|---|---|---|
| ~~F11~~ (withdrawn) | ~~Heir-revocable in-app fiduciary mode~~ | Withdrawn. Endpoint removed; framing rejected by the captain model. |
| **C1 (new)** | Captain-mandate re-sign on transfer: signatures are scoped to a named operator; operator change invalidates prior signatures for the ranking gate; return of the operator reactivates them | Alone, a data-model detail. In combination with the two-audience architecture and F1, it turns the method-agreement gate from a one-time signing into a durable statement of who each heir agreed would run the process, refreshed every time the operator changes. |
| **C2 (new)** | Representative as first-class distinguishable roster role bound by reference to the represented participant, administers-only, excluded from draft/ranking/equalization, may be captain | Alone, a general access-control pattern. In combination with the roster's heir/trustee/representative enumeration and the represented-role audit attribution, it is what makes "an heir's mediator can run the game without being an heir" implementable without inventing a new category the vocabulary rules would forbid. |

---

## What did **not** change on the patent story

- **No new prior art appeared** during the captain-model reshape. This is not a new scan; it is a delta over the Aug 7 fetched set.
- **The independent-claim shape is unchanged.** The one-sentence independent-claim recommendation from the base brief §0.5 stands verbatim. C1 and C2 are dependent claims under it.
- **The three-configurations model from the earlier same-day brief is superseded** by the captain-role model in SUITE-OVERVIEW. Nothing patentable turned on the configuration numbering, so this is a specification change, not a claim change. Counsel should draft the specification around the captain role and the four kinds of person who can wear it, not around a numbered configuration table.
- **The vocabulary purge itself is still not patentable.** Heir/trustee/captain/representative as user-visible strings are naming choices, not inventions.
- **The `role: "pr"` wire format** remains as documented in the base brief. Wire changes are deliberately deferred.

---

## Updated recommendation for counsel

The base brief's one-sentence recommendation is still the file target:

> Do not file around the ranked-draft algorithm. File a single independent claim spanning both apps — three-signal Important flag → paper reproduces the comment verbatim while suppressing the reason code and any monetary estimate → export envelope carries the flag → receiving app attributes as import (not participant) → refuses to open ranking until every heir has signed a versioned immutable snapshot → finalization emits a printed record naming who raised any still-open appraisal.

The captain-model reshape adds three notes for counsel and retracts one:

1. **Retract the earlier same-day recommendation to consider a dependent claim on the heir-revocable fiduciary-mode state transition.** F11 is withdrawn.
2. **Consider a dependent claim on the captain-mandate re-sign (C1 above).** Corroborated by 10 self-test checks and a composite-unique database constraint. The 38-record fetched set does not recite operator-scoped signatures with an invalidation-on-transfer rule.
3. **Consider a dependent claim on the representative-role construct (C2 above).** Corroborated by 8 self-test checks and a server-side role-resolution function that flows delegation through the audit trail. The 38-record fetched set does not enumerate a delegate role bound by reference to the delegator.
4. **The specification can now cite enforced code paths for the captain model's negative limitations**, in addition to the earlier role-partitioning ones. Auth 47, fiduciary 103, trustee 45, import 45, roundtrip 66 as of the reshape.

---

## Caveats that carry over from the prior briefs

All disclaimers from the Aug 7 brief still apply verbatim:

1. Screening scan, not a professional search. EPO/WIPO family checks, CPC-class sweeps (G06Q 50/16, G06Q 40/00), and file-wrapper review still required.
2. Every mechanic sits in **business-method territory** under 35 USC §101. Novelty is only half the game.
3. Google Patents' legal-status labels are "an assumption and is not a legal conclusion." Expired-fee-related patents remain prior art.
4. Role-based UI patents and adaptive-interface / accessibility patents were **not** the subject of a dedicated query in the prior scan. Counsel should sweep that category before filing any dependent claim leaning on role-conditioned rendering or role-conditioned ACL rules — C1 and C2 both do.

---

## Sources — cited above (all fetched during the Aug 7 session)

- [US20050203815A1 — Trust administration system](https://patents.google.com/patent/US20050203815A1/en) — abandoned, fiduciary records only.
- [US6850918B1 — Computerized dispute resolution](https://patents.google.com/patent/US6850918B1/en) — expired, blind offer/demand rounds.
- [US20140379589A1 — Dispute resolution](https://patents.google.com/patent/US20140379589A1) — abandoned.
- [US11625727B2 — Dispute resolution system interface](https://patents.google.com/patent/US11625727B2/en) — active, party scores, no session captaincy.
- [US9286596B2 — Signing ceremony](https://patents.google.com/patent/US9286596B2/en) — active, signing only.
- [US20190050587A1 — Multi-contributor e-signature](https://patents.google.com/patent/US20190050587A1/en) — abandoned.
- [US20240104299A1 — Collaborative agreement signing](https://patents.google.com/patent/US20240104299A1/en) — pending, session-bound signing, not a division gate.
- [US8812389B2 — Listing and dividing assets](https://patents.google.com/patent/US8812389B2/en) — FairSplit; expired-fee-related but prior art.
- [US8577748B1 — Ticket / property draft allocation](https://patents.google.com/patent/US8577748B1) — expired-fee-related.

Full 38-record table and the 21-product landscape live in [`docs/handoffs/2026-08-07-competitive-patent-landscape.md`](2026-08-07-competitive-patent-landscape.md).
