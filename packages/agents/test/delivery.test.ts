// P3-DELIVERY tests (docs/phase3/CONTRACTS.md). No live sends: fetch is stubbed
// via vi.stubGlobal, env via vi.stubEnv. Covers Resend + Twilio happy paths
// (URL + auth + body), missing-key → *_not_configured with ZERO fetch, dryRun
// payloads with ZERO fetch, and the @azen/emails render output.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DailyBriefEmailModel } from "@azen/emails";
import { renderBriefEmail } from "@azen/emails";
import {
  deliverBrief,
  sendBriefEmail,
  sendWhatsApp,
} from "../src/delivery/index";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(response: Response): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return response.clone();
    },
  );
  vi.stubGlobal("fetch", mock);
  return { calls };
}

/** Assert exactly one recorded call and return it (typed non-undefined). */
function only(calls: RecordedCall[]): RecordedCall {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) throw new Error("expected exactly one recorded fetch call");
  return call;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const MODEL: DailyBriefEmailModel = {
  headline: "MRR up 4% to £12,400 — two projects need eyes",
  heroNumbers: {
    mrrPence: 1_240_000,
    liveProjects: 4,
    activeClients: 3,
    health: { green: 2, amber: 1, red: 1 },
  },
  agencySummaryMd:
    "Strong day overall.\n\nBooking volume up versus the 7-day average.",
  needsAttention: ["Acme onboarding stalled — 26h of silence"],
  wins: ["Northwind saved 320 minutes of manual triage yesterday"],
  projects: [
    {
      name: "Acme Support Bot",
      clientName: "Acme Co",
      health: "red",
      summary: "No events for 26h",
      revenueYesterdayPence: 0,
      minutesSavedYesterday: 0,
    },
    {
      name: "Northwind Triage",
      clientName: "Northwind",
      health: "green",
      revenueYesterdayPence: 48_000,
      minutesSavedYesterday: 320,
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendBriefEmail (Resend)", () => {
  it("posts to the Resend endpoint with bearer auth and a full body", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("BRIEF_FROM_EMAIL", "brief@azen.test");
    const { calls } = stubFetch(jsonResponse({ id: "email-123" }));

    const result = await sendBriefEmail({
      to: "owner@azen.test",
      subject: "Daily Brief",
      html: "<p>hi</p>",
      text: "hi",
    });

    expect(result).toEqual({ ok: true, id: "email-123" });
    const call = only(calls);
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call.init.body as string) as {
      from: string;
      to: string[];
      subject: string;
      html: string;
      text: string;
    };
    expect(body.from).toBe("brief@azen.test");
    expect(body.to).toEqual(["owner@azen.test"]);
    expect(body.subject).toBe("Daily Brief");
    expect(body.html).toBe("<p>hi</p>");
    expect(body.text).toBe("hi");
  });

  it("returns email_not_configured with ZERO fetch when the key is absent", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("BRIEF_FROM_EMAIL", "");
    const { calls } = stubFetch(jsonResponse({ id: "should-not-happen" }));

    const result = await sendBriefEmail({
      to: "owner@azen.test",
      subject: "s",
      html: "<p>h</p>",
      text: "h",
    });

    expect(result).toEqual({ ok: false, reason: "email_not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("maps a non-2xx Resend response to a typed failure", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("BRIEF_FROM_EMAIL", "brief@azen.test");
    stubFetch(jsonResponse({ message: "domain not verified" }, 403));

    const result = await sendBriefEmail({
      to: "owner@azen.test",
      subject: "s",
      html: "<p>h</p>",
      text: "h",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("email_failed_403");
    }
  });
});

describe("sendWhatsApp (Twilio)", () => {
  it("posts to the account Messages endpoint with basic auth and whatsapp prefixes", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACxxxx");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secrettoken");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "+15005550006");
    const { calls } = stubFetch(jsonResponse({ sid: "SM123" }));

    const result = await sendWhatsApp({ to: "+447700900123", body: "hello" });

    expect(result).toEqual({ ok: true, id: "SM123" });
    const call = only(calls);
    expect(call.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/ACxxxx/Messages.json",
    );
    const headers = call.init.headers as Record<string, string>;
    const expectedAuth = `Basic ${Buffer.from("ACxxxx:secrettoken").toString(
      "base64",
    )}`;
    expect(headers.Authorization).toBe(expectedAuth);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(call.init.body as string);
    expect(params.get("From")).toBe("whatsapp:+15005550006");
    expect(params.get("To")).toBe("whatsapp:+447700900123");
    expect(params.get("Body")).toBe("hello");
  });

  it("returns whatsapp_not_configured with ZERO fetch when creds are absent", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "");
    const { calls } = stubFetch(jsonResponse({ sid: "should-not-happen" }));

    const result = await sendWhatsApp({ to: "+447700900123", body: "hi" });

    expect(result).toEqual({ ok: false, reason: "whatsapp_not_configured" });
    expect(calls).toHaveLength(0);
  });
});

