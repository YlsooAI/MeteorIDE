import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import { MODELS, DEFAULT_MODEL, resolveModel, REASONING_EFFORTS, type MeteorModel } from "./models.js";
import { complete, ZenError, type Message } from "./zen.js";
import { clearApiKey, loadConfig, resolveApiKey, resolveMercuryKey, resetConfig, saveConfig, isUsingFreeTier, saveBrowserbaseKey, resolveBrowserbaseKey } from "./config.js";
import { checkQuotaOrThrow, getQuotaStatus, recordTokenUsage, formatTimeRemaining, QuotaExceededError } from "./quota.js";
import { WEB_TOOL_DEFINITIONS, executeWebTool } from "./web.js";

const VERSION = "0.2.0";
const DEFAULT_SYSTEM =
  "You are Meteor, a helpful assistant. Answer concisely. You can use full markdown: headings, bold, italic, lists, tables, blockquotes, links, and fenced code blocks with language tags. Prefer markdown for structure and readability.\n\nYou have built-in web tools:\n- fetch_url: fetch the live readable text or markdown content of any URL or link the user provides or asks about.\n- search_internet: search the internet via Browserbase to find up-to-date documentation, news, facts, and code examples whenever current information is needed. Use it proactively whenever fresh context is required.";

interface CliArgs {
  model?: string;
  system?: string;
  apiKey?: string;
  reasoningEffort?: string;
  stream: boolean;
  prompt: string[];
  command?: string;
  help: boolean;
  version: boolean;
}

