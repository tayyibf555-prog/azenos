import type { ReactNode } from "react";

/** §4 KbdChip — reuses the global .kbd style for keyboard hints. Pure/SSR-safe. */
export function KbdChip({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}
