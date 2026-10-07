/**
 * Contract registry: every top-level S02 schema in one map, plus the explicit
 * extensibility register (D25: "unknown fields are rejected for internal
 * protocol messages unless explicitly marked extensible").
 *
 * The contract tests enforce this registry: completeness tests in both the
 * round-trip and unknown-field suites require every registered top-level
 * schema to have a fixture case (envelope-union members are covered through
 * the TypedExecutionEvent cases), and every case is poisoned for unknown-field
 * rejection — so a schema added without a fixture or without strictness fails
 * the suite. (Registry-driven completeness added 2026-09-19 on review.)
 */
import type { z } from "zod";

import { Agent, AgentSettingsCommand, AgentSettingsOverrides, AgentSettingsSnapshot } from "./agent.ts";
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
import {
  GetRuntimeStatusInput,
  ProvisionRuntimeInput,
  ProvisionRuntimeResult,
  ResourceSummary,
  ResumeRuntimeInput,
  ResumeRuntimeResult,
  RuntimeRegistrationRequest,
  RuntimeRegistrationResponse,
  RuntimeStatus,
  RuntimeCredentialCommitRequest,
  RuntimeCredentialCommitResponse,
  RuntimeCredentialRotationRequest,
  RuntimeCredentialRotationResponse,
  StopRuntimeInput,
  StopRuntimeResult,
} from "./runtime.ts";
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
  // S06 (runtime backend contract + internal channel; D12, D2).
  ResourceSummary,
  ProvisionRuntimeInput,
  ProvisionRuntimeResult,
  ResumeRuntimeInput,
  ResumeRuntimeResult,
  StopRuntimeInput,
  StopRuntimeResult,
  GetRuntimeStatusInput,
  RuntimeStatus,
  RuntimeRegistrationRequest,
  RuntimeRegistrationResponse,
  RuntimeCredentialRotationRequest,
  RuntimeCredentialRotationResponse,
  RuntimeCredentialCommitRequest,
  RuntimeCredentialCommitResponse,
  // S11 (D16 agent settings command surface; reused verbatim by S30 onboarding).
  AgentSettingsCommand,
  AgentSettingsSnapshot,
  AgentSettingsOverrides,
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
