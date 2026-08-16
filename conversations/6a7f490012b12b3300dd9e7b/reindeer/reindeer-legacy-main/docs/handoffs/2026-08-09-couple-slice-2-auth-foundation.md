# Couple Mode Slice 2 — Real authentication for Reindeer: Registry

**Date:** 2026-08-09 (session)
**Follows:** Slice 1 (`da4eecb` — schema + claim repos)
**Precedes:** Slice 3 (claim routes on top of real sessions)
**Status:** Landed. Full test matrix green (421 checks).

## What changed

Before this slice, Registry had no authentication. `resolveScope()`
returned a hardcoded `actorId: 'owner'` and every `/api` route accepted
any caller. The `req.body.participantId` impersonation hole documented
in the project instructions was already gone, but the deeper hole —
"anyone with the URL is the owner" — was still open.

Slice 2 closes that hole with the auth mechanism specified in the
project instructions:

- Email magic links, single-use, 20-minute TTL, sha256-hashed at rest
- 30-day sliding server-side sessions, sha256-hashed tokens
- `httpOnly` signed session cookies (`legacy_session`), HMAC-SHA256, `SameSite=Lax`
- Deny-by-default over `/api` — `authRequired` middleware in front of every route
- Bootstrap-owner mode: while `participants.count() === 0`, requests without a
  cookie get a synthetic `bootstrap-owner` identity so a fresh installer can
  onboard. As soon as the first participant exists, this shortcut turns off
  automatically.

## Files added

- `packages/legacy-core-data/src/repos/participantsRepo.js` — the participant roster
- `packages/legacy-core-data/src/repos/magicLinksRepo.js` — issue + single-use consume
- `packages/legacy-core-data/src/repos/sessionsRepo.js` — create + resolve + sliding + sign-out
- `apps/reindeer-registry/server/auth/cookie.js` — signed-cookie helpers (node stdlib only)
- `apps/reindeer-registry/server/auth/service.js` — `AuthService` (magic-link handshake + bootstrap)
- `apps/reindeer-registry/server/auth/middleware.js` — `attachSession`, `authRequired`, cookie helpers
- `apps/reindeer-registry/server/auth/router.js` — `POST /api/auth/request-link`, `GET /api/auth/verify`, `POST /api/auth/sign-out`, `GET /api/auth/me`
- `scripts/lib/http-auth.mjs` — test helper: `signInAsBootstrapOwner`, `authedFetch`
- `scripts/auth-test.mjs` — DB-layer suite for the three repos and the service (33 checks)
- `packages/legacy-core-data/src/migrations/index.js` — migration 14 (`auth_sessions_and_magic_links`)

## Files edited

- `packages/legacy-core-data/src/index.js` — export the three new repos + TTL constants
- `apps/reindeer-registry/server/index.js` —
  - Instantiate the three repos + `AuthService`
  - Read `REINDEER_SESSION_SECRET` from env (required in production; warns + generates ephemeral in dev)
  - Mount `attachSession` before any `/api` route
  - Mount `/api/auth/*` and `/api/health` before `authRequired`, everything else after
  - `resolveScope(req)` now derives `actorId` from `req.participant.participant_id`
- `scripts/people-test.mjs` — sign in via the helper up front; all requests carry the cookie
- `scripts/sign-test.mjs` — same; also rewrote 9 raw `fetch()` calls to use the authed wrapper

## No new npm packages

Everything uses node stdlib (`crypto` for HMAC, hashing, random tokens).

## Bootstrap-owner mode — the honest disclosure

While `participants.count() === 0`, ANY caller reaches `/api` as an
"owner". This is deliberate — a solo installer needs a way in without
external email. It self-disables the moment one participant exists. If
the installer wants to skip bootstrap entirely, they set
`REINDEER_SESSION_SECRET` and post to `/api/auth/request-link` before
anything else.

## Test matrix (all green after Slice 2)

| Suite                            | Checks |
| -------------------------------- | ------ |
| content-lint                     | clean  |
| auth-test (new, DB layer)        | 33     |
| couple-claims-test (Slice 1)     | 49     |
| roundtrip-test                   | 66     |
| two-outputs-envelope-test        | 37     |
| two-outputs-bundle-test          | 60     |
| two-lane-test                    | 22     |
| vision-test                      | 32     |
| people-test (HTTP)               | 36     |
| sign-test (HTTP)                 | 43     |
| **Total**                        | **421** |

## Next: Slice 3

- Add `household_mode` to `GET /api/scope-summary` response (additive JSON, always
  `'solo'` today).
- Add memorandum-claim + importance-claim routes (12 endpoints across 2 routers).
  `participantId` ALWAYS from `req.session`, never from body/header/query.
- Extend the addendum-preview lookup with a `household_mode === 'couple'` branch
  reading `memorandumClaimsRepo.addendumPreview()`; solo path unchanged.
- New HTTP integration test `couple-claims-http-test.mjs` (~50 checks).
- Full test matrix + submit.
