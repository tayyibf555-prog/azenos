import type { ProjectDraft } from "../server/intake/schema";
import type { ProposalItem } from "../../components/growth-types";

/**
 * Won→wizard prefill (docs/phase8/CONTRACTS.md §P8-GROWTH2 — the "won→wizard
 * link" carve-out on GROWTH2's file ownership). A won proposal's "Create
 * project" button stashes this payload in sessionStorage — a same-tab,
 * one-shot handoff, never a persisted or server-side value — and navigates to
 * the guided wizard (P8-WIZARD, `/projects/new`), which reads and clears it on
 * mount. Pure, dependency-free mapping so both sides of the handoff are
 * unit-testable without a DOM.
 */

export const WIZARD_PREFILL_STORAGE_KEY = "azen:wizardPrefillV1";

export interface WizardPrefillPayload {
  proposalId: string;
  /** Proposals always belong to a real client (clientId is NOT NULL on upsell_proposals). */
  clientId: string;
  clientName: string;
  title: string;
  problemMd: string;
  suggestedPricePence: number | null;
}

/** Build the sessionStorage payload from a won proposal. */
export function buildWizardPrefillPayload(
  proposal: Pick<
    ProposalItem,
    "id" | "clientId" | "clientName" | "title" | "problemMd" | "suggestedPricePence"
  >,
): WizardPrefillPayload {
  return {
    proposalId: proposal.id,
    clientId: proposal.clientId,
    clientName: proposal.clientName,
    title: proposal.title,
    problemMd: proposal.problemMd,
    suggestedPricePence: proposal.suggestedPricePence,
  };
}

/** Narrow an arbitrary parsed value to a well-formed WizardPrefillPayload. */
export function isWizardPrefillPayload(v: unknown): v is WizardPrefillPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.proposalId === "string" &&
    typeof p.clientId === "string" &&
    typeof p.clientName === "string" &&
    typeof p.title === "string" &&
    typeof p.problemMd === "string" &&
    (p.suggestedPricePence === null || typeof p.suggestedPricePence === "number")
  );
}

/**
 * Map a prefill payload onto a blank/base ProjectDraft: title → project name,
 * problem → description, price → build fee, client preselected (the
 * proposal's own client — always an existing one).
 */
export function applyWizardPrefillToDraft(
  base: ProjectDraft,
  payload: WizardPrefillPayload,
): ProjectDraft {
  return {
    ...base,
    name: payload.title.trim() || base.name,
    client: {
      match: "existing",
      clientId: payload.clientId,
      name: payload.clientName,
      industrySlug: null,
    },
    description: payload.problemMd.trim().slice(0, 2000),
    buildFeePence:
      payload.suggestedPricePence !== null && payload.suggestedPricePence > 0
        ? payload.suggestedPricePence
        : null,
  };
}
