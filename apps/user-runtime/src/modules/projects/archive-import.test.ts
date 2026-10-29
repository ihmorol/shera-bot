/**
 * S19 chunk 2 — the archive import (issue #20; PRD §10, G3, G4). Red-first:
 * these tests pin the extraction behaviors before the module exists.
 *
 * WHAT THIS IS: the third project source — a zip/tar archive of a repository
 * snapshot (the "download ZIP" flow), imported with the SAME atomicity rule
 * as clone/directory (a failed import registers NO project row and leaves no
 * staging directory) and STRICT path-traversal guards. The extraction module
 * is hand-rolled over node:zlib with a deliberately BOUNDED format surface:
 *   - zip: stored (method 0) and deflate (method 8) entries only; the
 *     encrypted flag, zip64, multi-disk archives, and every other method are
 *     refused typed — a bounded reader is an auditable reader.
 *   - tar: ustar headers, GNU longname ('L'), and pax path overrides ('x');
 *     every other typeflag (symlinks, hardlinks, devices, sparse) is refused.
 *
 * THE GUARDS (each pinned below, the whole point of the module): no absolute
 * paths, no drive letters, no `..` segments, no backslash traversal, no
 * entries escaping the destination, no `.git` tree inside an archive, no
 * symlink/hardlink entries, per-entry and total size caps, entry-count cap.
 * A refused entry fails the WHOLE extraction typed — nothing partial is
 * written, nothing is silently skipped.
 *
 * FIXTURES: the zip and tar byte builders below are hand-written (stored zip
 * with node:zlib crc32; 512-byte ustar blocks) so the tests control every
 * header — including the malicious ones a real archiving tool would refuse to
 * CREATE. node:zlib inflateRaw covers the deflate round trip.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { ProjectsRepository } from "../../adapters/sqlite/projects-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { EventsService } from "../events/events.service.ts";
import { ApprovalsService } from "../approvals/approvals.service.ts";
import { CredentialVault } from "./credential-vault.ts";
import { ArchiveImportError, extractArchiveInto, type ArchiveLimits } from "./archive-import.ts";
import { GitService } from "../git/git.service.ts";

const WS = "ws_s19_archive";
const USER = { type: "user", id: "user_001" } as const;
const NOW = "2026-10-29T12:00:00.000Z";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixture builders: a stored zip and 512-byte ustar tar blocks, by hand
// ---------------------------------------------------------------------------

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

interface ZipEntry {
  name: string;
  data: Buffer;
  /** Override the DECLARED uncompressed size in both headers (bomb fixtures). */
  declaredUncompressedSize?: number;
}

