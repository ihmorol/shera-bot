import { createServer, type Server } from "node:http";
import { join, dirname } from "node:path";
import type { Express } from "express";
import { Id } from "@shera-bot/contracts";
import { channelState } from "../../adapters/fs/channel-state.ts";
import { ChannelCredentialStore } from "./channel-credentials.ts";
import { createInternalApi } from "./internal-api.ts";

export interface ManagementConfig {
  host: string;
  port: number;
  accountId: string;
  credentialSha256: string;
}
export function managementConfigFromEnv(env: NodeJS.ProcessEnv): ManagementConfig | undefined {
  const digest = env.SHERA_INTERNAL_CHANNEL_CREDENTIAL_SHA256;
  if (!digest) return undefined;
  const accountId = Id.parse(env.SHERA_ACCOUNT_ID);
  const port = Number(env.SHERA_INTERNAL_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("SHERA_INTERNAL_PORT must be a valid port");
  return { host: "0.0.0.0", port, accountId, credentialSha256: digest };
}
export function createManagementServer(
  config: ManagementConfig,
  localApi: Express,
  dbPath: string,
): Server {
  Id.parse(config.accountId);
  const state = channelState(
    join(dirname(dbPath), ".runtime-control", "channel.json"),
    config.credentialSha256,
  );
  let loaded = false;
  const credentials = new ChannelCredentialStore((values) => {
    if (loaded) state.save(values);
  });
  for (const value of state.digests) credentials.admitDigest(value);
  loaded = true;
  state.save(state.digests);
  const internal = createInternalApi({ credentials, accountId: config.accountId, localApi });
  return createServer(internal.app);
}
