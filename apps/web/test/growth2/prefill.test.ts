import { describe, expect, it } from "vitest";
import { blankDraft } from "../../lib/onboarding/wizard";
import {
  applyWizardPrefillToDraft,
  buildWizardPrefillPayload,
  isWizardPrefillPayload,
} from "../../lib/growth/proposalPrefill";
import type { ProposalItem } from "../../components/growth-types";

/**
 * §P8-GROWTH2 — won→wizard prefill mapping (docs/phase8/CONTRACTS.md: "Won
 * proposal → 'Create project' → prefills the onboarding wizard step 3 from
 * the proposal (title/problem/price → build fee) + the client preselected").
 * Pure, dependency-free — no DOM, no DB.
 */

function wonProposal(overrides: Partial<ProposalItem> = {}): ProposalItem {
  return {
    id: "proposal-1",
    clientId: "client-1",
    clientName: "Bright Smile Dental",
    projectId: "project-1",
    projectName: "Reception voice agent",
    title: "Add an after-hours booking follow-up agent",
    problemMd: "The front desk misses ~30% of after-hours enquiries.",
    proposalMd: "We'd add a follow-up agent that texts back within a minute.",
    suggestedPricePence: 250_000,
    status: "won",
    insightIds: [],
    expectedRoiNote: null,
    evidenceEvents: [],
    createdAt: new Date().toISOString(),
    viewCount: 3,
    lastViewedAt: new Date().toISOString(),
    shareTokenId: null,
    ...overrides,
  };
}

describe("buildWizardPrefillPayload", () => {
  it("carries the proposal id, client, title, problem and price", () => {
    const p = wonProposal();
    const payload = buildWizardPrefillPayload(p);
    expect(payload).toEqual({
      proposalId: "proposal-1",
      clientId: "client-1",
      clientName: "Bright Smile Dental",
      title: p.title,
      problemMd: p.problemMd,
      suggestedPricePence: 250_000,
    });
  });

  it("round-trips through isWizardPrefillPayload", () => {
    const payload = buildWizardPrefillPayload(wonProposal());
    expect(isWizardPrefillPayload(JSON.parse(JSON.stringify(payload)))).toBe(true);
    expect(isWizardPrefillPayload(null)).toBe(false);
    expect(isWizardPrefillPayload({ proposalId: "x" })).toBe(false);
    expect(isWizardPrefillPayload("not an object")).toBe(false);
  });
});

describe("applyWizardPrefillToDraft", () => {
  it("maps title → name, problem → description, price → build fee, client preselected (existing)", () => {
    const payload = buildWizardPrefillPayload(wonProposal());
    const draft = applyWizardPrefillToDraft(blankDraft("ai_agent", "custom_code"), payload);

    expect(draft.name).toBe(payload.title);
    expect(draft.description).toBe(payload.problemMd);
    expect(draft.buildFeePence).toBe(250_000);
    expect(draft.client).toEqual({
      match: "existing",
      clientId: "client-1",
      name: "Bright Smile Dental",
      industrySlug: null,
    });
    // untouched wizard defaults
    expect(draft.type).toBe("ai_agent");
    expect(draft.stack).toBe("custom_code");
  });

  it("leaves build fee null when the proposal has no suggested price", () => {
    const payload = buildWizardPrefillPayload(wonProposal({ suggestedPricePence: null }));
    const draft = applyWizardPrefillToDraft(blankDraft("ai_agent", "custom_code"), payload);
    expect(draft.buildFeePence).toBeNull();
  });
});
