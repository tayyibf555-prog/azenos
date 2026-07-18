"use client";

import { openAskPalette } from "../ask/paletteEvents";
import { SysIcon } from "./icons";

/**
 * §2 topbar right cluster — circular icon buttons (search opens the ⌘K palette;
 * notifications carry a deep-hue attention dot when relevant) + the Live/env
 * chip. Client because search wires into the palette. Presentational otherwise.
 */
export function TopbarActions({ notify = false }: { notify?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="sys-iconbtn"
        onClick={() => openAskPalette()}
        aria-label="Ask Azen (Cmd/Ctrl+K)"
      >
        <SysIcon name="search" size={16} strokeWidth={1.6} />
      </button>
      <button
        type="button"
        className="sys-iconbtn"
        aria-label="Notifications"
        style={{ position: "relative" }}
      >
        <SysIcon name="bell" size={16} strokeWidth={1.6} />
        {notify ? (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--red)",
            }}
          />
        ) : null}
      </button>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 28,
          padding: "0 11px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 560,
          color: "var(--text-2)",
          background: "var(--bg-well)",
          border: "none",
        }}
      >
        <span
          className="pulse"
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "var(--green)",
          }}
        />
        Live
      </span>
    </div>
  );
}