const USAGE = `Meteor — AI in your terminal

Usage
  meteor [prompt...]              One-shot question (streams the answer)
  meteor chat [-m <model>]        Interactive session
  meteor quota                    Show your free tier quota usage (1M tokens / 5h)
  meteor build                    Build the project (emits to dist/)
  meteor plan                     Plan the build — preview without writing files
  meteor models                   List available models
  meteor auth set <api-key>             Store your API key
  meteor auth set-browserbase <bb-key>  Store Browserbase API key (for live web search)
  meteor auth show                      Show where the API keys come from
  meteor auth clear                     Remove stored API key

Modes
  Build   actually writes files (code + dist)
  Plan    previews the plan only — no files are written.
          In the app, toggle Plan / Build at the top.
          In the CLI, use  meteor plan  vs  meteor build
          or  npm run plan  vs  npm run build

Models
  sunlight-2        Sunlight 2
  sunlight-2-pro    Sunlight 2 Pro   (default)

Options
  -m, --model <model>    Model (sunlight-2 or sunlight-2-pro)
  -r, --reasoning <effort> Reasoning effort (default, minimal, low, medium, high, xhigh)
  -s, --system <text>    Override the system prompt
      --api-key <key>    Use this key for one call (else METEOR_API_KEY / stored key)
      --no-stream        Wait for the full response instead of streaming
  -h, --help             Show this help
  -v, --version          Show version

Environment
  METEOR_API_KEY         Your Meteor API key
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { stream: true, prompt: [], help: false, version: false };
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
  const isMercury = model?.provider === "mercury";
  const key = isMercury ? resolveMercuryKey(args.apiKey) : resolveApiKey(args.apiKey);
  if (!key) {
    if (isMercury) {
      console.error(
        "No Mercury API key found. Set MERCURY_API_KEY, or add mercuryKey to ~/.config/meteor/config.json",
      );
    } else {
      console.error(
        "No API key found. Set METEOR_API_KEY, or run:\n  meteor auth set <your-key>",
      );
    }
    process.exit(1);
  }
  return key;
}

async function runCompletion(args: CliArgs, messages: Message[], apiKey: string, model: MeteorModel): Promise<string> {
  const isFree = isUsingFreeTier(args.apiKey, model.provider);
  checkQuotaOrThrow(isFree);

  const allowed: string[] = [...REASONING_EFFORTS];
  const norm = (args.reasoningEffort || "").toLowerCase();
  const re = norm && norm !== "default" && norm !== "auto" && allowed.includes(norm) ? norm : undefined;

  let currentMessages: any[] = [...messages];
  let finalText = "";

  for (let iter = 0; iter < 5; iter++) {
    const res = await complete({
      apiKey,
      apiModel: model.apiModel,
      protocol: model.protocol,
      baseUrl: model.baseUrl,
      provider: model.provider,
      messages: currentMessages,
      stream: args.stream,
      reasoningEffort: re,
      tools: WEB_TOOL_DEFINITIONS,
      onDelta: (text) => process.stdout.write(text),
    });

    recordTokenUsage(res.usage.totalTokens, isFree);
    finalText = res.text;

    if (res.toolCalls.length === 0) {
      break;
    }

    const toolResults: Array<{ tool_call_id: string; content: string }> = [];
    for (const tc of res.toolCalls) {
      const parsedArgs: any = tc.parsedArgs ?? (() => {
        try { return JSON.parse(tc.arguments || "{}"); } catch { return {}; }
      })();

      if (tc.toolName === "search_internet" || tc.name.endsWith("search_internet")) {
        process.stdout.write(`\n\x1b[35m🔍 [search_internet] "${parsedArgs?.query || ""}"\x1b[0m\n`);
      } else if (tc.toolName === "fetch_url" || tc.name.endsWith("fetch_url")) {
        process.stdout.write(`\n\x1b[36m🌐 [fetch_url] ${parsedArgs?.url || ""}\x1b[0m\n`);
      } else {
        process.stdout.write(`\n\x1b[33m⚡ [${tc.toolName}]\x1b[0m\n`);
      }

      try {
        const text = await executeWebTool(tc.toolName, parsedArgs);
        toolResults.push({ tool_call_id: tc.id, content: text });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolResults.push({ tool_call_id: tc.id, content: `Error: ${msg}` });
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
  const messages: Message[] = [
    { role: "system", content: args.system ?? DEFAULT_SYSTEM },
    { role: "user", content: prompt },
  ];
  const answer = await runCompletion(args, messages, apiKey, model);
  if (!args.stream && answer) {
    const out = process.stdout.isTTY ? renderAnsi(answer) : answer;
    console.log(out);
  } else process.stdout.write("\n");
}

async function chatLoop(args: CliArgs): Promise<void> {
  const model = resolveModel(args.model ?? loadConfig().defaultModel);
  const apiKey = requireKey(args, model);
  let reasoningEffort = args.reasoningEffort ?? "";
  const reLabel = () => reasoningEffort ? ` · reasoning ${reasoningEffort}` : "";
  console.log(`Meteor chat — ${model.name}${reLabel()}`);
  console.log('Type /exit to quit, /clear to reset history, /model to switch models, /reasoning to set effort.\n');
  const rl = createInterface({ input, output });
  const history: Message[] = [{ role: "system", content: args.system ?? DEFAULT_SYSTEM }];
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
        history.push({ role: "system", content: args.system ?? DEFAULT_SYSTEM });
        console.log("(history cleared)\n");
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
        console.log("/exit /clear /model [name] /reasoning [effort] /quota /help\n");
        continue;
      }
      history.push({ role: "user", content: line });
      process.stdout.write(`${model.name.toLowerCase()}${reLabel()} > `);
      let answer = "";
      try {
        answer = await runCompletion(args, history, apiKey, model);
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
      process.stdout.write("\n\n");
      history.push({ role: "assistant", content: answer });
    }
  } finally {
    rl.close();
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
    console.log(`  Allowance:   Unlimited (bypasses free 1M/5h quota)`);
  } else {
    console.log(`  Tier:        \x1b[36mFree Tier (1,000,000 tokens / 5 hours)\x1b[0m`);
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
    case "show": {
      const source = process.env.METEOR_API_KEY || process.env.OPENCODE_API_KEY
        ? "environment (METEOR_API_KEY/OPENCODE_API_KEY)"
        : loadConfig().apiKey
          ? "~/.config/meteor/config.json"
          : "not configured";
      const bbSource = resolveBrowserbaseKey() ? "configured" : "not configured (using DuckDuckGo fallback)";
      console.log(`API key source:  ${source}`);
      console.log(`Browserbase key: ${bbSource}`);
      return;
    }
    case "clear": {
      console.log(clearApiKey() ? "Stored API key removed." : "No stored API key found.");
      return;
    }
    default:
      throw new Error("Usage: meteor auth <set|set-browserbase|show|clear> [args]");
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
