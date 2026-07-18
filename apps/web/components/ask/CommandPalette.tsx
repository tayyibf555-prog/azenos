"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useDictation } from "../../lib/useDictation";
import { TINTS } from "../system/tokens";
import { deriveAskContext } from "./context";
import { DictationMic } from "./DictationMic";
import { MessageList } from "./MessageList";
import { ASK_PALETTE_OPEN_EVENT } from "./paletteEvents";
import type { AskPaletteOpenDetail } from "./paletteEvents";
import { useAskChat } from "./useAskChat";

/**
 * Global command-K palette (mounted once in AppFrame). Cmd/Ctrl-K on any screen
 * opens a focus-trapped dialog that asks Azen with the current page's context
 * (project scope derived from the pathname) and streams the answer inline.
 * "Expand" hands the live session off to the full /ask screen; Escape closes.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const pathname = usePathname();
  const router = useRouter();
  const chat = useAskChat();

  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dictation = useDictation({
    getValue: useCallback(() => draftRef.current, []),
    setValue: setDraft,
  });

  // Global Cmd/Ctrl-K toggles the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Sidebar "Ask · ⌘K" affordance and push-to-talk open the palette the same
  // way the keybinding does — via this event, so there's exactly one open path.
  // Push-to-talk carries the dictated transcript in the event detail; drop it
  // straight into the input so the owner just reviews and hits Enter.
  useEffect(() => {
    const onOpenRequest = (e: Event) => {
      setOpen(true);
      const detail = (e as CustomEvent<AskPaletteOpenDetail | undefined>).detail;
      if (detail?.text) setDraft(detail.text);
    };
    window.addEventListener(ASK_PALETTE_OPEN_EVENT, onOpenRequest);
    return () => window.removeEventListener(ASK_PALETTE_OPEN_EVENT, onOpenRequest);
  }, []);

  // Focus management + body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(t);
      document.body.style.overflow = prevOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  // Keep the transcript pinned to the latest answer as it streams.
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [open, chat.messages]);

  const close = useCallback(() => setOpen(false), []);

  const submit = useCallback(() => {
    const text = draft.trim();
    // chat.send() is a no-op while a turn is in flight (busyRef guard); clearing
    // the draft unconditionally would silently discard the user's follow-up.
    if (text === "" || chat.busy) return;
    chat.send(text, deriveAskContext(pathname));
    setDraft("");
  }, [draft, chat, pathname]);

  const expand = useCallback(() => {
    const href = chat.sessionId ? `/ask?session=${encodeURIComponent(chat.sessionId)}` : "/ask";
    setOpen(false);
    router.push(href);
  }, [chat.sessionId, router]);

  // Dialog-scoped keys: Escape closes, Tab is trapped inside the panel.
  const onPanelKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const nodes = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  if (!open) return null;

  const ctx = deriveAskContext(pathname);
  const hasMessages = chat.messages.length > 0;

  return (
    <div
      className="ask-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className="ask-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Ask Azen"
        onKeyDown={onPanelKeyDown}
      >
        {/* Input row */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "13px 14px",
            borderBottom:
              hasMessages || chat.needsKey || dictation.error
                ? "1px solid var(--border)"
                : "none",
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-3)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            style={{ marginTop: 4, flex: "none" }}
          >
            <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-5A8 8 0 1 1 21 12Z" />
          </svg>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Ask Azen about your business…"
            aria-label="Ask Azen a question"
            style={{
              flex: 1,
              resize: "none",
              border: "none",
              background: "transparent",
              color: "var(--text)",
              fontFamily: "inherit",
              fontSize: 15,
              lineHeight: 1.5,
              padding: "3px 0",
              maxHeight: 120,
              outline: "none",
            }}
          />
          <DictationMic controller={dictation} />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={draft.trim() === "" || chat.busy}
            aria-label="Send"
          >
            {chat.busy ? "…" : "Ask"}
          </button>
        </div>

        {dictation.error && (
          <p
            className="faint"
            style={{ padding: "0 14px 8px", fontSize: 11.5, marginTop: -6 }}
          >
            {dictation.error}
          </p>
        )}

        {chat.needsKey && (
          <div
            style={{
              padding: "10px 14px",
              fontSize: 12.5,
              color: TINTS.butter.fg,
              background: TINTS.butter.bg,
            }}
          >
            Ask needs ANTHROPIC_API_KEY — set it in .env
          </div>
        )}

        {/* Transcript */}
        {hasMessages && (
          <div
            ref={scrollRef}
            style={{
              maxHeight: "48vh",
              overflowY: "auto",
              padding: "16px 16px 6px",
            }}
          >
            <MessageList messages={chat.messages} />
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "9px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--panel)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {ctx.project_id ? (
              <span className="chip" title="Scoped to the current project">
                Project context
              </span>
            ) : (
              <span className="faint" style={{ fontSize: 11.5 }}>
                Whole business
              </span>
            )}
            {hasMessages && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  chat.reset();
                  setDraft("");
                  inputRef.current?.focus();
                }}
                style={{ height: 22, padding: "0 7px", fontSize: 11.5 }}
              >
                New
              </button>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={expand}
              style={{ height: 24, padding: "0 8px", fontSize: 11.5 }}
            >
              Expand ↗
            </button>
            <span className="faint" style={{ fontSize: 11 }}>
              <span className="kbd">Esc</span> to close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
