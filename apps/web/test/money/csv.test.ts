import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, payments } from "@azen/db";
import { eq } from "drizzle-orm";
import {
  commitPaymentsImport,
  parsePaymentsCsv,
  previewPaymentsImport,
} from "../../lib/server/money";
import {
  cleanupMoneyHarness,
  createMoneyHarness,
  type MoneyHarness,
} from "./helpers";

describe("CSV import", () => {
  let h: MoneyHarness;

  beforeAll(async () => {
    h = await createMoneyHarness();
  });

  afterAll(async () => {
    await cleanupMoneyHarness(h);
  });

  it("pure parse flags a bad date and a bad amount as row errors", () => {
    const csv = [
      "date,amount,client,kind,ref",
      "2026-07-03,1200.50,Acme,retainer,INV-1",
      "not-a-date,50,Acme,retainer,INV-2",
      "2026-07-04,notanumber,Acme,retainer,INV-3",
    ].join("\n");
    const { rows } = parsePaymentsCsv(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.error).toBeUndefined();
    expect(rows[0]!.amountPence).toBe(120_050); // £1,200.50 → pence
    expect(rows[1]!.error).toMatch(/invalid date/);
    expect(rows[2]!.error).toMatch(/invalid amount/);
  });

  it("preview resolves clients and reports valid + error counts", async () => {
    const csv = [
      "date,amount,client,kind,ref",
      `2026-07-03,1000,${h.clientName},retainer,INV-10`,
      "2026-07-03,bad,Nobody Ltd,retainer,INV-11",
      "2026-07-03,500,Unknown Client,retainer,INV-12",
    ].join("\n");
    const preview = await previewPaymentsImport(h.orgId, csv);
    expect(preview.validCount).toBe(1);
    expect(preview.errorCount).toBe(2);
    expect(preview.totalPence).toBe(100_000);
    const valid = preview.rows.find((r) => r.valid);
    expect(valid?.clientId).toBe(h.clientId);
  });

  it("commit inserts only valid rows and reports the bad one", async () => {
    const csv = [
      "date,amount,client,kind,ref",
      `2026-06-05,250.00,${h.clientName},retainer,IMP-1`,
      "2026-06-05,10,Ghost Co,retainer,IMP-2",
    ].join("\n");
    const result = await commitPaymentsImport(h.orgId, csv);
    expect(result.committed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toMatch(/unknown client/);

    const rows = await db
      .select({ amountPence: payments.amountPence, ref: payments.invoiceRef, source: payments.source })
      .from(payments)
      .where(eq(payments.invoiceRef, "IMP-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountPence).toBe(25_000);
    expect(rows[0]!.source).toBe("bank_transfer");
  });
});
