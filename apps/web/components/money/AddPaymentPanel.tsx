"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { formatPence } from "../../lib/format";
import { COLORS } from "../ui";
import {
  PAYMENT_KINDS,
  type ClientOption,
  type ProjectOption,
} from "../money-types";

interface PreviewRow {
  index: number;
  raw: string[];
  valid: boolean;
  error?: string;
  amountPence?: number;
  clientName?: string;
  kind?: string;
}
interface PreviewResp {
  rows: PreviewRow[];
  validCount: number;
  errorCount: number;
  totalPence: number;
}

/** Bank-transfer entry + CSV import (§Money screen). */
export function AddPaymentPanel({
  clients,
  projects,
}: {
  clients: ClientOption[];
  projects: ProjectOption[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"manual" | "csv">("manual");

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        <button
          type="button"
          className={`tab ${tab === "manual" ? "tab-active" : ""}`}
          onClick={() => setTab("manual")}
        >
          Bank transfer
        </button>
        <button
          type="button"
          className={`tab ${tab === "csv" ? "tab-active" : ""}`}
          onClick={() => setTab("csv")}
        >
          CSV import
        </button>
      </div>
      {tab === "manual" ? (
        <ManualEntry clients={clients} projects={projects} onDone={() => router.refresh()} />
      ) : (
        <CsvImport onDone={() => router.refresh()} />
      )}
    </div>
  );
}

function ManualEntry({
  clients,
  projects,
  onDone,
}: {
  clients: ClientOption[];
  projects: ProjectOption[];
  onDone: () => void;
}) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [projectId, setProjectId] = useState("");
  const [kind, setKind] = useState<string>("retainer");
  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const clientProjects = useMemo(
    () => projects.filter((p) => p.clientId === clientId),
    [projects, clientId],
  );

  async function submit() {
    setMsg(null);
    const pounds = Number(amount.replace(/[£,\s]/g, ""));
    if (!clientId) return setMsg({ ok: false, text: "Pick a client." });
    if (!Number.isFinite(pounds) || pounds <= 0)
      return setMsg({ ok: false, text: "Enter a valid amount." });
    setBusy(true);
    try {
      const res = await fetch("/api/money/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId,
          projectId: projectId || undefined,
          kind,
          amountPence: Math.round(pounds * 100),
          paidAt: paidAt || undefined,
          invoiceRef: invoiceRef || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setMsg({ ok: false, text: `Couldn't save: ${j?.error ?? res.status}` });
        return;
      }
      setMsg({ ok: true, text: `Recorded ${formatPence(Math.round(pounds * 100))}.` });
      setAmount("");
      setInvoiceRef("");
      onDone();
    } catch {
      setMsg({ ok: false, text: "Couldn't reach the server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
      <label className="label">
        Client
        <select className="input" value={clientId} onChange={(e) => { setClientId(e.target.value); setProjectId(""); }}>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label className="label">
        Project (optional)
        <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">—</option>
          {clientProjects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <label className="label">
        Kind
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {PAYMENT_KINDS.map((k) => (
            <option key={k} value={k}>{k.replace("_", " ")}</option>
          ))}
        </select>
      </label>
      <label className="label">
        Amount (£)
        <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000.00" inputMode="decimal" />
      </label>
      <label className="label">
        Paid at (optional)
        <input className="input" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
      </label>
      <label className="label">
        Invoice ref (optional)
        <input className="input" value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} placeholder="AZ-2026-07" />
      </label>
      <div style={{ gridColumn: "1/-1", display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
          {busy ? "Saving…" : "Record payment"}
        </button>
        {msg && (
          <span style={{ fontSize: 12.5, color: msg.ok ? COLORS.green : "var(--red)" }}>{msg.text}</span>
        )}
      </div>
    </div>
  );
}

const SAMPLE_CSV = "date,amount,client,kind,ref\n2026-07-03,1000.00,Smile Dental,retainer,AZ-2026-07";

function CsvImport({ onDone }: { onDone: () => void }) {
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function doPreview() {
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/money/payments/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv, commit: false }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMsg({ ok: false, text: `Couldn't parse: ${j?.error ?? res.status}` });
        return;
      }
      setPreview(j as PreviewResp);
    } catch {
      setMsg({ ok: false, text: "Couldn't reach the server." });
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/money/payments/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv, commit: true }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMsg({ ok: false, text: `Import failed: ${j?.error ?? res.status}` });
        return;
      }
      setMsg({ ok: true, text: `Imported ${j.committed} payment(s), skipped ${j.skipped}.` });
      setPreview(null);
      setCsv("");
      onDone();
    } catch {
      setMsg({ ok: false, text: "Couldn't reach the server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p className="faint" style={{ fontSize: 12.5 }}>
        Paste bank rows as CSV — columns <span className="mono">date, amount, client, kind, ref</span>.
        Amounts are in pounds; clients are matched by name.
      </p>
      <textarea
        className="input"
        style={{ minHeight: 110, fontFamily: "var(--mono, monospace)", fontSize: 12.5 }}
        value={csv}
        onChange={(e) => { setCsv(e.target.value); setPreview(null); }}
        placeholder={SAMPLE_CSV}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" className="btn btn-sm" onClick={doPreview} disabled={busy || csv.trim().length === 0}>
          Preview
        </button>
        {preview && preview.validCount > 0 && (
          <button type="button" className="btn btn-primary btn-sm" onClick={doCommit} disabled={busy}>
            Commit {preview.validCount} valid row{preview.validCount === 1 ? "" : "s"} · {formatPence(preview.totalPence)}
          </button>
        )}
        {msg && (
          <span style={{ fontSize: 12.5, color: msg.ok ? COLORS.green : "var(--red)" }}>{msg.text}</span>
        )}
      </div>

      {preview && (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Client</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th>Kind</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.index}>
                  <td className="faint">{r.index}</td>
                  <td>{r.clientName ?? r.raw.join(" · ")}</td>
                  <td style={{ textAlign: "right" }}>
                    {r.amountPence !== undefined ? formatPence(r.amountPence) : "—"}
                  </td>
                  <td className="faint">{r.kind ?? "—"}</td>
                  <td>
                    {r.valid ? (
                      <span className="badge" style={{ color: COLORS.green }}>ok</span>
                    ) : (
                      <span className="badge" style={{ color: "var(--red)" }} title={r.error}>
                        {r.error ?? "error"}
                      </span>
                    )}
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
