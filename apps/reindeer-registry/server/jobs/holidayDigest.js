/*
 * Holiday reminder — per-holiday email, 2 weeks before the date.
 *
 * The Registry stores which holidays each participant wants a nudge about
 * (reminder_prefs table). This job runs daily and checks: is any holiday
 * exactly 2 weeks from today? If so, every participant who opted into
 * that holiday gets a single email with a practical tip for that specific
 * holiday.
 *
 * This replaces the old yearly-digest-on-November-1 approach. Reminders
 * are now per-holiday, timed to the real date, 2 weeks ahead — enough
 * time to photograph the menorah before Hanukkah, lay out the china
 * before Thanksgiving, etc.
 *
 * Usage:
 *   node server/jobs/holidayDigest.js
 *
 * Or import and call from the server process:
 *   import { runHolidayReminders } from './server/jobs/holidayDigest.js';
 *   await runHolidayReminders({ db, mailer, participantsRepo, reminderPrefs });
 *
 * Environment:
 *   REINDEER_SMTP_HOST, REINDEER_SMTP_PORT, REINDEER_SMTP_USER, REINDEER_SMTP_PASS,
 *   REINDEER_SMTP_FROM, REINDEER_SMTP_SECURE — see mailer.js for details.
 *   If none are set, the ConsoleMailer writes emails to /tmp/reindeer-mail
 *   and nothing is actually sent (safe for development).
 */
import { mailerFromEnv } from '@reindeer/delivery';
import { HOLIDAY_LABELS } from '../routes/reminders.js';
import { holidayDate, holidayTwoWeeksFromNow } from './holidayDates.js';

/*
 * Practical, plain-language tips for each holiday. One sentence each —
 * the point is a nudge, not a manual.
 */
const HOLIDAY_TIPS = {
  thanksgiving: 'Bring a camera to Thanksgiving — lay the silver and china out together before anyone sits down.',
  christmas:    'Photograph the ornaments as you unpack them. Say who gave you each one.',
  hanukkah:     'Set the menorah out with the candles. One photo of the whole spread is enough.',
  passover:     'Photograph the seder plate and any heirloom Haggadah before the meal begins.',
  diwali:       'Lay the diyas out together and photograph them lit.',
  lunar_new_year: 'Photograph the decorations and any red envelopes before they are given out.',
  easter:       'Photograph the baskets and any decorated eggs before they are found.',
  mothers_day:  'A good day to photograph anything your mother gave you and say where it should go.',
  fathers_day:  'A good day to photograph anything your father gave you and say where it should go.',
  independence_day: 'If you have flags, medals, or military items, photograph them today.',
  birthdays:    'On each family birthday, photograph the cake, the card, and anything handed down that day.',
};

/**
 * Build a per-holiday reminder email for a single participant.
 * Returns { subject, text, html }.
 */
export function buildReminderEmail(displayName, holidayKey, holidayLabel, holidayDateObj) {
  const name = displayName ? displayName.split(' ')[0] : 'there';
  const dateStr = holidayDateObj.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const tip = HOLIDAY_TIPS[holidayKey] || 'Photograph anything that carries a story and say who it should go to.';

  const lines = [
    `Hi ${name},`,
    '',
    `${holidayLabel} is coming up on ${dateStr} — two weeks from today.`,
    '',
    tip,
    '',
    'You can change your reminder picks any time in the app under "Possessions with high emotional connections that can cause conflict" → Holiday reminders.',
    '',
    'Nothing here is a will. It records your wishes so your family is not guessing.',
    '',
    'Reindeer: Registry',
  ];

  const htmlLines = [
    `<p>Hi ${name},</p>`,
    `<p><strong>${holidayLabel}</strong> is coming up on ${dateStr} — two weeks from today.</p>`,
    `<p>${tip}</p>`,
    `<p>You can change your reminder picks any time in the app under "Possessions with high emotional connections that can cause conflict" &rarr; Holiday reminders.</p>`,
    `<p><em>Nothing here is a will. It records your wishes so your family is not guessing.</em></p>`,
    `<p>Reindeer: Registry</p>`,
  ];

  return {
    subject: `${holidayLabel} is two weeks away — time to photograph your things`,
    text: lines.join('\n'),
    html: htmlLines.join('\n'),
  };
}

