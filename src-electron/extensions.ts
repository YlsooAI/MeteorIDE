import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, loadMcpServers, saveMcpServers, validateMcpServers, type McpServers } from "../src/config.js";

/**
 * Meteor extensions are declarative: a manifest that contributes MCP servers,
 * slash commands and extra instructions. No extension code runs inside the app;
 * anything executable is an MCP server, which the user confirms before install.
 * Format is documented in renderer/docs/extensions.html.
 */

export interface ExtensionCommand {
  name: string;
  description: string;
  prompt: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  mcpServers?: McpServers;
  commands?: ExtensionCommand[];
  instructions?: string;
}

export interface InstalledExtension extends ExtensionManifest {
  source: string;
  installedAt: number;
}

export const REGISTRY_URL = "https://raw.githubusercontent.com/YlsooAI/MeteorIDE/main/registry/extensions.json";
const RESERVED_COMMANDS = new Set(["clear", "new", "help", "model", "reasoning"]);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const COMMAND_RE = /^[a-z][a-z0-9-]{0,30}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function extensionsDir(): string {
  return join(configDir(), "extensions");
}

export function mcpKey(id: string, server: string): string {
  return `ext-${id}-${server}`;
}

function str(v: unknown, max: number, field: string, required = true): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`"${field}" is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`"${field}" must be a string`);
  if (v.length > max) throw new Error(`"${field}" is too long (max ${max} characters)`);
  return v;
}

/** Validate untrusted JSON and return a clean manifest. Throws a readable Error. */
export function validateManifest(input: unknown): ExtensionManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Manifest must be a JSON object");
  const m = input as Record<string, unknown>;

  const id = str(m.id, 40, "id")!;
  if (!ID_RE.test(id)) throw new Error('"id" must be 2-39 characters: lowercase letters, numbers and dashes, starting with a letter or number');
  const version = str(m.version, 32, "version")!;
  if (!SEMVER_RE.test(version)) throw new Error('"version" must look like 1.0.0');

  const out: ExtensionManifest = {
    id,
    name: str(m.name, 60, "name")!,
    version,
    description: str(m.description, 300, "description")!,
  };
  const author = str(m.author, 80, "author", false);
  if (author) out.author = author;
  const homepage = str(m.homepage, 200, "homepage", false);
  if (homepage) {
    if (!/^https:\/\//i.test(homepage)) throw new Error('"homepage" must be an https:// URL');
    out.homepage = homepage;
  }

  if (m.mcpServers !== undefined) {
    const res = validateMcpServers(m.mcpServers);
    if (!res.ok) throw new Error(`mcpServers: ${res.error}`);
    if (Object.keys(res.servers).length > 10) throw new Error("mcpServers: at most 10 servers per extension");
    if (Object.keys(res.servers).length) out.mcpServers = res.servers;
  }

  if (m.commands !== undefined) {
    if (!Array.isArray(m.commands)) throw new Error('"commands" must be an array');
    if (m.commands.length > 20) throw new Error('"commands": at most 20 commands per extension');
    const seen = new Set<string>();
    out.commands = m.commands.map((c, i) => {
      if (!c || typeof c !== "object") throw new Error(`commands[${i}] must be an object`);
      const cc = c as Record<string, unknown>;
      const name = str(cc.name, 31, `commands[${i}].name`)!;
      if (!COMMAND_RE.test(name)) throw new Error(`commands[${i}].name must be lowercase letters, numbers and dashes`);
      if (RESERVED_COMMANDS.has(name)) throw new Error(`commands[${i}].name "/${name}" is reserved by Meteor`);
      if (seen.has(name)) throw new Error(`commands[${i}].name "/${name}" is duplicated`);
      seen.add(name);
      return {
        name,
        description: str(cc.description, 120, `commands[${i}].description`)!,
        prompt: str(cc.prompt, 4000, `commands[${i}].prompt`)!,
      };
    });
    if (!out.commands.length) delete out.commands;
  }

  const instructions = str(m.instructions, 4000, "instructions", false);
  if (instructions) out.instructions = instructions;

  if (!out.mcpServers && !out.commands && !out.instructions) {
    throw new Error("An extension must contribute at least one of: mcpServers, commands, instructions");
  }
  return out;
}

/** Human-readable list of what installing this manifest will do (shown in the confirm dialog). */
export function describeManifest(m: ExtensionManifest): string {
  const lines: string[] = [];
  for (const [name, cfg] of Object.entries(m.mcpServers ?? {})) {
    const target = cfg.command ? `${cfg.command} ${(cfg.args ?? []).join(" ")}`.trim() : cfg.url ?? "(unknown)";
    lines.push(`• Adds MCP server "${name}" — runs: ${target}`);
  }
  for (const c of m.commands ?? []) lines.push(`• Adds slash command /${c.name}`);
  if (m.instructions) lines.push("• Adds instructions to every chat");
  return lines.join("\n");
}

export function listInstalled(): InstalledExtension[] {
  const dir = extensionsDir();
  if (!existsSync(dir)) return [];
  const out: InstalledExtension[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, entry.name, "meteor-extension.json"), "utf8"));
      const meta = JSON.parse(readFileSync(join(dir, entry.name, "install.json"), "utf8")) as { source?: string; installedAt?: number };
      const manifest = validateManifest(raw);
      if (manifest.id !== entry.name) continue;
      out.push({ ...manifest, source: meta.source ?? "unknown", installedAt: meta.installedAt ?? 0 });
    } catch {
      // skip broken installs
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function installExtension(input: unknown, source: string): InstalledExtension {
  const manifest = validateManifest(input);
  const dir = join(extensionsDir(), manifest.id);

  // replace any previous version cleanly (also drops its MCP servers)
  if (existsSync(dir)) uninstallExtension(manifest.id);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meteor-extension.json"), JSON.stringify(manifest, null, 2) + "\n");
  const installedAt = Date.now();
  writeFileSync(join(dir, "install.json"), JSON.stringify({ source, installedAt }, null, 2) + "\n");

  if (manifest.mcpServers) {
    const servers = { ...loadMcpServers() };
    for (const [name, cfg] of Object.entries(manifest.mcpServers)) servers[mcpKey(manifest.id, name)] = cfg;
    saveMcpServers(servers);
  }
  return { ...manifest, source, installedAt };
}

export function uninstallExtension(id: string): void {
  if (!ID_RE.test(id)) throw new Error("Invalid extension id");
  const dir = join(extensionsDir(), id);
  if (!existsSync(dir)) return;
  try {
    const manifest = validateManifest(JSON.parse(readFileSync(join(dir, "meteor-extension.json"), "utf8")));
    if (manifest.mcpServers) {
      const servers = { ...loadMcpServers() };
      for (const name of Object.keys(manifest.mcpServers)) delete servers[mcpKey(id, name)];
      saveMcpServers(servers);
    }
  } catch {
    // manifest unreadable — still remove the folder
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Parse a user-picked manifest file. */
export function parseManifestFile(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function fetchRegistry(bundledPath: string): Promise<{ entries: ExtensionManifest[]; source: "online" | "bundled"; error?: string }> {
  let error: string | undefined;
  try {
    const res = await fetch(REGISTRY_URL, { headers: { "User-Agent": "Meteor-Extensions" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { entries: cleanRegistry(await res.json()), source: "online" };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  try {
    return { entries: cleanRegistry(JSON.parse(readFileSync(bundledPath, "utf8"))), source: "bundled", error };
  } catch {
    return { entries: [], source: "bundled", error: error ?? "Registry unavailable" };
  }
}

function cleanRegistry(json: unknown): ExtensionManifest[] {
  const list = (json as { extensions?: unknown[] })?.extensions;
  if (!Array.isArray(list)) throw new Error("Registry has no extensions array");
  const out: ExtensionManifest[] = [];
  for (const item of list) {
    try {
      out.push(validateManifest(item));
    } catch {
      // ignore invalid registry entries instead of failing the whole store
    }
  }
  return out;
}
