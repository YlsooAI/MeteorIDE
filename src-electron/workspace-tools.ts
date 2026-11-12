import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../src/zen.js";
import { IGNORED_DIRS, LOCKFILES } from "./workspace.js";

/**
 * Workspace tools give the model direct, scoped access to the user's project
 * instead of stuffing file contents into every system prompt.
 *
 * All paths are workspace-relative and are rejected if they escape the root.
 */

export interface WorkspaceToolResult {
  /** Text handed back to the model (JSON for structured tools). */
  text: string;
  /** Extra payload for the renderer's tool cards. */
  structured?: unknown;
  isError?: boolean;
}

type Args = Record<string, unknown>;

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 500;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 500;
const MAX_WALK_FILES = 8000;
const SEARCH_TIMEOUT_MS = 15000;
const UNDO_MAX_BYTES = 256 * 1024;

export const WORKSPACE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    server: "workspace",
    name: "list_files",
    description:
      "List files and directories in the user's workspace. Use this to discover project structure and exact paths before reading, searching or editing. Paths returned are relative to the workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to the workspace root. Omit for the root." },
        depth: { type: "number", description: "How many directory levels to recurse (default 2, max 6)." },
        limit: { type: "number", description: "Maximum number of entries to return (default 500, max 5000)." },
        glob: { type: "string", description: "Only list files matching this glob, e.g. '*.ts' or 'src/**/*.tsx'." },
      },
    },
  },
  {
    server: "workspace",
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace. Returns line-numbered ranges so you can request only the part you need. Read the relevant range before editing; large files should be read in chunks.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        startLine: { type: "number", description: "First line to return (1-based, default 1)." },
        endLine: { type: "number", description: "Last line to return (inclusive, default startLine + 499)." },
      },
      required: ["path"],
    },
  },
  {
    server: "workspace",
    name: "search",
    description:
      "Search the workspace for text or a regular expression (ripgrep-backed when available). Returns matching file paths, line numbers and line text. Use this to locate symbols, strings, call sites and configuration without reading whole files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or regular expression to search for." },
        path: { type: "string", description: "Directory to search, relative to the workspace root. Omit for the whole workspace." },
        glob: { type: "string", description: "Only search files matching this glob, e.g. '*.ts' or 'src/**/*.tsx'." },
        literal: { type: "boolean", description: "Treat query as plain text (default true). Set false to use a regular expression." },
        caseSensitive: { type: "boolean", description: "Match case exactly (default false)." },
        maxResults: { type: "number", description: "Maximum matches to return (default 100, max 500)." },
      },
      required: ["query"],
    },
  },
  {
    server: "workspace",
    name: "project_info",
    description:
      "Summarize the workspace project: top-level entries, manifest files, package name/version/scripts, package manager, and git branch/status. Call this once when you need to know how to build, test or run the project.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    server: "workspace",
    name: "edit_file",
    description:
      "Replace an exact block of text in a workspace file. This is the safest and preferred tool for a single, small change: copy enough surrounding text from read_file so oldText appears exactly once. Set replaceAll to change every occurrence. Preserve the original indentation; line endings are handled automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        oldText: { type: "string", description: "Exact text to find. Include surrounding lines so it is unique." },
        newText: { type: "string", description: "Replacement text. Use an empty string to delete the matched block." },
        replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match (default false)." },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    server: "workspace",
    name: "apply_patch",
    description:
      "Apply a unified diff (git-style) or a '*** Begin Patch' block to one or more workspace files. Use this for multi-file changes, several hunks, or creating/deleting files. Supports creating files ('--- /dev/null') and deleting them ('+++ /dev/null'). Every path is relative to the workspace root. If any hunk does not match, nothing is written.",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "Unified diff text, e.g. '--- a/src/app.ts\\n+++ b/src/app.ts\\n@@ -10,7 +10,7 @@\\n context\\n-old\\n+new\\n context'. One section per file. A '*** Begin Patch ... *** End Patch' block is also accepted.",
        },
        dryRun: { type: "boolean", description: "Validate and report changes without writing to disk." },
      },
      required: ["patch"],
    },
  },
  {
    server: "workspace",
    name: "move_file",
    description:
      "Move or rename a workspace file. Creates missing parent directories. Use this for refactors and renames; use apply_patch for content changes.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Existing file path relative to the workspace root." },
        to: { type: "string", description: "New file path relative to the workspace root." },
        overwrite: { type: "boolean", description: "Allow replacing an existing destination file (default false)." },
      },
      required: ["from", "to"],
    },
  },
];

