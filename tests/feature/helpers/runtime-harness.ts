/**
 * Feature-QA harness — the shared boot for the cross-surface user journeys
 * under tests/feature/.
 *
 * Every journey boots the REAL composed user-runtime (`composeRuntime`: real
 * SQLite, real migrations, real routes, real journal, real services) as an
 * in-process HTTP server — the same boot every per-slice suite uses, so the
 * journeys exercise the product the browser actually talks to. No Docker, no
 * dev server, no live provider.
 *
 * The journeys drive ONLY the HTTP surface (`fetch` against the composed
 * origin), the way the web app's control-plane proxy does, except where a
 * journey explicitly names the service seam it drives (the credits ledger and
 * the scheduler fire seam are the recorded operator/admin channels).
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "../../../apps/user-runtime/src/transport/local-api/compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../apps/user-runtime/test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The pinned student pack the runtime loads at composition (D19/D28). */
export const PACKS_ROOT = resolve(here, "../../../agent-packs");

export const WS = DEFAULT_WORKSPACE_ID;
export const GENERAL = "agent_general_assistant";
export const RESEARCHER = "agent_researcher";
export const CITATION = "agent_citation_manager";
export const DEVELOPER = "agent_developer";

export interface FeatureRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dbPath: string;
  close(): Promise<void>;
}

export interface ComposeJourneyOptions {
  /** The injected clock (E37); the scheduler's truth source. */
  now?: () => string;
  scriptedToolProposal?: Parameters<typeof composeRuntime>[0]["scriptedToolProposal"];
  providerEnforcement?: boolean;
  workspaceId?: string;
  /** The supervised task-worker harness command (S16; the recovery journeys). */
  workerHarness?: Parameters<typeof composeRuntime>[0]["workerHarness"];
  workerPolicy?: Parameters<typeof composeRuntime>[0]["workerPolicy"];
  /**
   * Compose over an EXISTING store (the restart journeys). Default: a fresh
   * disposable database in a tracked temp directory.
   */
  dbPath?: string;
}

/**
 * Compose one journey runtime over a fresh disposable SQLite database and
 * listen on a loopback port. The handle is tracked for the shared cleanup.
 */
export async function composeJourney(
  options: ComposeJourneyOptions = {},
): Promise<FeatureRuntime> {
  const dbPath =
    options.dbPath ?? join(makeTempDir("shera-feature-"), "runtime.db");
  const runtime = composeRuntime({
    dbPath,
    packsRoot: PACKS_ROOT,
    ...(options.now ? { now: options.now } : {}),
    ...(options.scriptedToolProposal ? { scriptedToolProposal: options.scriptedToolProposal } : {}),
    ...(options.providerEnforcement !== undefined
      ? { providerEnforcement: options.providerEnforcement }
      : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.workerHarness ? { workerHarness: options.workerHarness } : {}),
    ...(options.workerPolicy ? { workerPolicy: options.workerPolicy } : {}),
  });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    dbPath,
    close: () => runtime.close(),
  };
}

export async function getJson(origin: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export async function postJson(
  origin: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export { cleanupTempResources, makeTempDir, mkdirSync };
