import { z } from "zod";

/**
 * MOCK DATA — demo streaming fixture (§6.1 scripted scenario). The chat
 * thread streams a scripted Assistant reply from these chunks on timers:
 * this is DEMO STREAMING — a fixture-driven stand-in for the runtime's
 * `message_delta` stream, clearly labeled in code and in the UI. It never
 * pretends a runtime call happened; the streamed text is fixture copy, and
 * the Stop control stops only this local demo stream (real cancellation is
 * a typed runtime command, D23 rule 6 / D32).
 */

export const FixtureStream = z.strictObject({
  conversation_id: z.string(),
  agent_id: z.string(),
  /** id of the message the streamed text becomes once complete. */
  message_id: z.string(),
  /** Full scripted reply split into token-sized chunks, in order. */
  chunks: z.array(z.string()).min(1),
  /** Conceptual chunk arrival cadence (ms) — the DOM stays throttled. */
  chunk_cadence_ms: z.number().int().positive(),
  /**
   * Fixture timestamp the completed reply carries (§6.2 ordering: it
   * continues the scripted conversation — after the last live seeded
   * message, before the replayed batch). The completed message is derived
   * during render, so the stamp must be deterministic fixture time, not a
   * capture-time Date.
   */
  completed_sent_at: z.string(),
});

export type FixtureStream = z.infer<typeof FixtureStream>;

/** Split a scripted reply into deterministic token-ish chunks (word + space). */
export function splitStreamChunks(text: string): string[] {
  const words = text.split(" ").filter((word) => word.length > 0);
  return words.map((word, index) => (index === words.length - 1 ? word : `${word} `));
}

const DEMO_STREAM_TEXT =
  "Methods deep-dive drafted: spaced repetition outperforms massed practice for retention, and retrieval practice adds testing-effect gains. Four 2024-or-newer sources are flagged for the evidence table — the Researcher can verify them inside an Operation when you launch it.";

export const DEMO_STREAM: FixtureStream = FixtureStream.parse({
  conversation_id: "conversation_agent_general_assistant",
  agent_id: "agent_general_assistant",
  message_id: "msg_stream_ga_methods",
  chunks: splitStreamChunks(DEMO_STREAM_TEXT),
  chunk_cadence_ms: 10,
  // After msg_ga_5 (10:16, the last live GA message) and before the
  // connection-demo replayed batch (10:18) — the reply lands mid-exchange.
  completed_sent_at: "2026-09-20T10:17:30Z",
});
