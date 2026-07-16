"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { COLORS, tint } from "../../components/ui";
import {
  formatPence,
  formatLondonDate,
  formatLondonTime,
  relativeTime,
} from "../../lib/format";
import {
  PROPOSAL_STATUSES,
  type ProposalItem,
  type ProposalStatus,
} from "../../components/growth-types";
import {
  buildWizardPrefillPayload,
  WIZARD_PREFILL_STORAGE_KEY,
} from "../../lib/growth/proposalPrefill";

const STATUS_COLOR: Record<string, string> = {
  draft: COLORS.grey,
  ready: COLORS.blue,
  sent: COLORS.violet,
  won: COLORS.green,
  lost: COLORS.red,
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  ready: "Ready",
  sent: "Sent",
  won: "Won",
  lost: "Lost",
};

/** The next forward status on the board, if any (draft→ready→sent→won). */
function nextStatus(status: string): ProposalStatus | null {
  const order: ProposalStatus[] = ["draft", "ready", "sent", "won"];
  const idx = order.indexOf(status as ProposalStatus);
  if (idx === -1 || idx === order.length - 1) return null;
  return order[idx + 1]!;
}

/** "Viewed 3x · last seen 2h ago" — or "Not viewed yet" once sent. */
function ViewedChip({ viewCount, lastViewedAt }: { viewCount: number; lastViewedAt: string | null }) {
  return (
    <span className="faint tnum" style={{ fontSize: 11 }}>
      {viewCount > 0
        ? `Viewed ${viewCount}× · last seen ${relativeTime(lastViewedAt!)}`
        : "Not viewed yet"}
    </span>
  );
}

/**
 * The proposals board (right): every upsell proposal as a kanban of the lifecycle
 * columns (draft → ready → sent → won → lost). Clicking a card opens the full,
 * client-ready proposal document (problem in the client's data, proposed build,
 * expected ROI, price) with the status controls and the cited evidence. "Send"
 * on a ready proposal mints a share link (P8-GROWTH2) and shows "viewed Nx ·
 * last seen"; "Create project" on a won proposal hands off to the onboarding
 * wizard prefilled from the proposal.
 */
