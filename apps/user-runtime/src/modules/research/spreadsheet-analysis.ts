/**
 * Spreadsheet/data analysis (S25 chunk 3; issue #26; PRD §5.1–5.3; D15,
 * D23 rule 8, G3) — uploaded tabular files through SheetJS CE (xlsx 0.18.5,
 * Apache-2.0, exact-pinned). The analysis is DETERMINISTIC statistics over
 * the sheet's rows — never a model call, never a guess:
 *
 *   - the sheet names and the analysed sheet;
 *   - the row/column shape (the header row is row 1);
 *   - per-numeric-column stats (count/min/max/sum/mean), computed over the
 *     cells number(...) accepts;
 *   - the full table rendered as CSV — the structured artifact (always
 *     written, provenance-stamped), while the result text carries the
 *     bounded summary and the pointer.
 */
import * as XLSX from "xlsx";

import { ResearchToolError } from "./research-errors.ts";

/** The tabular formats the analyser handles (the honest, closed set). */
export const SUPPORTED_SPREADSHEET_EXTENSIONS = [".xlsx", ".xls", ".csv"] as const;

export interface SheetAnalysis {
  sheetName: string;
  sheetNames: string[];
  rowCount: number;
  columnCount: number;
  headers: string[];
  numericStats: Array<{
    column: string;
    count: number;
    min: number;
    max: number;
    sum: number;
    mean: number;
  }>;
  csv: string;
}

function extensionOf(path: string): string {
  const clean = path.split("?")[0] ?? path;
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot).toLowerCase();
}

function isNumericCell(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Analyse one uploaded spreadsheet's bytes: the named sheet or the first
 * sheet. Every failure is typed; a PDF (or any non-tabular format) is the
 * typed unreadable refusal, never a guessed parse.
 */
export function analyzeSpreadsheetBytes(
  path: string,
  bytes: Uint8Array,
  sheetName?: string | null,
): SheetAnalysis {
  const extension = extensionOf(path);
  if (!SUPPORTED_SPREADSHEET_EXTENSIONS.includes(extension as (typeof SUPPORTED_SPREADSHEET_EXTENSIONS)[number])) {
    throw new ResearchToolError(
      "RESEARCH_SOURCE_UNREADABLE",
      `unsupported tabular format ${extension === "" ? "(no extension)" : extension} — supported: ${SUPPORTED_SPREADSHEET_EXTENSIONS.join(", ")}`,
    );
  }
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "buffer" });
  } catch (error) {
    throw new ResearchToolError(
      "RESEARCH_SOURCE_UNREADABLE",
      `the spreadsheet could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sheetNames = workbook.SheetNames;
  if (sheetNames.length === 0) {
    throw new ResearchToolError(
      "RESEARCH_SOURCE_UNREADABLE",
      "the workbook contains no sheets",
    );
  }
  const requested = sheetName ?? sheetNames[0];
  if (requested === undefined || !sheetNames.includes(requested)) {
    throw new ResearchToolError(
      "RESEARCH_INPUT_INVALID",
      `no sheet named ${JSON.stringify(sheetName ?? "")} — sheets: ${sheetNames.join(", ")}`,
    );
  }
  const sheet = workbook.Sheets[requested];
  if (sheet === undefined) {
    throw new ResearchToolError(
      "RESEARCH_SOURCE_UNREADABLE",
      "the requested sheet is missing from the workbook",
    );
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
  if (rows.length === 0) {
    throw new ResearchToolError(
      "RESEARCH_SOURCE_UNREADABLE",
      "the sheet has no rows",
    );
  }
  const headerRow = rows[0] ?? [];
  const headers = headerRow.map((cell, index) =>
    typeof cell === "string" && cell.trim() !== "" ? cell : `column_${index + 1}`,
  );
  const columnCount = headers.length;
  const dataRows = rows.slice(1);
  const numericStats: SheetAnalysis["numericStats"] = [];
  for (let column = 0; column < columnCount; column += 1) {
    let count = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (const row of dataRows) {
      const cell = row[column];
      if (isNumericCell(cell)) {
        count += 1;
        min = Math.min(min, cell);
        max = Math.max(max, cell);
        sum += cell;
      }
    }
    if (count > 0) {
      numericStats.push({
        column: headers[column] ?? `column_${column + 1}`,
        count,
        min,
        max,
        sum,
        mean: sum / count,
      });
    }
  }
  const csv = XLSX.utils.sheet_to_csv(sheet);
  return {
    sheetName: requested,
    sheetNames,
    rowCount: rows.length,
    columnCount,
    headers,
    numericStats,
    csv,
  };
}
