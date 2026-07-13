import Link from "next/link";
import { PageHeader } from "../../components/PageHeader";

export default function ComingSoonPage() {
  return (
    <div>
      <PageHeader
        title="Coming soon"
        subtitle="This section arrives in a later phase of Azen OS."
      />
      <div className="card empty">
        <span className="empty-title">Not built yet</span>
        <span style={{ fontSize: 13, maxWidth: 420 }}>
          Phase 1 covers the Command Center, Clients, and Projects. Money,
          Bookings, Briefs, Growth, Learn, and Ask land in later phases.
        </span>
        <Link href="/" className="btn btn-sm" style={{ marginTop: 8 }}>
          Back to Command Center
        </Link>
      </div>
    </div>
  );
}
