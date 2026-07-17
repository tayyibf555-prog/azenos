import { asc, eq } from "drizzle-orm";
import { clients as clientsTable, db, projects as projectsTable } from "@azen/db";
import { PageHeader } from "../../components/PageHeader";
import { StatCard } from "../../components/StatCard";
import { AddPaymentPanel } from "../../components/money/AddPaymentPanel";
import { CostStatementsPanel } from "../../components/money/CostStatementsPanel";
import { ExpensesPanel } from "../../components/money/ExpensesPanel";
import { MoneyCharts } from "../../components/money/MoneyCharts";
import { StatusPill } from "../../components/StatusPill";
import { Pill } from "../../components/system";
import type {
  ClientOption,
  ExpenseRow,
  ProjectOption,
} from "../../components/money-types";
import { formatPence } from "../../lib/format";
import {
  getClientMargins,
  getCostStatements,
  getMoneyOverview,
  getOsRoi,
  getProjectMargins,
  getRetainers,
  getRevenueByClient,
} from "../../lib/server/money";
import { listExpenses } from "../../lib/server/money";
import { requireOrgId } from "../../lib/server/org";

export const dynamic = "force-dynamic";

function Money({ pence, accent }: { pence: number; accent?: boolean }) {
  return (
    <span
      className="tnum"
      style={{ color: accent ? (pence < 0 ? "var(--red)" : "var(--green)") : undefined }}
    >
      {formatPence(pence)}
    </span>
  );
}

