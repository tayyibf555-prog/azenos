"use client";

import { useCallback, useRef, useState } from "react";
import { COLORS } from "./ui";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

/** Tiny context-free toast queue. Returns `{ toasts, show }`. */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const show = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  return { toasts, show };
}

const KIND_COLOR: Record<ToastKind, string> = {
  success: COLORS.green,
  error: COLORS.red,
  info: COLORS.blue,
};

/** Fixed bottom-right stack. Render once, pass it the queue from useToasts. */
export function ToastViewport({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        zIndex: 200,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        maxWidth: "min(380px, calc(100vw - 40px))",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="card row-in"
          style={{
            padding: "11px 14px",
            fontSize: 13,
            borderLeft: `3px solid ${KIND_COLOR[t.kind]}`,
            background: "var(--card-2)",
            boxShadow: "0 12px 30px -10px rgba(0,0,0,0.55)",
          }}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
