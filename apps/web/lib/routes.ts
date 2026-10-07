/**
 * Single source of truth for the chunk-1 route skeleton (UI_DESIGN §3.1).
 * Every internal link goes through these builders — the navigation test bans
 * literal `href="/..."` in UI source so a link can never point at a route
 * that does not exist in ROUTE_MANIFEST.
 */

export interface RouteManifestEntry {
  /** App-router path pattern; `page.tsx` must exist at `app<path>/page.tsx`. */
  path: string;
  title: string;
}

export const ROUTE_MANIFEST: RouteManifestEntry[] = [
  { path: "/login", title: "Sign in" },
  { path: "/app", title: "Dashboard" },
  { path: "/app/agent/[agentId]", title: "Agent chat" },
  { path: "/app/operation/new", title: "New Operation" },
  { path: "/app/operation/[operationId]", title: "Operation chat" },
  { path: "/app/operation/[operationId]/preview", title: "Launch preview" },
  { path: "/app/chat/[chatId]/workspace", title: "Workspace" },
  { path: "/app/chat/[chatId]/workspace/full", title: "Workspace (full page)" },
  { path: "/app/settings/[[...section]]", title: "Settings" },
];

export const routes = {
  login: () => "/login",
  app: () => "/app",
  agent: (agentId: string) => `/app/agent/${agentId}`,
  operationNew: () => "/app/operation/new",
  operation: (operationId: string) => `/app/operation/${operationId}`,
  operationPreview: (operationId: string) => `/app/operation/${operationId}/preview`,
  workspace: (chatId: string) => `/app/chat/${chatId}/workspace`,
  workspaceFull: (chatId: string) => `/app/chat/${chatId}/workspace/full`,
  settings: (section?: string) => (section ? `/app/settings/${section}` : "/app/settings"),
} as const;
