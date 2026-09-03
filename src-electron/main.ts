import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { MODELS, DEFAULT_MODEL, resolveModel, REASONING_EFFORTS } from "../src/models.js";
import { complete, ZenError, type Message } from "../src/zen.js";
import { loadMcpServers, saveMcpServers, validateMcpServers, type McpServerConfig } from "../src/config.js";
import { resolveApiKey } from "../src/config.js";
import { scanWorkspace, writeFileInWorkspace } from "./workspace.js";
import { authSignUp, authSignIn, authSignOut, authGetSession, authGetUser, isSupabaseConfigured, getProfileAvatar, getProfile, listProjects, createProject, getProject, updateProject, deleteProject, saveProjectMessages, loadProjectMessages } from "./supabase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#0d0f13",
    title: "Meteor",
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "src-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("meteor:info", async () => {
  const sess = await authGetSession().catch(() => ({ session: null, user: null, isMock: true, isConfigured: false }));
  return {
    version: app.getVersion(),
    defaultModel: DEFAULT_MODEL,
    hasKey: Boolean(resolveApiKey()),
    keySource: process.env.METEOR_API_KEY ? "environment" : "config",
    models: Object.values(MODELS).map((m) => ({
      key: m.key,
      name: m.name,
      description: m.description,
    })),
    auth: {
      isAuthenticated: Boolean(sess.user),
      user: sess.user ? { id: sess.user.id, email: sess.user.email } : null,
      isMock: (sess as { isMock?: boolean }).isMock ?? true,
      isConfigured: (sess as { isConfigured?: boolean }).isConfigured ?? false,
    },
    supabaseConfigured: isSupabaseConfigured(),
  };
});

// ── Auth ─────────────────────────────────────────────────────────────
ipcMain.handle("auth:signUp", async (_e, { email, password }: { email: string; password: string }) => {
  const { user, session } = await authSignUp(email, password);
  return { user: user ? { id: user.id, email: user.email } : null, session: Boolean(session) };
});
ipcMain.handle("auth:signIn", async (_e, { email, password }: { email: string; password: string }) => {
  const { user, session } = await authSignIn(email, password);
  return { user: user ? { id: user.id, email: user.email } : null, session: Boolean(session) };
});
ipcMain.handle("auth:signOut", async () => {
  await authSignOut();
  return { ok: true };
});
ipcMain.handle("auth:getSession", async () => {
  const { session, user, isMock, isConfigured } = await authGetSession();
  return { isAuthenticated: Boolean(user), user: user ? { id: user.id, email: user.email } : null, isMock, isConfigured };
});
ipcMain.handle("auth:getUser", async () => {
  const user = await authGetUser();
  return user ? { id: user.id, email: user.email } : null;
});
ipcMain.handle("auth:isConfigured", () => ({ configured: isSupabaseConfigured() }));
ipcMain.handle("profile:get", async () => {
  try {
    const user = await authGetUser();
    if (!user) return { avatarUrl: null, fullName: null };
    // try combined profile (avatar + full_name), fallback to avatar only
    try {
      const prof = await getProfile(user.id);
      if (prof.avatarUrl || prof.fullName) return prof;
    } catch {}
    const avatarUrl = await getProfileAvatar(user.id);
    const fullName = (user.user_metadata as { full_name?: string })?.full_name || (user.user_metadata as { fullName?: string })?.fullName || null;
    return { avatarUrl, fullName };
  } catch { return { avatarUrl: null, fullName: null }; }
});

// ── Projects (meteor_projects) ───────────────────────────────────────
ipcMain.handle("projects:list", async () => {
  try { return await listProjects(); } catch (e) { throw new Error(e instanceof Error ? e.message : String(e)); }
});
ipcMain.handle("projects:create", async (_e, payload: { name: string; folder_path: string; last_message?: string }) => {
  if (!payload?.name || !payload?.folder_path) throw new Error("name and folder_path required");
  return await createProject(payload);
});
ipcMain.handle("projects:get", async (_e, payload: { id: string }) => {
  if (!payload?.id) throw new Error("id required");
  return await getProject(payload.id);
});
ipcMain.handle("projects:update", async (_e, payload: { id: string; updates: Partial<{ name: string; folder_path: string; last_message: string; preview: string; message_count: number }> }) => {
  if (!payload?.id) throw new Error("id required");
  return await updateProject(payload.id, payload.updates);
});
ipcMain.handle("projects:delete", async (_e, payload: { id: string }) => {
  if (!payload?.id) throw new Error("id required");
  await deleteProject(payload.id);
  return { ok: true };
});
ipcMain.handle("projects:saveMessages", async (_e, payload: { projectId: string; messages: Array<{ role: string; content: unknown }> }) => {
  if (!payload?.projectId) throw new Error("projectId required");
  await saveProjectMessages(payload.projectId, payload.messages || []);
  return { ok: true };
});
ipcMain.handle("projects:loadMessages", async (_e, payload: { projectId: string }) => {
  if (!payload?.projectId) throw new Error("projectId required");
  return await loadProjectMessages(payload.projectId);
});

