import type { ReactNode } from "react";

/**
 * Numbers-first primitive #2: the dense tile grid every section's headline
 * numbers live in (APPLE-THEME.md §Numbers first — "10-16 per section is
 * good"). A plain responsive auto-fit grid; StatTile owns the tile chrome.
 */
export function StatGrid({
  children,
  minTileWidth = 150,
  gap = 12,
}: {
  children: ReactNode;
  minTileWidth?: number;
  gap?: number;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap,
        gridTemplateColumns: `repeat(auto-fit, minmax(${minTileWidth}px, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}
