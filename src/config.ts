import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Embedded keys for distributed builds (.exe/.dmg) — users will use our keys
export const EMBEDDED_API_KEY = "sk-qgeusPXxBRNxeblGvbMbFETpNJzZc3MFl7zO6dARiB694CwDvxDhzaXVfhN2Jx1c";
export const EMBEDDED_MERCURY_KEY = "sk_5766b0857b05f8b35566ffc42e55e7bc";
export const EMBEDDED_BROWSERBASE_API_KEY = "bb_live_MXTt6FP2BJ5RKgtOr4gezAvQL2g";
export const EMBEDDED_SUPABASE_URL = "https://ikjugnimawkoatkbvpgk.supabase.co";
export const EMBEDDED_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlranVnbmltYXdrb2F0a2J2cGdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwNzI3OTAsImV4cCI6MjA5NTY0ODc5MH0.xr9B_khj2zKIEoUsTisL66SGgn8Yo2K0YH5YDw0QmQw";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: "stdio" | "sse" | "http" | "streamable-http";
  disabled?: boolean;
  cwd?: string;
  headers?: Record<string, string>;
  [k: string]: unknown;
}

export type McpServers = Record<string, McpServerConfig>;

export interface MeteorConfig {
  apiKey?: string;
  mercuryKey?: string;
  browserbaseApiKey?: string;
  defaultModel?: string;
  mcpServers?: McpServers;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "meteor") : join(homedir(), ".config", "meteor");
}

function configFile(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): MeteorConfig {
  try {
    if (existsSync(configFile())) {
      return JSON.parse(readFileSync(configFile(), "utf8")) as MeteorConfig;
    }
  } catch {}
  return {};
}

export function saveConfig(update: Partial<MeteorConfig>): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const merged = { ...loadConfig(), ...update };
  writeFileSync(configFile(), JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
}

export function clearApiKey(): boolean {
  if (!existsSync(configFile())) return false;
  const cfg = loadConfig();
  delete cfg.apiKey;
  writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return true;
}

export function resetConfig(): boolean {
  if (!existsSync(configFile())) return false;
  rmSync(configFile());
  return true;
}

export function resolveApiKey(cliKey?: string): string | undefined {
  return (
    cliKey ??
    process.env.METEOR_API_KEY ??
    process.env.OPENCODE_API_KEY ??
    loadConfig().apiKey ??
    EMBEDDED_API_KEY
  );
}

export function resolveMercuryKey(cliKey?: string): string | undefined {
  return (
    cliKey ??
    process.env.MERCURY_API_KEY ??
    loadConfig().mercuryKey ??
    EMBEDDED_MERCURY_KEY
  );
}

export function resolveBrowserbaseKey(cliKey?: string): string | undefined {
  return (
    cliKey ??
    process.env.BROWSERBASE_API_KEY ??
    process.env.BROWSERBASE_KEY ??
    loadConfig().browserbaseApiKey ??
    EMBEDDED_BROWSERBASE_API_KEY
  );
}

export function saveBrowserbaseKey(key: string): void {
  saveConfig({ browserbaseApiKey: key });
}

export function isUsingFreeTier(cliKey?: string, provider?: string): boolean {
  if (cliKey) return false;
  if (provider === "mercury") {
    if (process.env.MERCURY_API_KEY) return false;
    const cfg = loadConfig();
    return !cfg.mercuryKey;
  }
  if (process.env.METEOR_API_KEY || process.env.OPENCODE_API_KEY) return false;
  const cfg = loadConfig();
  return !cfg.apiKey;
}

export function loadMcpServers(): McpServers {
  return loadConfig().mcpServers ?? {};
}

export function saveMcpServers(servers: McpServers): void {
  saveConfig({ mcpServers: servers });
}

export function validateMcpServers(input: unknown): { ok: true; servers: McpServers } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "MCP config must be an object" };
  }
  const raw = input as Record<string, unknown>;
  // Support both { mcpServers: {...} } and direct { serverName: config }
  const serversRaw: Record<string, unknown> = raw.mcpServers && typeof raw.mcpServers === "object" && !Array.isArray(raw.mcpServers)
    ? (raw.mcpServers as Record<string, unknown>)
    : raw;

  const servers: McpServers = {};
  for (const [name, cfg] of Object.entries(serversRaw)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return { ok: false, error: `Invalid server name "${name}": use letters, numbers, dash, underscore` };
    }
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
      return { ok: false, error: `Server "${name}" must be an object` };
    }
    const c = cfg as Record<string, unknown>;
    const out: McpServerConfig = {};
    if (c.command !== undefined) {
      if (typeof c.command !== "string" || !c.command.trim()) return { ok: false, error: `Server "${name}" command must be a non-empty string` };
      out.command = c.command.trim();
    }
    if (c.args !== undefined) {
      if (!Array.isArray(c.args) || !c.args.every((a) => typeof a === "string")) return { ok: false, error: `Server "${name}" args must be string array` };
      out.args = c.args as string[];
    }
    if (c.env !== undefined) {
      if (typeof c.env !== "object" || c.env === null || Array.isArray(c.env)) return { ok: false, error: `Server "${name}" env must be object` };
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
        if (typeof v !== "string") return { ok: false, error: `Server "${name}" env.${k} must be string` };
        env[k] = v;
      }
      out.env = env;
    }
    if (c.url !== undefined) {
      if (typeof c.url !== "string" || !c.url.trim()) return { ok: false, error: `Server "${name}" url must be non-empty string` };
      try { new URL(c.url); } catch { return { ok: false, error: `Server "${name}" url is not a valid URL` }; }
      out.url = c.url.trim();
    }
    if (c.type !== undefined) {
      const allowed = ["stdio", "sse", "http", "streamable-http"];
      if (typeof c.type !== "string" || !allowed.includes(c.type)) return { ok: false, error: `Server "${name}" type must be one of ${allowed.join(", ")}` };
      out.type = c.type as McpServerConfig["type"];
    }
    if (c.disabled !== undefined) {
      if (typeof c.disabled !== "boolean") return { ok: false, error: `Server "${name}" disabled must be boolean` };
      out.disabled = c.disabled;
    }
    if (c.cwd !== undefined) {
      if (typeof c.cwd !== "string") return { ok: false, error: `Server "${name}" cwd must be string` };
      out.cwd = c.cwd;
    }
    if (c.headers !== undefined) {
      if (typeof c.headers !== "object" || c.headers === null || Array.isArray(c.headers)) return { ok: false, error: `Server "${name}" headers must be object` };
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.headers as Record<string, unknown>)) {
        if (typeof v !== "string") return { ok: false, error: `Server "${name}" headers.${k} must be string` };
        headers[k] = v;
      }
      out.headers = headers;
    }
    // Infer type if not set
    if (!out.type) {
      out.type = out.url ? "sse" : "stdio";
    }
    // Require command for stdio, url for sse/http
    if (out.type === "stdio" && !out.command) {
      return { ok: false, error: `Server "${name}" (stdio) requires "command"` };
    }
    if ((out.type === "sse" || out.type === "http" || out.type === "streamable-http") && !out.url) {
      return { ok: false, error: `Server "${name}" (${out.type}) requires "url"` };
    }
    // preserve unknown extras? we already copied known; allow passthrough for others except mcpServers wrapper
    for (const [k, v] of Object.entries(c)) {
      if (!(k in out)) (out as Record<string, unknown>)[k] = v;
    }
    servers[name] = out;
  }
  return { ok: true, servers };
}
