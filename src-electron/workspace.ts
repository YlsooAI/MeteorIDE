import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceFile {
  /** Path relative to the workspace root, always with "/" separators. */
  path: string;
  size: number;
  /** File text, or null when the content was skipped (binary, lockfile, too large). */
  content: string | null;
  skipReason?: "binary" | "too-large" | "lockfile";
}

export interface WorkspaceScan {
  root: string;
  name: string;
  files: WorkspaceFile[];
  truncated: boolean;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".output",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".idea",
  ".vscode",
  "target",
  "vendor",
  "Pods",
  ".gradle",
  ".terraform",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);

const MAX_FILES = 4000;
const MAX_DEPTH = 20;
const MAX_FILE_BYTES = 256 * 1024;

const toRel = (root: string, abs: string): string =>
  path.relative(root, abs).split(path.sep).join("/");

export async function scanWorkspace(rootInput: string): Promise<WorkspaceScan> {
  const root = path.resolve(rootInput);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${root}`);

  const files: WorkspaceFile[] = [];
  let truncated = false;

  const walk = async (dirRel: string, depth: number): Promise<void> => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    if (depth > MAX_DEPTH) return;
    const entries = await readdir(dirRel ? path.join(root, dirRel) : root, { withFileTypes: true });
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(rel, depth + 1);
      } else if (entry.isFile()) {
        if (entry.name === ".DS_Store" || entry.name.endsWith(".pyc")) continue;
        const abs = path.join(root, rel);
        const st = await stat(abs);
        if (LOCKFILES.has(entry.name)) {
          files.push({ path: rel, size: st.size, content: null, skipReason: "lockfile" });
          continue;
        }
        if (st.size > MAX_FILE_BYTES) {
          files.push({ path: rel, size: st.size, content: null, skipReason: "too-large" });
          continue;
        }
        let content: string;
        try {
          content = await readFile(abs, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\u0000")) {
          files.push({ path: rel, size: st.size, content: null, skipReason: "binary" });
          continue;
        }
        files.push({ path: rel, size: content.length, content });
      }
    }
  };

  await walk("", 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, name: path.basename(root), files, truncated };
}

export async function writeFileInWorkspace(
  rootInput: string,
  relPath: string,
  content: string,
): Promise<string> {
  const root = path.resolve(rootInput);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Refusing to write outside the workspace root");
  }
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return toRel(root, abs);
}
