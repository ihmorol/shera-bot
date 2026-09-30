import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StreamingMessage } from "../components/chat/streaming-message";
import { DEMO_STREAM, splitStreamChunks } from "../lib/fixtures";
import { STREAM_ANNOUNCE_MS, STREAM_THROTTLE_MS, streamFrameAt } from "../lib/streaming";

/**
 * §6.1 streaming render (demo streaming): incremental text with a typing
 * cursor, DOM updates throttled to the ≥30fps budget, a throttled polite
 * announcement, a Stop control with an accessible name, and reduced-motion
 * coverage for the cursor animation.
 */

const render = (element: ReactElement): string => renderToStaticMarkup(element);

describe("stream fixture (§9 scripted scenario)", () => {
  it("splits the scripted reply into deterministic token-ish chunks", () => {
    expect(splitStreamChunks("one two three")).toEqual(["one ", "two ", "three"]);
    expect(DEMO_STREAM.chunks.length).toBeGreaterThan(10);
    expect(DEMO_STREAM.chunk_cadence_ms).toBe(10);
    // Chunks reassemble to the full scripted reply.
    expect(DEMO_STREAM.chunks.join("")).toBe(
      "Methods deep-dive drafted: spaced repetition outperforms massed practice for retention, and retrieval practice adds testing-effect gains. Four 2024-or-newer sources are flagged for the evidence table — the Researcher can verify them inside an Operation when you launch it.",
    );
  });

  it("belongs to the General Assistant conversation only", () => {
    expect(DEMO_STREAM.conversation_id).toBe("conversation_agent_general_assistant");
    expect(DEMO_STREAM.agent_id).toBe("agent_general_assistant");
  });
});

describe("stream frame math (§6.1 throttling)", () => {
  const chunks = DEMO_STREAM.chunks;
  const cadence = DEMO_STREAM.chunk_cadence_ms;

  it("delivers chunks on the fixture cadence and completes", () => {
    const early = streamFrameAt(chunks, cadence * 5, cadence);
    expect(early.deliveredChunks).toBe(5);
    expect(early.done).toBe(false);
    const finished = streamFrameAt(chunks, cadence * chunks.length + 1, cadence);
    expect(finished.done).toBe(true);
    expect(finished.visibleText).toBe(chunks.join(""));
  });

  it("throttles DOM updates to the 30fps budget — far below chunk cadence", () => {
    // 450ms of stream at 10ms cadence = 45 chunk events…
    const mid = streamFrameAt(chunks, cadence * chunks.length, cadence);
    expect(mid.deliveredChunks).toBe(chunks.length);
    // …but only ~13 DOM flushes at the 33ms budget.
    const budget = Math.floor((cadence * chunks.length) / STREAM_THROTTLE_MS);
    expect(mid.domUpdates).toBe(budget);
    expect(mid.domUpdates).toBeLessThan(mid.deliveredChunks);
    expect(STREAM_THROTTLE_MS).toBe(33); // ≥30fps budget
  });

  it("throttles the polite announcement below the visible-text cadence", () => {
    const mid = streamFrameAt(chunks, 300, cadence);
    expect(mid.announcementText.length).toBeLessThan(mid.visibleText.length);
    expect(mid.announcementText).toBe(
      chunks
        .slice(0, Math.floor((Math.floor(300 / STREAM_ANNOUNCE_MS) * STREAM_ANNOUNCE_MS) / cadence))
        .join(""),
    );
    // On completion the announcement carries the full text.
    const finished = streamFrameAt(chunks, cadence * chunks.length + 1, cadence);
    expect(finished.announcementText).toBe(chunks.join(""));
  });
});

describe("streaming message component (§6.1 + §2.3)", () => {
  it("renders attribution, the partial text, and the typing cursor", () => {
    const frame = streamFrameAt(DEMO_STREAM.chunks, 120, DEMO_STREAM.chunk_cadence_ms);
    const html = render(
      createElement(StreamingMessage, {
        agentId: DEMO_STREAM.agent_id,
        visibleText: frame.visibleText,
        done: frame.done,
        stopped: false,
        onStop: () => undefined,
      }),
    );
    expect(html).toContain("General Assistant");
    expect(html).toContain("Default coordinator of every Operation");
    expect(html).toContain("spaced repetition outperforms");
    expect(html).toContain('data-streaming-cursor=""');
    expect(html).toContain('aria-live="polite"');
  });

  it("labels the mechanism as demo streaming and names the Stop control", () => {
    const html = render(
      createElement(StreamingMessage, {
        agentId: DEMO_STREAM.agent_id,
        visibleText: "partial",
        done: false,
        stopped: false,
        onStop: () => undefined,
      }),
    );
    expect(html).toContain("demo stream");
    expect(html).toContain('aria-label="Stop streaming"');
  });

  it("drops the cursor once done and shows the stopped note without one", () => {
    const done = render(
      createElement(StreamingMessage, {
        agentId: DEMO_STREAM.agent_id,
        visibleText: DEMO_STREAM.chunks.join(""),
        done: true,
        stopped: false,
        onStop: () => undefined,
      }),
    );
    expect(done).not.toContain('data-streaming-cursor=""');
    expect(done).not.toContain("Stop streaming");

    const stopped = render(
      createElement(StreamingMessage, {
        agentId: DEMO_STREAM.agent_id,
        visibleText: "partial",
        done: false,
        stopped: true,
        onStop: () => undefined,
      }),
    );
    expect(stopped).not.toContain('data-streaming-cursor=""');
    expect(stopped).toContain("stopped locally");
    // The stop is honest: it stops only the local demo stream (D32 note).
    expect(stopped).toContain("D32");
  });

  it("announces the sender — the stream region carries the 'said:' prefix", () => {
    const html = render(
      createElement(StreamingMessage, {
        agentId: DEMO_STREAM.agent_id,
        visibleText: "partial",
        done: false,
        stopped: false,
        onStop: () => undefined,
      }),
    );
    expect(html).toContain("General Assistant said:");
  });

  it("cursor blink is a CSS animation covered by prefers-reduced-motion", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "app", "globals.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/animation-duration:\s*0\.01ms/);
    // The cursor animates via a Tailwind animation class (animate-pulse), so
    // the global reduced-motion rule stills it — no JS-driven blink exists.
    expect(css).not.toMatch(/@keyframes blink/);
  });
});
