import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  briefs,
  clients,
  db,
  organizations,
  shareTokens,
} from "@azen/db";

/**
 * Throwaway-org harness for the §P8-REPORT share tests. Every row hangs off a
 * fresh random org id and is torn down in afterAll — DEMO_ORG_ID is never
 * touched (ground rules). Seeds one client and one monthly client_value_report
 * brief so the public renderer has something to resolve.
 */
export interface ShareHarness {
  orgId: string;
  orgName: string;
  clientId: string;
  clientName: string;
  briefId: string;
}

export interface SeedReportOptions {
  revenueTouchedPence?: number;
  hoursSaved?: number;
  roiMultiple?: number | null;
  bookingsMade?: number;
  conversationsHandled?: number;
  resolvedRate?: number | null;
  headline?: string;
  bodyMd?: string;
  forMonth?: string;
}

export async function createShareHarness(
  opts: SeedReportOptions = {},
): Promise<ShareHarness> {
  const orgId = randomUUID();
  const clientId = randomUUID();
  const briefId = randomUUID();
  const orgName = `Share Agency ${orgId.slice(0, 8)}`;
  const clientName = `Bright Smiles ${orgId.slice(0, 8)}`;

  await db.insert(organizations).values({ id: orgId, name: orgName });
  await db.insert(clients).values({
    id: clientId,
    orgId,
    name: clientName,
    status: "active",
  });
  await db.insert(briefs).values({
    id: briefId,
    orgId,
    scope: "project",
    projectId: null,
    period: "monthly",
    periodStart: new Date("2026-06-01T00:00:00Z"),
    headline: opts.headline ?? "A strong month for Bright Smiles",
    bodyMd:
      opts.bodyMd ??
      "# A strong month\n\nYour assistant handled the busy season well.",
    dataSnapshot: {
      docType: "client_value_report",
      clientId,
      clientName,
      forMonth: opts.forMonth ?? "2026-06",
      client: {
        clientId,
        clientName,
        revenueTouchedPence: opts.revenueTouchedPence ?? 1_250_000,
        hoursSaved: opts.hoursSaved ?? 42.5,
        roiMultiple: opts.roiMultiple === undefined ? 6.4 : opts.roiMultiple,
        bookingsMade: opts.bookingsMade ?? 37,
        conversationsHandled: opts.conversationsHandled ?? 210,
        resolvedRate: opts.resolvedRate === undefined ? 0.82 : opts.resolvedRate,
      },
    },
  });

  return { orgId, orgName, clientId, clientName, briefId };
}

export async function cleanupShareHarness(h: ShareHarness): Promise<void> {
  await db.delete(shareTokens).where(eq(shareTokens.orgId, h.orgId));
  await db.delete(briefs).where(eq(briefs.orgId, h.orgId));
  await db.delete(clients).where(eq(clients.orgId, h.orgId));
  await db.delete(organizations).where(eq(organizations.id, h.orgId));
}
