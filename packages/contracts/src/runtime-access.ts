/** Paths available to a signed-in browser; management and raw mutations stay private. */
export function isBrowserRuntimePath(method: string, path: string): boolean {
  if (path.includes(String.fromCharCode(92)) || path.includes("%")) return false;
  // Operation id segment: the local API's Id primitive allows a wide class, but
  // browser URLs are the proxy's own concern — ids reach it percent-free and
  // the proxy already refuses any "%" anywhere in the path.
  if (method === "POST") {
    return (
      path === "/v1/conversations/commands" ||
      /^\/v1\/agents\/[a-zA-Z0-9_-]+\/settings\/commands$/.test(path) ||
      // S13 Operation chat (D31/D36/D41/D42): the record creation, the roster
      // commands, the coordinator set/remove, run creation, and the addressed
      // message send. The D7 collaboration-event write is deliberately absent
      // — the browser RENDERS events, it never authors them. S14 adds the
      // rename (D41: ad-hoc Operations are created nameless and renamed by
      // the user afterwards) — a durable row update carried by the same
      // contracts command envelope, never a free-form field write.
      path === "/v1/operations" ||
      /^\/v1\/operations\/[a-zA-Z0-9_-]+\/(?:roster\/commands|coordinator|runs|thread\/messages|rename)$/.test(
        path,
      )
    );
  }
  return (
    method === "GET" &&
    (path === "/v1/agents" ||
      /^\/v1\/agents\/[a-zA-Z0-9_-]+(?:\/settings)?$/.test(path) ||
      /^\/v1\/conversations\/[a-zA-Z0-9_-]+\/events$/.test(path) ||
      // S13 reads: the operations list, the detail read model, and the merged
      // thread. Run/event sub-reads stay private to the runtime surfaces.
      path === "/v1/operations" ||
      /^\/v1\/operations\/[a-zA-Z0-9_-]+(?:\/thread)?$/.test(path) ||
      // S16 (D32 layer 3, E1): the admission readout — the honest "who is
      // waiting and why" resource read (UI_DESIGN S11 resource states). The
      // one worker surface a browser may read; every worker mutation stays
      // runtime-internal (agents propose; the runtime validates and executes).
      path === "/v1/workers/admission")
      // S15 launch preview reads (D30): the pinned pack's definition
      // summaries and the eight-group preview. Strictly GET — the preview is
      // the safety gate where NOTHING executes before confirmation, and
      // chunk 3's launch route (the only mutation this slice introduces) is
      // deliberately absent here until it lands.
      path === "/v1/operation-definitions" ||
      /^\/v1\/operation-definitions\/[a-zA-Z0-9_-]+\/preview$/.test(path))
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