ipcMain.handle("project:generateTitle", async (_e, payload: { projectId: string; firstMessage?: string; firstResponse?: string }) => {
  if (!payload?.projectId) throw new Error("projectId required");
  const proj = await getProject(payload.projectId);
  if (!proj) throw new Error("Project not found");
  const user = await authGetUser();
  if (!user || proj.user_id !== user.id) throw new Error("Not authorized");
  // already has a custom title that isn't just folder name? skip if looks like AI title already
  const isGeneric = proj.name === proj.folder_path.split("/").pop() || proj.name === "Untitled" || !proj.name;
  // Build prompt for Sunlight 2 Pro
  const firstMsg = (payload.firstMessage || proj.last_message || "").slice(0, 800);
  const firstResp = (payload.firstResponse || "").slice(0, 800);
  const prompt = `Generate a short, concise chat title (3-6 words, no quotes, no period, Title Case, PLAIN TEXT ONLY — no markdown, no # symbols, no bold) that summarizes this conversation. Return ONLY the title, nothing else.\n\nUser: ${firstMsg}\n${firstResp ? `Assistant: ${firstResp}` : ""}`;
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error("No API key for title generation");
  const proModel = resolveModel("sunlight-2-pro");
  try {
    const result = await complete({
      apiKey,
      apiModel: proModel.apiModel,
      protocol: proModel.protocol,
      messages: [
        { role: "system", content: "You are a title generator. Respond with only the title, 3-6 words, no quotes." } as Message,
        { role: "user", content: prompt } as Message,
      ],
      stream: false,
      reasoningEffort: "low",
    });
    let title = (result.text || "").trim();
    // sanitize: strip markdown (## headings, **bold**, *italic*), quotes, newlines, trailing period, limit length
    title = title.replace(/^#{1,6}\s+/, "").replace(/^\*{1,3}\s*|\s*\*{1,3}$/g, "").replace(/^_{1,3}\s*|\s*_{1,3}$/g, "");
    title = title.replace(/^["'`\s]+|["'`\s]+$/g, "").replace(/\n.*$/s, "").replace(/[.]+$/g, "").trim();
    title = title.split(/\s+/).slice(0, 6).join(" ");
    if (title.length > 60) title = title.slice(0, 60).trim();
    if (!title || title.length < 3) throw new Error("Empty title");
    // Title Case normalization
    title = title.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const updated = await updateProject(payload.projectId, { name: title });
    return { title, project: updated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Title generation failed: ${msg}`);
  }
});

let mcpToolsCache: { tools: Array<{ server: string; name: string; description?: string; inputSchema?: unknown }>; at: number; cwd: string } | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

ipcMain.handle(
  "meteor:complete",
  async (event, payload: { id: string; modelKey?: string; reasoningEffort?: string; messages: Message[]; apiKey?: string }) => {
    const { id } = payload;
    const send = (channel: string, data?: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(`${channel}:${id}`, data);
    };
    // hard guarantee: never leave the renderer busy forever
    let settled = false;
    const overallWatchdog = setTimeout(() => {
      if (!settled) { settled = true; send("meteor:error", "Request timed out (15 min limit). Try again or check your MCP servers."); }
    }, 15 * 60 * 1000);
    const finish = () => { if (!settled) { settled = true; clearTimeout(overallWatchdog); } };
    try {
      const model = resolveModel(payload.modelKey ?? DEFAULT_MODEL);
      const apiKey = resolveApiKey(payload.apiKey);
      if (!apiKey) throw new Error("No API key found. Run `meteor auth set <key>` in the terminal or set METEOR_API_KEY.");
      // gate: must be authenticated via Supabase (or mock) before using Meteor
      const authSess = await authGetSession().catch(() => ({ user: null }));
      if (!authSess.user) throw new Error("Not authenticated — please sign in to use Meteor.");
      const allowed: string[] = [...REASONING_EFFORTS];
      const reasoningEffort = payload.reasoningEffort && allowed.includes(payload.reasoningEffort) ? payload.reasoningEffort : undefined;
      // ── MCP: only expose tools if user explicitly mentions them ──
      // Checks last user message for "mcp", "@", "tool" or any configured server name.
      // This prevents the model from auto-calling MCP on every turn.
      function getLastUserText(msgs: Message[]): string {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "user") {
            const c = msgs[i].content as unknown;
            if (typeof c === "string") return c;
            if (Array.isArray(c)) return (c as Array<{ text?: string }>).map(p => p.text || "").join(" ");
            return String(c ?? "");
          }
        }
        return "";
      }
      function mentionsMcp(text: string, serverNames: string[]): boolean {
        if (!text) return false;
        const low = text.toLowerCase();
        if (low.includes("mcp") || text.includes("@") || low.includes("use tool") || low.includes("call tool") || low.includes("use mcp")) return true;
        for (const n of serverNames) if (n && low.includes(n.toLowerCase())) return true;
        return false;
      }
      let mcpTools: Array<{ server: string; name: string; description?: string; inputSchema?: unknown }> = [];
      try {
        const lastText = getLastUserText(payload.messages as Message[]);
        const servers = loadMcpServers();
        const serverNames = Object.keys(servers);
        const shouldExpose = mentionsMcp(lastText, serverNames);
        if (shouldExpose) {
          // cache tool list for 5 min per cwd — avoids re-spawning/listing servers every turn
          const now = Date.now();
          if (mcpToolsCache && now - mcpToolsCache.at < 300000 && mcpToolsCache.cwd === termCwd) {
            mcpTools = mcpToolsCache.tools;
          } else {
            const { listMcpTools } = await import("./mcp-client.js");
            mcpTools = await withTimeout(listMcpTools(termCwd), 25000, "Listing MCP tools");
            mcpToolsCache = { tools: mcpTools, at: now, cwd: termCwd };
          }
          // double-check with discovered tool names for edge cases where user typed exact tool name
          if (mcpTools.length > 0) {
            const toolNames = mcpTools.map(t => t.name);
            const stillMentioned = mentionsMcp(lastText, [...serverNames, ...toolNames]) || serverNames.length === 0;
            if (!stillMentioned) mcpTools = [];
            else send("meteor:tool_info", { count: mcpTools.length, tools: mcpTools.map((t) => ({ server: t.server, name: t.name })) });
          }
        } else {
          // no mention -> keep mcpTools empty so model can't auto-call
        }
      } catch (e) {
        send("meteor:tool_info", { count: 0, tools: [], error: e instanceof Error ? e.message : String(e) });
      }
      const toolDefs = mcpTools;
      let messages: any[] = [...payload.messages];
      let finalText = "";
      let finalReasoning = "";
      // Tool loop — up to 6 iterations
      for (let iter = 0; iter < 6; iter++) {
        const result = await complete({
          apiKey,
          apiModel: model.apiModel,
          protocol: model.protocol,
          messages,
          stream: true,
          reasoningEffort,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          onDelta: (text) => send("meteor:chunk", text),
          onReasoningDelta: (text) => send("meteor:reasoning", text),
          onToolCallDelta: (delta) => send("meteor:tool_delta", delta),
        });
        finalText = result.text;
        if (result.reasoning) finalReasoning = finalReasoning ? finalReasoning + "\n" + result.reasoning : result.reasoning;
        if (result.toolCalls.length === 0) break;
        // Notify renderer of tool calls
        for (const tc of result.toolCalls) {
          send("meteor:tool_call", { id: tc.id, server: tc.server, tool: tc.toolName, name: tc.name, arguments: tc.arguments, parsedArgs: tc.parsedArgs });
        }
        // Execute MCP tools (each capped at 60s so a wedged server can't freeze the chat)
        const { callMcpTool } = await import("./mcp-client.js");
        const toolResults: Array<{ tool_call_id: string; content: string }> = [];
        for (const tc of result.toolCalls) {
          try {
            const res = await withTimeout(callMcpTool(tc.server, tc.toolName, tc.parsedArgs ?? {}, termCwd), 60000, `Tool ${tc.server}.${tc.toolName}`);
            const text = (res.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n") || JSON.stringify(res, null, 2);
            toolResults.push({ tool_call_id: tc.id, content: text });
            send("meteor:tool_result", { id: tc.id, server: tc.server, tool: tc.toolName, result: text, isError: !!res.isError });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toolResults.push({ tool_call_id: tc.id, content: `Error: ${msg}` });
            send("meteor:tool_result", { id: tc.id, server: tc.server, tool: tc.toolName, result: msg, isError: true });
          }
        }
        // Append assistant tool_calls + tool results for next iteration
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text || "",
            tool_calls: result.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })),
          } as unknown as Message,
          ...toolResults.map((tr) => ({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content } as unknown as Message)),
        ];
        // If model returned tool calls but no text, continue loop to get final answer
        if (iter === 5) break;
      }
      send("meteor:done", { text: finalText, reasoning: finalReasoning || undefined });
      finish();
    } catch (err) {
      const msg =
        err instanceof ZenError && err.status === 401
          ? "Unauthorized — check your API key"
          : err instanceof Error
            ? err.message
            : String(err);
      send("meteor:error", msg);
      finish();
    }
  },
);

let termCwd = process.cwd();
let currentTermProc: ChildProcessWithoutNullStreams | null = null;

ipcMain.handle("workspace:open", async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win as unknown as BrowserWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "Open folder as workspace",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const scan = await scanWorkspace(result.filePaths[0]);
  termCwd = scan.root;
  return scan;
});

ipcMain.handle("workspace:refresh", (_e, root: string) => scanWorkspace(root));

ipcMain.handle(
  "workspace:writeFile",
  (_e, args: { root: string; relPath: string; content: string }) =>
    writeFileInWorkspace(args.root, args.relPath, args.content),
);

ipcMain.handle("dialog:openFile", async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win as unknown as BrowserWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Code", extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "py", "go", "rs", "html", "css", "txt", "sh", "yml", "yaml", "toml"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const content = await readFile(filePath, "utf8");
  return { filePath, content };
});

ipcMain.handle("dialog:saveFile", async (_e, args: { content: string; filePath?: string }) => {
  let filePath = args.filePath;
  if (!filePath) {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win as unknown as BrowserWindow, {
      filters: [{ name: "Code", extensions: ["ts", "js", "json", "md", "py", "html", "css", "txt"] }],
    });
    if (result.canceled || !result.filePath) return null;
    filePath = result.filePath;
  }
  await writeFile(filePath, args.content, "utf8");
  return { filePath };
});

ipcMain.handle("term:getCwd", () => termCwd);
ipcMain.handle("term:getInfo", () => ({
  cwd: termCwd,
  home: os.homedir(),
  user: os.userInfo().username,
  host: os.hostname().split(".")[0],
}));

ipcMain.handle("term:exec", async (event, { id, cmd }: { id: string; cmd: string }) => {
  const send = (ch: string, data: unknown) => {
    if (!event.sender.isDestroyed()) event.sender.send(`${ch}:${id}`, data);
  };
  const trimmed = cmd.trim();
  if (!trimmed) {
    send("term:exit", 0);
    return;
  }
  if (trimmed === "clear" || trimmed === "cls") {
    send("term:clear", null);
    send("term:exit", 0);
    return;
  }
  if (trimmed.startsWith("cd")) {
    const target = trimmed.slice(2).trim();
    const dest = target ? path.resolve(termCwd, target.replace(/^~/, os.homedir())) : os.homedir();
    try {
      const st = await import("node:fs/promises").then((m) => m.stat(dest));
      if (!st.isDirectory()) throw new Error("Not a directory");
      termCwd = dest;
      send("term:exit", 0);
    } catch (e) {
      send("term:data", `cd: ${e instanceof Error ? e.message : String(e)}: ${dest}\r\n`);
      send("term:exit", 1);
    }
    return;
  }

  const proc = spawn(trimmed, {
    cwd: termCwd,
    shell: true,
    env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1" },
  });
  currentTermProc = proc;

  proc.stdout.on("data", (d) => send("term:data", d.toString()));
  proc.stderr.on("data", (d) => send("term:data", d.toString()));
  proc.on("close", (code) => {
    currentTermProc = null;
    send("term:exit", code ?? 0);
  });
  proc.on("error", (err) => {
    currentTermProc = null;
    send("term:data", err.message + "\r\n");
    send("term:exit", 1);
  });
});

ipcMain.handle("term:kill", async (event, { id }: { id: string }) => {
  if (currentTermProc && !currentTermProc.killed) {
    currentTermProc.kill("SIGINT");
  }
  if (!event.sender.isDestroyed()) event.sender.send(`term:exit:${id}`, 130);
});

// ── MCP ────────────────────────────────────────────────────────────────
const MCP_CONNECT_TIMEOUT = 12000;
const mcpStatus = new Map<string, { state: "connected" | "disconnected" | "error"; error?: string; at: number }>();

ipcMain.handle("mcp:get", () => {
  const servers = loadMcpServers();
  const withStatus = Object.fromEntries(
    Object.entries(servers).map(([name, cfg]) => [
      name,
      { config: cfg, status: mcpStatus.get(name) ?? { state: "disconnected" as const, at: 0 } },
    ]),
  );
  return { servers, withStatus };
});

ipcMain.handle("mcp:save", (_e, payload: { servers: Record<string, McpServerConfig> }) => {
  const res = validateMcpServers(payload.servers);
  if (!res.ok) throw new Error(res.error);
  saveMcpServers(res.servers);
  // mark changed servers as disconnected until re-tested
  for (const name of Object.keys(res.servers)) {
    if (!mcpStatus.has(name)) mcpStatus.set(name, { state: "disconnected", at: 0 });
  }
  for (const name of [...mcpStatus.keys()]) {
    if (!(name in res.servers)) mcpStatus.delete(name);
  }
  return { servers: res.servers };
});

ipcMain.handle("mcp:saveJson", (_e, payload: { jsonText: string }) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.jsonText);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const res = validateMcpServers(parsed);
  if (!res.ok) throw new Error(res.error);
  saveMcpServers(res.servers);
  for (const name of Object.keys(res.servers)) {
    if (!mcpStatus.has(name)) mcpStatus.set(name, { state: "disconnected", at: 0 });
  }
  for (const name of [...mcpStatus.keys()]) {
    if (!(name in res.servers)) mcpStatus.delete(name);
  }
  return { servers: res.servers };
});

ipcMain.handle("mcp:test", async (_e, payload: { name: string }) => {
  const servers = loadMcpServers();
  const cfg = servers[payload.name];
  if (!cfg) throw new Error(`MCP server "${payload.name}" not found`);
  if (cfg.disabled) throw new Error(`Server "${payload.name}" is disabled`);
  const type = cfg.type ?? (cfg.url ? "sse" : "stdio");
  try {
    if (type === "stdio") {
      // Test stdio: spawn command with args, expect process to stay alive briefly, handle MCP handshake minimally
      await testStdioMcp(cfg);
    } else {
      await testHttpMcp(cfg);
    }
    mcpStatus.set(payload.name, { state: "connected", at: Date.now() });
    return { ok: true as const, name: payload.name };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    mcpStatus.set(payload.name, { state: "error", error: msg, at: Date.now() });
    throw new Error(msg);
  }
});

ipcMain.handle("mcp:disconnect", (_e, payload: { name: string }) => {
  mcpStatus.set(payload.name, { state: "disconnected", at: Date.now() });
  return { ok: true };
});

ipcMain.handle("mcp:validate", (_e, payload: { jsonText: string }) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.jsonText);
  } catch (err) {
    return { ok: false as const, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const res = validateMcpServers(parsed);
  if (!res.ok) return { ok: false as const, error: res.error };
  return { ok: true as const, servers: res.servers, count: Object.keys(res.servers).length };
});

ipcMain.handle("mcp:listTools", async () => {
  const { listMcpTools } = await import("./mcp-client.js");
  return listMcpTools(termCwd);
});

ipcMain.handle("mcp:callTool", async (_e, payload: { server: string; tool: string; args?: unknown }) => {
  const { callMcpTool } = await import("./mcp-client.js");
  return callMcpTool(payload.server, payload.tool, payload.args ?? {}, termCwd);
});

ipcMain.handle("git:status", async () => {
  if (!termCwd) return { ok: false, error: "No workspace" };
  const { spawn } = await import("node:child_process");
  const run = (cmd: string, args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const p = spawn(cmd, args, { cwd: termCwd });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d.toString()));
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => resolve({ code: code ?? 0, out, err }));
      p.on("error", (e) => resolve({ code: 1, out: "", err: String(e) }));
    });
  const status = await run("git", ["status", "--porcelain=v1", "-uall"]);
  if (status.code !== 0) return { ok: false, error: status.err || "not a git repo", raw: status.out };
  const files: Array<{ path: string; status: string; staged: string; unstaged: string }> = [];
  for (const line of status.out.split("\n").filter(Boolean)) {
    const staged = line[0] || " ";
    const unstaged = line[1] || " ";
    const p = line.slice(3).trim();
    files.push({ path: p, status: `${staged}${unstaged}`, staged, unstaged });
  }
  const diffStat = await run("git", ["diff", "--stat"]);
  const diffNum = await run("git", ["diff", "--numstat"]);
  const log = await run("git", ["log", "--oneline", "-5"]);
  return { ok: true, files, diffStat: diffStat.out, diffNum: diffNum.out, log: log.out };
});

ipcMain.handle("git:diff", async (_e, payload: { path?: string; staged?: boolean }) => {
  const { spawn } = await import("node:child_process");
  const args = payload.staged ? ["diff", "--cached", "--", payload.path || "."] : payload.path ? ["diff", "--", payload.path] : ["diff"];
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd: termCwd });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ ok: code === 0, diff: out, error: err }));
    p.on("error", (e) => resolve({ ok: false, diff: "", error: String(e) }));
  });
});

ipcMain.handle("git:diffFile", async (_e, payload: { path: string; staged?: boolean }) => {
  const { spawn } = await import("node:child_process");
  const args = payload.staged ? ["diff", "--cached", "-U3", "--", payload.path] : ["diff", "-U3", "--", payload.path];
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd: termCwd });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ ok: code === 0, diff: out, error: err }));
    p.on("error", (e) => resolve({ ok: false, diff: "", error: String(e) }));
  });
});

// ── Updater (GitHub YlsooAI/MeteorIDE) ─────────────────────────────────
const GITHUB_REPO = "YlsooAI/MeteorIDE";
const GITHUB_API_COMMITS = `https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=1`;
const GITHUB_API_RELEASE = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

type UpdateStatus = {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  latestCommit: string;
  releaseUrl: string;
  changelog: string;
  checkedAt: number;
  error?: string;
};
let lastUpdateCheck: UpdateStatus | null = null;

async function getLocalCommit(): Promise<string | null> {
  try {
    const { spawn } = await import("node:child_process");
    const cwd = termCwd || process.cwd();
    const out: string = await new Promise((resolve, reject) => {
      const p = spawn("git", ["rev-parse", "HEAD"], { cwd });
      let o = "", e = "";
      p.stdout.on("data", d => o += d.toString());
      p.stderr.on("data", d => e += d.toString());
      p.on("close", code => code === 0 ? resolve(o.trim()) : reject(new Error(e.trim() || "not a git repo")));
      p.on("error", reject);
    });
    return out.trim() || null;
  } catch { return null; }
}

// Proper semver compare: returns >0 if a newer, <0 if older, 0 if equal
function semverCompare(a: string, b: string): number {
  const norm = (v: string) => String(v || "").replace(/^v/i, "").trim();
  const parts = (v: string) => norm(v).split(/[.\-+]/).map(x => /^\d+$/.test(x) ? parseInt(x, 10) : x);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i], xb = pb[i];
    if (xa === undefined && xb === undefined) return 0;
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    if (typeof xa === "number" && typeof xb === "number") {
      if (xa !== xb) return xa > xb ? 1 : -1;
    } else {
      const sa = String(xa), sb = String(xb);
      if (sa !== sb) return sa > sb ? 1 : -1;
    }
  }
  return 0;
}

async function fetchLatestTagViaRedirect(): Promise<string | null> {
  // github.com/.../releases/latest redirects to /releases/tag/<tag> — no API rate limit
  try {
    const r = await fetch(GITHUB_URL + "/releases/latest", { headers: { "User-Agent": "MeteorIDE-Updater" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
    const m = /\/releases\/tag\/([^/?#]+)/.exec(r.url || "");
    if (m) return decodeURIComponent(m[1]);
  } catch {}
  return null;
}

async function fetchVersionViaJsDelivr(): Promise<string | null> {
  // jsDelivr CDN serves the repo's package.json — works even when GitHub API is unreachable/rate-limited
  for (const branch of ["main", "master"]) {
    try {
      const r = await fetch(`https://cdn.jsdelivr.net/gh/${GITHUB_REPO}@${branch}/package.json`, { headers: { "User-Agent": "MeteorIDE-Updater" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json() as { version?: string };
      if (j.version && /^\d+\.\d+/.test(j.version)) return j.version;
    } catch {}
  }
  return null;
}

async function fetchGitHubLatest(): Promise<{ sha: string; message: string; date: string; url: string; releaseTag?: string; releaseUrl?: string; releaseNotes?: string }> {
  const headers: Record<string, string> = { "User-Agent": "MeteorIDE-Updater", Accept: "application/vnd.github+json" };
  let firstError: unknown = null;
  // 1) Releases API (gives notes too)
  try {
    const r = await fetch(GITHUB_API_RELEASE, { headers, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json() as { tag_name?: string; html_url?: string; body?: string; published_at?: string };
      if (j.tag_name) {
        return { sha: j.tag_name, message: j.body?.slice(0, 200) || "", date: j.published_at || "", url: j.html_url || GITHUB_URL, releaseTag: j.tag_name, releaseUrl: j.html_url || GITHUB_URL, releaseNotes: j.body || "" };
      }
    }
  } catch (e) { firstError = e; }
  // 2) releases/latest redirect (no API rate limit)
  const tag = await fetchLatestTagViaRedirect();
  if (tag) {
    return { sha: tag, message: "", date: "", url: `${GITHUB_URL}/releases/tag/${tag}`, releaseTag: tag, releaseUrl: `${GITHUB_URL}/releases/tag/${tag}`, releaseNotes: "" };
  }
  // 3) jsDelivr package.json version (works even when github.com is blocked)
  const ver = await fetchVersionViaJsDelivr();
  if (ver) {
    return { sha: ver, message: "", date: "", url: `${GITHUB_URL}/releases`, releaseTag: ver, releaseUrl: `${GITHUB_URL}/releases`, releaseNotes: "" };
  }
  throw new Error(firstError instanceof Error ? `GitHub check failed: ${firstError.message}` : "GitHub check failed");
}

async function checkForUpdates(force = false): Promise<UpdateStatus> {
  const currentVersion = app.getVersion();
  const localCommit = await getLocalCommit();
  try {
    const gh = await fetchGitHubLatest();
    const latestVersion = gh.releaseTag || gh.sha.slice(0, 7);
    const latestCommit = gh.sha;
    // compare: release tag (semver) wins; commit SHA only as last resort
    let hasUpdate = false;
    if (gh.releaseTag) {
      hasUpdate = semverCompare(gh.releaseTag, currentVersion) > 0;
    } else if (localCommit && gh.sha) {
      hasUpdate = localCommit !== gh.sha;
    } else {
      // first run: save without showing update
      const { readFileSync, existsSync, writeFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const cfgDir = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "meteor") : join(homedir(), ".config", "meteor");
      const seenFile = join(cfgDir, "last-seen-commit");
      let seen = "";
      try { if (existsSync(seenFile)) seen = readFileSync(seenFile, "utf8").trim(); } catch {}
      if (!seen) {
        try { mkdirSync(cfgDir, { recursive: true }); writeFileSync(seenFile, latestCommit); } catch {}
        hasUpdate = false;
      } else {
        hasUpdate = seen !== latestCommit;
      }
    }
    const status: UpdateStatus = {
      hasUpdate,
      currentVersion,
      latestVersion,
      latestCommit: gh.sha,
      releaseUrl: gh.releaseUrl || gh.url || GITHUB_URL,
      changelog: gh.message || gh.releaseNotes || "",
      checkedAt: Date.now(),
    };
    lastUpdateCheck = status;
    return status;
  } catch (e) {
    const status: UpdateStatus = {
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      latestCommit: localCommit || "",
      releaseUrl: GITHUB_URL,
      changelog: "",
      checkedAt: Date.now(),
      error: e instanceof Error ? e.message : String(e),
    };
    lastUpdateCheck = status;
    return status;
  }
}

ipcMain.handle("updater:check", async (_e, payload?: { force?: boolean }) => {
  return await checkForUpdates(!!payload?.force);
});
ipcMain.handle("updater:getStatus", async () => {
  if (!lastUpdateCheck) return await checkForUpdates(false);
  return lastUpdateCheck;
});
ipcMain.handle("updater:getChangelog", async () => {
  // Notes for the RUNNING version (shown once after each update)
  const version = app.getVersion();
  const norm = version.replace(/^v/, "");
  const headers: Record<string, string> = { "User-Agent": "MeteorIDE-Updater", Accept: "application/vnd.github+json" };
  const urls = [
    `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${norm}`,
    `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${norm}`,
    GITHUB_API_RELEASE,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json() as { tag_name?: string; name?: string; body?: string; html_url?: string; published_at?: string };
      if (j.tag_name) {
        return { version, tag: j.tag_name, title: j.name || j.tag_name, notes: j.body || "", url: j.html_url || GITHUB_URL, date: j.published_at || "" };
      }
    } catch {}
  }
  return { version, tag: "", title: `What's new in v${version}`, notes: "", url: GITHUB_URL, date: "" };
});
ipcMain.handle("updater:openRepo", async () => {
  await shell.openExternal(GITHUB_URL);
  return { ok: true };
});
function runCmd(cmd: string, args: string[], timeoutMs = 120000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, timeoutMs);
    p.stdout?.on("data", (d) => (out += d.toString()));
    p.stderr?.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? 1, out, err }); });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: 1, out: "", err: String(e) }); });
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  const res = await fetch(url, { headers: { "User-Agent": "MeteorIDE-Updater" }, redirect: "follow", signal: AbortSignal.timeout(600000) });
  if (!res.ok || !res.body) throw new Error(`Download failed HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

ipcMain.handle("app:restart", () => {
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

ipcMain.handle("updater:install", async () => {
  const status = lastUpdateCheck && lastUpdateCheck.hasUpdate ? lastUpdateCheck : await checkForUpdates(false);
  if (!status.hasUpdate) return { ok: false, error: "Already up to date" };

  // ── 1) dev/git checkout: pull source + rebuild in place ──
  const appDir = path.resolve(__dirname, "..", "..");
  if (existsSync(path.join(appDir, ".git"))) {
    const pull = await runCmd("git", ["pull", "--ff-only"], 120000);
    if (pull.code === 0) {
      const build = await runCmd(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], 300000);
      try {
        const gh = await fetchGitHubLatest();
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const cfgDir = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "meteor") : join(homedir(), ".config", "meteor");
        mkdirSync(cfgDir, { recursive: true });
        writeFileSync(join(cfgDir, "last-seen-commit"), gh.sha);
      } catch {}
      return { ok: build.code === 0, output: pull.out + "\n" + build.out, error: build.err || pull.err, needsRestart: true, method: "git" };
    }
    // fall through to packaged auto-update if git pull fails
  }

  // ── 2) packaged app: download the release asset and self-update ──
  try {
    const headers: Record<string, string> = { "User-Agent": "MeteorIDE-Updater", Accept: "application/vnd.github+json" };
    const r = await fetch(GITHUB_API_RELEASE, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Release lookup failed HTTP ${r.status}`);
    const rel = await r.json() as { assets?: Array<{ name: string; browser_download_url: string }> };
    const assets = rel.assets ?? [];
    const isMac = process.platform === "darwin";
    const isWin = process.platform === "win32";
    const asset = isWin
      ? assets.find(a => /\.exe$/i.test(a.name))
      : isMac
        ? (assets.find(a => /\.dmg$/i.test(a.name) && a.name.toLowerCase().includes(process.arch === "arm64" ? "arm64" : "x64"))
          || assets.find(a => /\.dmg$/i.test(a.name)))
        : undefined;
    if (!asset) throw new Error(`No ${isWin ? ".exe" : ".dmg"} asset found in latest release`);

    const dlPath = path.join(app.getPath("temp"), asset.name.replace(/\s+/g, "_"));

    if (isMac) {
      await downloadFile(asset.browser_download_url, dlPath);
      // clean stale mountpoint best-effort
      await runCmd("hdiutil", ["detach", "-quiet", "/Volumes/MeteorUpdate"], 10000).catch(() => undefined);
      const mount = await runCmd("hdiutil", ["attach", "-nobrowse", "-quiet", "-mountpoint", "/Volumes/MeteorUpdate", dlPath], 120000);
      if (mount.code !== 0) throw new Error("Failed to mount DMG: " + (mount.err || mount.out).slice(0, 200));
      try {
        const srcApp = "/Volumes/MeteorUpdate/Meteor.app";
        if (!existsSync(srcApp)) throw new Error("Meteor.app not found inside DMG");
        // overwrite the running bundle (running process keeps old inode until restart)
        const exe = app.getPath("exe");
        const m = /^(.*\.app)\//.exec(exe);
        const destApp = m ? m[1] : "/Applications/Meteor.app";
        const cp = await runCmd("ditto", [srcApp, destApp], 600000);
        if (cp.code !== 0) throw new Error("Failed to copy Meteor.app: " + (cp.err || cp.out).slice(0, 200));
      } finally {
        await runCmd("hdiutil", ["detach", "-quiet", "/Volumes/MeteorUpdate"], 30000);
        try { rmSync(dlPath, { force: true }); } catch {}
      }
      return { ok: true, needsRestart: true, method: "auto-dmg", output: `Installed ${status.latestVersion} — restart to apply` };
    }

    if (isWin) {
      await downloadFile(asset.browser_download_url, dlPath);
      const child = spawn(dlPath, ["/S"], { detached: true, stdio: "ignore", shell: false });
      child.unref();
      setTimeout(() => app.exit(0), 2000); // let silent installer take over
      return { ok: true, needsRestart: false, method: "auto-exe", output: "Silent installer launched — app will close" };
    }

    throw new Error("Auto-update not supported on this platform");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try { await shell.openExternal(GITHUB_URL + "/releases"); } catch {}
    return { ok: false, error: msg, fallbackOpened: true };
  }
});

