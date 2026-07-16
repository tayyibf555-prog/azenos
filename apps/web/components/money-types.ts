/**
 * JSON shapes for the Money screen client components (P4-MONEY). Mirrors the
 * return types in apps/web/lib/server/money.ts. Pure types — no runtime code,
 * safe in client bundles.
 */

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
  retainerCoverage: number | null;
}

export interface ClientRevenue {
  clientId: string;
  clientName: string;
  status: string;
  ltvPence: number;
  paidThisMonthPence: number;
  activeMrrPence: number;
}

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

export interface OsRoi {
  month: string;
  aiSpendPence: number;
  runCount: number;
  byAgent: { agent: string; pence: number; runs: number }[];
  retainersUnderManagementPence: number;
  upsellsWonPence: number | null;
  note: string;
}

export interface CostStatementProject {
  projectId: string;
  name: string;
  costPence: number;
  billablePence: number;
  osCostPence: number;
  clientSystemAiPence: number;
  clientEmittedPence: number;
}

export interface CostStatementProviderLine {
  provider: string;
  label: string;
  pence: number;
}

export interface CostStatementClient {
  clientId: string;
  clientName: string;
  markupPct: number;
  costPence: number;
  markupPence: number;
  billablePence: number;
  projects: CostStatementProject[];
  osCostPence: number;
  osBillablePence: number;
  clientSystemAiPence: number;
  clientSystemAiBillablePence: number;
  clientEmittedPence: number;
  providers: CostStatementProviderLine[];
  clientEmittedBilled: boolean;
}

export interface CostStatements {
  month: string;
  defaultMarkupPct: number;
  clients: CostStatementClient[];
  totals: { costPence: number; markupPence: number; billablePence: number };
  includeClientEmitted: boolean;
  totalClientEmittedPence: number;
  providerTotals: CostStatementProviderLine[];
}

export interface ExpenseRow {
  id: string;
  projectId: string | null;
  category: string;
  vendor: string;
  amountPence: number;
  recurring: boolean;
  period: string | null;
  notes: string | null;
  incurredAt: string;
}

export interface ClientOption {
  id: string;
  name: string;
}

export interface ProjectOption {
  id: string;
  name: string;
  clientId: string;
}

export const PAYMENT_KINDS = [
  "build_fee",
  "retainer",
  "deposit",
  "other",
] as const;

export const EXPENSE_CATEGORIES = [
  "hosting",
  "api",
  "tools",
  "contractor",
  "other",
] as const;
