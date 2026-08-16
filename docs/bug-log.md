# Reindeer Legacy — Bug Log

Every functional, code, or UX issue found while working on FairPlay or Registry. New rows added at the top. Status flows: **open → in-progress → fixed → verified** (or **wontfix / duplicate**).

## Severity

- **critical** — data loss, auth hole, crash, unrecoverable state
- **high** — wrong game outcome, lost work, print-out is wrong
- **medium** — confusing UX, cosmetic-but-noticed, small workflow annoyance
- **low** — nice-to-have polish, non-blocking

## How this file is used

1. At the start of every session, sync repo → read this log → triage anything `open` before new work.
2. When an issue is found (by agent or reported by user), add a row immediately — don't rely on memory.
3. When fixing, update `status` to `in-progress`, then `fixed` with the commit hash, then `verified` after the next test run.
4. `pplx project files submit` message should reference bug IDs closed in that commit (e.g. `fix: reveal copy — closes B-002`).

## Open

| ID | Date found | Severity | Area | Description | Proposed fix | Status | Fixed in commit |
|----|-----------|----------|------|-------------|--------------|--------|-----------------|
| B-005 | 2026-08-09 | medium | registry / gifts-UI | Preview and versions endpoints return `envelope.items` (with fields `id`, `name`, `room.name`), not `items` (with `title`, `room_name`). Signing screens must consume the envelope shape; sign submission must send `signature.device` (not `user_agent`) and `caretaker_ids: [id]` (not `trustee_id`). Fixed in commit 3 in `app.js` `loadGiftSign`, `renderGiftSign*`, and `giftSignGo`. | Fold envelope-vs-list shape difference into the client contract doc so future screens do not re-hit it. | fixed | (commit 3 pending) |
| B-004 | 2026-08-09 | high | registry / addendum-flow | `addendum/preview` returns HTTP 400 `"An addendum needs at least one wills caretaker or trustee to send it to"` when the owner has neither on file. UI must surface this as a friendly precondition instead of a raw error, and offer somewhere to fix it. | Sign screen now renders a warning box and keeps the caretaker/trustee dropdown visible so the owner can add one and come back. | fixed | (commit 3 pending) |
| B-003 | 2026-08-09 | medium | registry / capture | Save-time hook `assignItemToNamedRecipient` originally referenced but not defined — items ticked "Add to my special gifts" during capture would have thrown at save. Now defined (find-or-create heir, then PATCH `/api/items/:id/assign`). | Added helper + visibility hook so capture step 7 toggle is functional. | fixed | (commit 3 pending) |
| B-002 | 2026-08-09 | medium | vision / intake | `scripts/vision-test.mjs`: "a high suggested range still raises the high-value flag for review" fails (30 passed, 1 failed). Pre-existing at commit 94663f7 — reproduced with a clean checkout before this session's changes. Suggests the value-range → high-value promotion path is broken or the threshold moved without the test being updated. | Test was out of sync with a since-settled design: Registry never asserts a value tier; FairPlay does the tiering. Test now asserts `high_value_flag === false` and that the suggested range still travels on `value_suggestion`. Vision now 32/32. Decision recorded at `docs/decisions/2026-08-09-registry-does-not-set-high-value-flag.md`. | fixed | (commit 4b) |
| B-001 | 2026-08-08 | low | project instructions | Instructions reference `node scripts/roundtrip-test.mjs` with 44 checks. Actual file is at repo root (not app dir) and now reports 66 checks. | Update project-level instructions to say `node scripts/roundtrip-test.mjs (66 checks)` from repo root. Not a code change — instruction edit only. | fixed | (commit 4b — project instructions edit, not code) |

## Fixed / Verified

*(none yet)*

## Won't Fix / Duplicate

*(none yet)*
