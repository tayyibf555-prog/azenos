import { ActivationBanner } from "../../components/ActivationBanner";
import { PageHeader } from "../../components/PageHeader";
import {
  getGrowthPipeline,
  getGrowthProposals,
  getGrowthSummary,
} from "../../lib/server/growth";
import { requireOrgId } from "../../lib/server/org";
import { GrowthWorkspace } from "./GrowthWorkspace";

export const dynamic = "force-dynamic";

/**
 * Growth screen (P6-GROWTH; spec §5.7/§5.8): the agency's upsell engine surface.
 * Opportunity insights the Scout surfaced flow through review → convert →
 * proposal, and proposals move draft → ready → sent → won → lost. Won proposals
 * track the revenue the OS generated. All interaction is client-side; this
 * server component only loads the initial pipeline + proposals.
 */
export default async function GrowthPage() {
  let error: string | null = null;
  let pipeline: Awaited<ReturnType<typeof getGrowthPipeline>> = [];
  let proposals: Awaited<ReturnType<typeof getGrowthProposals>> = [];
  let summary: Awaited<ReturnType<typeof getGrowthSummary>> = {
    wonRevenuePence: 0,
    wonCount: 0,
    openProposals: 0,
    openOpportunities: 0,
  };

  try {
    const orgId = await requireOrgId();
    [pipeline, proposals, summary] = await Promise.all([
      getGrowthPipeline(orgId),
      getGrowthProposals(orgId),
      getGrowthSummary(orgId),
    ]);
  } catch (err) {
    console.error("[growth] load failed:", err);
    error = "Could not load the growth pipeline.";
  }

  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

  return (
    <div>
      <PageHeader
        title="Growth"
        subtitle="Turn the Scout's opportunities into client-ready upsell proposals."
      />
      <ActivationBanner missing={hasAnthropicKey ? [] : ["ANTHROPIC_API_KEY"]} />
      {error ? (
        <div className="card" style={{ padding: 20 }}>
          <span className="muted" style={{ fontSize: 13.5 }}>
            {error}
          </span>
        </div>
      ) : (
        <GrowthWorkspace
          initialPipeline={pipeline}
          initialProposals={proposals}
          initialSummary={summary}
        />
      )}
    </div>
  );
}
