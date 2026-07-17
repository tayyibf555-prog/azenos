"use client";

import { useState } from "react";
import { StatCard } from "../../components/StatCard";
import { formatPence } from "../../lib/format";
import {
  type GrowthSummary,
  type PipelineItem,
  type ProposalItem,
  type ProposalStatus,
  type ProposalsResponse,
  type ApiErrorShape,
} from "../../components/growth-types";
import { TINTS } from "../../components/system/tokens";
import { PipelineBoard } from "./PipelineBoard";
import { ProposalsBoard } from "./ProposalsBoard";

/**
 * The Growth workspace (P6-GROWTH): the opportunity pipeline on the left, the
 * proposals board on the right, and a live summary of OS-attributed revenue on
 * top. Server-rendered initial data is held in state and kept live as the owner
 * reviews, converts, and moves proposals — so the funnel numbers never go stale.
 *
 * Converting an opportunity POSTs to /api/growth/proposals, which runs the Upsell
 * Engine; on success the insight leaves the pipeline and the new draft proposal
 * appears (proposals are re-fetched to pick up the model's document). A missing
 * ANTHROPIC_API_KEY surfaces as an inline notice, never a crash.
 */
export function GrowthWorkspace({
  initialPipeline,
  initialProposals,
  initialSummary,
}: {
  initialPipeline: PipelineItem[];
  initialProposals: ProposalItem[];
  initialSummary: GrowthSummary;
}) {
  const [pipeline, setPipeline] = useState<PipelineItem[]>(initialPipeline);
  const [proposals, setProposals] = useState<ProposalItem[]>(initialProposals);
  const [pipelineBusy, setPipelineBusy] = useState<Record<string, string | undefined>>({});
  const [proposalBusy, setProposalBusy] = useState<Record<string, boolean>>({});
  // proposalId → full share URL, populated right after a successful "Send"
  // this session (P8-GROWTH2) — never persisted, never re-fetched (the raw
  // token is only ever returned once, by the send call itself).
  const [sentLinks, setSentLinks] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  // The headline funnel comes from the server aggregate (getGrowthSummary — the
  // tested SQL path) on first paint. Once the owner mutates state (dismiss /
  // convert / move), we recompute the same figures from the live arrays so the
  // numbers stay current without a round-trip; both definitions agree exactly.
  const [dirty, setDirty] = useState(false);

  // ── live summary (derived from current state, matching getGrowthSummary) ─────
  const summary: GrowthSummary = dirty
    ? {
        wonRevenuePence: proposals
          .filter((p) => p.status === "won")
          .reduce((s, p) => s + (p.suggestedPricePence ?? 0), 0),
        wonCount: proposals.filter((p) => p.status === "won").length,
        openProposals: proposals.filter((p) =>
          ["draft", "ready", "sent"].includes(p.status),
        ).length,
        openOpportunities: pipeline.length,
      }
    : initialSummary;
  const { wonRevenuePence: wonRevenue, wonCount, openProposals } = summary;

  async function refreshProposals(): Promise<void> {
    try {
      const res = await fetch("/api/growth/proposals", { cache: "no-store" });
      const json = (await res.json()) as ProposalsResponse | ApiErrorShape;
      if (res.ok && !("error" in json)) setProposals(json.proposals);
    } catch {
      /* keep current state on a transient fetch error */
    }
  }

  // ── pipeline actions ────────────────────────────────────────────────────────

  async function reviewInsight(id: string): Promise<void> {
    if (pipelineBusy[id]) return;
    setPipelineBusy((b) => ({ ...b, [id]: "review" }));
    const prev = pipeline;
    setPipeline((list) =>
      list.map((it) => (it.id === id ? { ...it, status: "reviewed" } : it)),
    );
    try {
      const res = await fetch(`/api/insights/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "reviewed" }),
      });
      if (!res.ok) setPipeline(prev);
    } catch {
      setPipeline(prev);
    } finally {
      clearPipelineBusy(id);
    }
  }

  async function dismissInsight(id: string): Promise<void> {
    if (pipelineBusy[id]) return;
    setPipelineBusy((b) => ({ ...b, [id]: "dismiss" }));
    setDirty(true);
    const prev = pipeline;
    setPipeline((list) => list.filter((it) => it.id !== id));
    try {
      const res = await fetch(`/api/insights/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "dismissed" }),
      });
      if (!res.ok) setPipeline(prev);
    } catch {
      setPipeline(prev);
    } finally {
      clearPipelineBusy(id);
    }
  }

  async function convertInsight(id: string): Promise<void> {
    if (pipelineBusy[id]) return;
    setNotice(null);
    setDirty(true);
    setPipelineBusy((b) => ({ ...b, [id]: "convert" }));
    try {
      const res = await fetch("/api/growth/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ insightId: id }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as ApiErrorShape;
        setNotice(convertErrorMessage(json.error));
        return;
      }
      // The insight is now converted — it leaves the pipeline; pull the new draft.
      setPipeline((list) => list.filter((it) => it.id !== id));
      await refreshProposals();
    } catch {
      setNotice("Could not reach the Upsell Engine — try again.");
    } finally {
      clearPipelineBusy(id);
    }
  }

  function clearPipelineBusy(id: string): void {
    setPipelineBusy((b) => {
      const next = { ...b };
      delete next[id];
      return next;
    });
  }

  // ── proposal actions ────────────────────────────────────────────────────────

  async function moveProposal(id: string, status: ProposalStatus): Promise<void> {
    if (proposalBusy[id]) return;
    setProposalBusy((b) => ({ ...b, [id]: true }));
    setDirty(true);
    const prev = proposals;
    setProposals((list) =>
      list.map((p) => (p.id === id ? { ...p, status } : p)),
    );
    try {
      const res = await fetch(`/api/growth/proposals/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) setProposals(prev);
    } catch {
      setProposals(prev);
    } finally {
      setProposalBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  async function sendProposal(id: string): Promise<void> {
    if (proposalBusy[id]) return;
    setProposalBusy((b) => ({ ...b, [id]: true }));
    setDirty(true);
    const prev = proposals;
    setProposals((list) =>
      list.map((p) => (p.id === id ? { ...p, status: "sent" } : p)),
    );
    try {
      const res = await fetch(`/api/growth/proposals/${id}/send`, { method: "POST" });
      if (!res.ok) {
        setProposals(prev);
        return;
      }
      const json = (await res.json()) as { token: string };
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      setSentLinks((m) => ({ ...m, [id]: `${origin}/share/${json.token}` }));
      await refreshProposals();
    } catch {
      setProposals(prev);
    } finally {
      setProposalBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  /**
   * Re-display the share link for an already-'sent' proposal (P8-GROWTH2). The
   * raw token is returned only ONCE, by the send call, so if the owner closed /
   * reloaded before copying it, the link is recovered by decrypting the stored
   * ciphertext server-side — the authenticated, org-scoped GET /api/share
   * (at-rest ruling). The SAME token comes back (no re-mint), so its view
   * history is preserved. Keyed on the proposal's latest share token id.
   */
  async function resendProposal(id: string): Promise<void> {
    if (proposalBusy[id]) return;
    const tokenId = proposals.find((p) => p.id === id)?.shareTokenId ?? null;
    if (!tokenId) return;
    setProposalBusy((b) => ({ ...b, [id]: true }));
    try {
      const res = await fetch(`/api/share?tokenId=${tokenId}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { token: string };
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      setSentLinks((m) => ({ ...m, [id]: `${origin}/share/${json.token}` }));
    } catch {
      /* transient failure — the owner can retry Re-send */
    } finally {
      setProposalBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: 12,
        }}
      >
        <StatCard
          label="OS-attributed won revenue"
          value={<span className="accent-num tnum">{formatPence(wonRevenue)}</span>}
          sub={`${wonCount} won proposal${wonCount === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Proposals in flight"
          value={<span className="tnum">{openProposals}</span>}
          sub="draft · ready · sent"
        />
        <StatCard
          label="Open opportunities"
          value={<span className="tnum">{summary.openOpportunities}</span>}
          sub="awaiting review or convert"
        />
      </div>

      {notice && (
        <div
          role="status"
          style={{
            padding: "10px 14px",
            borderRadius: "var(--radius-tile)",
            fontSize: 12.5,
            color: TINTS.butter.fg,
            background: TINTS.butter.bg,
          }}
        >
          {notice}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.35fr)",
          gap: 20,
          alignItems: "start",
        }}
      >
        <PipelineBoard
          items={pipeline}
          busy={pipelineBusy}
          onReview={reviewInsight}
          onDismiss={dismissInsight}
          onConvert={convertInsight}
        />
        <ProposalsBoard
          items={proposals}
          busy={proposalBusy}
          onMove={moveProposal}
          onSend={sendProposal}
          onResend={resendProposal}
          sentLinks={sentLinks}
        />
      </div>
    </div>
  );
}

function convertErrorMessage(error: string | undefined): string {
  switch (error) {
    case "anthropic_auth":
      return "Converting to a proposal needs ANTHROPIC_API_KEY. Add it to draft the document.";
    case "budget_exceeded":
      return "The monthly agent budget is spent — converting is paused until it resets.";
    case "no_eligible_opportunity":
      return "This opportunity is no longer eligible to convert.";
    default:
      return "Could not draft the proposal — please try again.";
  }
}
