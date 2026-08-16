# Reindeer Legacy

Two estate applications that share one codebase.

**Two perspectives, one estate.** While the owner is alive, the estate is theirs — Registry
serves *their* desires: what exists, what it means, and who each thing was meant for. After the
owner is gone, the estate belongs to the heirs, and FairPlay is the app the heirs run together
to divide what was not specifically directed. The **trustee** (the person named by the trust or
will to wind up the estate — your legal documents may call them *trustee*, *personal
representative*, or *executor*) sits outside the app by default and handles the high-value items
and the financial balance of the estate; when a family needs it, the trustee can sign in and run
the session as **captain**. The suite is designed around three protections: **protecting the
estate** (nothing significant is quietly divided by mistake), **protecting the heirs** (a fair,
agreed-in-advance process with a signed record), and **protecting the trustee** (a high-value
flag that prevents inadvertent legal exposure, plus a clean audit trail for the trust file). See
[`docs/SUITE-OVERVIEW.md`](docs/SUITE-OVERVIEW.md) for the positioning in full.

| App | Folder | What it does |
| --- | --- | --- |
| **Reindeer Registry** | `apps/reindeer-registry` | Owner-driven, while the owner is alive. Photograph, film, and record belongings. Print sheets. Send a sealed package to the trustee. |
| **Reindeer: FairPlay** | `apps/reindeer-fair-play` | The heir-run family distribution process, after. Segregates high-value items to the trustee. Sold separately. Accepts an inventory package through the import adapter. |

## Shared packages

| Package | Responsibility |
| --- | --- |
| `@reindeer-legacy/core-api` | Models, enums, ports, validators, errors. No I/O. |
| `@reindeer-legacy/core-data` | SQLite, migrations, hash-chained audit log, item repository, media stores. |
| `@reindeer-legacy/intake-feature` | Guided capture, vision screening, duplicate detection, intake routes. |
| `@reindeer-legacy/print-feature` | Item sheets, room and category reports, trustee cover packet. |
| `@reindeer-legacy/exchange` | ReindeerExchange v1 — the `.legacy` bundle, envelope, writer, reader, importer. |
| `@reindeer-legacy/delivery` | Trustees, mailer, two-step package delivery, secure links. |

## The boundary that must not move

Heirs, rankings, priority, conflict counters, the ranked-draft engine, and the
Record of Decisions belong to **Reindeer: FairPlay only**. Registry carries a
free-text `recipient_hint` that is always non-binding and never auto-applies to
anyone.

Value balancing between heirs sits outside both apps by design. FairPlay
flags items for appraisal and hands them to the trustee on the Record of
Decisions; the trustee resolves value questions against other estate assets in
their usual workflow. There is no in-app equalization ledger, per-item consent
flow, or finalization gate — that scope was retired in commits 6 and 7.

## Running it

```bash
npm install
npm run inventory          # http://localhost:3210
node scripts/roundtrip-test.mjs
```

Node 20+. Plain ESM JavaScript, no TypeScript, no build step, npm workspaces.

## Before you commit

Run `node scripts/roundtrip-test.mjs`. It builds an inventory with photos, video,
and voice, exports a bundle, imports it into a separate estate database, checks
the six import rules, exercises trustee delivery, and verifies both audit chains.
