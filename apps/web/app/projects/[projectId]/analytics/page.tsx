import Link from "next/link";
import { AnalyticsWorkspace } from "../../../../components/analytics/AnalyticsWorkspace";
import type { AnalyticsProjectView } from "../../../../components/analytics/types";
import { PageHeader } from "../../../../components/PageHeader";
import { getProjectForAnalytics } from "../../../../lib/server/analytics/base";
import { requireOrgId } from "../../../../lib/server/org";

export const dynamic = "force-dynamic";

/**
 * Deep per-project Analytics screen. Loads the project org-scoped (404 if it
 * doesn't belong to this org), then hands a dedicated full-screen workspace the
 * project + orgId. AppFrame chrome is already applied by the root layout, so
 * this renders as a normal app route.
 */
export default async function ProjectAnalyticsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  let project: AnalyticsProjectView | null = null;
  let orgId: string | null = null;
  let dbError: string | null = null;
  try {
    orgId = await requireOrgId();
    const loaded = await getProjectForAnalytics(orgId, projectId);
    if (loaded) {
      const { goals: _goals, ...view } = loaded;
      project = view;
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  if (dbError) {
    return (
      <div className="card empty">
        <span className="empty-title">Couldn&apos;t load analytics</span>
        <span className="faint" style={{ fontSize: 12 }}>
          {dbError}
        </span>
      </div>
    );
  }

  if (!project || !orgId) {
    return (
      <div>
        <PageHeader
          title="Project not found"
          subtitle="It may have been removed, or belong to another workspace."
          actions={
            <Link href="/projects" className="btn">
              ← Projects
            </Link>
          }
        />
      </div>
    );
  }

  return <AnalyticsWorkspace project={project} orgId={orgId} />;
}
