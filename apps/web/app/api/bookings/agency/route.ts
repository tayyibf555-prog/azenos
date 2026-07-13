import { NextResponse } from "next/server";
import { z } from "zod";
import { londonDayUTC } from "@azen/db";
import { getAgencyBookings } from "../../../../lib/server/bookings";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";
import { searchParamsObject, zodSummary } from "../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

/** YYYY-MM-DD of a Date's UTC calendar day (our London-day Dates are UTC midnight). */
const toDateStr = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The UTC instant whose Europe/London wall-clock time is 00:00 on `dateStr`.
 * The window params are London calendar dates, so their boundaries must anchor
 * on true Europe/London midnight — not UTC midnight, which under BST is 01:00
 * London and would mis-classify bookings in the first/last hour of a London day
 * (the client-end rollup uses Postgres `at time zone 'Europe/London'` for the
 * same reason). The London↔UTC offset for the date is read from Intl — the same
 * mechanism the shared londonTodayUTC helper uses — and subtracted.
 */
function londonMidnightUTC(dateStr: string): Date {
  const utcMidnight = new Date(`${dateStr}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utcMidnight);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)!.value);
  const hour = get("hour") % 24; // some engines emit 24 for midnight
  const wallAsUTC = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  const offsetMs = wallAsUTC - utcMidnight.getTime(); // London = UTC + offset
  return new Date(utcMidnight.getTime() - offsetMs);
}

/** from/to are London calendar dates (YYYY-MM-DD). Default: trailing 90 days. */
const querySchema = z.object({
  from: z.preprocess(emptyToUndefined, z.iso.date().optional()),
  to: z.preprocess(emptyToUndefined, z.iso.date().optional()),
});

export const GET = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = querySchema.safeParse(searchParamsObject(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  // Default window: trailing 90 London days .. end of today (exclusive next
  // day). Both boundaries anchor on true Europe/London midnight of the London
  // calendar date (londonDayUTC yields the UTC-midnight-labelled London date;
  // londonMidnightUTC converts it to the correct instant).
  const from = londonMidnightUTC(parsed.data.from ?? toDateStr(londonDayUTC(90)));
  const to = londonMidnightUTC(parsed.data.to ?? toDateStr(londonDayUTC(-1))); // start of tomorrow (London) → today is included
  if (to.getTime() <= from.getTime()) {
    return jsonError(400, "to must be after from");
  }

  return NextResponse.json(await getAgencyBookings(orgId, { from, to }));
});
