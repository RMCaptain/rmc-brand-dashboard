'use strict';
/**
 * PST/PDT-aware date utilities.
 *
 * Amazon North American marketplaces (CA + US) use America/Los_Angeles
 * (PST = UTC-8 in winter, PDT = UTC-7 in summer) as the day boundary for
 * Sales & Traffic reports, order timestamps, and all reporting periods.
 *
 * Using UTC midnight as the day boundary causes a mismatch:
 *   - UTC midnight on June 2 = 5pm PDT on June 1
 *   - Amazon's "June 1" S&T data doesn't close until midnight PDT (7am UTC June 2)
 *   - Result: our sync asks for "yesterday = June 1" while June 1 PST isn't finished yet
 *
 * These utilities ensure all date boundaries align with PST/PDT midnight.
 */

const LA_TZ = 'America/Los_Angeles';

/**
 * Returns today's date in PST/PDT as 'YYYY-MM-DD'.
 * Uses en-CA locale which formats as ISO date (YYYY-MM-DD) by default.
 */
function pstDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: LA_TZ }).format(date);
}

/**
 * Subtracts `days` calendar days from a PST date string (YYYY-MM-DD).
 * Pass a negative number to add days. Uses UTC arithmetic to avoid DST edge cases.
 */
function pstSubtractDays(pstDate, days) {
  const [y, m, d] = pstDate.split('-').map(Number);
  const result = new Date(Date.UTC(y, m - 1, d - days));
  return result.toISOString().split('T')[0];
}

/**
 * Returns the ISO UTC string for midnight PST/PDT on the given PST date (YYYY-MM-DD).
 * DST is handled automatically:
 *   Winter (PST, UTC-8): '2026-01-01' → '2026-01-01T08:00:00.000Z'
 *   Summer (PDT, UTC-7): '2026-06-01' → '2026-06-01T07:00:00.000Z'
 *
 * Algorithm: try PDT offset (7h) then PST offset (8h); accept whichever one
 * lands on hour=0 of the target date in the LA timezone.
 */
function pstMidnightAsUTC(pstDate) {
  for (const offsetHours of [7, 8]) {
    const utcStr   = `${pstDate}T${String(offsetHours).padStart(2, '0')}:00:00Z`;
    const candidate = new Date(utcStr);

    const localHour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: LA_TZ,
        hour: '2-digit',
        hour12: false
      }).format(candidate)
    );
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: LA_TZ }).format(candidate);

    if (localDate === pstDate && localHour === 0) return candidate.toISOString();
  }
  // Fallback: standard PST (UTC-8) — should never be reached under normal DST rules
  return `${pstDate}T08:00:00.000Z`;
}

/**
 * Returns the ISO UTC string for 23:59:59 PST/PDT on the given PST date.
 * Computed as (midnight of the next PST day) − 1 second, so it never
 * crosses into the next reporting day regardless of DST.
 */
function pstEndOfDayAsUTC(pstDate) {
  const nextDay         = pstSubtractDays(pstDate, -1);           // add 1 day
  const nextMidnightUTC = new Date(pstMidnightAsUTC(nextDay));
  return new Date(nextMidnightUTC.getTime() - 1000).toISOString(); // − 1 second
}

module.exports = { pstDateStr, pstSubtractDays, pstMidnightAsUTC, pstEndOfDayAsUTC };
