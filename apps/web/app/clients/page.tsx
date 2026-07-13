import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { clientStatus, clients, db, industries } from "@azen/db";
import { NewClientButton } from "../../components/NewClientButton";
import { PageHeader } from "../../components/PageHeader";
import { StatusPill } from "../../components/StatusPill";
import { formatLondonDate, formatPence } from "../../lib/format";
import { requireOrgId } from "../../lib/server/org";
import { getCostsByClient } from "../../lib/server/queries";

export const dynamic = "force-dynamic";

/** Current month as "YYYY-MM" in Europe/London (matches the /api/costs contract). */
function currentLondonMonth(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${y}-${m}`;
}

interface Row {
  id: string;
  name: string;
  status: string;
  industrySlug: string | null;
  projectCount: number;
  createdAt: Date;
}

async function loadClients(orgId: string): Promise<Row[]> {
  return db
    .select({
      id: clients.id,
      name: clients.name,
      status: clients.status,
      industrySlug: industries.slug,
      createdAt: clients.createdAt,
      projectCount: sql<number>`(select count(*) from projects p where p.client_id = ${clients.id})`.mapWith(
        Number,
      ),
    })
    .from(clients)
    .leftJoin(industries, eq(clients.industryId, industries.id))
    .where(eq(clients.orgId, orgId))
    .orderBy(desc(clients.createdAt));
}

export default async function ClientsPage() {
  let rows: Row[] = [];
  let dbError: string | null = null;
  // Month-to-date API cost per client (ADDENDUM §B — billing groundwork).
  const costByClient = new Map<string, number>();
  try {
    const orgId = await requireOrgId();
    rows = await loadClients(orgId);
    try {
      const costs = await getCostsByClient(orgId, currentLondonMonth());
      for (const c of costs.clients) {
        costByClient.set(c.clientId, c.totals.totalPence);
      }
    } catch {
      // Costs degrade to £0 without breaking the clients list.
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle="Everyone the agency builds systems for."
        actions={<NewClientButton statuses={[...clientStatus.enumValues]} />}
      />

      {dbError ? (
        <div className="card empty">
          <span className="empty-title">Couldn&apos;t load clients</span>
          <span className="faint" style={{ fontSize: 12 }}>
            {dbError}
          </span>
        </div>
      ) : rows.length === 0 ? (
        <div className="card empty">
          <span className="empty-title">No clients yet</span>
          <span style={{ fontSize: 13 }}>
            Add your first client, then spin up a project for them.
          </span>
        </div>
      ) : (
        <div className="card scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Industry</th>
                <th style={{ textAlign: "right" }}>Projects</th>
                <th style={{ textAlign: "right" }}>API cost (MTD)</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 550 }}>
                    <Link href={`/clients/${c.id}`}>{c.name}</Link>
                  </td>
                  <td>
                    <StatusPill status={c.status} />
                  </td>
                  <td className="muted">
                    {c.industrySlug ? (
                      <span className="mono" style={{ fontSize: 12 }}>
                        {c.industrySlug}
                      </span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>{c.projectCount}</td>
                  <td
                    style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                    title="Month-to-date API cost (client-system AI + OS agents)"
                  >
                    {costByClient.get(c.id) ? (
                      formatPence(costByClient.get(c.id))
                    ) : (
                      <span className="faint">{formatPence(0)}</span>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 12.5 }}>
                    {formatLondonDate(c.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
