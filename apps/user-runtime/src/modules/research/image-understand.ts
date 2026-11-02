/**
 * Image understanding (S25 chunk 4; issue #26; PRD §5.1, §7; D15, D17, D27,
 * G3/G7) — uploaded images through the S23 AI SDK vision seam: one-shot
 * `generateText` with `maxRetries: 0` (the E33-era lesson — a silent SDK
 * retry would multiply provider calls and stretch the tool's own deadline;
 * the RUNTIME owns retry decisions through the S22 policy), the tool's own
 * deadline as the abort signal, and the executor's cancel seam honoured.
 *
 * The description is the derived artifact (provenance-stamped, redacted at
 * the binding boundary before the sink); the result text carries the
 * bounded description. Default CI drives a deterministic mock model (G7:
 * no live provider in the default run); the live-provider posture is the
 * recorded opt-in item.
 */
import { APICallError, generateText, type LanguageModel } from "ai";

import { mapFetchFailure } from "./research-http.ts";
import { ResearchToolError } from "./research-errors.ts";

/** The image formats the tool handles (the honest, closed set). */
export const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;

/** The honest default instruction when the proposal carries no prompt. */
export const DEFAULT_IMAGE_PROMPT =
  "Describe this image factually: its subject, any visible text, and the details relevant to the requesting task.";

function mediaTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      throw new ResearchToolError(
        "RESEARCH_SOURCE_UNREADABLE",
        `unsupported image format ${extension === "" ? "(no extension)" : extension} — supported: ${SUPPORTED_IMAGE_EXTENSIONS.join(", ")}`,
      );
  }
}

/**
 * Describe one image's bytes through the configured vision model. The model
 * resolver is the composition's seam (chunk-4 wiring); every failure is the
 * typed research error with the deadline and cancel seams honoured.
 */
export async function describeImageBytes(deps: {
  model: LanguageModel;
  bytes: Uint8Array;
  mediaType: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ description: string }> {
  const timeoutSignal = AbortSignal.timeout(deps.timeoutMs);
  const abortSignal =
    deps.signal !== undefined ? AbortSignal.any([timeoutSignal, deps.signal]) : timeoutSignal;
  const cancelSignal: AbortSignal | null = deps.signal ?? null;
  let text: string;
  try {
    const result = await generateText({
      model: deps.model,
      // ONE honest request: the SDK's default retry/backoff would silently
      // multiply provider calls (E33-era lesson) and stretch the tool's
      // own deadline past honesty. The runtime owns retries (S22).
      maxRetries: 0,
      abortSignal,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: deps.prompt },
            { type: "file", data: deps.bytes, mediaType: deps.mediaType },
          ],
        },
      ],
    });
    text = result.text;
  } catch (error) {
    if (error instanceof ResearchToolError) {
      throw error;
    }
    // A provider 4xx (other than 429) is the endpoint refusing the request
    // — a configuration/contract fault, not a chance failure.
    if (
      APICallError.isInstance(error) &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500 &&
      error.statusCode !== 429
    ) {
      throw new ResearchToolError(
        "RESEARCH_RESPONSE_INVALID",
        `the vision endpoint refused the request with HTTP ${error.statusCode}`,
      );
    }
    throw mapFetchFailure(error, {
      cancelSignal,
      timeoutSignal,
      what: "the image description request",
    });
  }
  const description = text.trim();
  if (description === "") {
    throw new ResearchToolError(
      "RESEARCH_RESPONSE_INVALID",
      "the vision endpoint returned an empty description",
    );
  }
  return { description };
}

/** Resolve an uploaded image's media type (the registration-side guard). */
export function imageMediaType(path: string): string {
  return mediaTypeOf(path);
}