describe("deliverBrief", () => {
  it("dryRun returns would-send payloads with ZERO fetch", async () => {
    // Even with keys present, dryRun must not touch the network.
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("BRIEF_FROM_EMAIL", "brief@azen.test");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACxxxx");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secrettoken");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "+15005550006");
    const { calls } = stubFetch(jsonResponse({ id: "nope" }));

    const result = await deliverBrief(
      {
        headline: MODEL.headline,
        emailModel: MODEL,
        whatsappText: "MRR up 4% to £12,400. Two projects need eyes.",
      },
      {
        email: { to: "owner@azen.test" },
        whatsapp: { to: "+447700900123" },
      },
      { dryRun: true },
    );

    expect(calls).toHaveLength(0);
    expect(result.dryRun).toBe(true);
    expect(result.email).toEqual({ ok: true });
    expect(result.whatsapp).toEqual({ ok: true });
    expect(result.payloads.email).not.toBeNull();
    expect(result.payloads.email?.to).toBe("owner@azen.test");
    expect(result.payloads.email?.from).toBe("brief@azen.test");
    expect(result.payloads.email?.subject).toBe(MODEL.headline);
    expect(result.payloads.email?.html).toContain("<");
    expect(result.payloads.email?.text.length).toBeGreaterThan(0);
    expect(result.payloads.whatsapp).not.toBeNull();
    expect(result.payloads.whatsapp?.to).toBe("+447700900123");
    expect(result.payloads.whatsapp?.body).toContain("MRR up 4%");
  });

  it("dryRun reports the SAME reason codes a live send would (no dryRun/live drift)", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("BRIEF_FROM_EMAIL", "brief@azen.test");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACxxxx");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secrettoken");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "+15005550006");
    const { calls } = stubFetch(jsonResponse({ id: "nope" }));

    // Enabled channels with EMPTY recipients: a preview must not collapse this
    // to "channel_disabled" — it must report the *_no_recipient reason a real
    // send would give for the identical prefs.
    const prefs = {
      email: { to: "" },
      whatsapp: { to: "" },
    };
    const briefIn = {
      headline: MODEL.headline,
      emailModel: MODEL,
      whatsappText: "short",
    };

    const preview = await deliverBrief(briefIn, prefs, { dryRun: true });
    expect(calls).toHaveLength(0);
    expect(preview.email).toEqual({ ok: false, reason: "email_no_recipient" });
    expect(preview.whatsapp).toEqual({
      ok: false,
      reason: "whatsapp_no_recipient",
    });

    const live = await deliverBrief(briefIn, prefs);
    expect(calls).toHaveLength(0); // still no network — no recipient
    expect(live.email).toEqual(preview.email);
    expect(live.whatsapp).toEqual(preview.whatsapp);
  });

  it("sends both channels live when keys are present", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("BRIEF_FROM_EMAIL", "brief@azen.test");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACxxxx");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secrettoken");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "+15005550006");
    // Both channels get a success reply.
    const calls: RecordedCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init: init ?? {} });
        if (url.includes("resend.com")) return jsonResponse({ id: "email-1" });
        return jsonResponse({ sid: "SM-1" });
      }),
    );

    const result = await deliverBrief(
      { headline: MODEL.headline, emailModel: MODEL, whatsappText: "short" },
      { email: { to: "owner@azen.test" }, whatsapp: { to: "+447700900123" } },
    );

    expect(result.dryRun).toBe(false);
    expect(result.email).toEqual({ ok: true, id: "email-1" });
    expect(result.whatsapp).toEqual({ ok: true, id: "SM-1" });
    expect(result.sms).toBeUndefined();
    expect(calls.some((c) => c.url.includes("resend.com"))).toBe(true);
    expect(calls.some((c) => c.url.includes("twilio.com"))).toBe(true);
  });

  it("falls back to SMS after WhatsApp fails twice on a transient error (§9.7)", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("BRIEF_FROM_EMAIL", "");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACxxxx");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secrettoken");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "+15005550006");
    let whatsappCalls = 0;
    let smsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const params = new URLSearchParams((init?.body as string) ?? "");
        const to = params.get("To") ?? "";
        if (to.startsWith("whatsapp:")) {
          whatsappCalls++;
          // 5xx is a transient/server error → retried before SMS fallback.
          return jsonResponse({ message: "internal error" }, 503);
        }
        smsCalls++;
        return jsonResponse({ sid: "SM-sms" });
      }),
    );

    const result = await deliverBrief(
      { headline: MODEL.headline, emailModel: MODEL, whatsappText: "short" },
      {
        email: { enabled: false },
        whatsapp: { to: "+447700900123" },
      },
    );

    expect(whatsappCalls).toBe(2); // failed twice
    expect(smsCalls).toBe(1); // then SMS
    expect(result.whatsapp.ok).toBe(false);
    expect(result.sms).toEqual({ ok: true, id: "SM-sms" });
    expect(result.email).toEqual({ ok: false, reason: "channel_disabled" });
  });

  it("does NOT retry a permanent WhatsApp failure (4xx) but still falls back to SMS", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("BRIEF_FROM_EMAIL", "");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACxxxx");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secrettoken");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "+15005550006");
    let whatsappCalls = 0;
    let smsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const params = new URLSearchParams((init?.body as string) ?? "");
        const to = params.get("To") ?? "";
        if (to.startsWith("whatsapp:")) {
          whatsappCalls++;
          // 400 invalid-number / 401 bad-auth cannot succeed on retry.
          return jsonResponse({ message: "21211 invalid To number" }, 400);
        }
        smsCalls++;
        return jsonResponse({ sid: "SM-sms" });
      }),
    );

    const result = await deliverBrief(
      { headline: MODEL.headline, emailModel: MODEL, whatsappText: "short" },
      {
        email: { enabled: false },
        whatsapp: { to: "+447700900123" },
      },
    );

    expect(whatsappCalls).toBe(1); // single attempt — no pointless retry
    expect(smsCalls).toBe(1); // still a real delivery failure → SMS fallback
    expect(result.whatsapp.ok).toBe(false);
    expect(result.sms).toEqual({ ok: true, id: "SM-sms" });
  });

  it("does NOT fall back to SMS on a WhatsApp config gap (not a delivery failure)", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("BRIEF_FROM_EMAIL", "");
    // No TWILIO_* creds → sendWhatsApp short-circuits to whatsapp_not_configured
    // with zero network. A config gap is NOT a §9.7 delivery failure.
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "");
    let smsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const params = new URLSearchParams((init?.body as string) ?? "");
        const to = params.get("To") ?? "";
        if (!to.startsWith("whatsapp:")) smsCalls++;
        return jsonResponse({ sid: "SM-sms" });
      }),
    );

    const result = await deliverBrief(
      { headline: MODEL.headline, emailModel: MODEL, whatsappText: "short" },
      {
        email: { enabled: false },
        whatsapp: { to: "+447700900123" },
      },
    );

    expect(smsCalls).toBe(0); // no SMS fallback for a misconfiguration
    expect(result.whatsapp).toEqual({
      ok: false,
      reason: "whatsapp_not_configured",
    });
    expect(result.sms).toBeUndefined();
  });
});

describe("renderBriefEmail (@azen/emails)", () => {
  it("returns non-empty html + text containing the headline", async () => {
    const { html, text } = await renderBriefEmail(MODEL);

    expect(html.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(html).toContain(MODEL.headline);
    expect(text).toContain(MODEL.headline);
    // Hero numbers made it into the HTML.
    expect(html).toContain("£12,400.00");
    // Plain-text fallback is not raw HTML tags.
    expect(text).not.toContain("<td");
  });
});
