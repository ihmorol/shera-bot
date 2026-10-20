import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Only digests are persisted. A newly provisioned bootstrap invalidates old state. */
export function channelState(
  path: string,
  bootstrap: string,
): { digests: string[]; save(digests: string[]): void } {
  if (!/^[a-f0-9]{64}$/.test(bootstrap)) throw new Error("invalid channel credential digest");
  let digests = [bootstrap];
  if (existsSync(path)) {
    const state: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof state !== "object" ||
      state === null ||
      !("bootstrap" in state) ||
      !("digests" in state) ||
      typeof state.bootstrap !== "string" ||
      !Array.isArray(state.digests) ||
      state.digests.length < 1 ||
      state.digests.length > 2 ||
      !state.digests.every((v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
    )
      throw new Error("invalid persisted channel state");
    if (state.bootstrap === bootstrap) digests = state.digests;
  }
  return {
    digests,
    save(values) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ bootstrap, digests: values }), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, path);
    },
  };
}
