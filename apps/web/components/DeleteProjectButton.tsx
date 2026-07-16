"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { Modal } from "./Modal";
import { ToastViewport, useToasts } from "./Toast";
import type { ApiError } from "./types";

/**
 * Owner-only destructive affordance for a project (Phase 7). A quiet ghost
 * trash button opens a glass confirm modal that spells out exactly what dies
 * (project-scoped records) and what is kept (the agency money ledger), and
 * arms the red confirm button ONLY once the owner has typed the project name
 * verbatim. On success it lands the owner back on /projects with a toast.
 *
 * Positioning is the caller's job — drop it inside a `position: relative`
 * container (e.g. the projects-list card wrapper) or a page header.
 */
export function DeleteProjectButton({
  projectId,
  projectName,
  className,
}: {
  projectId: string;
  projectName: string;
  className?: string;
}) {
  const router = useRouter();
  const { toasts, show } = useToasts();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = typed.trim() === projectName && !busy;

  function close() {
    if (busy) return;
    setOpen(false);
    setTyped("");
    setError(null);
  }

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as ApiError | null;
        setError(json?.error ?? `Failed (${res.status})`);
        setBusy(false);
        return;
      }
      show(`Project “${projectName}” deleted`, "success");
      setOpen(false);
      // Land on the projects list and re-fetch so the row is gone.
      router.push("/projects");
      router.refresh();
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`btn btn-ghost btn-sm${className ? ` ${className}` : ""}`}
        onClick={() => setOpen(true)}
        aria-label={`Delete project ${projectName}`}
        title="Delete project"
        style={{ width: 30, padding: 0, color: "var(--text-3)" }}
      >
        <TrashIcon />
      </button>

      <Modal open={open} onClose={close} title="Delete project" width={460}>
        <form onSubmit={onConfirm} style={{ display: "grid", gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>
            Permanently deletes{" "}
            <strong style={{ fontWeight: 620 }}>{projectName}</strong>&apos;s
            events, bookings, insights, briefs, keys and credentials. Agency
            money history is kept. This cannot be undone.
          </p>

          <div>
            <label
              className="label"
              htmlFor="del-confirm"
              style={{ display: "block", marginBottom: 6 }}
            >
              Type{" "}
              <span style={{ color: "var(--text)", fontWeight: 600 }}>
                {projectName}
              </span>{" "}
              to confirm
            </label>
            <input
              id="del-confirm"
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={projectName}
              autoComplete="off"
              autoFocus
              spellCheck={false}
            />
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
              onClick={close}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-danger btn-sm"
              disabled={!armed}
            >
              {busy ? "Deleting…" : "Delete project"}
            </button>
          </div>
        </form>
      </Modal>

      <ToastViewport toasts={toasts} />
    </>
  );
}

function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
