/**
 * Typed open-signal for the ⌘K CommandPalette (owner brief: make the
 * shortcut discoverable via a header affordance, not just the keybinding).
 * A custom window event rather than a shared React context/store keeps
 * AppFrame and CommandPalette decoupled — AppFrame doesn't need to know the
 * palette exists as anything more than "something listens for this event",
 * and the palette's own Cmd/Ctrl-K listener keeps working unchanged.
 */
export const ASK_PALETTE_OPEN_EVENT = "azen:ask-palette-open";

/** Ask the CommandPalette to open — used by the sidebar "Ask · ⌘K" affordance. */
export function openAskPalette(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ASK_PALETTE_OPEN_EVENT));
}
