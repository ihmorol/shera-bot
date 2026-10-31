/**
 * The file-watch wake manager (S28 chunk 5; E5, chokidar MIT exact-pinned —
 * recorded in E37): chokidar is the LIVE detection source for agent-folder
 * watchers — it wakes the scheduler's tick the moment a private-folder
 * change lands instead of waiting for the poll. The SIGNATURE machinery
 * stays the dedup authority (the same observed state never fires twice), so
 * a wake can never manufacture a second firing — it only shortens the
 * latency of the one firing the next tick would produce.
 *
 * Watchers are maintained for the ACTIVE agent-scope file triggers; pause,
 * resume, and creation re-sync the set. Events are debounced (the default
 * 200 ms window is the flood-coalescing valve — a burst of events lands as
 * ONE wake).
 */
import { watch, type FSWatcher } from "chokidar";

import { agentFolderDir } from "../../adapters/fs/agent-folder-store.ts";
import type { TriggerRecordRow, TriggersRepository } from "../../adapters/sqlite/triggers-repository.ts";

export interface SchedulerWakeManagerDeps {
  triggers: TriggersRepository;
  workspaceId: string;
  agentFilesRoot: string;
  /** The wake callback (the scheduler's tick — the signature machinery dedups). */
  onWake: () => void;
  /** The flood-coalescing window (ms). */
  debounceMs?: number | undefined;
  /** Contained operator-fault sink. */
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export class SchedulerWakeManager {
  private readonly watchers = new Map<string, FSWatcher>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly deps: SchedulerWakeManagerDeps) {}

  /** Re-sync the watcher set with the active agent-scope file triggers. */
  sync(): void {
    if (this.stopped) return;
    const active = new Map<string, TriggerRecordRow>();
    for (const trigger of this.deps.triggers.listTriggersByKind(this.deps.workspaceId, "file_watch")) {
      if (trigger.state !== "active") continue;
      const config = JSON.parse(trigger.config_json) as {
        scope?: string;
        agent_id?: string;
      };
      if (config.scope !== "agent" || config.agent_id === undefined) continue;
      active.set(trigger.trigger_id, trigger);
    }
    // Stop watchers whose trigger vanished, paused, or changed scope.
    for (const [triggerId, watcher] of this.watchers) {
      if (!active.has(triggerId)) {
        void watcher.close().catch(() => {});
        this.watchers.delete(triggerId);
      }
    }
    for (const [triggerId, trigger] of active) {
      if (this.watchers.has(triggerId)) continue;
      const config = JSON.parse(trigger.config_json) as {
        path_uri: string;
        agent_id?: string;
      };
      const agentId = config.agent_id ?? "";
      const folder = agentFolderDir(this.deps.agentFilesRoot, this.deps.workspaceId, agentId);
      try {
        const watcher = watch(folder, {
          ignoreInitial: true, // a boot never replays history (AC4)
          depth: 12,
          awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
        });
        watcher.on("all", () => this.wake());
        watcher.on("error", (error: unknown) => {
          this.deps.logFault?.("agent_folder_watch_error", {
            trigger_id: triggerId,
            name: error instanceof Error ? error.name : "Error",
          });
        });
        this.watchers.set(triggerId, watcher);
      } catch (error) {
        // A folder that does not exist yet: no watcher — the poll tick owns
        // detection until the folder appears (a later sync picks it up).
        this.deps.logFault?.("agent_folder_watch_start_failed", {
          trigger_id: triggerId,
          name: error instanceof Error ? error.name : "Error",
        });
      }
    }
  }

  /** The debounced wake: a burst of events lands as ONE tick call. */
  private wake(): void {
    if (this.stopped) return;
    if (this.debounceTimer !== null) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      try {
        this.deps.onWake();
      } catch (error) {
        this.deps.logFault?.("agent_folder_wake_failed", {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.deps.debounceMs ?? 200);
    this.debounceTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const closing = [...this.watchers.values()].map((watcher) =>
      watcher.close().catch(() => {}),
    );
    this.watchers.clear();
    await Promise.all(closing);
  }
}
