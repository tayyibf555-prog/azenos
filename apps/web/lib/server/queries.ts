import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  isNull,
  like,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  agentRuns,
  aggregateValueSQL,
  bookings,
  briefs,
  bucketStartSQL,
  clients,
  db,
  events,
  expenses,
  feedbackItems,
  industries,
  insights,
  isoUTC,
  londonMonthStartUTC,
  londonTodayUTC,
  metricDefinitions,
  metricRollups,
  organizations,
  payments,
  projectKeys,
  projects,
  runRollups,
  subscriptions,
  toEvaluable,
  upsellProposals,
  webhookDeliveries,
  type Aggregation,
  type Db,
} from "@azen/db";
import { DEFAULT_HOURLY_RATE_PENCE } from "@azen/config";
import {
  generateFeedbackKey,
  generateKeyPair,
  generateSecret,
} from "@azen/db/keys";
import {
  encodeEventsCursor,
  type ClientCreateInput,
  type EventsCursor,
  type InsightsQuery,
  type MetricDefinitionInput,
  type MetricSeriesQuery,
  type ProjectCreateInput,
  type ProjectPatchInput,
} from "./schemas";

/**
 * Shared DB access for the dashboard API (docs/phase1/CONTRACTS.md, workstream
 * C). Every function takes orgId from requireOrgId() and scopes every query by
 * it — a missing row and a cross-org row are indistinguishable to callers.
 * Key secrets: only publicKey/hash/ciphertext live in the DB; the helpers here
 * either select an explicit column list without the secret columns, or return
 * the freshly generated plaintext (create/rotate/revoke — shown once).
 */

const dateOrNull = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(v as string | Date);

/** A db handle or a transaction — PgTransaction lacks the driver's $client. */
type DbConn = Omit<Db, "$client">;

// ── overview ─────────────────────────────────────────────────────────────────

export interface Overview {
  mrrPence: number;
  activeClients: number;
  liveProjects: number;
  eventsTotal: number;
  clientBookingsThisMonth: number;
}

export async function getOverview(orgId: string): Promise<Overview> {
  // raw sql`` params bypass column encoders — Dates must go over as ISO text
  const monthStart = londonMonthStartUTC(0).toISOString();
  const [row] = await db
    .select({
      mrrPence:
        sql<number>`coalesce((select sum(${subscriptions.amountPenceMonthly}) from ${subscriptions} where ${subscriptions.orgId} = ${orgId} and ${subscriptions.status} = 'active'), 0)`.mapWith(
          Number,
        ),
      activeClients:
        sql<number>`(select count(*) from ${clients} where ${clients.orgId} = ${orgId} and ${clients.status} = 'active')`.mapWith(
          Number,
        ),
      liveProjects:
        sql<number>`(select count(*) from ${projects} where ${projects.orgId} = ${orgId} and ${projects.status} = 'live')`.mapWith(
          Number,
        ),
      eventsTotal:
        sql<number>`(select count(*) from ${events} where ${events.orgId} = ${orgId})`.mapWith(
          Number,
        ),
      clientBookingsThisMonth:
        sql<number>`(select count(*) from ${bookings} where ${bookings.orgId} = ${orgId} and ${bookings.kind} = 'client_end_customer' and ${bookings.startsAt} >= ${monthStart}::timestamptz)`.mapWith(
          Number,
        ),
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return (
    row ?? {
      mrrPence: 0,
      activeClients: 0,
      liveProjects: 0,
      eventsTotal: 0,
      clientBookingsThisMonth: 0,
    }
  );
}

// ── ticker ───────────────────────────────────────────────────────────────────

export async function getTickerEvents(
  orgId: string,
  { afterId, limit }: { afterId?: string; limit: number },
) {
  // afterId → strictly newer received_at than that event's. An afterId we
  // can't see in this org just means no lower bound (client re-syncs).
  let after: Date | undefined;
  if (afterId) {
    const [ref] = await db
      .select({ receivedAt: events.receivedAt })
      .from(events)
      .where(and(eq(events.orgId, orgId), eq(events.id, afterId)))
      .limit(1);
    after = ref?.receivedAt;
  }
  return db
    .select({
      id: events.id,
      type: events.type,
      occurredAt: events.occurredAt,
      receivedAt: events.receivedAt,
      projectId: events.projectId,
      projectName: sql<string>`coalesce(${projects.name}, 'Agency')`,
      projectSlug: sql<string | null>`${projects.slug}`,
      subjectName: sql<string | null>`${events.subject}->>'name'`,
      valuePence: events.valuePence,
      minutesSaved: events.minutesSaved,
    })
    .from(events)
    .leftJoin(projects, eq(events.projectId, projects.id))
    .where(
      and(
        eq(events.orgId, orgId),
        after ? gt(events.receivedAt, after) : undefined,
      ),
    )
    .orderBy(desc(events.receivedAt), desc(events.id))
    .limit(limit);
}

// ── clients ──────────────────────────────────────────────────────────────────

export async function listClients(orgId: string) {
  return db
    .select({
      id: clients.id,
      name: clients.name,
      status: clients.status,
      industrySlug: sql<string | null>`${industries.slug}`,
      projectCount: sql<number>`count(${projects.id})`.mapWith(Number),
      createdAt: clients.createdAt,
    })
    .from(clients)
    .leftJoin(industries, eq(clients.industryId, industries.id))
    .leftJoin(projects, eq(projects.clientId, clients.id))
    .where(eq(clients.orgId, orgId))
    .groupBy(clients.id, industries.id)
    .orderBy(desc(clients.createdAt), desc(clients.id));
}

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Reuse this org's industries row by slug, else create one named from the
 * slug. industries.slug is globally unique in the Phase 0 schema, so a
 * cross-org slug collision throws (single-org reality until real auth).
 */
async function resolveIndustryId(
  conn: DbConn,
  orgId: string,
  rawSlug: string,
): Promise<string> {
  const slug = rawSlug.trim().toLowerCase();
  const [existing] = await conn
    .select({ id: industries.id })
    .from(industries)
    .where(and(eq(industries.orgId, orgId), eq(industries.slug, slug)))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await conn
    .insert(industries)
    .values({ orgId, slug, name: titleCaseSlug(slug) })
    .returning({ id: industries.id });
  if (!created) throw new Error("industry insert returned no row");
  return created.id;
}

export async function createClient(orgId: string, input: ClientCreateInput) {
  return db.transaction(async (tx) => {
    const industryId = input.industrySlug
      ? await resolveIndustryId(tx, orgId, input.industrySlug)
      : undefined;
    const [client] = await tx
      .insert(clients)
      .values({ orgId, name: input.name, industryId, status: input.status })
      .returning();
    if (!client) throw new Error("client insert returned no row");
    return client;
  });
}

// ── projects list (one grouped query — no N+1) ──────────────────────────────

export async function listProjects(orgId: string) {
  // "Today" = the current Europe/London day, computed with the SAME SQL
  // boundary as the rollup engine (packages/db/src/rollup) so the live
  // counter and the rollups agree — and so it's DST-correct (the JS
  // londonTodayUTC() helper is UTC-midnight-of-the-London-date, an hour off
  // during BST, fine for date strings but wrong as a timestamp boundary).
  const eventAgg = db.$with("event_agg").as(
    db
      .select({
        projectId: events.projectId,
        lastEventAt: sql<Date | null>`max(${events.occurredAt})`.as(
          "last_event_at",
        ),
        eventsToday:
          sql<number>`count(*) filter (where ${events.occurredAt} >= date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London')`.as(
            "events_today",
          ),
      })
      .from(events)
      .where(eq(events.orgId, orgId))
      .groupBy(events.projectId),
  );
  const latestKey = db.$with("latest_key").as(
    db
      .selectDistinctOn([projectKeys.projectId], {
        projectId: projectKeys.projectId,
        publicKey: projectKeys.publicKey,
      })
      .from(projectKeys)
      .where(and(eq(projectKeys.orgId, orgId), isNull(projectKeys.revokedAt)))
      .orderBy(projectKeys.projectId, desc(projectKeys.createdAt)),
  );
  const rows = await db
    .with(eventAgg, latestKey)
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      status: projects.status,
      health: projects.health,
      type: projects.type,
      stack: projects.stack,
      retainerPenceMonthly: projects.retainerPenceMonthly,
      clientId: clients.id,
      clientName: clients.name,
      publicKey: sql<string | null>`${latestKey.publicKey}`,
      lastEventAt: sql`${eventAgg.lastEventAt}`.mapWith(dateOrNull),
      eventsToday: sql<number>`coalesce(${eventAgg.eventsToday}, 0)`.mapWith(
        Number,
      ),
    })
    .from(projects)
    .innerJoin(clients, eq(projects.clientId, clients.id))
    .leftJoin(eventAgg, eq(eventAgg.projectId, projects.id))
    .leftJoin(latestKey, eq(latestKey.projectId, projects.id))
    .where(eq(projects.orgId, orgId))
    .orderBy(desc(projects.createdAt), desc(projects.id));

  return rows.map(({ clientId, clientName, ...rest }) => ({
    ...rest,
    client: { id: clientId, name: clientName },
  }));
}