/** Tools that can modify the workspace; hidden and rejected in plan mode. */
export const WORKSPACE_WRITE_TOOLS = new Set(["edit_file", "apply_patch", "move_file"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(num(v, fallback));
  return Math.min(max, Math.max(min, n));
}

function arg(args: Args, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

/** Normalize a user/model supplied path and reject traversal outside the root. */
function safeRel(input: unknown): string {
  const raw = str(input).trim();
  if (!raw) return "";
  if (raw.includes("\0")) throw new Error("Invalid path: null byte");
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`Paths must be relative to the workspace root: ${raw}`);
  }
  const rel = raw.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (rel.split("/").some((part) => part === "..")) {
    throw new Error(`Refusing path outside the workspace: ${raw}`);
  }
  return rel;
}

function absInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Refusing path outside the workspace");
  }
  return abs;
}

async function exists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Never write through a symlink that may point outside the workspace. */
async function rejectSymlink(abs: string, rel: string): Promise<void> {
  let st;
  try {
    st = await lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${rel}`);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/* ── list_files ─────────────────────────────────────────────────────── */

async function listFiles(root: string, args: Args): Promise<WorkspaceToolResult> {
  const baseRel = safeRel(arg(args, "path", "dir", "directory"));
  const baseAbs = absInside(root, baseRel);
  const baseStat = await stat(baseAbs);
  const glob = str(arg(args, "glob", "include")).trim();
  const globRe = globToRegExp(glob);
  const depth = clampInt(arg(args, "depth"), globRe ? 6 : 2, 0, 6);
  const limit = clampInt(arg(args, "limit"), 500, 1, 5000);
  const entries: Array<{ path: string; type: "file" | "dir"; size?: number }> = [];
  let truncated = false;

  if (!baseStat.isDirectory()) {
    if (globRe && !globRe.test(baseRel)) {
      const data = { ok: true, root, path: baseRel, entries: [], truncated: false, total: 0 };
      return { text: json(data), structured: data };
    }
    const size = baseStat.size;
    const data = { ok: true, root, path: baseRel, entries: [{ path: baseRel, type: "file" as const, size }], truncated: false, total: 1 };
    return { text: json(data), structured: data };
  }

  const walk = async (absDir: string, relDir: string, level: number): Promise<void> => {
    if (entries.length >= limit) {
      truncated = true;
      return;
    }
    const dirents = await readdir(absDir, { withFileTypes: true });
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of dirents) {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      if (entry.name === ".DS_Store" || entry.name.endsWith(".pyc")) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (globRe) {
          // With a glob, flatten results and keep walking.
          if (level < depth) await walk(path.join(absDir, entry.name), rel, level + 1);
          continue;
        }
        entries.push({ path: rel, type: "dir" });
        if (level < depth) await walk(path.join(absDir, entry.name), rel, level + 1);
      } else if (entry.isFile()) {
        if (globRe && !globRe.test(rel)) continue;
        if (LOCKFILES.has(entry.name)) {
          entries.push({ path: rel, type: "file" });
          continue;
        }
        let size: number | undefined;
        try {
          size = (await stat(path.join(absDir, entry.name))).size;
        } catch {}
        entries.push({ path: rel, type: "file", ...(size !== undefined ? { size } : {}) });
      }
    }
  };

  await walk(baseAbs, baseRel, 0);
  const data = { ok: true, root, path: baseRel || ".", entries, truncated, total: entries.length };
  return { text: json(data), structured: data };
}

/* ── read_file ──────────────────────────────────────────────────────── */

async function readFileTool(root: string, args: Args): Promise<WorkspaceToolResult> {
  const rel = safeRel(arg(args, "path", "file_path", "file"));
  if (!rel) throw new Error("read_file requires a path");
  const abs = absInside(root, rel);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
  if (st.size > MAX_READ_BYTES) throw new Error(`File is too large to read (${st.size} bytes, max ${MAX_READ_BYTES})`);

  const buffer = await readFile(abs);
  if (buffer.includes(0)) throw new Error(`Refusing to read binary file: ${rel}`);
  const source = buffer.toString("utf8");
  const lines = source.split(/\r?\n/);
  const totalLines = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

  const startLine = clampInt(arg(args, "startLine", "start_line", "start"), 1, 1, Math.max(1, totalLines));
  const requestedEnd = clampInt(
    arg(args, "endLine", "end_line", "end"),
    startLine + MAX_READ_LINES - 1,
    startLine,
    Math.max(startLine, totalLines),
  );
  const endLine = Math.min(requestedEnd, startLine + MAX_READ_LINES - 1, Math.max(totalLines, 1));
  const content = totalLines === 0 ? "" : lines.slice(startLine - 1, endLine).join("\n");
  const data = {
    ok: true,
    path: rel,
    startLine,
    endLine: totalLines === 0 ? 0 : endLine,
    totalLines,
    truncated: totalLines > 0 && endLine < totalLines,
    content,
  };
  return { text: json(data), structured: data };
}

/* ── project_info ───────────────────────────────────────────────────── */

function runGit(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: root, timeout: 3000, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout.toString());
    });
  });
}

const MANIFEST_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Makefile",
  "CMakeLists.txt",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "Dockerfile",
  "docker-compose.yml",
  "compose.yml",
]);

async function projectInfoTool(root: string): Promise<WorkspaceToolResult> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const topLevel = entries
    .filter((entry) => !entry.name.startsWith(".DS_Store") && !IGNORED_DIRS.has(entry.name))
    .slice(0, 80)
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }));
  const names = new Set(topLevel.map((entry) => entry.name));
  const manifests = [...MANIFEST_FILES].filter((name) => names.has(name));

  let pkg: { name?: string; version?: string; type?: string; scripts?: Record<string, string> } | null = null;
  if (names.has("package.json")) {
    try {
      const raw = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
      const scripts =
        raw.scripts && typeof raw.scripts === "object"
          ? Object.fromEntries(Object.entries(raw.scripts as Record<string, unknown>).slice(0, 30).map(([k, v]) => [k, String(v)]))
          : undefined;
      pkg = {
        name: typeof raw.name === "string" ? raw.name : undefined,
        version: typeof raw.version === "string" ? raw.version : undefined,
        type: typeof raw.type === "string" ? raw.type : undefined,
        scripts,
      };
    } catch {
      pkg = null;
    }
  }

  let packageManager: string | null = null;
  for (const [file, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ]) {
    if (names.has(file)) {
      packageManager = manager;
      break;
    }
  }
  if (!packageManager && names.has("package.json")) packageManager = "npm";

  let git: { branch: string; dirty: number; changed: string[]; lastCommit: string | null } | null = null;
  const branch = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) {
    const status = await runGit(root, ["status", "--porcelain"]);
    const changed = (status ?? "").split("\n").filter(Boolean);
    const lastCommit = await runGit(root, ["log", "-1", "--format=%h %s"]);
    git = { branch: branch.trim(), dirty: changed.length, changed: changed.slice(0, 15), lastCommit: lastCommit?.trim() || null };
  }

  const summary = [
    pkg?.name,
    packageManager,
    git ? `${git.branch}${git.dirty > 0 ? ` · ${git.dirty} changed` : " · clean"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const data = { ok: true, root, name: path.basename(root), topLevel, manifests, package: pkg, packageManager, git, summary };
  return { text: json(data), structured: data };
}

/* ── search ─────────────────────────────────────────────────────────── */

interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

interface SearchData {
  ok: boolean;
  query: string;
  engine: "rg" | "node";
  matches: SearchMatch[];
  total: number;
  truncated: boolean;
  error?: string;
}

function normalizeMatchPath(raw: string, root: string): string {
  let p = raw.replace(/\\/g, "/");
  const rootNorm = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (p.startsWith(rootNorm + "/")) p = p.slice(rootNorm.length + 1);
  return p.replace(/^\.\/+/, "");
}

async function runRipgrep(root: string, query: string, subRel: string, literal: boolean, caseSensitive: boolean, glob: string, maxResults: number): Promise<SearchData | null> {
  const rgArgs = [
    "--json",
    "--color",
    "never",
    "--max-columns",
    "500",
    "--max-columns-preview",
    "--max-filesize",
    "1M",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!.git/**",
    "--glob",
    "!dist/**",
    "--glob",
    "!build/**",
    "--glob",
    "!coverage/**",
  ];
  if (literal) rgArgs.push("--fixed-strings");
  if (!caseSensitive) rgArgs.push("--ignore-case");
  if (glob) rgArgs.push("--glob", glob);
  rgArgs.push("--", query, subRel || ".");

  const result = await new Promise<{ code: number; stdout: string; stderr: string; missing: boolean }>((resolve) => {
    let child;
    try {
      child = spawn("rg", rgArgs, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: 1, stdout: "", stderr: "", missing: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number, missing = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, missing });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(124);
    }, SEARCH_TIMEOUT_MS);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err: NodeJS.ErrnoException) => finish(1, err.code === "ENOENT"));
    child.on("close", (code) => finish(code ?? 1));
  });

  if (result.missing) return null;

  const matches: SearchMatch[] = [];
  let truncated = false;
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: {
      type?: string;
      data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const p = normalizeMatchPath(event.data?.path?.text || "", root);
    const text = (event.data?.lines?.text || "").replace(/\r?\n$/, "");
    if (!p) continue;
    matches.push({ path: p, line: event.data?.line_number || 0, text });
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
  }

  if (result.code > 1 && result.stderr.trim()) {
    return { ok: false, query, engine: "rg", matches: [], total: 0, truncated: false, error: result.stderr.trim().slice(0, 2000) };
  }
  return { ok: true, query, engine: "rg", matches, total: matches.length, truncated };
}

function globToRegExp(glob: string): RegExp | null {
  if (!glob || !glob.trim()) return null;
  const escaped = glob
    .trim()
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0002")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0002/g, ".*");
  try {
    return new RegExp(`^${escaped}$`);
  } catch {
    return null;
  }
}

async function fallbackSearch(root: string, query: string, subRel: string, literal: boolean, caseSensitive: boolean, glob: string, maxResults: number): Promise<SearchData> {
  const baseAbs = absInside(root, subRel);
  const globRe = globToRegExp(glob);
  const needle = caseSensitive ? query : query.toLowerCase();
  let regex: RegExp | null = null;
  if (!literal) {
    try {
      regex = new RegExp(query, caseSensitive ? "" : "i");
    } catch (err) {
      return { ok: false, query, engine: "node", matches: [], total: 0, truncated: false, error: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const matcher = (line: string): boolean => {
    if (regex) return regex.test(line);
    return caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle);
  };

  // A model may pass a file path rather than a directory.
  const baseStat = await stat(baseAbs).catch(() => null);
  if (baseStat?.isFile()) {
    const matches: SearchMatch[] = [];
    let truncated = false;
    if (!globRe || globRe.test(subRel)) {
      if (baseStat.size <= MAX_SEARCH_FILE_BYTES) {
        const buffer = await readFile(baseAbs).catch(() => null);
        if (buffer && !buffer.includes(0)) {
          const fileLines = buffer.toString("utf8").split(/\r?\n/);
          for (let i = 0; i < fileLines.length; i++) {
            if (!matcher(fileLines[i])) continue;
            matches.push({ path: subRel, line: i + 1, text: fileLines[i].slice(0, 500) });
            if (matches.length >= maxResults) {
              truncated = true;
              break;
            }
          }
        }
      }
    }
    return { ok: true, query, engine: "node", matches, total: matches.length, truncated };
  }

  const matches: SearchMatch[] = [];
  let truncated = false;
  let visited = 0;
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    if (matches.length >= maxResults || visited >= MAX_WALK_FILES) {
      truncated = true;
      return;
    }
    let dirents;
    try {
      dirents = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirents) {
      if (matches.length >= maxResults || visited >= MAX_WALK_FILES) {
        truncated = true;
        return;
      }
      if (entry.name === ".DS_Store" || entry.name.endsWith(".pyc")) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(absDir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (LOCKFILES.has(entry.name)) continue;
      if (globRe && !globRe.test(rel)) continue;
      const abs = path.join(absDir, entry.name);
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.size > MAX_SEARCH_FILE_BYTES) continue;
      visited += 1;
      let buffer;
      try {
        buffer = await readFile(abs);
      } catch {
        continue;
      }
      if (buffer.includes(0)) continue;
      const fileLines = buffer.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < fileLines.length; i++) {
        if (matcher(fileLines[i])) {
          matches.push({ path: rel, line: i + 1, text: fileLines[i].slice(0, 500) });
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      }
    }
  };
  await walk(baseAbs, subRel);
  return { ok: true, query, engine: "node", matches, total: matches.length, truncated };
}

async function searchTool(root: string, args: Args): Promise<WorkspaceToolResult> {
  const query = str(arg(args, "query", "q", "pattern"));
  if (!query) throw new Error("search requires a query");
  const subRel = safeRel(arg(args, "path", "dir", "directory"));
  const literalArg = arg(args, "literal", "fixed", "fixed_strings");
  const literal = literalArg === undefined ? true : literalArg !== false && literalArg !== "false";
  const caseSensitive = arg(args, "caseSensitive", "case_sensitive") === true;
  const glob = str(arg(args, "glob", "include")).trim();
  const maxResults = clampInt(arg(args, "maxResults", "max_results", "limit"), 100, 1, MAX_SEARCH_RESULTS);

  const viaRg = await runRipgrep(root, query, subRel, literal, caseSensitive, glob, maxResults);
  const data = viaRg ?? (await fallbackSearch(root, query, subRel, literal, caseSensitive, glob, maxResults));
  return { text: json(data), structured: data, isError: data.ok === false };
}

/* ── apply_patch ────────────────────────────────────────────────────── */

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

interface ParsedFilePatch {
  oldPath: string | null;
  newPath: string | null;
  hunks: ParsedHunk[];
}

interface FileChange {
  path: string;
  action: "create" | "update" | "delete";
  added: number;
  removed: number;
  hunks: number;
}

function patchHeaderPath(raw: string): string | null {
  let p = raw.trim();
  p = p.split("\t")[0].trim();
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p === "/dev/null") return null;
  p = p.replace(/^[ab]\//, "");
  return p;
}

function parseUnifiedPatch(patch: string): ParsedFilePatch[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: ParsedFilePatch[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (
      /^diff --git /.test(line) ||
      /^(index |new file mode |deleted file mode |old mode |new mode |similarity index |rename (from|to) )/.test(line)
    ) {
      i += 1;
      continue;
    }
    if (!line.startsWith("--- ")) {
      i += 1;
      continue;
    }

    const oldPath = patchHeaderPath(line.slice(4));
    i += 1;
    if (!lines[i]?.startsWith("+++ ")) {
      throw new Error(`Malformed patch: expected "+++ " after "--- " (line ${i + 1})`);
    }
    const newPath = patchHeaderPath(lines[i].slice(4));
    i += 1;

    const hunks: ParsedHunk[] = [];
    while (i < lines.length) {
      const current = lines[i];
      if (current.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) break;
      if (current.startsWith("diff --git ")) break;
      if (current.startsWith("\\")) {
        i += 1;
        continue;
      }
      if (!current.startsWith("@@")) {
        i += 1;
        continue;
      }
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(current);
      if (!m) throw new Error(`Malformed hunk header (line ${i + 1}): ${current}`);
      const hunk: ParsedHunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      i += 1;
      while (i < lines.length) {
        const body = lines[i];
        if (body.startsWith("@@")) break;
        if (body.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) break;
        if (body.startsWith("diff --git ")) break;
        if (body.startsWith("\\")) {
          i += 1;
          continue;
        }
        if (body === "") {
          // Blank lines are ambiguous: trailing newlines end the patch, and some
          // models drop the leading space from empty context lines.
          const next = lines[i + 1] ?? "";
          if (i === lines.length - 1 || next.startsWith("@@") || next.startsWith("--- ") || next.startsWith("diff --git ")) {
            i += 1;
            continue;
          }
          hunk.lines.push(" ");
          i += 1;
          continue;
        }
        const prefix = body[0];
        if (prefix !== " " && prefix !== "+" && prefix !== "-") break;
        hunk.lines.push(body);
        i += 1;
      }
      hunks.push(hunk);
    }
    files.push({ oldPath, newPath, hunks });
  }
  if (files.length === 0) {
    throw new Error("No file sections found. Expected a unified diff starting with '--- a/path' and '+++ b/path'.");
  }
  return files;
}

function parseBeginPatch(patch: string): ParsedFilePatch[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: ParsedFilePatch[] = [];
  let current: ParsedFilePatch | null = null;
  let hunk: ParsedHunk | null = null;
  let mode: "update" | "add" | "delete" | null = null;

  const pushHunk = (): void => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };
  const closeFile = (): void => {
    pushHunk();
    if (current) files.push(current);
    current = null;
    mode = null;
  };
  const newHunk = (header?: string): ParsedHunk => {
    const m = header ? /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header.trim()) : null;
    return m
      ? {
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
          lines: [],
        }
      : { oldStart: 0, oldCount: 0, newStart: 1, newCount: 0, lines: [] };
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const directive = rawLine.trimStart();
    if (/^\*\*\* (Begin Patch|End Patch)/.test(directive) || directive === "*** End of File") {
      if (/^\*\*\* End Patch/.test(directive)) closeFile();
      continue;
    }

    const updateMatch = /^\*\*\* (?:Update|Modify) File:\s*(.+)$/.exec(directive);
    if (updateMatch) {
      closeFile();
      const p = patchHeaderPath(updateMatch[1]);
      current = { oldPath: p, newPath: p, hunks: [] };
      mode = "update";
      continue;
    }
    const addMatch = /^\*\*\* Add File:\s*(.+)$/.exec(directive);
    if (addMatch) {
      closeFile();
      current = { oldPath: null, newPath: patchHeaderPath(addMatch[1]), hunks: [] };
      hunk = newHunk();
      mode = "add";
      continue;
    }
    const deleteMatch = /^\*\*\* Delete File:\s*(.+)$/.exec(directive);
    if (deleteMatch) {
      closeFile();
      current = { oldPath: patchHeaderPath(deleteMatch[1]), newPath: null, hunks: [] };
      mode = "delete";
      continue;
    }
    if (/^\*\*\* Move to:/.test(directive)) {
      throw new Error("This patch uses '*** Move to:' — use the move_file tool for renames instead.");
    }
    if (!current) continue;
    if (mode === "delete") continue;

    if (mode === "add") {
      hunk ??= newHunk();
      // Add File lines are normally prefixed with '+'; accept unprefixed too.
      const content = rawLine.startsWith("+") ? rawLine.slice(1) : rawLine;
      hunk.lines.push(`+${content}`);
      continue;
    }

    if (directive.startsWith("@@")) {
      pushHunk();
      hunk = newHunk(directive);
      continue;
    }
    hunk ??= newHunk();
    if (rawLine === "") {
      hunk.lines.push(" ");
      continue;
    }
    const prefix = rawLine[0];
    if (prefix === " " || prefix === "+" || prefix === "-") hunk.lines.push(rawLine);
  }
  closeFile();

  if (files.length === 0) {
    throw new Error("No file sections found in the '*** Begin Patch' block.");
  }
  return files;
}

function parsePatch(patch: string): ParsedFilePatch[] {
  if (/\*\*\* (Begin Patch|Update File:|Modify File:|Add File:|Delete File:)/.test(patch)) {
    return parseBeginPatch(patch);
  }
  return parseUnifiedPatch(patch);
}

function findBlock(lines: string[], block: string[], expected: number): number {
  const within = (at: number): boolean => at >= 0 && at + block.length <= lines.length;
  const exact = (at: number): boolean => {
    for (let j = 0; j < block.length; j++) if (lines[at + j] !== block[j]) return false;
    return true;
  };
  const trimEnd = (s: string): string => s.replace(/\s+$/, "");
  const blockTrimmed = block.map(trimEnd);
  const loose = (at: number): boolean => {
    for (let j = 0; j < blockTrimmed.length; j++) if (trimEnd(lines[at + j] ?? "") !== blockTrimmed[j]) return false;
    return true;
  };
  const search = (predicate: (at: number) => boolean, maxDistance: number): number => {
    if (expected < 0) {
      // No line number (e.g. '*** Begin Patch' hunks) — scan the whole file.
      for (let at = 0; at + block.length <= lines.length; at++) if (predicate(at)) return at;
      return -1;
    }
    if (within(expected) && predicate(expected)) return expected;
    for (let distance = 1; distance <= maxDistance; distance++) {
      const up = expected - distance;
      const down = expected + distance;
      if (within(up) && predicate(up)) return up;
      if (within(down) && predicate(down)) return down;
    }
    return -1;
  };

  const exactAt = search(exact, 500);
  if (exactAt !== -1) return exactAt;
  // Second pass: tolerate trailing whitespace differences.
  return search(loose, 200);
}

function mismatchMessage(lines: string[], block: string[], expected: number, rel: string, oldStart: number): string {
  const first = block[0] ?? "";
  const hits: number[] = [];
  if (first) {
    for (let i = 0; i < lines.length && hits.length < 3; i++) if (lines[i] === first) hits.push(i + 1);
  }
  const around = expected >= 0 ? Math.max(0, Math.min(expected, Math.max(0, lines.length - 1))) : 0;
  const limit = Math.min(Math.max(block.length, 3), 8);
  const expectedExcerpt = block
    .slice(0, limit)
    .map((line, index) => `${around + index + 1}| ${line}`)
    .join("\n");
  const actualExcerpt = lines
    .slice(around, around + limit)
    .map((line, index) => `${around + index + 1}| ${line}`)
    .join("\n");
  return [
    `Hunk at ${rel}:${oldStart > 0 ? oldStart : "?"} does not match the current file.`,
    hits.length ? `The first context line appears at line(s) ${hits.join(", ")}.` : "The first context line was not found.",
    `Expected around line ${around + 1}:`,
    expectedExcerpt,
    "Actual:",
    actualExcerpt || "(end of file)",
    `Read ${rel} again (or search for the context line) and regenerate the patch with exact context.`,
  ].join("\n");
}

function applyHunks(source: string, hunks: ParsedHunk[], rel: string): { content: string; added: number; removed: number } {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (hadTrailingNewline) lines.pop();

  let delta = 0;
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line[0] === "+") added += 1;
      else if (line[0] === "-") removed += 1;
    }
    const oldBlock = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
    const newBlock = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
    // oldStart === 0 means the hunk had no line numbers ('*** Begin Patch'),
    // so search the whole file instead of assuming a position.
    const expected = hunk.oldStart > 0 ? Math.max(0, hunk.oldStart - 1 + delta) : -1;
    let at: number;
    if (oldBlock.length === 0) {
      at = expected >= 0 ? Math.min(expected, lines.length) : lines.length;
    } else {
      at = findBlock(lines, oldBlock, expected);
      if (at === -1) {
        throw new Error(mismatchMessage(lines, oldBlock, expected, rel, hunk.oldStart));
      }
    }
    lines.splice(at, oldBlock.length, ...newBlock);
    delta += newBlock.length - oldBlock.length;
  }

  let content = lines.join(eol);
  if (hadTrailingNewline) content += eol;
  return { content, added, removed };
}

