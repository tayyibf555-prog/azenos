import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DictationMic } from "../../components/ask/DictationMic";
import { COLORS } from "../../components/ui";
import type { DictationController } from "../../lib/useDictation";

/**
 * DictationMic is the presentational control CommandPalette and AskScreen
 * both instantiate for their mic button — deliberately hook-free so it's
 * renderable in isolation with react-dom/server (already a dependency; no
 * jsdom needed) without triggering CommandPalette/AskScreen's next/navigation
 * router-context requirement, which a bare renderToStaticMarkup can't supply.
 */

type ControllerProps = Pick<
  DictationController,
  "tier" | "recState" | "listening" | "elapsedSeconds" | "unavailable" | "toggle"
>;

function render(controller: ControllerProps): string {
  return renderToStaticMarkup(createElement(DictationMic, { controller }));
}

const base: ControllerProps = {
  tier: "none",
  recState: "idle",
  listening: false,
  elapsedSeconds: 0,
  unavailable: false,
  toggle: () => undefined,
};

describe("DictationMic", () => {
  it("renders nothing when the browser has no capture path and no key issue is known yet", () => {
    expect(render({ ...base })).toBe("");
  });

  it('shows the calm "voice needs OPENAI_API_KEY" hint instead of a dead button once confirmed unavailable', () => {
    const html = render({ ...base, unavailable: true });
    expect(html).toContain("voice needs OPENAI_API_KEY");
    expect(html).not.toContain("<button");
  });

  it("renders an idle mic button for the whisper tier", () => {
    const html = render({ ...base, tier: "whisper" });
    expect(html).toContain("Start dictation");
    expect(html).toContain("🎙");
  });

  it("renders a pulsing stop control with elapsed time while recording", () => {
    const html = render({ ...base, tier: "whisper", recState: "recording", elapsedSeconds: 65 });
    expect(html).toContain("Stop recording");
    expect(html).toContain("1:05");
    expect(html).toMatch(/class="btn btn-sm pulse"/);
    // Assert the TOKEN, not a hex literal — the palette is allowed to evolve
    // (Apple-theme remap 2026-07-16: teal token → quiet ice-blue).
    expect(html).toContain(COLORS.teal);
  });

  it("renders a subtle disabled spinner while transcribing", () => {
    const html = render({ ...base, tier: "whisper", recState: "transcribing" });
    expect(html).toContain("dict-spinner");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-label="Transcribing"');
  });

  it("renders the Web Speech idle and listening states", () => {
    const idle = render({ ...base, tier: "webspeech" });
    expect(idle).toContain("Start dictation");
    expect(idle).toContain("🎙");

    const listening = render({ ...base, tier: "webspeech", listening: true });
    expect(listening).toContain("Stop dictation");
    expect(listening).toContain("● Rec");
    expect(listening).toMatch(/class="btn btn-sm pulse"/);
  });
});

describe("palette + composer wire-up", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  function readSource(rel: string): string {
    return readFileSync(path.join(here, "../..", rel), "utf8");
  }

  it("CommandPalette (⌘K) wires the shared hook + mic into its real input row", () => {
    const file = readSource("components/ask/CommandPalette.tsx");
    expect(file).toContain('import { useDictation } from "../../lib/useDictation";');
    expect(file).toContain('import { DictationMic } from "./DictationMic";');
    expect(file).toMatch(/const dictation = useDictation\(/);
    expect(file).toContain("<DictationMic controller={dictation} />");
  });

  it("the Ask screen composer wires the shared hook + mic into its real input row", () => {
    const file = readSource("components/ask/AskScreen.tsx");
    expect(file).toContain('import { useDictation } from "../../lib/useDictation";');
    expect(file).toContain('import { DictationMic } from "./DictationMic";');
    expect(file).toMatch(/const dictation = useDictation\(/);
    expect(file).toContain("<DictationMic controller={dictation} />");
  });

  it("AppFrame opens the palette via the same event the mic/keybinding share, not a second code path", () => {
    const palette = readSource("components/ask/CommandPalette.tsx");
    const frame = readSource("components/AppFrame.tsx");
    expect(palette).toContain("ASK_PALETTE_OPEN_EVENT");
    expect(palette).toMatch(/addEventListener\(ASK_PALETTE_OPEN_EVENT/);
    expect(frame).toContain("openAskPalette");
  });
});
