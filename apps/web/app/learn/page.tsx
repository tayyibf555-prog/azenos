import { PageHeader } from "../../components/PageHeader";
import {
  getIndustriesWithArticles,
  getIndustryArticles,
} from "../../lib/server/learn";
import { requireOrgId } from "../../lib/server/org";
import { LearnWorkspace } from "./LearnWorkspace";

export const dynamic = "force-dynamic";

/**
 * Learn screen (P6-LEARN; spec §9.6): the industry knowledge base. The Industry
 * Learning agent distils anonymised, aggregate patterns across the agency's
 * projects into durable knowledge_articles (primer, weekly digests, patterns,
 * playbooks) per industry, embedded with Voyage so they're semantically
 * searchable. This server component loads the industry index + the first
 * industry's articles; all browsing + search is client-side.
 */
export default async function LearnPage() {
  let error: string | null = null;
  let industries: Awaited<ReturnType<typeof getIndustriesWithArticles>> = [];
  let firstArticles: Awaited<ReturnType<typeof getIndustryArticles>> = [];

  try {
    const orgId = await requireOrgId();
    industries = await getIndustriesWithArticles(orgId);
    if (industries[0]) {
      firstArticles = await getIndustryArticles(orgId, industries[0].id);
    }
  } catch (err) {
    console.error("[learn] load failed:", err);
    error = "Could not load the knowledge base.";
  }

  return (
    <div>
      <PageHeader
        title="Learn"
        subtitle="What Azen OS has learned across every client in each industry — searchable, evidence-backed, reusable."
      />
      {error ? (
        <div className="card" style={{ padding: 20 }}>
          <span className="muted" style={{ fontSize: 13.5 }}>
            {error}
          </span>
        </div>
      ) : (
        <LearnWorkspace
          initialIndustries={industries}
          initialIndustryId={industries[0]?.id ?? null}
          initialArticles={firstArticles}
        />
      )}
    </div>
  );
}
