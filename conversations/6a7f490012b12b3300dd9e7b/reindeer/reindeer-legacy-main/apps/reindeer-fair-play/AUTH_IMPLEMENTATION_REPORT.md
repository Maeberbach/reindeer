# Real authentication — implementation report

Scope: `apps/reindeer-fair-play` only. `client/` was not touched at all
(verified: no diffs, no modification timestamps in this session's work
window — the two client files showing as modified in `git status` predate
this task by roughly two hours, from the earlier fiduciary/import phase of
this same session).

## What was built

Email magic links, with the Personal Representative (PR) signing in the
same way as any heir — a participant row's `isAdmin` flag is what makes
someone the PR, not a separate login system.

### New tables (`server/migrations/v10_authentication.ts`, wired into
`server/storage.ts` right after `runV9InventoryImportMigration`)

- **`auth_tokens`** — one row per issued magic link / invite / short code.
  Columns: `id`, `session_id`, `participant_id`, `token_hash` (sha256 hex,
  **never** the raw token), `short_code` (6 chars, alphabet excludes
  `O/0/I/1`), `purpose`, `created_at`, `expires_at`, `consumed_at`,
  `consumed_ip`, `requested_ip`, `requested_user_agent`.
- **`auth_sessions`** — one row per signed-in device/browser. Columns:
  `id`, `session_id`, `participant_id`, `token_hash` (sha256 hex of the
  session cookie's raw value), `created_at`, `last_seen_at`, `expires_at`,
  `revoked_at`, `revoked_by_participant_id`, `user_agent`, `ip`.
- **`auth_events`** — append-only audit log. Columns: `id`, `session_id`,
  `participant_id`, `kind` (`token_issued`, `invite_issued`, `sign_in`,
  `sign_in_failed`, `sign_out`, `session_revoked`, `rate_limited`),
  `detail`, `ip`, `user_agent`, `created_at`.

Drizzle table defs, inferred types, and shared constants
(`AUTH_TOKEN_TTL_MS` = 20 min, `AUTH_SESSION_TTL_MS` = 30 days,
`SHORT_CODE_ALPHABET`/`LENGTH`, rate-limit constants, plain-language
message strings) live at the end of `shared/schema.ts`.

### `server/auth/` (new directory)

| File | Responsibility |
|---|---|
| `secret.ts` | `getAuthSecret()` — `REINDEER_FAIR_PLAY_AUTH_SECRET` env var, or 32 random bytes persisted to a gitignored `.auth-secret` file beside the DB (mode `0600`), one warning logged. |
| `tokens.ts` | `sha256Hex`, `timingSafeEqualStr`, raw-token/short-code generation, `issueToken`, `findTokenRow`, `checkTokenFresh` (read-only), `markTokenConsumedInTx` (only ever called inside the redemption transaction). |
| `sessionStore.ts` | `redeemToken` (atomic consume-token + create-session via a real `sqlite.transaction()`), `lookupSession`, `touchSession` (sliding 30-day expiry), `revokeSession`, `revokeAllForParticipant`, `listSessionsForParticipant`, `getSessionRow`, `createBootstrapSession` (one-time PR bootstrap only). |
| `events.ts` | `recordAuthEvent` — writes to `auth_events`. |
| `mailer.ts` / `delivery.d.ts` | Reuses `packages/legacy-delivery` (`ConsoleMailer` by default, `SmtpMailer` only if `LEGACY_SMTP_HOST` is set, `RecordingMailer` for tests) via the package root import `@reindeer-legacy/delivery`. `setMailerForTests`/`getMailer` let tests swap in `RecordingMailer`. Plain-language email copy including the 6-character short code and 20-minute expiry note. |
| `cookies.ts` | `readSignedSessionCookie` (cookie header → `cookie.parse` → `cookie-signature.unsign`, `"s:"` prefix, same convention as `cookie-parser`), `setSessionCookie`, `clearSessionCookie`. Cookie name `fc_session`: httpOnly, `sameSite: "lax"`, `secure` only in production, 30-day `maxAge`, path `/`. |
| `middleware.ts` | `attachActor` (cookie → session → `req.actor`; **never** reads body/query/headers), `requireAuth` (401), `requirePR` (403, fails closed on null actor), `requireSelfOrPR(targetId)`. |
| `router.ts` | `createAuthRouter()`: `POST /request` (rate-limited 5/15min per email and per IP, identical response regardless of match), `POST /redeem` (token or short code), `GET /me`, `POST /sign-out`, `GET /sessions`, `POST /sessions/:id/revoke`, `POST /participants/:id/invite` (PR-only). |
| `sharedGuards.ts` | `actorIdOf`, `denyIfNotPR`, `isSelfOrPR` — the single implementation now shared by `routes.ts`, `fiduciary/router.ts`, and `import/router.ts`. |
| `vendor.d.ts` | Ambient types for the two untyped transitive deps `cookie` and `cookie-signature`. |
| `selftest.mts` | The verification suite described below. |

`package.json` gained `"@reindeer-legacy/delivery": "file:../../packages/legacy-delivery"` (installed, symlinked, resolves cleanly from the package root — the package's `package.json` has `"main": "src/index.js"` with no `exports` map, so the deep `/src/mailer.js` path used in earlier drafts didn't type-resolve; importing `@reindeer-legacy/delivery` directly does).

## Exact route protection model

1. **`app.use("/api", attachActor)`** — mounted first, before everything
   else under `/api`. Resolves `req.actor` strictly from the signed
   `fc_session` cookie. Never reads `req.body.participantId`,
   `req.body.actorId`, `x-participant-id`, or `?participantId=`.
2. **`app.use("/api/auth", createAuthRouter())`** — mounted second, so the
   auth endpoints themselves see `req.actor` (needed for `GET /me`,
   `POST /sign-out`, `GET /sessions`, invite) but are still reachable before
   any deny-by-default gate.
3. **Deny-by-default gate** (`app.use("/api", ...)`, mounted third) — every
   `/api` route requires `req.actor` to be set, **except**:
   - `/api/auth/*` (the sign-in flow itself),
   - `GET /api/session`, but *only* while no participant has `isAdmin` yet
     (needed so the client can decide whether to show the welcome screen),
   - `POST /api/session/welcome` (bootstrap; see below).
4. **Bootstrap rule**: `POST /api/session/welcome` succeeds only when no
   participant exists yet (`storage.createWelcome` itself 409s otherwise);
   on success it signs the new PR in via `createBootstrapSession` +
   `setSessionCookie`, logs a `sign_in` auth event, and accepts an optional
   PR email.
5. **`actorOf(req)`** now returns `req.actor ?? null` — every body/query/
   header code path was deleted.
6. **`isPurePR(participant)`** fixed: `null` is no longer "pure PR".
7. **`denyIfNotPR`** fixed to fail closed: `if (!actor || !actor.isAdmin) deny`.
8. **`denyUnlessAllowed`** fixed: `isPR` is now `!!actor && actor.isAdmin`
   (was `!actor || actor.isAdmin` — null used to mean PR).
9. **`denyIfNotSelfOrPR`** — a fourth fail-open site found during
   implementation (not named in the task's explicit list): a null actor used
   to satisfy `actor.id === participantId` (both undefined-ish), letting an
   anonymous caller read/write anyone's ranking by omission. Now returns 401
   with plain language ("Please sign in to see this ranking.").
10. **`rankWriteContext`** — a fifth-in-sequence but independently discovered
    fail-open site: a null actor used to silently fall back to
    `{ editedBy: participantId, mode: "self" }`, letting an anonymous caller
    write a ranking as if they were whoever's id was supplied. Now 401s
    ("Please sign in to change this ranking.").
11. Routes that take `participantId` in the body/params as the **target**
    of an action (e.g. creating an heir with a given seat, revoking a
    specific session, inviting a specific participant) are unchanged — only
    actor resolution changed, never target resolution.
12. `server/fiduciary/router.ts` and `server/import/router.ts` had their own
    local, identically-fail-open `actorOf`/`denyIfNotPR` — both now import
    the shared guards from `server/auth/sharedGuards.ts` instead of
    reimplementing the logic.

## Verification — observed results

- **`npm run check`** (tsc): clean, no errors.
- **`npm run build`**: succeeds (client + server bundles built).
- **`npx tsx server/fiduciary/selftest.mts`**: **40/40** checks passed (run
  from a throwaway cwd, per the file's own documented convention, using
  `TSX_TSCONFIG_PATH` to keep `@shared/*`/`@reindeer-legacy/*` path aliases
  resolvable from outside the app directory).
- **`npx tsx server/import/selftest.mts`**: **35/35** checks passed (same
  throwaway-cwd convention, `REINDEER_FAIR_PLAY_UPLOAD_DIR` set to a scratch dir).
- **`npx tsx server/auth/selftest.mts`** (new): **43/43** checks passed.
  Boots a real Express app (`registerRoutes`) on an OS-assigned port against
  a scratch `data.db`, drives it over real HTTP with a hand-rolled
  cookie jar, and asserts (among others):
  - anonymous `PATCH /api/session` refused before bootstrap;
  - anonymous read of a protected route refused;
  - sending the PR's id as `body.participantId`/`body.actorId`,
    `?participantId=`, and `x-participant-id` header all grant nothing;
  - a signed-in heir cannot reach a PR-only route (`close-registration`);
  - a magic link redeems once and a second redemption (by link or by its
    short code) fails;
  - an expired token fails to redeem;
  - a revoked session fails closed on the very next request;
  - sign-out ends access even if the old cookie is replayed;
  - `POST /api/auth/request` returns an identical body for a known and an
    unknown email (no enumeration);
  - `POST /api/session/welcome` is refused (409) once a PR exists;
  - the test's `RecordingMailer` recorded messages and no real transport
    was used;
  - `auth_tokens.tokenHash` and `auth_sessions.tokenHash` are always
    64-char lowercase hex (sha256 digests) and never contain either raw
    credential (`rawToken`, `shortCode`) as a substring — checked by direct
    query against the live scratch database, not just inferred;
  - the original vulnerability directly: an anonymous caller cannot read a
    heir's ranking, including by supplying the PR's id via `?participantId=`.

  A direct, independent re-query after the run (outside the selftest
  process) confirmed the same: every `token_hash` value in both
  `auth_tokens` and `auth_sessions` is a 64-character lowercase hex string.

## Bug found and fixed during verification (not in the original task list)

The auth router (`createAuthRouter()`) was originally mounted at
`/api/auth` **before** `app.use("/api", attachActor)`. Express matches
middleware in registration order; because `GET /api/auth/me`,
`POST /api/auth/sign-out`, etc. terminate the response inside the auth
sub-router, `attachActor` (registered afterward) never ran for those
requests, so `req.actor` was always `undefined` there — every call to
`GET /api/auth/me` 401'd even for a freshly-signed-in user, and the PR-only
invite endpoint was unreachable. Fixed by swapping the mount order:
`attachActor` now runs first, then the auth router. This was caught by the
selftest itself (which is exactly what it's for) before this report was
written, not left in place.

## What the client agent must now do differently

- **All `/api` requests now require the `fc_session` cookie** to be sent
  (`credentials: "include"` / `same-origin` fetch default is fine, since
  it's a same-origin cookie) — the app no longer accepts
  `participantId`/`actorId` in the request body, `?participantId=` in the
  query string, or an `x-participant-id` header as identity. Those fields
  can still be sent as the **target** of an action (e.g. "revoke this
  session", "add this heir") — only the acting identity changed.
- Before the estate has a PR, the client should call `GET /api/session`
  (still allowed pre-bootstrap) to decide whether to show the welcome
  screen, then `POST /api/session/welcome` to create the PR and sign them
  in.
- After bootstrap, every other participant needs a sign-in flow: the PR
  calls `POST /api/auth/participants/:id/invite` to get a `linkUrl` and a
  6-character `shortCode` (for reading aloud over the phone); the heir's
  client calls `POST /api/auth/redeem` with either `{ token }` (from the
  link) or `{ shortCode }`.
- Any existing heir (with an email on file) can also self-serve via
  `POST /api/auth/request { email }`, which always returns the same
  generic message regardless of whether the email matched anything.
- The client needs to handle 401 responses generically now (show a
  sign-in prompt) rather than assuming every request succeeds identity-wise.
  All 401/403 messages returned by the server are already plain language,
  suitable to show directly.
- `GET /api/auth/sessions` + `POST /api/auth/sessions/:id/revoke` +
  `POST /api/auth/sign-out` are available if the client wants to expose a
  "signed-in devices" or "sign out" UI, but nothing requires it to.

**Per the task's constraint, none of this was implemented in `client/` —
the client agent still needs to build the actual sign-in screens.**

## Honest list of remaining weaknesses

- **Rate limiting is in-memory** (`Map` in `server/auth/router.ts`). It
  resets on every process restart and would not be shared across multiple
  server processes/instances. Fine for this single-process app today; would
  need to move to the database or a shared store before any horizontal
  scaling.
- **No email deliverability guarantee** — `ConsoleMailer` (the default
  outside of `LEGACY_SMTP_HOST` being set) just writes files to disk; there
  is no verification here that a configured SMTP transport actually
  delivers, only that the app never *silently* fails to attempt sending.
- **Short codes and full tokens share one `auth_tokens` row and TTL** — a
  short code is a second way to redeem the *same* 20-minute-lived row as
  the link, not an independently-lived credential. This matches the task's
  description ("`POST /redeem` (token or shortCode)") but is worth naming:
  if a product requirement ever wants the short code to be dictate-able
  slower/later than the link (e.g. longer-lived phone codes), that would
  need a schema change.
- **A handful of pre-existing `!actor`-as-soft-signal branches remain
  untouched** in `routes.ts` (e.g. `denyIfCannotCategorize`, some item
  delete/upload permission checks, the `/api/upload` uploader check). These
  are now unreachable with a null actor in practice because the
  deny-by-default gate refuses unauthenticated requests before they can
  reach these branches — they're a second line of defense, not
  independently hardened. They were deliberately left as-is rather than
  rewritten, to avoid changing legitimately-permissive behavior for
  authenticated users that wasn't part of this task's named vulnerability.
- **No account lockout / anomaly detection** beyond the per-email/IP rate
  limit on `/request` — e.g. no alerting if one IP redeems many different
  short codes in a short window. `auth_events` logs everything needed to
  build that later, but nothing consumes it yet.
- **Session revocation is per-row, not per-device-fingerprint** — revoking
  "a device" really means revoking one `auth_sessions` row (one cookie).
  If a browser's cookie is copied elsewhere, revoking the original session
  also revokes the copy (correct), but there's no separate notion of
  "trusted device" beyond the session itself.
- **The dev-mode auth secret** (`.auth-secret`, used only when
  `REINDEER_FAIR_PLAY_AUTH_SECRET` is unset) is process-local and file-persisted;
  this is correct behavior for local development but means every deploy
  environment must independently set the real environment variable in
  production — that's already logged loudly (one warning) if forgotten, but
  it's an operational step, not something code alone can guarantee.

## Files created

- `server/migrations/v10_authentication.ts`
- `server/auth/secret.ts`
- `server/auth/tokens.ts`
- `server/auth/sessionStore.ts`
- `server/auth/events.ts`
- `server/auth/mailer.ts`
- `server/auth/delivery.d.ts`
- `server/auth/cookies.ts`
- `server/auth/middleware.ts`
- `server/auth/router.ts`
- `server/auth/sharedGuards.ts`
- `server/auth/vendor.d.ts`
- `server/auth/selftest.mts`
- `apps/reindeer-fair-play/AUTH_IMPLEMENTATION_REPORT.md` (this file)

## Files changed

- `shared/schema.ts` (auth tables/types/constants appended at the end)
- `server/storage.ts` (migration wiring, exported `sqlite` handle)
- `server/routes.ts` (mount order, `actorOf`/`isPurePR`/`denyIfNotPR`/
  `denyUnlessAllowed`/`denyIfNotSelfOrPR`/`rankWriteContext` fixes, deny-by-
  default gate, bootstrap rule)
- `server/fiduciary/router.ts` (uses shared guards, no local reimplementation)
- `server/import/router.ts` (uses shared guards, `actorIdFrom(req)` instead
  of `actorIdFrom(body)`)
- `package.json` / `package-lock.json` (added `@reindeer-legacy/delivery`
  dependency)
- `.gitignore` (added `.auth-secret`)
