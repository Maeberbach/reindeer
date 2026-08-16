# Working across chats in the Reindeer Legacy workspace

Both apps now live in this project's file repo. This is how to use it.

## What is actually in here

```
apps/reindeer-fair-play/          your real app — TypeScript, React, Drizzle
apps/reindeer-registry/   the new capture app — plain ESM JavaScript
packages/                         the scaffold's shared packages (see the warning below)
scripts/roundtrip-test.mjs        the 44-check contract test
docs/integration-spec.md          the plan, written before I saw your code
docs/fair-choice-audit.md         what your code actually is — read this first
```

**The two apps do not share a toolchain.** FairPlay is TypeScript on Vite with
Drizzle ORM and a build step. Reindeer Registry is plain ESM JavaScript with no
build step and hand-written SQL. They have separate `package.json` files and
separate `node_modules`. FairPlay is deliberately excluded from the root npm
workspace so its 447 dependencies stay out of the other app's tree.

That is a real constraint, not a temporary state. Plan around it.

## The one rule

Every chat starts on a fresh machine with nothing on it. First command, always:

```
pplx project files sync
```

Last command, after real work:

```
pplx project files submit -m "what changed"
```

Nothing crosses between chats until submit runs. A chat can work brilliantly for
two hours and leave nothing behind if it never submits.

## Starting each app

**Reindeer: FairPlay** — port 5000, creates `data.db` on first start.

```
cd apps/reindeer-fair-play
npm install          # ~1 minute, 447 packages
npm run dev          # http://localhost:5000
npm run check        # tsc — must stay clean
npm run build        # vite + esbuild
```

**Reindeer Registry** — port 3210, installs from the repo root.

```
npm install                        # root, covers packages/ and the inventory app
npm run inventory                  # http://localhost:3210
node scripts/roundtrip-test.mjs    # 44 checks
```

Both installs are needed if a chat touches both apps. Neither is stored in the
repo.

## Splitting work between chats

**Chat A — FairPlay.** Distribution logic, heirs, rounds, picks, the v8
fiduciary workflow, the import screen. Lives entirely in
`apps/reindeer-fair-play/`.

**Chat B — Reindeer Registry.** Capture screens, video and voice recording,
print layouts, trustee delivery. Lives in `apps/reindeer-registry/` and
`packages/`.

Because the two apps no longer share code, these two chats almost never collide.
The only shared surface is `docs/` and the root `package.json`. If a chat edits
either, submit promptly so the other chat can sync it.

**Sync before you start, submit before you stop.** A chat idle for an hour holds
a stale checkout. Tell it to sync again before it edits anything.

## When to use one chat instead of two

Use a single chat with parallel subagents when a change spans both apps — most
obviously the ReindeerExchange import path, where the bundle format and the
adapter that reads it have to move together. One sandbox, both apps present, one
submit at the end, no conflict.

Use two chats when the two efforts are independent and long-running.

## Read the audit before touching the integration

`docs/fair-choice-audit.md` is the honest comparison between the integration spec
and your real code. Three things in it change the plan:

1. **The spec assumed the wrong stack.** It was written from your descriptions
   and assumed plain JavaScript with no build step. Your app is TypeScript with
   Drizzle. Most of the spec's schema claims do not survive contact with
   `shared/schema.ts`.

2. **`packages/` cannot be shared with FairPlay as written.** The scaffold's
   import adapter, now parked at
   `apps/reindeer-fair-play/_scaffold/server/importAdapter.js`, writes SQL against
   `intake_queue`, `items.item_id`, `items.title`, and `items.review_state` —
   none of which exist in your database. It would fail on the first insert. Do
   not wire it up. The realistic shared artifact is the ReindeerExchange bundle
   format plus a TypeScript adapter written against your real Drizzle schema.

3. **The v8 fiduciary workflow was retired — not built out.** The audit warned
   that `equalization_decisions`, `consents`, `finalization_events`, and
   `threshold_decisions` had no runtime code behind them. Rather than build them
   out, the v14 rescope moved value balancing to the trustee outside the app,
   commit 6 removed the storage / routes / UI that referenced those tables, and
   commit 7 dropped the tables themselves along with the `equalization_*`
   session columns and the `equalizationPath` / `finalizedAt` /
   `finalizationEventId` item columns. Do not let a chat re-add an in-app
   equalization ledger, per-item consent flow, or finalization gate. `ITEM_STATES`
   is now three states: `normal`, `flagged_high_value`, `awaiting_value_review`.
   The live high-value trail is `appraisal_flags` + `high_value_audit_log` +
   the appraisal flag surfaced on the Record of Decisions.

## Also worth knowing before a chat changes auth

Auth is now real and must stay real: email magic links, single-use 20-minute
tokens, 30-day sliding sessions in an httpOnly signed cookie, and deny-by-default
over `/api`. `passport` and `express-session` are not used. The old
`?participantId=` / `req.body.participantId` / `x-participant-id` identity paths
were a live impersonation hole and were removed — do not let a chat reintroduce
any of them. Auth is covered by `server/auth/selftest.mts` (47 checks). Warn the
user before any rename, sweeping find-and-replace, dependency reinstall, or
schema / wire-format change, stating exactly what could break.

## Things that will bite you

- **A chat that never synced** will happily edit files that do not exist and
  report success. If it cannot find `packages/`, it never synced.
- **Committing generated files.** `.gitignore` covers `node_modules/`, `dist/`,
  `data.db`, `uploads/`, `data/`, `*.legacy`, and `*.sqlite`. Do not override it.
- **Real family data in the repo.** This store is persistent and shared. Test
  fixtures only.
- **Background servers die between messages.** A preview started in one message
  is not running in the next. Sandbox limit, not an app bug.
- **`npm run build` writes `dist/`.** Ignored, but delete it before submitting if
  you ever force-add.

## Quick reference

```
pplx project files sync                       # first command in every chat
npm install                                   # root: packages + inventory app
npm --prefix apps/reindeer-fair-play install  # the TypeScript app
npm run inventory                             # port 3210
npm run fairchoice                            # port 5000
node scripts/roundtrip-test.mjs               # 44 checks, before every submit
npm --prefix apps/reindeer-fair-play run check
pplx project files submit -m "message"        # end of meaningful work
```
