"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";

/** Accessible modal: closes on Escape and backdrop click; locks body scroll. */
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(4, 6, 11, 0.6)",
        backdropFilter: "blur(2px)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className="card"
        style={{
          width,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 32px)",
          overflow: "auto",
          background: "var(--card)",
          boxShadow: "0 24px 60px -12px rgba(0,0,0,0.6)",
        }}
      >
        {title && (
          <header
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "16px 18px",
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
              aria-label="Close"
              style={{ width: 28, padding: 0, fontSize: 16, lineHeight: 1 }}
            >
              ×
            </button>
          </header>
        )}
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  );
}
