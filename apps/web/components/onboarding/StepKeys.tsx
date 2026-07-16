"use client";

import { useEffect, useRef, useState } from "react";
import { KeyReveal } from "../KeyReveal";
import { FeedbackWidgetCard } from "../FeedbackWidgetCard";
import { COLORS } from "../ui";
import { buildCreatePayload } from "../../lib/onboarding/wizard";
import type { ApiError, CreateProjectResponse, ProjectKeyView } from "../types";
import type { ProjectDraft } from "../../lib/server/intake/schema";

/**
 * Step 4 — the single create call (contract: "State client-side; single
 * create call at step 4, reuse the existing create API"), then the reveal-
 * once ingest key/snippets (KeyReveal — wraps SnippetTabs) plus the
 * feedback-widget card, exactly as they render on a project's Setup tab.
 * Auto-fires on first arrival at this step; re-entering after Back/Next never
 * re-creates (`created` is owned by the parent wizard).
 */
export function StepKeys({
  draft,
  created,
  onCreated,
}: {
  draft: ProjectDraft;
  created: CreateProjectResponse | null;
  onCreated: (result: CreateProjectResponse) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (created || started.current) return;
    started.current = true;
    void create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCreatePayload(draft)),
      });
      const json = (await res.json()) as CreateProjectResponse | ApiError;
      if (!res.ok || "error" in json) {
        setError("error" in json ? json.error : `Request failed (${res.status})`);
        started.current = false; // allow a retry
        return;
      }
      onCreated(json);
    } catch {
      setError("Network error — please try again.");
      started.current = false;
    } finally {
      setCreating(false);
    }
  }

  if (!created) {
    return (
      <div style={{ maxWidth: 480 }}>
        {creating && (
          <p className="muted" style={{ fontSize: 13.5 }}>
            Creating the project…
          </p>
        )}
        {error && (
          <div style={{ display: "grid", gap: 10 }}>
            <p style={{ color: COLORS.red, fontSize: 13 }}>{error}</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={create}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const endpoint = `${origin}/api/ingest/${created.key.publicKey}`;
  const feedbackKey: ProjectKeyView = {
    id: created.project.id,
    publicKey: created.feedbackPublicKey,
    authMode: "public",
    kind: "feedback",
    rateLimitPer10s: 0,
    createdAt: new Date().toISOString(),
    revokedAt: null,
    lastUsedAt: null,
    label: null,
  };

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>
          {created.project.name} is live
        </h3>
        <KeyReveal
          endpoint={endpoint}
          publicKey={created.key.publicKey}
          secret={created.key.secret}
          authMode={created.key.authMode}
        />
      </div>
      <FeedbackWidgetCard
        projectId={created.project.id}
        feedbackKey={feedbackKey}
        origin={origin}
      />
    </div>
  );
}
