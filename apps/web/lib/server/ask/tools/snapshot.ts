import { z } from "zod";
import {
  getOverview,
  getOverviewExtras,
  listClients,
  listProjects,
} from "../../queries";
import { defineTool } from "./types";

/**
 * get_business_snapshot — the cheap always-available first call. Composes the
 * dashboard's own overview/clients/projects reads (no duplicated SQL) into one
 * org-scoped summary: client roster, project roster + status/health, MRR, and
 * this-month client-end bookings. Names are capped so a large org can't return
 * an unbounded blob into the model context.
 */

const NAME_CAP = 100;

function tally<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export const getBusinessSnapshot = defineTool({
  name: "get_business_snapshot",
  description:
    "High-level snapshot of the whole business: client count + names + status, project count + status/health breakdown, monthly recurring revenue (MRR, in pence), open anomaly count, and the number of end-customer bookings the client systems made this month. Cheap and always available — call this first to orient before drilling in with the other tools.",
  inputSchema: z.object({}).strict(),
  run: async (orgId) => {
    const [overview, extras, clients, projects] = await Promise.all([
      getOverview(orgId),
      getOverviewExtras(orgId),
      listClients(orgId),
      listProjects(orgId),
    ]);

    return {
      ok: true,
      data: {
        mrrPence: overview.mrrPence,
        clientBookingsThisMonth: overview.clientBookingsThisMonth,
        eventsTotal: overview.eventsTotal,
        openAnomalies: extras.openAnomalies,
        clients: {
          count: clients.length,
          activeCount: overview.activeClients,
          list: clients.slice(0, NAME_CAP).map((c) => ({
            name: c.name,
            status: c.status,
            industrySlug: c.industrySlug,
            projectCount: c.projectCount,
          })),
        },
        projects: {
          count: projects.length,
          liveCount: overview.liveProjects,
          healthSummary: extras.healthSummary,
          byStatus: tally(projects.map((p) => p.status)),
          list: projects.slice(0, NAME_CAP).map((p) => ({
            name: p.name,
            slug: p.slug,
            status: p.status,
            health: p.health,
            type: p.type,
            client: p.client.name,
            retainerPenceMonthly: p.retainerPenceMonthly,
          })),
        },
      },
    };
  },
});
