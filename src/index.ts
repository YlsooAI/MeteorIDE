import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { MODELS, DEFAULT_MODEL, resolveModel, REASONING_EFFORTS, type MeteorModel } from "./models.js";
import { complete, ZenError, type Message, type ToolDefinition } from "./zen.js";
import { clearApiKey, loadConfig, loadMcpServers, resolveApiKey, resetConfig, saveConfig, isUsingFreeTier, saveBrowserbaseKey, resolveBrowserbaseKey, resolveModelKey, modelKeyHint, saveTokenRouterKey, saveOrcaRouterKey, saveOpenRouterKey, saveApinexKey, saveOutrunKey, resolveTokenRouterKey, resolveOrcaRouterKey } from "./config.js";
import { checkQuotaOrThrow, getQuotaStatus, recordTokenUsage, formatTimeRemaining, QuotaExceededError } from "./quota.js";
import { WEB_TOOL_DEFINITIONS, executeWebTool } from "./web.js";
import { WORKSPACE_TOOL_DEFINITIONS, WORKSPACE_WRITE_TOOLS, WORKSPACE_APPROVAL_TOOLS, executeWorkspaceTool } from "./workspace-tools.js";
import { writeFileInWorkspace, deleteFileInWorkspace } from "./workspace.js";
import { listMcpTools, callMcpTool, killAllMcp, setMcpClientVersion } from "./mcp-client.js";

const VERSION = "0.2.26";
setMcpClientVersion(VERSION);

const DEFAULT_SYSTEM =
  "You are Meteor, a helpful AI coding assistant. Answer concisely. You can use full markdown: headings, bold, italic, lists, tables, blockquotes, links, and fenced code blocks with language tags. Prefer markdown for structure and readability.\n\nYou have built-in web tools:\n- fetch_url: fetch the live readable text or markdown content of any URL or link the user provides or asks about.\n- search_internet: search the internet via Browserbase to find up-to-date documentation, news, facts, and code examples whenever current information is needed. Use it proactively whenever fresh context is required.";

function buildCliSystemPrompt(args: CliArgs, workspaceRoot: string | null): string {
  if (args.system) return args.system;
  if (!workspaceRoot || args.noTools) return DEFAULT_SYSTEM;
  const readTools = [
    "- list_files(path?, depth?, glob?): discover files and directories.",
    "- read_file(path, startLine?, endLine?): read a specific line range.",
    "- search(query, path?, glob?, literal?, caseSensitive?): find text or regex matches.",
    "- project_info(): project name, scripts, package manager, and git status.",
    "- git_status(): git branch, ahead/behind, and changed/untracked files.",
    "- git_diff(path?, staged?, maxLines?): unified git diff for the workspace or a file.",
    "- git_log(limit?, path?): recent git commits for the workspace or a file.",
  ];
  const writeTools = [
    "- edit_file(path, oldText, newText, replaceAll?): replace one exact block of text.",
    "- apply_patch(patch, dryRun?): apply a unified diff or '*** Begin Patch' block.",
    "- move_file(from, to, overwrite?): rename or move a file.",
    "- run_command(command, cwd?, timeoutMs?): run a shell command in the workspace (tests, typecheck, build, linters). Requires user approval.",
  ];
  const toolLines = args.mode === "plan" ? readTools : [...readTools, ...writeTools];
  const modeNote =
    args.mode === "plan"
      ? "You are in PLAN (read-only) mode. Inspect files and propose changes without modifying the workspace."
      : "You are in BUILD mode. Inspect files before editing, use workspace-relative paths, and run tests or typecheck via run_command when appropriate.";
  return `${DEFAULT_SYSTEM}\n\n# Workspace tools (${workspaceRoot})\n${toolLines.join("\n")}\n\n${modeNote}`;
}

interface CliArgs {
  model?: string;
  system?: string;
  apiKey?: string;
  reasoningEffort?: string;
  cwd?: string;
  mode: "build" | "plan";
  yes: boolean;
  noTools: boolean;
  mcp: boolean;
  stream: boolean;
  prompt: string[];
  command?: string;
  help: boolean;
  version: boolean;
}

