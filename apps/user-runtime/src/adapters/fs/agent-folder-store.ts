import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { AgentFolderStore } from "../../modules/agents/agent-folders.service.ts";

const MAX_BYTES = 64 * 1024;
function validSegment(value: string): boolean {
  return (
    !value.includes(String.fromCharCode(92)) &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes(":") &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    !/[. ]$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  );
}
function existing(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/** Runtime-owned storage, outside the files exposed to task processes. */
export class FileAgentFolderStore implements AgentFolderStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink())
      throw new Error("private folder root must not be a link");
  }
  private file(workspaceId: string, agentId: string, path: string, create: boolean): string | null {
    if (!validSegment(agentId)) throw new Error("invalid private folder owner");
    const parts = path.split("/");
    if (!parts.every(validSegment)) throw new Error("invalid private folder path");
    const scope = createHash("sha256").update(workspaceId).digest("hex");
    let current = this.root;
    // shortcut: roots are runtime-owned and inaccessible to task processes; use
    // descriptor-relative operations if that ownership boundary changes.
    for (const part of [scope, agentId, ...parts.slice(0, -1)]) {
      current = join(current, part);
      let info = existing(current);
      if (!info && create) {
        mkdirSync(current, { mode: 0o700 });
        info = lstatSync(current);
      }
      if (!info) return null;
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("private folder parent is not a directory");
    }
    const file = join(current, parts.at(-1)!);
    const info = existing(file);
    if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1))
      throw new Error("private file is not an isolated regular file");
    return file;
  }
  read(workspaceId: string, agentId: string, path: string): string | null {
    if (path === "") return null;
    const file = this.file(workspaceId, agentId, path, false);
    if (file === null || !existing(file)) return null;
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES)
        throw new Error("private file exceeds storage policy");
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }
  write(workspaceId: string, agentId: string, path: string, content: string): void {
    if (Buffer.byteLength(content, "utf8") > MAX_BYTES)
      throw new Error("private file exceeds storage policy");
    const file = this.file(workspaceId, agentId, path, true)!;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
    } finally {
      if (existing(temporary)) unlinkSync(temporary);
    }
  }
}