async function applyPatchTool(root: string, args: Args): Promise<WorkspaceToolResult> {
  const patch = str(arg(args, "patch", "diff", "input"));
  if (!patch.trim()) throw new Error("apply_patch requires a unified diff in 'patch'");
  const dryRun = arg(args, "dryRun", "dry_run") === true;
  const parsed = parsePatch(patch);

  const undoSnapshot = (source: string): string | undefined =>
    Buffer.byteLength(source, "utf8") <= UNDO_MAX_BYTES ? source : undefined;

  const planned: Array<{ abs: string; change: FileChange; content?: string; before?: string }> = [];
  for (const file of parsed) {
    if (file.oldPath === null && file.newPath === null) continue;
    const rel = safeRel(file.newPath ?? file.oldPath);
    if (!rel) throw new Error("Patch contains an empty file path");
    const abs = absInside(root, rel);
    await rejectSymlink(abs, rel);

    if (file.newPath === null) {
      if (!(await exists(abs))) throw new Error(`Cannot delete missing file: ${rel}`);
      let source: string | undefined;
      try {
        source = await readFile(abs, "utf8");
      } catch {
        source = undefined;
      }
      let removed = 0;
      // A delete patch still carries context; validate it before unlinking so a
      // stale patch can't remove a file the model never actually read.
      if (file.hunks.length > 0) {
        if (source === undefined) throw new Error(`Cannot read file to validate delete: ${rel}`);
        applyHunks(source, file.hunks, rel);
        removed = file.hunks.reduce((n, hunk) => n + hunk.lines.filter((line) => line[0] === "-").length, 0);
      }
      planned.push({
        abs,
        change: { path: rel, action: "delete", added: 0, removed, hunks: file.hunks.length },
        before: source !== undefined ? undoSnapshot(source) : undefined,
      });
      continue;
    }

    if (file.oldPath === null) {
      if (await exists(abs)) {
        throw new Error(`Cannot create ${rel}: the file already exists. Read it first and send an update hunk instead.`);
      }
      const contentLines = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1)));
      const content = contentLines.join("\n") + "\n";
      planned.push({
        abs,
        change: { path: rel, action: "create", added: contentLines.length, removed: 0, hunks: file.hunks.length },
        content,
      });
      continue;
    }

    const source = await readFile(abs, "utf8");
    const { content, added, removed } = applyHunks(source, file.hunks, rel);
    planned.push({
      abs,
      change: { path: rel, action: "update", added, removed, hunks: file.hunks.length },
      content,
      before: undoSnapshot(source),
    });
  }

  if (planned.length === 0) throw new Error("The patch did not contain any file changes");

  // All patches validated — only now touch the disk.
  if (!dryRun) {
    for (const item of planned) {
      if (item.change.action === "delete") {
        await unlink(item.abs);
      } else {
        await mkdir(path.dirname(item.abs), { recursive: true });
        await writeFile(item.abs, item.content ?? "", "utf8");
      }
    }
  }

  const files = planned.map((item) => item.change);
  const totalAdded = files.reduce((n, f) => n + f.added, 0);
  const totalRemoved = files.reduce((n, f) => n + f.removed, 0);
  const summary = `${dryRun ? "Validated (dry run)" : "Applied"} ${files.length} file${files.length === 1 ? "" : "s"} (+${totalAdded} -${totalRemoved})`;
  const data = { ok: true, dryRun, files, summary };
  // 'before' is only for the renderer's undo stack — never send it to the model.
  const structuredFiles = planned.map((item) =>
    item.before !== undefined ? { ...item.change, before: item.before } : item.change,
  );
  return { text: json(data), structured: { ...data, files: structuredFiles } };
}