const USAGE = `Meteor — AI in your terminal

Usage
  meteor [prompt...]              One-shot question or coding task (streams the answer)
  meteor chat [-m <model>]        Interactive coding session with workspace & MCP tools
  meteor quota                    Show your free tier quota usage (10M tokens / 5h)
  meteor build                    Build the project (emits to dist/)
  meteor plan                     Plan the build — preview without writing files
  meteor models                   List available models
  meteor auth set <api-key>             Store your API key
  meteor auth set-openrouter <key>     Store OpenRouter API key
  meteor auth set-outrun <key>         Store Outrun API key (for Sunlight 2.1)
  meteor auth set-apinex <key>         Store Apinex API key
  meteor auth set-tokenrouter <key>     Store TokenRouter API key
  meteor auth set-orcarouter <key>      Store OrcaRouter API key
  meteor auth set-browserbase <bb-key>  Store Browserbase API key (for live web search)
  meteor auth show                      Show where the API keys come from
  meteor auth clear                     Remove stored API key

Modes
  Build   actually writes files and can run approved commands (default)
  Plan    read-only investigation — no files are written (--plan / --read-only)

Models
  sunlight-2.1      Sunlight 2.1   (default)

Options
  -m, --model <model>      Model (sunlight-2.1)
  -r, --reasoning <effort> Reasoning effort (default, minimal, low, medium, high, xhigh)
  -s, --system <text>      Override the system prompt
      --cwd <dir>          Workspace root directory (default: current directory)
      --plan, --read-only  Read-only mode (disable file edits and run_command)
  -y, --yes                Auto-approve run_command tool calls
      --mcp                Always expose configured MCP server tools
      --no-tools           Disable workspace and MCP tools
      --api-key <key>      Use this key for one call (else METEOR_API_KEY / stored key)
      --no-stream          Wait for the full response instead of streaming
  -h, --help               Show this help
  -v, --version            Show version

Environment
  METEOR_API_KEY         Your Meteor API key
  OPENROUTER_API_KEY     OpenRouter key (all Sunlight models)
  TOKENROUTER_API_KEY    TokenRouter key
  ORCAROUTER_API_KEY     OrcaRouter key
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { stream: true, mode: "build", yes: false, noTools: false, mcp: false, prompt: [], help: false, version: false };
  const rest = [...argv];
  if (rest.length > 0 && !rest[0].startsWith("-") && ["chat", "models", "auth", "help", "build", "plan", "quota"].includes(rest[0])) {
    args.command = rest.shift();
  }
  while (rest.length > 0) {
    const arg = rest.shift()!;
    switch (arg) {
      case "-m":
      case "--model":
        args.model = rest.shift();
        break;
      case "-r":
      case "--reasoning":
        args.reasoningEffort = rest.shift();
        break;
      case "-s":
      case "--system":
        args.system = rest.shift();
        break;
      case "--cwd":
        args.cwd = rest.shift();
        break;
      case "--plan":
      case "--read-only":
        args.mode = "plan";
        break;
      case "-y":
      case "--yes":
        args.yes = true;
        break;
      case "--no-tools":
        args.noTools = true;
        break;
      case "--mcp":
        args.mcp = true;
        break;
      case "--api-key":
        args.apiKey = rest.shift();
        break;
      case "--no-stream":
        args.stream = false;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        args.prompt.push(arg);
    }
  }
  return args;
}

function requireKey(args: CliArgs, model?: MeteorModel): string {
  const key = resolveModelKey(model?.provider, args.apiKey);
  if (!key) {
    console.error(`No API key found for ${model?.name ?? "model"}. ${modelKeyHint(model?.provider)}`);
    process.exit(1);
  }
  return key;
}

interface TurnFileChange {
  action: "create" | "update" | "delete" | "move";
  path: string;
  deletePath?: string;
  oldContent: string | null;
}

interface CompletionRuntime {
  workspaceRoot: string | null;
  sessionApprovedCommands: Set<string>;
  askLine?: (prompt: string) => Promise<string | null>;
  turnChanges?: Map<string, TurnFileChange>;
}

function getLastUserText(msgs: Message[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      const c = msgs[i].content as unknown;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return (c as Array<{ text?: string }>).map((p) => p.text || "").join(" ");
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

function recordCliTurnChanges(structured: unknown, turnChanges?: Map<string, TurnFileChange>): void {
  if (!turnChanges || !structured || typeof structured !== "object") return;
  const s = structured as { kind?: string; dryRun?: boolean; files?: Array<{ action?: string; path?: string; from?: string; before?: string }> };
  if (s.dryRun || s.kind === "git_status" || !Array.isArray(s.files)) return;
  for (const f of s.files) {
    if (f.action === "create" && f.path) {
      if (!turnChanges.has(f.path)) {
        turnChanges.set(f.path, { action: "create", path: f.path, deletePath: f.path, oldContent: null });
      }
    } else if ((f.action === "update" || f.action === "delete") && f.path && typeof f.before === "string") {
      if (!turnChanges.has(f.path)) {
        turnChanges.set(f.path, { action: f.action, path: f.path, oldContent: f.before });
      }
    } else if (f.action === "move" && f.from && f.path && typeof f.before === "string") {
      const existing = turnChanges.get(f.from);
      if (existing) {
        existing.deletePath = f.path;
      } else {
        turnChanges.set(f.from, { action: "move", path: f.from, deletePath: f.path, oldContent: f.before });
      }
    }
  }
}

async function revertCliCheckpoint(root: string, checkpoint: Map<string, TurnFileChange>): Promise<{ reverted: number; failed: number }> {
  let reverted = 0;
  let failed = 0;
  const entries = [...checkpoint.values()].reverse();
  for (const entry of entries) {
    try {
      if (entry.deletePath) {
        try { await deleteFileInWorkspace(root, entry.deletePath); } catch {}
      }
      if (entry.oldContent !== null && entry.path) {
        await writeFileInWorkspace(root, entry.path, entry.oldContent);
      }
      reverted++;
    } catch (err) {
      failed++;
      console.error(`\x1b[31m✗ failed to revert ${entry.path || entry.deletePath}:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { reverted, failed };
}

