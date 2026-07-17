"use client";

import { useState } from "react";
import { OnboardingWizard } from "./OnboardingWizard";
import { NewProjectForm } from "../NewProjectForm";

type Mode = "guided" | "quick";

/**
 * Entry point for /projects/new — defaults to the guided stepper; the
 * existing quick form (transcript-or-manual, one screen) stays reachable via
 * a toggle, per the contract ("keep the existing quick form reachable").
 */
export function NewProjectEntry({
  types,
  stacks,
}: {
  types: string[];
  stacks: string[];
}) {
  const [mode, setMode] = useState<Mode>("guided");

  return (
    <div>
      <div
        role="tablist"
        aria-label="New project entry mode"
        style={{
          display: "inline-flex",
          gap: 3,
          padding: 3,
          marginBottom: 22,
          background: "var(--bg-well)",
          borderRadius: "var(--radius-pill)",
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === "guided"}
          className={mode === "guided" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}
          onClick={() => setMode("guided")}
        >
          Guided setup
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "quick"}
          className={mode === "quick" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}
          onClick={() => setMode("quick")}
        >
          Quick form
        </button>
      </div>

      {mode === "guided" ? (
        <OnboardingWizard types={types} stacks={stacks} />
      ) : (
        <NewProjectForm types={types} stacks={stacks} />
      )}
    </div>
  );
}
