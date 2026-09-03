import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import { loadMcpServers, type McpServerConfig } from "../src/config.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  server: string;
  serverConfig: McpServerConfig;
}

export interface McpToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  raw?: unknown;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

class StdioMcpConnection {
  proc: ChildProcessWithoutNullStreams;
  pending = new Map<number, Pending>();
  nextId = 1;
  buffer = "";
  initialized = false;
  cwd: string;
  env: Record<string, string>;

  constructor(
    public name: string,
    public config: McpServerConfig,
    cwdHint: string,
  ) {
    const cwd = config.cwd ? path.resolve(config.cwd.replace(/^~/, os.homedir())) : cwdHint;
    const env = { ...process.env, ...(config.env ?? {}) } as Record<string, string>;
    this.cwd = cwd;
    this.env = env;
    const cmd = config.command!;
    const args = config.args ?? [];
    this.proc = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.proc.stdout.on("data", (d) => this.onData(d.toString()));
    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (err) => this.rejectAll(err));
    this.proc.on("exit", (code) => {
      const err = new Error(`MCP server "${name}" exited with ${code}`);
      this.rejectAll(err);
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const obj = msg as { id?: number; result?: unknown; error?: unknown };
      if (typeof obj.id === "number" && this.pending.has(obj.id)) {
        const p = this.pending.get(obj.id)!;
        clearTimeout(p.timer);
        this.pending.delete(obj.id);
        if (obj.error) {
          p.reject(new Error(typeof obj.error === "object" ? JSON.stringify(obj.error) : String(obj.error)));
        } else {
          p.resolve(obj.result ?? obj);
        }
      }
    }
  }

  private rejectAll(err: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private request(method: string, params?: unknown, timeoutMs = 8000): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout ${method} on ${this.name} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(payload);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private notify(method: string, params?: unknown) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try {
      this.proc.stdin.write(payload);
    } catch {}
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "meteor", version: app.getVersion() },
      }, 8000);
    } catch (e) {
      // handshake failed — kill so we don't reuse a wedged process
      this.kill();
      throw e;
    }
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    const res = (await this.request("tools/list", {}, 8000)) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    const tools = res.tools ?? [];
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      server: this.name,
      serverConfig: this.config,
    }));
  }

  async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
    await this.initialize();
    try {
      const res = (await this.request("tools/call", { name, arguments: args ?? {} }, 15000)) as McpToolCallResult;
      return res;
    } catch (e) {
      // server is wedged or died — kill it so the next call spawns a fresh process
      this.kill();
      throw e;
    }
  }

  kill() {
    try {
      this.proc.kill("SIGTERM");
    } catch {}
    this.rejectAll(new Error(`MCP server "${this.name}" killed`));
  }
}

async function httpMcpRequest(cfg: McpServerConfig, method: string, params?: unknown, timeoutMs = 8000): Promise<unknown> {
  const url = cfg.url!;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(cfg.headers ?? {}),
  };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    // Try to parse as JSON-RPC, or SSE
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
      if (!payload) continue;
      try {
        const obj = JSON.parse(payload) as { result?: unknown; error?: unknown };
        if (obj.error) throw new Error(typeof obj.error === "object" ? JSON.stringify(obj.error) : String(obj.error));
        if (obj.result !== undefined) return obj.result;
        return obj;
      } catch {}
    }
    try {
      const obj = JSON.parse(text) as { result?: unknown; error?: unknown };
      if (obj.error) throw new Error(typeof obj.error === "object" ? JSON.stringify(obj.error) : String(obj.error));
      return obj.result ?? obj;
    } catch {
      throw new Error(`Invalid response from ${url}: ${text.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(t);
  }
}

const stdioConnections = new Map<string, StdioMcpConnection>();

function getStdioConnection(name: string, cfg: McpServerConfig, cwdHint: string): StdioMcpConnection {
  const existing = stdioConnections.get(name);
  if (existing && !existing.proc.killed && existing.proc.exitCode === null) return existing;
  if (existing) {
    try { existing.kill(); } catch {}
    stdioConnections.delete(name);
  }
  const conn = new StdioMcpConnection(name, cfg, cwdHint);
  stdioConnections.set(name, conn);
  return conn;
}

export async function listMcpTools(cwdHint: string): Promise<McpTool[]> {
  const servers = loadMcpServers();
  const all: McpTool[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.disabled) continue;
    const type = cfg.type ?? (cfg.url ? "sse" : "stdio");
    try {
      if (type === "stdio") {
        const conn = getStdioConnection(name, cfg, cwdHint);
        const tools = await conn.listTools();
        all.push(...tools);
      } else {
        // http: we need to initialize first via http
        // Try tools/list directly
        const res = (await httpMcpRequest(cfg, "tools/list", {}, 8000)) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
        const tools = res.tools ?? [];
        for (const t of tools) {
          all.push({ name: t.name, description: t.description, inputSchema: t.inputSchema, server: name, serverConfig: cfg });
        }
      }
    } catch (err) {
      // Silently skip failing servers for tool listing
      console.warn(`[mcp] listTools failed for ${name}:`, err instanceof Error ? err.message : String(err));
    }
  }
  return all;
}

export async function callMcpTool(server: string, toolName: string, args: unknown, cwdHint: string): Promise<McpToolCallResult> {
  const servers = loadMcpServers();
  const cfg = servers[server];
  if (!cfg) throw new Error(`MCP server "${server}" not found`);
  if (cfg.disabled) throw new Error(`MCP server "${server}" is disabled`);
  const type = cfg.type ?? (cfg.url ? "sse" : "stdio");
  if (type === "stdio") {
    const conn = getStdioConnection(server, cfg, cwdHint);
    return conn.callTool(toolName, args);
  } else {
    const res = (await httpMcpRequest(cfg, "tools/call", { name: toolName, arguments: args ?? {} }, 15000)) as McpToolCallResult;
    return res;
  }
}

export function killAllMcp() {
  for (const [, conn] of stdioConnections) {
    try { conn.kill(); } catch {}
  }
  stdioConnections.clear();
}

export function getMcpServerStatus(name: string): { state: "connected" | "disconnected"; pid?: number } {
  const conn = stdioConnections.get(name);
  if (!conn) return { state: "disconnected" };
  if (conn.proc.killed || conn.proc.exitCode !== null) return { state: "disconnected" };
  return { state: "connected", pid: conn.proc.pid };
}
