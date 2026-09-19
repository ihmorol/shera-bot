/**
 * FakeContainerBackend tests (S06) — the deterministic fake models the same
 * adoption-path invariants the real LocalContainerBackend is held to:
 *
 * - Re-attach with the SAME credential returns the SAME handle and never
 *   creates a second container (I1: handle continuity).
 * - Re-provision with a DIFFERENT credential recreates: the old record is
 *   replaced by a new handle and the new credential digest is what the record
 *   carries (I2: the container's credential equals THIS call's digest).
 */
import { describe, expect, it } from "vitest";

import { FakeContainerBackend } from "./fake-container-backend.ts";
import { sha256Hex } from "../../../apps/control-plane/src/runtime/channel-token.ts";

const ACCOUNT = "a1b2c3d4-0000-4000-8000-000000000001";

function provisionRequest(accountId: string) {
  return {
    account_id: accountId,
    tier: "balanced" as const,
    request_id: `req-${Math.random().toString(36).slice(2)}`,
  };
}

describe("FakeContainerBackend adoption semantics (I1/I2)", () => {
  it("re-attach with the same credential returns the SAME handle and never a second container", async () => {
    const backend = new FakeContainerBackend();
    const first = await backend.provisionRuntime(provisionRequest(ACCOUNT), {
      internal_channel_token: "token-one",
    });
    const second = await backend.provisionRuntime(provisionRequest(ACCOUNT), {
      internal_channel_token: "token-one",
    });
    expect(second.result.runtime_handle).toBe(first.result.runtime_handle);
    expect(backend.containersCreated).toBe(1);
    expect(backend.recordFor(ACCOUNT).credential_sha256).toBe(sha256Hex("token-one"));
  });

  it("re-provision with a different credential recreates: new handle, new digest, still one container", async () => {
    const backend = new FakeContainerBackend();
    const first = await backend.provisionRuntime(provisionRequest(ACCOUNT), {
      internal_channel_token: "token-one",
    });

    const second = await backend.provisionRuntime(provisionRequest(ACCOUNT), {
      internal_channel_token: "token-two",
    });

    expect(second.result.runtime_handle).not.toBe(first.result.runtime_handle);
    expect(backend.containersCreated).toBe(1);
    expect(backend.recordFor(ACCOUNT).runtime_handle).toBe(second.result.runtime_handle);
    expect(backend.recordFor(ACCOUNT).credential_sha256).toBe(sha256Hex("token-two"));
    // The new handle resolves; the old one is gone with the old container.
    const status = await backend.getRuntimeStatus({
      runtime_handle: second.result.runtime_handle,
    });
    expect(status.account_id).toBe(ACCOUNT);
    expect(() => backend.recordFor(ACCOUNT)).not.toThrow();
  });
});