// ── project create ───────────────────────────────────────────────────────────

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "project"
  );
}

/**
 * projects.slug is globally unique — the collision scan must cross orgs
 * (existence only; nothing about other orgs is returned to the caller).
 */
async function availableSlug(conn: DbConn, base: string): Promise<string> {
  const taken = new Set(
    (
      await conn
        .select({ slug: projects.slug })
        .from(projects)
        .where(or(eq(projects.slug, base), like(projects.slug, `${base}-%`)))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

export type CreateProjectResult =
  | { ok: false; error: "client_not_found" }
  | {
      ok: true;
      project: typeof projects.$inferSelect;
      key: { publicKey: string; secret: string; authMode: "hmac" | "token" };
      /** Phase 7 §B: the public feedback-widget key (no secret). */
      feedbackPublicKey: string;
    };

export async function createProject(
  orgId: string,
  input: ProjectCreateInput,
): Promise<CreateProjectResult> {
  return db.transaction(async (tx): Promise<CreateProjectResult> => {
    let clientId: string;
    if (input.clientId !== undefined) {
      const [existing] = await tx
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.orgId, orgId), eq(clients.id, input.clientId)))
        .limit(1);
      if (!existing) return { ok: false, error: "client_not_found" };
      clientId = existing.id;
    } else if (input.newClient !== undefined) {
      const industryId = input.newClient.industrySlug
        ? await resolveIndustryId(tx, orgId, input.newClient.industrySlug)
        : undefined;
      const [created] = await tx
        .insert(clients)
        .values({ orgId, name: input.newClient.name, industryId })
        .returning({ id: clients.id });
      if (!created) throw new Error("client insert returned no row");
      clientId = created.id;
    } else {
      throw new Error("unreachable: schema enforces clientId xor newClient");
    }

    const slug = await availableSlug(tx, slugify(input.name));
    const [project] = await tx
      .insert(projects)
      .values({
        orgId,
        clientId,
        name: input.name,
        slug,
        description: input.description,
        type: input.type,
        stack: input.stack,
        status: "building",
        retainerPenceMonthly: input.retainerPenceMonthly,
        buildFeePence: input.buildFeePence,
        hourlyRatePence: input.hourlyRatePence,
        goals: input.goals ?? [],
      })
      .returning();
    if (!project) throw new Error("project insert returned no row");

    const authMode = "hmac" as const;
    const pair = generateKeyPair();
    await tx.insert(projectKeys).values({
      orgId,
      projectId: project.id,
      publicKey: pair.publicKey,
      secretHash: pair.secretHash,
      secretCiphertext: pair.secretCiphertext,
      authMode,
      kind: "ingest",
    });
    // Phase 7 §B: also provision a PUBLIC feedback key (no secret shipped) so
    // the embeddable widget works the moment a project exists.
    const fb = generateFeedbackKey();
    await tx.insert(projectKeys).values({
      orgId,
      projectId: project.id,
      publicKey: fb.publicKey,
      secretHash: fb.secretHash,
      authMode: "token",
      kind: "feedback",
      label: "feedback widget key",
    });
    return {
      ok: true,
      project,
      key: { publicKey: pair.publicKey, secret: pair.secret, authMode },
      feedbackPublicKey: fb.publicKey,
    };
  });
}

// ── project detail / patch ───────────────────────────────────────────────────

export async function projectExists(
  orgId: string,
  projectId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
    .limit(1);
  return row !== undefined;
}

export async function getProjectWithClient(orgId: string, projectId: string) {
  const [row] = await db
    .select({ project: projects, client: clients })
    .from(projects)
    .innerJoin(clients, eq(projects.clientId, clients.id))
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
    .limit(1);
  return row;
}

export async function listProjectKeys(orgId: string, projectId: string) {
  return db
    .select({
      id: projectKeys.id,
      publicKey: projectKeys.publicKey,
      authMode: projectKeys.authMode,
      rateLimitPer10s: projectKeys.rateLimitPer10s,
      createdAt: projectKeys.createdAt,
      revokedAt: projectKeys.revokedAt,
      lastUsedAt: projectKeys.lastUsedAt,
      label: projectKeys.label,
    })
    .from(projectKeys)
    .where(
      and(eq(projectKeys.orgId, orgId), eq(projectKeys.projectId, projectId)),
    )
    .orderBy(desc(projectKeys.createdAt));
}

export async function listEventTypesSeen(orgId: string, projectId: string) {
  return db
    .select({
      type: events.type,
      count: sql<number>`count(*)`.mapWith(Number),
      lastAt: sql`max(${events.occurredAt})`.mapWith(
        (v: unknown) => new Date(v as string | Date),
      ),
    })
    .from(events)
    .where(and(eq(events.orgId, orgId), eq(events.projectId, projectId)))
    .groupBy(events.type)
    .orderBy(desc(sql`count(*)`), asc(events.type));
}

export async function updateProject(
  orgId: string,
  projectId: string,
  patch: ProjectPatchInput,
) {
  const [row] = await db
    .update(projects)
    .set(patch)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
    .returning();
  return row;
}

