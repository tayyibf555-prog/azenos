import { withErrorHandling } from "../../../../lib/server/http";
import { handleIngestRequest } from "../../../../lib/server/ingest/pipeline";

export const runtime = "nodejs";

export const POST = withErrorHandling(
  async (req: Request, ctx: { params: Promise<{ publicKey: string }> }) => {
    const { publicKey } = await ctx.params;
    return handleIngestRequest(req, publicKey);
  },
);
