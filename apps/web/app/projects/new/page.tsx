import Link from "next/link";
import { projectStack, projectType } from "@azen/db";
import { NewProjectEntry } from "../../../components/onboarding/NewProjectEntry";
import { PageHeader } from "../../../components/PageHeader";

export const dynamic = "force-dynamic";

export default function NewProjectPage() {
  return (
    <div>
      <PageHeader
        title="New project"
        subtitle="A guided walkthrough from client to first event — or jump straight to the quick form. Either way, creating it mints an ingest key and endpoint."
        actions={
          <Link href="/projects" className="btn">
            ← Projects
          </Link>
        }
      />
      <NewProjectEntry
        types={[...projectType.enumValues]}
        stacks={[...projectStack.enumValues]}
      />
    </div>
  );
}
