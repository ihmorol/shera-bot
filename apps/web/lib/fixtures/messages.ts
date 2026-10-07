import { z } from "zod";

/**
 * MOCK DATA — chat message fixtures. The S02 contracts define the runtime
 * event envelope, not chat bubbles; this UI-level schema carries the
 * presentation fields (§5 message bubbles, §21.5 attribution) and is clearly
 * scoped to the fixture layer. Agent senders reference `Agent.agent_id` from
 * the pack fixture, so attribution data (avatar, name, role) always resolves
 * from the contract-typed pack — never a duplicated identity record (D39).
 */
export const ChatMessage = z.strictObject({
  message_id: z.string(),
  conversation_id: z.string(),
  sender: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("user"), display_name: z.string() }),
    z.strictObject({ kind: z.literal("agent"), agent_id: z.string() }),
    z.strictObject({ kind: z.literal("system") }),
  ]),
  text: z.string().min(1),
  sent_at: z.string(),
  /** User-bubble status ticks (§5): sending / sent / failed-retry. */
  delivery: z.enum(["sending", "sent", "failed"]).default("sent"),
  /** §6.2 delivery class: replayed events render with the batch marker. */
  delivery_class: z.enum(["live", "replayed"]).default("live"),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

const A = "conversation_agent_";

/** General Assistant — the three oldest messages arrived as a replayed batch (§6.2). */
const GA_REPLAYED: ChatMessage[] = [
  ChatMessage.parse({
    message_id: "msg_ga_1",
    conversation_id: `${A}general_assistant`,
    sender: { kind: "user", display_name: "Emon" },
    text: "Morning — can you outline a plan for my thesis chapter on study methods?",
    sent_at: "2026-09-19T09:10:00Z",
    delivery_class: "replayed",
  }),
  ChatMessage.parse({
    message_id: "msg_ga_2",
    conversation_id: `${A}general_assistant`,
    sender: { kind: "agent", agent_id: "agent_general_assistant" },
    text: "Here is a three-pass plan: (1) scope the chapter around spaced repetition and retrieval practice, (2) gather 8–12 recent sources, (3) draft section by section with a methods deep-dive. I can delegate source gathering to the Researcher inside an Operation when you are ready.",
    sent_at: "2026-09-19T09:12:00Z",
    delivery_class: "replayed",
  }),
  ChatMessage.parse({
    message_id: "msg_ga_3",
    conversation_id: `${A}general_assistant`,
    sender: { kind: "user", display_name: "Emon" },
    text: "Good. Expand the methods part first.",
    sent_at: "2026-09-19T09:15:00Z",
    delivery_class: "replayed",
  }),
];

const GA_LIVE: ChatMessage[] = [
  ChatMessage.parse({
    message_id: "msg_ga_4",
    conversation_id: `${A}general_assistant`,
    sender: { kind: "agent", agent_id: "agent_general_assistant" },
    text: "Methods expansion is drafted below the plan. To fill the evidence gap I just flagged, I propose a web search — the runtime validates it before anything runs.",
    sent_at: "2026-09-20T10:12:00Z",
  }),
  ChatMessage.parse({
    message_id: "msg_ga_5",
    conversation_id: `${A}general_assistant`,
    sender: { kind: "user", display_name: "Emon" },
    text: "Go ahead — focus on 2024 or later.",
    sent_at: "2026-09-20T10:16:00Z",
  }),
];

const RESEARCHER: ChatMessage[] = [
  ChatMessage.parse({
    message_id: "msg_res_1",
    conversation_id: `${A}researcher`,
    sender: { kind: "user", display_name: "Emon" },
    text: "Find me recent papers on retrieval practice for exam prep — five is enough for today.",
    sent_at: "2026-09-19T16:20:00Z",
  }),
  ChatMessage.parse({
    message_id: "msg_res_2",
    conversation_id: `${A}researcher`,
    sender: { kind: "agent", agent_id: "agent_researcher" },
    text: "Shortlisted five candidates, all 2023 or newer. Two are open-access. I am reading them now and will summarize claim-by-claim with links.",
    sent_at: "2026-09-19T16:41:00Z",
  }),
  ChatMessage.parse({
    message_id: "msg_res_3",
    conversation_id: `${A}researcher`,
    sender: { kind: "agent", agent_id: "agent_researcher" },
    text: "Done — the digest is published to the workspace as sources-digest.md. Each claim links back to its source paragraph.",
    sent_at: "2026-09-20T09:48:00Z",
  }),
];

