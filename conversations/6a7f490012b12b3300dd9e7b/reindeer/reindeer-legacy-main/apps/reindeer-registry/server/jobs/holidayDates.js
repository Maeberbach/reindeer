/*
 * Holiday date computation.
 *
 * Each holiday the Registry knows about can be mapped to a specific date
 * in a given year. Several are fixed (Christmas = Dec 25), others are
 * variable (Thanksgiving = 4th Thursday of November, Easter = computus,
 * Mother's Day = 2nd Sunday of May, etc.).
 *
 * Birthdays are a special case — they are per-family and the Registry
 * does not track specific dates. The reminder job skips 'birthdays' and
 * the client shows a note explaining that birthday reminders are not
 * scheduled (the owner handles those themselves).
 *
 * All dates are returned as JS Date objects at midnight local time
 * (America/New_York assumed, but the date itself is timezone-independent
 * for reminder math — we only care about the calendar day).
 */

/**
 * Compute the date of a holiday in a given year.
 * @param {string} key - Holiday key from HOLIDAY_KEYS
 * @param {number} year - 4-digit year
 * @returns {Date|null} Date at midnight, or null for 'birthdays' (no fixed date)
 */
export function holidayDate(key, year) {
  switch (key) {
    case 'christmas':
      return new Date(year, 11, 25);

    case 'thanksgiving':
      // 4th Thursday of November
      return nthWeekdayOfMonth(year, 10, 4, 4); // Nov=10, Thursday=4

    case 'easter':
      return easterDate(year);

    case 'mothers_day':
      // 2nd Sunday of May
      return nthWeekdayOfMonth(year, 4, 2, 0); // May=4, Sunday=0

    case 'fathers_day':
      // 3rd Sunday of June
      return nthWeekdayOfMonth(year, 5, 3, 0); // Jun=5, Sunday=0

    case 'independence_day':
      return new Date(year, 6, 4); // Jul 4

    case 'hanukkah':
      // 25th of Kislev on the Hebrew calendar. We approximate using
      // the known civil date range — Hanukkah falls between late Nov
      // and late Dec. For a precise date we'd need a full Hebrew
      // calendar conversion, which is beyond this module. We use a
      // simple approximation: 25 Kislev ≈ Dec 15 ± 20 days.
      // For now, return null to indicate "compute externally" and
      // the reminder job will skip it with a note.
      return hanukkahApprox(year);

    case 'passover':
      // 15th of Nisan on the Hebrew calendar. Falls in March or April,
      // often near Easter but not always the same. Similar to Hanukkah,
      // a precise date requires a Hebrew calendar conversion.
      return passoverApprox(year);

    case 'diwali':
      // Falls in October or November, date varies by Hindu calendar.
      return diwaliApprox(year);

    case 'lunar_new_year':
      // Falls in Jan or Feb, date varies by Chinese lunisolar calendar.
      return lunarNewYearApprox(year);

    case 'birthdays':
      // No fixed date — handled separately by the owner.
      return null;

    default:
      return null;
  }
}

/**
 * Find the Nth occurrence of a given weekday in a month.
 * @param {number} year
 * @param {number} month - 0-indexed (0 = January)
 * @param {number} n - Which occurrence (1st, 2nd, 3rd, 4th)
 * @param {number} weekday - 0 = Sunday, 1 = Monday, ..., 6 = Saturday
 * @returns {Date}
 */
function nthWeekdayOfMonth(year, month, n, weekday) {
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return new Date(year, month, day);
}

/**
 * Easter date using the Computus algorithm (Gregorian).
 * @param {number} year
 * @returns {Date}
 */
function easterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/*
 * Approximate dates for holidays on non-Gregorian calendars.
 * These are close enough for "send a reminder 2 weeks before" — being
 * off by a day or two doesn't matter when the nudge is 14 days out.
 * The exact dates would require full calendar conversions (Hebrew,
 * Hindu, Chinese) which are heavy dependencies for a reminder job.
 * If precision becomes important, swap these for a calendar library.
 */

