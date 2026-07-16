import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WizardProgress } from "../../components/onboarding/WizardProgress";

/**
 * Reuse checks (contract: "reuse intake + tracking-presets + snippet pieces;
 * do not fork") plus a hook-free render of the progress rail — same pattern
 * as test/dictation/mic.test.ts: components with hooks/router deps are
 * asserted via source wiring, the one presentational hook-free component is
 * rendered directly with react-dom/server.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
function readSource(rel: string): string {
  return readFileSync(path.join(here, "../..", rel), "utf8");
}

describe("WizardProgress", () => {
  it("marks the active step and shows a check on completed ones", () => {
    const html = renderToStaticMarkup(createElement(WizardProgress, { step: 3 }));
    expect(html).toContain("aria-current=\"step\"");
    expect(html).toContain("Details");
    expect((html.match(/✓/g) ?? []).length).toBe(2); // steps 1 and 2 done
  });

  it("renders all five step labels in order", () => {
    const html = renderToStaticMarkup(createElement(WizardProgress, { step: 1 }));
    for (const label of ["Client", "Intake", "Details", "Keys", "Live check"]) {
      expect(html).toContain(label);
    }
  });
});

describe("reuse, not fork — step components import the existing pieces", () => {
  it("StepIntake reuses DraftCard, IntakeCopilot, DictationMic and the two intake routes (never a copy)", () => {
    const file = readSource("components/onboarding/StepIntake.tsx");
    expect(file).toContain('import { DraftCard } from "../DraftCard"');
    expect(file).toContain('import { IntakeCopilot');
    expect(file).toContain('import { DictationMic } from "../ask/DictationMic"');
    expect(file).toContain('"/api/projects/intake"');
    expect(file).toContain('"/api/projects/intake/refine"');
  });

  it("StepDetails reuses TrackingPlanCard (lib/tracking-presets) unmodified", () => {
    const file = readSource("components/onboarding/StepDetails.tsx");
    expect(file).toContain('import { TrackingPlanCard } from "../TrackingPlanCard"');
    expect(file).toMatch(/<TrackingPlanCard projectType={draft\.type} eventTypesSeen={\[\]} \/>/);
  });

  it("StepKeys reuses KeyReveal (SnippetTabs) and FeedbackWidgetCard, posting once to /api/projects", () => {
    const file = readSource("components/onboarding/StepKeys.tsx");
    expect(file).toContain('import { KeyReveal } from "../KeyReveal"');
    expect(file).toContain('import { FeedbackWidgetCard } from "../FeedbackWidgetCard"');
    const postCalls = file.match(/fetch\("\/api\/projects"/g) ?? [];
    expect(postCalls).toHaveLength(1);
  });

  it("StepLiveCheck polls via the shared usePolling hook and the pure fetchLiveCheck helper", () => {
    const file = readSource("components/onboarding/StepLiveCheck.tsx");
    expect(file).toContain('import { usePolling } from "../usePolling"');
    expect(file).toContain('import { fetchLiveCheck } from "../../lib/onboarding/wizard"');
  });

  it("NewProjectEntry keeps the existing quick form (NewProjectForm) reachable alongside the wizard", () => {
    const file = readSource("components/onboarding/NewProjectEntry.tsx");
    expect(file).toContain('import { NewProjectForm } from "../NewProjectForm"');
    expect(file).toContain('import { OnboardingWizard } from "./OnboardingWizard"');
  });

  it("the /projects/new page mounts NewProjectEntry (guided by default, quick form one click away)", () => {
    const file = readSource("app/projects/new/page.tsx");
    expect(file).toContain(
      'import { NewProjectEntry } from "../../../components/onboarding/NewProjectEntry"',
    );
    expect(file).toContain("<NewProjectEntry");
  });

  it("StepKeys never re-creates once a project already exists for this wizard instance", () => {
    const file = readSource("components/onboarding/StepKeys.tsx");
    expect(file).toContain("if (created || started.current) return;");
  });
});