export default async function MoneyPage() {
  let dbError: string | null = null;
  let data: Awaited<ReturnType<typeof loadAll>> | null = null;
  try {
    const orgId = await requireOrgId();
    data = await loadAll(orgId);
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  return (
    <div>
      <PageHeader
        title="Money"
        subtitle="MRR, cash flow, retainers, expenses and client cost billing — the agency ledger."
      />

      {dbError || !data ? (
        <div className="card" style={{ padding: 20 }}>
          <strong style={{ color: "var(--red)" }}>Database not reachable.</strong>
          <pre className="codeblock" style={{ marginTop: 8 }}>{dbError}</pre>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Hero stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14 }}>
            <StatCard
              label="MRR"
              value={<span className="accent-num tnum">{formatPence(data.overview.currentMrrPence)}</span>}
              sub="active subscriptions"
            />
            <StatCard
              label="Cash in · this month"
              value={<span className="tnum">{formatPence(data.overview.cashInThisMonthPence)}</span>}
              accent="var(--green)"
            />
            <StatCard
              label="Cash out · this month"
              value={<span className="tnum">{formatPence(data.overview.cashOutThisMonthPence)}</span>}
              accent="var(--red)"
            />
            <StatCard
              label="Net · this month"
              value={<span className="tnum">{formatPence(data.overview.netThisMonthPence)}</span>}
              accent={data.overview.netThisMonthPence < 0 ? "var(--red)" : "var(--green)"}
            />
            <StatCard
              label="Retainer coverage"
              value={
                <span className="tnum">
                  {data.overview.retainerCoverage === null ? "—" : `${data.overview.retainerCoverage}×`}
                </span>
              }
              sub="MRR ÷ recurring costs"
            />
            <StatCard
              label="Overdue retainers"
              value={<span className="tnum">{data.retainers.totals.overdueCount}</span>}
              sub={data.retainers.totals.overduePence > 0 ? `${formatPence(data.retainers.totals.overduePence)} outstanding` : "all collected"}
              accent={data.retainers.totals.overdueCount > 0 ? "var(--amber)" : undefined}
            />
          </div>

          <MoneyCharts
            mrrSeries={data.overview.mrrSeries}
            cashInSeries={data.overview.cashInSeries}
            cashOutSeries={data.overview.cashOutSeries}
          />

          <AddPaymentPanel clients={data.clientOptions} projects={data.projectOptions} />

          {/* Revenue by client + retainers */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
            <div className="card" style={{ padding: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 620, marginBottom: 12 }}>Revenue by client</h3>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th style={{ textAlign: "right" }}>LTV</th>
                      <th style={{ textAlign: "right" }}>This month</th>
                      <th style={{ textAlign: "right" }}>MRR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byClient.clients.map((c) => (
                      <tr key={c.clientId}>
                        <td>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            {c.clientName}
                            <StatusPill status={c.status} />
                          </span>
                        </td>
                        <td className="tnum" style={{ textAlign: "right", fontWeight: 600 }}>{formatPence(c.ltvPence)}</td>
                        <td className="tnum" style={{ textAlign: "right" }}>{formatPence(c.paidThisMonthPence)}</td>
                        <td style={{ textAlign: "right" }} className="faint tnum">{formatPence(c.activeMrrPence)}</td>
                      </tr>
                    ))}
                    {data.byClient.clients.length === 0 && (
                      <tr><td colSpan={4} className="faint">No revenue recorded yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card" style={{ padding: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 620, marginBottom: 12 }}>
                Retainers · expected vs received
              </h3>
              <div className="scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Client / project</th>
                      <th style={{ textAlign: "right" }}>Expected</th>
                      <th style={{ textAlign: "right" }}>Received</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.retainers.rows.map((r) => (
                      <tr key={r.subscriptionId}>
                        <td>
                          {r.clientName}
                          {r.projectName && <span className="faint"> · {r.projectName}</span>}
                        </td>
                        <td className="tnum" style={{ textAlign: "right" }}>{formatPence(r.expectedPence)}</td>
                        <td className="tnum" style={{ textAlign: "right" }}>{formatPence(r.receivedPence)}</td>
                        <td style={{ textAlign: "right" }}>
                          {r.overdue ? (
                            <span title={`${formatPence(r.shortfallPence)} short`}>
                              <Pill tone="butter">overdue</Pill>
                            </span>
                          ) : (
                            <Pill tone="mint">paid</Pill>
                          )}
                        </td>
                      </tr>
                    ))}
                    {data.retainers.rows.length === 0 && (
                      <tr><td colSpan={4} className="faint">No active retainers.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Margin per client — retainer + billable markup (cost is billed back) */}
          <div className="card" style={{ padding: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 620, marginBottom: 4 }}>
              Margin per client{" "}
              <span className="faint" style={{ fontWeight: 400 }}>
                · retainer + billable markup (reimbursed cost billed back)
              </span>
            </h3>
            <p className="faint" style={{ fontSize: 12.5, marginBottom: 12 }}>
              MTD ({data.clientMargins.month}) vs prior month ({data.clientMargins.priorMonth}).
            </p>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th style={{ textAlign: "right" }}>Retainer</th>
                    <th style={{ textAlign: "right" }}>OS cost MTD</th>
                    <th style={{ textAlign: "right" }}>Markup MTD</th>
                    <th style={{ textAlign: "right" }}>Margin MTD</th>
                    <th style={{ textAlign: "right" }}>Margin prior</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clientMargins.rows.map((m) => (
                    <tr key={m.clientId}>
                      <td>{m.clientName}</td>
                      <td className="tnum" style={{ textAlign: "right" }}>{formatPence(m.retainerPence)}</td>
                      <td className="faint tnum" style={{ textAlign: "right" }}>{formatPence(m.mtd.osCostPence)}</td>
                      <td className="faint tnum" style={{ textAlign: "right" }}>{formatPence(m.mtd.markupPence)}</td>
                      <td style={{ textAlign: "right", fontWeight: 600 }}>
                        <Money pence={m.mtd.marginPence} accent />
                      </td>
                      <td className="tnum" style={{ textAlign: "right" }}>{formatPence(m.prior.marginPence)}</td>
                    </tr>
                  ))}
                  {data.clientMargins.rows.length === 0 && (
                    <tr><td colSpan={6} className="faint">No clients yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Per-project margin */}
          <div className="card" style={{ padding: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 620, marginBottom: 12 }}>
              Per-project margin{" "}
              <span className="faint" style={{ fontWeight: 400 }}>· retainer − attributed cost, {data.margins.month}</span>
            </h3>
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Client</th>
                    <th style={{ textAlign: "right" }}>Retainer</th>
                    <th style={{ textAlign: "right" }}>API cost</th>
                    <th style={{ textAlign: "right" }}>Hosting</th>
                    <th style={{ textAlign: "right" }}>Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {data.margins.rows.map((m) => (
                    <tr key={m.projectId}>
                      <td>{m.name}</td>
                      <td className="faint">{m.clientName}</td>
                      <td className="tnum" style={{ textAlign: "right" }}>{formatPence(m.retainerPence)}</td>
                      <td className="faint tnum" style={{ textAlign: "right" }}>{formatPence(m.aiCostPence)}</td>
                      <td className="faint tnum" style={{ textAlign: "right" }}>{formatPence(m.hostingCostPence)}</td>
                      <td style={{ textAlign: "right", fontWeight: 600 }}>
                        <Money pence={m.marginPence} accent />
                      </td>
                    </tr>
                  ))}
                  {data.margins.rows.length === 0 && (
                    <tr><td colSpan={6} className="faint">No projects.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <ExpensesPanel expenses={data.expenses} projects={data.projectOptions} />

          {/* OS-ROI */}
          <div className="card" style={{ padding: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 620, marginBottom: 4 }}>
              OS ROI{" "}
              <span className="faint" style={{ fontWeight: 400 }}>· the OS eats its own cooking</span>
            </h3>
            <p className="faint" style={{ fontSize: 12.5, marginBottom: 12 }}>{data.osRoi.note}</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
              <div>
                <div className="muted" style={{ fontSize: 12 }}>AI spend · this month</div>
                <div className="tnum" style={{ fontSize: 22, fontWeight: 640, marginTop: 4 }}>{formatPence(data.osRoi.aiSpendPence)}</div>
                <div className="faint" style={{ fontSize: 12 }}>{data.osRoi.runCount} agent run{data.osRoi.runCount === 1 ? "" : "s"}</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: 12 }}>Retainers under management</div>
                <div className="tnum" style={{ fontSize: 22, fontWeight: 640, marginTop: 4, color: "var(--green)" }}>
                  {formatPence(data.osRoi.retainersUnderManagementPence)}
                </div>
                <div className="faint" style={{ fontSize: 12 }}>outcome · placeholder (§10)</div>
              </div>
              {data.osRoi.byAgent.length > 0 && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Spend by agent</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {data.osRoi.byAgent.map((a) => (
                      <span key={a.agent} className="tnum">
                        <Pill tone="lavender">
                          {a.agent.replace(/_/g, " ")} · {formatPence(a.pence)}
                        </Pill>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <CostStatementsPanel initial={data.costStatements} />
        </div>
      )}
    </div>
  );
}

async function loadAll(orgId: string) {
  const [
    overview,
    byClient,
    retainers,
    margins,
    clientMargins,
    osRoi,
    costStatements,
    expenses,
    clientRows,
    projectRows,
  ] = await Promise.all([
    getMoneyOverview(orgId, 6),
    getRevenueByClient(orgId),
    getRetainers(orgId),
    getProjectMargins(orgId),
    getClientMargins(orgId),
    getOsRoi(orgId),
    getCostStatements(orgId),
    listExpenses(orgId, { month: undefined }),
    db
      .select({ id: clientsTable.id, name: clientsTable.name })
      .from(clientsTable)
      .where(eq(clientsTable.orgId, orgId))
      .orderBy(asc(clientsTable.name)),
    db
      .select({ id: projectsTable.id, name: projectsTable.name, clientId: projectsTable.clientId })
      .from(projectsTable)
      .where(eq(projectsTable.orgId, orgId))
      .orderBy(asc(projectsTable.name)),
  ]);

  const expenseRows: ExpenseRow[] = expenses.map((e) => ({
    ...e,
    incurredAt: String(e.incurredAt),
  }));
  const clientOptions: ClientOption[] = clientRows;
  const projectOptions: ProjectOption[] = projectRows;

  return {
    overview,
    byClient,
    retainers,
    margins,
    clientMargins,
    osRoi,
    costStatements,
    expenses: expenseRows,
    clientOptions,
    projectOptions,
  };
}