/**
 * Run the daily check. Finds any holiday that is exactly 2 weeks from
 * today, then sends a per-holiday email to every participant who opted
 * into that holiday.
 *
 * Returns a summary: { sent, skipped, failed, holiday, details }.
 * If no holiday is 2 weeks out, returns { sent: 0, holiday: null }.
 */
export async function runHolidayReminders({ db, mailer, participantsRepo, reminderPrefs, now }) {
  const m = mailer || mailerFromEnv();
  const today = now || new Date();
  const year = today.getFullYear();

  // Check if any holiday is 2 weeks from today.
  // We check both this year and next year (to catch early-January
  // holidays that fall just after New Year's).
  let holidayKey = holidayTwoWeeksFromNow(today, year);
  if (!holidayKey) {
    holidayKey = holidayTwoWeeksFromNow(today, year + 1);
  }

  const summary = { sent: 0, skipped: 0, failed: 0, holiday: holidayKey, details: [] };

  if (!holidayKey) {
    // No holiday is 2 weeks out today — nothing to send.
    return summary;
  }

  const holidayLabel = HOLIDAY_LABELS[holidayKey] || holidayKey;
  const hDate = holidayDate(holidayKey, holidayKey === holidayTwoWeeksFromNow(today, year + 1) ? year + 1 : year);

  // Find every participant who opted into this holiday.
  const participants = reminderPrefs.participantsForHoliday(holidayKey);

  for (const { participant_id } of participants) {
    const participant = participantsRepo.get(participant_id);
    if (!participant || !participant.email) {
      summary.skipped++;
      summary.details.push({ participant_id, status: 'no_email' });
      continue;
    }

    const email = buildReminderEmail(participant.display_name || '', holidayKey, holidayLabel, hDate);

    try {
      const result = await m.send({
        to: participant.email,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });

      if (result.ok) {
        summary.sent++;
        summary.details.push({ participant_id, email: participant.email, status: 'sent' });
      } else {
        summary.failed++;
        summary.details.push({ participant_id, email: participant.email, status: 'failed', error: result.error });
      }
    } catch (e) {
      summary.failed++;
      summary.details.push({ participant_id, email: participant.email, status: 'failed', error: e.message });
    }
  }

  return summary;
}

/**
 * CLI entry point. Run directly with: node server/jobs/holidayDigest.js
 */
async function main() {
  const Database = (await import('better-sqlite3')).default;
  const { ParticipantsRepo, ReminderPrefsRepo } = await import('@reindeer/core-data');

  const dbPath = process.env.REINDEER_DB_PATH || './data/reindeer-registry.db';
  const db = new Database(dbPath);

  // Ensure the reminder_prefs table exists.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminder_prefs (
      scope_id       TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      holidays_json  TEXT NOT NULL DEFAULT '[]',
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (scope_id, participant_id)
    );
  `);

  const participantsRepo = new ParticipantsRepo(db);
  const reminderPrefs = new ReminderPrefsRepo(db);
  const mailer = mailerFromEnv();

  console.log(`Holiday reminder check starting. Mailer: ${mailer.describe}`);
  console.log(`Database: ${dbPath}`);
  console.log(`Date: ${new Date().toISOString()}`);

  const summary = await runHolidayReminders({ db, mailer, participantsRepo, reminderPrefs });

  if (!summary.holiday) {
    console.log('No holiday is two weeks from today. Nothing to send.');
  } else {
    console.log(`\nHoliday: ${summary.holiday}`);
    console.log(`Sent: ${summary.sent}, Skipped: ${summary.skipped}, Failed: ${summary.failed}`);
    for (const d of summary.details) {
      console.log(`  ${d.status}: ${d.email || d.participant_id}${d.error ? ` — ${d.error}` : ''}`);
    }
  }

  db.close();
}

// Run if invoked directly (not imported).
const isMain = (() => {
  try { return import.meta.url === `file://${process.argv[1]}`; }
  catch { return false; }
})();
if (isMain) main().catch(e => { console.error(e); process.exit(1); });
