import Link from "next/link";
import { projectStack, projectType } from "@azen/db";
import { NewProjectForm } from "../../../components/NewProjectForm";
import { PageHeader } from "../../../components/PageHeader";

export const dynamic = "force-dynamic";

export default function NewProjectPage() {
  return (
    <div>
      <PageHeader
        title="New project"
        subtitle="Draft a project from a call transcript, or fill the form in. Either way, creating it mints an ingest key and endpoint."
        actions={
          <Link href="/projects" className="btn">
            ← Projects
          </Link>
        }
      />
      <NewProjectForm
        types={[...projectType.enumValues]}
        stacks={[...projectStack.enumValues]}
      />
    </div>
  );
}
