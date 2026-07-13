"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { Modal } from "./Modal";
import { ToastViewport, useToasts } from "./Toast";
import { humanize } from "./ui";
import type { CreatedClient, ApiError } from "./types";

export function NewClientButton({ statuses }: { statuses: string[] }) {
  const router = useRouter();
  const { toasts, show } = useToasts();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [industrySlug, setIndustrySlug] = useState("");
  const [status, setStatus] = useState(statuses[0] ?? "lead");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setIndustrySlug("");
    setStatus(statuses[0] ?? "lead");
    setError(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { name: name.trim(), status };
    if (industrySlug.trim()) body.industrySlug = industrySlug.trim();
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { client: CreatedClient } | ApiError;
      if (!res.ok || "error" in json) {
        setError("error" in json ? json.error : `Failed (${res.status})`);
        return;
      }
      show(`Client “${json.client.name}” created`, "success");
      setOpen(false);
      reset();
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen(true)}
      >
        + New client
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New client"
        width={440}
      >
        <form onSubmit={onSubmit} style={{ display: "grid", gap: 14 }}>
          <div>
            <label className="label" htmlFor="nc-name">
              Name
            </label>
            <input
              id="nc-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Bright Smile Dental"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="nc-industry">
              Industry slug <span className="faint">(optional)</span>
            </label>
            <input
              id="nc-industry"
              className="input"
              value={industrySlug}
              onChange={(e) => setIndustrySlug(e.target.value)}
              placeholder="dental"
            />
          </div>
          <div>
            <label className="label" htmlFor="nc-status">
              Status
            </label>
            <select
              id="nc-status"
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p style={{ color: "var(--red)", fontSize: 13, margin: 0 }}>
              {error}
            </p>
          )}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!name.trim() || busy}
            >
              {busy ? "Creating…" : "Create client"}
            </button>
          </div>
        </form>
      </Modal>

      <ToastViewport toasts={toasts} />
    </>
  );
}