// Known Hanukkah start dates (25 Kislev):
// 2025: Dec 14, 2026: Dec 4, 2027: Dec 24, 2028: Dec 12, 2029: Dec 1,
// 2030: Dec 19, 2031: Dec 8, 2032: Dec 27, 2033: Dec 16, 2034: Dec 5
const HANUKKAH_DATES = {
  2025: '2025-12-14', 2026: '2026-12-04', 2027: '2027-12-24',
  2028: '2028-12-12', 2029: '2029-12-01', 2030: '2030-12-19',
  2031: '2031-12-08', 2032: '2032-12-27', 2033: '2033-12-16',
  2034: '2034-12-05',
};
function hanukkahApprox(year) {
  const s = HANUKKAH_DATES[year];
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Known Passover start dates (15 Nisan):
// 2025: Apr 12, 2026: Apr 1, 2027: Apr 21, 2028: Apr 9, 2029: Mar 29,
// 2030: Apr 17, 2031: Apr 5, 2032: Apr 23, 2033: Apr 11, 2034: Apr 31→Apr 1
const PASSOVER_DATES = {
  2025: '2025-04-12', 2026: '2026-04-01', 2027: '2027-04-21',
  2028: '2028-04-09', 2029: '2029-03-29', 2030: '2030-04-17',
  2031: '2031-04-05', 2032: '2032-04-23', 2033: '2033-04-11',
  2034: '2034-04-01',
};
function passoverApprox(year) {
  const s = PASSOVER_DATES[year];
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Known Diwali dates:
// 2025: Oct 21, 2026: Nov 8, 2027: Oct 28, 2028: Oct 17, 2029: Nov 5,
// 2030: Oct 26, 2031: Nov 14, 2032: Nov 3, 2033: Oct 23, 2034: Nov 12
const DIWALI_DATES = {
  2025: '2025-10-21', 2026: '2026-11-08', 2027: '2027-10-28',
  2028: '2028-10-17', 2029: '2029-11-05', 2030: '2030-10-26',
  2031: '2031-11-14', 2032: '2032-11-03', 2033: '2033-10-23',
  2034: '2034-11-12',
};
function diwaliApprox(year) {
  const s = DIWALI_DATES[year];
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Known Lunar New Year dates:
// 2025: Jan 29, 2026: Feb 17, 2027: Feb 6, 2028: Jan 26, 2029: Feb 13,
// 2030: Feb 3, 2031: Jan 23, 2032: Feb 11, 2033: Jan 31, 2034: Feb 19
const LUNAR_NEW_YEAR_DATES = {
  2025: '2025-01-29', 2026: '2026-02-17', 2027: '2027-02-06',
  2028: '2028-01-26', 2029: '2029-02-13', 2030: '2030-02-03',
  2031: '2031-01-23', 2032: '2032-02-11', 2033: '2033-01-31',
  2034: '2034-02-19',
};
function lunarNewYearApprox(year) {
  const s = LUNAR_NEW_YEAR_DATES[year];
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Given a date, return the holiday key whose date is exactly 14 days
 * after it (i.e., the holiday is 2 weeks from this date).
 *
 * @param {Date} today - The current date
 * @param {number} year - Year to check holidays in
 * @returns {string|null} Holiday key, or null if none is 2 weeks out
 */
export function holidayTwoWeeksFromNow(today, year) {
  const target = new Date(today);
  target.setDate(target.getDate() + 14);
  target.setHours(0, 0, 0, 0);

  for (const key of Object.keys(HOLIDAY_LABELS_MAP)) {
    const hDate = holidayDate(key, year);
    if (!hDate) continue;
    hDate.setHours(0, 0, 0, 0);
    if (hDate.getTime() === target.getTime()) return key;
  }
  return null;
}

// Avoid circular import — define a local copy of the labels map.
const HOLIDAY_LABELS_MAP = {
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
};