/**
 * Owner action: permanently delete a project. A cross-org or unknown id is an
 * indistinguishable "not found" (returns false → the route answers 404 and
 * nothing is touched). One transaction handles EVERY foreign key against
 * `projects` deliberately (verified against live information_schema):
 *
 *  - AGENCY-LEDGER money must SURVIVE (two-ledger rule §10). payments,
 *    subscriptions and expenses are the org's own money history — re-point them
 *    to project_id NULL, never delete, or MRR/cash reporting corrupts.
 *  - upsell_proposals.project_id is NULLABLE → SET NULL preserves won-revenue
 *    history at the client level (the proposal still belongs to the client).
 *  - Project-scoped record data DIES with the project: events, bookings and
 *    insights where project_id matches, plus project-scoped briefs
 *    (scope='project'). Org-level rows (project_id NULL / scope='agency') are
 *    untouched by definition.
 *  - Everything else FK'd to projects is handled by the DB: ON DELETE CASCADE
 *    (alert_rules, feedback_items, metric_definitions, metric_rollups,
 *    project_credentials, project_integrations, project_keys,
 *    rollup_watermarks) or ON DELETE SET NULL (agent_runs — AI cost history
 *    survives unattributed). Deleting the project row last fires those.
 *
 * Statements are ordered so the NO-ACTION foreign keys are cleared BEFORE the
 * project row is removed — no FK violation is ever possible.
 */
export async function deleteProject(
  orgId: string,
  projectId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Existence + org scope in one shot; a cross-org row never matches → false.
    const [found] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
      .limit(1);
    if (!found) return false;

    // 1. AGENCY-LEDGER money survives — re-point to NULL (never delete: §10).
    await tx
      .update(payments)
      .set({ projectId: null })
      .where(and(eq(payments.orgId, orgId), eq(payments.projectId, projectId)));
    await tx
      .update(subscriptions)
      .set({ projectId: null })
      .where(
        and(
          eq(subscriptions.orgId, orgId),
          eq(subscriptions.projectId, projectId),
        ),
      );
    await tx
      .update(expenses)
      .set({ projectId: null })
      .where(and(eq(expenses.orgId, orgId), eq(expenses.projectId, projectId)));

    // 2. Upsell proposals: project_id is nullable → SET NULL keeps the
    //    won-revenue history attached to the client.
    await tx
      .update(upsellProposals)
      .set({ projectId: null })
      .where(
        and(
          eq(upsellProposals.orgId, orgId),
          eq(upsellProposals.projectId, projectId),
        ),
      );

    // 3. Project-scoped record data dies with the project.
    await tx
      .delete(events)
      .where(and(eq(events.orgId, orgId), eq(events.projectId, projectId)));
    await tx
      .delete(bookings)
      .where(and(eq(bookings.orgId, orgId), eq(bookings.projectId, projectId)));
    await tx
      .delete(insights)
      .where(and(eq(insights.orgId, orgId), eq(insights.projectId, projectId)));
    // Only project-scoped briefs; agency briefs (scope='agency') are untouched.
    await tx
      .delete(briefs)
      .where(
        and(
          eq(briefs.orgId, orgId),
          eq(briefs.scope, "project"),
          eq(briefs.projectId, projectId),
        ),
      );

    // 4. Finally the project row — DB-level CASCADE (project_keys,
    //    project_credentials, project_integrations, metric_definitions,
    //    metric_rollups, rollup_watermarks, alert_rules, feedback_items) and
    //    SET NULL (agent_runs) fire here.
    await tx
      .delete(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));
    return true;
  });
}

// ── keys: rotate / revoke ────────────────────────────────────────────────────

async function findActiveKey(
  orgId: string,
  projectId: string,
  kind: "ingest" | "feedback" = "ingest",
) {
  const [key] = await db
    .select({
      id: projectKeys.id,
      publicKey: projectKeys.publicKey,
      authMode: projectKeys.authMode,
      rateLimitPer10s: projectKeys.rateLimitPer10s,
    })
    .from(projectKeys)
    .where(
      and(
        eq(projectKeys.orgId, orgId),
        eq(projectKeys.projectId, projectId),
        eq(projectKeys.kind, kind),
        isNull(projectKeys.revokedAt),
      ),
    )
    .orderBy(desc(projectKeys.createdAt))
    .limit(1);
  return key;
}

/** New secret under the same public key; the old secret dies now (§6.1). */
export async function rotateActiveKey(orgId: string, projectId: string) {
  const key = await findActiveKey(orgId, projectId, "ingest");
  if (!key) return null;
  const material = generateSecret();
  await db
    .update(projectKeys)
    .set({
      secretHash: material.secretHash,
      secretCiphertext: material.secretCiphertext,
    })
    .where(eq(projectKeys.id, key.id));
  return { publicKey: key.publicKey, secret: material.secret };
}

/** Revoke the active ingest key and issue a fresh pair — new URL (§6.1). */
export async function revokeAndReissueKey(orgId: string, projectId: string) {
  const key = await findActiveKey(orgId, projectId, "ingest");
  if (!key) return null;
  const pair = generateKeyPair();
  await db.transaction(async (tx) => {
    await tx
      .update(projectKeys)
      .set({ revokedAt: new Date() })
      .where(eq(projectKeys.id, key.id));
    await tx.insert(projectKeys).values({
      orgId,
      projectId,
      publicKey: pair.publicKey,
      secretHash: pair.secretHash,
      secretCiphertext: pair.secretCiphertext,
      authMode: key.authMode,
      rateLimitPer10s: key.rateLimitPer10s,
      kind: "ingest",
    });
  });
  return {
    publicKey: pair.publicKey,
    secret: pair.secret,
    authMode: key.authMode,
  };
}

/**
 * Phase 7 §B: revoke the active PUBLIC feedback key and mint a new one. There
 * is no secret to rotate, so this is the only feedback-key lifecycle op — the
 * old widget key stops working immediately and every embed must be re-pasted.
 */
export async function revokeAndReissueFeedbackKey(
  orgId: string,
  projectId: string,
) {
  const key = await findActiveKey(orgId, projectId, "feedback");
  const fb = generateFeedbackKey();
  await db.transaction(async (tx) => {
    if (key) {
      await tx
        .update(projectKeys)
        .set({ revokedAt: new Date() })
        .where(eq(projectKeys.id, key.id));
    }
    await tx.insert(projectKeys).values({
      orgId,
      projectId,
      publicKey: fb.publicKey,
      secretHash: fb.secretHash,
      authMode: "token",
      kind: "feedback",
      label: "feedback widget key",
    });
  });
  return { publicKey: fb.publicKey };
}

// ── project events (keyset pagination) ───────────────────────────────────────

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface ProjectEventsFilters {
  type?: string;
  q?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: EventsCursor;
}

