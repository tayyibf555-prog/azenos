"use client";

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/** Standalone copy button with transient "Copied ✓" state (no bare alert). */
export function CopyButton({
  value,
  className = "btn btn-sm",
  idle = "Copy",
  style,
}: {
  value: string;
  className?: string;
  idle?: ReactNode;
  style?: CSSProperties;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (insecure context)
    }
  }
  return (
    <button type="button" className={className} onClick={copy} style={style}>
      {copied ? "Copied ✓" : idle}
    </button>
  );
}

/** A read-only value with a copy-to-clipboard button and transient "Copied ✓". */
export function CopyBlock({
  value,
  label,
  mono = true,
}: {
  value: string;
  label?: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (insecure context) — leave state untouched
    }
  }

  return (
    <div>
      {label && <div className="label">{label}</div>}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 8,
          minWidth: 0,
        }}
      >
        <code
          className={mono ? "mono" : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            padding: "0 11px",
            height: 36,
            fontSize: 12.5,
            color: "var(--text)",
            background: "var(--input)",
            border: "1px solid var(--border-2)",
            borderRadius: "var(--radius-sm)",
            overflowX: "auto",
            whiteSpace: "nowrap",
          }}
        >
          {value}
        </code>
        <button
          type="button"
          className="btn btn-sm"
          onClick={copy}
          style={{ flex: "none", width: 84 }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </div>
  );
}
