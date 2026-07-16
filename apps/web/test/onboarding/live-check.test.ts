import { describe, expect, it, vi } from "vitest";
import { fetchLiveCheck } from "../../lib/onboarding/wizard";

/**
 * Step 5's poll tick, exercised with a mocked `fetch` (no DOM/interval
 * needed — `usePolling` just calls this on a timer; the interesting logic,
 * covered here, is what a tick DOES with the response).
 */

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe("fetchLiveCheck", () => {
  it("hits the project's events route with limit=1 and no-store", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ events: [] }));
    await fetchLiveCheck("proj-1", fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/proj-1/events?limit=1",
      { cache: "no-store" },
    );
  });

  it("renders the waiting state while the events page is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ events: [] }));
    const state = await fetchLiveCheck("proj-1", fetchMock);
    expect(state).toEqual({ received: false, eventType: null });
  });

  it("renders the arrived-event state once an event lands", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ events: [{ type: "call.completed" }] }));
    const state = await fetchLiveCheck("proj-1", fetchMock);
    expect(state).toEqual({ received: true, eventType: "call.completed" });
  });

  it("throws on a non-ok response so the caller can show the retrying banner", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    await expect(fetchLiveCheck("proj-1", fetchMock)).rejects.toThrow("events 500");
  });
});
