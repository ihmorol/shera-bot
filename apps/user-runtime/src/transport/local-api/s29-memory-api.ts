/**
 * S29 chunk 1 — the memory HTTP surface (issue #30; PRD §11, D37, AC27,
 * G3/G6). Four routes, each workspace-scoped (E12):
 *
 * - GET  /v1/memory — the USER's management read: the per-scope breakdown
 *   (every D37 scope present as a group), the publication queue, and the
 *   auto-memory settings. This is the S9 Memory surface's data source; the
 *   browser proxy allowlists the GET.
 * - POST /v1/memory/commands — the ONE typed commands envelope (the
 *   contracts MemoryCommand union). The acting user is bound SERVER-SIDE by
 *   the proxy's session binding; the runtime validates the command against
 *   its schema (G2) and the service enforces the boundary.
 * - GET  /v1/agents/:agent_id/memory/context — ONE Agent's visible set (the
 *   context-assembly projection). The path identity is the ACTING Agent (the
 *   S11 folder-route posture); another Agent's private rows are
 *   unrepresentable by construction. Deliberately OFF the browser allowlist:
 *   Agent-identity context reads are runtime-internal.
 * - GET  /v1/agents/:agent_id/memory/entries/:memory_id — one entry's detail
 *   as an Agent viewer; another Agent's private entry is the typed 403 (the
 *   private-folder analogue, AC7's runtime denial path).
 * - GET  /v1/operations/:operation_id/memory-context — the Operation context
 *   projection (published-in entries + its own scopes); the read the AC27
 *   boundary is proven against.
 *
 * The typed MemoryServiceError rejections map onto the SheraError taxonomy in
 * transport/http/typed-errors.ts like every other module surface.
 */
import type { Express } from "express";
import { z } from "zod";

import { Id, MemoryCommand, WorkspaceId } from "@shera-bot/contracts";

import type { MemoryService } from "../../modules/memory/memory.service.ts";
import { contractValidationResponse } from "../http/typed-errors.ts";

export const MEMORY_USER_VIEW_PATH = "/v1/memory" as const;
export const MEMORY_COMMANDS_PATH = "/v1/memory/commands" as const;
export const MEMORY_AGENT_CONTEXT_PATH = "/v1/agents/:agent_id/memory/context" as const;
export const MEMORY_AGENT_ENTRY_PATH = "/v1/agents/:agent_id/memory/entries/:memory_id" as const;
export const MEMORY_OPERATION_CONTEXT_PATH = "/v1/operations/:operation_id/memory-context" as const;

export interface MemoryApiHandle {
  memory: MemoryService;
  /** E12: the container's workspace. */
  workspaceId: string;
}

const WorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });
const AgentContextQuery = z.strictObject({
  workspace_id: WorkspaceId,
  operation_id: Id.optional(),
});
const OperationContextQuery = z.strictObject({ workspace_id: WorkspaceId });

/** Mirror the local API's workspace binding: memory is a workspace-scoped surface. */
function workspaceMatches(handle: MemoryApiHandle, workspaceId: string): boolean {
  return workspaceId === handle.workspaceId;
}

export function registerMemoryRoutes(app: Express, deps: MemoryApiHandle): void {
  // The user's management read (the S9 Memory surface's data source).
  app.get(MEMORY_USER_VIEW_PATH, (req, res) => {
    const query = WorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      const { status, body } = contractValidationResponse(
        "The memory request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    if (!workspaceMatches(deps, query.data.workspace_id)) {
      res.status(403).json({
        code: "WORKSPACE_MISMATCH",
        category: "policy",
        safe_message: "This workspace does not belong to this runtime.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id: null,
      });
      return;
    }
    res.status(200).json(deps.memory.userView(query.data.workspace_id));
  });

  // The ONE typed commands envelope (G2). The workspace_id travels in the
  // command body and must be THIS runtime's workspace; the actor is bound by
  // the caller (the proxy rebuilds it from the session for browser writes).
  app.post(MEMORY_COMMANDS_PATH, (req, res) => {
    const parsed = MemoryCommand.safeParse(req.body);
    if (!parsed.success) {
      const { status, body } = contractValidationResponse(
        "The memory command is not valid: the body must be a memory command.",
      );
      res.status(status).json(body);
      return;
    }
    if (!workspaceMatches(deps, parsed.data.workspace_id)) {
      res.status(403).json({
        code: "WORKSPACE_MISMATCH",
        category: "policy",
        safe_message: "This workspace does not belong to this runtime.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id: null,
      });
      return;
    }
    res.status(200).json(deps.memory.applyCommand(parsed.data));
  });

  // ONE Agent's visible set — the acting Agent is the PATH identity (the S11
  // folder-route posture). Runtime-internal: deliberately off the browser
  // allowlist (Agent-identity reads never proxy through the browser).
  app.get(MEMORY_AGENT_CONTEXT_PATH, (req, res) => {
    const agentId = Id.safeParse(req.params.agent_id);
    const query = AgentContextQuery.safeParse(req.query);
    if (!agentId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The memory context request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    if (!workspaceMatches(deps, query.data.workspace_id)) {
      res.status(403).json({
        code: "WORKSPACE_MISMATCH",
        category: "policy",
        safe_message: "This workspace does not belong to this runtime.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id: null,
      });
      return;
    }
    res.status(200).json({
      workspace_id: query.data.workspace_id,
      agent_id: agentId.data,
      ...(query.data.operation_id !== undefined ? { operation_id: query.data.operation_id } : {}),
      entries: deps.memory.agentContext(
        query.data.workspace_id,
        agentId.data,
        query.data.operation_id,
      ),
    });
  });

  // One entry's detail as an Agent viewer — the AC7 denial surface: another
  // Agent's private entry is the typed 403 from the service.
  app.get(MEMORY_AGENT_ENTRY_PATH, (req, res) => {
    const agentId = Id.safeParse(req.params.agent_id);
    const memoryId = Id.safeParse(req.params.memory_id);
    const query = WorkspaceQuery.safeParse(req.query);
    if (!agentId.success || !memoryId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The memory entry request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    if (!workspaceMatches(deps, query.data.workspace_id)) {
      res.status(403).json({
        code: "WORKSPACE_MISMATCH",
        category: "policy",
        safe_message: "This workspace does not belong to this runtime.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id: null,
      });
      return;
    }
    res
      .status(200)
      .json(
        deps.memory.readEntryAsAgent(query.data.workspace_id, agentId.data, memoryId.data),
      );
  });

  // The Operation context projection — the read the AC27 boundary is proven
  // against (published-in entries + its own operation/task scopes only).
  app.get(MEMORY_OPERATION_CONTEXT_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const query = OperationContextQuery.safeParse(req.query);
    if (!operationId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The Operation memory request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    if (!workspaceMatches(deps, query.data.workspace_id)) {
      res.status(403).json({
        code: "WORKSPACE_MISMATCH",
        category: "policy",
        safe_message: "This workspace does not belong to this runtime.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id: null,
      });
      return;
    }
    res.status(200).json({
      workspace_id: query.data.workspace_id,
      operation_id: operationId.data,
      entries: deps.memory.operationContext(query.data.workspace_id, operationId.data),
    });
  });
}
