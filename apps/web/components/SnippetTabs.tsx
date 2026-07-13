"use client";

import { useState } from "react";
import { CopyButton } from "./CopyBlock";

/**
 * Integration snippets prefilled with the real public key + endpoint. The
 * secret is only ever referenced as an `AZEN_SECRET=…` placeholder line —
 * never inlined (contract §UI.3).
 */
export function SnippetTabs({
  publicKey,
  endpoint,
  authMode,
}: {
  publicKey: string;
  endpoint: string;
  authMode: string;
}) {
  const tabs = ["Node SDK", "curl", "GHL"] as const;
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

  const ghl =
    authMode === "token"
      ? `# GoHighLevel → Workflow → Webhook (no code)
# Method:  POST
# URL:
${endpoint}
# Custom header (store the secret as AZEN_SECRET):
X-Azen-Token: <your secret>
# Body (map GHL merge fields into data):
{"type":"booking.created","occurred_at":"{{appointment.startTime}}",
 "idempotency_key":"{{appointment.id}}",
 "data":{"starts_at":"{{appointment.startTime}}","service":"{{appointment.title}}"}}`
      : `# This project uses HMAC signing.
# GoHighLevel's no-code webhook can't sign requests — it needs a
# token-mode key. Create the project with the "GHL" stack, or use
# "Revoke & re-issue" here to switch, then map fields into the body:
${endpoint}`;

  const current = active === "Node SDK" ? node : active === "curl" ? curl : ghl;

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
    </div>
  );
}
