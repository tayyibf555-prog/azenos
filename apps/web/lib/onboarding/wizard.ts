import type { ProjectDraft } from "../server/intake/schema";

/**
 * Guided onboarding wizard (Phase 8 task P8-WIZARD) — pure, dependency-free
 * state helpers. Kept separate from the client components so the step
 * machine, the create-payload mapping, and the live-check derivation are all
 * unit-testable without a DOM (mirrors the useDictation extraction pattern:
 * framework-free logic lives here, components only render it).
 *
 * The wizard's single source of truth is a `ProjectDraft` — the SAME shape
 * the transcript-intake flow already produces (lib/server/intake/schema.ts).
 * Reusing it means step 2's intake output slots straight into step 3/4 with
 * no separate wizard-only draft type, and step 3 (manual entry, no
 * transcript) just starts from `blankDraft()` instead.
 */

export const WIZARD_STEPS = [1, 2, 3, 4, 5] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const STEP_LABELS: Record<WizardStep, string> = {
  1: "Client",
  2: "Intake",
  3: "Details",
  4: "Keys",
  5: "Live check",
};

/** A fresh, empty draft for the manual-entry path (no transcript used). */
export function blankDraft(defaultType: string, defaultStack: string): ProjectDraft {
  return {
    name: "",
    client: { match: "new", clientId: null, name: "", industrySlug: null },
    type: defaultType as ProjectDraft["type"],
    stack: defaultStack as ProjectDraft["stack"],
    description: "",
    retainerPenceMonthly: null,
    buildFeePence: null,
    hourlyRatePence: null,
    goals: [],
    suggestedEventTypes: [],
    assumptions: [],
  };
}

/** Which top-level fields changed between two drafts (drives DraftCard's flash — same contract as the intake flow's diffDraft). */
export function diffDraft(prev: ProjectDraft, next: ProjectDraft): string[] {
  const keys: Array<keyof ProjectDraft> = [
    "name",
    "client",
    "type",
    "stack",
    "description",
    "retainerPenceMonthly",
    "buildFeePence",
    "hourlyRatePence",
    "goals",
    "suggestedEventTypes",
    "assumptions",
  ];
  return keys.filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
}

export function clientValid(draft: ProjectDraft): boolean {
  return draft.client.match === "existing"
    ? Boolean(draft.client.clientId)
    : draft.client.name.trim().length > 0;
}

export function detailsValid(draft: ProjectDraft): boolean {
  return draft.name.trim().length > 0 && clientValid(draft);
}

/** Whether the wizard may move FORWARD off `step` given the current draft. */
export function canAdvance(step: WizardStep, draft: ProjectDraft): boolean {
  switch (step) {
    case 1:
      return clientValid(draft);
    case 2:
      return true; // intake is optional — always skippable
    case 3:
      return detailsValid(draft);
    case 4:
      return true; // gated by the create call itself, not client validation
    case 5:
      return true;
    default:
      return false;
  }
}

export function nextStep(step: WizardStep): WizardStep {
  return Math.min(step + 1, 5) as WizardStep;
}

export function prevStep(step: WizardStep): WizardStep {
  return Math.max(step - 1, 1) as WizardStep;
}

/** £ input string → integer pence, or null for blank/invalid/non-positive. */
export function poundsToPence(pounds: string): number | null {
  const n = parseFloat(pounds);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/**
 * Map the current draft to the POST /api/projects body — the SAME mapping
 * TranscriptIntake's toCreateBody uses, reimplemented here (not imported)
 * because that function is private to a component outside this workstream's
 * file ownership; the contract shape (docs/phase8/CONTRACTS.md, projects
 * create schema) is the pinned source of truth both sides implement against.
 */
export function buildCreatePayload(draft: ProjectDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: draft.name.trim(),
    type: draft.type,
    stack: draft.stack,
  };
  if (draft.description.trim()) body.description = draft.description.trim();
  if (draft.retainerPenceMonthly !== null && draft.retainerPenceMonthly >= 0) {
    body.retainerPenceMonthly = draft.retainerPenceMonthly;
  }
  if (draft.buildFeePence !== null && draft.buildFeePence >= 0) {
    body.buildFeePence = draft.buildFeePence;
  }
  if (draft.hourlyRatePence !== null && draft.hourlyRatePence > 0) {
    body.hourlyRatePence = Math.min(draft.hourlyRatePence, 100_000);
  }
  if (draft.goals.length > 0) body.goals = draft.goals;
  if (draft.client.match === "existing" && draft.client.clientId) {
    body.clientId = draft.client.clientId;
  } else {
    body.newClient = {
      name: draft.client.name.trim() || draft.name.trim(),
      ...(draft.client.industrySlug
        ? { industrySlug: draft.client.industrySlug }
        : {}),
    };
  }
  return body;
}

// ── step 5: live check ──────────────────────────────────────────────────────

export interface LiveCheckState {
  received: boolean;
  eventType: string | null;
}

/** Pure derivation from a polled events page — no I/O, easy to test with mock fetch payloads. */
export function deriveLiveCheck(
  events: ReadonlyArray<{ type: string }>,
): LiveCheckState {
  const first = events[0];
  return { received: Boolean(first), eventType: first ? first.type : null };
}

/**
 * One poll tick for step 5 — hits the SAME per-project events route the
 * Events tab uses (limit=1 is enough; `deriveLiveCheck` only looks at the
 * first row) and reduces it to the derived state. Extracted from the
 * component so the polling contract is testable with a mocked `fetch`
 * without a DOM.
 */
export async function fetchLiveCheck(
  projectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveCheckState> {
  const res = await fetchImpl(`/api/projects/${projectId}/events?limit=1`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`events ${res.status}`);
  const json = (await res.json()) as { events: ReadonlyArray<{ type: string }> };
  return deriveLiveCheck(json.events);
}