async function promptCommandApproval(
  command: string,
  cwd: string | undefined,
  args: CliArgs,
  runtime: CompletionRuntime,
): Promise<boolean> {
  if (args.yes || runtime.sessionApprovedCommands.has(command)) return true;
  if (!process.stdin.isTTY) return false;
  const dirNote = cwd && cwd !== "." ? ` (in ${cwd})` : "";
  const promptText = `\n\x1b[33mApprove command${dirNote}:\x1b[0m $ ${command} [y/N/a(lways)] `;
  let answer: string | null = null;
  if (runtime.askLine) {
    answer = await runtime.askLine(promptText);
  } else {
    const rl = createInterface({ input, output });
    try {
      answer = await rl.question(promptText);
    } finally {
      rl.close();
    }
  }
  const norm = (answer ?? "").trim().toLowerCase();
  if (norm === "a" || norm === "always") {
    runtime.sessionApprovedCommands.add(command);
    return true;
  }
  return norm === "y" || norm === "yes";
}

async function runCompletion(
  args: CliArgs,
  messages: Message[],
  apiKey: string,
  model: MeteorModel,
  runtime: CompletionRuntime,
): Promise<string> {
  const isFree = isUsingFreeTier(args.apiKey, model.provider);
  checkQuotaOrThrow(isFree);

  const allowed: string[] = [...REASONING_EFFORTS];
  const norm = (args.reasoningEffort || "").toLowerCase();
  const re = norm && norm !== "default" && norm !== "auto" && allowed.includes(norm) ? norm : undefined;

  let mcpTools: ToolDefinition[] = [];
  if (!args.noTools) {
    try {
      const servers = loadMcpServers();
      const serverNames = Object.keys(servers);
      if (serverNames.length > 0 && (args.mcp || mentionsMcp(getLastUserText(messages), serverNames))) {
        const discovered = await listMcpTools(runtime.workspaceRoot ?? process.cwd());
        mcpTools = discovered.map((t) => ({
          server: t.server,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        if (mcpTools.length > 0) {
          process.stdout.write(`\x1b[90m[mcp: ${mcpTools.length} tool${mcpTools.length === 1 ? "" : "s"} loaded]\x1b[0m\n`);
        }
      }
    } catch (err) {
      console.error(`\x1b[90m[mcp warning: ${err instanceof Error ? err.message : String(err)}]\x1b[0m`);
    }
  }

  const workspaceTools: ToolDefinition[] =
    !args.noTools && runtime.workspaceRoot
      ? WORKSPACE_TOOL_DEFINITIONS.filter((tool) => !(args.mode === "plan" && WORKSPACE_WRITE_TOOLS.has(tool.name)))
      : [];

  const toolDefs: ToolDefinition[] = [...workspaceTools, ...WEB_TOOL_DEFINITIONS, ...mcpTools];

  let currentMessages: any[] = [...messages];
  let finalText = "";

  const MAX_TOOL_ITERS = 12;
  for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
    const res = await complete({
      apiKey,
      apiModel: model.apiModel,
      protocol: model.protocol,
      baseUrl: model.baseUrl,
      provider: model.provider,
      messages: currentMessages,
      stream: args.stream,
      reasoningEffort: re,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      onDelta: (text) => process.stdout.write(text),
    });

    recordTokenUsage(res.usage.totalTokens, isFree);
    finalText = res.text;

    if (res.toolCalls.length === 0) {
      break;
    }

    const toolResults: Array<{ tool_call_id: string; content: string }> = [];
    for (const tc of res.toolCalls) {
      const parsedArgs: Record<string, unknown> = (tc.parsedArgs && typeof tc.parsedArgs === "object"
        ? tc.parsedArgs
        : (() => {
            try { return JSON.parse(tc.arguments || "{}"); } catch { return {}; }
          })()) as Record<string, unknown>;

      if (tc.server === "workspace") {
        const detail =
          tc.toolName === "run_command"
            ? `$ ${String(parsedArgs.command ?? "")}`
            : tc.toolName === "search"
              ? `"${String(parsedArgs.query ?? "")}"`
              : String(parsedArgs.path ?? parsedArgs.from ?? "");
        process.stdout.write(`\n\x1b[36m⚙ [${tc.toolName}]${detail ? ` ${detail}` : ""}\x1b[0m\n`);
        try {
          if (args.mode === "plan" && WORKSPACE_WRITE_TOOLS.has(tc.toolName)) {
            throw new Error(`${tc.toolName} is disabled in plan mode.`);
          }
          if (WORKSPACE_APPROVAL_TOOLS.has(tc.toolName)) {
            const cmd = String(parsedArgs.command ?? parsedArgs.cmd ?? "").trim();
            const cwdArg = parsedArgs.cwd ? String(parsedArgs.cwd) : undefined;
            if (!cmd) throw new Error("command is required");
            const approved = await promptCommandApproval(cmd, cwdArg, args, runtime);
            if (!approved) {
              const reason = process.stdin.isTTY
                ? "Command execution denied by user."
                : "Command execution denied in non-interactive mode. Pass --yes to auto-approve commands.";
              throw new Error(reason);
            }
          }
          const result = await executeWorkspaceTool(tc.toolName, parsedArgs, runtime.workspaceRoot ?? "");
          if (!result.isError) {
            recordCliTurnChanges(result.structured, runtime.turnChanges);
          }
          if (tc.toolName === "run_command" && result.structured && typeof result.structured === "object") {
            const st = result.structured as { exitCode?: number | null; durationMs?: number; ok?: boolean };
            const color = st.ok ? "\x1b[32m" : "\x1b[31m";
            process.stdout.write(`${color}  ↳ exit ${st.exitCode ?? "?"} (${st.durationMs ?? 0}ms)\x1b[0m\n`);
          }
          toolResults.push({ tool_call_id: tc.id, content: result.text });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write(`\x1b[31m  ↳ ${msg}\x1b[0m\n`);
          toolResults.push({ tool_call_id: tc.id, content: `Error: ${msg}` });
        }
      } else if (tc.server === "web" || tc.toolName === "search_internet" || tc.toolName === "fetch_url") {
        if (tc.toolName === "search_internet" || tc.name.endsWith("search_internet")) {
          process.stdout.write(`\n\x1b[35m🔍 [search_internet] "${parsedArgs?.query || ""}"\x1b[0m\n`);
        } else {
          process.stdout.write(`\n\x1b[36m🌐 [fetch_url] ${parsedArgs?.url || ""}\x1b[0m\n`);
        }
        try {
          const text = await executeWebTool(tc.toolName, parsedArgs);
          toolResults.push({ tool_call_id: tc.id, content: text });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toolResults.push({ tool_call_id: tc.id, content: `Error: ${msg}` });
        }
      } else {
        process.stdout.write(`\n\x1b[33m⚡ [${tc.server}.${tc.toolName}]\x1b[0m\n`);
        try {
          const resMcp = await callMcpTool(tc.server, tc.toolName, parsedArgs, runtime.workspaceRoot ?? process.cwd());
          const text = (resMcp.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n") || JSON.stringify(resMcp, null, 2);
          toolResults.push({ tool_call_id: tc.id, content: text });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toolResults.push({ tool_call_id: tc.id, content: `Error: ${msg}` });
        }
      }
    }

    currentMessages = [
      ...currentMessages,
      {
        role: "assistant",
        content: res.text || "",
        tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })),
      } as unknown as Message,
      ...toolResults.map((tr) => ({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content } as unknown as Message)),
    ];
  }

  return finalText;
}

