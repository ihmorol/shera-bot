/**
 * Terminal live-view journal stream naming (S18 chunk 1) — the single
 * definition of the per-Agent terminal stream, mirroring the session
 * supervisor's `session:<workspace_id>:<agent_id>` convention. Every
 * terminal event of one Agent's executions journals on this stream, so the
 * durable replay is one gapless per-stream cursor read (D26).
 */
export function terminalStreamFor(workspaceId: string, agentId: string): string {
  return `terminal:${workspaceId}:${agentId}`;
}