export async function listProjectEvents(
  orgId: string,
  projectId: string,
  filters: ProjectEventsFilters,
) {
  const conds = [eq(events.orgId, orgId), eq(events.projectId, projectId)];
  if (filters.type) conds.push(eq(events.type, filters.type));
  if (filters.from) conds.push(gte(events.occurredAt, new Date(filters.from)));
  if (filters.to) {
    if (filters.to.includes("T")) {
      conds.push(lte(events.occurredAt, new Date(filters.to)));
    } else {
      // bare date = inclusive whole day (UTC midnight boundaries — the seed's
      // 8-19 UTC band keeps UTC and London calendar dates in agreement)
      const end = new Date(`${filters.to}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      conds.push(lt(events.occurredAt, end));
    }
  }
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    const qCond = or(
      sql`${events.data}::text ilike ${pattern}`,
      sql`${events.subject}->>'name' ilike ${pattern}`,
      ilike(events.type, pattern),
    );
    if (qCond) conds.push(qCond);
  }
  if (filters.cursor) {
    // row-value keyset predicate; ISO text param (raw sql`` skips encoders)
    conds.push(
      sql`(${events.occurredAt}, ${events.id}) < (${filters.cursor.occurredAt.toISOString()}::timestamptz, ${filters.cursor.id}::uuid)`,
    );
  }
  const rows = await db
    .select()
    .from(events)
    .where(and(...conds))
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(filters.limit);
  const last = rows.length === filters.limit ? rows[rows.length - 1] : undefined;
  return {
    events: rows,
    nextCursor: last ? encodeEventsCursor(last.occurredAt, last.id) : null,
  };
}

// ── deliveries ───────────────────────────────────────────────────────────────

export async function listProjectDeliveries(
  orgId: string,
  projectId: string,
  limit: number,
) {
  // raw can contain end-customer data — expose only its presence
  return db
    .select({
      id: webhookDeliveries.id,
      status: webhookDeliveries.status,
      httpStatus: webhookDeliveries.httpStatus,
      latencyMs: webhookDeliveries.latencyMs,
      error: webhookDeliveries.error,
      receivedAt: webhookDeliveries.receivedAt,
      hasRaw: sql<boolean>`(${webhookDeliveries.raw} is not null)`.mapWith(
        (v: unknown) => v === true || v === "t",
      ),
    })
    .from(webhookDeliveries)
    .innerJoin(projectKeys, eq(webhookDeliveries.projectKeyId, projectKeys.id))
    .where(
      and(
        eq(webhookDeliveries.orgId, orgId),
        eq(projectKeys.projectId, projectId),
      ),
    )
    .orderBy(desc(webhookDeliveries.receivedAt), desc(webhookDeliveries.id))
    .limit(limit);
}

// ═══════════════════════════════════════════════════════════════════════════
// M2 (wave 2): metrics read API + ROI + insights + sparklines + costs
// (docs/phase2/CONTRACTS.md §Metrics/read API + ADDENDUM §B). Append-only per
// M2 ownership. series/roi/costs read from metric_rollups (day buckets; London
// month/day boundaries computed in SQL so DST is correct); derived ratio keys
// are computed here from two underlying series; preview evaluates a definition
// over RAW events WITHOUT writing (reuses @azen/db's bucket/value/aggregate SQL
// helpers — no forked bucket math). raw sql`` numerics/bigints come back as
// strings from postgres.js, so every aggregate is coerced with Number().
// ═══════════════════════════════════════════════════════════════════════════

type RollupPeriodName = "hour" | "day" | "week" | "month";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** YYYY-MM-DD of a Date's UTC calendar day (our London-day Dates are UTC midnight). */
const toDateStr = (d: Date): string => d.toISOString().slice(0, 10);

function shiftDateStr(dateStr: string, deltaDays: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return toDateStr(d);
}

/** Inclusive calendar-day count between two YYYY-MM-DD strings. */
function daysInclusive(fromStr: string, toStr: string): number {
  const a = Date.parse(`${fromStr}T00:00:00Z`);
  const b = Date.parse(`${toStr}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

/** UTC instant of Europe/London midnight on `dateStr` (DST-correct via Postgres). */
function londonInstant(dateStr: string): SQL {
  return sql`(${dateStr}::date)::timestamp at time zone 'Europe/London'`;
}

/** [start, end) London-month window as UTC instants. month = 'YYYY-MM'. */
function londonMonthBounds(month: string): { start: SQL; end: SQL } {
  const first = `${month}-01`;
  return {
    start: sql`(${first}::date)::timestamp at time zone 'Europe/London'`,
    end: sql`(${first}::date + interval '1 month')::timestamp at time zone 'Europe/London'`,
  };
}

/** Current Europe/London calendar month as 'YYYY-MM'. */
function currentLondonMonth(): string {
  return toDateStr(londonTodayUTC()).slice(0, 7);
}

// ── effective metric definitions (with description + isCustom) ───────────────
// The engine's resolveEffectiveDefinitions omits description/projectId; the read
// API needs both (isCustom = a project-level row exists), so it re-resolves here.

export interface EffectiveMetricDefinition {
  key: string;
  name: string;
  description: string | null;
  unit: string;
  aggregation: Aggregation;
  eventType: string;
  valuePath: string | null;
  whereEquals: Record<string, string | number | boolean> | null;
  goodDirection: "up" | "down";
  isKpi: boolean;
  sort: number;
  isCustom: boolean;
}

export async function resolveEffectiveMetricDefinitions(
  orgId: string,
  projectId: string,
): Promise<EffectiveMetricDefinition[]> {
  const rows = await db
    .select({
      key: metricDefinitions.key,
      name: metricDefinitions.name,
      description: metricDefinitions.description,
      unit: metricDefinitions.unit,
      aggregation: metricDefinitions.aggregation,
      eventType: metricDefinitions.eventType,
      valuePath: metricDefinitions.valuePath,
      whereEquals: metricDefinitions.whereEquals,
      goodDirection: metricDefinitions.goodDirection,
      isKpi: metricDefinitions.isKpi,
      sort: metricDefinitions.sort,
      projectId: metricDefinitions.projectId,
    })
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.orgId, orgId),
        or(
          eq(metricDefinitions.projectId, projectId),
          isNull(metricDefinitions.projectId),
        ),
      ),
    );

  const byKey = new Map<string, EffectiveMetricDefinition>();
  for (const r of rows) {
    const existing = byKey.get(r.key);
    if (existing && r.projectId === null) continue; // project override wins
    byKey.set(r.key, {
      key: r.key,
      name: r.name,
      description: r.description,
      unit: r.unit,
      aggregation: r.aggregation,
      eventType: r.eventType,
      valuePath: r.valuePath,
      whereEquals: r.whereEquals,
      goodDirection: r.goodDirection,
      isKpi: r.isKpi,
      sort: r.sort,
      isCustom: r.projectId !== null,
    });
  }
  return [...byKey.values()].sort(
    (a, b) => a.sort - b.sort || a.key.localeCompare(b.key),
  );
}

// ── derived ratio metrics (§Metrics/read API virtual keys) ───────────────────
// Each is num/den of two underlying series (percent, 0-100, null when den 0).
// no_show_rate's numerator has no seeded metric key, so it counts booking.no_show
// events directly (same bucket SQL as the engine) — the others read rollups.

type DerivedSource =
  | { kind: "metric"; key: string }
  | { kind: "event"; eventType: string };

interface DerivedSpec {
  name: string;
  goodDirection: "up" | "down";
  num: DerivedSource;
  den: DerivedSource;
}

const DERIVED_METRICS: Record<string, DerivedSpec> = {
  agent_success_rate: {
    name: "Agent success rate",
    goodDirection: "up",
    num: { kind: "metric", key: "agent_runs_succeeded" },
    den: { kind: "metric", key: "agent_runs" },
  },
  escalation_rate: {
    name: "Escalation rate",
    goodDirection: "down",
    num: { kind: "metric", key: "escalations" },
    den: { kind: "metric", key: "conversations" },
  },
  no_show_rate: {
    name: "No-show rate",
    goodDirection: "down",
    num: { kind: "event", eventType: "booking.no_show" },
    den: { kind: "metric", key: "bookings_created" },
  },
};
const DERIVED_ORDER = [
  "agent_success_rate",
  "escalation_rate",
  "no_show_rate",
] as const;

// ── GET /metrics (effective defs + virtual derived keys) ─────────────────────

export interface MetricDefinitionView {
  key: string;
  name: string;
  description: string | null;
  unit: string;
  aggregation: string;
  eventType: string;
  valuePath: string | null;
  whereEquals: Record<string, string | number | boolean> | null;
  goodDirection: "up" | "down";
  isKpi: boolean;
  sort: number;
  isCustom: boolean;
  isDerived: boolean;
}

export async function getProjectMetrics(
  orgId: string,
  projectId: string,
): Promise<{ definitions: MetricDefinitionView[] }> {
  const effective = await resolveEffectiveMetricDefinitions(orgId, projectId);
  const definitions: MetricDefinitionView[] = effective.map((d) => ({
    ...d,
    isDerived: false,
  }));
  DERIVED_ORDER.forEach((key, i) => {
    const d = DERIVED_METRICS[key]!;
    definitions.push({
      key,
      name: d.name,
      description: null,
      unit: "percent",
      aggregation: "rate",
      eventType: "derived",
      valuePath: null,
      whereEquals: null,
      goodDirection: d.goodDirection,
      isKpi: false,
      sort: 1000 + i,
      isCustom: false,
      isDerived: true,
    });
  });
  return { definitions };
}

// ── POST /metrics (create custom def) + scoped recompute ─────────────────────

const CUSTOM_METRIC_SORT = 500;

export type CreateMetricResult =
  | { ok: true; definition: MetricDefinitionView }
  | { ok: false; error: "duplicate" | "invalid_definition" };

export async function createProjectMetric(
  orgId: string,
  projectId: string,
  input: MetricDefinitionInput,
): Promise<CreateMetricResult> {
  const goodDirection = input.goodDirection ?? "up";
  const isKpi = input.isKpi ?? false;
  const valuePath = input.valuePath ?? null;
  const whereEquals = input.whereEquals ?? null;

  // Reject definitions the SQL grammar can't evaluate — otherwise the engine
  // would silently skip them and the metric would never gather data.
  const evaluable = toEvaluable({
    key: input.key,
    name: input.name,
    unit: input.unit,
    aggregation: input.aggregation,
    eventType: input.eventType,
    valuePath,
    whereEquals,
    goodDirection,
    isKpi,
    sort: CUSTOM_METRIC_SORT,
  });
  if (evaluable === null) return { ok: false, error: "invalid_definition" };

  const [existing] = await db
    .select({ id: metricDefinitions.id })
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.orgId, orgId),
        eq(metricDefinitions.projectId, projectId),
        eq(metricDefinitions.key, input.key),
      ),
    )
    .limit(1);
  if (existing) return { ok: false, error: "duplicate" };

  const [row] = await db
    .insert(metricDefinitions)
    .values({
      orgId,
      projectId,
      key: input.key,
      name: input.name,
      description: input.description,
      unit: input.unit,
      aggregation: input.aggregation,
      eventType: input.eventType,
      valuePath,
      whereEquals,
      goodDirection,
      isKpi,
      sort: CUSTOM_METRIC_SORT,
    })
    .returning();
  if (!row) throw new Error("metric definition insert returned no row");

  return {
    ok: true,
    definition: {
      key: row.key,
      name: row.name,
      description: row.description,
      unit: row.unit,
      aggregation: row.aggregation,
      eventType: row.eventType,
      valuePath: row.valuePath,
      whereEquals: row.whereEquals,
      goodDirection: row.goodDirection,
      isKpi: row.isKpi,
      sort: row.sort,
      isCustom: true,
      isDerived: false,
    },
  };
}

