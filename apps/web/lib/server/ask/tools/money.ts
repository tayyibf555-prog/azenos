import { z } from "zod";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db, expenses, payments, subscriptions } from "@azen/db";
import { defineTool } from "./types";
import { dateRangeConds, timestampRangeConds } from "./shared";

/**
 * The agency money ledger (§4.5 / two-ledger rule §10 — client end-customer
 * payment.* events live in `events`, NEVER here). Pre-Phase-4 the payments/
 * expenses tables may be empty: every aggregate is coalesced to 0 and the tools
 * degrade to zeros gracefully rather than erroring.
 *
 * Note on "overdue": a true expected-vs-received retainer check is a Phase-4
 * feature (there is no due-date column yet). Until then `overduePence` reports
 * outstanding (status='pending') payments — the closest honest proxy — and a
 * note flags it.
 */

const LIMIT_CAP = 50;

const paymentStatuses = ["pending", "paid", "failed", "refunded"] as const;
const expenseCategories = [
  "hosting",
  "api",
  "tools",
  "contractor",
  "other",
] as const;
export const moneySummary = defineTool({
  name: "money_summary",
  description:
    "Agency money position (the agency's own ledger — money clients pay Azen, not the clients' end-customer revenue). Returns MRR (sum of active subscriptions, pence), payments broken down by status (paid/pending/failed/refunded sums, pence), outstanding/overdue total, and total expenses for the range. Optional from/to (YYYY-MM-DD) bound paid payments (by paid_at) and expenses (by incurred_at); MRR is point-in-time. Degrades to zeros when the ledger is empty.",
  inputSchema: z
    .object({
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
    })
    .strict(),
  run: async (orgId, input) => {
    const paidRange = timestampRangeConds(payments.paidAt, input.from, input.to);

    const sumFor = (status: (typeof paymentStatuses)[number], extra: SQL[]) =>
      db
        .select({
          total: sql<number>`coalesce(sum(${payments.amountPence}), 0)`.mapWith(
            Number,
          ),
          count: sql<number>`count(*)`.mapWith(Number),
        })
        .from(payments)
        .where(and(eq(payments.orgId, orgId), eq(payments.status, status), ...extra));

    const [mrrRow] = await db
      .select({
        mrrPence:
          sql<number>`coalesce(sum(${subscriptions.amountPenceMonthly}), 0)`.mapWith(
            Number,
          ),
        activeCount: sql<number>`count(*)`.mapWith(Number),
      })
      .from(subscriptions)
      .where(
        and(eq(subscriptions.orgId, orgId), eq(subscriptions.status, "active")),
      );

    // paid is bounded by the range; still-owed (pending/failed) are not date-bound.
    const [paid] = await sumFor("paid", paidRange);
    const [pending] = await sumFor("pending", []);
    const [failed] = await sumFor("failed", []);
    const [refunded] = await sumFor("refunded", []);

    const [expRow] = await db
      .select({
        total: sql<number>`coalesce(sum(${expenses.amountPence}), 0)`.mapWith(
          Number,
        ),
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.orgId, orgId),
          ...dateRangeConds(expenses.incurredAt, input.from, input.to),
        ),
      );

    const totalPaid = paid?.total ?? 0;
    const totalPending = pending?.total ?? 0;
    const totalExpenses = expRow?.total ?? 0;

    return {
      ok: true,
      data: {
        mrrPence: mrrRow?.mrrPence ?? 0,
        activeSubscriptions: mrrRow?.activeCount ?? 0,
        payments: {
          paidPence: totalPaid,
          pendingPence: totalPending,
          failedPence: failed?.total ?? 0,
          refundedPence: refunded?.total ?? 0,
          overduePence: totalPending,
          counts: {
            paid: paid?.count ?? 0,
            pending: pending?.count ?? 0,
            failed: failed?.count ?? 0,
            refunded: refunded?.count ?? 0,
          },
        },
        expensesPence: totalExpenses,
        expensesCount: expRow?.count ?? 0,
        note:
          "overduePence = outstanding pending payments; a due-date-aware retainer check arrives in Phase 4.",
      },
    };
  },
});

export const listPayments = defineTool({
  name: "list_payments",
  description:
    "List agency payments (money clients paid Azen), org-scoped, newest-first, capped at 50. Filter by status (pending/paid/failed/refunded), from/to (YYYY-MM-DD, on paid_at), and limit (<=50). Returns [] when the ledger is empty.",
  inputSchema: z
    .object({
      status: z.enum(paymentStatuses).optional(),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  run: async (orgId, input) => {
    const conds: SQL[] = [eq(payments.orgId, orgId)];
    if (input.status !== undefined) conds.push(eq(payments.status, input.status));
    conds.push(...timestampRangeConds(payments.paidAt, input.from, input.to));

    const limit = Math.min(input.limit ?? LIMIT_CAP, LIMIT_CAP);
    const rows = await db
      .select({
        id: payments.id,
        clientId: payments.clientId,
        projectId: payments.projectId,
        source: payments.source,
        kind: payments.kind,
        amountPence: payments.amountPence,
        currency: payments.currency,
        status: payments.status,
        invoiceRef: payments.invoiceRef,
        paidAt: payments.paidAt,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(and(...conds))
      // Postgres defaults DESC to NULLS FIRST, which would float pending/failed
      // rows (paid_at NULL) above real paid payments and, at the cap, push recent
      // paid rows off the end. NULLS LAST keeps "newest-first" honest; unpaid rows
      // then fall back to created_at order.
      .orderBy(sql`${payments.paidAt} desc nulls last`, desc(payments.createdAt))
      .limit(limit);

    return { ok: true, data: { payments: rows, count: rows.length } };
  },
});

export const listExpenses = defineTool({
  name: "list_expenses",
  description:
    "List agency expenses (hosting, API, tools, contractors, etc.), org-scoped, newest-first, capped at 50. Filter by category, from/to (YYYY-MM-DD, on incurred_at), and limit (<=50). Returns [] when there are none.",
  inputSchema: z
    .object({
      category: z.enum(expenseCategories).optional(),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  run: async (orgId, input) => {
    const conds: SQL[] = [eq(expenses.orgId, orgId)];
    if (input.category !== undefined)
      conds.push(eq(expenses.category, input.category));
    conds.push(...dateRangeConds(expenses.incurredAt, input.from, input.to));

    const limit = Math.min(input.limit ?? LIMIT_CAP, LIMIT_CAP);
    const rows = await db
      .select({
        id: expenses.id,
        projectId: expenses.projectId,
        category: expenses.category,
        vendor: expenses.vendor,
        amountPence: expenses.amountPence,
        recurring: expenses.recurring,
        period: expenses.period,
        incurredAt: expenses.incurredAt,
      })
      .from(expenses)
      .where(and(...conds))
      .orderBy(desc(expenses.incurredAt))
      .limit(limit);

    return { ok: true, data: { expenses: rows, count: rows.length } };
  },
});
