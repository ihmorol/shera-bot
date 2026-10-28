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
      ) ||
      // S15 chunk 3 (D30/AC23): the launch CONFIRM — the one mutation the
      // preview gate leads to. The envelope is the contracts
      // OperationLaunchCommand (idempotency_key + actor + issued_at); the
      // runtime re-resolves the definition and re-validates the roster before
      // creating anything, so the browser never writes Operation rows
      // directly.
      path === "/v1/operations/launch" ||
      // S17 chunk 4 (D6/D39/G6): the workspace panel's typed writes — file
      // upload/mkdir/user-confirmed delete, lease acquire/renew/release for
      // the panel's conflict surfaces, and artifact insert. Every write still
      // carries its D4 actor + workspace_id in the body (the proxy's
      // runtimeWorkspaceMatches check enforces the binding); the D6 lease
      // gate inside the repositories refuses what the actor may not do. The
      // runtime-internal task-terminal force-release
      // (/v1/workspace/leases/release-for-task) is deliberately ABSENT — task
      // ids are runtime-minted and only the gateway may force-release.
      path === "/v1/workspace/files/upload" ||
      path === "/v1/workspace/directories" ||
      path === "/v1/workspace/delete" ||
      path === "/v1/workspace/leases" ||
      /^\/v1\/workspace\/leases\/[a-zA-Z0-9_-]+\/renew$/.test(path) ||
      path === "/v1/workspace/artifacts" ||
      // S20 chunk 5 (D9/PRD §8, G6): the three approval mutations the web UI
      // offers — one of the five decisions (the deciding actor is relayed and
      // the SERVICE refuses any agent actor), one grant revoke, one reminder
      // mute. Approval CREATION stays runtime-internal (grants are runtime
      // objects, never prompt- or browser-created); there is deliberately no
      // un-mute or un-revoke path (write-once semantics live in the runtime).
      /^\/v1\/approvals\/[a-zA-Z0-9_-]+\/decision$/.test(path) ||
      path === "/v1/approvals/grants/revoke" ||
      path === "/v1/approvals/mutes"
    );
  }
  if (method === "PUT") {
    // S17: the gated file write (D6) — the one PUT, the panel's editor seam.
    return path === "/v1/workspace/files";
  }
  if (method === "DELETE") {
    // S17: the holder-task lease release (D6). File deletes are a POST route
    // (/v1/workspace/delete) so the confirmed delete travels as a typed body,
    // not a destructive URL.
    return /^\/v1\/workspace\/leases\/[a-zA-Z0-9_-]+$/.test(path);
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
      // S20 chunk 5 (§S8, E3) approvals reads: the pending D9 cards, one
      // detail card (with its reminder slots + run projection), the ACTIVE
      // grants list, the reminder mutes list, and the due-reminder scan the
      // chat views poll (firing due slots — a delivery stamp, never a state
      // change). Every answer is workspace-scoped (E12).
      path === "/v1/approvals/pending" ||
      /^\/v1\/approvals\/[a-zA-Z0-9_-]+$/.test(path) ||
      path === "/v1/approvals/grants" ||
      path === "/v1/approvals/mutes" ||
      path === "/v1/approvals/due-reminders" ||
      // S16 (D32 layer 3, E1): the admission readout — the honest "who is
      // waiting and why" resource read (UI_DESIGN S11 resource states). The
      // one worker surface a browser may read; every worker mutation stays
      // runtime-internal (agents propose; the runtime validates and executes).
      path === "/v1/workers/admission" ||
      // S15 launch preview reads (D30): the pinned pack's definition
      // summaries and the eight-group preview. Strictly GET — the preview is
      // the safety gate where NOTHING executes before confirmation; the one
      // mutation the gate adds is the launch CONFIRM (POST
      // /v1/operations/launch, allowlisted above).
      path === "/v1/operation-definitions" ||
      /^\/v1\/operation-definitions\/[a-zA-Z0-9_-]+\/preview$/.test(path) ||
      // S17 chunk 4 (E12/AC16): the workspace panel reads — the shared
      // workspace:// tree listing, file bytes (base64 prototype body), the
      // active write leases (the conflict tooltip's data source, G5), and the
      // artifact refs + byte-exact artifact download. Reads are scoped by the
      // workspace_id query the proxy binds to the session (E12); private
      // agent:// denials stay in the storage layer (D39).
      path === "/v1/workspace/nodes" ||
      path === "/v1/workspace/files" ||
      path === "/v1/workspace/leases" ||
      path === "/v1/workspace/artifacts" ||
      /^\/v1\/workspace\/artifacts\/[a-zA-Z0-9_-]+$/.test(path))
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
