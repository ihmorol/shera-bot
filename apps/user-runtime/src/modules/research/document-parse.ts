/**
 * Uploaded-document parsing (S25 chunk 3; issue #26; PRD §5.1–5.3; D15,
 * D23 rule 8, G3) — PDF text extraction through unpdf 1.3.2 (MIT,
 * exact-pinned; the bundled pdf.js), plain text passthrough for text
 * documents. Unsupported formats are the typed RESEARCH_SOURCE_UNREADABLE,
 * naming the supported set — never a guessed extraction (G4).
 *
 * The parse-bomb caps (review fix F5): the INPUT byte cap refuses a hostile
 * oversized upload typed BEFORE any parser runs (the PDF decoder never sees
 * the bytes), and the DERIVED text budget truncates an over-budget parse
 * with the honest marker — the artifact holds the real head, its size
 * bounded, the cut recorded (G4), never an unbounded in-process parse.
 * pdf.js (the unpdf bundle) exposes no abort seam for an in-flight parse
 * (no `signal` in its DocumentInitParameters) — recorded honestly in E40;
 * the input cap is what bounds the decoder's work.
 */
import { extractText, getDocumentProxy } from "unpdf";

import { ResearchToolError } from "./research-errors.ts";

/** The document formats the parser handles (the honest, closed set). */
export const SUPPORTED_DOCUMENT_EXTENSIONS = [".pdf", ".txt", ".md", ".markdown"] as const;

/** The parse INPUT cap: a larger upload refuses typed before any parse. */
export const DOCUMENT_MAX_INPUT_BYTES = 20 * 1024 * 1024;
/** The DERIVED text budget: a larger parse is truncated with the marker. */
export const DOCUMENT_TEXT_MAX_CHARS = 4 * 1024 * 1024;

export interface ParsedDocument {
  kind: "pdf" | "text";
  text: string;
  /** PDF page count when the source was a PDF; null for text documents. */
  pages: number | null;
  /** True when the derived text budget cut the parsed text. */
  truncated: boolean;
}

/** Per-call cap overrides (the tools' defaults are the constants above). */
export interface ParseCapOptions {
  maxInputBytes?: number;
  maxTextChars?: number;
}

function extensionOf(path: string): string {
  const clean = path.split("?")[0] ?? path;
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot).toLowerCase();
}

/**
 * Parse one uploaded document's bytes: PDFs through unpdf (merged pages),
 * text/markdown as themselves. The extension decides the parser; a format
 * outside the declared set refuses typed; an over-cap upload refuses typed
 * BEFORE any parser runs (review fix F5).
 */
export async function parseDocumentBytes(
  path: string,
  bytes: Uint8Array,
  opts: ParseCapOptions = {},
): Promise<ParsedDocument> {
  const extension = extensionOf(path);
  const maxInputBytes = opts.maxInputBytes ?? DOCUMENT_MAX_INPUT_BYTES;
  const maxTextChars = opts.maxTextChars ?? DOCUMENT_TEXT_MAX_CHARS;
  if (bytes.byteLength > maxInputBytes) {
    // The parse-bomb refusal happens BEFORE the parser (and before the
    // redaction boundary) — the hostile bytes are counted, never decoded.
    throw new ResearchToolError(
      "RESEARCH_INPUT_INVALID",
      `the document exceeds the ${maxInputBytes}-byte parse cap (${bytes.byteLength} bytes)`,
    );
  }
  if (extension === ".pdf") {
    try {
      const pdf = await getDocumentProxy(bytes);
      const { text, totalPages } = await extractText(pdf, { mergePages: true });
      return capParsedText({ kind: "pdf", text, pages: totalPages }, maxTextChars);
    } catch (error) {
      throw new ResearchToolError(
        "RESEARCH_SOURCE_UNREADABLE",
        `the PDF could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (extension === ".txt" || extension === ".md" || extension === ".markdown") {
    return capParsedText(
      { kind: "text", text: Buffer.from(bytes).toString("utf8"), pages: null },
      maxTextChars,
    );
  }
  throw new ResearchToolError(
    "RESEARCH_SOURCE_UNREADABLE",
    `unsupported document format ${extension === "" ? "(no extension)" : extension} — supported: ${SUPPORTED_DOCUMENT_EXTENSIONS.join(", ")}`,
  );
}

/** Apply the derived-text budget with the honest marker (G4). */
function capParsedText(
  parsed: Omit<ParsedDocument, "truncated">,
  maxTextChars: number,
): ParsedDocument {
  if (parsed.text.length <= maxTextChars) {
    return { ...parsed, truncated: false };
  }
  return {
    ...parsed,
    text: `${parsed.text.slice(0, maxTextChars)}\n[the parsed text was truncated at the ${maxTextChars}-character budget]`,
    truncated: true,
  };
}