// auto-check on startup (delay 5s) and every 30min
app.whenReady().then(() => {
  setTimeout(async () => {
    try { await checkForUpdates(false); } catch {}
  }, 5000);
  setInterval(async () => { try { await checkForUpdates(false); } catch {} }, 1000 * 60 * 30);
});

async function testStdioMcp(cfg: McpServerConfig): Promise<void> {
  const cmd = cfg.command!;
  const args = cfg.args ?? [];
  const env = { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>;
  const cwd = cfg.cwd ? path.resolve(cfg.cwd.replace(/^~/, os.homedir())) : termCwd;
  return new Promise((resolve, reject) => {
    let settled = false;
    const proc = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGTERM"); } catch {}
      // If still alive after timeout, consider it connectable (MCP servers stay alive)
      resolve();
    }, MCP_CONNECT_TIMEOUT);
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString().slice(0, 4000); });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn "${cmd}": ${err.message}`));
    });
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Command exited with ${code}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`));
    });
    // Try minimal MCP handshake: send initialize
    try {
      const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "meteor", version: app.getVersion() } } }) + "\n";
      proc.stdin.write(init);
    } catch {}
    // If we get any data back, it's a good sign
    let gotData = false;
    proc.stdout?.on("data", () => {
      if (gotData || settled) return;
      gotData = true;
      settled = true;
      clearTimeout(timeout);
      try { proc.kill("SIGTERM"); } catch {}
      resolve();
    });
  });
}

async function testHttpMcp(cfg: McpServerConfig): Promise<void> {
  const url = cfg.url!;
  const headers: Record<string, string> = { Accept: "application/json, text/event-stream", ...(cfg.headers ?? {}) };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), MCP_CONNECT_TIMEOUT);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (res.ok) return;
    // try POST for streamable-http
    if (res.status === 405 || res.status === 404) {
      const res2 = await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), signal: controller.signal });
      if (res2.ok || res2.status === 400) return; // 400 often means endpoint exists but expects MCP framing
      throw new Error(`HTTP ${res.status} ${res.statusText} (POST fallback ${res2.status})`);
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error(`Timeout connecting to ${url} (${MCP_CONNECT_TIMEOUT}ms)`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}
