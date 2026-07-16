"use client";

import { useEffect, useState } from "react";
import { RelativeTime } from "./RelativeTime";
import { healthColor } from "./ui";
import {
  Avatar,
  EmptyState,
  List,
  ListRow,
  StatusDot,
} from "./system";

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  health: string;
  eventsToday: number;
  lastEventAt: string | null;
  client: { id: string; name: string };
}

/**
 * §5 project-health table — dense ListRows (project squircle-avatar · name ·
 * client · health StatusDot · events-today · last-event relative). Reads the
 * SAME /api/projects endpoint the Command Center already consumes (via
 * OverviewHealth) — no new query. Client-only; the page passes no props.
 */
export function ProjectHealthTable() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/projects", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`projects ${res.status}`);
        const json = (await res.json()) as { projects?: ProjectRow[] };
        if (alive) setRows(json.projects ?? []);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return <EmptyState>Couldn&apos;t load projects.</EmptyState>;
  }
  if (rows === null) {
    return (
      <div style={{ display: "grid", gap: 8, padding: "4px 2px" }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton" style={{ height: 28 }} />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return <EmptyState>No projects yet.</EmptyState>;
  }

  return (
    <List>
      {rows.map((p) => (
        <ListRow
          key={p.id}
          href={`/projects/${p.id}`}
          leading={<Avatar name={p.name} size={28} />}
          primary={p.name}
          secondary={p.client.name}
          meta={
            <>
              <StatusDot color={healthColor(p.health)} />
              <span
                className="tnum"
                style={{ fontSize: 12.5, color: "var(--text-2)", minWidth: 42, textAlign: "right" }}
                title="Events today"
              >
                {p.eventsToday} today
              </span>
              <span
                className="faint"
                style={{ fontSize: 11.5, minWidth: 58, textAlign: "right" }}
              >
                {p.lastEventAt ? <RelativeTime value={p.lastEventAt} /> : "—"}
              </span>
            </>
          }
        />
      ))}
    </List>
  );
}
