"use client";

import { Markdown } from "../Markdown";
import { AnswerTrace } from "./AnswerTrace";
import type { ChatMessage } from "./types";

/**
 * Renders a conversation: right-aligned user questions, left-aligned assistant
 * answers (markdown body + collapsible tool trace). Shows a live streaming
 * indicator while an answer is still arriving and a quiet inline error when a
 * turn fails. Layout-only; state lives in useAskChat.
 */

function StreamingDots() {
  return (
    <span
      aria-label="thinking"
      style={{ display: "inline-flex", gap: 4, alignItems: "center", height: 16 }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="dot"
          style={{
            width: 5,
            height: 5,
            background: "var(--text-3)",
            animation: "askBlink 1.1s ease-in-out infinite",
            animationDelay: `${i * 0.18}s`,
          }}
        />
      ))}
    </span>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <div
        style={{
          maxWidth: "82%",
          background: "var(--card-2)",
          border: "1px solid var(--border-2)",
          borderRadius: "12px 12px 3px 12px",
          padding: "9px 13px",
          fontSize: 13.5,
          lineHeight: 1.5,
          color: "var(--text)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text}
      </div>
    </div>
  );
}

function AssistantBubble({ msg }: { msg: ChatMessage }) {
  const empty = msg.content.trim() === "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: "92%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: 5,
            background: "linear-gradient(135deg, #7aa2f7, #bb9af7)",
            display: "grid",
            placeItems: "center",
            color: "#0b0e14",
            fontWeight: 800,
            fontSize: 10,
            flex: "none",
          }}
          aria-hidden
        >
          A
        </span>
        <span className="faint" style={{ fontSize: 11.5, fontWeight: 550 }}>
          Azen
        </span>
      </div>

      <div style={{ paddingLeft: 25 }}>
        {empty && msg.streaming && !msg.error ? (
          <StreamingDots />
        ) : (
          <Markdown source={msg.content} />
        )}

        {msg.streaming && !empty && (
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 7,
              height: 14,
              marginLeft: 2,
              verticalAlign: "text-bottom",
              background: "var(--accent)",
              animation: "askBlink 1s step-end infinite",
            }}
          />
        )}

        {msg.error && (
          <div
            role="alert"
            style={{
              marginTop: empty ? 0 : 8,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12.5,
              color: "var(--amber)",
              background: "rgba(217, 164, 65, 0.08)",
              border: "1px solid rgba(217, 164, 65, 0.22)",
              borderRadius: "var(--radius-sm)",
              padding: "8px 11px",
            }}
          >
            <span className="dot" style={{ width: 6, height: 6, background: "var(--amber)" }} aria-hidden />
            {msg.error}
          </div>
        )}

        <AnswerTrace trace={msg.trace} />
      </div>
    </div>
  );
}

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {messages.map((m) =>
        m.role === "user" ? (
          <UserBubble key={m.id} text={m.content} />
        ) : (
          <AssistantBubble key={m.id} msg={m} />
        ),
      )}
    </div>
  );
}