/* ── edit_file ──────────────────────────────────────────────────────── */

async function editFileTool(root: string, args: Args): Promise<WorkspaceToolResult> {
  const rel = safeRel(arg(args, "path", "file_path", "file"));
  if (!rel) throw new Error("edit_file requires a path");
  const oldTextRaw = str(arg(args, "oldText", "old_text", "old_string", "find"));
  const newTextRaw = str(arg(args, "newText", "new_text", "new_string", "replace"));
  if (!oldTextRaw) throw new Error("edit_file requires a non-empty oldText");
  if (oldTextRaw === newTextRaw) throw new Error("oldText and newText are identical — nothing to change");

  const abs = absInside(root, rel);
  await rejectSymlink(abs, rel);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
  if (st.size > MAX_READ_BYTES) throw new Error(`File is too large to edit (${st.size} bytes, max ${MAX_READ_BYTES})`);

  const source = await readFile(abs, "utf8");
  if (source.includes("\0")) throw new Error(`Refusing to edit binary file: ${rel}`);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const normalized = source.replace(/\r\n/g, "\n");
  const oldText = oldTextRaw.replace(/\r\n/g, "\n");
  const newText = newTextRaw.replace(/\r\n/g, "\n");

  const count = normalized.split(oldText).length - 1;
  if (count === 0) {
    throw new Error(
      `oldText was not found in ${rel}. Read the file again and copy the exact text, including indentation and surrounding lines.`,
    );
  }
  const replaceAll = arg(args, "replaceAll", "replace_all", "all") === true;
  if (count > 1 && !replaceAll) {
    throw new Error(
      `oldText appears ${count} times in ${rel}. Include more surrounding text to make it unique, or set replaceAll: true.`,
    );
  }
  if (count > 5000) throw new Error(`Refusing to replace ${count} occurrences in ${rel}; narrow the match.`);

  const firstIndex = normalized.indexOf(oldText);
  const line = normalized.slice(0, firstIndex).split("\n").length;
  const replaced = replaceAll
    ? normalized.split(oldText).join(newText)
    : normalized.slice(0, firstIndex) + newText + normalized.slice(firstIndex + oldText.length);
  const content = eol === "\r\n" ? replaced.replace(/\n/g, "\r\n") : replaced;
  if (content === source) throw new Error("edit_file produced no change");

  await writeFile(abs, content, "utf8");

  const oldLines = oldText.split("\n").length;
  const newLines = newText ? newText.split("\n").length : 0;
  const replacements = replaceAll ? count : 1;
  const change: FileChange = {
    path: rel,
    action: "update",
    added: newLines * replacements,
    removed: oldLines * replacements,
    hunks: replacements,
  };
  const summary = `Replaced ${replacements} occurrence${replacements === 1 ? "" : "s"} in ${rel} (line ${line})`;
  const data = { ok: true, path: rel, line, replacements, files: [change], summary };
  const before = Buffer.byteLength(source, "utf8") <= UNDO_MAX_BYTES ? source : undefined;
  return {
    text: json(data),
    structured: before !== undefined ? { ...data, files: [{ ...change, before }] } : data,
  };
}

