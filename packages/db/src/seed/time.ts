/**
 * Day boundaries are Europe/London calendar dates (spec §13) — labelled as
 * UTC midnight of the London date. Event times are generated in the 8-19 UTC
 * band, which stays inside the same London calendar date year-round, so
 * date-grouping in either zone agrees. (The seed initially used UTC "today"
 * and the whole 90-day window shifted by a day when run between 23:00 and
 * 01:00 London — exactly the DST-boundary class of bug §13 tells us to test.)
 */

export function londonTodayUTC(): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
  }).format(new Date());
  return new Date(`${ymd}T00:00:00Z`);
}

export function londonDayUTC(daysAgo: number): Date {
  const d = londonTodayUTC();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

export function londonMonthStartUTC(monthsAgo: number): Date {
  const d = londonTodayUTC();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d;
}
