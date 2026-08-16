/*
 * Holiday reminders.
 *
 * The owner (or their linked partner) picks which holidays they want a nudge
 * about — "photograph the tree," "bring a camera to Thanksgiving," etc. The
 * Registry does NOT send the email itself. It stores the picks in
 * reminder_prefs and a Perplexity Computer scheduled task reads the table
 * and dispatches the actual emails on the right days.
 *
 * The allowed keys are a small closed vocabulary shared between this route
 * and the client. Add a key here first, then the client checkbox, then the
 * scheduled task.
 *
 * Identity is always taken from req.participant.participant_id. No body
 * field ever supplies an identity.
 */
import express from 'express';
import { makeScopeCtx } from '@reindeer/core-api';

export const HOLIDAY_KEYS = Object.freeze([
  'thanksgiving',
  'christmas',
  'hanukkah',
  'passover',
  'diwali',
  'lunar_new_year',
  'easter',
  'mothers_day',
  'fathers_day',
  'independence_day',
  'birthdays',
]);

export const HOLIDAY_LABELS = Object.freeze({
  thanksgiving: 'Thanksgiving',
  christmas: 'Christmas',
  hanukkah: 'Hanukkah',
  passover: 'Passover',
  diwali: 'Diwali',
  lunar_new_year: 'Lunar New Year',
  easter: 'Easter',
  mothers_day: "Mother's Day",
  fathers_day: "Father's Day",
  independence_day: 'Independence Day',
  birthdays: 'Family birthdays',
});

function signedIn(req, res, next) {
  if (!req.participant) return res.status(401).json({ error: 'Sign in to continue.' });
  return next();
}

export function createRemindersRouter({ reminderPrefs, resolveScope }) {
  const r = express.Router();
  const ctxOf = (req) => makeScopeCtx(resolveScope(req));
  const me = (req) => req.participant?.participant_id;

  /*
   * GET /reminders/holidays
   *   Returns the current participant's picked holidays plus the full
   *   vocabulary so the client can render checkboxes without a second call.
   */
  r.get('/reminders/holidays', signedIn, (req, res) => {
    const ctx = ctxOf(req);
    const picks = reminderPrefs.get(ctx.scopeId, me(req));
    res.json({
      picked: picks,
      vocabulary: HOLIDAY_KEYS.map((k) => ({ key: k, label: HOLIDAY_LABELS[k] })),
    });
  });

  /*
   * POST /reminders/holidays
   *   Body: { holidays: string[] } — a full replacement of the picked list.
   *   Empty array clears all opt-ins. Every entry must be in HOLIDAY_KEYS
   *   or the whole request is rejected 400.
   */
  r.post('/reminders/holidays', signedIn, express.json(), (req, res) => {
    const ctx = ctxOf(req);
    const raw = req.body?.holidays;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: 'holidays must be an array.' });
    }
    const bad = raw.find((k) => typeof k !== 'string' || !HOLIDAY_KEYS.includes(k));
    if (bad !== undefined) {
      return res.status(400).json({ error: `Unknown holiday: ${String(bad)}` });
    }
    // De-duplicate while preserving order.
    const seen = new Set();
    const cleaned = raw.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
    const saved = reminderPrefs.set(ctx.scopeId, me(req), cleaned);
    res.json({ ok: true, picked: saved });
  });

  return r;
}