/* ── move_file ──────────────────────────────────────────────────────── */

async function moveFileTool(root: string, args: Args): Promise<WorkspaceToolResult> {
  const fromRel = safeRel(arg(args, "from", "path", "oldPath", "old_path", "source"));
  const toRel = safeRel(arg(args, "to", "newPath", "new_path", "destination", "dest"));
  if (!fromRel || !toRel) throw new Error("move_file requires both 'from' and 'to' paths");
  if (fromRel === toRel) throw new Error("'from' and 'to' are the same path");

  const fromAbs = absInside(root, fromRel);
  const toAbs = absInside(root, toRel);
  await rejectSymlink(fromAbs, fromRel);
  await rejectSymlink(toAbs, toRel);

  const fromStat = await stat(fromAbs);
  if (!fromStat.isFile()) throw new Error(`Not a file: ${fromRel}`);
  const overwrite = arg(args, "overwrite", "force") === true;
  if (await exists(toAbs)) {
    if (!overwrite) throw new Error(`Destination already exists: ${toRel}. Set overwrite: true to replace it.`);
    await rejectSymlink(toAbs, toRel);
  }

  let before: string | undefined;
  try {
    const source = await readFile(fromAbs, "utf8");
    if (Buffer.byteLength(source, "utf8") <= UNDO_MAX_BYTES) before = source;
  } catch {
    before = undefined;
  }

  await mkdir(path.dirname(toAbs), { recursive: true });
  await rename(fromAbs, toAbs);

  const change = { path: toRel, from: fromRel, action: "move" as const, added: 0, removed: 0, hunks: 0 };
  const summary = `Moved ${fromRel} → ${toRel}`;
  const data = { ok: true, from: fromRel, to: toRel, files: [change], summary };
  const structuredChange = before !== undefined ? { ...change, before } : change;
  return { text: json(data), structured: { ...data, files: [structuredChange] } };
}

/* ── entry point ────────────────────────────────────────────────────── */

export async function executeWorkspaceTool(name: string, rawArgs: unknown, root: string): Promise<WorkspaceToolResult> {
  const toolName = name.replace(/^workspace__/, "");
  const args: Args = typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Args) : {};
  try {
    if (!root) throw new Error("No workspace is open. Ask the user to open a folder first.");
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
    switch (toolName) {
      case "list_files":
        return await listFiles(root, args);
      case "read_file":
        return await readFileTool(root, args);
      case "search":
        return await searchTool(root, args);
      case "project_info":
        return await projectInfoTool(root);
      case "edit_file":
        return await editFileTool(root, args);
      case "apply_patch":
        return await applyPatchTool(root, args);
      case "move_file":
        return await moveFileTool(root, args);
      default:
        return { text: `Error: Unknown workspace tool '${name}'`, isError: true, structured: { ok: false, error: "unknown tool" } };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `Error: ${message}`, isError: true, structured: { ok: false, error: message } };
  }
}
