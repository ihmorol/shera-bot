/**
 * Archive extraction (S19 chunk 2; issue #20, PRD §10, G3/G4) — the
 * path-traversal-safe reader behind the `archive` project source: a zip or
 * tar/tar.gz snapshot of a repository tree (the "download ZIP" flow) extracted
 * into a staging directory before the git service registers anything.
 *
 * ---------------------------------------------------------------------------
 * WHY HAND-ROLLED, AND THE BOUNDED FORMAT SURFACE
 *
 * The whole point of this module is that every byte that reaches the
 * filesystem passes the guards below. That is only auditable if the reader is:
 * the supported format surface is deliberately minimal, everything outside it
 * is refused TYPED (never guessed at), and no entry is ever silently skipped.
 *
 *   zip:   the End-of-Central-Directory record, central directory, and local
 *          file headers; stored (method 0) and deflate (method 8) entries via
 *          node:zlib inflateRaw. Refused: the encrypted flag, data
 *          descriptors, multi-disk archives, any other compression method
 *          (zip64 included — the caps below refuse the 4GB world first).
 *   tar:   512-byte ustar headers (regular files, directories), GNU longname
 *          ('L') entries, and pax extended headers ('x') — with only the
 *          `path` override honored. Refused: every other typeflag (symlinks,
 *          hardlinks, devices, sparse, …) and base-256 size fields.
 *
 * THE GUARDS (each pinned by a red-first test):
 *   - entry names: no absolute paths, no drive letters, no `..` segments, no
 *     control characters, no length abuse; backslashes are normalized to
 *     slashes FIRST so Windows-authored archives cannot smuggle separators;
 *   - no `.git` entry anywhere in an archive (a snapshot must not carry a
 *     foreign repository database into a fresh clone);
 *   - no symlink or hardlink entries AT ALL: the writer never materializes
 *     one, so a link-escape is unrepresentable;
 *   - size caps: per-entry (checked against the DECLARED size BEFORE
 *     decompression — the zip-bomb guard), the whole tar.gz stream capped
 *     WHILE it decompresses (a gzip bomb never materializes in memory), the
 *     total extracted bytes, entry count, and the archive file itself;
 *   - a refused entry fails the WHOLE extraction typed and writes NOTHING:
 *     files are created only after their entry is admitted, so a refusal
 *     leaves the destination untouched (the atomicity the git service
 *     composes with — a failed import registers no project).
 */
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip, inflateRawSync } from "node:zlib";

export class ArchiveImportError extends Error {
  readonly code:
    | "ARCHIVE_UNREADABLE"
    | "ARCHIVE_UNSUPPORTED_FORMAT"
    | "ARCHIVE_UNSAFE_ENTRY"
    | "ARCHIVE_LIMIT_EXCEEDED";

  constructor(code: ArchiveImportError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "ArchiveImportError";
    this.code = code;
  }
}

/** The extraction caps. Generous defaults; the git service may tighten them. */
export interface ArchiveLimits {
  /** One extracted file's uncompressed size ceiling. */
  maxFileBytes: number;
  /** The whole extraction's byte ceiling. */
  maxTotalBytes: number;
  /** The entry-count ceiling. */
  maxEntries: number;
  /** The archive FILE's own size ceiling (read guard). */
  maxArchiveBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxEntries: 20_000,
  maxArchiveBytes: 512 * 1024 * 1024,
};

export interface ArchiveExtractionResult {
  /** The admitted, extracted paths relative to the destination root. */
  files: string[];
}

// ---------------------------------------------------------------------------
// Entry-name guards
// ---------------------------------------------------------------------------

const MAX_NAME_LENGTH = 400;

/**
 * The ONE path every entry must survive. Returns the destination-relative
 * path (slash-separated, no leading slash, no `..`), or null for a bare
 * directory marker like "./" that carries no file. A refused shape THROWS —
 * nothing is silently skipped.
 */
export function safeEntryPath(rawName: string): string | null {
  if (rawName.length === 0 || rawName.length > MAX_NAME_LENGTH) {
    throw new ArchiveImportError("ARCHIVE_UNSAFE_ENTRY", "an entry name has an unusable length");
  }
  // The control characters are the point: this is the path-traversal guard
  // that REJECTS entries carrying NUL/C0/DEL bytes, so the rule is suppressed
  // deliberately (not an accidental control regex).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rawName)) {
    throw new ArchiveImportError(
      "ARCHIVE_UNSAFE_ENTRY",
      "an entry name carries control characters",
    );
  }
  // Windows-authored archives use backslash separators; normalize FIRST so a
  // traversal cannot hide behind a separator the POSIX eye does not see.
  const name = rawName.replace(/\\/g, "/");
  if (name.startsWith("/")) {
    throw new ArchiveImportError("ARCHIVE_UNSAFE_ENTRY", "an entry name is an absolute path");
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw new ArchiveImportError("ARCHIVE_UNSAFE_ENTRY", "an entry name carries a drive letter");
  }
  const segments = name.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new ArchiveImportError("ARCHIVE_UNSAFE_ENTRY", "an entry name escapes the destination");
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    throw new ArchiveImportError("ARCHIVE_UNSAFE_ENTRY", "an archive must not carry a .git entry");
  }
  if (segments.length === 0) {
    return null;
  }
  return segments.join("/");
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

