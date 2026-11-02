/**
 * Uploaded-document parsing (S25 chunk 3; issue #26; PRD §5.1–5.3; D15,
 * D23 rule 8, G3) — PDF text extraction through unpdf 1.3.2 (MIT,
 * exact-pinned; the bundled pdf.js), plain text passthrough for text
 * documents. Unsupported formats are the typed RESEARCH_SOURCE_UNREADABLE,
 * naming the supported set — never a guessed extraction (G4).
 */
import { extractText, getDocumentProxy } from "unpdf";

import { ResearchToolError } from "./research-errors.ts";

/** The document formats the parser handles (the honest, closed set). */
export const SUPPORTED_DOCUMENT_EXTENSIONS = [".pdf", ".txt", ".md", ".markdown"] as const;

export interface ParsedDocument {
  kind: "pdf" | "text";
  text: string;
  /** PDF page count when the source was a PDF; null for text documents. */
  pages: number | null;
}

function extensionOf(path: string): string {
  const clean = path.split("?")[0] ?? path;
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot).toLowerCase();
}

/**
 * Parse one uploaded document's bytes: PDFs through unpdf (merged pages),
 * text/markdown as themselves. The extension decides the parser; a format
 * outside the declared set refuses typed.
 */
export async function parseDocumentBytes(
  path: string,
  bytes: Uint8Array,
): Promise<ParsedDocument> {
  const extension = extensionOf(path);
  if (extension === ".pdf") {
    try {
      const pdf = await getDocumentProxy(bytes);
      const { text, totalPages } = await extractText(pdf, { mergePages: true });
      return { kind: "pdf", text, pages: totalPages };
    } catch (error) {
      throw new ResearchToolError(
        "RESEARCH_SOURCE_UNREADABLE",
        `the PDF could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (extension === ".txt" || extension === ".md" || extension === ".markdown") {
    return { kind: "text", text: Buffer.from(bytes).toString("utf8"), pages: null };
  }
  throw new ResearchToolError(
    "RESEARCH_SOURCE_UNREADABLE",
    `unsupported document format ${extension === "" ? "(no extension)" : extension} — supported: ${SUPPORTED_DOCUMENT_EXTENSIONS.join(", ")}`,
  );
}
