/**
 * Pack contract (S02 #2): a versioned, declarative customer Pack (D18, D29).
 * A Pack is configuration and data — never executable code, never secrets
 * (D28 trust rules). The workspace pins one Pack version; tasks snapshot the
 * version that created them (D19, D28).
 */
import { z } from "zod";

import { Agent } from "./agent.ts";
import { Id, Sha256Hex, SemVer } from "./primitives.ts";
import { OperationDefinition } from "./operation.ts";

export const DEFAULT_COORDINATOR_SENTINEL = "agent_general_assistant";

export const Pack = z
  .strictObject({
    pack_id: Id,
    version: SemVer,
    /** Manifest content hash recorded at load time (D28). */
    manifest_hash: Sha256Hex,
    /**
     * D42: the General Assistant is the default coordinator of every Operation
     * and is removable; a pack may name a different default via per-Operation
     * `coordinator`. This field names the pack-wide default coordinator Agent.
     */
    default_coordinator_agent_id: Id,
    agents: z.array(Agent).min(1).max(100),
    operations: z.array(OperationDefinition).max(100),
    /** Semantic version compatibility range of the runtime contract (D18). */
    runtime_compatibility: z.string().min(1).max(64),
  })
  .superRefine((pack, ctx) => {
    const declared = new Set(pack.agents.map((agent) => agent.agent_id));
    const rosterCount = new Map<string, number>();

    for (const operation of pack.operations) {
      for (const agentId of operation.roster) {
        if (!declared.has(agentId)) {
          ctx.addIssue({
            code: "custom",
            path: ["operations"],
            message: `operation ${operation.operation_id} rosters undeclared agent ${agentId}`,
          });
        }
        rosterCount.set(agentId, (rosterCount.get(agentId) ?? 0) + 1);
      }

      if (
        operation.coordinator &&
        operation.coordinator !== "none" &&
        !declared.has(operation.coordinator)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["operations"],
          message: `operation ${operation.operation_id} names undeclared coordinator ${operation.coordinator}`,
        });
      }
    }

    // D46: one home Operation per Agent. The default coordinator's
    // cross-Operation presence is the coordinator role specifically and does
    // not count as multi-Operation rostering (D46, point 2).
    for (const [agentId, count] of rosterCount) {
      if (count > 1 && agentId !== pack.default_coordinator_agent_id) {
        ctx.addIssue({
          code: "custom",
          path: ["operations"],
          message:
            `agent ${agentId} appears in ${count} operation rosters; D46 allows multi-roster ` +
            `presence only for the default coordinator (${pack.default_coordinator_agent_id})`,
        });
      }
    }

    for (const agent of pack.agents) {
      if (
        agent.home_operation_id &&
        !pack.operations.some((operation) => operation.operation_id === agent.home_operation_id)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["agents"],
          message: `agent ${agent.agent_id} names unknown home operation ${agent.home_operation_id}`,
        });
      }
    }

    if (!declared.has(pack.default_coordinator_agent_id)) {
      ctx.addIssue({
        code: "custom",
        path: ["default_coordinator_agent_id"],
        message: `default_coordinator_agent_id ${pack.default_coordinator_agent_id} is not a declared agent`,
      });
    }
  });

export type Pack = z.infer<typeof Pack>;
