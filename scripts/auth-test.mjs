/* Auth foundation \u2014 DB-layer tests for participants, magic links, and
 * sessions. Runs against a fresh temp SQLite database so it can be
 * repeated deterministically. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  openDb, SqliteAuditLog, ParticipantsRepo, normalizeEmail,
  MagicLinksRepo, MAGIC_LINK_TTL_MINUTES, SessionsRepo, SESSION_TTL_MILLISECONDS,
} from '@reindeer-legacy/core-data';
import { AuthService } from '../apps/reindeer-registry/server/auth/service.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-auth-test-'));
const db = openDb(path.join(dir, 'auth-test.db'));
const audit = new SqliteAuditLog(db);
const participants = new ParticipantsRepo(db, audit);
const magicLinks = new MagicLinksRepo(db);
const sessions = new SessionsRepo(db);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  \u2713 ' + m)) : (fail++, console.log('  \u2717 ' + m)); };

console.log('\n1. Email normalization');
{
  ok(normalizeEmail('  Mark@Example.COM  ') === 'mark@example.com', 'trims and lowercases');
  ok(normalizeEmail('') === '', 'empty stays empty');
  ok(normalizeEmail(null) === '', 'null becomes empty');
}

console.log('\n2. Participants \u2014 count, upsert, find, touch');
{
  ok(participants.count() === 0, 'starts empty');
  const p = participants.upsertByEmail({ email: 'Owner@Legacy.test', role: 'owner', status: 'active' });
  ok(!!p.participant_id && p.email === 'owner@legacy.test', 'stores normalized email');
  ok(participants.count() === 1, 'count reflects the new row');
  const again = participants.upsertByEmail({ email: 'OWNER@legacy.test', role: 'partner' });
  ok(again.participant_id === p.participant_id, 'same email returns same participant');
  ok(again.role === 'owner', 'upsert never downgrades an owner');
  const found = participants.findByEmail('owner@legacy.test');
  ok(found?.participant_id === p.participant_id, 'findByEmail is case-insensitive via normalization');
  participants.touchLastSeen(p.participant_id);
  const touched = participants.get(p.participant_id);
  ok(!!touched.last_seen_at, 'touchLastSeen records a timestamp');
}

console.log('\n3. Magic links \u2014 issue, consume once, expiry');
{
  const email = 'signin@legacy.test';
  const { token, expiresAt } = magicLinks.issue({ email, purpose: 'signin' });
  ok(typeof token === 'string' && token.length >= 32, 'issues an opaque token');
  const link = magicLinks.consume(token);
  ok(link.email === email, 'first consume returns the email');
  ok(link.purpose === 'signin', 'and the purpose');
  let threw = null;
  try { magicLinks.consume(token); } catch (e) { threw = e; }
  ok(threw && threw.status === 400, 'a second consume of the same token is rejected');
  ok(!/hash|sha|already/i.test(threw?.message || ''), 'the rejection message is generic (no oracle)');
  // Fabricated token
  let threw2 = null;
  try { magicLinks.consume('this-is-not-a-real-token-xxxxxxxxxxxxxxx'); } catch (e) { threw2 = e; }
  ok(threw2 && threw2.status === 400, 'an unknown token is rejected the same way');
  // TTL constant
  ok(MAGIC_LINK_TTL_MINUTES >= 5 && MAGIC_LINK_TTL_MINUTES <= 60, 'TTL is in a sensible range');
  // Manually expire and re-consume
  const stale = magicLinks.issue({ email, purpose: 'signin' });
  db.prepare('UPDATE magic_links SET expires_at = ? WHERE token_hash = (SELECT token_hash FROM magic_links ORDER BY issued_at DESC LIMIT 1)')
    .run(new Date(Date.now() - 60_000).toISOString());
  let threw3 = null;
  try { magicLinks.consume(stale.token); } catch (e) { threw3 = e; }
  ok(threw3 && threw3.status === 400, 'expired tokens are rejected');
  // Invite variant
  const invite = magicLinks.issue({ email: 'partner@legacy.test', purpose: 'invite', inviteRole: 'partner', inviteScopeId: 'inventory-default' });
  const consumed = magicLinks.consume(invite.token);
  ok(consumed.purpose === 'invite' && consumed.invite_role === 'partner', 'invite tokens carry their role');
}

console.log('\n4. Sessions \u2014 create, resolve, sign out');
{
  const p = participants.findByEmail('owner@legacy.test');
  const s = sessions.create({ participantId: p.participant_id, userAgent: 'test-runner/1.0' });
  ok(typeof s.token === 'string' && s.token.length >= 32, 'session token is opaque');
  ok(!!s.sessionId, 'sessionId is returned');
  const resolved = sessions.resolve(s.token);
  ok(resolved?.participant_id === p.participant_id, 'resolve returns the participant');
  ok(sessions.resolve('bogus-token-that-should-not-match') === null, 'unknown tokens resolve to null');
  sessions.signOut(s.sessionId);
  ok(sessions.resolve(s.token) === null, 'signed-out sessions no longer resolve');
  ok(SESSION_TTL_MILLISECONDS >= 7 * 24 * 3600 * 1000, 'session TTL is at least a week');
}

console.log('\n5. AuthService \u2014 bootstrap, magic-link handshake, invite');
{
  // Wipe participants so we can prove bootstrap mode toggles correctly.
  db.prepare('DELETE FROM participants').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM magic_links').run();
  const auth = new AuthService({
    participants, magicLinks, sessions, mailer: null,
    linkBaseUrl: 'http://localhost:9999',
  });
  ok(auth.isBootstrapMode() === true, 'fresh install is in bootstrap mode');
  const { link } = await auth.requestLink({ email: 'firstowner@legacy.test' });
  const token = new URL(link).searchParams.get('token');
  const result = await auth.verifyLink({ token, userAgent: 'test' });
  ok(result.participant.role === 'owner', 'the first verify makes an owner');
  ok(result.participant.email === 'firstowner@legacy.test', 'and stores the email');
  ok(auth.isBootstrapMode() === false, 'after one participant, bootstrap is disabled');
  // A stranger cannot sign in via signin (email is not on file)
  const { link: strangerLink } = await auth.requestLink({ email: 'stranger@legacy.test' });
  const strangerToken = new URL(strangerLink).searchParams.get('token');
  let strangerErr = null;
  try { await auth.verifyLink({ token: strangerToken }); } catch (e) { strangerErr = e; }
  ok(strangerErr && strangerErr.status === 400, 'a stranger cannot sign in without an invite');
  // Invite path admits a new participant with the requested role
  const { link: inviteLink } = await auth.requestLink({
    email: 'partner@legacy.test',
    invite: { scopeId: 'inventory-default', role: 'partner' },
  });
  const inviteToken = new URL(inviteLink).searchParams.get('token');
  const inviteResult = await auth.verifyLink({ token: inviteToken });
  ok(inviteResult.participant.role === 'partner', 'an invited partner gets the partner role');
  ok(inviteResult.linkPurpose === 'invite', 'and the link purpose is preserved for callers');
  const resolved = auth.resolveSession(inviteResult.sessionToken);
  ok(resolved?.participant.email === 'partner@legacy.test', 'the minted session resolves back to the participant');
}

// Cleanup
try { db.close(); } catch { /* ignore */ }
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} checks passed, ${fail} failed`);
if (fail > 0) process.exit(1);
