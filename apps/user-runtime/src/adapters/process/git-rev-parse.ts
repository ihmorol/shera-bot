/**
 * The git rev-parse seam (S28; E5, G3) — the ONE place user-runtime shells
 * out to the git binary for a watcher signature read. The boundary guard
 * keeps child_process inside adapters/process (D23 rule 2); the scheduler's
 * watcher evaluation imports THIS seam, never the node API directly.
 *
 * One local, bounded call: `git rev-parse --verify --quiet <ref>` in the
 * project's own repository path. Synchronous by design — the runtime tick
 * stays deterministic (recorded in E37). No credential material ever flows
 * through here: the output is a sha (or the absent marker), never a URL or
 * a token (G3).
 */
import { execFileSync } from "node:child_process";

/** The branch's HEAD sha, or null when the branch/repo does not resolve. */
export function gitRevParseHead(repoPath: string, ref: string): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: repoPath,
      encoding: "utf8",
      maxBuffer: 1024,
      timeout: 5_000,
    });
    const trimmed = sha.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