export function ProposalsBoard({
  items,
  busy,
  onMove,
  onSend,
  onResend,
  sentLinks = {},
}: {
  items: ProposalItem[];
  busy: Record<string, boolean>;
  onMove: (id: string, status: ProposalStatus) => void;
  /** Send a 'ready' proposal (docs/phase8 §P8-GROWTH2): mints a share link, flips status → sent. */
  onSend: (id: string) => void;
  /** Re-display the link for an already-'sent' proposal whose one-time token was lost before copying (decrypts server-side; same token). */
  onResend: (id: string) => void;
  /** proposalId → full share URL, populated right after a successful send (this session only). */
  sentLinks?: Record<string, string>;
}) {
  const router = useRouter();

  function createProjectFromProposal(p: ProposalItem): void {
    try {
      window.sessionStorage.setItem(
        WIZARD_PREFILL_STORAGE_KEY,
        JSON.stringify(buildWizardPrefillPayload(p)),
      );
    } catch {
      /* sessionStorage unavailable (private mode) — wizard just starts blank */
    }
    router.push("/projects/new?fromProposal=1");
  }

  const [openId, setOpenId] = useState<string | null>(null);
  const open = items.find((p) => p.id === openId) ?? null;

  return (
    <section className="card" style={{ padding: 0 }}>
      <div
        style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 620 }}>
          Proposals{" "}
          <span className="faint tnum" style={{ fontWeight: 400 }}>
            · {items.length}
          </span>
        </h3>
      </div>

      {items.length === 0 ? (
        <div className="empty" style={{ padding: "34px 24px" }}>
          <span className="empty-title">No proposals yet</span>
          <span style={{ fontSize: 13 }}>
            Convert an opportunity on the left to draft a client-ready proposal.
          </span>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${PROPOSAL_STATUSES.length}, minmax(150px, 1fr))`,
            gap: 10,
            padding: 14,
            overflowX: "auto",
          }}
        >
          {PROPOSAL_STATUSES.map((status) => {
            const col = items.filter((p) => p.status === status);
            const tone = STATUS_COLOR[status]!;
            return (
              <div key={status} style={{ display: "grid", gap: 8, alignContent: "start" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 650,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--text-3)",
                  }}
                >
                  <span
                    className="dot"
                    style={{ width: 6, height: 6, background: tone }}
                    aria-hidden
                  />
                  {STATUS_LABEL[status]}
                  <span style={{ color: "var(--text-3)" }}>· {col.length}</span>
                </div>
                {col.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setOpenId(p.id)}
                    className="card"
                    style={{
                      textAlign: "left",
                      padding: "10px 12px",
                      display: "grid",
                      gap: 4,
                      cursor: "pointer",
                      borderColor: tint(tone, 0.3),
                    }}
                  >
                    <span style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.35 }}>
                      {p.title}
                    </span>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {p.clientName}
                    </span>
                    {p.suggestedPricePence !== null && (
                      <span
                        className="mono tnum"
                        style={{ fontSize: 11.5, color: COLORS.green }}
                      >
                        {formatPence(p.suggestedPricePence)}
                      </span>
                    )}
                    {p.status !== "draft" && p.status !== "ready" && (
                      <ViewedChip viewCount={p.viewCount} lastViewedAt={p.lastViewedAt} />
                    )}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <ProposalModal
          proposal={open}
          busy={Boolean(busy[open.id])}
          onMove={onMove}
          onSend={onSend}
          onResend={onResend}
          sentLink={sentLinks[open.id]}
          onCreateProject={() => createProjectFromProposal(open)}
          onClose={() => setOpenId(null)}
        />
      )}
    </section>
  );
}

function ProposalModal({
  proposal: p,
  busy,
  onMove,
  onSend,
  onResend,
  sentLink,
  onCreateProject,
  onClose,
}: {
  proposal: ProposalItem;
  busy: boolean;
  onMove: (id: string, status: ProposalStatus) => void;
  onSend: (id: string) => void;
  onResend: (id: string) => void;
  sentLink?: string;
  onCreateProject: () => void;
  onClose: () => void;
}) {
  const tone = STATUS_COLOR[p.status]!;
  const advance = nextStatus(p.status);
  // 'ready' → 'sent' isn't a plain status flip: it must mint the share link
  // first (P8-GROWTH2), so that one transition gets its own "Send" action.
  const advanceIsSend = advance === "sent";
  // The raw token isn't shown by any read, so a sent proposal may have a link
  // the owner lost before copying. Re-display it by decrypting the stored
  // ciphertext server-side (same token, view history intact) — offered whenever
  // there's a sent token and no link already in hand this session.
  const canRecoverLink =
    p.status === "sent" && !sentLink && p.shareTokenId !== null;
  const [copied, setCopied] = useState(false);

  async function copyLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the link is still visible to select manually */
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-strong"
        style={{
          width: "min(720px, 100%)",
          maxHeight: "86vh",
          overflowY: "auto",
          padding: 0,
        }}
      >
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            position: "sticky",
            top: 0,
            background: "var(--panel)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 660 }}>{p.title}</div>
            <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>
              {p.clientName}
              {p.projectName ? ` · ${p.projectName}` : ""} ·{" "}
              {formatLondonDate(p.createdAt)}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flex: "none" }}>
            <span
              className="badge"
              style={{
                color: tone,
                background: tint(tone, 0.12),
                borderColor: tint(tone, 0.28),
              }}
            >
              {STATUS_LABEL[p.status]}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div style={{ padding: "18px 20px", display: "grid", gap: 18 }}>
          {p.suggestedPricePence !== null && (
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
              }}
            >
              <span className="tnum" style={{ fontSize: 24, fontWeight: 680, color: COLORS.green }}>
                {formatPence(p.suggestedPricePence)}
              </span>
              <span className="faint" style={{ fontSize: 12 }}>
                suggested price
              </span>
            </div>
          )}

          {p.status !== "draft" && p.status !== "ready" && (
            <ViewedChip viewCount={p.viewCount} lastViewedAt={p.lastViewedAt} />
          )}

          {sentLink && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 12px",
                borderRadius: "var(--radius-sm)",
                background: tint(COLORS.violet, 0.08),
                border: `1px solid ${tint(COLORS.violet, 0.24)}`,
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 11.5,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {sentLink}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => copyLink(sentLink)}
              >
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            </div>
          )}

          <Block title="The problem — in your own data" body={p.problemMd} />
          <Block title="What we'd build & the return" body={p.proposalMd} />

          {p.expectedRoiNote && (
            <div
              style={{
                padding: "12px 14px",
                borderRadius: "var(--radius-sm)",
                background: tint(COLORS.green, 0.08),
                border: `1px solid ${tint(COLORS.green, 0.24)}`,
                fontSize: 13,
                color: "var(--text)",
              }}
            >
              <span style={{ fontWeight: 620 }}>Expected ROI · </span>
              {p.expectedRoiNote}
            </div>
          )}

          {p.evidenceEvents.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 650,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-3)",
                  marginBottom: 8,
                }}
              >
                Evidence · {p.evidenceEvents.length} event
                {p.evidenceEvents.length === 1 ? "" : "s"}
              </div>
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                {p.evidenceEvents.map((ev, i) => (
                  <div
                    key={ev.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "7px 12px",
                      borderTop: i === 0 ? "none" : "1px solid var(--border)",
                    }}
                  >
                    <span className="mono" style={{ fontSize: 11.5 }}>
                      {ev.type}
                    </span>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {formatLondonTime(ev.occurredAt)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            position: "sticky",
            bottom: 0,
            background: "var(--panel)",
          }}
        >
          {advance && advanceIsSend && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => onSend(p.id)}
              style={{
                color: "var(--bg)",
                background: STATUS_COLOR.sent,
                borderColor: STATUS_COLOR.sent,
              }}
            >
              Send to client
            </button>
          )}
          {advance && !advanceIsSend && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => onMove(p.id, advance)}
              style={{
                color: "var(--bg)",
                background: STATUS_COLOR[advance],
                borderColor: STATUS_COLOR[advance],
              }}
            >
              Move to {STATUS_LABEL[advance]}
            </button>
          )}
          {canRecoverLink && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => onResend(p.id)}
              title="Show the client link again — the raw link isn't kept after sending"
            >
              Show link
            </button>
          )}
          {p.status === "won" && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onCreateProject}
              style={{
                color: "var(--bg)",
                background: COLORS.blue,
                borderColor: COLORS.blue,
              }}
            >
              Create project →
            </button>
          )}
          {p.status !== "won" && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => onMove(p.id, "won")}
            >
              Mark won
            </button>
          )}
          {p.status !== "lost" && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => onMove(p.id, "lost")}
            >
              Mark lost
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Block({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 650,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-3)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <Markdown text={body} />
    </div>
  );
}

/**
 * Minimal, dependency-free Markdown renderer for proposal bodies. The Upsell
 * prompt emits Markdown (short paragraphs + a bullet list of what's included, with
 * `**bold**` emphasis), so rendering it as raw pre-wrap text would leak literal
 * `**` / `-` markers into the client-ready document. This covers the constructs the
 * prompt actually uses — paragraphs, `-`/`*` bullet lists, `1.` ordered lists, and
 * inline `**bold**` / `*italic*` / `` `code` `` — and falls back to line-preserved
 * text for anything else. No new dependency (contract: NO new deps).
 */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim().length > 0);
  if (blocks.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 10, color: "var(--text)" }}>
      {blocks.map((block, bi) => {
        const lines = block.split("\n");
        const isBullet = lines.every((l) => /^\s*[-*]\s+/.test(l));
        const isOrdered = lines.every((l) => /^\s*\d+\.\s+/.test(l));

        if (isBullet || isOrdered) {
          const items = lines.map((l, li) => (
            <li key={li} style={{ fontSize: 13.5, lineHeight: 1.55 }}>
              {renderInline(
                l.replace(isBullet ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/, ""),
                `${bi}-${li}`,
              )}
            </li>
          ));
          const listStyle = { margin: 0, paddingLeft: 20, display: "grid", gap: 4 } as const;
          return isBullet ? (
            <ul key={bi} style={listStyle}>
              {items}
            </ul>
          ) : (
            <ol key={bi} style={listStyle}>
              {items}
            </ol>
          );
        }

        return (
          <p key={bi} style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            {lines.map((l, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {renderInline(l, `${bi}-${li}`)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/** Render inline `**bold**`, `*italic*`, and `` `code` `` spans within one line. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let token: RegExpExecArray | null;
  let i = 0;
  while ((token = pattern.exec(text)) !== null) {
    if (token.index > last) nodes.push(text.slice(last, token.index));
    const raw = token[0];
    const key = `${keyPrefix}-${i}`;
    if (raw.startsWith("**")) {
      nodes.push(<strong key={key}>{raw.slice(2, -2)}</strong>);
    } else if (raw.startsWith("`")) {
      nodes.push(
        <code key={key} className="mono" style={{ fontSize: 12.5 }}>
          {raw.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<em key={key}>{raw.slice(1, -1)}</em>);
    }
    last = token.index + raw.length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
