import { describe, expect, it } from "vitest";
import type { TypedExecutionEvent } from "@shera-bot/contracts";

import {
  ChatMessage,
  CONVERSATIONS,
  ConversationState,
  FIXTURE_ARTIFACTS,
  FIXTURE_EVENTS,
  MESSAGES,
  OPERATION_INSTANCES,
  RUNS,
  STUDENT_PACK,
  agentById,
  buildThread,
  conversationForAgent,
  entitySlug,
  ingestEvents,
  sidebarModel,
  sortBySequence,
} from "../lib/fixtures";
import { firstUnreadMessageId } from "../lib/thread-layout";
import { fixtureHash } from "../lib/fixtures/fixture-hash";
import { PACK_AGENTS, PACK_OPERATION_TEMPLATES } from "../lib/navigation";
import { routes } from "../lib/routes";

/**
 * UI_DESIGN §9 mock-data contract: the fixture layer is typed with the real
 * S02 contracts, covers the required demo shapes, and stays honest (G2:
 * approval markers are pending proposals, never granted states). The §6.2
 * ingestion path dedupes duplicate event_ids (D26, D23 rule 6).
 */

describe("pack fixture (§9 #1)", () => {
  it("has the six pack Agents with identity fields", () => {
    expect(STUDENT_PACK.agents).toHaveLength(6);
    expect(STUDENT_PACK.agents.map((agent) => agent.display_name)).toEqual(
      PACK_AGENTS.map((agent) => agent.name),
    );
    for (const agent of STUDENT_PACK.agents) {
      expect(agent.role_description.length).toBeGreaterThan(0);
      expect(agent.default_provider.model.length).toBeGreaterThan(0);
    }
  });

  it("matches the D46 roster mapping exactly (S10 alignment — the demo fixture IS the student pack)", () => {
    expect(STUDENT_PACK.pack_id).toBe("student");
    const byId = (operationId: string) =>
      STUDENT_PACK.operations.find((operation) => operation.operation_id === operationId);
    const rosterOf = (operationId: string) => byId(operationId)?.roster ?? [];
    // D46 table, asserted verbatim.
    expect(rosterOf("operation_research_paper")).toEqual([
      "agent_general_assistant",
      "agent_researcher",
      "agent_citation_manager",
    ]);
    expect(rosterOf("operation_programming_assignment")).toEqual([
      "agent_general_assistant",
      "agent_developer",
      "agent_programming_tutor",
    ]);
    expect(rosterOf("operation_exam_preparation")).toEqual(["agent_study_planner"]);
    // Coordinators: pack default for the first two; the pack override for
    // Exam Preparation (Study Planner coordinates its own home Operation).
    expect(byId("operation_research_paper")?.coordinator).toBeUndefined();
    expect(byId("operation_programming_assignment")?.coordinator).toBeUndefined();
    expect(byId("operation_exam_preparation")?.coordinator).toBe("agent_study_planner");
    // Single membership (D46): no Agent appears in two rosters — EXCEPT the
    // pack default coordinator, whose cross-Operation presence is the
    // coordinator role, not a roster assignment (the canonical schema's rule).
    const rosterAgents = STUDENT_PACK.operations.flatMap((operation) => operation.roster);
    const nonCoordinator = rosterAgents.filter(
      (agentId) => agentId !== STUDENT_PACK.default_coordinator_agent_id,
    );
    expect(new Set(nonCoordinator).size).toBe(nonCoordinator.length);
  });

  it("has the three pack Operation templates matching the navigation seed", () => {
    expect(STUDENT_PACK.operations).toHaveLength(3);
    expect(STUDENT_PACK.operations.map((operation) => operation.title)).toEqual(
      PACK_OPERATION_TEMPLATES.map((operation) => operation.name),
    );
  });

  it("entity slugs resolve to the chunk-1 seeded routes", () => {
    for (const agent of STUDENT_PACK.agents) {
      expect(PACK_AGENTS.some((entry) => entry.slug === entitySlug(agent.agent_id))).toBe(true);
    }
    for (const operation of STUDENT_PACK.operations) {
      expect(
        PACK_OPERATION_TEMPLATES.some((entry) => entry.slug === entitySlug(operation.operation_id)),
      ).toBe(true);
    }
    const matchers = [routes.agent("general-assistant"), routes.operationPreview("research-paper")];
    expect(matchers.every((href) => href.startsWith("/app/"))).toBe(true);
  });

  it("fixtureHash is a stable, distinct, format-valid Sha256Hex stand-in", () => {
    const digest = fixtureHash("pack_student/v1.0.0");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(fixtureHash("pack_student/v1.0.0")).toBe(digest);
    expect(fixtureHash("operation_research_paper/v1.0.0")).not.toBe(digest);
    // Pack and operation hashes parse with the real contract.
    expect(STUDENT_PACK.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
    for (const operation of STUDENT_PACK.operations) {
      expect(operation.content_hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe("conversation fixtures (§9 #2)", () => {
  it("seeds one direct chat per Agent plus two Operation chats", () => {
    expect(CONVERSATIONS).toHaveLength(8);
    const directChats = CONVERSATIONS.filter(
      (conversation) => conversation.kind === "agent_direct",
    );
    expect(directChats).toHaveLength(6);
    for (const agent of STUDENT_PACK.agents) {
      expect(conversationForAgent(agent.agent_id)).toBeDefined();
    }
    expect(OPERATION_INSTANCES).toHaveLength(2);
    expect(OPERATION_INSTANCES[0]?.definition).not.toBeNull();
    expect(OPERATION_INSTANCES[1]?.definition).toBeNull(); // the ad-hoc chat (D41)
  });

  it("keeps ad-hoc subtitles in the §3.2 roster-summary form", () => {
    const adhoc = CONVERSATIONS.find(
      (conversation) => conversation.conversation_id === "conversation_op_adhoc_terms",
    );
    expect(adhoc?.subtitle).toBe("Ad-hoc · 2 Agents");
  });
});

describe("run fixtures (§9 #3)", () => {
  it("covers every required demo state", () => {
    const states = new Set(RUNS.map((run) => run.state));
    for (const required of [
      "RUNNING",
      "WAITING_FOR_APPROVAL",
      "RETRYING",
      "SUCCEEDED",
      "FAILED",
      "PAUSED",
      "RECOVERY_REQUIRED",
    ]) {
      expect(states.has(required as (typeof RUNS)[number]["state"]), `missing ${required}`).toBe(
        true,
      );
    }
  });

  it("shows RETRYING at 2 of 3 attempts and SUCCEEDED with artifacts", () => {
    const retrying = RUNS.find((run) => run.state === "RETRYING");
    expect(retrying?.retry_count).toBe(2);
    const succeededIds = new Set(
      RUNS.filter((run) => run.state === "SUCCEEDED").map((run) => run.task_id),
    );
    expect(FIXTURE_ARTIFACTS.length).toBeGreaterThan(0);
    for (const artifact of FIXTURE_ARTIFACTS) {
      expect(succeededIds.has(artifact.producer_task_id)).toBe(true);
    }
  });
});

describe("sidebar model (§3.2, PRD §4.1)", () => {
  it("lists six Agents, three templates, and two Operation chats", () => {
    const model = sidebarModel();
    expect(model.agents).toHaveLength(6);
    expect(model.templates).toHaveLength(3);
    expect(model.operationChats).toHaveLength(2);
  });

  it("derives honest states from the run fixtures", () => {
    const model = sidebarModel();
    const byAgent = new Map(model.agents.map((entry) => [entry.agent.agent_id, entry]));
    // General Assistant: a RUNNING run wins over the unread count.
    expect(byAgent.get("agent_general_assistant")?.state).toBe("running");
    // Researcher: SUCCEEDED run only, unread seed → unread.
    expect(byAgent.get("agent_researcher")?.state).toBe("unread");
    // Developer: RECOVERY_REQUIRED → needs review.
    expect(byAgent.get("agent_developer")?.state).toBe("failed");
    // Citation Manager: SUCCEEDED run, nothing unread → quiet.
    expect(byAgent.get("agent_citation_manager")?.state).toBe("quiet");
    // Operation chats: pack-defined is running, ad-hoc FAILED run → review.
    expect(model.operationChats[0]?.state).toBe("running");
    expect(model.operationChats[1]?.state).toBe("failed");
  });

  it("splits the failed state per §2.1: red for FAILED runs, amber for review", () => {
    const model = sidebarModel();
    const byAgent = new Map(model.agents.map((entry) => [entry.agent.agent_id, entry]));
    // Developer: RECOVERY_REQUIRED — waiting on the user, not an error → review (amber).
    expect(byAgent.get("agent_developer")?.attention).toBe("review");
    // Study Planner: PAUSED (insufficient credits) — attention, not an error → review (amber).
    expect(byAgent.get("agent_study_planner")?.attention).toBe("review");
    // Ad-hoc Operation: a genuinely FAILED run → error (red).
    expect(model.operationChats[1]?.attention).toBe("error");
    // Non-failed conversations carry no attention variant.
    expect(byAgent.get("agent_general_assistant")?.attention).toBeUndefined();
    expect(byAgent.get("agent_researcher")?.attention).toBeUndefined();
  });

  it("renders approval_required only for WAITING_FOR_APPROVAL runs (G2)", () => {
    const model = sidebarModel();
    const approvalEntries = [...model.agents, ...model.operationChats].filter(
      (entry) => entry.state === "approval_required",
    );
    expect(approvalEntries.length).toBeGreaterThan(0);
    for (const entry of approvalEntries) {
      const waiting = RUNS.filter(
        (run) =>
          run.conversation_id === entry.conversation.conversation_id &&
          run.state === "WAITING_FOR_APPROVAL",
      );
      expect(waiting.length).toBe(entry.approvalCount);
      expect(entry.approvalCount).toBeGreaterThan(0);
    }
    // The state vocabulary itself has no granted member — a decision is a
    // runtime event, never a sidebar state.
    expect(ConversationState.options).toEqual([
      "unread",
      "running",
      "approval_required",
      "failed",
      "quiet",
    ]);
  });
});

describe("event ingestion (§6.2, D26)", () => {
  it("ignores duplicate event_ids — first occurrence wins (D23 rule 6)", () => {
    const [first, second, third] = FIXTURE_EVENTS;
    expect(first && second && third).toBeTruthy();
    // A distinct object carrying the same event_id (equal values, new identity).
    const duplicateOfFirst = JSON.parse(JSON.stringify(first)) as TypedExecutionEvent;
    expect(duplicateOfFirst).not.toBe(first);
    const accepted = ingestEvents(new Set(), [first!, duplicateOfFirst, second!, third!]);
    expect(accepted.accepted).toHaveLength(3);
    expect(accepted.duplicateCount).toBe(1);
    // The kept record is the first occurrence, not the replacement.
    expect(accepted.accepted[0]).toBe(first);
    expect(accepted.accepted.map((event) => event.event_id)).toEqual([
      first!.event_id,
      second!.event_id,
      third!.event_id,
    ]);
  });

  it("dedupes against already-known event ids from the store", () => {
    const [first] = FIXTURE_EVENTS;
    const known = new Set([first!.event_id]);
    const result = ingestEvents(known, [first!, first!]);
    expect(result.accepted).toHaveLength(0);
    expect(result.duplicateCount).toBe(2);
  });

  it("sortBySequence orders by stream then 1-based sequence", () => {
    const ordered = sortBySequence([...FIXTURE_EVENTS].reverse());
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!;
      const current = ordered[i]!;
      const streamOrder = previous.stream_id.localeCompare(current.stream_id);
      expect(streamOrder <= 0).toBe(true);
      if (streamOrder === 0) {
        expect(previous.sequence).toBeLessThan(current.sequence);
      }
    }
  });
});

describe("thread assembly (§6.2 replay honesty)", () => {
  it("closes the replayed batch with the exact §6.2 boundary marker count", () => {
    const thread = buildThread("conversation_agent_general_assistant");
    const messageItems = thread.filter((item) => item.kind === "message");
    const firstLiveIndex = messageItems.findIndex(
      (item) => item.kind === "message" && item.message.delivery_class === "live",
    );
    // The three seeded replayed messages come first, live resumes after them.
    expect(firstLiveIndex).toBe(3);
    const boundary = thread.find((item) => item.kind === "replay_boundary");
    expect(boundary).toEqual({ kind: "replay_boundary", at: expect.any(String), count: 3 });
    // The boundary sits at the seam: after the last replayed message, before
    // the first live item — replayed content is never interleaved as live.
    const boundaryAt = boundary!.at;
    const lastReplayed = messageItems[2]!;
    const firstLive = messageItems[3]!;
    expect(boundaryAt >= lastReplayed.at).toBe(true);
    expect(boundaryAt <= firstLive.at).toBe(true);
  });

  it("renders no boundary for conversations without replayed messages", () => {
    const thread = buildThread("conversation_agent_researcher");
    expect(thread.some((item) => item.kind === "replay_boundary")).toBe(false);
  });

  it("builds cards strictly from typed fixture records", () => {
    const researcher = buildThread("conversation_agent_researcher");
    expect(researcher.some((item) => item.kind === "artifact")).toBe(true);
    const tutor = buildThread("conversation_agent_programming_tutor");
    expect(
      tutor.some((item) => item.kind === "tool_card" && item.status === "pausing_for_approval"),
    ).toBe(true);
    const general = buildThread("conversation_agent_general_assistant");
    expect(general.some((item) => item.kind === "tool_card" && item.status === "proposed")).toBe(
      true,
    );
    expect(general.some((item) => item.kind === "run")).toBe(true);
  });
});

describe("message fixtures (§21.5 attribution data)", () => {
  it("resolves every Agent sender from the pack — no duplicated identity", () => {
    for (const message of MESSAGES) {
      if (message.sender.kind === "agent") {
        expect(agentById(message.sender.agent_id)).toBeDefined();
      }
    }
  });

  it("keeps every message inside a seeded conversation with a delivery class", () => {
    const conversationIds = new Set(
      CONVERSATIONS.map((conversation) => conversation.conversation_id),
    );
    for (const message of MESSAGES) {
      expect(conversationIds.has(message.conversation_id)).toBe(true);
      expect(["live", "replayed"]).toContain(message.delivery_class);
      expect(["sending", "sent", "failed"]).toContain(message.delivery);
    }
  });

  it("parses locally-sent demo messages through the real schema", () => {
    const message = ChatMessage.parse({
      message_id: "msg_test_local",
      conversation_id: "conversation_agent_researcher",
      sender: { kind: "user", display_name: "Emon" },
      text: "hello",
      sent_at: "2026-09-30T09:00:00Z",
      delivery: "sending",
    });
    expect(message.delivery_class).toBe("live");
  });
});

describe("jump-to-unread anchor (§S3)", () => {
  it("anchors on the last unread message of the seeded thread", () => {
    // The general-assistant chat seeds 5 messages with 2 unread.
    const thread = buildThread("conversation_agent_general_assistant");
    const messages = thread.filter((item) => item.kind === "message");
    expect(messages).toHaveLength(5);
    const anchorId = firstUnreadMessageId(thread, 2);
    expect(anchorId).toBe(messages[3]!.message.message_id);
  });

  it("returns no anchor when nothing is unread", () => {
    const thread = buildThread("conversation_agent_researcher");
    expect(firstUnreadMessageId(thread, 0)).toBeNull();
  });
});
