import { withErrorHandling } from "../../../../lib/server/http";
import {
  feedbackOptions,
  handleFeedbackRequest,
} from "../../../../lib/server/feedback/intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, browser-embeddable feedback webhook (Phase 7 §B). Least privilege:
// only feedback-kind keys work here; the response never leaks org/project ids.
export const POST = withErrorHandling(
  async (req: Request, ctx: { params: Promise<{ publicKey: string }> }) => {
    const { publicKey } = await ctx.params;
    return handleFeedbackRequest(req, publicKey);
  },
);

// CORS preflight for cross-origin widget embeds.
export function OPTIONS(): Response {
  return feedbackOptions();
}
