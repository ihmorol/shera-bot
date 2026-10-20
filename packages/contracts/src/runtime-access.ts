/** Paths available to a signed-in browser; management and raw mutations stay private. */
export function isBrowserRuntimePath(method: string, path: string): boolean {
  if (path.includes(String.fromCharCode(92)) || path.includes("%")) return false;
  if (method === "POST") {
    return (
      path === "/v1/conversations/commands" ||
      /^\/v1\/agents\/[a-zA-Z0-9_-]+\/settings\/commands$/.test(path)
    );
  }
  return (
    method === "GET" &&
    (path === "/v1/agents" ||
      /^\/v1\/agents\/[a-zA-Z0-9_-]+(?:\/settings)?$/.test(path) ||
      /^\/v1\/conversations\/[a-zA-Z0-9_-]+\/events$/.test(path))
  );
}

/** Check both selectors when present, so one cannot shadow the other. */
export function runtimeWorkspaceMatches(
  method: string,
  query: { getAll(name: string): string[] },
  body: unknown,
  workspaceId: string,
): boolean {
  const selectors = query.getAll("workspace_id");
  if (selectors.length > 1 || selectors.some((value) => value !== workspaceId)) return false;
  if (method === "GET") return selectors.length === 1;
  return (
    typeof body === "object" &&
    body !== null &&
    "workspace_id" in body &&
    body.workspace_id === workspaceId
  );
}