const TUTOR: ChatMessage[] = [
  ChatMessage.parse({
    message_id: "msg_tut_1",
    conversation_id: `${A}programming_tutor`,
    sender: { kind: "user", display_name: "Emon" },
    text: "My recursion solution passes the samples but fails the hidden tests. Where do I start?",
    sent_at: "2026-09-20T13:50:00Z",
  }),
  ChatMessage.parse({
    message_id: "msg_tut_2",
    conversation_id: `${A}programming_tutor`,
    sender: { kind: "agent", agent_id: "agent_programming_tutor" },
    text: "Trace the base case first — hidden tests usually probe empty or single-element input. Sketch your terminating condition and I will walk it with you. Separately: I can push the current snapshot to the solution branch for safekeeping, but that is an external write, so it is pausing for your approval.",
    sent_at: "2026-09-20T13:58:00Z",
  }),
];

const DEVELOPER: ChatMessage[] = [
  ChatMessage.parse({
    message_id: "msg_dev_1",
    conversation_id: `${A}developer`,
    sender: { kind: "user", display_name: "Emon" },
    text: "The test runner crashed mid-suite yesterday. Anything recoverable?",
    sent_at: "2026-09-19T13:58:00Z",
  }),
  ChatMessage.parse({
    message_id: "msg_dev_2",
    conversation_id: `${A}developer`,
    sender: { kind: "system" },
    text: "A run in this conversation needs recovery. The runtime will resume it automatically and report back here.",
    sent_at: "2026-09-19T14:20:00Z",
  }),
];

const CITATION: ChatMessage[] = [
  ChatMessage.parse({
    message_id: "msg_cit_1",
    conversation_id: `${A}citation_manager`,
    sender: { kind: "user", display_name: "Emon" },
    text: "Check the draft bibliography against APA 7 — flag anything mismatched.",
    sent_at: "2026-09-17T08:55:00Z",
  }),
  ChatMessage.parse({
    message_id: "msg_cit_2",
    conversation_id: `${A}citation_manager`,
    sender: { kind: "agent", agent_id: "agent_citation_manager" },
    text: "Checked 18 entries: 15 clean, 3 with missing DOIs and one inconsistent capitalization. The corrected draft is in the workspace.",
    sent_at: "2026-09-17T09:05:00Z",
  }),
];

const PLANNER: ChatMessage[] = [
  ChatMessage.parse({
    message_id: "msg_pla_1",
    conversation_id: `${A}study_planner`,
    sender: { kind: "user", display_name: "Emon" },
    text: "Rebalance my week — the algorithms midterm moved to Friday.",
    sent_at: "2026-09-19T17:55:00Z",
  }),
  ChatMessage.parse({
    message_id: "msg_pla_2",
    conversation_id: `${A}study_planner`,
    sender: { kind: "agent", agent_id: "agent_study_planner" },
    text: "Proposed a new schedule: algorithms gets Tue/Thu evenings, databases keeps Wednesday. It is queued to apply, but the run paused — credits for this month are reserved elsewhere. Settle or free a reservation and it resumes.",
    sent_at: "2026-09-19T18:02:00Z",
  }),
];

export const MESSAGES: ChatMessage[] = [
  ...GA_REPLAYED,
  ...GA_LIVE,
  ...RESEARCHER,
  ...TUTOR,
  ...DEVELOPER,
  ...CITATION,
  ...PLANNER,
];

export function messagesForConversation(conversationId: string): ChatMessage[] {
  return MESSAGES.filter((message) => message.conversation_id === conversationId).sort((a, b) =>
    a.sent_at.localeCompare(b.sent_at),
  );
}
