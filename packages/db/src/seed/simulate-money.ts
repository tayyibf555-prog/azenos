import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { CLIENTS, PROJECTS } from "./demo-data";

/**
 * pnpm sim:stripe   [--endpoint=url] [--client=<clientId>] [--project=<slug>]
 *                   [--kind=retainer|build_fee|deposit|other] [--amount=<pence>]
 *                   [--event=invoice.paid|invoice.payment_failed|
 *                            customer.subscription.created] [--dry]
 * pnpm sim:calendly [--endpoint=url] [--name="Discovery Call"] [--invitee=Name]
 *                   [--event=invitee.created|invitee.canceled] [--dry]
 *
 * Posts CORRECTLY-SIGNED Stripe / Calendly payloads at the LOCAL agency hooks
 * so Phase 4 money + bookings are demoable without live accounts (§P4-HOOKS).
 * The signature is computed with the same local secret the hook verifies with
 * (STRIPE_WEBHOOK_SECRET / CALENDLY_WEBHOOK_SIGNING_KEY from the root .env) —
 * identical `t=<unix>,v1=HMAC-SHA256(secret,"${t}.${body}")` scheme as ingest.
 */

// Load the repo-root .env regardless of cwd. NOTE: this file is in src/seed/,
// one level deeper than client.ts (src/), so it needs four ../ to reach root
// (seed → src → db → packages → root), not the three client.ts uses.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../../.env") });
config();

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  return undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function signHookBody(secret: string, rawBody: string): string {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

async function post(
  endpoint: string,
  header: string,
  headerValue: string,
  body: string,
  dry: boolean,
): Promise<void> {
  if (dry) {
    console.log(`POST ${endpoint}`);
    console.log(`${header}: ${headerValue}`);
    console.log(body);
    console.log("\n--dry: nothing sent.");
    return;
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", [header]: headerValue },
    body,
  });
  const text = await res.text().catch(() => "");
  console.log(`${res.status} ${text}`);
  if (!res.ok) process.exitCode = 1;
}

async function simulateStripe(): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      "STRIPE_WEBHOOK_SECRET is not set — add it to .env (the dev server must use the same value).",
    );
    process.exit(1);
  }
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const endpoint = arg("endpoint") || `${appUrl}/api/hooks/stripe`;

  const projectSlug = arg("project");
  const project = projectSlug
    ? PROJECTS.find((p) => p.slug === projectSlug)
    : undefined;
  const clientId = arg("client") || project?.clientId || CLIENTS[0].id;
  const kind = arg("kind") || "retainer";
  const amount = Number(arg("amount") || 50_000); // £500 default
  const eventType = arg("event") || "invoice.paid";
  const stamp = Date.now();

  const metadata: Record<string, string> = { azen_client_id: clientId, azen_kind: kind };
  if (project) metadata.azen_project_id = project.id;

  let event: unknown;
  if (eventType.startsWith("customer.subscription")) {
    event = {
      id: `evt_sim_${stamp}`,
      type: eventType,
      data: {
        object: {
          id: `sub_sim_${stamp}`,
          object: "subscription",
          customer: `cus_sim_${clientId.slice(0, 8)}`,
          status: eventType.endsWith("deleted") ? "canceled" : "active",
          start_date: Math.floor(stamp / 1000),
          items: { data: [{ price: { unit_amount: amount } }] },
          metadata,
        },
      },
    };
  } else {
    event = {
      id: `evt_sim_${stamp}`,
      type: eventType,
      data: {
        object: {
          id: `in_sim_${stamp}`,
          object: "invoice",
          customer: `cus_sim_${clientId.slice(0, 8)}`,
          number: `SIM-${stamp}`,
          currency: "gbp",
          amount_paid: amount,
          amount_due: amount,
          status_transitions: { paid_at: Math.floor(stamp / 1000) },
          metadata,
        },
      },
    };
  }

  const body = JSON.stringify(event);
  console.log(`Stripe ${eventType} → ${endpoint} (client ${clientId}, ${amount}p)`);
  await post(endpoint, "stripe-signature", signHookBody(secret, body), body, flag("dry"));
}

async function simulateCalendly(): Promise<void> {
  const secret = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  if (!secret) {
    console.error(
      "CALENDLY_WEBHOOK_SIGNING_KEY is not set — add it to .env (the dev server must use the same value).",
    );
    process.exit(1);
  }
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const endpoint = arg("endpoint") || `${appUrl}/api/hooks/calendly`;
  const eventName = arg("name") || "Discovery Call";
  const invitee = arg("invitee") || "Jamie Prospect";
  const eventType = arg("event") || "invitee.created";
  const stamp = Date.now();
  const inviteeUri = `https://api.calendly.com/scheduled_events/sim-${stamp}/invitees/sim-${stamp}`;
  const start = new Date(stamp + 24 * 3_600_000);
  const end = new Date(start.getTime() + 30 * 60_000);

  const event = {
    event: eventType,
    payload: {
      uri: inviteeUri,
      name: invitee,
      email: "jamie@prospect.example",
      scheduled_event: {
        uri: `https://api.calendly.com/scheduled_events/sim-${stamp}`,
        name: eventName,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
      },
    },
  };

  const body = JSON.stringify(event);
  console.log(`Calendly ${eventType} (${eventName}) → ${endpoint}`);
  await post(
    endpoint,
    "calendly-webhook-signature",
    signHookBody(secret, body),
    body,
    flag("dry"),
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "stripe") await simulateStripe();
  else if (mode === "calendly") await simulateCalendly();
  else {
    console.error("Usage: tsx src/seed/simulate-money.ts <stripe|calendly> [flags]");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
