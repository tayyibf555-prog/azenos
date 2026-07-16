import type { ReactNode } from "react";

/**
 * Thin 1.5px-stroke icon set for §3 tinted squircles and the §2 topbar. 24-unit
 * viewBox, `currentColor` stroke — the squircle sets the colour. Pure/SSR-safe.
 */
export type IconName =
  | "grid"
  | "users"
  | "box"
  | "calendar"
  | "pound"
  | "activity"
  | "doc"
  | "spark"
  | "trending"
  | "book"
  | "layers"
  | "phone"
  | "bulb"
  | "alert"
  | "clock"
  | "check"
  | "bell"
  | "search"
  | "chevron"
  | "inbox"
  | "flag";

const PATHS: Record<IconName, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.4" />
      <rect x="14" y="3" width="7" height="5" rx="1.4" />
      <rect x="14" y="12" width="7" height="9" rx="1.4" />
      <rect x="3" y="16" width="7" height="5" rx="1.4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.6a3 3 0 0 1 0 5.6" />
      <path d="M20.5 20a5.5 5.5 0 0 0-4-5.3" />
    </>
  ),
  box: (
    <>
      <path d="M21 8 12 3 3 8l9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v3M16 3v3" />
    </>
  ),
  pound: (
    <>
      <path d="M17 6.5A4 4 0 0 0 9 8c0 5-2 6-2 6h9" />
      <path d="M7 14h8M7 18h9" />
    </>
  ),
  activity: <path d="M3 12h4l2 5 4-11 2 6h6" />,
  doc: (
    <>
      <path d="M6 3h8l4 4v14H6Z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 17h6" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M12 8.5 13.4 11l2.6 1-2.6 1L12 15.5 10.6 13 8 12l2.6-1L12 8.5Z" />
    </>
  ),
  trending: (
    <>
      <path d="M4 19V5" />
      <path d="M4 15l5-5 4 3 6-7" />
      <path d="M19 9V6h-3" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2 2 0 0 1 6 4h6v15H6a2 2 0 0 0-2 1.5Z" />
      <path d="M20 5.5A2 2 0 0 0 18 4h-6v15h6a2 2 0 0 1 2 1.5Z" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  phone: (
    <path d="M6.5 3.5 9 4l1 3.5L8.2 9.2a13 13 0 0 0 6.6 6.6L16.5 14l3.5 1 .5 2.5a2 2 0 0 1-2 2.4A15 15 0 0 1 4.1 5a2 2 0 0 1 2.4-2Z" />
  ),
  bulb: (
    <>
      <path d="M9 17.5h6" />
      <path d="M10 21h4" />
      <path d="M8 12a5 5 0 1 1 8 0c-1 1.3-1.5 2-1.5 3.5h-5C9.5 14 9 13.3 8 12Z" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9.5v4.5M12 17.2v.1" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.2l2.4 2.4 4.6-5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-3.8-3.8" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
  inbox: (
    <>
      <path d="M3 13h5l1.5 3h5L21 13" />
      <path d="M3 13 5.5 5h13L21 13v6H3v-6Z" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </>
  ),
};

export function SysIcon({
  name,
  size = 16,
  strokeWidth = 1.5,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: "none", display: "block" }}
    >
      {PATHS[name]}
    </svg>
  );
}