/** Build a stored-method zip (every tool and the module read this shape). */
function writeStoredZip(entries: ZipEntry[], method: 0 | 8 = 0): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const declaredSize = entry.declaredUncompressedSize ?? entry.data.length;
    let payload = entry.data;
    let compressedSize = entry.data.length;
    if (method === 8) {
      payload = deflateRawSync(entry.data);
      compressedSize = payload.length;
    }
    const local = Buffer.concat([
      Buffer.from("PK\x03\x04", "binary"),
      u16(20),
      u16(0x0800),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(compressedSize),
      u32(declaredSize),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      payload,
    ]);
    localParts.push(local);
    const central = Buffer.concat([
      Buffer.from("PK\x01\x02", "binary"),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(compressedSize),
      u32(declaredSize),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);
    centralParts.push(central);
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    Buffer.from("PK\x05\x06", "binary"),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

const TAR_BLOCK = 512;

function octalField(value: number, length: number): Buffer {
  // length includes the trailing NUL: 7 usable digits for an 8-byte field.
  return Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`, "binary");
}

function stringField(value: string, length: number): Buffer {
  const buf = Buffer.alloc(length);
  Buffer.from(value, "binary").copy(buf);
  return buf;
}

interface TarEntrySpec {
  name: string;
  data?: Buffer;
  /** ustar typeflag: "0" file (default), "5" dir, "1" hardlink, "2" symlink, "L" GNU longname. */
  typeflag?: string;
  linkname?: string;
  /** A full pax record set ("25 path=<value>\n") carried by a preceding 'x' entry. */
  paxPath?: string;
}

function tarHeader(spec: {
  name: string;
  size: number;
  typeflag: string;
  linkname?: string | undefined;
}) {
  const head = Buffer.alloc(TAR_BLOCK);
  stringField(spec.name, 100).copy(head, 0);
  stringField("0000644", 8).copy(head, 100);
  stringField("0000000", 8).copy(head, 108);
  stringField("0000000", 8).copy(head, 116);
  octalField(spec.size, 12).copy(head, 124);
  octalField(0, 12).copy(head, 136);
  head.write("        ", 148, "binary"); // checksum placeholder (spaces)
  head.write(spec.typeflag, 156, "binary");
  if (spec.linkname) {
    stringField(spec.linkname, 100).copy(head, 157);
  }
  stringField("ustar\0", 6).copy(head, 257);
  stringField("00", 2).copy(head, 263);
  stringField("fixture", 32).copy(head, 265);
  stringField("fixture", 32).copy(head, 297);
  let sum = 0;
  for (const byte of head) {
    sum += byte;
  }
  Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "binary").copy(head, 148);
  return head;
}

function tarData(data: Buffer): Buffer {
  const padding = (TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK;
  return Buffer.concat([data, Buffer.alloc(padding)]);
}

/** Build a tar from the specs, emitting GNU longname ('L') and pax ('x') helper entries. */
function writeTar(specs: TarEntrySpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    const data = spec.data ?? Buffer.alloc(0);
    if (spec.paxPath !== undefined) {
      const record = `${spec.paxPath.length + 8} path=${spec.paxPath}\n`;
      const recordData = Buffer.from(record, "binary");
      parts.push(tarHeader({ name: "pax_header", size: recordData.length, typeflag: "x" }));
      parts.push(tarData(recordData));
    }
    if (spec.name.length > 100) {
      const longData = Buffer.from(`${spec.name}\0`, "binary");
      parts.push(tarHeader({ name: "././@LongLink", size: longData.length, typeflag: "L" }));
      parts.push(tarData(longData));
      // The real header carries the truncated name; the reader prefers 'L'.
      parts.push(
        tarHeader({
          name: spec.name.slice(0, 100),
          size: data.length,
          typeflag: spec.typeflag ?? "0",
          linkname: spec.linkname,
        }),
      );
    } else {
      parts.push(
        tarHeader({
          name: spec.name,
          size: data.length,
          typeflag: spec.typeflag ?? "0",
          linkname: spec.linkname,
        }),
      );
    }
    if ((spec.typeflag ?? "0") !== "5") {
      parts.push(tarData(data));
    }
  }
  parts.push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// The extraction module, exercised directly
// ---------------------------------------------------------------------------

describe("archive extraction: zip happy paths", () => {
  it("extracts stored and deflate entries with their directory structure", async () => {
    const dest = makeTempDir("shera-s19-zip-ok-");
    const zip = writeStoredZip(
      [
        { name: "README.md", data: Buffer.from("# zip repo\n") },
        { name: "src/", data: Buffer.alloc(0) },
        { name: "src/index.js", data: Buffer.from("console.log(1);\n") },
      ],
      0,
    );
    const zipDeflated = writeStoredZip(
      [{ name: "package.json", data: Buffer.from('{"name":"z"}') }],
      8,
    );
    const archive = join(dest, "repo.zip");
    const deflated = join(dest, "deflated.zip");
    writeFileSync(archive, zip);
    writeFileSync(deflated, zipDeflated);

    const outA = join(dest, "out-a");
    const result = await extractArchiveInto(archive, outA);
    expect(readFileSync(join(outA, "README.md"), "utf8")).toBe("# zip repo\n");
    expect(existsSync(join(outA, "src", "index.js"))).toBe(true);
    expect(result.files).toContain("src/index.js");

    const outB = join(dest, "out-b");
    await extractArchiveInto(deflated, outB);
    expect(readFileSync(join(outB, "package.json"), "utf8")).toBe('{"name":"z"}');
  });

  it("strips the single common root folder (the download-ZIP shape)", async () => {
    const dest = makeTempDir("shera-s19-zip-root-");
    const archive = join(dest, "repo.zip");
    writeFileSync(
      archive,
      writeStoredZip([
        { name: "repo-main/", data: Buffer.alloc(0) },
        { name: "repo-main/README.md", data: Buffer.from("# root\n") },
        { name: "repo-main/src/index.js", data: Buffer.from("export {};\n") },
      ]),
    );
    const result = await extractArchiveInto(archive, join(dest, "out"));
    expect(readFileSync(join(dest, "out", "README.md"), "utf8")).toBe("# root\n");
    expect(existsSync(join(dest, "out", "src", "index.js"))).toBe(true);
    expect(existsSync(join(dest, "out", "repo-main"))).toBe(false);
    expect(result.files).toEqual(["README.md", "src/index.js"]);
  });

  it("accepts backslash-nested Windows-authored names inside the destination", async () => {
    const dest = makeTempDir("shera-s19-zip-win-");
    const archive = join(dest, "repo.zip");
    writeFileSync(
      archive,
      writeStoredZip([
        { name: "README.md", data: Buffer.from("# top\n") },
        { name: "src\\main.rs", data: Buffer.from("fn main() {}\n") },
      ]),
    );
    await extractArchiveInto(archive, join(dest, "out"));
    expect(readFileSync(join(dest, "out", "src", "main.rs"), "utf8")).toBe("fn main() {}\n");
  });
});

describe("archive extraction: traversal and unsafe-entry guards (the point of the module)", () => {
  const cases: Array<{ label: string; entry: ZipEntry }> = [
    { label: "parent traversal", entry: { name: "../evil.txt", data: Buffer.from("x") } },
    {
      label: "nested parent traversal",
      entry: { name: "a/../../evil.txt", data: Buffer.from("x") },
    },
    { label: "absolute path", entry: { name: "/etc/evil.txt", data: Buffer.from("x") } },
    { label: "windows absolute", entry: { name: "\\windows\\evil.txt", data: Buffer.from("x") } },
    { label: "drive letter", entry: { name: "C:/evil.txt", data: Buffer.from("x") } },
    { label: "backslash traversal", entry: { name: "..\\..\\evil.txt", data: Buffer.from("x") } },
    { label: "dotfile .git tree", entry: { name: ".git/config", data: Buffer.from("[core]\n") } },
    { label: "root .git file", entry: { name: ".git", data: Buffer.from("gitdir: x\n") } },
  ];

  for (const { label, entry } of cases) {
    it(`refuses a zip with a ${label} entry and writes NOTHING`, async () => {
      const dest = makeTempDir("shera-s19-zip-bad-");
      const archive = join(dest, "evil.zip");
      writeFileSync(
        archive,
        writeStoredZip([{ name: "README.md", data: Buffer.from("# good\n") }, entry]),
      );
      await expect(extractArchiveInto(archive, join(dest, "out"))).rejects.toThrow(
        ArchiveImportError,
      );
      expect(existsSync(join(dest, "out"))).toBe(false);
      expect(existsSync(join(dirname(archive), "..", "evil.txt"))).toBe(false);
    });
  }

  it("refuses a tar with a symlink entry, a hardlink entry, and a parent traversal", async () => {
    const dest = makeTempDir("shera-s19-tar-bad-");
    const symlink = join(dest, "symlink.tar");
    writeFileSync(
      symlink,
      writeTar([{ name: "link", typeflag: "2", linkname: "/etc/passwd", data: Buffer.alloc(0) }]),
    );
    await expect(extractArchiveInto(symlink, join(dest, "out-1"))).rejects.toThrow(/symlink/i);
    const hardlink = join(dest, "hardlink.tar");
    writeFileSync(
      hardlink,
      writeTar([{ name: "hard", typeflag: "1", linkname: "target", data: Buffer.alloc(0) }]),
    );
    await expect(extractArchiveInto(hardlink, join(dest, "out-2"))).rejects.toThrow(
      ArchiveImportError,
    );
    const traversal = join(dest, "traversal.tar");
    writeFileSync(traversal, writeTar([{ name: "../evil.txt", data: Buffer.from("x") }]));
    await expect(extractArchiveInto(traversal, join(dest, "out-3"))).rejects.toThrow(
      ArchiveImportError,
    );
    expect(readdirSync(dest).sort()).toEqual(["hardlink.tar", "symlink.tar", "traversal.tar"]);
  });

  it("refuses unsupported zip shapes: the encrypted flag and other compression methods", async () => {
    const dest = makeTempDir("shera-s19-zip-shape-");
    // An encrypted payload: general-purpose bit 0 set in the local header.
    const encrypted = writeStoredZip([{ name: "a.txt", data: Buffer.from("x") }]);
    encrypted.writeUInt16LE(0x0001, 6);
    const archive = join(dest, "encrypted.zip");
    writeFileSync(archive, encrypted);
    await expect(extractArchiveInto(archive, join(dest, "out"))).rejects.toThrow(
      ArchiveImportError,
    );
    // A bzip2-compressed entry (method 12) is outside the bounded surface.
    const bzip = writeStoredZip([{ name: "a.txt", data: Buffer.from("x") }]);
    bzip.writeUInt16LE(12, 8);
    const bzipArchive = join(dest, "bzip.zip");
    writeFileSync(bzipArchive, bzip);
    await expect(extractArchiveInto(bzipArchive, join(dest, "out-2"))).rejects.toThrow(
      ArchiveImportError,
    );
  });

  it("refuses garbage bytes and unknown extensions typed", async () => {
    const dest = makeTempDir("shera-s19-zip-junk-");
    const garbage = join(dest, "garbage.zip");
    writeFileSync(garbage, Buffer.from("this is not a zip file, not even close"));
    await expect(extractArchiveInto(garbage, join(dest, "out-1"))).rejects.toThrow(
      ArchiveImportError,
    );
    const unknown = join(dest, "archive.rar");
    writeFileSync(unknown, Buffer.from("Rar!"));
    await expect(extractArchiveInto(unknown, join(dest, "out-2"))).rejects.toThrow(/format/i);
  });
});

describe("archive extraction: tar formats", () => {
  it("extracts ustar files and directories", async () => {
    const dest = makeTempDir("shera-s19-tar-ok-");
    const archive = join(dest, "repo.tar");
    writeFileSync(
      archive,
      writeTar([
        { name: "README.md", data: Buffer.from("# tar repo\n") },
        { name: "src/", typeflag: "5" },
        { name: "src/index.js", data: Buffer.from("export {};\n") },
      ]),
    );
    const result = await extractArchiveInto(archive, join(dest, "out"));
    expect(readFileSync(join(dest, "out", "README.md"), "utf8")).toBe("# tar repo\n");
    expect(existsSync(join(dest, "out", "src", "index.js"))).toBe(true);
    expect(result.files).toContain("src/index.js");
  });

  it("reads gzipped tars", async () => {
    const dest = makeTempDir("shera-s19-tgz-");
    const archive = join(dest, "repo.tar.gz");
    writeFileSync(
      archive,
      gzipSync(writeTar([{ name: "package.json", data: Buffer.from('{"name":"t"}') }])),
    );
    await extractArchiveInto(archive, join(dest, "out"));
    expect(readFileSync(join(dest, "out", "package.json"), "utf8")).toBe('{"name":"t"}');
  });

  it("reads GNU longname entries at their full path", async () => {
    const dest = makeTempDir("shera-s19-tar-long-");
    const longName = `${"deep/".repeat(30)}actually-fine.txt`;
    const archive = join(dest, "long.tar");
    writeFileSync(
      archive,
      writeTar([
        { name: "README.md", data: Buffer.from("# top\n") },
        { name: longName, data: Buffer.from("long\n") },
      ]),
    );
    const result = await extractArchiveInto(archive, join(dest, "out"));
    expect(readFileSync(join(dest, "out", longName), "utf8")).toBe("long\n");
    expect(result.files).toContain(longName);
  });

  it("honors a pax path override and still guards it", async () => {
    const dest = makeTempDir("shera-s19-tar-pax-");
    const archive = join(dest, "pax.tar");
    writeFileSync(
      archive,
      writeTar([
        { name: "README.md", data: Buffer.from("# top\n") },
        { name: "shortname", paxPath: "real/path/file.txt", data: Buffer.from("pax\n") },
      ]),
    );
    await extractArchiveInto(archive, join(dest, "out"));
    expect(readFileSync(join(dest, "out", "real", "path", "file.txt"), "utf8")).toBe("pax\n");

    const evil = join(dest, "pax-evil.tar");
    writeFileSync(
      evil,
      writeTar([{ name: "shortname", paxPath: "../evil.txt", data: Buffer.from("x") }]),
    );
    await expect(extractArchiveInto(evil, join(dest, "out-2"))).rejects.toThrow(ArchiveImportError);
  });
});

describe("archive extraction: size and count caps", () => {
  const tightLimits: ArchiveLimits = {
    maxFileBytes: 1024,
    maxTotalBytes: 2048,
    maxEntries: 8,
    maxArchiveBytes: 8192,
  };

  it("refuses a single entry above the per-entry cap", async () => {
    const dest = makeTempDir("shera-s19-cap-file-");
    const archive = join(dest, "big.zip");
    writeFileSync(archive, writeStoredZip([{ name: "big.bin", data: Buffer.alloc(4096, 7) }]));
    await expect(extractArchiveInto(archive, join(dest, "out"), tightLimits)).rejects.toThrow(
      /limit/i,
    );
    expect(existsSync(join(dest, "out"))).toBe(false);
  });

  it("refuses a declared size that exceeds the cap before decompressing (bomb guard)", async () => {
    const dest = makeTempDir("shera-s19-cap-bomb-");
    // A small DEFLATED payload whose UNCOMPRESSED size fields declare far
    // more than the cap — the reader must refuse on the declared size,
    // before inflating anything into memory.
    const bomb = writeStoredZip(
      [
        {
          name: "bomb.txt",
          data: Buffer.from("0".repeat(64)),
          declaredUncompressedSize: 0x40000000,
        },
      ],
      8,
    );
    const archive = join(dest, "bomb.zip");
    writeFileSync(archive, bomb);
    await expect(extractArchiveInto(archive, join(dest, "out"), tightLimits)).rejects.toThrow(
      /limit/i,
    );
    expect(existsSync(join(dest, "out"))).toBe(false);
  });

  it("refuses a tar.gz whose decompressed stream exceeds the cap mid-stream (gzip bomb guard)", async () => {
    const dest = makeTempDir("shera-s19-cap-gzip-");
    // A small compressed file whose INFLATED stream is far over the total cap
    // while every entry fits the per-entry cap: only the mid-stream guard can
    // refuse this — the reader throws DURING decompression, so the whole
    // inflated stream never materializes in memory (the review-round fix).
    const bomb = gzipSync(
      writeTar([
        { name: "a.txt", data: Buffer.alloc(700, 48) },
        { name: "b.txt", data: Buffer.alloc(700, 48) },
        { name: "c.txt", data: Buffer.alloc(700, 48) },
      ]),
    );
    expect(bomb.length).toBeLessThan(2048);
    const archive = join(dest, "bomb.tar.gz");
    writeFileSync(archive, bomb);
    await expect(extractArchiveInto(archive, join(dest, "out"), tightLimits)).rejects.toThrow(
      /decompresses above the total size cap/,
    );
    expect(existsSync(join(dest, "out"))).toBe(false);
  });

  it("refuses archives above the total-bytes cap and the entry-count cap", async () => {
    const dest = makeTempDir("shera-s19-cap-total-");
    const total = join(dest, "total.tar");
    writeFileSync(
      total,
      writeTar([
        { name: "a.txt", data: Buffer.alloc(1500, 1) },
        { name: "b.txt", data: Buffer.alloc(1500, 2) },
      ]),
    );
    await expect(extractArchiveInto(total, join(dest, "out-1"), tightLimits)).rejects.toThrow(
      /limit/i,
    );

    const many = join(dest, "many.zip");
    writeFileSync(
      many,
      writeStoredZip(
        Array.from({ length: 16 }, (_, index) => ({
          name: `f${index}.txt`,
          data: Buffer.from("x"),
        })),
      ),
    );
    await expect(extractArchiveInto(many, join(dest, "out-2"), tightLimits)).rejects.toThrow(
      /limit/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: git.service importProject with an archive source
// ---------------------------------------------------------------------------

interface TestEnv {
  dir: string;
  conn: SqliteConnection;
  projects: ProjectsRepository;
  git: GitService;
  projectsRoot: string;
}

function newEnv(): TestEnv {
  const dir = makeTempDir("shera-runtime-s19-archive-");
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const approvalsRepository = new ApprovalsRepository(tx);
  const approvals = new ApprovalsService({
    tx,
    journal,
    events,
    approvals: approvalsRepository,
    operations: new OperationsRepository(tx),
    clock: () => NOW,
  });
  const projects = new ProjectsRepository(tx);
  const projectsRoot = join(dir, "projects");
  mkdirSync(projectsRoot, { recursive: true });
  const git = new GitService({
    projects,
    vault: new CredentialVault(join(dir, "project-credentials.key")),
    approvals,
    approvalsRepository,
    tx,
    projectsRoot,
    clock: () => NOW,
  });
  return { dir, conn, projects, git, projectsRoot };
}

const openEnvs: TestEnv[] = [];

function trackedEnv(): TestEnv {
  const env = newEnv();
  openEnvs.push(env);
  return env;
}

afterEach(() => {
  for (const env of openEnvs.splice(0)) {
    env.conn.close();
  }
});

describe("archive import through the git service: atomicity", () => {
  it("imports a zip snapshot as a fresh repository with source_kind archive", async () => {
    const env = trackedEnv();
    const base = makeTempDir("shera-s19-archive-base-");
    const archive = join(base, "repo.zip");
    writeFileSync(
      archive,
      writeStoredZip([
        { name: "repo-main/", data: Buffer.alloc(0) },
        { name: "repo-main/README.md", data: Buffer.from("# archived\n") },
        { name: "repo-main/package.json", data: Buffer.from('{"name":"archived"}') },
      ]),
    );
    const project = await env.git.importProject({
      workspace_id: WS,
      name: "archived",
      actor: USER,
      source: { kind: "archive", path: archive },
    });
    expect(project.source_kind).toBe("archive");
    expect(project.default_branch).toBe("main");
    expect(readFileSync(join(project.repo_path, "README.md"), "utf8")).toBe("# archived\n");
    // The snapshot is committed as one import commit on a fresh repository.
    const log = await simpleGit(project.repo_path).log({ maxCount: 1 });
    expect(log.total).toBe(1);
    expect(existsSync(join(project.repo_path, ".git"))).toBe(true);
    // The source archive is consumed, never destroyed.
    expect(existsSync(archive)).toBe(true);
  });

  it("imports a tar.gz snapshot with its directory structure", async () => {
    const env = trackedEnv();
    const base = makeTempDir("shera-s19-archive-base-");
    const archive = join(base, "repo.tar.gz");
    writeFileSync(
      archive,
      gzipSync(
        writeTar([
          { name: "README.md", data: Buffer.from("# tarred\n") },
          { name: "src/", typeflag: "5" },
          { name: "src/main.go", data: Buffer.from("package main\n") },
        ]),
      ),
    );
    const project = await env.git.importProject({
      workspace_id: WS,
      name: "tarred",
      actor: USER,
      source: { kind: "archive", path: archive },
    });
    expect(readFileSync(join(project.repo_path, "src", "main.go"), "utf8")).toBe("package main\n");
  });

  it("registers NOTHING and leaves no staging directory when the archive is hostile", async () => {
    const env = trackedEnv();
    const base = makeTempDir("shera-s19-archive-base-");
    const archive = join(base, "evil.zip");
    writeFileSync(
      archive,
      writeStoredZip([
        { name: "README.md", data: Buffer.from("# good\n") },
        { name: "../escaped.txt", data: Buffer.from("x") },
      ]),
    );
    await expect(
      env.git.importProject({
        workspace_id: WS,
        name: "evil",
        actor: USER,
        source: { kind: "archive", path: archive },
      }),
    ).rejects.toThrow(/escapes the destination/);
    expect(env.projects.listProjects(WS)).toEqual([]);
    expect(readdirSync(env.projectsRoot)).toEqual([]);
    // And nothing escaped the workspace either.
    expect(existsSync(join(base, "escaped.txt"))).toBe(false);
  });

  it("fails typed when the archive file does not exist", async () => {
    const env = trackedEnv();
    await expect(
      env.git.importProject({
        workspace_id: WS,
        name: "ghost",
        actor: USER,
        source: { kind: "archive", path: join(tempDirs[0] ?? ".", "missing.zip") },
      }),
    ).rejects.toThrow(/archive file does not exist/);
    expect(env.projects.listProjects(WS)).toEqual([]);
  });
});