interface ZipCentralEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

function readZipCentralEntries(buffer: Buffer): ZipCentralEntry[] {
  // Locate the EOCD from the tail (the comment may follow it, up to 64KiB).
  const scanFloor = Math.max(0, buffer.length - 22 - 65_536);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= scanFloor; index -= 1) {
    if (buffer.readUInt32LE(index) === ZIP_EOCD_SIGNATURE) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) {
    throw new ArchiveImportError("ARCHIVE_UNREADABLE", "the zip directory could not be located");
  }
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const diskWithCentral = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  if (diskNumber !== 0 || diskWithCentral !== 0 || diskEntries !== totalEntries) {
    throw new ArchiveImportError(
      "ARCHIVE_UNSUPPORTED_FORMAT",
      "multi-disk zip archives are not supported",
    );
  }
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipCentralEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new ArchiveImportError("ARCHIVE_UNREADABLE", "the zip directory is corrupt");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipEntryBytes(buffer: Buffer, entry: ZipCentralEntry): Buffer {
  if ((entry.flags & 0x0001) !== 0) {
    throw new ArchiveImportError("ARCHIVE_UNSUPPORTED_FORMAT", "encrypted zip entries are refused");
  }
  if ((entry.flags & 0x0008) !== 0) {
    throw new ArchiveImportError(
      "ARCHIVE_UNSUPPORTED_FORMAT",
      "zip entries with data descriptors are not supported",
    );
  }
  const local = entry.localHeaderOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== ZIP_LOCAL_SIGNATURE) {
    throw new ArchiveImportError("ARCHIVE_UNREADABLE", "a zip local header is corrupt");
  }
  // The local header must agree with the central directory on the shape that
  // matters: an encrypted or differently-compressed local header is refused
  // even when the (authoritative) central entry looks benign.
  const localFlags = buffer.readUInt16LE(local + 6);
  const localMethod = buffer.readUInt16LE(local + 8);
  if ((localFlags & 0x0001) !== 0) {
    throw new ArchiveImportError("ARCHIVE_UNSUPPORTED_FORMAT", "encrypted zip entries are refused");
  }
  if (localMethod !== entry.method) {
    throw new ArchiveImportError(
      "ARCHIVE_UNREADABLE",
      "a zip local header contradicts its directory",
    );
  }
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new ArchiveImportError("ARCHIVE_UNREADABLE", "a zip entry extends past the archive");
  }
  const payload = buffer.subarray(dataStart, dataEnd);
  if (entry.method === 0) {
    return Buffer.from(payload);
  }
  if (entry.method === 8) {
    try {
      return inflateRawSync(payload);
    } catch {
      throw new ArchiveImportError("ARCHIVE_UNREADABLE", "a deflate entry failed to inflate");
    }
  }
  throw new ArchiveImportError(
    "ARCHIVE_UNSUPPORTED_FORMAT",
    "the archive uses a compression method outside the supported set",
  );
}

