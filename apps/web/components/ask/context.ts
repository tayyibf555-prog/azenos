import type { AskContext } from "./types";

/**
 * Derive the page context to inject into an Ask turn from the current pathname.
 * `/projects/<id>` (and any deeper `/projects/<id>/…`) scopes the question to
 * that project; everything else carries no scope. Matches the
 * chat_sessions.context shape ({ project_id }).
 */
export function deriveAskContext(pathname: string | null): AskContext {
  if (!pathname) return {};
  const m = /^\/projects\/([^/]+)/.exec(pathname);
  const projectId = m?.[1];
  // `/projects/new` is the create form, not a project scope.
  if (projectId && projectId !== "new") return { project_id: projectId };
  return {};
}