function renderAnsi(md: string): string {
  const codeBlocks: string[] = [];
  md = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`\x1b[2m\x1b[90m┌─ ${lang || "code"} ─┐\x1b[0m\n${code.trimEnd()}\n\x1b[2m\x1b[90m└${"─".repeat(20)}\x1b[0m`);
    return `\x00CB${idx}\x00`;
  });
  md = md.replace(/`([^`]+?)`/g, (_, c) => `\x1b[7m ${c} \x1b[0m`);
  md = md.replace(/^######\s+(.*)$/gm, "\x1b[1m\x1b[2m$1\x1b[0m");
  md = md.replace(/^#####\s+(.*)$/gm, "\x1b[1m\x1b[2m$1\x1b[0m");
  md = md.replace(/^####\s+(.*)$/gm, "\x1b[1m$1\x1b[0m");
  md = md.replace(/^###\s+(.*)$/gm, "\x1b[1m\x1b[4m$1\x1b[0m");
  md = md.replace(/^##\s+(.*)$/gm, "\x1b[1m\x1b[4m$1\x1b[0m");
  md = md.replace(/^#\s+(.*)$/gm, "\x1b[1m\x1b[4m\x1b[33m$1\x1b[0m");
  md = md.replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[22m");
  md = md.replace(/__(.+?)__/g, "\x1b[1m$1\x1b[22m");
  md = md.replace(/~~(.+?)~~/g, "\x1b[9m$1\x1b[29m");
  md = md.replace(/\*(.+?)\*/g, "\x1b[3m$1\x1b[23m");
  md = md.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, "\x1b[4m\x1b[34m$1\x1b[0m (\x1b[2m$2\x1b[0m)");
  md = md.replace(/^\s*>\s?(.*)$/gm, "\x1b[2m▎ $1\x1b[0m");
  md = md.replace(/^\s*[-*+]\s+(.*)$/gm, "  \x1b[33m•\x1b[0m $1");
  md = md.replace(/^\s*\d+\.\s+(.*)$/gm, "  \x1b[33m$&\x1b[0m");
  md = md.replace(/^\s*([-*_])\s*\1\s*\1(\s*\1)*\s*$/gm, "\x1b[2m" + "─".repeat(40) + "\x1b[0m");
  md = md.replace(/\x00CB(\d+)\x00/g, (_, n) => codeBlocks[Number(n)] || "");
  return md;
}

async function askOnce(args: CliArgs): Promise<void> {
  const model = resolveModel(args.model ?? loadConfig().defaultModel);
  const apiKey = requireKey(args, model);
  const prompt = args.prompt.join(" ").trim();
  if (!prompt) throw new Error("Provide a prompt, e.g. meteor \"explain event loops\"");
  const workspaceRoot = args.noTools ? null : path.resolve(args.cwd ?? process.cwd());
  const messages: Message[] = [
    { role: "system", content: buildCliSystemPrompt(args, workspaceRoot) },
    { role: "user", content: prompt },
  ];
  const runtime: CompletionRuntime = {
    workspaceRoot,
    sessionApprovedCommands: new Set(),
  };
  try {
    const answer = await runCompletion(args, messages, apiKey, model, runtime);
    if (!args.stream && answer) {
      const out = process.stdout.isTTY ? renderAnsi(answer) : answer;
      console.log(out);
    } else process.stdout.write("\n");
  } finally {
    killAllMcp();
  }
}

async function chatLoop(args: CliArgs): Promise<void> {
  const model = resolveModel(args.model ?? loadConfig().defaultModel);
  const apiKey = requireKey(args, model);
  const workspaceRoot = args.noTools ? null : path.resolve(args.cwd ?? process.cwd());
  let reasoningEffort = args.reasoningEffort ?? "";
  const reLabel = () => reasoningEffort ? ` · reasoning ${reasoningEffort}` : "";
  const modeLabel = () => (args.noTools ? "no-tools" : args.mode);
  console.log(`Meteor chat — ${model.name}${reLabel()} · ${modeLabel()}${workspaceRoot ? ` · ${path.basename(workspaceRoot)}` : ""}`);
  console.log("Type /exit to quit, /clear to reset, /mode [plan|build], /undo to revert last turn, /tools, /help.\n");
  const rl = createInterface({ input, output });
  const history: Message[] = [{ role: "system", content: buildCliSystemPrompt(args, workspaceRoot) }];
  const sessionApprovedCommands = new Set<string>();
  const turnCheckpoints: Array<Map<string, TurnFileChange>> = [];
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.on("line", (line: string) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  const nextLine = (): Promise<string | null> => {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  };
  const askLine = async (promptText: string): Promise<string | null> => {
    process.stdout.write(promptText);
    return nextLine();
  };
  try {
    while (true) {
      process.stdout.write("you > ");
      const raw = await nextLine();
      if (raw === null) {
        process.stdout.write("\n");
        break;
      }
      const line = raw.trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/clear") {
        history.length = 0;
        history.push({ role: "system", content: buildCliSystemPrompt(args, workspaceRoot) });
        console.log("(history cleared)\n");
        continue;
      }
      if (line === "/mode" || line.startsWith("/mode ")) {
        const target = line.slice("/mode".length).trim().toLowerCase();
        if (!target) {
          console.log(`mode: ${args.mode} (use /mode plan or /mode build)\n`);
        } else if (target === "plan" || target === "build") {
          args.mode = target;
          history[0] = { role: "system", content: buildCliSystemPrompt(args, workspaceRoot) };
          console.log(`switched mode → ${args.mode}\n`);
        } else {
          console.log(`unknown mode "${target}". Use plan or build.\n`);
        }
        continue;
      }
      if (line === "/undo") {
        if (!workspaceRoot || turnCheckpoints.length === 0) {
          console.log("nothing to undo\n");
          continue;
        }
        const cp = turnCheckpoints.pop()!;
        const { reverted, failed } = await revertCliCheckpoint(workspaceRoot, cp);
        console.log(`\x1b[32m↺ Reverted ${reverted} file${reverted === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}\x1b[0m\n`);
        continue;
      }
      if (line === "/tools") {
        const wsTools = args.noTools
          ? []
          : WORKSPACE_TOOL_DEFINITIONS.filter((t) => !(args.mode === "plan" && WORKSPACE_WRITE_TOOLS.has(t.name))).map((t) => t.name);
        const mcpServers = Object.keys(loadMcpServers());
        console.log(`workspace (${args.mode}): ${wsTools.length ? wsTools.join(", ") : "disabled"}`);
        console.log(`web: ${WEB_TOOL_DEFINITIONS.map((t) => t.name).join(", ")}`);
        console.log(`mcp servers: ${mcpServers.length ? mcpServers.join(", ") : "none configured"}\n`);
        continue;
      }
      if (line === "/model" || line.startsWith("/model ")) {
        const target = line.slice("/model".length).trim() || undefined;
        const next = resolveModel(target);
        model.key = next.key;
        Object.assign(model, next);
        console.log(`switched to ${next.name}${reLabel()}\n`);
        continue;
      }
      if (line === "/reasoning" || line.startsWith("/reasoning ")) {
        const target = line.slice("/reasoning".length).trim().toLowerCase();
        const allowed = ["", "auto", "default", ...REASONING_EFFORTS];
        if (!target) {
          console.log(`reasoning effort: ${reasoningEffort || "default"} (available: ${allowed.filter(Boolean).join(", ")})\n`);
        } else if (!allowed.includes(target)) {
          console.log(`unknown reasoning "${target}". Available: ${allowed.filter(Boolean).join(", ")}\n`);
        } else {
          reasoningEffort = target === "auto" || target === "default" ? "" : target;
          args.reasoningEffort = reasoningEffort;
          console.log(`reasoning effort → ${reasoningEffort || "default"}\n`);
        }
        continue;
      }
      if (line === "/quota") {
        showQuotaAction();
        continue;
      }
      if (line === "/help") {
        console.log("/exit /clear /mode [plan|build] /undo /tools /model [name] /reasoning [effort] /quota /help\n");
        continue;
      }
      history.push({ role: "user", content: line });
      process.stdout.write(`${model.name.toLowerCase()}${reLabel()} > `);
      const turnChanges = new Map<string, TurnFileChange>();
      let answer = "";
      try {
        answer = await runCompletion(args, history, apiKey, model, {
          workspaceRoot,
          sessionApprovedCommands,
          askLine,
          turnChanges,
        });
        if (!args.stream && answer) {
          const out = process.stdout.isTTY ? renderAnsi(answer) : answer;
          process.stdout.write(out);
        }
      } catch (err) {
        process.stdout.write("\n");
        if (err instanceof Error) console.error(`error: ${err.message}`);
        history.pop();
        continue;
      }
      process.stdout.write("\n");
      if (turnChanges.size > 0) {
        turnCheckpoints.push(turnChanges);
        if (turnCheckpoints.length > 20) turnCheckpoints.shift();
        console.log(`\x1b[90m✓ Checkpoint saved (${turnChanges.size} file${turnChanges.size === 1 ? "" : "s"} changed — type /undo to revert this turn)\x1b[0m`);
      }
      process.stdout.write("\n");
      history.push({ role: "assistant", content: answer });
    }
  } finally {
    rl.close();
    killAllMcp();
  }
}

function showQuotaAction(): void {
  const isFree = isUsingFreeTier();
  const status = getQuotaStatus(isFree);

  const barWidth = 24;
  const filled = Math.min(barWidth, Math.round((status.used / status.limit) * barWidth));
  const empty = barWidth - filled;
  const bar = `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
  const resetDate = new Date(status.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const timeLeft = formatTimeRemaining(status.resetsInMs);

  console.log(`\n\x1b[1m\x1b[35mMeteor Free Quota\x1b[0m`);
  console.log(`\x1b[90m${"─".repeat(45)}\x1b[0m`);
  if (!isFree) {
    console.log(`  Tier:        \x1b[32mCustom API Key (Unlimited)\x1b[0m`);
    console.log(`  Allowance:   Unlimited (bypasses free 10M/5h quota)`);
  } else {
    console.log(`  Tier:        \x1b[36mFree Tier (10,000,000 tokens / 5 hours)\x1b[0m`);
  }
  console.log(`  Usage:       \x1b[1m${status.used.toLocaleString()} / ${status.limit.toLocaleString()}\x1b[0m tokens (${status.percentUsed}%)`);
  console.log(`  Progress:    \x1b[33m${bar}\x1b[0m`);
  console.log(`  Remaining:   \x1b[1m${status.remaining.toLocaleString()}\x1b[0m tokens`);
  console.log(`  Resets in:   \x1b[33m${timeLeft}\x1b[0m (at ${resetDate})`);
  if (status.isExceeded) {
    console.log(`\n\x1b[31m⚠ Quota limit reached for this 5-hour window. Wait for reset or configure your own key:\x1b[0m`);
    console.log(`  meteor auth set <your-api-key>\n`);
  } else {
    console.log();
  }
}

function listModels(): void {
  const cfg = loadConfig();
  for (const m of Object.values(MODELS)) {
    const isDefault = m.key === (cfg.defaultModel ? resolveModel(cfg.defaultModel).key : DEFAULT_MODEL);
    console.log(`${m.key.padEnd(16)} ${m.name}${isDefault ? "  [default]" : ""}`);
  }
}

function runBuild(planOnly: boolean): void {
  if (planOnly) {
    const r = spawnSync("node", ["scripts/plan.mjs"], { stdio: "inherit" });
    process.exitCode = r.status ?? 0;
    return;
  }
  console.log("\x1b[1m▶ Building Meteor…\x1b[0m");
  const r = spawnSync("npx", ["tsc"], { stdio: "inherit" });
  if (r.status === 0) console.log("\n\x1b[32m✔ Build complete → dist/\x1b[0m");
  else console.log("\n\x1b[31m✘ Build failed\x1b[0m");
  process.exitCode = r.status ?? 1;
}

async function authAction(sub: string | undefined, value: string | undefined): Promise<void> {
  switch (sub) {
    case "set": {
      if (!value) throw new Error("Usage: meteor auth set <api-key>");
      saveConfig({ apiKey: value });
      console.log("API key saved to ~/.config/meteor/config.json");
      return;
    }
    case "set-browserbase": {
      if (!value) throw new Error("Usage: meteor auth set-browserbase <browserbase-api-key>");
      saveBrowserbaseKey(value);
      console.log("Browserbase API key saved to ~/.config/meteor/config.json");
      return;
    }
    case "set-openrouter": {
      if (!value) throw new Error("Usage: meteor auth set-openrouter <openrouter-api-key>");
      saveOpenRouterKey(value);
      console.log("OpenRouter key saved to ~/.config/meteor/config.json");
      return;
    }
    case "set-apinex": {
      if (!value) throw new Error("Usage: meteor auth set-apinex <apinex-api-key>");
      saveApinexKey(value);
      console.log("Apinex key saved to ~/.config/meteor/config.json");
      return;
    }
    case "set-outrun": {
      if (!value) throw new Error("Usage: meteor auth set-outrun <outrun-api-key>");
      saveOutrunKey(value);
      console.log("Outrun key saved to ~/.config/meteor/config.json");
      return;
    }
    case "set-tokenrouter": {
      if (!value) throw new Error("Usage: meteor auth set-tokenrouter <tokenrouter-api-key>");
      saveTokenRouterKey(value);
      console.log("TokenRouter API key saved to ~/.config/meteor/config.json");
      return;
    }
    case "set-orcarouter": {
      if (!value) throw new Error("Usage: meteor auth set-orcarouter <orcarouter-api-key>");
      saveOrcaRouterKey(value);
      console.log("OrcaRouter API key saved to ~/.config/meteor/config.json");
      return;
    }
    case "show": {
      const source = process.env.METEOR_API_KEY || process.env.OPENCODE_API_KEY
        ? "environment (METEOR_API_KEY/OPENCODE_API_KEY)"
        : loadConfig().apiKey
          ? "~/.config/meteor/config.json"
          : "not configured";
      const orSource = process.env.OPENROUTER_API_KEY
        ? "environment (OPENROUTER_API_KEY)"
        : loadConfig().openrouterKey
          ? "~/.config/meteor/config.json"
          : "not configured";
      const apSource = process.env.APINEX_API_KEY
        ? "environment (APINEX_API_KEY)"
        : loadConfig().apinexKey
          ? "~/.config/meteor/config.json"
          : "not configured (using embedded key)";
      const outrunSource = process.env.OUTRUN_API_KEY
        ? "environment (OUTRUN_API_KEY)"
        : loadConfig().outrunKey
          ? "~/.config/meteor/config.json"
          : "not configured (using embedded key)";
      const trSource = process.env.TOKENROUTER_API_KEY
        ? "environment (TOKENROUTER_API_KEY)"
        : loadConfig().tokenrouterKey
          ? "~/.config/meteor/config.json"
          : "not configured";
      const orcaSource = process.env.ORCAROUTER_API_KEY
        ? "environment (ORCAROUTER_API_KEY)"
        : loadConfig().orcarouterKey
          ? "~/.config/meteor/config.json"
          : "not configured";
      const bbSource = resolveBrowserbaseKey() ? "configured" : "not configured (using DuckDuckGo fallback)";
      console.log(`API key source:      ${source}`);
      console.log(`OpenRouter key:      ${orSource}`);
      console.log(`Outrun key:          ${outrunSource}`);
      console.log(`Apinex key:         ${apSource}`);
      console.log(`TokenRouter key:     ${trSource}`);
      console.log(`OrcaRouter key:      ${orcaSource}`);
      console.log(`Browserbase key:     ${bbSource}`);
      return;
    }
    case "clear": {
      console.log(clearApiKey() ? "Stored API key removed." : "No stored API key found.");
      return;
    }
    default:
      throw new Error("Usage: meteor auth <set|set-openrouter|set-tokenrouter|set-orcarouter|set-browserbase|show|clear> [args]");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) return console.log(`meteor ${VERSION}`);
  if (args.help || args.command === "help") return console.log(USAGE);

  try {
    switch (args.command) {
      case "chat":
        return await chatLoop(args);
      case "quota":
        return showQuotaAction();
      case "build":
        return runBuild(false);
      case "plan":
        return runBuild(true);
      case "models":
        return listModels();
      case "auth":
        return await authAction(args.prompt[0], args.prompt[1]);
      default:
        if (args.prompt.length === 0) return console.log(USAGE);
        return await askOnce(args);
    }
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      console.error(`\x1b[31mQuota Exceeded:\x1b[0m ${err.message}`);
    } else if (err instanceof ZenError && err.status === 401) {
      console.error("error: Unauthorized — check your API key");
    } else if (err instanceof Error) {
      console.error(`error: ${err.message}`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  }
}

await main();

export { resetConfig };
