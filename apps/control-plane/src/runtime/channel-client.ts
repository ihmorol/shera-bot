/**
 * Runtime channel client (S06) — the control-plane side of the authenticated
 * internal channel (D2, PRD §16).
 *
 * Every call presents the per-container bearer token. The channel client is
 * transport-generic (fetch over the management network) and engine-agnostic:
 * a remote/cloud backend's runtime speaks the same contract. A 401 from the
 * container is a security-relevant event: it is surfaced as a typed
 * ChannelRejected error so the provisioning service records
 * `runtime_channel_auth_failed` centrally (the container records its own
 * rejection locally). No credential material ever appears in an error
 * message (G3).
 */
import {
  RUNTIME_CREDENTIALS_COMMIT_PATH,
  RUNTIME_CREDENTIALS_PATH,
  RUNTIME_REGISTRATION_PATH,
  RuntimeCredentialCommitResponse,
  RuntimeCredentialRotationResponse,
  RuntimeRegistrationResponse,
  type RuntimeRegistrationRequest,
} from "@shera-bot/contracts";

const DEFAULT_TIMEOUT_MS = 10_000;

export class ChannelRejected extends Error {
  readonly kind: "unauthorized" | "unreachable" | "invalid_response";
  readonly detail: string;

  constructor(kind: "unauthorized" | "unreachable" | "invalid_response", detail: string) {
    super(detail);
    this.name = "ChannelRejected";
    this.kind = kind;
    this.detail = detail;
  }
}

export interface RuntimeChannelClientOptions {
  timeout_ms?: number;
}

async function call<T extends { parse(input: unknown): unknown }>(
  endpoint: string,
  path: string,
  method: "POST" | "PUT",
  bearer: string,
  body: unknown,
  responseSchema: T,
  options: RuntimeChannelClientOptions,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${endpoint.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeout_ms ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ChannelRejected(
      "unreachable",
      `the runtime gateway did not answer: ${error instanceof Error ? error.name : "error"}`,
    );
  }
  if (response.status === 401) {
    throw new ChannelRejected(
      "unauthorized",
      "the runtime gateway rejected the channel credential",
    );
  }
  if (!response.ok) {
    throw new ChannelRejected(
      "invalid_response",
      `the runtime gateway answered ${response.status} for ${path}`,
    );
  }
  try {
    return responseSchema.parse(await response.json());
  } catch {
    throw new ChannelRejected(
      "invalid_response",
      `the runtime gateway response for ${path} is not contract-valid`,
    );
  }
}

/** Typed internal-channel calls used by the provisioning service. */
export class RuntimeChannelClient {
  private readonly options: RuntimeChannelClientOptions;

  constructor(options: RuntimeChannelClientOptions = {}) {
    this.options = options;
  }

  async register(
    endpoint: string,
    bearer: string,
    request: RuntimeRegistrationRequest,
  ): Promise<void> {
    await call(
      endpoint,
      RUNTIME_REGISTRATION_PATH,
      "POST",
      bearer,
      request,
      RuntimeRegistrationResponse,
      this.options,
    );
  }

  /** Stage the new credential digest, authenticated with the CURRENT token. */
  async stageCredential(
    endpoint: string,
    currentBearer: string,
    newCredentialSha256: string,
  ): Promise<void> {
    await call(
      endpoint,
      RUNTIME_CREDENTIALS_PATH,
      "PUT",
      currentBearer,
      { credential_sha256: newCredentialSha256 },
      RuntimeCredentialRotationResponse,
      this.options,
    );
  }

  /** Commit the rotation, authenticated with the NEW token; prunes other digests. */
  async commitCredential(endpoint: string, newBearer: string): Promise<void> {
    await call(
      endpoint,
      RUNTIME_CREDENTIALS_COMMIT_PATH,
      "POST",
      newBearer,
      {},
      RuntimeCredentialCommitResponse,
      this.options,
    );
  }
}
