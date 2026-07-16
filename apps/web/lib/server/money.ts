import {
  agentRuns,
  clients,
  db,
  expenseCategory,
  expenses,
  londonMonthStartUTC,
  paymentKind,
  payments,
  projects,
  subscriptions,
} from "@azen/db";
import { DEFAULT_COST_MARKUP_PCT } from "@azen/config";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getCostsByClient } from "./queries";

/**
 * Money screen + client cost-statement logic (docs/phase4/CONTRACTS.md,
 * P4-MONEY). Everything here reads the AGENCY ledger only — `payments`,
 * `subscriptions`, `expenses`. The two-ledger rule (§6.3/§10) is structural:
 * client END-CUSTOMER `payment.*` events live in `events`/rollups and are
 * never queried here, so agency revenue can never absorb them.
 *
 * Money is integer pence throughout. Month boundaries are Europe/London
 * calendar months resolved in Postgres (`at time zone 'Europe/London'`) — the
 * exact pattern the Phase 2 cost rollups use — so DST never shifts a bucket.
 * postgres-js returns numerics/bigints as strings, so every aggregate is
 * coerced with Number().
 */

// ── month helpers (mirror queries.ts; London-correct, DST-safe) ──────────────

/** YYYY-MM-DD of a Date's UTC calendar day (our London-day Dates are UTC midnight). */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Current Europe/London calendar month as 'YYYY-MM'. */
export function currentLondonMonth(): string {
  return toDateStr(londonMonthStartUTC(0)).slice(0, 7);
}

/** [start, end) London-month window as UTC instants. month = 'YYYY-MM'. */
function londonMonthBounds(month: string): { start: ReturnType<typeof sql>; end: ReturnType<typeof sql> } {
  const first = `${month}-01`;
  return {
    start: sql`(${first}::date)::timestamp at time zone 'Europe/London'`,
    end: sql`(${first}::date + interval '1 month')::timestamp at time zone 'Europe/London'`,
  };
}

