/**
 * JSON API response shapes — declared once, matching the Phase 1
 * "Dashboard API (workstream C)" + ingest test/replay contracts exactly.
 * Client components code against these; server components reuse the row
 * shapes where convenient.
 */

export interface OverviewResponse {
  mrrPence: number;
  activeClients: number;
  liveProjects: number;
  eventsTotal: number;
  clientBookingsThisMonth: number;
}

export interface TickerEvent {
  id: string;
  type: string;
  occurredAt: string;
  receivedAt: string;
  projectId: string | null;
  projectName: string;
  projectSlug: string | null;
  subjectName: string | null;
  valuePence: number | null;
  minutesSaved: number | null;
}

export interface TickerResponse {
  events: TickerEvent[];
}

export interface ClientRow {
  id: string;
  name: string;
  status: string;
  industrySlug: string | null;
  projectCount: number;
  createdAt: string;
}

export interface ClientsResponse {
  clients: ClientRow[];
}

export interface CreatedClient {
  id: string;
  name: string;
  status: string;
  industrySlug?: string | null;
}

export interface ProjectClientRef {
  id: string;
  name: string;
}

export interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
  status: string;
  health: string;
  type: string;
  stack: string;
  retainerPenceMonthly: number;
  client: ProjectClientRef;
  publicKey: string | null;
  lastEventAt: string | null;
  eventsToday: number;
}

export interface ProjectsResponse {
  projects: ProjectListItem[];
}

export interface ProjectKeyView {
  id: string;
  publicKey: string;
  authMode: string;
  rateLimitPer10s: number;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  label: string | null;
}

export interface EventTypeSeen {
  type: string;
  count: number;
  lastAt: string;
}

export interface EventActor {
  kind: string;
  id?: string;
  name?: string;
}

export interface EventRow {
  id: string;
  orgId: string;
  projectId: string | null;
  type: string;
  source: string;
  idempotencyKey: string;
  occurredAt: string;
  receivedAt: string;
  actor: EventActor | null;
  subject: EventActor | null;
  data: Record<string, unknown>;
  valuePence: number | null;
  currency: string;
  minutesSaved: number | null;
  raw: unknown;
}

export interface EventsResponse {
  events: EventRow[];
  nextCursor: string | null;
}

export interface DeliveryRow {
  id: string;
  status: string;
  httpStatus: number;
  latencyMs: number | null;
  error: string | null;
  receivedAt: string;
  hasRaw: boolean;
}

export interface DeliveriesResponse {
  deliveries: DeliveryRow[];
}

/** Shape returned by POST /api/projects (secret shown once). */
export interface IssuedKey {
  publicKey: string;
  secret: string;
  authMode: string;
}

export interface CreateProjectResponse {
  project: {
    id: string;
    name: string;
    slug: string;
    status: string;
  };
  key: IssuedKey;
}

export interface RotateResponse {
  publicKey: string;
  secret: string;
}

export interface RevokeResponse {
  publicKey: string;
  secret: string;
  authMode: string;
}

export interface RejectedEvent {
  index: number;
  reason: string;
}

export interface TestEventResponse {
  accepted: number;
  duplicates: number;
  rejected: RejectedEvent[];
  eventType: string;
}

export interface ReplayResponse {
  accepted: number;
  duplicates: number;
  rejected: RejectedEvent[];
}

export interface ApiError {
  error: string;
}
