/**
 * §6.3 step 6 — reaction work runs AFTER the response is sent.
 * On Vercel this must go through waitUntil() or the function freezes before
 * the work finishes; locally a detached promise is fine. @vercel/functions
 * is resolved dynamically so local dev needs no extra dependency — add it to
 * apps/web when deploying (docs/DECISIONS.md).
 */
export function runAfterResponse(task: () => Promise<unknown>): void {
  const run = async () => {
    try {
      const mod = (await import(
        /* webpackIgnore: true */ "@vercel/functions" as string
      )) as { waitUntil?: (p: Promise<unknown>) => void };
      if (typeof mod.waitUntil === "function") {
        mod.waitUntil(task());
        return;
      }
    } catch {
      // not on Vercel — fall through to detached execution
    }
    task().catch((err) => {
      console.error("[after-response] reaction failed:", err);
    });
  };
  void run();
}
