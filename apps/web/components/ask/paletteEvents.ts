/**
 * Typed open-signal for the ⌘K CommandPalette (owner brief: make the
 * shortcut discoverable via a header affordance, not just the keybinding).
 * A custom window event rather than a shared React context/store keeps
 * AppFrame and CommandPalette decoupled — AppFrame doesn't need to know the
 * palette exists as anything more than "something listens for this event",
 * and the palette's own Cmd/Ctrl-K listener keeps working unchanged.
 */
export const ASK_PALETTE_OPEN_EVENT = "azen:ask-palette-open";

/** Optional payload: text to pre-fill the palette input with (push-to-talk). */
export interface AskPaletteOpenDetail {
  text?: string;
}

/**
 * Ask the CommandPalette to open — used by the sidebar "Ask · ⌘K" affordance
 * and by push-to-talk, which passes the dictated transcript to pre-fill the
 * input. Calling with no argument just opens it (backwards-compatible).
 */
export function openAskPalette(text?: string): void {
  if (typeof window === "undefined") return;
  const detail: AskPaletteOpenDetail | undefined =
    typeof text === "string" && text.trim() !== "" ? { text } : undefined;
  window.dispatchEvent(new CustomEvent(ASK_PALETTE_OPEN_EVENT, { detail }));
}