/** The trailing `n` London months (oldest → newest) as 'YYYY-MM' labels. */
function trailingMonths(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(toDateStr(londonMonthStartUTC(i)).slice(0, 7));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Overview — MRR over time, cash in/out, retainer coverage, net
// ═══════════════════════════════════════════════════════════════════════════

export interface MonthPoint {
  month: string;
  pence: number;
}

export interface MoneyOverview {
  months: string[];
  mrrSeries: MonthPoint[];
  cashInSeries: MonthPoint[];
  cashOutSeries: MonthPoint[];
  netSeries: MonthPoint[];
  currentMrrPence: number;
  cashInThisMonthPence: number;
  cashOutThisMonthPence: number;
  netThisMonthPence: number;
  recurringExpensesMonthlyPence: number;
  /** MRR ÷ recurring monthly expenses; null when there are no recurring costs. */
  retainerCoverage: number | null;
}

/**
 * MRR is a stock (subs active as of a month end), so it is computed in JS from
 * the raw subscription rows; cash in/out are flows, aggregated in SQL grouped
 * by the London month. Months with no rows read 0.
 */
export async function getMoneyOverview(
  orgId: string,
  months = 6,
): Promise<MoneyOverview> {
  const labels = trailingMonths(Math.min(Math.max(months, 1), 24));
  const currentMonth = labels[labels.length - 1]!;

  const [subRows, cashInRows, cashOutRows, recurringRow] = await Promise.all([
    db
      .select({
        amountPenceMonthly: subscriptions.amountPenceMonthly,
        status: subscriptions.status,
        startedAt: subscriptions.startedAt,
        cancelledAt: subscriptions.cancelledAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.orgId, orgId)),
    db.execute(sql`
      select to_char(paid_at at time zone 'Europe/London', 'YYYY-MM') as month,
             coalesce(sum(amount_pence), 0) as pence
      from payments
      where org_id = ${orgId}::uuid and status = 'paid' and paid_at is not null
      group by 1
    `) as unknown as Promise<{ month: string; pence: unknown }[]>,
    db.execute(sql`
      select to_char(incurred_at::timestamp, 'YYYY-MM') as month,
             coalesce(sum(amount_pence), 0) as pence
      from expenses
      where org_id = ${orgId}::uuid
      group by 1
    `) as unknown as Promise<{ month: string; pence: unknown }[]>,
    db.execute(sql`
      select coalesce(sum(amount_pence), 0) as pence
      from expenses
      where org_id = ${orgId}::uuid and recurring = true and period = ${currentMonth}
    `) as unknown as Promise<{ pence: unknown }[]>,
  ]);

  const cashInByMonth = new Map(
    cashInRows.map((r) => [r.month, Math.round(Number(r.pence))] as const),
  );
  const cashOutByMonth = new Map(
    cashOutRows.map((r) => [r.month, Math.round(Number(r.pence))] as const),
  );

  // MRR active as of each month's END (exclusive next-month-first). The set
  // must agree with the hero currentMrrPence (Σ status='active') for the
  // current month, so status — not only dates — gates each point: an 'active'
  // sub counts from the month it started (it carries no cancelledAt); a
  // 'cancelled' sub counts only while it was still live at month end, its
  // cancellation date bounding it (a sub cancelled mid-current-month is already
  // off by this month's end, matching the hero); 'paused'/'past_due' subs are
  // not recurring revenue and never count. Date-only string compares are
  // DST-immune.
  const mrrForMonth = (month: string): number => {
    const endExclusive = toDateStr(
      new Date(
        Date.UTC(
          Number(month.slice(0, 4)),
          Number(month.slice(5, 7)), // 0-based next month
          1,
        ),
      ),
    );
    let sum = 0;
    for (const s of subRows) {
      if (s.status !== "active" && s.status !== "cancelled") continue;
      if (s.startedAt >= endExclusive) continue;
      if (s.cancelledAt !== null && s.cancelledAt < endExclusive) continue;
      sum += s.amountPenceMonthly;
    }
    return sum;
  };

  const mrrSeries = labels.map((month) => ({ month, pence: mrrForMonth(month) }));
  const cashInSeries = labels.map((month) => ({
    month,
    pence: cashInByMonth.get(month) ?? 0,
  }));
  const cashOutSeries = labels.map((month) => ({
    month,
    pence: cashOutByMonth.get(month) ?? 0,
  }));
  const netSeries = labels.map((month, i) => ({
    month,
    pence: cashInSeries[i]!.pence - cashOutSeries[i]!.pence,
  }));

  // Current MRR matches the Phase 1 overview definition exactly: Σ ACTIVE subs.
  const currentMrrPence = subRows
    .filter((s) => s.status === "active")
    .reduce((a, s) => a + s.amountPenceMonthly, 0);

  const recurringExpensesMonthlyPence = Math.round(
    Number(recurringRow[0]?.pence ?? 0),
  );
  const cashInThisMonthPence = cashInByMonth.get(currentMonth) ?? 0;
  const cashOutThisMonthPence = cashOutByMonth.get(currentMonth) ?? 0;

  return {
    months: labels,
    mrrSeries,
    cashInSeries,
    cashOutSeries,
    netSeries,
    currentMrrPence,
    cashInThisMonthPence,
    cashOutThisMonthPence,
    netThisMonthPence: cashInThisMonthPence - cashOutThisMonthPence,
    recurringExpensesMonthlyPence,
    retainerCoverage:
      recurringExpensesMonthlyPence > 0
        ? Math.round((currentMrrPence / recurringExpensesMonthlyPence) * 100) /
          100
        : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Revenue by client (+ LTV) — agency ledger only
// ═══════════════════════════════════════════════════════════════════════════

export interface ClientRevenue {
  clientId: string;
  clientName: string;
  status: string;
  /** Σ all paid agency payments (lifetime value). */
  ltvPence: number;
  /** Paid agency payments in the current London month. */
  paidThisMonthPence: number;
  /** Σ active-subscription MRR for this client. */
  activeMrrPence: number;
}

export async function getRevenueByClient(
  orgId: string,
): Promise<{ clients: ClientRevenue[] }> {
  const currentMonth = currentLondonMonth();
  const { start, end } = londonMonthBounds(currentMonth);

  const rows = (await db.execute(sql`
    select c.id as client_id, c.name as client_name, c.status as status,
      coalesce((select sum(p.amount_pence) from payments p
        where p.client_id = c.id and p.org_id = ${orgId}::uuid and p.status = 'paid'), 0) as ltv,
      coalesce((select sum(p.amount_pence) from payments p
        where p.client_id = c.id and p.org_id = ${orgId}::uuid and p.status = 'paid'
          and p.paid_at >= ${start} and p.paid_at < ${end}), 0) as this_month,
      coalesce((select sum(s.amount_pence_monthly) from subscriptions s
        where s.client_id = c.id and s.org_id = ${orgId}::uuid and s.status = 'active'), 0) as active_mrr
    from clients c
    where c.org_id = ${orgId}::uuid
    order by ltv desc, c.name asc
  `)) as unknown as {
    client_id: string;
    client_name: string;
    status: string;
    ltv: unknown;
    this_month: unknown;
    active_mrr: unknown;
  }[];

  return {
    clients: rows.map((r) => ({
      clientId: r.client_id,
      clientName: r.client_name,
      status: r.status,
      ltvPence: Math.round(Number(r.ltv)),
      paidThisMonthPence: Math.round(Number(r.this_month)),
      activeMrrPence: Math.round(Number(r.active_mrr)),
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Retainers — expected active-sub monthly vs received this month → overdue
// ═══════════════════════════════════════════════════════════════════════════

export interface RetainerRow {
  subscriptionId: string;
  clientId: string;
  clientName: string;
  projectId: string | null;
  projectName: string | null;
  expectedPence: number;
  receivedPence: number;
  shortfallPence: number;
  overdue: boolean;
}

export interface RetainersResult {
  month: string;
  rows: RetainerRow[];
  totals: {
    expectedPence: number;
    receivedPence: number;
    overdueCount: number;
    overduePence: number;
  };
}

export async function getRetainers(
  orgId: string,
  month?: string,
): Promise<RetainersResult> {
  const m = month ?? currentLondonMonth();
  const { start, end } = londonMonthBounds(m);

  // One active-subscription row per retainer we expect; received = paid
  // retainer payments this month for the same client, scoped to the SAME
  // project as the subscription (a project-less sub matches only project-less
  // payments — `is not distinct from` treats null=null — so a project-scoped
  // sub's payment is never double-counted against a project-less sub of the
  // same client). A retainer paid through the org Stripe account lands as
  // kind='other' when the invoice carries no azen_kind metadata (per the hooks
  // contract), so those Stripe payments count as retainer coverage too;
  // manual/bank 'other' entries do not. A missing/short payment flags overdue.
  const rows = (await db.execute(sql`
    select s.id as subscription_id, s.client_id, c.name as client_name,
      s.project_id, pr.name as project_name,
      s.amount_pence_monthly as expected,
      coalesce((select sum(p.amount_pence) from payments p
        where p.org_id = ${orgId}::uuid and p.status = 'paid'
          and (p.kind = 'retainer' or (p.source = 'stripe' and p.kind = 'other'))
          and p.client_id = s.client_id
          and p.project_id is not distinct from s.project_id
          and p.paid_at >= ${start} and p.paid_at < ${end}), 0) as received
    from subscriptions s
    join clients c on c.id = s.client_id
    left join projects pr on pr.id = s.project_id
    where s.org_id = ${orgId}::uuid and s.status = 'active'
    order by c.name asc, pr.name asc
  `)) as unknown as {
    subscription_id: string;
    client_id: string;
    client_name: string;
    project_id: string | null;
    project_name: string | null;
    expected: unknown;
    received: unknown;
  }[];

  const out: RetainerRow[] = rows.map((r) => {
    const expectedPence = Math.round(Number(r.expected));
    const receivedPence = Math.round(Number(r.received));
    const shortfallPence = Math.max(0, expectedPence - receivedPence);
    return {
      subscriptionId: r.subscription_id,
      clientId: r.client_id,
      clientName: r.client_name,
      projectId: r.project_id,
      projectName: r.project_name,
      expectedPence,
      receivedPence,
      shortfallPence,
      overdue: receivedPence < expectedPence,
    };
  });

  return {
    month: m,
    rows: out,
    totals: {
      expectedPence: out.reduce((a, r) => a + r.expectedPence, 0),
      receivedPence: out.reduce((a, r) => a + r.receivedPence, 0),
      overdueCount: out.filter((r) => r.overdue).length,
      overduePence: out.reduce((a, r) => a + r.shortfallPence, 0),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Manual bank-transfer payment entry
// ═══════════════════════════════════════════════════════════════════════════

export const bankPaymentSchema = z.object({
  clientId: z.uuid(),
  projectId: z.uuid().optional(),
  amountPence: z.number().int().positive(),
  kind: z.enum(paymentKind.enumValues),
  paidAt: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
  invoiceRef: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type BankPaymentInput = z.infer<typeof bankPaymentSchema>;

export type CreatePaymentResult =
  | { ok: true; payment: typeof payments.$inferSelect }
  | { ok: false; error: "client_not_found" | "project_not_found" };

export async function createBankPayment(
  orgId: string,
  input: BankPaymentInput,
): Promise<CreatePaymentResult> {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.orgId, orgId), eq(clients.id, input.clientId)))
    .limit(1);
  if (!client) return { ok: false, error: "client_not_found" };

  if (input.projectId) {
    const [proj] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, orgId),
          eq(projects.id, input.projectId),
          eq(projects.clientId, input.clientId),
        ),
      )
      .limit(1);
    if (!proj) return { ok: false, error: "project_not_found" };
  }

  const [row] = await db
    .insert(payments)
    .values({
      orgId,
      clientId: input.clientId,
      projectId: input.projectId ?? null,
      source: "bank_transfer",
      kind: input.kind,
      amountPence: input.amountPence,
      status: "paid",
      paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
      invoiceRef: input.invoiceRef ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  if (!row) throw new Error("payment insert returned no row");
  return { ok: true, payment: row };
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV import (bank-statement rows) — plain parse, NO dependency
// ═══════════════════════════════════════════════════════════════════════════

/** Split one CSV line into cells, honouring double-quoted fields. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

const CSV_FIELDS = ["date", "amount", "client", "kind", "ref"] as const;
type CsvField = (typeof CSV_FIELDS)[number];

/** Amount → pence. Accepts "£1,200.50", "1200.5", "1200". Must be positive. */
function parseAmountToPence(raw: string): number | null {
  const cleaned = raw.replace(/[£$,\s]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const pounds = Number(cleaned);
  if (!Number.isFinite(pounds) || pounds <= 0) return null;
  return Math.round(pounds * 100);
}

/** Date → ISO 'YYYY-MM-DD'. Accepts YYYY-MM-DD or DD/MM/YYYY (UK order). */
function parseDateToIso(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return Number.isNaN(Date.parse(`${s}T12:00:00Z`)) ? null : s;
  }
  const uk = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (uk) {
    const [, d, mo, y] = uk;
    const iso = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
    return Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) ? null : iso;
  }
  return null;
}

export interface ParsedCsvRow {
  index: number;
  raw: string[];
  paidAtIso?: string;
  amountPence?: number;
  clientName?: string;
  kind?: string;
  invoiceRef?: string;
  error?: string;
}

export interface CsvParseResult {
  rows: ParsedCsvRow[];
  /** Column order used (from a detected header, else the default order). */
  header: CsvField[];
}

/**
 * Pure parse (no DB): validates date/amount/kind and pulls the raw client
 * NAME. Client resolution to an id happens later (needs the org). A header row
 * (contains "date"/"amount"/"client") maps columns by name; otherwise the
 * default `date,amount,client,kind,ref` order is assumed.
 */
export function parsePaymentsCsv(text: string): CsvParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: [], header: [...CSV_FIELDS] };

  let header: CsvField[] = [...CSV_FIELDS];
  let startIdx = 0;
  const firstCells = parseCsvLine(lines[0]!).map((c) => c.toLowerCase());
  const looksLikeHeader =
    firstCells.includes("date") ||
    firstCells.includes("amount") ||
    firstCells.includes("client");
  if (looksLikeHeader) {
    header = firstCells.map((c) => {
      if (c.startsWith("date")) return "date";
      if (c.startsWith("amount") || c === "value") return "amount";
      if (c.startsWith("client") || c === "name") return "client";
      if (c.startsWith("kind") || c === "type") return "kind";
      if (c.startsWith("ref") || c === "invoice") return "ref";
      return c as CsvField;
    });
    startIdx = 1;
  }

  const col = (cells: string[], field: CsvField): string => {
    const i = header.indexOf(field);
    return i >= 0 ? (cells[i] ?? "") : "";
  };

  const rows: ParsedCsvRow[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]!);
    const rowNum = i - startIdx + 1;
    const row: ParsedCsvRow = { index: rowNum, raw: cells };

    const paidAtIso = parseDateToIso(col(cells, "date"));
    if (paidAtIso === null) {
      row.error = `row ${rowNum}: invalid date "${col(cells, "date")}"`;
      rows.push(row);
      continue;
    }
    const amountPence = parseAmountToPence(col(cells, "amount"));
    if (amountPence === null) {
      row.error = `row ${rowNum}: invalid amount "${col(cells, "amount")}"`;
      rows.push(row);
      continue;
    }
    const clientName = col(cells, "client");
    if (clientName === "") {
      row.error = `row ${rowNum}: missing client`;
      rows.push(row);
      continue;
    }
    const kindRaw = col(cells, "kind").toLowerCase();
    const kind = kindRaw === "" ? "other" : kindRaw;
    if (!(paymentKind.enumValues as readonly string[]).includes(kind)) {
      row.error = `row ${rowNum}: invalid kind "${kindRaw}"`;
      rows.push(row);
      continue;
    }

    row.paidAtIso = paidAtIso;
    row.amountPence = amountPence;
    row.clientName = clientName;
    row.kind = kind;
    row.invoiceRef = col(cells, "ref") || undefined;
    rows.push(row);
  }
  return { rows, header };
}

export interface ImportPreviewRow {
  index: number;
  raw: string[];
  valid: boolean;
  error?: string;
  paidAtIso?: string;
  amountPence?: number;
  clientId?: string;
  clientName?: string;
  kind?: string;
  invoiceRef?: string;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  validCount: number;
  errorCount: number;
  totalPence: number;
}

/** Resolve client NAMES (case-insensitive) to ids within the org. */
async function resolveClientNames(
  orgId: string,
  names: string[],
): Promise<Map<string, { id: string; name: string }>> {
  const map = new Map<string, { id: string; name: string }>();
  if (names.length === 0) return map;
  const rows = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.orgId, orgId));
  for (const r of rows) map.set(r.name.trim().toLowerCase(), r);
  return map;
}

export async function previewPaymentsImport(
  orgId: string,
  text: string,
): Promise<ImportPreview> {
  const { rows } = parsePaymentsCsv(text);
  const names = rows
    .filter((r) => r.clientName !== undefined)
    .map((r) => r.clientName!);
  const byName = await resolveClientNames(orgId, names);

  const preview: ImportPreviewRow[] = rows.map((r) => {
    if (r.error) {
      return { index: r.index, raw: r.raw, valid: false, error: r.error };
    }
    const match = byName.get(r.clientName!.trim().toLowerCase());
    if (!match) {
      return {
        index: r.index,
        raw: r.raw,
        valid: false,
        error: `row ${r.index}: unknown client "${r.clientName}"`,
      };
    }
    return {
      index: r.index,
      raw: r.raw,
      valid: true,
      paidAtIso: r.paidAtIso,
      amountPence: r.amountPence,
      clientId: match.id,
      clientName: match.name,
      kind: r.kind,
      invoiceRef: r.invoiceRef,
    };
  });

  const valid = preview.filter((r) => r.valid);
  return {
    rows: preview,
    validCount: valid.length,
    errorCount: preview.length - valid.length,
    totalPence: valid.reduce((a, r) => a + (r.amountPence ?? 0), 0),
  };
}

export interface ImportCommitResult {
  committed: number;
  skipped: number;
  errors: { index: number; error: string }[];
  totalPence: number;
}

export async function commitPaymentsImport(
  orgId: string,
  text: string,
): Promise<ImportCommitResult> {
  const preview = await previewPaymentsImport(orgId, text);
  const valid = preview.rows.filter((r) => r.valid);
  if (valid.length > 0) {
    await db.insert(payments).values(
      valid.map((r) => ({
        orgId,
        clientId: r.clientId!,
        source: "bank_transfer" as const,
        kind: r.kind as (typeof paymentKind.enumValues)[number],
        amountPence: r.amountPence!,
        status: "paid" as const,
        paidAt: new Date(`${r.paidAtIso}T12:00:00Z`),
        invoiceRef: r.invoiceRef ?? null,
        notes: "Imported from CSV",
      })),
    );
  }
  return {
    committed: valid.length,
    skipped: preview.errorCount,
    errors: preview.rows
      .filter((r) => !r.valid)
      .map((r) => ({ index: r.index, error: r.error ?? "invalid row" })),
    totalPence: preview.totalPence,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Expenses CRUD
// ═══════════════════════════════════════════════════════════════════════════

export const expenseCreateSchema = z.object({
  category: z.enum(expenseCategory.enumValues),
  vendor: z.string().trim().min(1).max(120),
  amountPence: z.number().int().positive(),
  recurring: z.boolean().optional(),
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  incurredAt: z.iso.date().optional(),
  projectId: z.uuid().optional(),
  notes: z.string().trim().max(500).optional(),
});
export type ExpenseCreateInput = z.infer<typeof expenseCreateSchema>;

export async function listExpenses(
  orgId: string,
  opts: { month?: string } = {},
) {
  const conds = [eq(expenses.orgId, orgId)];
  if (opts.month) conds.push(eq(expenses.period, opts.month));
  return db
    .select({
      id: expenses.id,
      projectId: expenses.projectId,
      category: expenses.category,
      vendor: expenses.vendor,
      amountPence: expenses.amountPence,
      recurring: expenses.recurring,
      period: expenses.period,
      notes: expenses.notes,
      incurredAt: expenses.incurredAt,
    })
    .from(expenses)
    .where(and(...conds))
    .orderBy(desc(expenses.incurredAt), asc(expenses.vendor));
}

export type CreateExpenseResult =
  | { ok: true; expense: typeof expenses.$inferSelect }
  | { ok: false; error: "project_not_found" };

export async function createExpense(
  orgId: string,
  input: ExpenseCreateInput,
): Promise<CreateExpenseResult> {
  if (input.projectId) {
    const [proj] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, input.projectId)))
      .limit(1);
    if (!proj) return { ok: false, error: "project_not_found" };
  }
  const incurredAt = input.incurredAt ?? toDateStr(londonMonthStartUTC(0));
  const [row] = await db
    .insert(expenses)
    .values({
      orgId,
      projectId: input.projectId ?? null,
      category: input.category,
      vendor: input.vendor,
      amountPence: input.amountPence,
      recurring: input.recurring ?? false,
      period: input.period ?? incurredAt.slice(0, 7),
      notes: input.notes ?? null,
      incurredAt,
    })
    .returning();
  if (!row) throw new Error("expense insert returned no row");
  return { ok: true, expense: row };
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-project margin — retainer − attributed API/hosting cost
// ═══════════════════════════════════════════════════════════════════════════

export interface ProjectMargin {
  projectId: string;
  name: string;
  clientName: string;
  retainerPence: number;
  aiCostPence: number;
  hostingCostPence: number;
  totalCostPence: number;
  marginPence: number;
}

export async function getProjectMargins(
  orgId: string,
  month?: string,
): Promise<{ month: string; rows: ProjectMargin[] }> {
  const m = month ?? currentLondonMonth();
  const costs = await getCostsByClient(orgId, m);
  const aiByProject = new Map<string, { ai: number; client: string }>();
  for (const c of costs.clients) {
    for (const p of c.projects) {
      aiByProject.set(p.projectId, {
        ai: p.totalPence,
        client: c.clientName,
      });
    }
  }

  const projRows = await db
    .select({
      id: projects.id,
      name: projects.name,
      retainer: projects.retainerPenceMonthly,
      clientName: clients.name,
    })
    .from(projects)
    .innerJoin(clients, eq(projects.clientId, clients.id))
    .where(eq(projects.orgId, orgId))
    .orderBy(asc(clients.name), asc(projects.name));

  const hostingRows = (await db.execute(sql`
    select project_id, coalesce(sum(amount_pence), 0) as pence
    from expenses
    where org_id = ${orgId}::uuid and project_id is not null and period = ${m}
    group by project_id
  `)) as unknown as { project_id: string; pence: unknown }[];
  const hostingByProject = new Map(
    hostingRows.map((r) => [r.project_id, Math.round(Number(r.pence))] as const),
  );

  const rows: ProjectMargin[] = projRows.map((p) => {
    const aiCostPence = aiByProject.get(p.id)?.ai ?? 0;
    const hostingCostPence = hostingByProject.get(p.id) ?? 0;
    const totalCostPence = aiCostPence + hostingCostPence;
    return {
      projectId: p.id,
      name: p.name,
      clientName: p.clientName,
      retainerPence: p.retainer,
      aiCostPence,
      hostingCostPence,
      totalCostPence,
      marginPence: p.retainer - totalCostPence,
    };
  });

  return { month: m, rows };
}

// ═══════════════════════════════════════════════════════════════════════════
// OS-ROI (§10) — the OS's own ROI: AI spend vs outcomes (placeholder outcomes)
// ═══════════════════════════════════════════════════════════════════════════

export interface OsRoi {
  month: string;
  aiSpendPence: number;
  runCount: number;
  byAgent: { agent: string; pence: number; runs: number }[];
  /** Placeholder outcome: retainer MRR the OS defends. Upsell value is Phase 6. */
  retainersUnderManagementPence: number;
  upsellsWonPence: number | null;
  note: string;
}

export async function getOsRoi(orgId: string, month?: string): Promise<OsRoi> {
  const m = month ?? currentLondonMonth();
  const { start, end } = londonMonthBounds(m);

  const [agentRows, mrrRow] = await Promise.all([
    db
      .select({
        agent: agentRuns.agent,
        pence: sql<number>`coalesce(sum(${agentRuns.costEstimatePence}), 0)`.mapWith(
          Number,
        ),
        runs: sql<number>`count(*)`.mapWith(Number),
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          sql`${agentRuns.startedAt} >= ${start}`,
          sql`${agentRuns.startedAt} < ${end}`,
        ),
      )
      .groupBy(agentRuns.agent),
    db
      .select({
        pence: sql<number>`coalesce(sum(${subscriptions.amountPenceMonthly}), 0)`.mapWith(
          Number,
        ),
      })
      .from(subscriptions)
      .where(
        and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "active")),
      ),
  ]);

  const byAgent = agentRows
    .map((r) => ({
      agent: r.agent,
      pence: Math.round(Number(r.pence)),
      runs: Number(r.runs),
    }))
    .sort((a, b) => b.pence - a.pence);
  const aiSpendPence = byAgent.reduce((a, r) => a + r.pence, 0);
  const runCount = byAgent.reduce((a, r) => a + r.runs, 0);

  return {
    month: m,
    aiSpendPence,
    runCount,
    byAgent,
    retainersUnderManagementPence: Math.round(Number(mrrRow[0]?.pence ?? 0)),
    upsellsWonPence: null,
    note: "Upsell attribution lands in Phase 6; outcome shown is retainer MRR under active management.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Client cost statements (owner invoicing) — cost × (1 + markup%) = billable
// ═══════════════════════════════════════════════════════════════════════════

export interface CostStatementProject {
  projectId: string;
  name: string;
  /** Billed base for the project = OS cost + (billed client-system AI). */
  costPence: number;
  billablePence: number;
  /** OS agent-run cost on this project. */
  osCostPence: number;
  /** client-system AI (tokens_cost_pence rollup) on this project — billed by
   *  default; display-only when include_client_emitted=false. */
  clientSystemAiPence: number;
  /** per-provider client-emitted spend (event spine) on this project — detail. */
  clientEmittedPence: number;
}

/** Per-provider line of a client's own (client-emitted) key spend. */
export interface CostStatementProviderLine {
  provider: string;
  label: string;
  pence: number;
}

export interface CostStatementClient {
  clientId: string;
  clientName: string;
  markupPct: number;
  /** Billed base = OS cost + (billed client-system AI). Marked up to billable. */
  costPence: number;
  markupPence: number;
  billablePence: number;
  projects: CostStatementProject[];
  // ── Billing v2 additive fields ────────────────────────────────────────────
  /** OS agent-run cost — one of the two billed streams. */
  osCostPence: number;
  /** OS stream billable (marked up); reconciles with clientSystemAiBillablePence
   *  to billablePence. */
  osBillablePence: number;
  /** client-system AI spend (tokens_cost_pence rollup) — the SECOND billed
   *  stream by default (LEAD RULING 2026-07-16); display-only when
   *  include_client_emitted=false (clients who bring their own keys). */
  clientSystemAiPence: number;
  /** client-system AI billable (marked up when billed; 0 when excluded). */
  clientSystemAiBillablePence: number;
  /** per-provider client-emitted spend (event spine) — provider detail lines. */
  clientEmittedPence: number;
  /** clientEmitted broken down by provider (anthropic/openai/twilio/…). */
  providers: CostStatementProviderLine[];
  /** true when the client-system AI stream is folded into billablePence. */
  clientEmittedBilled: boolean;
}

export interface CostStatements {
  month: string;
  defaultMarkupPct: number;
  clients: CostStatementClient[];
  totals: { costPence: number; markupPence: number; billablePence: number };
  // ── Billing v2 additive fields ──────────────────────────────────────────────
  /** whether client-emitted spend was folded into billable (query param). */
  includeClientEmitted: boolean;
  /** Σ client-emitted spend across all clients (display-only by default). */
  totalClientEmittedPence: number;
  /** org-wide client-emitted spend by provider. */
  providerTotals: CostStatementProviderLine[];
}

const PROVIDER_STATEMENT_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  twilio: "Twilio",
  higgsfield: "Higgsfield",
  other: "Other",
};
function statementProviderLabel(p: string): string {
  return PROVIDER_STATEMENT_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

/** billable = round(cost × (1 + pct/100)); pct 0 ⇒ billable == cost, exactly. */
function applyMarkup(costPence: number, pct: number): number {
  return Math.round(costPence * (1 + pct / 100));
}

/**
 * Split a client's billable total across its project costs so the per-project
 * lines sum EXACTLY to the client billable. Rounding each line independently
 * (round(cost × factor)) can overshoot the client total — e.g. two 10p projects
 * at 25% each round to 13p, summing to 26p under a 25p client billable — so a
 * copied invoice's line items would not add up to its stated Total. Largest-
 * remainder allocation floors every line then hands the leftover pence to the
 * lines with the biggest fractional parts (ties broken by order). pct 0 leaves
 * every line at cost (integer costs × 1 have no fractional remainder).
 */
function allocateBillable(costsPence: number[], pct: number, clientBillablePence: number): number[] {
  const factor = 1 + pct / 100;
  const floors = costsPence.map((c) => Math.floor(c * factor));
  let remainder = clientBillablePence - floors.reduce((a, b) => a + b, 0);
  const out = [...floors];
  const order = costsPence
    .map((c, i) => ({ i, frac: c * factor - floors[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i]! += 1;
    remainder -= 1;
  }
  return out;
}

interface EmittedProviderRow {
  client_id: string;
  project_id: string | null;
  provider: string;
  pence: number | string;
}

/**
 * Client cost statement (billing v2, docs/phase9/CONTRACTS.md — P9-COST).
 *
 * TWO cost streams, kept as SEPARATE labelled line items:
 *  - OS cost (agent_runs) → "OS agents".
 *  - client-system AI (tokens_cost_pence rollup) → "client-system AI".
 *
 * LEAD RULING 2026-07-16 (P9-COST A): both streams are billed WITH the client
 * markup by DEFAULT (includeClientEmitted defaults to TRUE), so the v2 default
 * reproduces the v1 statement total exactly (v1 marked up os+client-system AI
 * combined; there is no retroactive restatement). `costPence` is the combined
 * billed base and `billablePence` its markup; the streams reconcile to it via
 * `osBillablePence` + `clientSystemAiBillablePence`. `includeClientEmitted=false`
 * EXCLUDES the client-system AI stream from billing (display-only) for clients
 * who bring their own keys. The event-spine per-provider lines (`providers`,
 * `clientEmittedPence`) remain provider detail on that stream.
 *
 * Additive only — every v1 field keeps its shape and meaning.
 */
export async function getCostStatements(
  orgId: string,
  month?: string,
  opts?: { includeClientEmitted?: boolean },
): Promise<CostStatements> {
  const includeClientEmitted = opts?.includeClientEmitted !== false;
  const costs = await getCostsByClient(orgId, month);
  const { start, end } = londonMonthBounds(costs.month);

  const markupRows = await db
    .select({ id: clients.id, markup: clients.costMarkupPct })
    .from(clients)
    .where(eq(clients.orgId, orgId));
  const markupById = new Map(markupRows.map((r) => [r.id, r.markup] as const));

  // Client-emitted spend from the event spine, grouped by (client, project,
  // provider) — the authoritative source for the display-only block, so its
  // totals reconcile to SQL exactly. Missing/blank provider → 'other'.
  const emittedRows = (await db.execute(sql`
    select
      p.client_id as client_id,
      e.project_id as project_id,
      coalesce(nullif(lower(e.data->>'provider'), ''), 'other') as provider,
      coalesce(sum((e.data->>'cost_pence')::numeric), 0)::bigint as pence
    from events e
    join projects p on p.id = e.project_id and p.org_id = ${orgId}::uuid
    where e.org_id = ${orgId}::uuid
      and e.type = 'agent.run.completed'
      and (e.data ? 'cost_pence')
      and e.occurred_at >= ${start} and e.occurred_at < ${end}
    group by p.client_id, e.project_id, provider
  `)) as unknown as EmittedProviderRow[];

  const emittedByClientProvider = new Map<string, Map<string, number>>();
  const emittedByProject = new Map<string, number>();
  const providerTotalsMap = new Map<string, number>();
  for (const row of emittedRows) {
    const pence = Math.round(Number(row.pence)) || 0;
    if (pence === 0) continue;
    let cp = emittedByClientProvider.get(row.client_id);
    if (!cp) {
      cp = new Map();
      emittedByClientProvider.set(row.client_id, cp);
    }
    cp.set(row.provider, (cp.get(row.provider) ?? 0) + pence);
    if (row.project_id) {
      emittedByProject.set(
        row.project_id,
        (emittedByProject.get(row.project_id) ?? 0) + pence,
      );
    }
    providerTotalsMap.set(
      row.provider,
      (providerTotalsMap.get(row.provider) ?? 0) + pence,
    );
  }

  const outClients: CostStatementClient[] = costs.clients.map((c) => {
    const pct = markupById.get(c.clientId) ?? DEFAULT_COST_MARKUP_PCT;
    // Two billed streams: OS (agent_runs) + client-system AI (tokens_cost_pence
    // rollup). Both marked up by default (LEAD RULING 2026-07-16); the latter is
    // excluded from billing — display-only — when includeClientEmitted=false.
    const osCostPence = c.totals.osAgentPence;
    const clientSystemAiPence = c.totals.clientSystemAiPence;
    const billedCsai = includeClientEmitted ? clientSystemAiPence : 0;

    // v1-identical: mark up the COMBINED billed base so v2 default reproduces
    // the v1 statement total exactly, then split the two labelled line items so
    // they reconcile (largest-remainder).
    const costPence = osCostPence + billedCsai;
    const billablePence = applyMarkup(costPence, pct);
    const [osBillablePence, clientSystemAiBillablePence] = allocateBillable(
      [osCostPence, billedCsai],
      pct,
      billablePence,
    ) as [number, number];

    // event-spine provider detail lines (display) for this client.
    const cp = emittedByClientProvider.get(c.clientId);
    const providers: CostStatementProviderLine[] = cp
      ? [...cp.entries()]
          .map(([provider, pence]) => ({
            provider,
            label: statementProviderLabel(provider),
            pence,
          }))
          .sort((a, b) => b.pence - a.pence)
      : [];
    const clientEmittedPence = providers.reduce((a, p) => a + p.pence, 0);

    // Allocate the client billable across the projects' billed base (OS +
    // billed client-system AI) so the per-project lines reconcile exactly.
    const projBases = c.projects.map(
      (p) => p.osAgentPence + (includeClientEmitted ? p.clientSystemAiPence : 0),
    );
    const lineBillable = allocateBillable(projBases, pct, billablePence);
    const projects: CostStatementProject[] = c.projects.map((p, i) => ({
      projectId: p.projectId,
      name: p.name,
      costPence: projBases[i]!,
      billablePence: lineBillable[i]!,
      osCostPence: p.osAgentPence,
      clientSystemAiPence: p.clientSystemAiPence,
      clientEmittedPence: emittedByProject.get(p.projectId) ?? 0,
    }));

    return {
      clientId: c.clientId,
      clientName: c.clientName,
      markupPct: pct,
      costPence,
      markupPence: billablePence - costPence,
      billablePence,
      projects,
      osCostPence,
      osBillablePence,
      clientSystemAiPence,
      clientSystemAiBillablePence,
      clientEmittedPence,
      providers,
      clientEmittedBilled: includeClientEmitted && clientSystemAiPence > 0,
    };
  });

  const providerTotals: CostStatementProviderLine[] = [...providerTotalsMap.entries()]
    .map(([provider, pence]) => ({
      provider,
      label: statementProviderLabel(provider),
      pence,
    }))
    .sort((a, b) => b.pence - a.pence);

  return {
    month: costs.month,
    defaultMarkupPct: DEFAULT_COST_MARKUP_PCT,
    clients: outClients,
    totals: {
      costPence: outClients.reduce((a, c) => a + c.costPence, 0),
      markupPence: outClients.reduce((a, c) => a + c.markupPence, 0),
      billablePence: outClients.reduce((a, c) => a + c.billablePence, 0),
    },
    includeClientEmitted,
    totalClientEmittedPence: outClients.reduce(
      (a, c) => a + c.clientEmittedPence,
      0,
    ),
    providerTotals,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Margin per client (P9-COST) — (retainer + billable markup) − OS cost
// ═══════════════════════════════════════════════════════════════════════════

export interface ClientMarginPeriod {
  month: string;
  osCostPence: number;
  /** client-system AI cost (tokens_cost_pence rollup) — the second billed
   *  stream under the statement default. */
  clientSystemAiPence: number;
  /** billable markup spread over the billed streams (OS + client-system AI) =
   *  round(cost×(1+pct/100)) − cost. */
  markupPence: number;
  /** LEAD RULING 2026-07-16 (P9-COST B): retainer + markup spread. Reimbursed
   *  cost is NOT subtracted — the statement bills it back to the client. */
  marginPence: number;
}

export interface ClientMargin {
  clientId: string;
  clientName: string;
  status: string;
  /** active-subscription MRR — the retainer term of the margin. */
  retainerPence: number;
  markupPct: number;
  mtd: ClientMarginPeriod;
  prior: ClientMarginPeriod;
}

/**
 * Per-client margin (P9-COST): margin = (retainer + billable markup) − OS cost,
 * for the current London month-to-date and the prior full month. Reuses the
 * existing cost + markup + MRR queries — no new cost math. Deterministic in
 * (orgId, now).
 */
export async function getClientMargins(
  orgId: string,
): Promise<{ month: string; priorMonth: string; rows: ClientMargin[] }> {
  const [priorMonth, month] = trailingMonths(2) as [string, string];

  const [costsMtd, costsPrior, markupRows, mrrRows] = await Promise.all([
    getCostsByClient(orgId, month),
    getCostsByClient(orgId, priorMonth),
    db
      .select({ id: clients.id, name: clients.name, status: clients.status, markup: clients.costMarkupPct })
      .from(clients)
      .where(eq(clients.orgId, orgId)),
    db
      .select({
        clientId: subscriptions.clientId,
        pence: sql<number>`coalesce(sum(${subscriptions.amountPenceMonthly}), 0)`.mapWith(Number),
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "active")))
      .groupBy(subscriptions.clientId),
  ]);

  const osMtdByClient = new Map(costsMtd.clients.map((c) => [c.clientId, c.totals.osAgentPence] as const));
  const osPriorByClient = new Map(costsPrior.clients.map((c) => [c.clientId, c.totals.osAgentPence] as const));
  const csaiMtdByClient = new Map(costsMtd.clients.map((c) => [c.clientId, c.totals.clientSystemAiPence] as const));
  const csaiPriorByClient = new Map(costsPrior.clients.map((c) => [c.clientId, c.totals.clientSystemAiPence] as const));
  const mrrByClient = new Map(mrrRows.map((r) => [r.clientId, Math.round(Number(r.pence))] as const));

  // LEAD RULING 2026-07-16 (P9-COST B): margin = retainer + markup spread over
  // the streams billed under the statement default (OS + client-system AI). The
  // reimbursed cost is NOT subtracted — the statement bills it back.
  const period = (
    m: string,
    osCost: number,
    csaiCost: number,
    pct: number,
    retainer: number,
  ): ClientMarginPeriod => {
    const billedCost = osCost + csaiCost;
    const markupPence = applyMarkup(billedCost, pct) - billedCost;
    return {
      month: m,
      osCostPence: osCost,
      clientSystemAiPence: csaiCost,
      markupPence,
      marginPence: retainer + markupPence,
    };
  };

  const rows: ClientMargin[] = markupRows
    .map((c) => {
      const pct = c.markup ?? DEFAULT_COST_MARKUP_PCT;
      const retainer = mrrByClient.get(c.id) ?? 0;
      const osMtd = osMtdByClient.get(c.id) ?? 0;
      const osPrior = osPriorByClient.get(c.id) ?? 0;
      const csaiMtd = csaiMtdByClient.get(c.id) ?? 0;
      const csaiPrior = csaiPriorByClient.get(c.id) ?? 0;
      return {
        clientId: c.id,
        clientName: c.name,
        status: c.status,
        retainerPence: retainer,
        markupPct: pct,
        mtd: period(month, osMtd, csaiMtd, pct, retainer),
        prior: period(priorMonth, osPrior, csaiPrior, pct, retainer),
      };
    })
    .sort((a, b) => b.mtd.marginPence - a.mtd.marginPence);

  return { month, priorMonth, rows };
}

// ── client markup editor (PATCH /api/clients/[clientId]/markup) ──────────────

export const markupSchema = z.object({
  pct: z.number().int().min(0).max(1000),
});
export type MarkupInput = z.infer<typeof markupSchema>;

export async function setClientMarkup(
  orgId: string,
  clientId: string,
  pct: number,
): Promise<{ clientId: string; markupPct: number } | null> {
  const [row] = await db
    .update(clients)
    .set({ costMarkupPct: pct })
    .where(and(eq(clients.orgId, orgId), eq(clients.id, clientId)))
    .returning({ id: clients.id, markup: clients.costMarkupPct });
  if (!row) return null;
  return { clientId: row.id, markupPct: row.markup ?? pct };
}
