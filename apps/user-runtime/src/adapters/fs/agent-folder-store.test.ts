import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAgentFolderStore } from "./agent-folder-store.ts";

describe("durable private Agent files", () => {
  it("survives store reconstruction and isolates equal paths across workspaces and Agents", () => {
    const root = mkdtempSync(join(tmpdir(), "shera-files-"));
    try {
      const first = new FileAgentFolderStore(root);
      first.write("ws_a", "agent_researcher", "notes/source.txt", "Saved evidence");
      const reopened = new FileAgentFolderStore(root);
      expect(reopened.read("ws_a", "agent_researcher", "notes/source.txt")).toBe("Saved evidence");
      expect(reopened.read("ws_b", "agent_researcher", "notes/source.txt")).toBeNull();
      expect(reopened.read("ws_a", "agent_developer", "notes/source.txt")).toBeNull();
      for (const path of [
        "../outside",
        "a/../../outside",
        "a" + String.fromCharCode(92) + "outside",
        "file:stream",
        "CON.txt",
        "trailing.",
      ])
        expect(() => reopened.write("ws_a", "agent_researcher", path, "escape")).toThrow();
      expect(() =>
        reopened.write("ws_a", "agent_researcher", "large.txt", "a".repeat(65537)),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("refuses a linked private root", () => {
    const root = mkdtempSync(join(tmpdir(), "shera-links-"));
    const target = join(root, "target");
    try {
      new FileAgentFolderStore(target);
      symlinkSync(target, join(root, "link"), "junction");
      expect(() => new FileAgentFolderStore(join(root, "link"))).toThrow();
      writeFileSync(join(target, "unchanged.txt"), "preserved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
