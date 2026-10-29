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
      // S20 chunk 5 (D9/PRD §8, G6): the approval mutations the web UI
      // offers — one of the five decisions (the acting user is bound
      // SERVER-SIDE by the proxy from the authenticated session), one grant
      // revoke, one reminder mute, and the due-reminder scan (S20 review fix
      // F3: the scan MOVED from GET to POST — it stamps delivered_at, a state
      // mutation no GET may carry; the S15 command-convention precedent).
      // Approval CREATION stays runtime-internal (grants are runtime objects,
      // never prompt- or browser-created); there is deliberately no un-mute
      // or un-revoke path (write-once semantics live in the runtime).
      /^\/v1\/approvals\/[a-zA-Z0-9_-]+\/decision$/.test(path) ||
      path === "/v1/approvals/grants/revoke" ||
      path === "/v1/approvals/mutes" ||
      path === "/v1/approvals/due-reminders" ||
      // S19 chunk 2 (PRD §10, G2/G6): the merge-review surface's two
      // mutations — the runtime's validation run for one merge request (G2:
      // agents propose; the runtime validates and attaches the result) and
      // one PRD §10 decision (approve / reject / request-changes), relayed
      // into the S20 approval machinery with the acting user bound
      // SERVER-SIDE by the proxy (agents never decide, G6). Merge-request
      // PREPARATION stays Agent/runtime-owned; there is no browser path for
      // project import/clone, credential store/revoke, or worktree
      // allocation.
      /^\/v1\/projects\/[a-zA-Z0-9_-]+\/merge-requests\/[a-zA-Z0-9_-]+\/decision$/.test(path) ||
      /^\/v1\/projects\/[a-zA-Z0-9_-]+\/merge-requests\/[a-zA-Z0-9_-]+\/validation$/.test(path)
      // S21 (PRD §7, E4, G6): the tools mutations the web UI offers — the
      // PURE creation preview (a POST because it carries a typed body; zero
      // side effects, the D30 posture), the creation command, the
      // runtime-grant activation, and the disable/enable switch (the switch
      // that beats any grant). Every actor on these paths is bound
      // SERVER-SIDE from the authenticated session (the proxy rebuilds
      // `actor` — an agent-asserted identity cannot create, activate, or
      // disable a tool through the browser path). Tool EXECUTION has no
      // browser route at all: agents propose through the runtime, the
      // executor decides (G2) — the browser can only manage the inventory.
      path === "/v1/tools/creation-preview" ||
      path === "/v1/tools/create" ||
      path === "/v1/tools/activate" ||
      path === "/v1/tools/disable" ||
      path === "/v1/tools/enable"
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
      // grants list, and the reminder mutes list. The detail capture EXCLUDES
      // the reserved literal segments (grants/mutes/due-reminders are their
      // own allowlist entries — and due-reminders must NOT answer a GET: the
      // scan is a POST mutation, S20 review fix F3). Every answer is
      // workspace-scoped (E12).
      path === "/v1/approvals/pending" ||
      /^\/v1\/approvals\/(?!grants$|mutes$|due-reminders$)[a-zA-Z0-9_-]+$/.test(path) ||
      path === "/v1/approvals/grants" ||
      path === "/v1/approvals/mutes" ||
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
      /^\/v1\/workspace\/artifacts\/[a-zA-Z0-9_-]+$/.test(path) ||
      // S18 (issue #19, G6): the terminal and browser READ-ONLY live views —
      // the durable terminal replay, one Agent's current terminal state, one
      // execution's record, the shared browser's actual page, and its
      // lifecycle readout. Strictly GET: the runtime registers zero
      // mutation routes on these paths (the no-takeover criterion IS the
      // route inventory), and the allowlist mirrors that — no POST/PUT/
      // DELETE/PATCH arm exists for any /v1/terminals/* or /v1/browser/*
      // path, so a stdin write, a signal send, or a browser navigation is
      // unreachable from the browser by construction. Every read is
      // workspace-scoped (E12) via the workspace_id query binding above.
      path === "/v1/terminals/events" ||
      path === "/v1/terminals/state" ||
      /^\/v1\/terminals\/[a-zA-Z0-9_-]+$/.test(path) ||
      path === "/v1/browser/view" ||
      path === "/v1/browser/state" ||
      // S19 chunk 2 (PRD §10, E6, G3/G5): the merge-review surface's reads.
      // The workspace's project list, one project's detail (worktrees + merge
      // requests + credential METADATA — masked hints only; no read-back
      // route exists for secrets, D22), the worktree ledger (the G5 queue is
      // visible), and the merge-request queue. There is deliberately NO
      // browser path for project import/clone, credential store/revoke, or
      // worktree allocation: those ride the Agent/runtime surfaces, never a
      // direct browser write.
      path === "/v1/projects" ||
      /^\/v1\/projects\/[a-zA-Z0-9_-]+(?:\/worktrees|\/merge-requests)?$/.test(path))
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
