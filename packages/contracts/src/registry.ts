/**
 * Contract registry: every top-level S02 schema in one map, plus the explicit
 * extensibility register (D25: "unknown fields are rejected for internal
 * protocol messages unless explicitly marked extensible").
 *
 * The contract tests iterate this registry: round-trip fixtures and
 * unknown-field rejection are enforced mechanically against every entry, so a
 * schema added without fixtures or without strictness fails the suite.
 */
import type { z } from "zod";

import { Agent } from "./agent.ts";
import { ArtifactRef } from "./artifact.ts";
import { EventPage, ListTaskEventsQuery } from "./api.ts";
import { ApprovalGrant, ApprovalRequest } from "./approval.ts";
import { CollaborationMessage } from "./collaboration.ts";
import { CreditRelease, CreditReservation, CreditSettlement } from "./credits.ts";
import { SheraError } from "./errors.ts";
import { EVENT_ENVELOPES, TypedExecutionEvent, TriggerWebhookPayload } from "./events.ts";
import { MemoryEntry } from "./memory.ts";
import { Operation, OperationDefinition } from "./operation.ts";
import { Pack } from "./pack.ts";
import { Session } from "./session.ts";
import { TaskCommand, TaskCommandResult, TaskRejection } from "./task-commands.ts";
import { TaskRun } from "./task-run.ts";
import { ToolDefinition } from "./tool.ts";

export const CONTRACT_REGISTRY = {
  Session,
  Pack,
  Agent,
  OperationDefinition,
  Operation,
  TaskRun,
  TypedExecutionEvent,
  ApprovalRequest,
  ApprovalGrant,
  ArtifactRef,
  CreditReservation,
  CreditSettlement,
  CreditRelease,
  MemoryEntry,
  ToolDefinition,
  CollaborationMessage,
  SheraError,
  TaskCommand,
  TaskCommandResult,
  TaskRejection,
  EventPage,
  ListTaskEventsQuery,
  TriggerWebhookPayload,
  ...EVENT_ENVELOPES,
} as const;

export type ContractName = keyof typeof CONTRACT_REGISTRY;
export type ContractSchema = (typeof CONTRACT_REGISTRY)[ContractName];

/**
 * Explicitly extensible contracts (D25 exception register). Every entry must
 * carry a written rationale; the unknown-field contract test inverts its
 * expectation for these names only.
 */
export const EXTENSIBLE_CONTRACTS: Readonly<Record<string, string>> = {
  TriggerWebhookPayload:
    "Webhook bodies vary by source system; the transport bounds their size and " +
    "consumers must not treat unknown fields as meaningful (D25 exception, S02).",
};

/** Narrow a registry entry to its Zod type for test iteration. */
export type RegisteredSchema = z.ZodType;
