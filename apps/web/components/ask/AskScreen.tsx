"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDictation } from "../../lib/useDictation";
import { ActivationBanner } from "../ActivationBanner";
import { COLORS, tint } from "../ui";
import { deriveAskContext } from "./context";
import { DictationMic } from "./DictationMic";
import { MessageList } from "./MessageList";
import type { SessionSummary } from "./types";
import { useAskChat } from "./useAskChat";

/**
 * The dedicated Ask Azen screen: a session-history sidebar (GET
 * /api/ask/sessions) beside the active streaming conversation. Deep-links via
 * `?session=<id>` (used by the palette's "expand") hydrate that session on load.
 * New turns stream markdown answers with a collapsible per-answer tool trace.
 */

const STARTERS = [
  "What's our MRR and how many active clients do we have?",
  "Which projects need attention right now?",
  "How did bookings trend over the last 30 days?",
  "Summarise the most recent daily brief.",
];

function parseSessions(json: unknown): SessionSummary[] {
  const container = (json ?? {}) as Record<string, unknown>;
  const list = Array.isArray(json)
    ? json
    : Array.isArray(container.sessions)
      ? (container.sessions as unknown[])
      : [];
  const out: SessionSummary[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : undefined;
    if (!id) continue;
    const title =
      typeof o.title === "string" && o.title.trim() !== "" ? o.title : null;
    const createdAt =
      typeof o.createdAt === "string"
        ? o.createdAt
        : typeof o.created_at === "string"
          ? o.created_at
          : null;
    out.push({ id, title, createdAt });
  }
  return out;
}

export function AskScreen({ hasAnthropicKey = true }: { hasAnthropicKey?: boolean }) {
  const chat = useAskChat();
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const [draft, setDraft] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dictation = useDictation({
    getValue: useCallback(() => draftRef.current, []),
    setValue: setDraft,
  });

  const querySession = search.get("session");

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/ask/sessions", { cache: "no-store" });
      if (!res.ok) return;
      setSessions(parseSessions(await res.json()));
    } catch {
      /* history is a convenience; a failed list must never break the chat */
    }
  }, []);

  // Load a deep-linked session once on mount / when the query id changes.
  const loadSession = chat.loadSession;
  useEffect(() => {
    if (querySession) void loadSession(querySession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySession]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // Refresh the sidebar when a turn settles (a new session may have been named).
  const busy = chat.busy;
  useEffect(() => {
    if (!busy) void refreshSessions();
  }, [busy, refreshSessions]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat.messages]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (text === "") return;
    chat.send(text, deriveAskContext(pathname));
    setDraft("");
  }, [draft, chat, pathname]);

  const openSession = useCallback(
    (id: string) => {
      void chat.loadSession(id);
      router.replace(`/ask?session=${encodeURIComponent(id)}`);
    },
    [chat, router],
  );

  const newChat = useCallback(() => {
    chat.reset();
    setDraft("");
    router.replace("/ask");
    composerRef.current?.focus();
  }, [chat, router]);

  const hasMessages = chat.messages.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100dvh - 116px)", minHeight: 440 }}>
      <ActivationBanner missing={hasAnthropicKey ? [] : ["ANTHROPIC_API_KEY"]} />
      <div style={{ display: "flex", gap: 20, flex: 1, minHeight: 0 }}>
        {/* History sidebar */}
        <aside
        style={{
          width: 244,
          flex: "none",
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid var(--border)",
          paddingRight: 16,
        }}
      >
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={newChat}
          style={{ width: "100%", marginBottom: 14 }}
        >
          + New question
        </button>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            padding: "0 4px 8px",
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 650,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--text-3)",
            }}
          >
            History
          </span>
          {sessions.length > 0 && (
            <span className="accent-num tnum" style={{ fontSize: 13, fontWeight: 680 }}>
              {sessions.length}
            </span>
          )}
        </div>
        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
          {sessions.length === 0 && (
            <p className="faint" style={{ fontSize: 12, padding: "4px" }}>
              No conversations yet.
            </p>
          )}
          {sessions.map((s) => {
            const active = s.id === chat.sessionId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => openSession(s.id)}
                className="truncate"
                style={{
                  textAlign: "left",
                  padding: "8px 9px",
                  borderRadius: "var(--radius-sm)",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12.5,
                  fontFamily: "inherit",
                  color: active ? "var(--text)" : "var(--text-2)",
                  background: active ? "var(--card-2)" : "transparent",
                }}
                title={s.title ?? "Untitled"}
              >
                {s.title ?? "Untitled question"}
              </button>
            );
          })}
        </div>
      </aside>

      {/* Conversation */}
      <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", paddingRight: 4 }}>
          {!hasMessages ? (
            <div style={{ maxWidth: 620, margin: "8vh auto 0", textAlign: "center" }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 11,
                  margin: "0 auto 16px",
                  background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--bg)",
                  fontWeight: 800,
                  fontSize: 18,
                }}
                aria-hidden
              >
                A
              </div>
              <h2 style={{ fontSize: 19 }}>Ask Azen</h2>
              <p className="muted" style={{ fontSize: 13.5, marginTop: 6 }}>
                Ask anything about your business — every answer is grounded in your live
                data, with the tools it used shown for each number.
              </p>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  justifyContent: "center",
                  marginTop: 20,
                }}
              >
                {STARTERS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="btn btn-sm"
                    onClick={() => chat.send(q, deriveAskContext(pathname))}
                    style={{ height: "auto", padding: "8px 12px", whiteSpace: "normal", textAlign: "left" }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ maxWidth: 760, margin: "0 auto", paddingBottom: 8 }}>
              <MessageList messages={chat.messages} />
            </div>
          )}
        </div>

        {chat.needsKey && (
          <div
            role="alert"
            style={{
              maxWidth: 760,
              margin: "12px auto 0",
              width: "100%",
              fontSize: 12.5,
              color: "var(--amber)",
              background: tint(COLORS.amber, 0.08),
              border: `1px solid ${tint(COLORS.amber, 0.22)}`,
              borderRadius: "var(--radius-sm)",
              padding: "9px 12px",
            }}
          >
            Ask needs ANTHROPIC_API_KEY — set it in .env
          </div>
        )}

        {/* Composer */}
        <div style={{ maxWidth: 760, margin: "14px auto 0", width: "100%" }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 10,
              background: "var(--input)",
              border: "1px solid var(--border-2)",
              borderRadius: "var(--radius)",
              padding: "8px 8px 8px 14px",
            }}
          >
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder="Ask a follow-up…"
              aria-label="Ask Azen a question"
              style={{
                flex: 1,
                resize: "none",
                border: "none",
                background: "transparent",
                color: "var(--text)",
                fontFamily: "inherit",
                fontSize: 14,
                lineHeight: 1.5,
                padding: "6px 0",
                maxHeight: 160,
                outline: "none",
              }}
            />
            <DictationMic controller={dictation} />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={submit}
              disabled={draft.trim() === "" || chat.busy}
            >
              {chat.busy ? "…" : "Send"}
            </button>
          </div>
          {dictation.error && (
            <p className="faint" style={{ fontSize: 11.5, marginTop: 6, textAlign: "center" }}>
              {dictation.error}
            </p>
          )}
          <p className="faint" style={{ fontSize: 11, marginTop: 6, textAlign: "center" }}>
            <span className="kbd">Enter</span> to send · <span className="kbd">Shift</span>+
            <span className="kbd">Enter</span> for a new line
          </p>
        </div>
      </section>
      </div>
    </div>
  );
}
