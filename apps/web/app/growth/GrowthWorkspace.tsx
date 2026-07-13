"use client";

import { useState } from "react";
import { StatCard } from "../../components/StatCard";
import { COLORS } from "../../components/ui";
import { formatPence } from "../../lib/format";
import {
  type GrowthSummary,
  type PipelineItem,
  type ProposalItem,
  type ProposalStatus,
  type ProposalsResponse,
  type ApiErrorShape,
} from "../../components/growth-types";
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
          value={formatPence(wonRevenue)}
          sub={`${wonCount} won proposal${wonCount === 1 ? "" : "s"}`}
          accent={COLORS.green}
        />
        <StatCard label="Proposals in flight" value={openProposals} sub="draft · ready · sent" />
        <StatCard
          label="Open opportunities"
          value={summary.openOpportunities}
          sub="awaiting review or convert"
        />
      </div>

      {notice && (
        <div
          role="status"
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 12.5,
            color: "#d9a441",
            background: "rgba(217, 164, 65, 0.08)",
            border: "1px solid rgba(217, 164, 65, 0.24)",
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
        <ProposalsBoard items={proposals} busy={proposalBusy} onMove={moveProposal} />
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
