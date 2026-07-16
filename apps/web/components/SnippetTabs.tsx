"use client";

import { useState } from "react";
import { CopyButton } from "./CopyBlock";

/**
 * Integration snippets prefilled with the real public key + endpoint. The
 * secret is only ever referenced as an `AZEN_SECRET=…` placeholder line —
 * never inlined (contract §UI.3).
 */

// Plausible example `data` payload per event type, for the per-missing-type
// copy-paste snippets on the Setup tab's Tracking plan card. Only the types
// that actually appear in TRACKING_PRESETS (lib/tracking-presets.ts) need an
// entry — anything else falls back to an empty object.
const EXAMPLE_EVENT_DATA: Record<string, Record<string, unknown>> = {
  "llm.conversation": {
    channel: "webchat",
    resolution: "resolved",
    turns: 5,
    duration_seconds: 92,
  },
  "call.completed": {
    duration_seconds: 180,
    outcome: "booked",
    direction: "inbound",
  },
  "agent.escalated_to_human": { reason: "complex request" },
  "booking.created": {
    starts_at: "2026-07-16T10:00:00Z",
    service: "Consultation",
  },
  "booking.completed": { duration_minutes: 30 },
  "booking.no_show": {},
  "message.sent": { channel: "sms", to: "+447700900000" },
  "message.received": { channel: "webchat", from: "web visitor" },
  "lead.created": { name: "Jane Doe", email: "jane@example.com", source: "website" },
  "lead.qualified": { score: 82 },
  "lead.stage_changed": { to_stage: "qualified" },
  "lead.converted": {},
  "lead.lost": { reason: "no budget" },
  "form.submitted": { form_name: "Contact form" },
  "workflow.run": { name: "Lead nurture", success: true },
  "task.completed": { what: "Sent invoice" },
  "system.error": { severity: "error", message: "Payment webhook timed out" },
  "document.generated": { kind: "invoice" },
  "agent.run.started": { task: "generate proposal" },
  "agent.run.completed": { success: true, duration_ms: 1200 },
  "agent.run.failed": { error: "timeout" },
  "agent.feedback": { rating: 5 },
  "agent.heartbeat": { agent_id: "agent_1", status: "ok" },
  "email.sent": { to: "jane@example.com", subject: "Your quote" },
  "email.opened": {},
  "quote.sent": { amount_pence: 45000 },
  "quote.accepted": { amount_pence: 45000 },
  "order.created": { amount_pence: 2500, items_count: 1 },
  "order.fulfilled": {},
  "payment.captured": { amount_pence: 4999 },
  "feedback.submitted": { kind: "bug", message: "Booking button does nothing" },
};

/** Per-type `os.track(...)` copy-paste snippet for the Tracking plan card. */
export function trackSnippet(type: string): string {
  const data = EXAMPLE_EVENT_DATA[type] ?? {};
  return `await os.track(${JSON.stringify(type)}, {
  subject: { kind: "customer", name: "Jane Doe" },
  data: ${JSON.stringify(data, null, 2).replace(/\n/g, "\n  ")},
});`;
}
export function SnippetTabs({
  publicKey,
  endpoint,
  authMode,
}: {
  publicKey: string;
  endpoint: string;
  authMode: string;
}) {
  const tabs = ["Node SDK", "Co-pilot", "curl"] as const;
  const [active, setActive] = useState<(typeof tabs)[number]>("Node SDK");

  const bodyExample =
    '{"type":"booking.created","occurred_at":"2026-07-12T09:00:00Z",' +
    '"idempotency_key":"bk_123","data":{"starts_at":"2026-07-12T10:00:00Z",' +
    '"service":"Consultation"}}';

  const node = `# .env
AZEN_SECRET=<your secret>

import { AzenOS } from "@azen/os-sdk";

const os = new AzenOS({
  key: "${publicKey}",
  secret: process.env.AZEN_SECRET!,${authMode === "token" ? '\n  authMode: "token",' : ""}
});

await os.track("booking.created", {
  subject: { kind: "customer", name: "Jane Doe" },
  data: { starts_at: new Date().toISOString(), service: "Consultation" },
});`;

  const curl =
    authMode === "token"
      ? `AZEN_SECRET=<your secret>

curl -X POST '${endpoint}' \\
  -H 'Content-Type: application/json' \\
  -H "X-Azen-Token: $AZEN_SECRET" \\
  -d '${bodyExample}'`
      : `# HMAC: X-Azen-Signature: t=<unix>,v1=hmac_sha256(secret, "<t>.<body>")
# The SDK computes this for you; raw curl must sign the body itself.
AZEN_SECRET=<your secret>

curl -X POST '${endpoint}' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Azen-Signature: t=1720800000,v1=<hmac-sha256>' \\
  -d '${bodyExample}'`;

  // Co-pilot capture: feed the end-user's QUESTION into the spine so the
  // Analytics → Conversations & AI "Question Intelligence" panel can mine it.
  // The question rides in `data.question` on llm.conversation, and standalone
  // inbound messages carry it in `data.text` on message.received.
  const copilot = `import { AzenOS } from "@azen/os-sdk";

const os = new AzenOS({ key: "${publicKey}", secret: process.env.AZEN_SECRET! });

// Log a co-pilot conversation WITH the end-user's question text.
// (data is freeform — the "question" key powers Question Intelligence.)
await os.track("llm.conversation", {
  subject: { kind: "customer", name: "Jane Doe" },
  data: {
    question: "How much is teeth whitening?",
    intent: "pricing",
    resolution: "resolved",        // resolved | escalated | abandoned
    sentiment: "positive",         // positive | neutral | negative
    turns: 5,
    duration_seconds: 92,
  },
});

// Or capture a standalone inbound message (chat/SMS/WhatsApp):
await os.track("message.received", {
  subject: { kind: "customer", name: "Jane Doe" },
  data: { channel: "webchat", text: "Are you open on Saturday?" },
});`;

  const current =
    active === "Node SDK" ? node : active === "Co-pilot" ? copilot : curl;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setActive(t)}
              className={active === t ? "btn btn-sm" : "btn btn-ghost btn-sm"}
              style={active === t ? undefined : { color: "var(--text-2)" }}
            >
              {t}
            </button>
          ))}
        </div>
        <CopyButton value={current} className="btn btn-sm" />
      </div>
      <pre className="codeblock">{current}</pre>
      <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>
        Any stack connects the same way — the SDK above, or point a no-code
        platform&rsquo;s outgoing webhook at the signed curl endpoint.
      </p>
    </div>
  );
}