/** Force-recompute this project's rollups over the trailing 30 days so a newly
 * created custom metric has data immediately (contract: POST triggers recompute). */
export async function recomputeProjectMetrics(
  orgId: string,
  projectId: string,
): Promise<void> {
  await runRollups(db, {
    orgId,
    projectId,
    force: true,
    forceWindowDays: 30,
  });
}

// ── DELETE /metrics/[key] (project-level custom only) ────────────────────────

export async function deleteProjectMetric(
  orgId: string,
  projectId: string,
  key: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(metricDefinitions)
      .where(
        and(
          eq(metricDefinitions.orgId, orgId),
          // project-level only; a global (project_id NULL) never matches → 404
          eq(metricDefinitions.projectId, projectId),
          eq(metricDefinitions.key, key),
        ),
      )
      .returning({ id: metricDefinitions.id });
    if (deleted.length === 0) return false;
    await tx
      .delete(metricRollups)
      .where(
        and(
          eq(metricRollups.projectId, projectId),
          eq(metricRollups.metricKey, key),
        ),
      );
    return true;
  });
}

// ── series (rollup reads + derived ratios, with optional compare window) ─────

type IsoValueMap = Map<string, number>;

async function fetchRollupSeries(
  projectId: string,
  period: string,
  keys: string[],
  start: SQL,
  end: SQL,
): Promise<Map<string, IsoValueMap>> {
  const out = new Map<string, IsoValueMap>();
  if (keys.length === 0) return out;
  const keyList = sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    select metric_key, ${isoUTC(sql`period_start`)} as period_start, value
    from metric_rollups
    where project_id = ${projectId}::uuid
      and period = ${period}::rollup_period
      and metric_key in (${keyList})
      and period_start >= ${start}
      and period_start < ${end}
    order by period_start asc
  `)) as unknown as {
    metric_key: string;
    period_start: string;
    value: unknown;
  }[];
  for (const r of rows) {
    let m = out.get(r.metric_key);
    if (!m) {
      m = new Map();
      out.set(r.metric_key, m);
    }
    m.set(r.period_start, Number(r.value));
  }
  return out;
}

async function fetchEventCountSeries(
  projectId: string,
  eventTypes: string[],
  period: string,
  start: SQL,
  end: SQL,
): Promise<Map<string, IsoValueMap>> {
  const out = new Map<string, IsoValueMap>();
  if (eventTypes.length === 0) return out;
  const typeList = sql.join(
    eventTypes.map((t) => sql`${t}`),
    sql`, `,
  );
  // Pre-filter on occurred_at >= start (safe lower bound), then keep only buckets
  // whose START falls inside the window so the counts align with rollup periods.
  const rows = (await db.execute(sql`
    select type, ${isoUTC(sql`bucket`)} as period_start, count(*)::int as value
    from (
      select e.type as type, ${bucketStartSQL(period as RollupPeriodName)} as bucket
      from events e
      where e.project_id = ${projectId}::uuid
        and e.type in (${typeList})
        and e.occurred_at >= ${start}
    ) sub
    where bucket >= ${start} and bucket < ${end}
    group by type, bucket
    order by bucket asc
  `)) as unknown as { type: string; period_start: string; value: number }[];
  for (const r of rows) {
    let m = out.get(r.type);
    if (!m) {
      m = new Map();
      out.set(r.type, m);
    }
    m.set(r.period_start, Number(r.value));
  }
  return out;
}

export type SeriesPoint = { periodStart: string; value: number | null };
export interface MetricSeriesResult {
  series: Record<string, SeriesPoint[]>;
  compare?: Record<string, SeriesPoint[]>;
  meta: Record<
    string,
    { name: string; unit: string; goodDirection: "up" | "down"; aggregation: string }
  >;
}

export async function getMetricSeries(
  orgId: string,
  projectId: string,
  query: MetricSeriesQuery,
  /**
   * Optional pre-resolved effective definitions. Callers that already resolved
   * them (e.g. to pick `query.keys`) can pass them through to avoid a redundant
   * identical metric_definitions SELECT on the hot path.
   */
  preResolvedDefs?: EffectiveMetricDefinition[],
): Promise<MetricSeriesResult> {
  const period = query.period;
  const toDate = query.to ?? toDateStr(londonTodayUTC());
  const fromDate = query.from ?? shiftDateStr(toDate, -29);
  const mainStart = londonInstant(fromDate);
  const mainEnd = londonInstant(shiftDateStr(toDate, 1));

  const effective =
    preResolvedDefs ??
    (await resolveEffectiveMetricDefinitions(orgId, projectId));
  const realByKey = new Map(effective.map((d) => [d.key, d] as const));

  const requestedReal: string[] = [];
  const requestedDerived: string[] = [];
  for (const k of query.keys) {
    if (realByKey.has(k)) requestedReal.push(k);
    else if (DERIVED_METRICS[k]) requestedDerived.push(k);
    // unknown keys are silently skipped
  }

  const metricKeysNeeded = new Set<string>(requestedReal);
  const eventTypesNeeded = new Set<string>();
  for (const dk of requestedDerived) {
    const spec = DERIVED_METRICS[dk]!;
    for (const src of [spec.num, spec.den]) {
      if (src.kind === "metric") metricKeysNeeded.add(src.key);
      else eventTypesNeeded.add(src.eventType);
    }
  }

  const buildWindow = async (
    start: SQL,
    end: SQL,
  ): Promise<Record<string, SeriesPoint[]>> => {
    const [rollupMaps, eventMaps] = await Promise.all([
      fetchRollupSeries(projectId, period, [...metricKeysNeeded], start, end),
      fetchEventCountSeries(projectId, [...eventTypesNeeded], period, start, end),
    ]);
    const series: Record<string, SeriesPoint[]> = {};
    for (const k of requestedReal) {
      const m = rollupMaps.get(k);
      series[k] = m
        ? [...m.entries()].map(([periodStart, value]) => ({ periodStart, value }))
        : [];
    }
    for (const dk of requestedDerived) {
      const spec = DERIVED_METRICS[dk]!;
      const numMap =
        spec.num.kind === "metric"
          ? rollupMaps.get(spec.num.key)
          : eventMaps.get(spec.num.eventType);
      const denMap =
        spec.den.kind === "metric"
          ? rollupMaps.get(spec.den.key)
          : eventMaps.get(spec.den.eventType);
      const isos = new Set<string>();
      numMap?.forEach((_v, iso) => isos.add(iso));
      denMap?.forEach((_v, iso) => isos.add(iso));
      series[dk] = [...isos].sort().map((iso) => {
        const num = numMap?.get(iso) ?? 0;
        const den = denMap?.get(iso) ?? 0;
        return {
          periodStart: iso,
          // num/den count disjoint event populations in the same bucket (e.g.
          // no-shows on appointments booked earlier days vs today's new bookings),
          // so the raw ratio can exceed 1. Clamp to the contract's declared 0-100
          // percent range so the derived series never emits e.g. 200%.
          value: den > 0 ? Math.min(100, round2((num / den) * 100)) : null,
        };
      });
    }
    return series;
  };

  const series = await buildWindow(mainStart, mainEnd);

  let compare: Record<string, SeriesPoint[]> | undefined;
  if (query.compare === "previous") {
    const length = daysInclusive(fromDate, toDate);
    const cmpStart = londonInstant(shiftDateStr(fromDate, -length));
    compare = await buildWindow(cmpStart, mainStart);
  }

  const meta: MetricSeriesResult["meta"] = {};
  for (const k of requestedReal) {
    const d = realByKey.get(k)!;
    meta[k] = {
      name: d.name,
      unit: d.unit,
      goodDirection: d.goodDirection,
      aggregation: d.aggregation,
    };
  }
  for (const dk of requestedDerived) {
    const spec = DERIVED_METRICS[dk]!;
    meta[dk] = {
      name: spec.name,
      unit: "percent",
      goodDirection: spec.goodDirection,
      aggregation: "rate",
    };
  }

  return compare ? { series, compare, meta } : { series, meta };
}

// ── preview (evaluate a definition over raw events, WITHOUT writing) ──────────

export interface MetricPreviewResult {
  series: { periodStart: string; value: number; sampleCount: number }[];
  total: number;
  sampleEvents: { id: string; occurredAt: string; extracted: number | null }[];
}

export async function previewMetric(
  projectId: string,
  input: MetricDefinitionInput,
): Promise<MetricPreviewResult | null> {
  const evaluable = toEvaluable({
    key: input.key,
    name: input.name,
    unit: input.unit,
    aggregation: input.aggregation,
    eventType: input.eventType,
    valuePath: input.valuePath ?? null,
    whereEquals: input.whereEquals ?? null,
    goodDirection: input.goodDirection ?? "up",
    isKpi: input.isKpi ?? false,
    sort: 0,
  });
  if (evaluable === null) return null;

  const todayDate = toDateStr(londonTodayUTC());
  const start = londonInstant(shiftDateStr(todayDate, -29));
  const end = londonInstant(shiftDateStr(todayDate, 1));

  // Same filter shape the engine's recompute uses, scoped to one project + the
  // last 30 London days, day-bucketed — but this writes nothing.
  let where = sql`e.project_id = ${projectId}::uuid and e.occurred_at >= ${start} and e.occurred_at < ${end}`;
  if (evaluable.eventType !== "*")
    where = sql`${where} and e.type = ${evaluable.eventType}`;
  for (const c of evaluable.where) where = sql`${where} and ${c}`;
  const valued = evaluable.value !== null;
  if (valued) where = sql`${where} and (${evaluable.value!}) is not null`;
  const v = valued ? evaluable.value! : sql`null::numeric`;

  const inner = sql`select ${bucketStartSQL("day")} as bucket, ${v} as v, e.occurred_at as occ, e.id as id from events e where ${where}`;

  const [seriesRows, totalRows, sampleRows] = await Promise.all([
    db.execute(sql`
      select ${isoUTC(sql`bucket`)} as period_start, ${aggregateValueSQL(evaluable.aggregation)} as value, count(*)::int as sample_count
      from (${inner}) sub
      group by bucket
      order by bucket asc
    `) as unknown as Promise<
      { period_start: string; value: unknown; sample_count: number }[]
    >,
    db.execute(sql`
      select ${aggregateValueSQL(evaluable.aggregation)} as value from (${inner}) sub
    `) as unknown as Promise<{ value: unknown }[]>,
    db.execute(sql`
      select e.id as id, ${isoUTC(sql`e.occurred_at`)} as occurred_at, ${v} as extracted
      from events e where ${where}
      order by e.occurred_at desc, e.id desc limit 5
    `) as unknown as Promise<
      { id: string; occurred_at: string; extracted: unknown }[]
    >,
  ]);

  return {
    series: seriesRows.map((r) => ({
      periodStart: r.period_start,
      value: Number(r.value ?? 0),
      sampleCount: Number(r.sample_count),
    })),
    total: Number(totalRows[0]?.value ?? 0),
    sampleEvents: sampleRows.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      extracted:
        r.extracted === null || r.extracted === undefined
          ? null
          : Number(r.extracted),
    })),
  };
}

// ── ROI (§10: (revenue + minutes/60*rate) / (retainer + tokens_cost)) ────────

export interface RoiResult {
  revenueAttributedPence: number;
  minutesSaved: number;
  timeValuePence: number;
  hourlyRatePence: number;
  retainerPence: number;
  runCostPence: number;
  roiMultiple: number | null;
  breakdown: {
    numeratorPence: number;
    denominatorPence: number;
    revenueAttributedPence: number;
    timeValuePence: number;
    retainerPence: number;
    runCostPence: number;
  };
  month: string;
}

export async function getProjectRoi(
  orgId: string,
  projectId: string,
  month?: string,
): Promise<RoiResult | null> {
  const [project] = await db
    .select({
      retainerPenceMonthly: projects.retainerPenceMonthly,
      hourlyRatePence: projects.hourlyRatePence,
    })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
    .limit(1);
  if (!project) return null;

  const m = month ?? currentLondonMonth();
  const { start, end } = londonMonthBounds(m);
  const sumFor = (key: string): SQL =>
    sql`coalesce((select sum(value) from metric_rollups where project_id = ${projectId}::uuid and metric_key = ${key} and period = 'day' and period_start >= ${start} and period_start < ${end}), 0)`;
  const rows = (await db.execute(sql`
    select ${sumFor("revenue_attributed")} as revenue,
           ${sumFor("minutes_saved")} as minutes,
           ${sumFor("tokens_cost_pence")} as run_cost
  `)) as unknown as { revenue: unknown; minutes: unknown; run_cost: unknown }[];
  const revenueAttributedPence = Math.round(Number(rows[0]?.revenue ?? 0));
  const minutesSaved = Number(rows[0]?.minutes ?? 0);
  const runCostPence = Math.round(Number(rows[0]?.run_cost ?? 0));

  const hourlyRatePence = project.hourlyRatePence ?? DEFAULT_HOURLY_RATE_PENCE;
  const retainerPence = project.retainerPenceMonthly;
  const timeValuePence = Math.round((minutesSaved / 60) * hourlyRatePence);
  const numeratorPence = revenueAttributedPence + timeValuePence;
  const denominatorPence = retainerPence + runCostPence;
  const roiMultiple =
    denominatorPence > 0 ? round2(numeratorPence / denominatorPence) : null;

  return {
    revenueAttributedPence,
    minutesSaved,
    timeValuePence,
    hourlyRatePence,
    retainerPence,
    runCostPence,
    roiMultiple,
    breakdown: {
      numeratorPence,
      denominatorPence,
      revenueAttributedPence,
      timeValuePence,
      retainerPence,
      runCostPence,
    },
    month: m,
  };
}

// ── insights (list + status patch) ───────────────────────────────────────────

export async function listProjectInsights(
  orgId: string,
  projectId: string,
  opts: { status?: InsightsQuery["status"]; limit: number },
) {
  const conds = [eq(insights.orgId, orgId), eq(insights.projectId, projectId)];
  if (opts.status) conds.push(eq(insights.status, opts.status));
  return db
    .select({
      id: insights.id,
      kind: insights.kind,
      title: insights.title,
      bodyMd: insights.bodyMd,
      confidence: insights.confidence,
      status: insights.status,
      evidence: insights.evidence,
      createdAt: insights.createdAt,
    })
    .from(insights)
    .where(and(...conds))
    .orderBy(desc(insights.createdAt), desc(insights.id))
    .limit(opts.limit);
}

export async function updateInsightStatus(
  orgId: string,
  insightId: string,
  status: "reviewed" | "dismissed",
) {
  const [row] = await db
    .update(insights)
    .set({ status })
    .where(and(eq(insights.orgId, orgId), eq(insights.id, insightId)))
    .returning({
      id: insights.id,
      kind: insights.kind,
      title: insights.title,
      bodyMd: insights.bodyMd,
      confidence: insights.confidence,
      status: insights.status,
      evidence: insights.evidence,
      createdAt: insights.createdAt,
    });
  return row;
}

/**
 * Phase 7 §B2 — triage board status transition for one feedback_items row.
 * Scoped by (orgId, projectId, itemId): a cross-org OR cross-project id
 * matches nothing and the caller 404s (indistinguishable from "not found").
 */
export async function updateFeedbackItemStatus(
  orgId: string,
  projectId: string,
  itemId: string,
  status: "new" | "seen" | "planned" | "done",
) {
  const [row] = await db
    .update(feedbackItems)
    .set({ status })
    .where(
      and(
        eq(feedbackItems.orgId, orgId),
        eq(feedbackItems.projectId, projectId),
        eq(feedbackItems.id, itemId),
      ),
    )
    .returning({
      id: feedbackItems.id,
      kind: feedbackItems.kind,
      message: feedbackItems.message,
      severity: feedbackItems.severity,
      submitterName: feedbackItems.submitterName,
      submitterEmail: feedbackItems.submitterEmail,
      pageUrl: feedbackItems.pageUrl,
      status: feedbackItems.status,
      createdAt: feedbackItems.createdAt,
    });
  return row;
}

// ── sparklines (each project's primary KPI day series, else events_total) ────

export interface Sparkline {
  metricKey: string;
  points: { day: string; value: number }[];
}

export async function getSparklines(
  orgId: string,
  days: number,
): Promise<{ sparklines: Record<string, Sparkline> }> {
  const todayDate = toDateStr(londonTodayUTC());
  const start = londonInstant(shiftDateStr(todayDate, -(days - 1)));
  const end = londonInstant(shiftDateStr(todayDate, 1));

  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.orgId, orgId));
  if (projectRows.length === 0) return { sparklines: {} };

  const defRows = await db
    .select({
      key: metricDefinitions.key,
      isKpi: metricDefinitions.isKpi,
      sort: metricDefinitions.sort,
      projectId: metricDefinitions.projectId,
    })
    .from(metricDefinitions)
    .where(eq(metricDefinitions.orgId, orgId));

  const rollupRows = (await db.execute(sql`
    select project_id, metric_key,
           to_char(period_start at time zone 'Europe/London', 'YYYY-MM-DD') as day,
           value
    from metric_rollups
    where org_id = ${orgId}::uuid and period = 'day'
      and period_start >= ${start} and period_start < ${end}
    order by project_id, metric_key, period_start asc
  `)) as unknown as {
    project_id: string;
    metric_key: string;
    day: string;
    value: unknown;
  }[];

  const byProject = new Map<
    string,
    Map<string, { day: string; value: number }[]>
  >();
  for (const r of rollupRows) {
    let mk = byProject.get(r.project_id);
    if (!mk) {
      mk = new Map();
      byProject.set(r.project_id, mk);
    }
    let pts = mk.get(r.metric_key);
    if (!pts) {
      pts = [];
      mk.set(r.metric_key, pts);
    }
    pts.push({ day: r.day, value: Number(r.value) });
  }

  const globals = defRows.filter((d) => d.projectId === null);
  const overridesByProject = new Map<string, typeof defRows>();
  for (const d of defRows) {
    if (d.projectId === null) continue;
    const list = overridesByProject.get(d.projectId) ?? [];
    list.push(d);
    overridesByProject.set(d.projectId, list);
  }

  const sparklines: Record<string, Sparkline> = {};
  for (const p of projectRows) {
    const byKey = new Map<string, { key: string; isKpi: boolean; sort: number }>();
    for (const g of globals)
      byKey.set(g.key, { key: g.key, isKpi: g.isKpi, sort: g.sort });
    for (const o of overridesByProject.get(p.id) ?? [])
      byKey.set(o.key, { key: o.key, isKpi: o.isKpi, sort: o.sort });
    const kpis = [...byKey.values()]
      .filter((d) => d.isKpi)
      .sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
    const projMaps = byProject.get(p.id);
    let chosen: string | null = null;
    for (const k of kpis) {
      if (projMaps?.get(k.key)?.length) {
        chosen = k.key;
        break;
      }
    }
    const metricKey = chosen ?? "events_total";
    sparklines[p.id] = { metricKey, points: projMaps?.get(metricKey) ?? [] };
  }
  return { sparklines };
}

// ── costs (ADDENDUM §B: client-system AI + OS agent spend, per client/project) ─

export interface ProjectCost {
  projectId: string;
  name: string;
  clientSystemAiPence: number;
  osAgentPence: number;
  totalPence: number;
}
export interface ClientCost {
  clientId: string;
  clientName: string;
  projects: ProjectCost[];
  totals: { clientSystemAiPence: number; osAgentPence: number; totalPence: number };
}

export async function getCostsByClient(
  orgId: string,
  month?: string,
): Promise<{ month: string; clients: ClientCost[]; orgOverheadPence: number }> {
  const m = month ?? currentLondonMonth();
  const { start, end } = londonMonthBounds(m);

  const projRows = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      clientId: clients.id,
      clientName: clients.name,
    })
    .from(projects)
    .innerJoin(clients, eq(projects.clientId, clients.id))
    .where(eq(projects.orgId, orgId))
    .orderBy(asc(clients.name), asc(projects.name));

  const aiRows = (await db.execute(sql`
    select project_id, coalesce(sum(value), 0) as pence from metric_rollups
    where org_id = ${orgId}::uuid and metric_key = 'tokens_cost_pence' and period = 'day'
      and period_start >= ${start} and period_start < ${end}
    group by project_id
  `)) as unknown as { project_id: string; pence: unknown }[];
  const aiByProject = new Map(
    aiRows.map((r) => [r.project_id, Math.round(Number(r.pence))] as const),
  );

  const osRows = (await db.execute(sql`
    select project_id, coalesce(sum(cost_estimate_pence), 0) as pence from agent_runs
    where org_id = ${orgId}::uuid and project_id is not null
      and started_at >= ${start} and started_at < ${end}
    group by project_id
  `)) as unknown as { project_id: string; pence: unknown }[];
  const osByProject = new Map(
    osRows.map((r) => [r.project_id, Math.round(Number(r.pence))] as const),
  );

  const overheadRows = (await db.execute(sql`
    select coalesce(sum(cost_estimate_pence), 0) as pence from agent_runs
    where org_id = ${orgId}::uuid and project_id is null
      and started_at >= ${start} and started_at < ${end}
  `)) as unknown as { pence: unknown }[];
  const orgOverheadPence = Math.round(Number(overheadRows[0]?.pence ?? 0));

  const clientMap = new Map<string, ClientCost>();
  for (const p of projRows) {
    let c = clientMap.get(p.clientId);
    if (!c) {
      c = {
        clientId: p.clientId,
        clientName: p.clientName,
        projects: [],
        totals: { clientSystemAiPence: 0, osAgentPence: 0, totalPence: 0 },
      };
      clientMap.set(p.clientId, c);
    }
    const ai = aiByProject.get(p.projectId) ?? 0;
    const os = osByProject.get(p.projectId) ?? 0;
    const total = ai + os;
    c.projects.push({
      projectId: p.projectId,
      name: p.projectName,
      clientSystemAiPence: ai,
      osAgentPence: os,
      totalPence: total,
    });
    c.totals.clientSystemAiPence += ai;
    c.totals.osAgentPence += os;
    c.totals.totalPence += total;
  }
  return { month: m, clients: [...clientMap.values()], orgOverheadPence };
}

export async function getProjectCosts(
  orgId: string,
  projectId: string,
  month?: string,
) {
  const [proj] = await db
    .select({
      projectId: projects.id,
      name: projects.name,
      clientId: clients.id,
      clientName: clients.name,
    })
    .from(projects)
    .innerJoin(clients, eq(projects.clientId, clients.id))
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
    .limit(1);
  if (!proj) return null;

  const m = month ?? currentLondonMonth();
  const { start, end } = londonMonthBounds(m);
  const aiRows = (await db.execute(sql`
    select coalesce(sum(value), 0) as pence from metric_rollups
    where project_id = ${projectId}::uuid and metric_key = 'tokens_cost_pence' and period = 'day'
      and period_start >= ${start} and period_start < ${end}
  `)) as unknown as { pence: unknown }[];
  const osRows = (await db.execute(sql`
    select coalesce(sum(cost_estimate_pence), 0) as pence from agent_runs
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and started_at >= ${start} and started_at < ${end}
  `)) as unknown as { pence: unknown }[];
  const clientSystemAiPence = Math.round(Number(aiRows[0]?.pence ?? 0));
  const osAgentPence = Math.round(Number(osRows[0]?.pence ?? 0));
  return {
    projectId: proj.projectId,
    name: proj.name,
    clientId: proj.clientId,
    clientName: proj.clientName,
    month: m,
    clientSystemAiPence,
    osAgentPence,
    totalPence: clientSystemAiPence + osAgentPence,
  };
}

// ── overview extras (append to GET /api/overview) ────────────────────────────

export interface OverviewExtras {
  healthSummary: { green: number; amber: number; red: number };
  openAnomalies: number;
}

export async function getOverviewExtras(orgId: string): Promise<OverviewExtras> {
  const rows = (await db.execute(sql`
    select
      (select count(*) from projects where org_id = ${orgId}::uuid and status = 'live' and health = 'green')::int as green,
      (select count(*) from projects where org_id = ${orgId}::uuid and status = 'live' and health = 'amber')::int as amber,
      (select count(*) from projects where org_id = ${orgId}::uuid and status = 'live' and health = 'red')::int as red,
      (select count(*) from insights where org_id = ${orgId}::uuid and kind = 'anomaly' and status = 'new')::int as open_anomalies
  `)) as unknown as {
    green: number;
    amber: number;
    red: number;
    open_anomalies: number;
  }[];
  const r = rows[0];
  return {
    healthSummary: {
      green: Number(r?.green ?? 0),
      amber: Number(r?.amber ?? 0),
      red: Number(r?.red ?? 0),
    },
    openAnomalies: Number(r?.open_anomalies ?? 0),
  };
}
