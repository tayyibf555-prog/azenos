"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatPence, formatLondonDate } from "../../lib/format";
import { Pill, type SquircleTone } from "../system";
import {
  EXPENSE_CATEGORIES,
  type ExpenseRow,
  type ProjectOption,
} from "../money-types";

const CATEGORY_TONE: Record<string, SquircleTone> = {
  hosting: "sky",
  api: "lavender",
  tools: "graphite",
  contractor: "butter",
  other: "graphite",
};

/** Expenses list + add form (§Money screen). POSTs /api/money/expenses. */
export function ExpensesPanel({
  expenses,
  projects,
}: {
  expenses: ExpenseRow[];
  projects: ProjectOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("api");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [recurring, setRecurring] = useState(false);
  const [projectId, setProjectId] = useState("");

  async function submit() {
    setErr(null);
    const pounds = Number(amount.replace(/[£,\s]/g, ""));
    if (!vendor.trim()) return setErr("Vendor is required.");
    if (!Number.isFinite(pounds) || pounds <= 0) return setErr("Enter a valid amount.");
    setBusy(true);
    try {
      const res = await fetch("/api/money/expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category,
          vendor: vendor.trim(),
          amountPence: Math.round(pounds * 100),
          recurring,
          projectId: projectId || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setErr(`Couldn't save: ${j?.error ?? res.status}`);
        return;
      }
      setVendor("");
      setAmount("");
      setRecurring(false);
      setProjectId("");
      setOpen(false);
      router.refresh();
    } catch {
      setErr("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const total = expenses.reduce((a, e) => a + e.amountPence, 0);

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ fontSize: 14, fontWeight: 620 }}>
          Expenses{" "}
          <span className="faint tnum" style={{ fontWeight: 400 }}>
            · {formatPence(total)}
          </span>
        </h3>
        <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "+ Add expense"}
        </button>
      </div>

      {open && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
            gap: 8,
            marginBottom: 14,
            padding: 12,
            background: "var(--bg-well)",
            borderRadius: "var(--radius-tile)",
          }}
        >
          <label className="label">
            Category
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            Vendor
            <input className="input" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Anthropic" />
          </label>
          <label className="label">
            Amount (£)
            <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="42.00" inputMode="decimal" />
          </label>
          <label className="label">
            Project
            <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Agency (org-wide)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="label" style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "end" }}>
            <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
            Recurring
          </label>
          <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
          {err && (
            <div style={{ gridColumn: "1/-1", fontSize: 12.5, color: "var(--red)" }}>{err}</div>
          )}
        </div>
      )}

      {expenses.length === 0 ? (
        <div className="faint" style={{ fontSize: 13, padding: "8px 2px" }}>
          No expenses recorded for this month.
        </div>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Category</th>
                <th>Project</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.vendor}
                    {e.recurring && (
                      <span className="chip" style={{ marginLeft: 6 }}>
                        recurring
                      </span>
                    )}
                  </td>
                  <td>
                    <Pill tone={CATEGORY_TONE[e.category] ?? "graphite"}>{e.category}</Pill>
                  </td>
                  <td className="faint">{e.projectId ? "Project" : "Agency"}</td>
                  <td className="tnum" style={{ textAlign: "right" }}>{formatPence(e.amountPence)}</td>
                  <td className="faint">{formatLondonDate(e.incurredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
