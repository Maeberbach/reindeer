# Reindeer Legacy — Patent brief update (2026-08-08)

**Prior brief:** [`docs/handoffs/2026-08-07-competitive-patent-landscape.md`](2026-08-07-competitive-patent-landscape.md). That document holds the 21-product landscape, the 38-record patent scan, and the full analysis. It is still the base document.

**Purpose of this update:** state what today's owner→heir→trustee alignment changes shift on the patent posture, and nothing else. Same disclaimers as the prior brief — screening scan, not counsel's opinion, not an FTO opinion, business-method §101 questions unresolved.

**Grounding rule:** every claim added or reweighted below is checked against the fetched-patent set summarized in §3 (Part B) of the prior brief. Nothing new was fetched today; the delta is entirely in what the app now *does* and *says*, not in what has been published.

---

## What actually changed today

Three concrete changes landed in commit `6cae093` on top of `88c4022`:

1. **Vocabulary purge** on the user-visible surface: every user-visible string uses **trustee**. Wire values, route paths, and DB columns are untouched.
2. **`new_outside_pr` transfer mode removed.** `POST /api/session/transfer-pr` now only accepts `to_existing_heir`. Handing captaincy to a non-heir goes through the trustee endpoints — nowhere else.
3. **Heir-initiated end-trustee-mode.** New endpoint `POST /api/session/trustee/end-mode`. Any signed-in heir (including the heir-admin) may end trustee mode. The trustee themselves cannot use this path — they hand back via the existing `/api/session/trustee/hand-back` route.

The formal **three configurations** model (Configuration 1: heir captain, trustee outside; Configuration 2: trustee inside as captain; Configuration 3: heir captain, no trustee at all) is now first-class in [`docs/SUITE-OVERVIEW.md`](../SUITE-OVERVIEW.md).

None of these change the AI photo pipeline, the offline sync, the ranked draft, the signing gate, the cross-app envelope, or the printed record.

---

## Bottom line on the patent story

The strongest independent-claim shape from the prior brief — the two-audience architecture + owner-authored flag suppressed on the paper + cross-app envelope attributing arrival to the import + signed versioned method-agreement gate + finalization-with-pending-appraisals — **is unchanged**. The four "strong on their own" mechanics (R2+R3+R4, F1, F6, F3+F7) are still strong, for the same reasons.

Today's changes add **one small new candidate** for a dependent claim and **tighten a distinguishing limitation** already discussed. They do not open new prior-art risk on this record.

---

## Candidate new dependent claim — heir-revocable in-app fiduciary mode

This is the only genuinely new patent-shaped mechanic since yesterday. It is a **dependent claim**, not an independent one — it sits under the two-application system claim from §0.5 and §3 (Part B, B.2) of the prior brief.

**Shape of the limitation:**

> ...the division application further comprising a fiduciary-mode state in which a non-participant trustee, invited into the session and having no draft/rank/receive capability, may act as session captain; wherein any non-administrative heir participant may unilaterally end the fiduciary-mode state, restoring the heir-administrator as captain and preserving the trustee's roster record; and wherein the trustee is precluded from ending the fiduciary-mode state through the heir-revocation endpoint and instead exits through a separate hand-back path.

**Why this looks novel on the fetched record:**

