// @azen/emails — React Email templates (spec §9.7). Phase 3, P3-DELIVERY
// (docs/phase3/CONTRACTS.md): DailyBriefEmail + a render() helper to HTML+text.
import { render } from "@react-email/components";
import { DailyBriefEmail } from "./DailyBriefEmail";
import type { DailyBriefEmailModel } from "./DailyBriefEmail";

export { DailyBriefEmail } from "./DailyBriefEmail";
export type {
  DailyBriefEmailModel,
  BriefHeroNumbers,
  BriefProjectRow,
} from "./DailyBriefEmail";

/**
 * Render a Daily Brief to both an HTML body and a plain-text fallback.
 * Pure — no network, no env. Used by the delivery orchestrator and demoable
 * standalone (this is what the render test exercises).
 */
export async function renderBriefEmail(
  model: DailyBriefEmailModel,
): Promise<{ html: string; text: string }> {
  const element = DailyBriefEmail(model);
  const [html, text] = await Promise.all([
    render(element),
    render(element, {
      plainText: true,
      // html-to-text uppercases headings by default; keep the headline's
      // original case so the plain-text body contains it verbatim.
      htmlToTextOptions: {
        selectors: [
          { selector: "h1", options: { uppercase: false } },
          { selector: "h2", options: { uppercase: false } },
        ],
      },
    }),
  ]);
  return { html, text };
}
