"use client";

import { useEffect, useRef, useState } from "react";
import { WizardProgress } from "./WizardProgress";
import { StepClient } from "./StepClient";
import { StepIntake } from "./StepIntake";
import { StepDetails } from "./StepDetails";
import { StepKeys } from "./StepKeys";
import { StepLiveCheck } from "./StepLiveCheck";
import type { ChatMessage } from "../IntakeCopilot";
import {
  blankDraft,
  canAdvance,
  nextStep,
  prevStep,
  type WizardStep,
} from "../../lib/onboarding/wizard";
import type { CreateProjectResponse } from "../types";
import type { ProjectDraft } from "../../lib/server/intake/schema";
import {
  applyWizardPrefillToDraft,
  isWizardPrefillPayload,
  WIZARD_PREFILL_STORAGE_KEY,
} from "../../lib/growth/proposalPrefill";

/**
 * Guided onboarding stepper (Phase 8, P8-WIZARD). Owns all state client-side
 * across the five steps; the ONLY network write that creates anything is the
 * single POST /api/projects call inside StepKeys (step 4) — every other step
 * only reads (clients list) or calls the existing read-only intake routes.
 */
export function OnboardingWizard({
  types,
  stacks,
}: {
  types: string[];
  stacks: string[];
}) {
  const [step, setStep] = useState<WizardStep>(1);
  const [draft, setDraft] = useState<ProjectDraft>(() =>
    blankDraft(types[0] ?? "custom", stacks[0] ?? "custom_code"),
  );
  const [transcript, setTranscript] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [created, setCreated] = useState<CreateProjectResponse | null>(null);
  const runIdsRef = useRef<string[]>([]);

  // Won→wizard prefill (P8-GROWTH2's carve-out on this file — "won→wizard
  // link" in docs/phase8/CONTRACTS.md's file-ownership map): a won proposal's
  // "Create project" button stashes a one-shot payload before navigating
  // here. Consume + clear it once on mount; a client is already selected and
  // step 3 is prefilled, so we jump straight past steps 1-2.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem(WIZARD_PREFILL_STORAGE_KEY);
    if (!raw) return;
    window.sessionStorage.removeItem(WIZARD_PREFILL_STORAGE_KEY);
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isWizardPrefillPayload(parsed)) return;
      setDraft((prev) => applyWizardPrefillToDraft(prev, parsed));
      setStep(3);
    } catch {
      /* malformed/foreign sessionStorage value — ignore, wizard starts blank */
    }
    // Runs once on mount only — the payload is one-shot and already cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canGoNext = canAdvance(step, draft);

  function goNext() {
    if (!canGoNext) return;
    setStep(nextStep(step));
  }
  function goBack() {
    setStep(prevStep(step));
  }

  function onCreated(result: CreateProjectResponse) {
    setCreated(result);
    attributeIntakeRuns(result.project.id);
  }

  /** Fire-and-forget cost attribution (same addendum §B contract the transcript flow uses) — failures console-only. */
  function attributeIntakeRuns(projectId: string) {
    const runIds = runIdsRef.current.slice(-100);
    if (runIds.length === 0) return;
    fetch("/api/projects/intake/attribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runIds, projectId }),
    })
      .then((res) => {
        if (!res.ok) console.error("[onboarding] cost attribution failed:", res.status);
      })
      .catch((err) => console.error("[onboarding] cost attribution failed:", err));
  }

  return (
    <div>
      <WizardProgress step={step} />

      {step === 1 && (
        <StepClient
          draft={draft}
          onChange={(client) => setDraft({ ...draft, client })}
        />
      )}

      {step === 2 && (
        <StepIntake
          transcript={transcript}
          onTranscriptChange={setTranscript}
          draft={draft}
          onDraftChange={setDraft}
          messages={messages}
          onMessagesChange={setMessages}
          onRunId={(id) => runIdsRef.current.push(id)}
        />
      )}

      {step === 3 && (
        <StepDetails draft={draft} onChange={setDraft} types={types} stacks={stacks} />
      )}

      {step === 4 && (
        <StepKeys draft={draft} created={created} onCreated={onCreated} />
      )}

      {step === 5 && created && (
        <StepLiveCheck
          projectId={created.project.id}
          projectName={created.project.name}
        />
      )}

      {step < 5 && (
        <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
          {step > 1 && (
            <button type="button" className="btn" onClick={goBack}>
              ← Back
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={goNext}
            disabled={!canGoNext || (step === 4 && !created)}
          >
            {step === 2 && draft.name.trim().length === 0
              ? "Skip intake →"
              : step === 4
                ? "Next: check for events →"
                : "Next →"}
          </button>
        </div>
      )}
    </div>
  );
}