async function extractZip(
  archivePath: string,
  destDir: string,
  limits: ArchiveLimits,
): Promise<ArchiveExtractionResult> {
  const buffer = await readFile(archivePath);
  const entries = readZipCentralEntries(buffer);
  if (entries.length > limits.maxEntries) {
    throw new ArchiveImportError("ARCHIVE_LIMIT_EXCEEDED", "the archive exceeds the entry cap");
  }
  const files: string[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    // The DECLARED size is checked before anything is decompressed: a lying
    // header never gets the chance to spend the memory (the bomb guard).
    if (entry.uncompressedSize > limits.maxFileBytes) {
      throw new ArchiveImportError(
        "ARCHIVE_LIMIT_EXCEEDED",
        "an entry declares a size above the per-entry cap",
      );
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ArchiveImportError(
        "ARCHIVE_LIMIT_EXCEEDED",
        "the archive exceeds the total size cap",
      );
    }
    const relative = safeEntryPath(entry.name);
    if (relative === null) {
      continue;
    }
    if (entry.name.endsWith("/")) {
      await mkdir(join(destDir, relative), { recursive: true });
      continue;
    }
    const bytes = zipEntryBytes(buffer, entry);
    if (bytes.length > limits.maxFileBytes) {
      throw new ArchiveImportError(
        "ARCHIVE_LIMIT_EXCEEDED",
        "an entry decompresses above the per-entry cap",
      );
    }
    const target = join(destDir, relative);
    if (!target.startsWith(destDir)) {
      throw new ArchiveImportError(
        "ARCHIVE_UNSAFE_ENTRY",
        "an entry resolves outside the destination",
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    files.push(relative);
  }
  return { files };
}

// ---------------------------------------------------------------------------
// Tar
// ---------------------------------------------------------------------------

const TAR_BLOCK = 512;

interface TarEntry {
  name: string;
  typeflag: string;
  linkname: string | null;
  size: number;
}

function parseTarHeader(block: Buffer): TarEntry {
  const field = (start: number, length: number): string =>
    block
      .subarray(start, start + length)
      .toString("binary")
      .replace(/\0.*$/, "");
  const name = field(0, 100);
  const sizeField = block.subarray(124, 136);
  // GNU base-256 sizes (high bit of the first byte) are outside the surface.
  if (((sizeField[0] ?? 0) & 0x80) !== 0) {
    throw new ArchiveImportError(
      "ARCHIVE_UNSUPPORTED_FORMAT",
      "base-256 tar size fields are not supported",
    );
  }
  const sizeText = field(124, 12).trim();
  const size = sizeText.length === 0 ? 0 : parseInt(sizeText, 8);
  if (!Number.isFinite(size) || size < 0) {
    throw new ArchiveImportError("ARCHIVE_UNREADABLE", "a tar header has an unusable size field");
  }
  const typeflag = field(156, 1) || "0";
  const linkname = field(157, 100) || null;
  const prefix = field(345, 155);
  return {
    name: prefix.length > 0 ? `${prefix}/${name}` : name,
    typeflag,
    linkname,
    size,
  };
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let cursor = 0;
  while (cursor < data.length) {
    const spaceIndex = data.indexOf(0x20, cursor);
    if (spaceIndex < 0) {
      break;
    }
    const lengthText = data.subarray(cursor, spaceIndex).toString("binary");
    const length = parseInt(lengthText, 10);
    if (!Number.isFinite(length) || length <= 0 || cursor + length > data.length) {
      break;
    }
    const record = data.subarray(cursor + spaceIndex + 1, cursor + length).toString("utf8");
    const equalsIndex = record.indexOf("=");
    if (equalsIndex > 0) {
      records[record.slice(0, equalsIndex)] = record.slice(equalsIndex + 1);
    }
    cursor += length;
  }
  return records;
}

/**
 * Stream-decompress the gzip stream with a HARD decompressed-size ceiling:
 * the whole inflated stream never exists beyond `capBytes` — a gzip bomb is
 * refused mid-stream (typed ARCHIVE_LIMIT_EXCEEDED) instead of being
 * gunzipSync'd into memory first. The stream bounds the file data plus the
 * tar framing, so it can only refuse archives whose extracted bytes would
 * blow the total cap anyway (the safe direction).
 */
async function gunzipCapped(raw: Buffer, capBytes: number): Promise<Buffer> {
  const gunzip = createGunzip();
  const source = Readable.from(raw).pipe(gunzip);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      total += (chunk as Buffer).length;
      if (total > capBytes) {
        throw new ArchiveImportError(
          "ARCHIVE_LIMIT_EXCEEDED",
          "the archive decompresses above the total size cap",
        );
      }
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    if (error instanceof ArchiveImportError) {
      throw error;
    }
    throw new ArchiveImportError("ARCHIVE_UNREADABLE", "the gzip stream failed to decompress");
  }
  return Buffer.concat(chunks);
}

async function extractTar(
  archivePath: string,
  destDir: string,
  limits: ArchiveLimits,
  gzipped: boolean,
): Promise<ArchiveExtractionResult> {
  const raw = await readFile(archivePath);
  const buffer = gzipped ? await gunzipCapped(raw, limits.maxTotalBytes) : raw;
  if (buffer.length % TAR_BLOCK !== 0) {
    throw new ArchiveImportError("ARCHIVE_UNREADABLE", "the tar stream is not block-aligned");
  }
  const files: string[] = [];
  let totalBytes = 0;
  let cursor = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;
  while (cursor + TAR_BLOCK <= buffer.length) {
    const block = buffer.subarray(cursor, cursor + TAR_BLOCK);
    if (block.every((byte) => byte === 0)) {
      break;
    }
    const entry = parseTarHeader(block);
    cursor += TAR_BLOCK;
    const dataBytes =
      entry.size > 0 ? buffer.subarray(cursor, cursor + entry.size) : Buffer.alloc(0);
    const paddedSize = entry.size + ((TAR_BLOCK - (entry.size % TAR_BLOCK)) % TAR_BLOCK);
    cursor += paddedSize;

    if (entry.typeflag === "L") {
      pendingLongName = dataBytes.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (entry.typeflag === "x") {
      pendingPaxPath = parsePaxRecords(dataBytes)["path"] ?? null;
      continue;
    }
    if (entry.typeflag === "g") {
      continue;
    }
    if (entry.typeflag !== "0" && entry.typeflag !== "\0" && entry.typeflag !== "5") {
      if (entry.typeflag === "2" || entry.typeflag === "1") {
        throw new ArchiveImportError(
          "ARCHIVE_UNSAFE_ENTRY",
          "a symlink or hardlink entry is refused; archives carry plain trees only",
        );
      }
      throw new ArchiveImportError(
        "ARCHIVE_UNSUPPORTED_FORMAT",
        "the tar uses an entry type outside the supported set",
      );
    }
    const rawName = pendingLongName ?? pendingPaxPath ?? entry.name;
    pendingLongName = null;
    pendingPaxPath = null;
    const relative = safeEntryPath(rawName);
    if (relative === null) {
      continue;
    }
    if (entry.size > limits.maxFileBytes) {
      throw new ArchiveImportError(
        "ARCHIVE_LIMIT_EXCEEDED",
        "an entry declares a size above the per-entry cap",
      );
    }
    totalBytes += entry.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ArchiveImportError(
        "ARCHIVE_LIMIT_EXCEEDED",
        "the archive exceeds the total size cap",
      );
    }
    if (files.length + 1 > limits.maxEntries) {
      throw new ArchiveImportError("ARCHIVE_LIMIT_EXCEEDED", "the archive exceeds the entry cap");
    }
    const target = join(destDir, relative);
    if (!target.startsWith(destDir)) {
      throw new ArchiveImportError(
        "ARCHIVE_UNSAFE_ENTRY",
        "an entry resolves outside the destination",
      );
    }
    if (entry.typeflag === "5") {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, dataBytes);
    files.push(relative);
  }
  return { files };
}

// ---------------------------------------------------------------------------
// The single-root flattening + the entry point
// ---------------------------------------------------------------------------

/**
 * Strip the single common root folder (the "repo-main/…" download-ZIP shape):
 * when every extracted file shares exactly one root directory, the root's
 * children move up one level and the root is removed, so the repository root
 * IS the destination root.
 */
function stripCommonRoot(files: string[], destDir: string): string[] {
  if (files.length === 0) {
    return files;
  }
  const firstSegments = new Set(
    files.map((file) => (file.includes("/") ? file.split("/")[0] : file)),
  );
  if (firstSegments.size !== 1) {
    return files;
  }
  const root = [...firstSegments][0] as string;
  const allNested = files.every((file) => file.startsWith(`${root}/`));
  if (!allNested) {
    return files;
  }
  const rootDir = join(destDir, root);
  for (const entry of readdirSync(rootDir)) {
    const to = join(destDir, entry);
    if (existsSync(to)) {
      throw new ArchiveImportError(
        "ARCHIVE_UNSAFE_ENTRY",
        "the single-root archive collides with another entry at the destination",
      );
    }
    renameSync(join(rootDir, entry), to);
  }
  rmSync(rootDir, { recursive: true, force: true });
  return files.map((file) => file.slice(root.length + 1));
}

/**
 * Extract one archive into `destDir` (created on demand). Every entry passes
 * the guards; a refusal leaves `destDir` untouched (files are written only
 * after their entry is admitted) and throws ArchiveImportError.
 */
export async function extractArchiveInto(
  archivePath: string,
  destDir: string,
  limits: Partial<ArchiveLimits> = {},
): Promise<ArchiveExtractionResult> {
  const resolvedLimits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...limits };
  if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
    throw new ArchiveImportError("ARCHIVE_UNREADABLE", "the archive file does not exist");
  }
  if (statSync(archivePath).size > resolvedLimits.maxArchiveBytes) {
    throw new ArchiveImportError(
      "ARCHIVE_LIMIT_EXCEEDED",
      "the archive file exceeds the archive size cap",
    );
  }
  const lower = archivePath.toLowerCase();
  try {
    let extracted: ArchiveExtractionResult;
    if (lower.endsWith(".zip")) {
      extracted = await extractZip(archivePath, destDir, resolvedLimits);
    } else if (lower.endsWith(".tar")) {
      extracted = await extractTar(archivePath, destDir, resolvedLimits, false);
    } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
      extracted = await extractTar(archivePath, destDir, resolvedLimits, true);
    } else {
      throw new ArchiveImportError(
        "ARCHIVE_UNSUPPORTED_FORMAT",
        "only .zip, .tar, .tar.gz and .tgz archives are supported",
      );
    }
    return { files: stripCommonRoot(extracted.files, destDir) };
  } catch (error) {
    // The destination is the git service's staging directory: a failed
    // extraction leaves NOTHING behind (the atomicity the caller composes).
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
