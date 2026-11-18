import { afterEach, describe, expect, it, vi } from "vitest";

import { editTrigger, fetchFirings, pauseTrigger, resumeTrigger } from "../lib/schedules-api";

/**
 * The S28 schedules client's transport seams (lib/schedules-api.ts): the
 * trigger id travels in the URL path, so it must ride the SAME
 * encodeURIComponent convention every other runtime client uses
 * (agent-api.ts, operation-api.ts, approvals-api.ts, runtime-client.ts). The
 * proxy refuses "%" anywhere in a browser path, and an unencoded "?" or "/"
 * in an id would corrupt the path/query boundary before the allowlist ever
 * sees the intended route.
 */

const MUTATE_RESPONSE = { trigger_id: "trg_a", state: "paused" };
const EDIT_RESPONSE = { next_occurrence_at: null };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const body = url.endsWith("/edit")
        ? EDIT_RESPONSE
        : url.includes("/firings?")
          ? []
          : MUTATE_RESPONSE;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  return urls;
}

describe("schedules api — trigger id path encoding", () => {
  it("encodes the trigger id on the edit path", async () => {
    const urls = stubFetch();
    await editTrigger("ws_1", "trg_9?probe=1", { name: "Edited" });
    expect(urls[0]).toBe("/api/runtime/v1/schedules/trg_9%3Fprobe%3D1/edit");
  });

  it("encodes the trigger id on the pause and resume paths", async () => {
    const urls = stubFetch();
    await pauseTrigger("ws_1", "trg_9?probe=1");
    expect(urls[0]).toBe("/api/runtime/v1/schedules/trg_9%3Fprobe%3D1/pause");
    await resumeTrigger("ws_1", "trg_9?probe=1");
    expect(urls[1]).toBe("/api/runtime/v1/schedules/trg_9%3Fprobe%3D1/resume");
  });

  it("encodes the trigger id on the firings read", async () => {
    const urls = stubFetch();
    await fetchFirings("ws_1", "trg_9?probe=1");
    expect(urls[0]).toBe("/api/runtime/v1/schedules/trg_9%3Fprobe%3D1/firings?workspace_id=ws_1");
  });
});
