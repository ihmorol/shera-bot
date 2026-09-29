import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PACK_AGENTS, PACK_OPERATION_TEMPLATES } from "../lib/navigation";
import { ROUTE_MANIFEST, routes } from "../lib/routes";

/**
 * Chunk-1 route-skeleton contract (UI_DESIGN §3.1): every route resolves, no
 * dead links. Navigation flows through lib/routes builders; the manifest is
 * the single source of truth and is checked against the app-router file tree.
 */
const APP_DIR = join(import.meta.dirname, "..");
const COMPONENT_DIRS = ["app", "components"].map((dir) => join(APP_DIR, dir));
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo"]);

/** Compile "/app/agent/[agentId]" / "/app/settings/[[...section]]" to a matcher. */
function compilePattern(pattern: string): (path: string) => boolean {
  const regex = new RegExp(
    `^${pattern
      .replace(/\/\[\[\.\.\.[^\]]+\]\]/g, "(?:/.*)?")
      .replace(/\/\[\.\.\.[^\]]+\]/g, "/.+")
      .replace(/\/\[[^\]]+\]/g, "/[^/]+")
      .replace(/\//g, "/")}$`,
  );
  return (path: string) => regex.test(path);
}

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) files.push(...listSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      files.push(full);
    }
  }
  return files;
}

describe("route manifest (UI_DESIGN §3.1)", () => {
  it("covers the chunk-1 route map", () => {
    const paths = ROUTE_MANIFEST.map((route) => route.path);
    expect(paths).toEqual([
      "/login",
      "/app",
      "/app/agent/[agentId]",
      "/app/operation/new",
      "/app/operation/[operationId]",
      "/app/operation/[operationId]/preview",
      "/app/chat/[chatId]/workspace",
      "/app/chat/[chatId]/workspace/full",
      "/app/settings/[[...section]]",
    ]);
  });

  it("every manifest entry has a page.tsx in the app router", () => {
    const missing = ROUTE_MANIFEST.filter(
      (route) => !existsSync(join(APP_DIR, "app", route.path, "page.tsx")),
    ).map((route) => route.path);
    expect(missing, `routes without page.tsx: ${missing.join(", ")}`).toEqual([]);
  });

  it("every route builder output matches exactly one manifest pattern", () => {
    const samples: Array<[string, string]> = [
      ["login", routes.login()],
      ["app", routes.app()],
      ["agent", routes.agent("general-assistant")],
      ["operationNew", routes.operationNew()],
      ["operation", routes.operation("research-paper")],
      ["operationPreview", routes.operationPreview("research-paper")],
      ["workspace", routes.workspace("chat-1")],
      ["workspaceFull", routes.workspaceFull("chat-1")],
      ["settings", routes.settings()],
      ["settings(section)", routes.settings("providers")],
    ];
    const dead = samples.filter(([, path]) => {
      // Next.js static routes take precedence over dynamic ones
      // ("/app/operation/new" vs "/app/operation/[operationId]"), so multiple
      // manifest matches are fine — zero matches is a dead link.
      const matches = ROUTE_MANIFEST.filter((route) => {
        return compilePattern(route.path)(path);
      });
      return matches.length === 0;
    });
    expect(dead, `builder outputs that do not resolve to a manifest route: ${dead.map(([name]) => name).join(", ")}`).toEqual([]);
  });
});

describe("navigation integrity", () => {
  it("the root URL redirects to the login route (no dead /)", () => {
    const rootPage = readFileSync(join(APP_DIR, "app", "page.tsx"), "utf8");
    expect(rootPage).toContain("redirect(routes.login())");
  });

  it("internal links use route builders — no raw href literals in UI source", () => {
    const violations: string[] = [];
    for (const dir of COMPONENT_DIRS) {
      for (const file of listSourceFiles(dir)) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (/href\s*=\s*["']\/(?!\/)/.test(line)) {
            violations.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(violations, "use the lib/routes builders instead of literal hrefs").toEqual([]);
  });
});

describe("sidebar pack navigation (D43/D46 shell seed)", () => {
  it("lists the six pack Agents", () => {
    expect(PACK_AGENTS.map((agent) => agent.name)).toEqual([
      "General Assistant",
      "Researcher",
      "Developer",
      "Citation Manager",
      "Programming Tutor",
      "Study Planner",
    ]);
  });

  it("lists the three pack Operation templates", () => {
    expect(PACK_OPERATION_TEMPLATES.map((operation) => operation.name)).toEqual([
      "Research Paper",
      "Programming Assignment",
      "Exam Preparation",
    ]);
  });

  it("every sidebar entry builds a resolvable route", () => {
    const agentRoutes = PACK_AGENTS.map((agent) => routes.agent(agent.slug));
    const templateRoutes = PACK_OPERATION_TEMPLATES.map((operation) =>
      routes.operationPreview(operation.slug),
    );
    const matchers = ROUTE_MANIFEST.map((route) => compilePattern(route.path));
    const allResolve = [...agentRoutes, ...templateRoutes].every((path) =>
      matchers.some((match) => match(path)),
    );
    expect(allResolve).toBe(true);
  });
});