- **Nothing in the 38 fetched records recites an heir-revocable fiduciary mode.** The nearest fiduciary-control record, [US20050203815A1](https://patents.google.com/patent/US20050203815A1/en) (trust administration), is abandoned and does not recite session captaincy at all. It is a system for a fiduciary's *own* records, not a heritable session control that heirs can revoke.
- **The dispute-resolution family** — [US6850918B1](https://patents.google.com/patent/US6850918B1/en), [US20140379589A1](https://patents.google.com/patent/US20140379589A1), [US11625727B2](https://patents.google.com/patent/US11625727B2/en) — sits on the wrong side of the split. Those are all about a neutral third party running a dispute; none of them lets a party unilaterally rescind that neutral's control mid-session. And [US20140379589A1](https://patents.google.com/patent/US20140379589A1) is abandoned in any event.
- **The signing-ceremony family** — [US9286596B2](https://patents.google.com/patent/US9286596B2/en), [US20190050587A1](https://patents.google.com/patent/US20190050587A1/en), [US20240104299A1](https://patents.google.com/patent/US20240104299A1/en) — does not touch session captaincy or fiduciary control at all.
- **No fetched product does this.** FairSplit, Estate Divvy, Nemu, and Heirly all treat the executor / fiduciary either as an outside role (documented but not inside the app) or as a permanent operator inside the app. None of the 21 fetched product pages describes a heritable fiduciary-mode toggle that any heir can end.

**Why it is dependent, not independent:**

- Alone, "any heir can end trustee mode" is a small state-machine limitation. It gains its weight from sitting *inside* the two-audience system with a signed method-agreement gate. The audience split is what makes the revocation meaningful — the trustee is invited as a service by the heir audience, so the heir audience can withdraw the invitation.
- On its own it likely runs into §101 as "an abstract rule about who can push which button." As a dependent claim under the two-application system it inherits a technical hook from the architecture.

**The §101 hook** for this dependent claim, if counsel wants one that is specific to *this* limitation rather than borrowed from the parent claim: the endpoint enforces the revocation as a **role-conditioned state transition on the server** (`role='heir' → 200`, `role='trustee' → 403`, `role='heir' AND session.trusteeMode=false → 409`, unauthenticated → 401). That is a concrete, machine-implemented ACL over a durable session-state field, not just a UI affordance.

---

## Tighter framing for a limitation already in the prior brief

The prior brief's reframed one-sentence independent claim (§0.5) already noted that "the division application is scoped to multiple heir participants ranking items under a signed versioned method agreement." Today's alignment makes two things more defensible about *that* framing, without changing the claim shape:

### 1. "An heir is never a trustee. A trustee is never an heir." is now a code-level invariant, not a doc convention.

- Storage refuses to create a trustee with `administersOnly=false` (self-test #1).
- Storage refuses to promote an heir row into a trustee via patch (self-test #3).
- Storage refuses a second trustee on the same session (self-test #2).
- The trustee is excluded from `draftParticipantCount` (self-test #12).
- The trustee cannot draft, cannot rank, cannot receive items, cannot appear in equalization math.

The **role-partitioned intake-vs-division architecture** the prior brief flagged (§0.5, "One caveat specific to this reframing") is now enforced in code and covered by 56 self-test checks, up from 44 yesterday. That does not make the mechanic more or less patentable per se, but it materially improves what counsel can put in the specification: the negative limitations ("never drafts, never ranks, never receives") are grounded in enforced code paths, not aspirational documentation. That matters for both written description under §112 and for arguing the technical hook under §101.

### 2. The "outside oversight goes through the trustee endpoints, not through captain transfer" line is now a hard boundary.

Yesterday `transfer-pr` accepted `new_outside_pr` — meaning the captain role could be handed to a non-heir without the trustee path. Today it cannot. The wire refuses old callers with 400. That means the two-audience split is now enforced at the wire, not just at the UI. The independent claim's phrase "the division application is scoped to multiple heir participants" is now literally true at the API level: no endpoint can install a non-heir as captain except by invoking the trustee flow.

This is a defensive tightening, not a new claim. It removes a small "well actually" that a prosecutor could otherwise use to argue that the audience split was aspirational.

---

## Rescoring the four "strong on their own" mechanics with today's changes

Same table shape as prior §0. Nothing moves — this is the audit trail, not a re-ranking.

| # | Mechanic | Status | Effect of today's changes |
|---|---|---|---|
| **R2 + R3 + R4** | Owner-authored "Important" with three signals; comment prints verbatim; reason chip suppressed from paper | Still strong | Unchanged. The rendering rule is what carries this, and the print path was not touched today. |
| **F1** | Signed, versioned method-agreement gate before ranking opens | Still strong | Unchanged. The gate did not move. |
| **F6** | Finalization with pending appraisals; printed record names the escalating heir | Still strong | Unchanged. |
| **F3 + F7** | Cross-app import as null-participant audit row; reverts preserved as two rows | Still strong | Unchanged. |

---

## Rescoring the "weak — do not lead with these" mechanics

Same — nothing moves. F2 (ranked draft) is still the most exposed via [US8812389B2](https://patents.google.com/patent/US8812389B2/en) and [US8577748B1](https://patents.google.com/patent/US8577748B1). R6, R10, R7 are still crowded. R9 is still legal convention. R8 is still a UI nudge.

---

## New candidate for the "only patentable as combinations or dependent limitations" bucket

Adding one row to that bucket from the prior brief (§0):

| # | Mechanic | The problem alone, the value in combination |
|---|---|---|
| **F11 (new)** | Heir-revocable in-app fiduciary mode: any heir may end trustee mode; trustee cannot use that path | Alone, a small ACL. In combination with the two-audience architecture and the signed method-agreement gate, it is what makes Configuration 2 genuinely reversible — the trustee is a service the family invited, and the family can withdraw the invitation without the trustee's cooperation. No fetched patent recites this direction of control. |

(F11 is a new mechanic ID for the update. The prior brief stopped at F10.)

---

## What did **not** change on the patent story

- **No new prior art appeared** today. This is not a new scan; it is a delta over the Aug 7 fetched set.
- **The vocabulary purge itself is not patentable.** "The user-visible string is *trustee* instead of *PR*" is not an invention. Nothing about the copy pass has patent weight. It matters for user trust and legal clarity, not for §101 or §102.
- **The wire format is unchanged.** `role: "pr"` in the DB, `/api/fiduciary/*` endpoint paths, and the ReindeerExchange v1 envelope schema all still read as they did in the prior brief.
- **The three configurations model** was already implicit in yesterday's brief (§0.5 "two-audience architecture") — today it is formal in the code and docs, but the patent argument is the same.

---

## Updated recommendation for counsel

The prior brief's one-sentence recommendation stands unchanged:

> **Do not file around the ranked-draft algorithm.** File a single independent claim spanning both apps — three-signal Important flag → paper reproduces the comment verbatim while suppressing the reason code and any monetary estimate → export envelope carries the flag → receiving app attributes as import (not participant) → refuses to open ranking until every heir has signed a versioned immutable snapshot → finalization emits a printed record naming who raised any still-open appraisal.

Today's update adds two small notes for counsel:

1. **Consider a dependent claim on the heir-revocable fiduciary-mode state transition.** The role-conditioned ACL is small but was not found anywhere in the 38-record fetched set, and it makes Configuration 2 reversible on the record. See "Candidate new dependent claim" above.
2. **The specification for the independent claim can now cite enforced code paths, not just documentation, for the role-partitioning limitations** ("an heir is never a trustee; a trustee is never an heir; the trustee is excluded from draft participant count"). 56 self-test checks corroborate this. That is a written-description strength, not a new claim.

---

## Caveats that carry over from the prior brief

All disclaimers from the Aug 7 brief still apply verbatim:

1. This is a screening scan, not a professional search. EPO/WIPO family checks, CPC-class sweeps (G06Q 50/16, G06Q 40/00), and file-wrapper review are still required.
2. Every mechanic here sits in **business-method territory** under 35 USC §101. Novelty is only half the game — eligibility is the other half.
3. Google Patents' legal-status labels are "an assumption and is not a legal conclusion." Expired-fee-related patents remain prior art even where enforcement is gone.
4. Role-based UI patents and adaptive-interface / accessibility patents were **not** the subject of a dedicated query in the prior scan. Counsel should sweep that category before filing, particularly for any dependent claim that leans on the role-conditioned rendering or ACL rules.

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

Full 38-record table and the 21-product landscape live in the prior brief.
